# 預言家日報

《預言家日報》是一個以魔法世界為主題的私人邀請制閱讀平台，提供小說閱讀、系列收藏、論壇式羊皮紙、作者投稿、內容審核及成員管理。

平台以手機與 PWA 使用體驗為主，只有持有效邀請連結的成員能建立帳號。不同身份會看到不同的閱讀、創作與管理功能。

## 線上入口

- GitHub Pages：<https://surf0912.github.io/prophet-daily/>
- Render 新加坡鏡像及 API：<https://the-prophet-daily.onrender.com>

Render 同時提供前端鏡像，作為部分無法穩定連線 GitHub Pages 地區的備援入口。（舊 Oregon 過渡鏡像已於 2026-07-24 移除。）

## 主要功能

平台涵蓋小說閱讀（書架、系列、搜尋篩選、跨裝置續讀、繁簡切換）、畫作展示（留影走廊）、社群互動（許願池、問題回報、貓頭鷹通知）、作家投稿與審核，以及成員與內容管理。細部功能以站內為準，不在此逐項列出。

## 身份與權限

站內分 `reader`、`writer`、`admin`、`super_admin` 四種身份，權限逐級提高。所有權限檢查都在後端 API 進行，前端的顯示與隱藏只是介面層。

## 技術架構

- **前端**：原生 HTML、CSS、JavaScript，集中於 `index.html`
- **後端**：FastAPI / Uvicorn，已拆到私有 repo `surf0912/prophet-daily-api`
- **資料與登入**：Supabase Auth + PostgreSQL
- **前端部署**：GitHub Pages
- **後端及備援前端**：Render 新加坡 service `the-prophet-daily`
- **PWA**：Web App Manifest + Service Worker
- **備份**：私有後端 repo 的 GitHub Actions + `pg_dump` + GPG AES-256

```text
瀏覽器 / PWA
├── GitHub Pages（主要前端）
└── Render 新加坡（API + 前端鏡像）
        └── FastAPI
              └── Supabase Auth / PostgreSQL
```

後端使用 Supabase service role 存取資料，因此所有讀寫權限都必須由 FastAPI 路由再次驗證。請勿把 service role key 放進前端、commit 或公開日誌。

## 專案結構

```text
.
├── index.html                 # 前端語意結構與嚴格 Content Security Policy
├── app.js                     # 前端互動及畫面渲染邏輯
├── safe-events.js             # CSP-safe、allowlist 宣告式事件分派器
├── styles.css                 # 前端樣式與響應式版面
├── service-worker.js          # PWA 快取與離線殼層
├── manifest.json              # PWA 名稱、主題與圖示
├── zhconv.js                  # 繁簡逐字轉換表
├── chars/                     # 官方角色封面圖
├── wallpapers/                # 手機桌布圖
├── artwork/                   # 作品文首插圖（<作品id>.jpg 約定式）
├── gallery-frames/            # 留影走廊畫框素材
├── tools/                     # 封面／插圖／版本 bump 輔助腳本
├── supabase/schema.sql        # 前端參考用 schema 快照；正式遷移在私有後端 repo
├── tests/test_frontend_safety.py
└── .github/
    └── workflows/ci.yml       # 前端語法與輸出安全檢查
```

## 本地啟動

專案內的 Claude Code launch 設定使用：

```bash
npx serve -p 3333 .
```

目前正式前端的 `API` 常數指向 `https://the-prophet-daily.onrender.com`。如需以本機後端測試，請暫時改成 `http://localhost:8000`，並在私有後端 repo 的 `ALLOWED_ORIGINS` 放行本機來源。

## Supabase

正式 Supabase schema 與遷移以私有後端 repo `surf0912/prophet-daily-api` 為準。這個公開 repo 只保留前端需要的參考快照；建立全新環境前，不要只依賴這裡的 `supabase/schema.sql`。

- `profiles.last_seen_at`
- `profiles.auto_publish`
- `profiles.home_chars`
- `novels.locked`
- `custom_characters`
- `custom_char_tags`

不要直接假設現有 `schema.sql` 已能完整重建正式環境。

## 部署

### GitHub Pages

前端由 `main` 分支部署。`index.html` 採 network-first，因此重新整理時會優先取得最新版。

### Render

Render 部署設定在私有後端 repo `surf0912/prophet-daily-api`。公開前端只需要確認 `app.js` 的 `API` 指向正式 service；自 v3.43 起，從 Render 鏡像開啟時 API 會改打同源，避免部分地區跨域連不上：

```js
const API = location.hostname.endsWith('.onrender.com') ? location.origin : 'https://the-prophet-daily.onrender.com';
```

Render 免費方案可能休眠；前端會預先喚醒服務，並在請求較慢時顯示友善提示及自動重試。

### PWA 版本

更新 PWA 資產時，以下版本必須一致：

- `app.js` 的 `APP_VERSION`
- `service-worker.js` 的 `CACHE_NAME`

目前版本：`v5.59`（可用 `tools/bump.py` 一次進位）

版本不一致時，前端的 self-heal 機制會清除舊 Service Worker 和快取後重新載入。

## 備份

最高管理員可從監看頁下載站內內容 JSON。完整災難復原備份由私有後端 repo 的 GitHub Actions 每日執行，使用 PostgreSQL 17 `pg_dump`、gzip 與 GPG AES-256 加密，成品保留七天。

需要在 GitHub Actions Secrets 設定：

- `SUPABASE_DB_URL`
- `BACKUP_PASSPHRASE`

請另外安全保存備份密語；沒有密語便無法還原加密備份。

## 安全提醒

- 不要提交 `.env`、Supabase service role key、JWT secret 或備份密語；這些只應存在私有後端 repo / Render / GitHub Actions Secrets。
- 邀請碼屬於一次性的秘密能力，不應公開張貼。
- 新增 API 時請在私有後端 repo 同時檢查登入身份、角色、作品狀態、擁有者、鎖定狀態及受限內容權限。
- 正式 API 已在私有後端關閉 `/docs`、`/redoc` 和 `/openapi.json`。

## 專案狀態

這是私人社群使用中的持續開發專案，不是公開註冊服務。功能及資料結構會依實際成員需求繼續調整。
