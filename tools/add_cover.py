#!/usr/bin/env python3
"""心動封面「標準化」處理工具。

把一張（或多張）原圖轉成網站要的兩個版本：
  ‧ 顯示版 → chars/<name>.JPG    首頁 hero + 角色資料頁 gallery 用；壓小才不會「圖跑不出來」
  ‧ 下載版 → wallpapers/<name>_wall.jpg   角色頁「浮水印下載」用；用原圖＋浮水印保持清晰

用法：
    /usr/bin/python3 tools/add_cover.py <圖檔…或資料夾>

檔名決定型別（一定要照命名規則）：
    *_phone_*    手機直式封面 → 顯示版壓到 ≤1080 寬(q80) ＋ 產生浮水印下載版
    *_desktop_*  桌機橫式封面 → 顯示版壓到 ≤1366 寬(q82)；桌機不進 gallery、不做浮水印

輸出後會印出「還要手動做的事」(改 CHARS、日夜分類、bump 版本)——這些是程式碼/判斷，工具不碰。

注意：Homebrew 的 python3(3.14) 沒裝 Pillow。一律用 /usr/bin/python3(3.9，已裝 Pillow)。
"""
import os
import sys
import glob
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wallpaper_watermark import overlay_logo   # 沿用同一顆浮水印邏輯，樣式一致

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHARS_DIR = os.path.join(REPO, "chars")
WALL_DIR = os.path.join(REPO, "wallpapers")
LOGO = os.path.join(REPO, "tools", "watermark_logo.png")   # repo 內建，不依賴 wp
PHONE_MAX_W, DESK_MAX_W = 1080, 1366
DISPLAY_Q, WALL_Q = 80, 92


def process(src):
    name = os.path.splitext(os.path.basename(src))[0]
    is_phone = "_phone_" in name
    is_desk = "_desktop_" in name
    if not (is_phone or is_desk):
        print(f"  ⚠ 跳過 {os.path.basename(src)}：檔名要含 _phone_ 或 _desktop_")
        return None
    orig = Image.open(src).convert("RGB")
    w, h = orig.size
    max_w = PHONE_MAX_W if is_phone else DESK_MAX_W
    disp = orig.resize((max_w, round(h * max_w / w)), Image.LANCZOS) if w > max_w else orig
    disp_path = os.path.join(CHARS_DIR, name + ".JPG")
    disp.save(disp_path, "JPEG", quality=DISPLAY_Q, optimize=True)
    msg = f"  ✓ chars/{name}.JPG  {disp.size[0]}x{disp.size[1]}  {os.path.getsize(disp_path)//1024}KB"
    if is_phone:
        wm = overlay_logo(orig, Image.open(LOGO).convert("RGBA"))   # 浮水印疊在原圖上（下載版要清晰）
        wm_path = os.path.join(WALL_DIR, name + "_wall.jpg")
        wm.save(wm_path, "JPEG", quality=WALL_Q)
        msg += f"   +  wallpapers/{name}_wall.jpg  {os.path.getsize(wm_path)//1024}KB"
    print(msg)
    return (name, "phone" if is_phone else "desktop")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    files = []
    for a in args:
        files += sorted(glob.glob(os.path.join(a, "*"))) if os.path.isdir(a) else [a]
    files = [f for f in files if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
    if not files:
        print("找不到圖片")
        return
    print(f"處理 {len(files)} 張 →")
    done = [d for d in (process(f) for f in files) if d]
    phones = [n for n, t in done if t == "phone"]
    desks = [n for n, t in done if t == "desktop"]
    print("\n── 接著手動做（程式碼/判斷，工具不碰）──")
    if phones:
        print(f"  1) app.js CHARS：把 {', '.join(phones)} 加進對應角色的 imgs（手機）")
    if desks:
        print(f"     app.js CHARS：把 {', '.join(desks)} 加進對應角色的 imgsD（桌機）")
    print("  2) 日夜分類：有日光/明亮→MORNING_COVERS；日落黃昏→AFTERNOON_COVERS；無陽光不加(=夜晚)")
    print("  3) bump APP_VERSION + service-worker CACHE_NAME（兩者必須一致）")
    print("  4) esprima 驗語法 → git add/commit/push → 提醒上 Render 手動 Deploy")


if __name__ == "__main__":
    main()
