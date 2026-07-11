# 心動封面 標準化處理流程

新增／更新一張心動封面時，照這份做，避免再出現「沒壓縮 → 圖跑不出來」那種事。

## 0. 命名（最重要，工具靠檔名判斷型別）
- 手機直式：`<角色小寫>_phone_<N>.png/jpg`　例：`sean_phone_5`
- 桌機橫式：`<角色小寫>_desktop_<N>.png/jpg`　例：`sean_desktop_3`
- 桌機第 1 張的角色首字大寫是歷史遺留（`Sean_desktop_1`），**新的一律全小寫**。
- 一張圖若同時要手機+桌機，就做兩個檔（直式一個、橫式一個），共用同一個 N 沒關係。

## 1. 跑工具（自動：壓縮顯示版 + 浮水印下載版）
```
/usr/bin/python3 tools/add_cover.py ~/Desktop/wp/sean_phone_5.png ~/Desktop/wp/sean_desktop_3.png
```
它會產生：
- `chars/<name>.webp` — 網站顯示版（v3.49 起 WebP q82；手機壓到 ≤1080 寬、桌機 ≤1366 寬；約 0.1–0.25MB）。
- `wallpapers/<name>_wall.jpg` — **手機才有**，用原圖＋浮水印 q92（角色頁「下載桌布」用）。

浮水印 logo 內建在 `tools/watermark_logo.png`（不依賴桌面 wp，之前 wp 的 logo 曾消失過）。
`python3` 要用 `/usr/bin/python3`（3.9 有 Pillow；Homebrew 的 3.14 沒有）。

## 2. 改 app.js 的 CHARS（手動）
把新檔加進對應角色：
- 手機 → 該角色的 `imgs: [...]`
- 桌機 → 該角色的 `imgsD: [...]`

## 3. 日夜分類（手動，看圖判斷）
在 app.js 的兩個集合裡二選一或都不加：
- **有陽光、明亮**（一般日光、晴天、溫室、窗光）→ `MORNING_COVERS`（早晨＆中午 06:00–14:30）
- **日落／黃昏金色光**→ `AFTERNOON_COVERS`（下午 14:30–18:00）
- **無陽光**（室內、暗水族箱、夜景、燭光）→ **兩個都不加**（預設就是夜晚 18:00–06:00）

## 4. Bump 版本（手動，一定要）
`app.js` 的 `APP_VERSION` 和 `service-worker.js` 的 `CACHE_NAME` **改成同一個新版號**。
不 bump 的話，舊 service worker 會繼續給快取裡的舊圖，使用者拿不到更新。

## 5. 驗證 → 推 → 部署
- esprima 驗語法（見健檢流程）。
- 確認每張 `chars/*.webp`（＋手機的 `wallpapers/*_wall.jpg`）都在、CHARS 引用大小寫一致。
- `git add -A && git commit && git push`。
- **提醒自己上 Render 手動 Deploy**（Manual Deploy → Deploy latest commit），中國鏡像才會同步。

## 規格速查
| 項目 | 值 |
| --- | --- |
| 手機顯示版寬 / 畫質 | ≤1080 / q80 |
| 桌機顯示版寬 / 畫質 | ≤1366 / q82 |
| 浮水印下載版 | 原圖尺寸 + logo / q92（手機限定） |
| 顯示版目標大小 | 約 0.2–0.4MB（別再出現 1MB+ 的顯示版） |
