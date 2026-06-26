const CACHE_NAME = 'prophet-daily-v2.61';
const ASSETS = [
  './styles.css',
  './app.js',
  './safe-events.js',
  './manifest.json',
  './favicon.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './maskable-192.png',
  './maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => {
      if (key !== CACHE_NAME) return caches.delete(key);
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
        .catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
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

  // Static assets: cache-first + store on first fetch so refreshes are instant/offline.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
