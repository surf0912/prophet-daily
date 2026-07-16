const CACHE_NAME = 'prophet-daily-v4.32';
// 圖片與字型的常駐快取：跨版本保留（activate 不清），避免每次發版把使用者存好的
// ~10MB 心動封面全部作廢重抓。內容物都是不改內容的靜態檔；若真要強制換新，把 -v1 進位。
const STATIC_CACHE = 'prophet-daily-static-v1';
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './safe-events.js',
  './zhconv.js',
  './assets/offline_sean.webp',
  './assets/offline_silas.webp',
  './assets/offline_eli.webp',
  './assets/offline_adrian.webp',
  './manifest.json',
  './favicon.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './maskable-192.png',
  './maskable-512.png'
];

self.addEventListener('install', (event) => {
  // Precache each asset with a version-stamped, no-store fetch, then store it under its BARE url.
  // Why: the Render mirror (and any CDN/HTTP cache) can hand a plain `addAll` a STALE app.js, so the
  // new version's cache ends up holding old code — APP_VERSION never advances and the update button
  // loops forever. The ?swv=<version> query is a guaranteed cache-miss → the real new file from
  // origin; storing under the bare url means the fetch handler (which matches bare requests) serves
  // it. Per-asset catch so one 404 can't fail the whole install.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
    ASSETS.map((u) => fetch(new Request(u + (u.includes('?') ? '&' : '?') + 'swv=' + CACHE_NAME, { cache: 'no-store' }))
      .then((res) => (res && res.ok) ? cache.put(u, res) : undefined)
      .catch(() => undefined))
  )));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => {
      if (key !== CACHE_NAME && key !== STATIC_CACHE) return caches.delete(key);
    })))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // HTML / navigation: network-first so UI updates show up without bumping the SW.
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(
      // no-store: bypass the browser HTTP cache so UI updates always show on reload.
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        // Network failed (offline, flaky, or GitHub Pages blocked/throttled on some CN networks).
        // Fall back through the cache, and ALWAYS end in a real Response — never resolve to null,
        // or Safari throws "FetchEvent.respondWith received an error: Returned response is null"
        // and the whole page fails to open instead of degrading gracefully.
        .catch(() => caches.match(req)
          .then((c) => c || caches.match('./index.html'))
          .then((c) => c || caches.match('./'))
          .then((c) => c || new Response(
            '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>預言家日報</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:#141019;color:#e7d9b8;font-family:-apple-system,\'PingFang TC\',sans-serif;line-height:1.8"><div><p>目前連線不穩，暫時打不開。</p><p style="font-size:14px;opacity:.7">請確認網路後重新整理。</p><p style="font-size:13px;margin-top:10px">或改用鏡像入口：<a href="https://the-prophet-daily.onrender.com/" style="color:#d8b24a">the-prophet-daily.onrender.com</a></p></div></body></html>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )))
    );
    return;
  }

  // SECURITY: on the Render mirror the frontend and the API share an origin, so a blanket
  // "cache every same-origin GET" would store authenticated API/JSON responses (/auth/me,
  // /permissions/users, /permissions/export, /chapters/…) and later serve them to a DIFFERENT
  // account after logout/switch. Only cache an allowlist of STATIC assets (by extension or the
  // /chars/ image folder); everything else — i.e. every API request — is left to default network
  // handling and is NEVER written to the cache.
  const isStaticAsset = req.method === 'GET' && (
    /\.(?:woff2?|ttf|otf|jpe?g|png|gif|svg|webp|ico|css|js|json)$/i.test(url.pathname)
    || url.pathname.startsWith('/chars/')
  );
  if (!isStaticAsset) return;   // API & everything dynamic: straight to network, no SW cache

  // 圖片/字型（內容不變的檔案）→ 常駐快取；js/css/json（隨版本更新）→ 版本快取，升版時照舊作廢。
  const persistent = /\.(?:woff2?|ttf|otf|jpe?g|png|gif|svg|webp|ico)$/i.test(url.pathname)
    || url.pathname.startsWith('/chars/');
  const bucket = persistent ? STATIC_CACHE : CACHE_NAME;

  // Static assets: cache-first + store on first fetch so refreshes are instant/offline.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(bucket).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
