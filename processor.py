"""Core image-protection pipeline.

Design goal (revised): disrupt OCR / AI extraction while keeping the image as
readable as possible to a human. By default the output is rotated 180° AND mirrored
(the reader flips/rotates it back), plus two low-human-impact techniques below.
Visible mask and blur stay OFF and are manual options. The low-human-impact
techniques are:

    * micro-warp  - a smooth sub-pixel-to-2px displacement field that breaks the
      clean glyph geometry OCR/embeddings rely on, while the eye barely notices.
    * light noise - low-amplitude Gaussian noise that disturbs edge detection.

All parameters scale with image size, so arbitrary / varying photo dimensions are
handled consistently. Every step preserves the original pixel dimensions.

Honest limitation: no transform is both invisible to humans AND able to reliably
defeat modern robust multimodal models. Stronger settings = more visible.

Pure, Streamlit-free, so the same logic can back a FastAPI endpoint later.
The public entry point is `process_image` / `protect_bytes`.
"""

from __future__ import annotations

import io
import random
from dataclasses import dataclass, asdict
from typing import Optional

import numpy as np
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
@dataclass
class ProtectionConfig:
    """All knobs for the pipeline. Defaults = the 'Stealth' preset."""

    # --- Micro-warp (primary, low human impact, anti-OCR) ---
    warp_enabled: bool = True
    warp_amplitude: float = 1.2     # max displacement in px at a 1000px reference
    warp_cell: float = 0.05         # smoothness: cell size as fraction of min(W, H)

    # --- High-frequency noise ---
    noise_enabled: bool = True
    noise_sigma: float = 3.0        # std-dev in 0-255 space; light by default

    # --- Subtle disruption overlay (OFF by default; visible if on) ---
    mask_enabled: bool = False
    mask_opacity: float = 0.07      # keep low to stay readable
    line_width_min: int = 1
    line_width_max: int = 1
    spacing_min: int = 12           # px at 1000px reference, auto-scaled
    spacing_max: int = 22
    use_diagonal: bool = True
    use_crosshatch: bool = True
    use_grid: bool = False

    # --- Geometry ---
    # Both ON by default: output is rotated 180° AND mirrored, which scrambles
    # orientation for AI/OCR while a human can fully restore it (flip + rotate
    # back). No information is lost.
    rotate_180: bool = True
    flip_horizontal: bool = True

    # --- Optional blur (OFF: hurts reading) ---
    blur_enabled: bool = False
    blur_radius: float = 0.4        # 0.3 - 0.5 px

    # Reproducibility (None = fresh randomness each run)
    seed: Optional[int] = None

    def to_dict(self) -> dict:
        return asdict(self)


# Protection presets ---------------------------------------------------------
# Empirically, light warp+noise alone does NOT stop strong multimodal models
# (GPT/Claude). What actually degrades them is a visible disruption mask + a
# stronger warp. So the recommended default ("Standard") keeps the mask ON and
# accepts that the output looks processed. "Light" is kept but honestly labelled
# as effective only against basic OCR.
PRESETS: dict[str, dict] = {
    "Standard": dict(  # 標準 — looks processed but readable; stops weaker AI/OCR
        warp_enabled=True, warp_amplitude=2.5, warp_cell=0.05,
        noise_enabled=True, noise_sigma=6.0,
        mask_enabled=True, mask_opacity=0.11, use_grid=False,
        use_diagonal=True, use_crosshatch=True,
        rotate_180=True, flip_horizontal=True, blur_enabled=False,
    ),
    "Maximum": dict(  # 重度 — clearly processed; harder for AI
        warp_enabled=True, warp_amplitude=3.5, warp_cell=0.045,
        noise_enabled=True, noise_sigma=10.0,
        mask_enabled=True, mask_opacity=0.16, use_grid=True,
        use_diagonal=True, use_crosshatch=True,
        rotate_180=True, flip_horizontal=True, blur_enabled=False,
    ),
    "Extreme": dict(  # 極限 — maximises AI disruption; ugly, hard for humans too
        warp_enabled=True, warp_amplitude=11.0, warp_cell=0.02,
        noise_enabled=True, noise_sigma=18.0,
        mask_enabled=True, mask_opacity=0.30, use_grid=True,
        use_diagonal=True, use_crosshatch=True,
        spacing_min=5, spacing_max=9, line_width_min=1, line_width_max=2,
        rotate_180=True, flip_horizontal=True, blur_enabled=False,
    ),
}


def config_from_preset(name: str, **overrides) -> ProtectionConfig:
    """Build a config from a named preset, with optional field overrides."""
    base = PRESETS.get(name, {})
    return ProtectionConfig(**{**base, **overrides})


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _size_factor(size: tuple[int, int]) -> float:
    """Scale factor so px-based params adapt to arbitrary image sizes.

    Calibrated to 1.0 at a 1000px short side, clamped so tiny and huge images
    stay sensible.
    """
    short = min(size)
    return float(np.clip(short / 1000.0, 0.5, 3.0))


def _working_image(img: Image.Image) -> tuple[Image.Image, str]:
    """Return an RGB/RGBA copy and its mode (so alpha is preserved if present)."""
    if img.mode == "RGBA":
        return img, "RGBA"
    return img.convert("RGB"), "RGB"


# --------------------------------------------------------------------------- #
# Individual pipeline steps
# --------------------------------------------------------------------------- #
def _rotate_180(img: Image.Image) -> Image.Image:
    return img.transpose(Image.ROTATE_180)


def _flip_horizontal(img: Image.Image) -> Image.Image:
    return img.transpose(Image.FLIP_LEFT_RIGHT)


def _remap_strip(src: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> np.ndarray:
    """Bilinear resample full uint8 source `src` (H,W,C) at (map_x, map_y).

    `map_*` cover one horizontal strip (sh, W). Source rows are read from the
    whole image so vertical displacement across the strip edge is fine.
    """
    H, W = src.shape[:2]
    C = src.shape[2]

    x0 = np.floor(map_x).astype(np.int32)
    y0 = np.floor(map_y).astype(np.int32)
    wx = (map_x - x0).astype(np.float32)
    wy = (map_y - y0).astype(np.float32)
    x1 = x0 + 1
    y1 = y0 + 1
    np.clip(x0, 0, W - 1, out=x0)
    np.clip(x1, 0, W - 1, out=x1)
    np.clip(y0, 0, H - 1, out=y0)
    np.clip(y1, 0, H - 1, out=y1)

    out = np.empty((map_x.shape[0], W, C), dtype=np.float32)
    for c in range(C):
        ch = src[..., c]
        top = ch[y0, x0].astype(np.float32)
        top += (ch[y0, x1].astype(np.float32) - top) * wx
        bot = ch[y1, x0].astype(np.float32)
        bot += (ch[y1, x1].astype(np.float32) - bot) * wx
        out[..., c] = top + (bot - top) * wy
    return np.clip(out, 0, 255).astype(np.uint8)


def _apply_warp(img: Image.Image, cfg: ProtectionConfig, np_rng: np.random.Generator) -> Image.Image:
    """Smooth low-amplitude displacement field. Alpha (if any) is warped too.

    Processed in row-strips so peak memory stays bounded (~hundreds of MB) even
    for 12MP+ phone photos on a small host.
    """
    work, mode = _working_image(img)
    src = np.asarray(work)  # uint8, full image
    H, W, C = src.shape

    amp = cfg.warp_amplitude * _size_factor((W, H))
    cell = max(8, int(min(W, H) * cfg.warp_cell))
    gh = max(2, H // cell + 2)
    gw = max(2, W // cell + 2)

    # Coarse random field -> bicubic upscale = smooth displacement field.
    dx_small = np_rng.uniform(-1.0, 1.0, (gh, gw)).astype(np.float32)
    dy_small = np_rng.uniform(-1.0, 1.0, (gh, gw)).astype(np.float32)
    dx = np.asarray(Image.fromarray(dx_small, mode="F").resize((W, H), Image.BICUBIC),
                    dtype=np.float32) * amp
    dy = np.asarray(Image.fromarray(dy_small, mode="F").resize((W, H), Image.BICUBIC),
                    dtype=np.float32) * amp

    out = np.empty((H, W, C), dtype=np.uint8)
    xs_row = np.arange(W, dtype=np.float32)
    strip = max(256, 1_000_000 // max(1, W))  # ~1 megapixel per strip
    for r0 in range(0, H, strip):
        r1 = min(H, r0 + strip)
        rows = np.arange(r0, r1, dtype=np.float32)
        map_x = xs_row[None, :] + dx[r0:r1]
        map_y = rows[:, None] + dy[r0:r1]
        out[r0:r1] = _remap_strip(src, map_x, map_y)

    return Image.fromarray(out, mode=mode)


def _draw_line_set(draw: ImageDraw.ImageDraw, size: tuple[int, int], rng: random.Random,
                   orientation: str, cfg: ProtectionConfig, alpha: int, factor: float) -> None:
    """Draw one family of jittered lines. Spacing scales with image size."""
    w, h = size
    spacing = max(4, int(rng.randint(cfg.spacing_min, cfg.spacing_max) * factor))

    c = -h
    end = w + h
    while c < end:
        jitter = rng.randint(-spacing // 3 or -1, spacing // 3 or 1)
        pos = c + jitter
        width = rng.randint(cfg.line_width_min, cfg.line_width_max)
        grey = rng.randint(40, 110)
        a = max(0, min(255, alpha + rng.randint(-20, 20)))
        colour = (grey, grey, grey, a)

        if orientation == "diag":
            draw.line([(pos, 0), (pos + h, h)], fill=colour, width=width)
        elif orientation == "anti":
            draw.line([(pos, 0), (pos - h, h)], fill=colour, width=width)
        elif orientation == "vert":
            if 0 <= pos <= w:
                draw.line([(pos, 0), (pos, h)], fill=colour, width=width)
        elif orientation == "horiz":
            if 0 <= pos <= h:
                draw.line([(0, pos), (w, pos)], fill=colour, width=width)
        c += spacing


def _apply_mask(img: Image.Image, cfg: ProtectionConfig, rng: random.Random) -> Image.Image:
    size = img.size
    factor = _size_factor(size)
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    alpha = int(round(255 * cfg.mask_opacity))

    if cfg.use_diagonal:
        _draw_line_set(draw, size, rng, "diag", cfg, alpha, factor)
    if cfg.use_crosshatch:
        _draw_line_set(draw, size, rng, "anti", cfg, alpha, factor)
    if cfg.use_grid:
        grid_cfg = ProtectionConfig(**{**cfg.to_dict(),
                                       "spacing_min": max(6, cfg.spacing_min // 2),
                                       "spacing_max": max(8, cfg.spacing_max // 2)})
        _draw_line_set(draw, size, rng, "vert", grid_cfg, alpha, factor)
        _draw_line_set(draw, size, rng, "horiz", grid_cfg, alpha, factor)

    base = img.convert("RGBA")
    result = Image.alpha_composite(base, overlay)
    # Don't carry an alpha channel downstream unless the source had one.
    return result if img.mode == "RGBA" else result.convert("RGB")


def _apply_noise(img: Image.Image, cfg: ProtectionConfig, np_rng: np.random.Generator) -> Image.Image:
    """Add light Gaussian noise to the colour channels (alpha untouched).

    Strip-based and in-place so memory stays bounded on large photos.
    """
    work, mode = _working_image(img)
    out = np.array(work)  # writable uint8 copy
    H, W = out.shape[:2]
    strip = max(256, 1_000_000 // max(1, W))  # ~1 megapixel per strip
    for r0 in range(0, H, strip):
        r1 = min(H, r0 + strip)
        block = out[r0:r1, :, :3].astype(np.int16)
        noise = (np_rng.standard_normal((r1 - r0, W, 3), dtype=np.float32)
                 * cfg.noise_sigma).astype(np.int16)
        block += noise
        np.clip(block, 0, 255, out=block)
        out[r0:r1, :, :3] = block.astype(np.uint8)
    return Image.fromarray(out, mode=mode)


def _apply_blur(img: Image.Image, cfg: ProtectionConfig) -> Image.Image:
    return img.filter(ImageFilter.GaussianBlur(radius=cfg.blur_radius))


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def process_image(img: Image.Image, cfg: ProtectionConfig) -> Image.Image:
    """Run the full protection pipeline. Output size == input size."""
    img = _normalise_orientation(img)
    # Normalise to RGB once up front (RGBA only if the source actually has alpha),
    # so every step works in a predictable, memory-lean mode.
    img = img.convert("RGBA") if "A" in img.getbands() else img.convert("RGB")
    original_size = img.size

    rng = random.Random(cfg.seed)
    np_rng = np.random.default_rng(cfg.seed)

    if cfg.rotate_180:
        img = _rotate_180(img)
    if cfg.flip_horizontal:
        img = _flip_horizontal(img)
    if cfg.warp_enabled:
        img = _apply_warp(img, cfg, np_rng)
    if cfg.mask_enabled:
        img = _apply_mask(img, cfg, rng)
    if cfg.noise_enabled:
        img = _apply_noise(img, cfg, np_rng)
    if cfg.blur_enabled:
        img = _apply_blur(img, cfg)

    assert img.size == original_size, "pipeline must preserve dimensions"
    return img


def _normalise_orientation(img: Image.Image) -> Image.Image:
    """Apply any EXIF rotation, then drop EXIF so it isn't re-applied."""
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    return img


def encode_image(img: Image.Image, fmt: str = "PNG", jpg_quality: int = 92) -> bytes:
    """Serialise to bytes in the requested format ('PNG' or 'JPG'/'JPEG')."""
    fmt = fmt.upper()
    buf = io.BytesIO()
    if fmt in ("JPG", "JPEG"):
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        else:
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=jpg_quality, optimize=True)
    else:
        img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def protect_bytes(data: bytes, cfg: ProtectionConfig, out_format: str = "PNG") -> bytes:
    """Convenience: bytes in -> protected bytes out (handy for an API layer)."""
    img = Image.open(io.BytesIO(data))
    processed = process_image(img, cfg)
    return encode_image(processed, out_format)


# Noto Sans CJK — covers both Traditional and Simplified Chinese (server-side only,
# so its size doesn't affect what the browser downloads).
_BAND_FONT = Path(__file__).parent / "assets" / "band-font.otf"


def add_title_band(
    img: Image.Image, title: str = "", author: str = "", date: str = ""
) -> Image.Image:
    """Prepend a parchment band with the work's title / author / date to the top.

    Drawn crisp (not warped) and meant to be flipped together with the image, so a
    reader who flips the result back sees the credit upright and legible. Returns a
    taller image (band height + original). No-op if all fields are empty.
    """
    title = (title or "").strip()
    author = (author or "").strip()
    date = (date or "").strip()
    if not (title or author or date):
        return img

    base = img.convert("RGB")
    W, H = base.size
    pad = max(10, int(W * 0.03))
    font_path = str(_BAND_FONT)

    def _fit(text: str, start_frac: float, min_px: int = 14) -> ImageFont.FreeTypeFont:
        size = max(min_px, int(W * start_frac))
        while size > min_px:
            f = ImageFont.truetype(font_path, size)
            if f.getbbox(text)[2] <= W - 2 * pad:
                return f
            size -= 2
        return ImageFont.truetype(font_path, min_px)

    lines = []
    if title:
        lines.append((title, _fit(title, 0.055)))
    meta = "　·　".join(p for p in [("作者：" + author) if author else "", date] if p)
    if meta:
        lines.append((meta, _fit(meta, 0.038)))

    gap = max(4, int(W * 0.012))
    bboxes = [(t, f, f.getbbox(t)) for t, f in lines]
    text_h = sum(b[3] - b[1] for _, _, b in bboxes) + gap * (len(bboxes) - 1)
    band_h = text_h + pad * 2

    parchment = (239, 226, 196)
    band = Image.new("RGB", (W, band_h), parchment)
    d = ImageDraw.Draw(band)
    y = pad
    for t, f, b in bboxes:
        w = b[2] - b[0]
        d.text(((W - w) // 2 - b[0], y - b[1]), t, fill=(58, 42, 23), font=f)
        y += (b[3] - b[1]) + gap
    d.line([(0, band_h - 1), (W, band_h - 1)], fill=(123, 45, 38), width=max(2, int(W * 0.004)))

    out = Image.new("RGB", (W, band_h + H), parchment)
    out.paste(band, (0, 0))
    out.paste(base, (0, band_h))
    return out
