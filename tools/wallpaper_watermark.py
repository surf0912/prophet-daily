#!/usr/bin/env python3
"""把高清原檔做成「桌布版」：縮到手機桌布解析度，右下角加上浮水印,輸出 JPEG。

用法：
    /usr/bin/python3 tools/wallpaper_watermark.py <輸入資料夾> [輸出資料夾] [浮水印圖.png]

  輸入資料夾：你的高清原檔（.jpg/.jpeg/.png/.webp）
  輸出資料夾：預設 ./wallpapers（直接可放 repo 給前端抓）
  浮水印圖  ：可選。給一張去背 PNG（透明背景）就疊那張 logo;不給則改印「預言家日報」文字。
              這張 logo 若在輸入資料夾裡，會自動排除、不會被當素材處理。

輸出檔名：<原檔名>_wall.jpg。畫質只會縮小、不會放大。
注意：你的 `python3` 是 3.14 沒裝 Pillow,請用 `/usr/bin/python3`(3.9，已裝 Pillow)。
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageFilter

MARK = "預言家日報"          # 文字浮水印(沒給 logo 時用)
MAX_W, MAX_H = 99999, 99999   # 不壓解析度：直接用原檔尺寸，只加浮水印（不放大）
JPEG_Q = 92
LOGO_W_RATIO = 0.40         # logo 寬 = 桌布寬的比例(放大)
PAD_RATIO = 0.045           # 距邊距 = 桌布寬的比例
LOGO_OPACITY = 0.95         # logo 透明度(1=完全不透明)
LOGO_DARKEN = 0.80          # 把金色壓暗(1=原色, 0.8=壓暗 20%)
GLOW_OPACITY = 0.32         # logo 後方暗色光暈濃度(很淡, 讓 logo 在亮背景也浮得出來)

FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def overlay_logo(im, logo):
    w, h = im.size
    lw = max(40, int(w * LOGO_W_RATIO))
    lh = max(1, int(logo.height * lw / logo.width))
    lg = logo.resize((lw, lh), Image.LANCZOS)
    if LOGO_DARKEN < 1:   # 壓暗金色(只動 RGB，保留透明通道)→ 沉穩暗金
        r, g, b, a = lg.split()
        rgb = ImageEnhance.Brightness(Image.merge("RGB", (r, g, b))).enhance(LOGO_DARKEN)
        lg = Image.merge("RGBA", (*rgb.split(), a))
    if LOGO_OPACITY < 1:
        alpha = lg.split()[3].point(lambda p: int(p * LOGO_OPACITY))
        lg.putalpha(alpha)
    pad = int(w * PAD_RATIO)
    x, y = w - lw - pad, h - lh - pad
    base = im.convert("RGBA")
    if GLOW_OPACITY > 0:   # 很淡的暗色光暈(模糊橢圓),墊在 logo 後面增加對比
        gw, gh = int(lw * 1.3), int(lh * 1.3)
        glow = Image.new("RGBA", (gw, gh), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse([0, 0, gw, gh], fill=(0, 0, 0, int(255 * GLOW_OPACITY)))
        glow = glow.filter(ImageFilter.GaussianBlur(int(lw * 0.13)))
        base.alpha_composite(glow, (x + lw // 2 - gw // 2, y + lh // 2 - gh // 2))
    base.alpha_composite(lg, (x, y))
    return base.convert("RGB")


def overlay_text(im):
    w, h = im.size
    draw = ImageDraw.Draw(im, "RGBA")
    font = load_font(max(20, w // 22))
    bbox = draw.textbbox((0, 0), MARK, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    pad = int(w * PAD_RATIO)
    x = w - tw - pad - bbox[0]
    y = h - th - pad - bbox[1]
    draw.text((x + 2, y + 2), MARK, font=font, fill=(0, 0, 0, 105))
    draw.text((x, y), MARK, font=font, fill=(255, 250, 236, 215))
    return im


def process(src, dst, logo):
    im = Image.open(src).convert("RGB")
    im.thumbnail((MAX_W, MAX_H), Image.LANCZOS)   # 只縮不放
    im = overlay_logo(im, logo) if logo is not None else overlay_text(im)
    im.save(dst, "JPEG", quality=JPEG_Q)
    print(f"  ✓ {os.path.basename(dst):32s} {im.size[0]}x{im.size[1]}")


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: /usr/bin/python3 tools/wallpaper_watermark.py <輸入資料夾> [輸出資料夾] [浮水印圖.png]")
        return
    indir = args[0]
    outdir = args[1] if len(args) > 1 else "wallpapers"
    logo_path = args[2] if len(args) > 2 else None
    logo = Image.open(logo_path).convert("RGBA") if logo_path else None
    logo_name = os.path.basename(logo_path) if logo_path else None
    os.makedirs(outdir, exist_ok=True)
    exts = (".jpg", ".jpeg", ".png", ".webp")
    files = [f for f in sorted(os.listdir(indir)) if f.lower().endswith(exts) and f != logo_name]
    if not files:
        print(f"在 {indir} 找不到圖片")
        return
    print(f"處理 {len(files)} 張（浮水印：{'logo ' + logo_name if logo else '文字 ' + MARK}）→ {outdir}/")
    for fn in files:
        base = os.path.splitext(fn)[0]
        process(os.path.join(indir, fn), os.path.join(outdir, base + "_wall.jpg"), logo)
    print("完成。")


if __name__ == "__main__":
    main()
