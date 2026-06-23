# 預言家日報

《預言家日報》是一個以魔法世界為主題的私人邀請制閱讀平台，提供小說閱讀、系列收藏、論壇式羊皮紙、作者投稿、內容審核及成員管理。

平台以手機與 PWA 使用體驗為主，只有持有效邀請連結的成員能建立帳號。不同身份會看到不同的閱讀、創作與管理功能。

## 線上入口

- GitHub Pages：<https://surf0912.github.io/prophet-daily/>
- Render 鏡像及 API：<https://prophet-daily.onrender.com>

Render 同時提供前端鏡像，作為部分無法穩定連線 GitHub Pages 地區的備援入口。

## 主要功能

### 閱讀體驗

- 「心動」角色封面與隨機問候
- 「意若思鏡」小說書架
- 作品搜尋、分類及角色篩選
- 任一角色／角色同框篩選模式
- 系列作品分組與上下篇導覽
- 整篇收藏與新篇章提示
- 最近 24 小時熱門作品排序
- 閱讀進度及捲動位置保存
- 閱讀器字級、夜間模式與魔法字體
- 個人化浮水印及複製保護

### 內容分類

- **迷情劑**：受限制內容，讀者與作家需提出申請並由管理員開放
- **吐真劑**：一般故事分類
- **儲思盆**：一般故事分類
- **羊皮紙**：論壇式文章與樓層內容

### 社群與回報

- 羊皮紙留言收藏
- 匿名許願池
- 私人問題回報
- 管理員回覆及處理狀態
- 常見問題

### 作家與編輯部

- 直接貼上內文或匯入 `.txt`
- 本機自動保存未送出草稿
- 自訂發佈日期及未來排程
- 作品分類、角色及系列設定
- 共同擁有者
- 作者自行鎖定／隱藏作品
- 投稿審核與指定作家自動通過
- 每位新作家的可刪除入職指南

### 管理功能

- 成員、身份及活躍狀態管理
- 迷情劑閱讀權申請
- 帳號封禁、刪除及密碼重設
- 單次、三日有效的邀請連結
- 最高管理員批次產生邀請
- 即時伺服器負載、記憶體及回應時間監看
- 一鍵匯出站內內容 JSON
- 每日加密 PostgreSQL 備份

### 實驗功能

目前最高管理員可在本機開啟 beta 功能，建立只有自己能看見的自創角色，並用私人標籤整理作品。相關 API 仍限制為 `super_admin`。

## 身份與權限

| 身份 | 主要權限 |
| --- | --- |
| `reader` | 閱讀公開作品、收藏、許願、回報問題、申請迷情劑權限 |
| `writer` | 包含讀者功能，另可建立及管理自己的作品 |
| `admin` | 審核作品、管理一般成員、迷情劑權限及邀請連結 |
| `super_admin` | 完整管理權、身份調整、帳號刪除、監看、備份及 beta 功能 |

## 技術架構

- **前端**：原生 HTML、CSS、JavaScript，集中於 `index.html`
- **後端**：FastAPI / Uvicorn
- **資料與登入**：Supabase Auth + PostgreSQL
- **前端部署**：GitHub Pages
- **後端及備援前端**：Render
- **PWA**：Web App Manifest + Service Worker
- **備份**：GitHub Actions + `pg_dump` + GPG AES-256

```text
瀏覽器 / PWA
├── GitHub Pages（主要前端）
└── Render（API + 前端鏡像）
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
├── main.py                    # FastAPI 入口、路由及靜態檔案服務
├── deps.py                    # Supabase client、JWT 驗證及角色守門
├── config.py                  # 環境變數設定
├── monitor.py                 # 輕量伺服器監看
├── guide_content.py           # 作家入職指南內容
├── routers/
│   ├── auth.py                # 登入、續期及個人資料
│   ├── novels.py              # 作品、系列、收藏及熱門排序
│   ├── chapters.py            # 章節讀寫
│   ├── permissions.py         # 成員、角色及內容權限
│   ├── invites.py             # 邀請與註冊
│   ├── feedback.py            # 許願池、問題回報及 FAQ
│   └── custom_characters.py   # 私人自創角色 beta
├── supabase/schema.sql        # 初始 schema 與部分冪等遷移
├── service-worker.js          # PWA 快取與離線殼層
├── manifest.json              # PWA 名稱、主題與圖示
├── chars/                     # 官方角色封面圖
├── requirements.in            # 人工維護的直接 Python 依賴
├── requirements.lock          # CI/Render 共用的完整固定版本
└── .github/
    ├── dependabot.yml         # 每週依賴更新提醒
    └── workflows/
        ├── ci.yml             # 編譯、安全測試及套件漏洞掃描
        └── backup.yml         # 每日加密資料庫備份
```

## 本地啟動

### 1. 準備環境變數

```bash
cp .env.example .env
```

填入：

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-role-key
JWT_SECRET=your-supabase-jwt-secret
ALLOWED_ORIGINS=https://surf0912.github.io,http://localhost:3000
```

`.env` 不應加入版本控制。

### 2. 啟動後端

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. 啟動前端

專案內的 Claude Code launch 設定使用：

```bash
npx serve -p 3333 .
```

目前正式前端的 `API` 常數指向 Render。如需以本機後端測試，請暫時改成 `http://localhost:8000`，並把本機來源加入 `ALLOWED_ORIGINS`。

## Supabase

新環境可由 `supabase/schema.sql` 建立基礎資料表與安全政策。這個專案曾快速迭代，正式資料庫另包含後期欄位及 beta 資料表；建立全新環境前，應先比對目前後端使用的欄位，尤其是：

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

```text
Build command: pip install -r requirements.txt
Start command: uvicorn main:app --host 0.0.0.0 --port $PORT
```

Render 免費方案可能休眠；前端會預先喚醒服務，並在請求較慢時顯示友善提示及自動重試。

### PWA 版本

更新 PWA 資產時，以下版本必須一致：

- `index.html` 的 `APP_VERSION`
- `service-worker.js` 的 `CACHE_NAME`

目前版本：`v2.19`

版本不一致時，前端的 self-heal 機制會清除舊 Service Worker 和快取後重新載入。

## 備份

最高管理員可從監看頁下載站內內容 JSON。完整災難復原備份由 GitHub Actions 每日執行，使用 PostgreSQL 17 `pg_dump`、gzip 與 GPG AES-256 加密，成品保留七天。

需要在 GitHub Actions Secrets 設定：

- `SUPABASE_DB_URL`
- `BACKUP_PASSPHRASE`

請另外安全保存備份密語；沒有密語便無法還原加密備份。

## 安全提醒

- 不要提交 `.env`、Supabase service role key、JWT secret 或備份密語。
- 邀請碼屬於一次性的秘密能力，不應公開張貼。
- 新增 API 時必須同時檢查登入身份、角色、作品狀態、擁有者、鎖定狀態及迷情劑權限。
- 正式 API 已關閉 `/docs`、`/redoc` 和 `/openapi.json`。

## 專案狀態

這是私人社群使用中的持續開發專案，不是公開註冊服務。功能及資料結構會依實際成員需求繼續調整。
