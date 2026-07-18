// ── Block double-tap-to-zoom ─────────────────────────────────
// iOS Safari often ignores touch-action / user-scalable for double-tap zoom. Suppress the second
// of two quick taps; pinch-zoom and single taps still work. Skip form fields so text editing is
// unaffected.
(function () {
  let lastTap = 0;
  document.addEventListener('touchend', function (e) {
    const t = e.target;
    // .char-custom needs its real double-tap (= edit character); don't swallow the 2nd tap there.
    if (t && (t.closest('input, textarea, select, [contenteditable], .char-chip'))) { lastTap = 0; return; }
    const now = Date.now();
    if (now - lastTap <= 350) e.preventDefault();   // cancels the zoom gesture on the 2nd tap
    lastTap = now;
  }, { passive: false });
  // Block pinch-zoom too: iOS fires gesture* events; other browsers do a 2-finger touchmove.
  // (Avatar crop uses a slider + single-finger drag, so this doesn't affect it.)
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); }, { passive: false });
  });
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}());

// ── Config (update after deploy) ────────────────────────────
// 鏡像用戶（*.onrender.com）一律打「自己同源」的 API：中國讀者不必跨到新加坡那台
// （GFW 對個別 Render 區域的可達性不可靠，7/10 搬遷後全指新加坡曾造成鏡像用戶進不去）。
// github.io（Pages）用戶照舊打新加坡主後端。兩台後端共用同一個 Supabase，JWT 通用。
const API = location.hostname.endsWith('.onrender.com') ? location.origin : 'https://the-prophet-daily.onrender.com';

// ── Font toggle ───────────────────────────────────────────────
const APP_VERSION = 'v4.52';   // MUST match service-worker CACHE_NAME (self-heal compares them). Bump as v1.13, v1.14…
let magicFont = localStorage.getItem('pd_magic_font') !== 'off';

const MAGIC_FONT_CSS = `
html, body, *, *::before, *::after,
input, button, textarea, select, option, label,
h1, h2, h3, h4, h5, h6, p, span, div, a, li, td, th {
  font-family: 'YuseiMagic', 'Huninn', 'HuninnUI', 'SimpRound', 'PingFang SC', 'PingFang TC', 'Heiti SC', sans-serif !important;
}
input::placeholder, textarea::placeholder {
  font-family: 'YuseiMagic', 'Huninn', 'HuninnUI', 'SimpRound', 'PingFang SC', 'PingFang TC', 'Heiti SC', sans-serif !important;
}`;

const SYSTEM_FONT_CSS = `
html, body, *, *::before, *::after,
input, button, textarea, select, option, label,
h1, h2, h3, h4, h5, h6, p, span, div, a, li, td, th {
  font-family: system-ui, -apple-system, "PingFang TC", "Microsoft YaHei", sans-serif !important;
}
input::placeholder, textarea::placeholder {
  font-family: system-ui, -apple-system, "PingFang TC", "Microsoft YaHei", sans-serif !important;
}`;

function applyFont() {
  let el = document.getElementById('dynamic-font-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'dynamic-font-style';
    document.head.appendChild(el);
  }
  el.textContent = magicFont ? MAGIC_FONT_CSS : SYSTEM_FONT_CSS;
  const cb = document.getElementById('magic-font-toggle');
  if (cb) cb.checked = magicFont;
}

function toggleFont() {
  magicFont = !magicFont;
  localStorage.setItem('pd_magic_font', magicFont ? 'on' : 'off');
  applyFont();
}

applyFont();

// ── State ────────────────────────────────────────────────────
let token = localStorage.getItem('pd_token') || null;
let currentUser = null;
let novels = [];
let currentNovelId = null;
let currentChapters = [];
let currentChapterIdx = 0;
let replyToId = null;
let currentForumChapterId = null;

// ── API helper ───────────────────────────────────────────────
// 顯示連線中覆蓋層：任何前景請求超過 ~3.5 秒就浮出（升 Starter 後伺服器不再休眠，
// 這裡攔的是網路層的慢／掛住，不是冷啟動）。
let _wakeCount = 0;
function _wakeToggle(on) {
  const el = document.getElementById('waking-overlay');
  if (el) el.classList.toggle('show', on);
}
// Silently swap an expired access token for a fresh one using the stored refresh token,
// so the ~1h expiry doesn't force-logout active users. Deduped across concurrent calls.
let _refreshing = null;
async function tryRefreshToken() {
  const rt = localStorage.getItem('pd_refresh');
  if (!rt) return false;
  if (!_refreshing) {
    _refreshing = (async () => {
      try {
        const res = await fetch(API + '/auth/refresh', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (!res.ok) return false;
        const d = await res.json();
        if (!d.access_token) return false;
        token = d.access_token;
        localStorage.setItem('pd_token', token);
        if (d.refresh_token) localStorage.setItem('pd_refresh', d.refresh_token);
        return true;
      } catch { return false; }
    })();
  }
  const ok = await _refreshing;
  _refreshing = null;
  return ok;
}

async function api(path, opts = {}, _retried) {
  const headers = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const bg = opts.background;   // background polls (e.g. SA 監看) must never flash the 喚醒 overlay
  if (!bg) _wakeCount++;
  const wt = bg ? null : setTimeout(() => _wakeToggle(true), 3500);
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      // PWA 啟動時第一發連線常常「瞬間失敗」或「掛住不回」——伺服器端其實從沒收到（監看的
      // per-endpoint 最慢也只有幾百毫秒），所以那十秒全花在這個迴圈上。兩個對策：
      //  (1) 無 body 的請求（GET 與簡單 POST）加 5 秒逾時，掛住就中止改重試，不再乾等；
      //      有 body 的（上傳畫作等）不設限，免得大圖被砍。
      //  (2) 退避改成「首次極快」：300ms → 1s → 2.5s → 5s，取代原本的 2s → 4s → 6s。
      let _sig, _tid;
      if (!opts.body && typeof AbortController !== 'undefined') {
        const _c = new AbortController();
        _sig = _c.signal;
        _tid = setTimeout(() => _c.abort(), 5000);
      }
      try {
        res = await fetch(API + path, { ...opts, headers, ...(_sig ? { signal: _sig } : {}) });
        break;
      } catch (netErr) {
        if (attempt >= 4) throw netErr;            // 5 次後放棄
        if (!bg) _wakeToggle(true);
        await new Promise(r => setTimeout(r, [300, 1000, 2500, 5000][attempt] || 5000));
      } finally {
        if (_tid) clearTimeout(_tid);
      }
    }
    // A 401 from the login / invite-register forms means "wrong credentials" — surface that message
    // instead of treating it as an expired session (the refresh+logout path swallows it, so the user
    // saw nothing when they mistyped their 密碼).
    const _authSubmit = path === '/auth/signin' || path === '/invites/register';
    if (res.status === 401 && !_authSubmit) {
      // Try a one-time silent refresh + retry before giving up and logging out.
      if (!_retried && path !== '/auth/refresh' && await tryRefreshToken()) {
        return await api(path, opts, true);
      }
      doLogout(); return null;
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      // FastAPI 422 的 detail 是「驗證錯誤陣列」[{loc,msg,...}]，直接丟給 Error 會變成 [object Object]。
      // 攤平成可讀訊息（陣列取各 msg、物件取 msg），一般字串照舊。
      let d = e.detail;
      if (Array.isArray(d)) d = d.map(x => (x && x.msg) || '').filter(Boolean).join('；') || '輸入格式有誤';
      else if (d && typeof d === 'object') d = d.msg || JSON.stringify(d);
      throw new Error(d || 'Request failed');
    }
    return await res.json();
  } finally {
    if (wt) clearTimeout(wt);
    if (!bg) {
      _wakeCount = Math.max(0, _wakeCount - 1);
      if (_wakeCount === 0) _wakeToggle(false);
    }
  }
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('zh-TW') + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

function initials(name) { return name ? name[0].toUpperCase() : '?'; }

// Only image data URLs produced by our cropper are allowed into CSS/HTML. The backend enforces
// the same rule; this also protects the UI if an old or manually-edited database row is unsafe.
function safeAvatarDataUrl(value) {
  return typeof value === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value : '';
}

// Round avatar: the user's uploaded photo if any, else an initial on a scarlet circle.
function avatarHTML(u, px, extra) {
  const base = `width:${px}px;height:${px}px;border-radius:50%;flex-shrink:0;${extra || ''}`;
  const avatar = safeAvatarDataUrl(u && u.avatar_url);
  if (avatar) return `<div style="${base}background-image:url(&quot;${avatar}&quot;);background-position:center;background-size:cover;background-repeat:no-repeat"></div>`;
  const name = (u && (u.nickname || u.username)) || '?';
  return `<div style="${base}background:var(--scarlet);display:flex;align-items:center;justify-content:center;color:var(--gold);font-size:${Math.round(px * 0.44)}px">${escapeHtml(initials(name))}</div>`;
}

// Resize/center-crop an image file to a square data URL (keeps avatars tiny ~10-20KB).
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Avatar crop (drag to move, slider to zoom, before saving) ──
const _crop = { img: null, V: 260, scale: 1, minScale: 1, tx: 0, ty: 0, url: null, target: 'profile' };

function handleAvatarUpload(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { toast('請選擇圖片檔'); return; }
  _crop.target = 'profile';
  if (_crop.url) URL.revokeObjectURL(_crop.url);
  _crop.url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => openAvatarCrop(img);
  img.onerror = () => toast('圖片讀取失敗');
  img.src = _crop.url;
}

function _cropApply() {
  const el = document.getElementById('avatar-crop-img');
  el.style.transform = `translate(${_crop.tx}px, ${_crop.ty}px) scale(${_crop.scale})`;
}
function _cropClamp() {
  const { V, scale, img } = _crop;
  _crop.tx = Math.min(0, Math.max(V - img.naturalWidth * scale, _crop.tx));
  _crop.ty = Math.min(0, Math.max(V - img.naturalHeight * scale, _crop.ty));
}

function openAvatarCrop(img) {
  _crop.img = img;
  const V = _crop.V;
  _crop.minScale = V / Math.min(img.naturalWidth, img.naturalHeight);
  _crop.scale = _crop.minScale;
  _crop.tx = (V - img.naturalWidth * _crop.scale) / 2;
  _crop.ty = (V - img.naturalHeight * _crop.scale) / 2;
  const el = document.getElementById('avatar-crop-img');
  el.src = img.src;
  el.style.width = img.naturalWidth + 'px';
  el.style.height = img.naturalHeight + 'px';
  document.getElementById('avatar-crop-zoom').value = 1;
  _cropApply();
  document.getElementById('avatar-crop-modal').classList.add('open');
}

function avatarZoom(mult) {
  const { V } = _crop;
  const cx = (V / 2 - _crop.tx) / _crop.scale;   // keep viewport centre fixed
  const cy = (V / 2 - _crop.ty) / _crop.scale;
  _crop.scale = _crop.minScale * parseFloat(mult);
  _crop.tx = V / 2 - cx * _crop.scale;
  _crop.ty = V / 2 - cy * _crop.scale;
  _cropClamp(); _cropApply();
}

function avatarDragStart(ev) {
  ev.preventDefault();
  const p = ev.touches ? ev.touches[0] : ev;
  let lastX = p.clientX, lastY = p.clientY;
  const move = (e) => {
    const q = e.touches ? e.touches[0] : e;
    _crop.tx += q.clientX - lastX; _crop.ty += q.clientY - lastY;
    lastX = q.clientX; lastY = q.clientY;
    _cropClamp(); _cropApply();
  };
  const end = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end);
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
}

async function saveAvatarCrop() {
  const { img, V, scale, tx, ty } = _crop;
  const sx = -tx / scale, sy = -ty / scale, sSize = V / scale;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  c.getContext('2d').drawImage(img, sx, sy, sSize, sSize, 0, 0, 128, 128);
  const dataUrl = c.toDataURL('image/jpeg', 0.82);
  document.getElementById('avatar-crop-modal').classList.remove('open');
  if (_crop.url) { URL.revokeObjectURL(_crop.url); _crop.url = null; }
  try {
    const updated = await api('/auth/me/avatar', { method: 'PATCH', body: JSON.stringify({ avatar: dataUrl }) });
    currentUser.avatar_url = (updated && updated.avatar_url) || dataUrl;
    toast('頭像已更新');
    renderSettings();
  } catch (err) { toast(err.message || '頭像更新失敗'); }
}

// ── Auth ─────────────────────────────────────────────────────
function showLoginForm() {
  document.getElementById('signin-form').style.display = '';
  document.getElementById('invite-form').style.display = 'none';
  document.getElementById('invite-invalid').style.display = 'none';
  document.getElementById('auth-msg').textContent = '';
}

// Show an auth error and shake it to draw the eye (restart the animation each call).
function shakeMsg(text) {
  const el = document.getElementById('auth-msg');
  el.textContent = text;
  el.classList.remove('shake');
  void el.offsetWidth;        // force reflow so the animation replays on repeat clicks
  el.classList.add('shake');
  // 從 GitHub Pages 開啟且登入出錯 → 提示鏡像入口（部分地區 Pages 不穩，鏡像走 Render）
  const mh = document.getElementById('mirror-hint');
  if (mh && location.hostname === 'surf0912.github.io') mh.style.display = '';
}

async function doSignIn() {
  const msg = document.getElementById('auth-msg');
  msg.classList.remove('shake');
  msg.textContent = '驗證中…';
  try {
    const username = document.getElementById('si-username').value.trim();
    if (!username) { shakeMsg('請輸入巫師入學全名'); return; }
    const res = await api('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ username, password: document.getElementById('si-pass').value }),
    });
    if (!res) return;
    token = res.access_token;
    localStorage.setItem('pd_token', token);
    if (res.refresh_token) localStorage.setItem('pd_refresh', res.refresh_token);
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    history.replaceState({}, '', url);
    await initApp();
  } catch (e) { shakeMsg('' + e.message); }
}

// Best-effort browser fingerprint for re-registration / ban-evasion review (NOT security). Uses
// only stable-ish traits (no canvas — Safari randomises it) so the same device produces the same id
// across sign-ups; admins review matches, nothing is blocked.
function deviceFingerprint() {
  try {
    const n = navigator;
    const s = [
      n.userAgent, n.language, (n.languages || []).join(','), n.platform || '',
      n.hardwareConcurrency || '', n.deviceMemory || '',
      screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || ''),
      window.devicePixelRatio || '', (Intl.DateTimeFormat().resolvedOptions().timeZone) || '',
    ].join('|');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'fp' + h.toString(36);
  } catch (e) { return ''; }
}

// Persistent per-browser token (strongest "same browser" signal — survives until site data is cleared
// or a different browser is used). Generated once, kept in localStorage. Cross-referenced with the
// fingerprint + IP to recognise a returning banned account.
function deviceToken() {
  try {
    let t = localStorage.getItem('pd_did');
    if (!t) {
      t = 'd' + ((window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '')
                 : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
      localStorage.setItem('pd_did', t);
    }
    return t;
  } catch (e) { return ''; }
}

// Magical tap sparkle — every tap/click spawns a small burst of gold motes + an expanding ring at
// the pointer. Purely decorative (pointer-events:none, never blocks the real action); skipped when
// the user prefers reduced motion. Runs at document level so it works everywhere, login included.
(function initTapSparkle() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let last = 0;
    document.addEventListener('pointerdown', (e) => {
      if (localStorage.getItem('pd_tap_fx') === '0') return;   // user turned it off in 小工具
      const now = Date.now();
      if (now - last < 45) return;   // guard against rapid synthetic bursts
      last = now;
      const x = e.clientX, y = e.clientY;
      if (x == null || y == null) return;
      const frag = document.createDocumentFragment();
      const ring = document.createElement('div');
      ring.className = 'tap-ring';
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.addEventListener('animationend', () => ring.remove());
      frag.appendChild(ring);
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.7;
        const dist = 15 + Math.random() * 16;
        const s = document.createElement('div');
        s.className = 'tap-spark';
        s.style.left = x + 'px'; s.style.top = y + 'px';
        s.style.setProperty('--dx', (Math.cos(a) * dist).toFixed(1) + 'px');
        s.style.setProperty('--dy', (Math.sin(a) * dist).toFixed(1) + 'px');
        s.addEventListener('animationend', () => s.remove());
        frag.appendChild(s);
      }
      document.body.appendChild(frag);
    }, { passive: true });
  } catch (e) {}
})();

// 小工具 toggle for the tap sparkle (default on). The pointerdown handler reads this flag live, so
// flipping it takes effect on the very next tap — no reload needed.
function toggleTapFx(on) {
  localStorage.setItem('pd_tap_fx', on ? '1' : '0');
}

async function doInviteRegister() {
  const msg = document.getElementById('auth-msg');
  const username = document.getElementById('inv-name').value.trim();
  const nickname = document.getElementById('inv-nickname').value.trim();
  const pass = document.getElementById('inv-pass').value;
  const invToken = new URLSearchParams(window.location.search).get('invite');
  const grabCode = new URLSearchParams(window.location.search).get('grab');
  if (!username) { shakeMsg('請輸入巫師入學全名'); return; }
  if (/\s/.test(username)) { shakeMsg('入學全名不能有空格'); return; }
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) { shakeMsg('入學全名只能用英文、數字、底線，2-20字'); return; }
  if (!nickname) { shakeMsg('請輸入巫師姓名（暱稱）'); return; }
  if (!invToken && !grabCode) { shakeMsg('找不到邀請令牌'); return; }
  msg.classList.remove('shake');
  msg.textContent = grabCode ? '領取邀請函中…' : '建立帳號中…';
  try {
    // 搶名額走 group-register（後端從該輪撈未用 token 原子搶佔，額滿回 410 訊息）
    await api(grabCode ? '/invites/group-register' : '/invites/register', {
      method: 'POST',
      body: JSON.stringify(grabCode
        ? { code: grabCode, username, password: pass, nickname, fingerprint: deviceFingerprint(), device: deviceToken() }
        : { token: invToken, username, password: pass, nickname, fingerprint: deviceFingerprint(), device: deviceToken() }),
    });
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    url.searchParams.delete('grab');
    history.replaceState({}, '', url);
    // Auto-login straight into the app with the same credentials (skip the manual login step).
    msg.textContent = '登入中…';
    try {
      const res = await api('/auth/signin', { method: 'POST', body: JSON.stringify({ username, password: pass }) });
      if (res) {
        token = res.access_token;
        localStorage.setItem('pd_token', token);
        if (res.refresh_token) localStorage.setItem('pd_refresh', res.refresh_token);
        await initApp();
        return;
      }
    } catch (_) { /* fall through to manual login */ }
    document.getElementById('si-username').value = username;
    showLoginForm();
    msg.textContent = '帳號建立成功，請登入';
  } catch (e) { shakeMsg('' + e.message); }
}

// iOS 獨立模式：底部安全區(home indicator 那條)會被填上 meta theme-color。登入頁沒有導覽列蓋住，
// 就會露出深色。登入頁設成「暗化羊皮紙」融入背景、登入後(導覽列蓋住)再設回深色。
const LOGIN_THEME = '#5D4B38';
function setThemeColor(c) { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', c); }

// ── 語言選擇（檔案 → 閱讀偏好）──────────────────────────────────────────────
// 三檔：orig 原文（預設）＝介面繁體、內文照作者原樣，完全不轉換；
//       tc 繁體＝全站含內文轉繁（站內不少文章以簡體撰寫；scToTc＋S2T_FIX 修正表）；
//       sc 簡體＝全站含內文轉簡（tcToSc，多對一幾乎不錯字）。
// 繁體原文經 scToTc 是恆等（字表鍵都是簡體字），所以 tc 模式不會動到本來就是繁體的文字。
let uiScript = ['tc', 'sc'].includes(localStorage.getItem('pd_script')) ? localStorage.getItem('pd_script') : 'orig';
const _zhConv = uiScript === 'sc' ? (s => tcToSc(s)) : (s => scToTc(s));
function setUiScript(v) {
  const val = ['tc', 'sc'].includes(v) ? v : 'orig';
  localStorage.setItem('pd_script', val);
  // 先回寫帳號（跨裝置同步），再 reload 從原始碼重新渲染；斷網最多等 1.2 秒照樣切換。
  let reloaded = false;
  const done = () => { if (!reloaded) { reloaded = true; location.reload(); } };
  if (typeof token !== 'undefined' && token) {
    try { api('/auth/me/client-state', { method: 'PATCH', body: JSON.stringify({ script: val }) }).catch(() => {}).finally(done); } catch (e) { done(); }
    setTimeout(done, 1200);
  } else done();
}
// 把 root 底下所有文字節點（含 placeholder/title/aria-label）轉成目前選擇的字體。
function zhConvertTree(root) {
  if (!root) return;
  if (root.nodeType === 3) { const v = _zhConv(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; return; }
  if (root.nodeType !== 1) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode;
    const v = _zhConv(n.nodeValue);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
  const els = [root, ...root.querySelectorAll('[placeholder],[title],[aria-label]')];
  for (const el of els) {
    for (const a of ['placeholder', 'title', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const c = _zhConv(v); if (c !== v) el.setAttribute(a, c); }
    }
  }
}
// 轉換模式（tc/sc）：先整棵轉一次，之後任何新渲染（頁面切換、toast、彈窗、章節內容）由 observer 接手。
// 只在文字真的有變時才寫回，observer 不會自己觸發自己。orig 完全不掛 observer。
if (uiScript !== 'orig') {
  if (uiScript === 'sc') document.documentElement.lang = 'zh-CN';
  const start = () => {
    zhConvertTree(document.body);
    new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'characterData') { const v = _zhConv(m.target.nodeValue); if (v !== m.target.nodeValue) m.target.nodeValue = v; }
        else for (const n of m.addedNodes) zhConvertTree(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}
// ── 已讀狀態＋語言選擇：跨裝置同步（profiles.client_state；開機合併、變動即回寫）────
// localStorage 只是本機快取；合併採「聯集」——換裝置/重加 App/換鏡像不會重跳已讀過的通知。
// 夜間模式、字級等裝置偏好刻意不同步（同一人不同裝置要不同設定是合理需求）。
function pushClientState(delta) {
  if (!token) return;
  try { api('/auth/me/client-state', { method: 'PATCH', body: JSON.stringify(delta) }).catch(() => {}); } catch (e) {}
}
let _readingPushT = null;
function _pushReadingNow() {
  try {
    const raw = localStorage.getItem('pd_last_read'); if (!raw) return;
    const p = JSON.parse(raw); p.at = Date.now();
    localStorage.setItem('pd_last_read', JSON.stringify(p));
    pushClientState({ reading: p });
  } catch (e) {}
}
function _pushReadingSoon() { clearTimeout(_readingPushT); _readingPushT = setTimeout(_pushReadingNow, 1500); }
function syncClientState() {
  const cs = (currentUser && currentUser.client_state) || {};
  const delta = {};
  // 主編來信：只在意「現行這一封」
  const localSeen = localStorage.getItem('pd_letter_seen');
  if (cs.letter_seen === EDITOR_LETTER.id && localSeen !== EDITOR_LETTER.id) {
    try { localStorage.setItem('pd_letter_seen', EDITOR_LETTER.id); } catch (e) {}
  } else if (localSeen === EDITOR_LETTER.id && cs.letter_seen !== EDITOR_LETTER.id) {
    delta.letter_seen = EDITOR_LETTER.id;
  }
  // 追蹤更新已讀：雙向聯集
  const localWorks = _readInstallments();
  const serverWorks = Array.isArray(cs.read_works) ? cs.read_works : [];
  const worksUp = localWorks.filter(x => !serverWorks.includes(x));
  if (worksUp.length) delta.read_works_add = worksUp;
  try { localStorage.setItem('pd_read_installments', JSON.stringify([...new Set([...serverWorks, ...localWorks])].slice(-300))); } catch (e) {}
  // 願望回音已讀：伺服器優先合併；本機獨有的推上去
  const localW = _readWishReplies(), serverW = cs.read_wishes || {};
  const wishUp = {};
  for (const k in localW) if (!(k in serverW)) wishUp[k] = localW[k];
  if (Object.keys(wishUp).length) delta.read_wishes_set = wishUp;
  try { localStorage.setItem('pd_read_wishreplies', JSON.stringify({ ...localW, ...serverW })); } catch (e) {}
  // 被叉掉的通知：雙向聯集
  const localD = _dismissedNotices();
  const serverD = Array.isArray(cs.dismissed) ? cs.dismissed : [];
  const dUp = localD.filter(x => !serverD.includes(x));
  if (dUp.length) delta.dismissed_add = dUp;
  try { localStorage.setItem('pd_dismissed_notices', JSON.stringify([...new Set([...serverD, ...localD])].slice(-100))); } catch (e) {}
  // 加入主畫面引導卡：「知道了」為帳號級
  if (cs.install_hint === 'dismissed' && localStorage.getItem('pd_install_hint') !== '1') {
    try { localStorage.setItem('pd_install_hint', '1'); } catch (e) {}
  } else if (localStorage.getItem('pd_install_hint') === '1' && cs.install_hint !== 'dismissed') {
    delta.install_hint = 'dismissed';
  }
  // 續讀進度：兩邊取較新的一份（手機讀到哪、電腦接著讀）
  try {
    const localR = JSON.parse(localStorage.getItem('pd_last_read') || 'null');
    const serverR = cs.reading || null;
    const lAt = (localR && localR.at) || 0, sAt = (serverR && serverR.at) || 0;
    if (serverR && sAt > lAt) localStorage.setItem('pd_last_read', JSON.stringify(serverR));
    else if (localR && lAt > sAt) delta.reading = localR;
  } catch (e) {}
  // 語言選擇：伺服器有值且與本機不同 → 套用並重載（一次性）；伺服器沒有而本機有 → 推上去
  const localScript = localStorage.getItem('pd_script');
  let needReload = false;
  if (['orig', 'tc', 'sc'].includes(cs.script) && cs.script !== (localScript || 'orig')) {
    try { localStorage.setItem('pd_script', cs.script); } catch (e) {}
    needReload = true;
  } else if (localScript && !cs.script) {
    delta.script = localScript;
  }
  if (Object.keys(delta).length) pushClientState(delta);
  if (needReload) location.reload();
}
function doLogout() {
  token = null; currentUser = null;
  localStorage.removeItem('pd_token');
  localStorage.removeItem('pd_refresh');
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  setThemeColor(LOGIN_THEME);
  document.documentElement.classList.remove('in-app'); document.body.classList.remove('in-app');   // 底層回羊皮紙（登入頁專屬）
  showLoginForm();
}

async function initApp() {
  // 401 → api() already logged out & returned null. A thrown error here is a NETWORK failure
  // (e.g. cold start still waking) — retry rather than logging the user out over a blip.
  try { currentUser = await api('/auth/me'); } catch { setTimeout(initApp, 3000); return; }
  if (!currentUser) return;
  // Record this device's signal (IP + fingerprint) once per launch, so existing members have signals
  // on file before any ban — a later re-registration from the same device can then be flagged. Best-
  // effort, never blocks the UI.
  try { api('/auth/me/signal', { method: 'POST', body: JSON.stringify({ fingerprint: deviceFingerprint(), device: deviceToken() }) }); } catch (e) {}
  syncClientState();   // 先跟帳號合併已讀狀態/語言，再讓主編來信與貓頭鷹用合併後的狀態判斷
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  setThemeColor('#1a0a00');   // 進 App：導覽列蓋住底部，theme-color 設回深色
  document.documentElement.classList.add('in-app'); document.body.classList.add('in-app');   // 底層切回 --chrome（頂部時間列/導覽列下方＝原本深棕）
  // Reset role-based UI on every login (accounts can switch in-place without a page reload).
  const staff = ['writer', 'admin', 'super_admin'].includes(currentUser.role);
  const adminish = ['admin', 'super_admin'].includes(currentUser.role);
  document.getElementById('admin-nav-btn').style.display = staff ? '' : 'none';  // readers: no 後台
  { // 羊皮紙已併入意若思鏡、留影升上導覽列（正式版）：nav 一律顯示留影、隱藏羊皮紙
    const _fn = document.getElementById('forum-nav-btn'); if (_fn) _fn.style.display = 'none';
    const _gn = document.getElementById('gallery-nav-btn'); if (_gn) _gn.style.display = ''; }
  document.querySelectorAll('.staff-only').forEach(el => el.style.display = staff ? '' : 'none');  // readers: no 防窺工坊
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = adminish ? '' : 'none');  // writers: only 作品管理 + 上傳
  document.querySelectorAll('.super-only').forEach(el => el.style.display = currentUser.role === 'super_admin' ? '' : 'none');  // 監看面板 + 實驗功能開關：只給 SA
  // 授權信箱：writer 用獨立「授權」分頁；admin 併入「審核」分頁的授權信膠囊，不重複顯示
  { const _au = document.getElementById('auths-tab-btn'); if (_au) _au.style.display = currentUser.role === 'writer' ? '' : 'none'; }
  { const _fx = document.getElementById('tapfx-toggle'); if (_fx) _fx.checked = localStorage.getItem('pd_tap_fx') !== '0'; }   // 點擊特效預設開
  { const _ow = document.getElementById('owl-toggle'); if (_ow) _ow.checked = localStorage.getItem('pd_owl_always') === '1'; }   // 貓頭鷹常駐預設關
  if (typeof renderShelf === 'function') renderShelf();   // 載入身分後刷新書架
  adminNovelScope = null;
  loadOwnerNames();   // super_admin only: map owner uuid → 巫師全名 for the owner hint
  loadFavIds().then(renderFavUpdates);   // 意若思鏡 收藏夾 ids + 追蹤更新 alert
  loadHomeGalleryCovers();   // P2：留影走廊已排時段的畫作併入心動封面池
  loadCoverCrops().then(() => renderGreeting(false));   // 封面裁切框：載完把框貼到「同一張」封面上，不重抽
  loadAppSettings();   // 全域設定（通知保留天數等）→ 載入後重算貓頭鷹
  renderSettings();
  renderGreeting();
  renderTourBanner();
  renderInstallHint();   // persistent home prompt for anyone not yet onboarded
  setTimeout(maybeShowEditorLetter, 700);   // 主編來信：登入後跳一次（已看過導覽的人才跳，不與新手導覽撞窗）
  setTimeout(maybeShowMonthlyRecap, 1600);  // 月末讀報回顧：每月第一次開啟時回顧上月（不與主編來信撞窗）
  // Run the first-time tour only AFTER the shelf finishes loading — i.e. once the
  // backend is awake and the 喚醒中 overlay is gone — so it isn't shown over (and
  // accidentally dismissed during) a cold start. .catch keeps the chain alive even if
  // loadNovels' render throws, so the tour still fires.
  loadNovels().catch(() => {}).then(() => maybeAutoTour());
}

// super_admin sees the real owner (巫師全名) after the free-text author, so a changed
// 作者署名 doesn't hide who the work belongs to. Others never see this.
let _ownerNames = {};
async function loadOwnerNames() {
  _ownerNames = {};
  if (currentUser?.role !== 'super_admin') return;
  try {
    (await api('/permissions/users') || []).forEach(u => { _ownerNames[u.id] = u.username; });
  } catch {}
}
function ownerTag(work) {
  if (currentUser?.role !== 'super_admin') return '';
  const names = (work.owners || []).map(id => _ownerNames[id]).filter(Boolean);
  return names.length ? ` <span style="color:var(--gold);opacity:.85">${ic('ic-idcard',12)} ${escapeHtml(names.join('、'))}</span>` : '';
}

// ── Navigation ───────────────────────────────────────────────
function showPage(id, btn) {
  // 已經在這一頁又點同一個頁籤：只回到頂部，不重新抓資料（否則反覆點會一直閃 spinner 重刷）。
  const already = document.getElementById('page-' + id)?.classList.contains('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  if (btn) btn.classList.add('active');
  // 所有頁面共用 #page-area 這個捲動容器；切頁時把它捲回頂部，否則在某頁往下滑後
  // 切走再切回，會停在上次的捲動位置（首頁自身鎖定不捲，不受影響）。
  { const pa = document.getElementById('page-area'); if (pa) pa.scrollTop = 0; }
  if (already) return;   // 同頁再點＝只捲頂
  { const pa = document.getElementById('page-area'); if (pa) pa.classList.remove('gallery-bg'); }   // 切頁先卸木紋底；進羊皮紙時 loadForumPosts 會依模式重設
  if (id !== 'admin') stopMonitor();   // leaving 編輯部 cancels the live monitor poll
  if (id === 'home') { renderContinueBar(); renderFavUpdates(); }
  if (id === 'scroll') loadNovels();
  if (id === 'forum') loadForumPosts();
  if (id === 'settings') renderVersionStatus();   // 每次進檔案頁重新檢查版本狀態
  if (id === 'admin') { adminNovelScope = null; switchAdminTab('novels'); }
}

// ── Guided tour (新手導覽) ─────────────────────────────────────
// Steps anchor to data-tour / stable ids; a missing target degrades to a
// centered bubble (auto-skip look) instead of breaking. See infra notes.
const TOUR_VERSION = '7';   // tags which tour version a user last completed; NOT a re-show trigger — veterans (seen any version for their role) keep their 'seen' status across bumps
const TOUR_READER = [
  { page: 'home', target: '[data-tour="nav-home"]',
    html: "<span class='tour-h'>歡迎來到《預言家日報》</span>這裡是心動頁。左上角若出現<b>貓頭鷹</b>，代表有信等你——追蹤的系列出了新作品、主編來信，或你的願望有了回音。" },
  { page: 'home', target: '#hero-heart',
    html: "<span class='tour-h'>他是誰？</span>點封面右上的<b>愛心</b>，走進角色設定頁——挑選你想在心動頁遇見的封面，也能下載作為個人桌布使用。" },
  { page: 'scroll', target: '[data-tour="nav-scroll"]',
    html: "<span class='tour-h'>意若思鏡</span>這面鏡子映照出大家所有的念想——點這裡就能走進書架找文。" },
  { page: 'scroll', target: '#shelf-char-chips',
    html: "<span class='tour-h'>只看某個人</span>點角色頭像，就只顯示有那位角色的故事，再點一次即可取消；選好兩個頭像再點「同框」，就只看兩人<b>同框</b>的文。<b>雙擊頭像</b>可直接開啟角色設定頁。" },
  { page: 'scroll', target: '#shelf-wish-btn',
    html: "<span class='tour-h'>許願池</span>想看的主題、主角，或想加的網站功能，都能在這裡許願——一律匿名，放心許。<b>被回覆時，貓頭鷹會叼信通知你</b>。" },
  // 羊皮紙已併入意若思鏡、留影升上導覽列（正式版）
  { page: 'scroll', target: '#shelf-cat-pills',
    html: "<span class='tour-h'>羊皮紙在這裡</span>論壇體文章併進了意若思鏡——故事類型多一格「<b>羊皮紙</b>」，點它就能看大家的論壇貼文，跟小說一起逛；讀文時點<b>星星</b>收藏，收藏夾也通用。" },
  { target: '#gallery-nav-btn',
    html: "<span class='tour-h'>留影走廊</span>導覽列這一格就是<b>留影走廊</b>，掛著大家投稿的角色畫作，點進去慢慢欣賞。" },
  { page: 'settings', target: '[data-tour="nav-settings"]',
    html: "<span class='tour-h'>個人檔案</span>字體大小、夜間模式、<b>語言選擇</b>都在閱讀偏好；頁面最下方能查看你手上的日報是否為最新一期。想<b>重看這份導覽</b>，到「檔案 → 小工具 → 新手導覽」。" },
];
const TOUR_WRITER_EXTRA = [
  { page: 'admin', target: '[data-tour="nav-admin"]',
    html: "<span class='tour-h'>編輯部</span>身為執筆人,你比讀者多了一個編輯部——你的創作基地就在這。" },
  { page: 'admin', before: () => switchAdminTab('upload'), target: '.admin-tab[data-tab="upload"]',
    html: "<span class='tour-h'>發表作品</span>點「上傳」就能開始發表你的故事。" },
  { page: 'admin', before: () => switchAdminTab('upload'), target: '[data-tour="upload-kind"]',
    html: "<span class='tour-h'>先選類型</span>先決定要發<b>小說</b>、<b>論壇貼文</b>還是<b>畫作</b>——三種的欄位與格式各不相同,先選對類型再往下填。" },
  { page: 'admin', before: () => { switchAdminTab('upload'); setUploadKind('image'); }, target: '#image-drop',
    html: "<span class='tour-h'>投稿畫作</span>會畫圖的你,也能把作品掛上<b>留影走廊</b>。選「畫作」後上傳圖檔、標好角色送出,審核通過就會出現在牆上。" },
  { page: 'admin', before: () => { switchAdminTab('upload'); setUploadKind('novel'); }, target: '#new-novel-category',
    html: "<span class='tour-h'>分類與角色</span>填好標題後,選<b>故事類型</b>和<b>角色標籤</b>——標好讀者才搜得到、篩得到你的文。" },
  { page: 'admin', before: () => { switchAdminTab('upload'); setUploadKind('novel'); }, target: '[data-tour="upload-submit"]',
    html: "<span class='tour-h'>貼上內文送出</span>把內文貼進上方框裡,按這顆就送出。發佈日期可留空(預設今天),也能補填過去日期;<b>填未來日期會排程,到當天才自動公開</b>。" },
  { page: 'admin', before: () => switchAdminTab('novels'), target: '.admin-tab[data-tab="novels"]',
    html: "<span class='tour-h'>作品管理</span>送出後可在這裡編輯、分系列、改分類。提醒,作品需<b>等管理員審核</b>通過才會公開。" },
  { page: 'admin', before: () => switchAdminTab('novels'), target: '#admin-novel-list',
    html: "<span class='tour-h'>拿範例練手</span>系統在這放了一篇《作家入職指南》當範例,點開讀一遍,並在它上面試<b>編輯、分類、系列</b>(把上下集連在一起)。讀完想刪就刪,不影響你的身份。" },
];
let _tour = { steps: [], i: 0, on: false };

// "Seen" is tracked PER ACCOUNT on the server (profiles.tour_seen) so the tour
// shows exactly once per account, across every device. A per-account localStorage
// key is a fallback (covers the DB-migration gap + offline).
function tourSeenKey() { return 'pd_tour_seen_' + (currentUser?.id || 'anon'); }
// Tour is role-scoped: readers complete 'r'+version, writers (incl. readers promoted
// to writer) complete 'w'+version — so a promoted reader re-sees the writer tour.
function tourTag() { return (currentUser?.role === 'reader' ? 'r' : 'w') + TOUR_VERSION; }
function _normTag(v) { return v === TOUR_VERSION ? 'r' + TOUR_VERSION : (v || ''); }  // legacy plain value = reader-seen
// Has this account seen ANY version of the tour for its CURRENT role? BOTH the auto-run and the
// home banner gate on this — so once someone has been through onboarding (any version), a later
// content/version bump won't re-nudge them; only genuinely-new accounts (or a reader freshly
// promoted to writer) are prompted. Completing or dismissing marks the current tag as seen.
function tourSeenAnyForRole() {
  const roleChar = currentUser?.role === 'reader' ? 'r' : 'w';
  const stored = _normTag(currentUser?.tour_seen) || _normTag(localStorage.getItem(tourSeenKey())) || '';
  return stored.startsWith(roleChar);
}

function maybeAutoTour() {
  if (!currentUser || !['reader', 'writer'].includes(currentUser.role)) return;  // auto only for 讀者/作家
  if (tourSeenAnyForRole()) return;   // already saw this role's tour (any version) → don't force a replay
  // Called after loadNovels resolves (backend awake). Wait out any lingering 喚醒 overlay,
  // then a short settle so the shelf has rendered before the spotlight appears.
  let tries = 0;
  (function go() {
    const waking = document.getElementById('waking-overlay');
    if (waking && waking.classList.contains('show') && tries++ < 60) { setTimeout(go, 500); return; }
    setTimeout(startTour, 350);
  })();
}

function startTour() {
  // showIf 讓某步依身份出現／略過（例：留影走廊只給作家以上）——在此就濾掉，步數編號才乾淨
  const pass = s => !s.showIf || s.showIf();
  const steps = TOUR_READER.filter(pass);
  if (currentUser && currentUser.role !== 'reader') steps.push(...TOUR_WRITER_EXTRA.filter(pass));
  _tour = { steps, i: 0, on: true };
  document.getElementById('tour-overlay').classList.add('open');
  window.addEventListener('resize', _tourReposition);
  showTourStep(0);
}
function tourNext() { showTourStep(_tour.i + 1); }
function tourBack() { showTourStep(_tour.i - 1); }

function showTourStep(i) {
  const steps = _tour.steps;
  if (i < 0) return;
  if (i >= steps.length) { endTour(true); return; }
  _tour.i = i;
  const s = steps[i];
  if (s.page) showPage(s.page, document.querySelector(`[data-tour="nav-${s.page}"]`));
  if (s.before) { try { s.before(); } catch (e) {} }
  document.getElementById('tour-text').innerHTML = s.html;
  document.getElementById('tour-step-num').textContent = `${i + 1} / ${steps.length}`;
  document.getElementById('tour-back').style.display = i > 0 ? '' : 'none';
  document.getElementById('tour-next').textContent = (i === steps.length - 1) ? '完成 ✦' : '下一步 ›';
  setTimeout(() => _placeTour(s), 90);
}

function _placeTour(s) {
  const spot = document.getElementById('tour-spot');
  const bub = document.getElementById('tour-bubble');
  const el0 = s.target ? document.querySelector(s.target) : null;
  // 目標不存在，或對這個身份是隱藏的（display:none，如讀者看不到的留影走廊鈕）→ 當成沒有目標，置中泡泡、不打光
  const el = (el0 && el0.offsetParent !== null) ? el0 : null;
  if (!el) {  // missing/hidden target → centered bubble, no spotlight
    spot.classList.add('nohole');
    bub.style.transform = 'translate(-50%,-50%)';
    bub.style.left = '50%'; bub.style.top = '50%';
    return;
  }
  bub.style.transform = 'none';
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const place = () => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;   // not laid out yet — wait for the next pass
    const pad = 6;
    spot.classList.remove('nohole');
    spot.style.left = (r.left - pad) + 'px';
    spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px';
    spot.style.height = (r.height + pad * 2) + 'px';
    const bw = bub.offsetWidth, bh = bub.offsetHeight;
    let top = r.bottom + 12;
    if (top + bh > innerHeight - 16) top = r.top - 12 - bh;  // no room below → flip above
    if (top < 12) top = 12;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(12, Math.min(left, innerWidth - bw - 12));
    bub.style.left = left + 'px';
    bub.style.top = top + 'px';
  };
  // Place now, then re-measure after layout/scroll/URL-bar settle — fixes the auto-run case
  // where the shelf/viewport is still shifting when the tour first opens (manual open is fine).
  requestAnimationFrame(place);
  setTimeout(place, 350);
  setTimeout(place, 700);
}
function _tourReposition() { if (_tour.on) _placeTour(_tour.steps[_tour.i]); }

function markTourSeen() {
  const tag = tourTag();   // 'r2' / 'w2' — role-scoped
  localStorage.setItem(tourSeenKey(), tag);   // device fast-path
  if (currentUser) currentUser.tour_seen = tag;
  api('/auth/me/tour-seen', { method: 'PATCH', body: JSON.stringify({ version: tag }) }).catch(() => {});  // cross-device record (best effort)
}

// markSeen=true only when the tour is COMPLETED. A mere 跳過 just closes it and leaves the
// home banner up, so onboarding isn't silently consumed (e.g. by the register→auto-login flash).
function endTour(markSeen) {
  _tour.on = false;
  document.getElementById('tour-overlay').classList.remove('open');
  window.removeEventListener('resize', _tourReposition);
  if (markSeen) markTourSeen();
  showPage('home', document.querySelector('[data-tour="nav-home"]'));
  renderTourBanner();
  renderInstallHint();
}

// Persistent home prompt — the reliable entry point that can't be missed/consumed.
function renderTourBanner() {
  const b = document.getElementById('tour-banner');
  if (!b) return;
  b.style.display = (currentUser && ['reader', 'writer'].includes(currentUser.role) && !tourSeenAnyForRole()) ? 'block' : 'none';
}
function dismissTourBanner() { markTourSeen(); renderTourBanner(); }

// ── 「加入主畫面」引導卡（心動頁）───────────────────────────────────────────
// 只在瀏覽器模式出現（已加入主畫面永遠看不到）；iOS 給分步說明、Android 給一鍵安裝。
// 「知道了」跟帳號同步（client_state.install_hint）——全帳號只提醒一次。
let _bipEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); _bipEvent = e; renderInstallHint(); });
function _isStandalone() { return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches); }
function renderInstallHint() {
  const el = document.getElementById('install-hint'); if (!el) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const show = currentUser && !_isStandalone() && localStorage.getItem('pd_install_hint') !== '1' && (isIOS || !!_bipEvent);
  el.style.display = show ? 'block' : 'none';
  if (!show) return;
  const go = document.getElementById('install-hint-go');
  if (go) go.style.display = _bipEvent ? '' : 'none';
  if (_bipEvent) {
    const b = document.getElementById('install-hint-body');
    if (b) b.textContent = '一鍵安裝，之後像 App 一樣從主畫面翻開——全螢幕、更快，貓頭鷹也在。';
  }
}
function dismissInstallHint() {
  try { localStorage.setItem('pd_install_hint', '1'); } catch (e) {}
  pushClientState({ install_hint: 'dismissed' });
  renderInstallHint();
}
function installPwaNow() {
  const ev = _bipEvent; _bipEvent = null;
  if (ev) ev.prompt();
  dismissInstallHint();
}

// ── Home ─────────────────────────────────────────────────────
// quotes[0]=早上  quotes[1]=中午  quotes[2]=下午  quotes[3]=晚上
const CHARS = [
  {
    name: 'Sean', emoji: '', img: './chars/sean_phone_2.webp', imgs: ['./chars/sean_phone_1.webp', './chars/sean_phone_2.webp', './chars/sean_phone_3.webp', './chars/sean_phone_4.webp', './chars/sean_phone_5.webp', './chars/sean_phone_6.webp', './chars/sean_phone_7.webp', './chars/sean_phone_8.webp', './chars/sean_phone_9.webp', './chars/sean_phone_10.webp', './chars/sean_phone_11.webp'], imgD: './chars/Sean_desktop_1.webp', imgsD: ['./chars/Sean_desktop_1.webp', './chars/sean_desktop_2.webp', './chars/sean_desktop_3.webp', './chars/sean_desktop_4.webp'], bgPos: 'center 20%',
    quotes: [
      '早上好，今天也很漂亮。別懷疑，我說的是事實。',
      '中午好。終於下課了？我可以把你借走一會兒嗎？',
      '下午好。還撐得住嗎？不行的話，我帶你逃走十分鐘。',
      '晚上好。現在可以只看我了嗎？',
    ],
  },
  {
    name: 'Silas', emoji: '', img: './chars/silas_phone_2.webp', imgs: ['./chars/silas_phone_1.webp', './chars/silas_phone_2.webp', './chars/silas_phone_3.webp', './chars/silas_phone_4.webp', './chars/silas_phone_5.webp', './chars/silas_phone_6.webp', './chars/silas_phone_7.webp', './chars/silas_phone_8.webp', './chars/silas_phone_9.webp', './chars/silas_phone_10.webp', './chars/silas_phone_11.webp'], imgD: './chars/Silas_desktop_1.webp', imgsD: ['./chars/Silas_desktop_1.webp', './chars/silas_desktop_2.webp', './chars/silas_desktop_3.webp'], bgPos: 'center top', bgPosDesktop: 'center 30%',
    quotes: [
      '早上好。你的座位在這裡。',
      '中午好。先吃飯，你上午已經喝了兩杯咖啡了。',
      '下午好。你再看下去，今天晚上會頭疼。',
      '晚上好。門沒有鎖，但我想你會進來。',
    ],
  },
  {
    name: 'Eli', emoji: '', img: './chars/eli_phone_2.webp', imgs: ['./chars/eli_phone_1.webp', './chars/eli_phone_2.webp', './chars/eli_phone_4.webp', './chars/eli_phone_5.webp', './chars/eli_phone_7.webp', './chars/eli_phone_8.webp', './chars/eli_phone_10.webp', './chars/eli_phone_11.webp'], imgD: './chars/Eli_desktop_1.webp', imgsD: ['./chars/Eli_desktop_1.webp', './chars/eli_desktop_2.webp'], bgPos: 'center 20%',
    quotes: [
      '啊，早上好。你吃早飯了嗎？我這裡還有一塊餅乾。',
      '啊，中午好。剛剛有一隻蒲絨絨一直跟著我……我想它可能比較喜歡你。',
      '下午好。溫室現在有太陽，你要不要來看一下？',
      '晚上好……你冷不冷？',
    ],
  },
  {
    name: 'Adrian', emoji: '', img: './chars/adrian_phone_2.webp', imgs: ['./chars/adrian_phone_1.webp', './chars/adrian_phone_2.webp', './chars/adrian_phone_3.webp', './chars/adrian_phone_4.webp', './chars/adrian_phone_7.webp', './chars/adrian_phone_8.webp', './chars/adrian_phone_10.webp'], imgD: './chars/Adrian_desktop_1.webp', imgsD: ['./chars/Adrian_desktop_1.webp', './chars/adrian_desktop_2.webp', './chars/adrian_desktop_3.webp'], bgPos: 'center top', bgPosDesktop: 'center 20%',
    quotes: [
      '早上好。你今天沒繞遠路，看來心情不錯。',
      '中午好。當心，西側長廊今天別去。',
      '下午好。無聊了？看來他們還沒說到重點。',
      '晚上好。這裡很安靜。你可以不用立刻回答任何人。',
    ],
  },
];

// ── 心動封面時段分類（早晨＆中午 / 下午 / 夜晚）─────────────────────────────
// 判準：有陽光的白天圖再依光線細分——一般日光/明亮＝早晨＆中午；日落/黃昏金色光＝下午；
// 無陽光(室內/暗水族箱/夜景/燭光)一律默認夜晚(不在下面兩集合的都算夜晚)。
// 首頁時段：06:00–14:30 早晨＆中午、14:30–18:00 下午、其餘夜晚(見 renderGreeting)。
const MORNING_COVERS = new Set([   // 早晨＆中午：一般日光/明亮
  './chars/sean_phone_1.webp',    // 水族箱：水面透亮、有日光
  './chars/sean_phone_3.webp',    // 雨天陰天日光
  './chars/silas_phone_3.webp',   // 窗邊明亮日光
  './chars/silas_phone_5.webp',   // 臥室柔和日光
  './chars/eli_phone_1.webp',     // 水族箱：偏亮有日光
  './chars/eli_phone_2.webp',     // 溫室陽光
  './chars/eli_phone_5.webp',     // 溫室日光（照料植物）
  './chars/sean_phone_5.webp',    // 床邊晨光
  './chars/sean_phone_9.webp',    // 鬱金香花田＋風車、藍天大晴（原 phone_5）
  './chars/adrian_phone_1.webp',  // 水族箱（使用者指定白天）
  './chars/silas_phone_1.webp',   // 水族箱（使用者指定白天）
  './chars/silas_phone_9.webp',   // 正氣師辦公室（使用者指定白天）
  './chars/Silas_desktop_1.webp', // 圖書館窗外日光（桌機）
  './chars/Eli_desktop_1.webp',   // 教室窗光（桌機）
  './chars/eli_desktop_2.webp',   // 溫室陽光（桌機）
  './chars/sean_desktop_3.webp',  // 鬱金香花田（桌機橫版）
]);
const AFTERNOON_COVERS = new Set([ // 下午：日落/黃昏金色光
  './chars/sean_phone_6.webp',    // 海邊日落（原 phone_4 改號）
  './chars/silas_phone_4.webp',   // 金色逆光/黃昏
  './chars/adrian_phone_3.webp',  // 佛羅倫斯日落
  './chars/silas_phone_2.webp',   // 水晶球燭光（使用者指定下午）
  './chars/sean_phone_2.webp',    // 書桌燭光（使用者指定下午）
  './chars/adrian_desktop_3.webp',// 佛羅倫斯日落（桌機橫版）
]);
// 照片識別鍵：去掉副檔名。封面 v3.49 從 .JPG 轉 .webp，但使用者帳號存的隱藏設定、
// 留影走廊匯入時存下的 image_url 都還是 .JPG 路徑——所有比對一律用去副檔名 key，新舊通吃。
function photoKey(u) { return String(u || '').replace(/\.(jpe?g|webp)$/i, ''); }
const _MORNING_KEYS = new Set([...MORNING_COVERS].map(photoKey));
const _AFTERNOON_KEYS = new Set([...AFTERNOON_COVERS].map(photoKey));
// 傳回某封面的時段：am=早晨中午、pm=下午、night=夜晚(預設)。
function coverSlot(img) { const k = photoKey(img); return _MORNING_KEYS.has(k) ? 'am' : _AFTERNOON_KEYS.has(k) ? 'pm' : 'night'; }
// 匯入留影走廊的心動封面：image_slot 空時，回退顯示它在心動的原始早/午/晚分類（只對「確實是封面」的 url 生效，
// 一般作者投稿的圖不套用，避免被誤判成夜晚）。管理員按時段鈕仍可覆寫（存進 image_slot）。P2 心動池同樣用此回退。
const _ALL_COVER_URLS = (() => { const s = new Set(); CHARS.forEach(ch => [...(ch.imgs || []), ...(ch.imgsD || [])].forEach(u => u && s.add(photoKey(u)))); return s; })();
function coverSlotForUrl(url) { return _ALL_COVER_URLS.has(photoKey(url)) ? coverSlot(url) : ''; }
function effectiveImageSlot(work) { return (work && work.image_slot) || coverSlotForUrl(work && work.image_url) || ''; }

// ── 封面裁切框（心動 hero / 角色頁縮圖共用）──────────────────────────────────
// 非破壞性：原圖不動，後端只存一個 "z,x,y" 顯示框（z=在 cover 之上的縮放倍率≥1，x,y=可視框在
// 圖上的正規化焦點中心 0..1）。套用時依當前框（不同頁面框比例不同）以 cover 為底重算，所以同一份
// 設定在心動大圖與角色頁縮圖都成立——中心固定、縮放一致，只有邊緣依框比例裁掉（cover 本義）。
let _coverCrops = {};       // photoKey → "z,x,y"
const _imgNat = {};         // photoKey → {w,h}（原圖尺寸快取）
async function loadCoverCrops() {
  try { _coverCrops = await api('/novels/cover-crops') || {}; }
  catch { _coverCrops = {}; }
}
function parseCrop(s) {
  const p = String(s || '').split(',').map(Number);
  if (p.length < 3 || p.some(n => !isFinite(n))) return null;
  return { z: Math.max(1, p[0]), x: Math.min(1, Math.max(0, p[1])), y: Math.min(1, Math.max(0, p[2])) };
}
function getCoverCrop(url) { return parseCrop(_coverCrops[photoKey(url)]); }
function imgNat(url) {
  const k = photoKey(url);
  if (_imgNat[k]) return Promise.resolve(_imgNat[k]);
  return new Promise(res => {
    const im = new Image();
    im.onload = () => { _imgNat[k] = { w: im.naturalWidth, h: im.naturalHeight }; res(_imgNat[k]); };
    im.onerror = () => res(null);
    im.src = url;
  });
}
// 依框尺寸把「z,x,y」換算成該圖層的 background-size / background-position（px）。
function cropBgPx(fw, fh, nw, nh, crop) {
  const cover = Math.max(fw / nw, fh / nh);
  const s = cover * crop.z, dw = nw * s, dh = nh * s;
  let left = fw / 2 - crop.x * dw, top = fh / 2 - crop.y * dh;
  left = Math.min(0, Math.max(fw - dw, left));
  top = Math.min(0, Math.max(fh - dh, top));
  return { size: `${dw}px ${dh}px`, position: `${left}px ${top}px` };
}
// 對一個以 background-image 呈現的元素套用裁切框；無裁切或原圖未知時回退預設 cover。
function applyCoverCropToEl(el, url) {
  const crop = getCoverCrop(url);
  if (!crop) { el.style.backgroundSize = ''; el.style.backgroundPosition = ''; return; }
  imgNat(url).then(nat => {
    if (!nat) return;
    const fw = el.clientWidth, fh = el.clientHeight;
    if (!fw || !fh) return;
    const px = cropBgPx(fw, fh, nat.w, nat.h, crop);
    el.style.backgroundSize = px.size;
    el.style.backgroundPosition = px.position;
  });
}

// ── 角色設定頁 (beta) — 基本資料 + GitHub 圖庫。bio / gallery 由站長填寫；gallery 留空時自動用封面圖。
const CHAR_PROFILE = {
  Sean:   { bio: '', gallery: [] },
  Silas:  { bio: '', gallery: [] },
  Eli:    { bio: '', gallery: [] },
  Adrian: { bio: '', gallery: [] },
};
let _homeChar = null;   // 目前顯示在心動封面的角色(給封面愛心 → 角色頁用)
let _homePick = null;   // 目前這輪選中的封面 {char,img,slot}；載完裁切框／畫作等「重貼」時沿用同一張，不重抽（避免人物跳動）
// 從留影走廊隱藏的畫作（photoKey 集合）。隱藏 = 牆上與心動封面都不出現，只影響本人、跨裝置同步。
function hiddenGallery() {
  return new Set((currentUser && currentUser.hidden_gallery ? String(currentUser.hidden_gallery).split(',') : [])
    .map(s => photoKey(s.trim())).filter(Boolean));
}
function excludedPhotos() {
  // beta：使用者逐張隱藏的心動封面照片(存照片路徑，含桌機版一起排除)。空 = 全部顯示。
  // 一律正規化成 photoKey：帳號裡可能同時存著舊 .JPG 與新 .webp 的路徑。
  // 併入「留影走廊隱藏」的畫作——隱藏一張圖時，心動封面也一起不出現。
  const s = new Set((currentUser && currentUser.home_chars ? String(currentUser.home_chars).split(',') : [])
    .map(x => photoKey(x.trim())).filter(Boolean));
  hiddenGallery().forEach(k => s.add(k));
  return s;
}

// ── 角色設定頁（公開，所有人可用）─────────────────────────────
function openCharProfile(name) {
  if (!name) return;
  renderCharProfile(name);
  document.getElementById('char-profile').classList.add('open');
}
function openCharProfileFromHome() { if (_homeChar) openCharProfile(_homeChar.name); }
function closeCharProfile() { document.getElementById('char-profile').classList.remove('open'); }
function renderCharProfile(name) {
  const charData = CHARS.find(c => c.name === name) || {};
  const prof = CHAR_PROFILE[name] || { bio: '', gallery: [] };
  const code = (CHAR_LIST.find(x => x.name === name) || {}).code;
  document.getElementById('cp-name').textContent = name;
  const photos = (charData.imgs && charData.imgs.length) ? charData.imgs : [charData.img].filter(Boolean);
  const excluded = excludedPhotos();
  const myWorks = (typeof novels !== 'undefined' ? novels : []).filter(n =>
    (n.owners || []).includes(currentUser && currentUser.id) && (n.characters || []).includes(code));
  let html = '';
  if (photos.length) {
    // 每張照片右上角一個開關：勾 = 這張出現在心動封面，取消 = 隱藏這張(連同桌機同序版)
    const HEART = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 20.7l-1.45-1.32C5.4 14.74 2 11.66 2 7.9 2 5.1 4.2 3 7 3c1.6 0 3.14.74 4.13 1.9L12 5.9l.87-1C13.86 3.74 15.4 3 17 3c2.8 0 5 2.1 5 4.9 0 3.76-3.4 6.84-8.55 11.49L12 20.7z"/></svg>`;
    const DL = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 12l5 5 5-5"/><path d="M5 21h14"/></svg>`;
    // 裁切框（心動顯示焦點）：官方封面只有管理員能框；留影走廊畫作作者(gc.mine)或管理員能框。
    const CROP = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>`;
    const adminish = currentUser && ['admin', 'super_admin'].includes(currentUser.role);
    const cropBtn = (u) => `<button class="cp-crop" data-onclick="openCoverCrop('${escapeHtml(u)}')" aria-label="調整心動封面顯示" title="調整心動封面顯示">${CROP}</button>`;
    html += `<div class="cp-cover-head"><h3>心動封面</h3><button class="cp-hint-btn" data-onclick="cpCoverHint()" aria-label="心動封面說明" title="心動封面說明">${ic('ic-help', 16)}</button><div class="cp-cover-note" id="cp-cover-note" hidden>點亮愛心即可加入心動封面；取消後不再出現。全部取消時，會恢復隨機輪替。</div></div>`;
    const charShots = photos.map((u, i) => {
      const on = !excluded.has(photoKey(u));
      const dl = photoWallpaperUrl(u) ? `<button class="cp-download" data-onclick="downloadPhoto('${u}','${escapeHtml(name)}')" aria-label="下載桌布" title="下載桌布">${DL}</button>` : '';
      const heart = `<button class="cp-cover-toggle${on ? ' on' : ''}" data-onclick="toggleCoverPhoto('${name}', ${i}, this)" role="checkbox" aria-checked="${on}" aria-label="心動封面顯示這張">${HEART}</button>`;
      return `<div class="cp-shot" data-full="${escapeHtml(u)}" style="background-image:url('${u}')">${heart}${dl}${adminish ? cropBtn(u) : ''}</div>`;
    }).join('');
    // P2：這個角色「已排時段」的留影走廊畫作也列進來（傳全域索引給 toggle，避免把 URL 塞進宣告式 handler）
    const galShots = (_homeGalleryCovers || []).map((gc, gi) => ({ gc, gi }))
      .filter(x => (x.gc.characters || []).includes(code))
      .map(({ gc, gi }) => {
        const on = !excluded.has(photoKey(gc.image_url));
        const heart = `<button class="cp-cover-toggle${on ? ' on' : ''}" data-onclick="toggleCoverGallery(${gi}, this)" role="checkbox" aria-checked="${on}" aria-label="心動封面顯示這張">${HEART}</button>`;
        const canCrop = adminish || gc.mine;
        return `<div class="cp-shot" data-full="${escapeHtml(gc.image_url)}" style="background-image:url('${escapeHtml(gc.image_url)}')">${heart}${canCrop ? cropBtn(gc.image_url) : ''}</div>`;
      }).join('');
    html += `<div class="cp-gallery">${charShots}${galShots}</div>`;
  }
  html += `<div class="cp-section"><h3>基本資料</h3><p class="cp-bio">${prof.bio ? escapeHtml(prof.bio) : '（基本資料待補充）'}</p></div>`;
  html += `<div class="cp-section"><h3>我為 ${escapeHtml(name)} 寫的文章</h3>`;
  html += myWorks.length
    ? myWorks.map(n => `<a class="cp-work" href="#" data-onclick="closeCharProfile();openNovel('${n.id}');return false;">${ic('ic-book', 14)} ${escapeHtml(n.title)}</a>`).join('')
    : `<p class="cp-hint">還沒有你為這個角色寫的文章。</p>`;
  html += `</div>`;
  const body = document.getElementById('cp-body');
  body.innerHTML = html;
  // 每張縮圖套用自己的裁切框（有設定才動，否則維持 cover 預設）。
  body.querySelectorAll('.cp-shot[data-full]').forEach(el => applyCoverCropToEl(el, el.dataset.full));
  // 封面雙擊 → 全螢幕帶浮水印大圖（同留影走廊）。手動雙擊偵測，避免與愛心／下載鈕的單擊誤觸。
  body.querySelectorAll('.cp-shot').forEach(el => {
    let t = 0;
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;   // 點在愛心／下載鈕上不算
      const now = Date.now();
      if (now - t < 320) { t = 0; const u = el.dataset.full; if (u) openImageFull(u); }
      else t = now;
    });
  });
}
// 逐張開關：勾 = 這張出現在心動封面，取消 = 隱藏。連同同一序的桌機版一起排除(照顧桌機讀者)。
// 封面愛心說明(收進 tooltip:點 ⓘ 才出現,不直接佔版面)
function cpCoverHint() { const n = document.getElementById('cp-cover-note'); if (n) n.hidden = !n.hidden; }
function toggleEntryNote() { const n = document.getElementById('entry-note'); if (n) n.hidden = !n.hidden; }
async function toggleCoverPhoto(charName, index, btn) {
  const c = CHARS.find(x => x.name === charName) || {};
  const ids = [(c.imgs || [c.img])[index], (c.imgsD || [])[index]].filter(Boolean).map(photoKey);
  const ex = excludedPhotos();
  const nowShown = ex.has(ids[0]);          // 目前被隱藏 → 切換後變顯示
  ids.forEach(id => { if (nowShown) ex.delete(id); else ex.add(id); });
  btn.classList.toggle('on', nowShown);
  try {
    const r = await api('/auth/me/home-chars', { method: 'PATCH', body: JSON.stringify({ chars: [...ex] }) });
    if (currentUser) currentUser.home_chars = (r && r.home_chars) || '';
  } catch (e) {
    ids.forEach(id => { if (nowShown) ex.add(id); else ex.delete(id); });   // 還原
    btn.classList.toggle('on', !nowShown);
    toast(e.message || '儲存失敗');
  }
}
// 留影走廊畫作的心動封面開關（角色頁）：用全域索引取回該張，以 photoKey 加入／移出隱藏集。
// renderGreeting 的併池已用同一個 excluded 判斷，所以隱藏後那張立刻退出心動輪播。
async function toggleCoverGallery(idx, btn) {
  const gc = (_homeGalleryCovers || [])[idx];
  if (!gc) return;
  const key = photoKey(gc.image_url);
  const ex = excludedPhotos();
  const nowShown = ex.has(key);             // 目前被隱藏 → 切換後變顯示
  if (nowShown) ex.delete(key); else ex.add(key);
  btn.classList.toggle('on', nowShown);
  try {
    const r = await api('/auth/me/home-chars', { method: 'PATCH', body: JSON.stringify({ chars: [...ex] }) });
    if (currentUser) currentUser.home_chars = (r && r.home_chars) || '';
  } catch (e) {
    if (nowShown) ex.add(key); else ex.delete(key);   // 還原
    btn.classList.toggle('on', !nowShown);
    toast(e.message || '儲存失敗');
  }
}
// 官方角色頭像：單擊 = 篩選（原行為）；雙擊 = 開角色頁。onFilter(type,val) 是原本的篩選回呼。
let _ocTapTimer = null, _ocTapCode = null;
function officialCharTap(code, onFilter) {
  if (_ocTapTimer && _ocTapCode === code) {
    clearTimeout(_ocTapTimer); _ocTapTimer = null; _ocTapCode = null;
    openCharProfile((CHAR_LIST.find(x => x.code === code) || {}).name);
  } else {
    if (_ocTapTimer) clearTimeout(_ocTapTimer);
    _ocTapCode = code;
    _ocTapTimer = setTimeout(() => { _ocTapTimer = null; _ocTapCode = null; onFilter('char', code); }, 320);
  }
}

// 下載桌布:把某張封面照片對應的「加浮水印桌布版」抓下來。
// ./chars/sean_phone_2.webp → ./wallpapers/sean_phone_2_wall.jpg
function photoWallpaperUrl(img) {
  if (!img) return null;
  return img.replace('./chars/', './wallpapers/').replace(/\.(jpe?g|webp)$/i, '_wall.jpg');
}
async function downloadPhoto(img, charName) {
  const url = photoWallpaperUrl(img);
  if (!url) return;
  await shareOrDownload(url, '預言家日報-' + (charName || '桌布') + '.jpg');
}
// iOS PWA 存相簿要走 Web Share(會跳「儲存影像」);桌機/Android 退回直接下載;再不行就開圖讓使用者長按存。
async function shareOrDownload(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('not found');
    const blob = await res.blob();
    const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) {}   // 使用者取消 = 不做事
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } catch (e) {
    window.open(url, '_blank');   // 最後手段:開圖,長按儲存
  }
}



// P2：留影走廊已指定時段的畫作，登入後抓一次併入心動封面池（依角色分入 CHARS 輪替）。
let _homeGalleryCovers = [];
async function loadHomeGalleryCovers() {
  try {
    const raw = await api('/novels/home-covers', { background: true }) || [];
    // 從留影走廊「批次匯入」的官方封面，其 image_url 就是 /chars/ 原圖，本來就已是心動封面（透過 CHARS）。
    // 再從留影走廊併進來會與官方封面重複（角色頁出現兩張、輪播雙重計數）→ 濾掉。使用者投稿畫作(Supabase URL)保留。
    _homeGalleryCovers = raw.filter(gc => !_ALL_COVER_URLS.has(photoKey(gc.image_url)));
  }
  catch { _homeGalleryCovers = []; }
  // 抓到資料時，若正停在心動頁就重繪讓畫作即時登場
  if (_homeGalleryCovers.length && document.getElementById('page-home')?.classList.contains('active')) renderGreeting(false);
}

let _heroSeq = 0;   // 心動封面載入的渲染序號（防舊計時器/回呼蓋掉新一輪）
// repick=true 才重抽封面；載入資料後的「重貼」(裁切框/畫作/暱稱)傳 false，沿用上一張，避免整頁人物一直跳。
function renderGreeting(repick = true) {
  const h = new Date().getHours();
  // 時段 index：0=早上(5-11) 1=中午(12-13) 2=下午(14-17) 3=晚上/深夜(18-4)
  const timeIdx = h >= 5 && h < 12 ? 0 : h >= 12 && h < 14 ? 1 : h >= 14 && h < 18 ? 2 : 3;
  const period = h < 5 ? '深夜好' : h < 12 ? '早安' : h < 18 ? '午安' : '晚安';
  const isWide = window.matchMedia('(min-width: 600px)').matches;
  const photosOf = c => ((isWide ? (c.imgsD || [c.imgD]) : (c.imgs || [c.img])) || []).filter(Boolean);
  // 以「照片」為單位建池：使用者未取消的照片(連同角色)都是候選。全被取消 → 退回全部隨機。
  const excluded = excludedPhotos();
  let selected = [];
  CHARS.forEach(c => photosOf(c).forEach(img => { if (!excluded.has(photoKey(img))) selected.push({ char: c, img }); }));
  if (!selected.length) CHARS.forEach(c => photosOf(c).forEach(img => selected.push({ char: c, img })));
  // P2：併入留影走廊已指定時段的畫作。依角色代碼對回 CHARS（一張多角色 → 每個角色都當候選），
  // 候選帶著自己的 slot（Supabase URL 無法用 coverSlot 推時段，靠後端給的 image_slot）。
  (_homeGalleryCovers || []).forEach(gc => {
    (gc.characters || []).forEach(code => {
      const nm = (CHAR_LIST.find(x => x.code === code) || {}).name;
      const c = nm && CHARS.find(x => x.name === nm);
      if (c && !excluded.has(photoKey(gc.image_url))) selected.push({ char: c, img: gc.image_url, slot: gc.slot });
    });
  });
  // 時段門檻：06:00–14:30 早晨＆中午(am)、14:30–18:00 下午(pm)、其餘夜晚(night；無陽光者默認夜晚)。
  const mins = h * 60 + new Date().getMinutes();
  const slot = (mins >= 360 && mins < 870) ? 'am' : (mins >= 870 && mins < 1080) ? 'pm' : 'night';
  // 候選時段：畫作用自帶 slot，官方封面照舊用 coverSlot(檔名) 推。
  const slotOf = x => x.slot || coverSlot(x.img);
  // 下午池較小：下午時段讓「早晨中午」的圖也一起輪（反向不成立——下午的圖只在下午出現）。
  let pool = selected.filter(x => slot === 'pm'
    ? (slotOf(x) === 'pm' || slotOf(x) === 'am')
    : slotOf(x) === slot);
  // 保底：使用者的選取在當前時段沒有任何圖 → 忽略時段，改在他選的那幾張裡隨機輪轉(不留白)。
  if (!pool.length) pool = selected;
  // 「重貼」時沿用上一張(仍在候選池裡才用，否則退回重抽)，讓載入資料的回呼不會把人物換掉。
  const reusable = !repick && _homePick && pool.some(x => photoKey(x.img) === photoKey(_homePick.img));
  const pick = reusable ? _homePick : (pool[Math.floor(Math.random() * pool.length)] || { char: CHARS[0], img: CHARS[0].img });
  _homePick = pick;
  const char = pick.char;
  _homeChar = char;
  const heart = document.getElementById('hero-heart');
  if (heart) heart.style.display = 'flex';
  const hero = document.getElementById('greeting-hero');
  const emoji = document.getElementById('char-emoji');
  const GRAD = 'linear-gradient(160deg, #4a1d1d 0%, #2a1408 100%)';
  emoji.textContent = char.emoji;
  emoji.style.display = '';            // show emoji over the gradient (fallback)
  hero.style.backgroundImage = GRAD;   // gradient base — never let parchment show through
  document.getElementById('greeting-line-text').innerHTML = `${period}，${escapeHtml(currentUser.nickname || currentUser.username || '你')} <svg width="17" height="17" aria-hidden="true" style="vertical-align:-2px"><use href="#ic-star"/></svg>`;
  document.getElementById('greeting-quote-text').textContent = char.quotes[timeIdx];
  // 三層背景：封面（最上，載完自動浮現）→ 角色線稿（0 秒即顯示的底稿）→ 漸層（最後保底）。
  // 瀏覽器把「還沒載好的背景層」視為透明，所以不需要計時器：網路快線稿只閃一瞬，
  // 網路慢/斷網線稿一直陪著，封面到貨那一刻自動蓋上。
  const heroPos = isWide ? (char.bgPosDesktop || char.bgPos || 'center') : (char.bgPos || 'center');
  const FALLBACK_ART = { Sean: './assets/offline_sean.webp', Silas: './assets/offline_silas.webp', Eli: './assets/offline_eli.webp', Adrian: './assets/offline_adrian.webp' };
  const fbArt = FALLBACK_ART[char.name];
  const layers = (top, cropPx) => {
    const imgs = [top && `url('${top}')`, fbArt && `url('${fbArt}')`, GRAD].filter(Boolean);
    const n = imgs.length - 1;   // 圖片層數（不含漸層）
    const poss = Array(n).fill(heroPos).concat('center');
    const sizes = Array(n).fill(char.bgSize || 'cover').concat('cover');
    if (top && cropPx) { poss[0] = cropPx.position; sizes[0] = cropPx.size; }   // 頂層封面有裁切框時只覆寫它
    hero.style.backgroundImage = imgs.join(', ');
    hero.style.backgroundPosition = poss.join(', ');
    hero.style.backgroundRepeat = Array(n + 1).fill('no-repeat').join(', ');
    hero.style.backgroundSize = sizes.join(', ');
  };
  const showHero = (url, natEl) => {
    let cropPx = null;
    const crop = getCoverCrop(url);
    if (crop && natEl && natEl.naturalWidth && hero.clientWidth) {
      _imgNat[photoKey(url)] = { w: natEl.naturalWidth, h: natEl.naturalHeight };
      cropPx = cropBgPx(hero.clientWidth, hero.clientHeight, natEl.naturalWidth, natEl.naturalHeight, crop);
    }
    layers(url, cropPx);
    emoji.style.display = 'none';
  };
  // 0 秒先鋪線稿底稿（有的話），封面載到再蓋上。
  if (fbArt) { layers(null); emoji.style.display = 'none'; }
  // 候選圖：先用挑中的那張，載入失敗時退回同角色其他「未隱藏」的照片，最後才是全部(避免空白)。
  let candidates = [pick.img, ...photosOf(char).filter(u => !excluded.has(photoKey(u))), ...photosOf(char)];
  candidates = [...new Set(candidates.filter(Boolean))];   // dedup, keep order
  const seq = ++_heroSeq;   // 防舊一輪回呼污染新渲染（切頁、整點換圖時 renderGreeting 會重跑）
  (function tryLoad(i) {
    if (seq !== _heroSeq) return;
    if (i >= candidates.length) return;   // 全部失敗 → 線稿底稿留守（或漸層+emoji）
    const im = new Image();
    im.onload = () => { if (seq === _heroSeq) showHero(candidates[i], im); };
    im.onerror = () => tryLoad(i + 1);
    im.src = candidates[i];
  })(0);
  setTimeout(warmCoverCache, 3000);   // 當前封面穩定後，閒置預抓本時段封面池（SW 存進常駐快取）
}

// 背景預熱心動封面：把「當前時段會輪到」的封面一張張慢慢抓進 Service Worker 常駐快取，
// 之後隨機輪到哪張都是秒開。每個 session 只跑一次；使用者開省流量模式就不預抓。
let _coverWarmed = false;
function warmCoverCache() {
  if (_coverWarmed) return; _coverWarmed = true;
  if (navigator.connection && navigator.connection.saveData) return;
  const isWide = window.matchMedia('(min-width: 600px)').matches;
  const photosOf = c => ((isWide ? (c.imgsD || [c.imgD]) : (c.imgs || [c.img])) || []).filter(Boolean);
  const mins = new Date().getHours() * 60 + new Date().getMinutes();
  const slot = (mins >= 360 && mins < 870) ? 'am' : (mins >= 870 && mins < 1080) ? 'pm' : 'night';
  const excluded = excludedPhotos();   // 使用者已隱藏的封面不預抓（他永遠看不到，抓了純浪費流量）
  const urls = [];
  CHARS.forEach(c => photosOf(c).forEach(img => {
    if (excluded.has(photoKey(img))) return;
    const s = coverSlot(img);
    if (s === slot || (slot === 'pm' && s === 'am')) urls.push(img);   // 下午池含早午圖，同 renderGreeting
  }));
  (function next(i) {   // 序列式、每張間隔 300ms——不跟當前畫面搶頻寬
    if (i >= urls.length) return;
    const im = new Image();
    im.onload = im.onerror = () => setTimeout(() => next(i + 1), 300);
    im.src = urls[i];
  })(0);
}

// ── Novels ───────────────────────────────────────────────────
function fmtUpdated(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  // 用固定時區(台北 UTC+8，與後端「上架/排程」判斷同基準)顯示發佈日期，讓所有讀者(含美東作者、
  // 美國讀者)看到同一個日曆日期，避免依觀看者本機時區換算造成 off-by-one(11 號被顯示成 10 號)。
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }).replace(/-/g, '/');
}

let novelsError = false;
let hotIds = [];   // top-3 works (last 24h) floated to the front of the default shelf, silently
async function loadNovels() {
  // 書架先顯示：novels 一回來就 render，不再 sequential 等 /novels/hot（那讓首屏疊加成 ~1.2s）。
  // hot 只是把 24h top-3 靜默浮頂，屬錦上添花——背景載入，回來後若有再重排一次即可。
  hotIds = [];
  try { novels = await api('/novels/?kind=novel') || []; novelsError = false; }
  catch { novels = []; novelsError = true; }
  renderShelf();              // 立即顯示（此時純發佈日期序，尚無 hot 浮頂）
  renderContinueBar();
  api('/novels/hot').then(ids => {   // hot 背景回來 → 重排把 top-3 浮頂（renderShelf 內部自判浮頂條件）
    hotIds = ids || [];
    if (hotIds.length) renderShelf();
  }).catch(() => {});
}

// ── Classification (category + characters) ───────────────────
const CATEGORIES = ['迷情劑', '吐真劑', '儲思盆'];
const CHAR_LIST = [
  { code: 'sean',   name: 'Sean',   house: 'gry', img: './chars/sean_phone_2.webp' },   /* 葛來分多 / phone_1 暫時下架 */
  { code: 'silas',  name: 'Silas',  house: 'rav', img: './chars/silas_phone_2.webp' },  /* 雷文克勞 / phone_1 暫時下架 */
  { code: 'eli',    name: 'Eli',    house: 'huf', img: './chars/eli_phone_2.webp' },    /* 赫夫帕夫 / phone_1 暫時下架 */
  { code: 'adrian', name: 'Adrian', house: 'sly', img: './chars/adrian_phone_2.webp' }, /* 史萊哲林 / phone_1 暫時下架 */
];
// 角色 pill：依角色所屬學院上邊框色。統一從這裡產生，各處呼叫 charPill(code) 不再手寫 span。
function charPill(code) {
  const c = CHAR_LIST.find(x => x.code === code);
  const name = c ? c.name : code;
  const dot = c && c.house ? `<span class="t-dot h-${c.house}"></span>` : '';
  return `<span class="t-chr">${dot}${escapeHtml(name)}</span>`;
}
// 分類標籤色：迷情劑紅（預設）、吐真劑綠、儲思盆靛藍。
function catCls(c) { return c === '吐真劑' ? ' t-cat-green' : c === '儲思盆' ? ' t-cat-blue' : ''; }
let shelfCat = '';        // '' = 全部
let shelfChars = [];   // default: none lit = show everything; tap a character to filter to them (OR)
// 作品管理 (admin works) filter. Type pills include 羊皮紙 (=forum) on top of the 3 novel categories.
const ADMIN_CATS = ['迷情劑', '吐真劑', '儲思盆'];   // 作品管理「分類」子篩，僅在種類=小說時出現
let adminKind = '';       // 作品管理種類分頁：'' 全部 | 'novel' | 'forum' | 'image'
let adminCat = '';        // '' | 迷情劑 | 吐真劑 | 儲思盆（僅小說種類下）
let adminChars = [];
let favIds = new Set();   // 意若思鏡 收藏夾: ids of whole works the user has favorited
let favTimes = new Map();   // novel_id → 收藏時間（追蹤更新的伺服器端基準）
let favWishReplies = [];    // 我自己被回應的許願（貓頭鷹通知用）
let APP_SETTINGS = {};   // 全域站台設定（超管可調，全體讀取）
let shelfFav = false;     // 收藏夾 view toggle

async function loadFavIds() {
  favTimes = new Map();
  try {
    const rows = await api('/novels/my-favorites');   // [{novel_id, created_at}]
    if (Array.isArray(rows)) {
      favIds = new Set(rows.map(r => r.novel_id));
      rows.forEach(r => { if (r.created_at) favTimes.set(r.novel_id, r.created_at); });
      return;
    }
  } catch (e) { /* 舊端點後援（部署空窗期） */ }
  try { favIds = new Set(await api('/novels/my-favorite-ids') || []); }
  catch { favIds = new Set(); }
}

// ── 追蹤更新: follow a SERIES by favouriting any of its parts ──
// Works are single-piece (one work = one chapter). A "series" is several works sharing a
// `series` name. Favouriting any part = following that series; an installment published
// AFTER you started following (server favourite time) shows as a notification on the owl.
function _readInstallments() { try { return JSON.parse(localStorage.getItem('pd_read_installments') || '[]'); } catch (e) { return []; } }
function _markInstallmentRead(id) {   // 打開某篇 = 標記該篇追蹤通知為已讀（per-device 已讀狀態）
  if (!id) return;
  const a = _readInstallments();
  if (!a.includes(id)) { a.push(id); try { localStorage.setItem('pd_read_installments', JSON.stringify(a)); } catch (e) {} pushClientState({ read_works_add: [id] }); }
}
function markSeriesSeenForWork(novel) { if (novel && novel.id) _markInstallmentRead(novel.id); }
function owlAlways() { return localStorage.getItem('pd_owl_always') === '1'; }   // 小工具「貓頭鷹常駐」
function toggleOwlAlways(on) { localStorage.setItem('pd_owl_always', on ? '1' : '0'); renderFavUpdates(); }
function noticeDays() { const d = parseInt(APP_SETTINGS.notice_days, 10); return (d && d > 0) ? d : 30; }   // 通知保留天數（超管可調，預設 30）
async function loadAppSettings() {
  try { APP_SETTINGS = await api('/settings/') || {}; } catch (e) { APP_SETTINGS = {}; }
  const nd = document.getElementById('notice-days'); if (nd) nd.value = noticeDays();
  renderFavUpdates();
}
async function saveNoticeDays(v) {   // 超管：設定通知保留天數（全站一致）
  const n = parseInt(v, 10);
  if (!n || n < 1 || n > 365) { toast('請輸入 1–365 之間的天數'); return; }
  try {
    await api('/settings/notice_days', { method: 'PUT', body: JSON.stringify({ value: String(n) }) });
    APP_SETTINGS.notice_days = String(n);
    renderFavUpdates();
    toast(`通知保留天數已設為 ${n} 天`);
  } catch (e) { toast('更新失敗，請稍後再試'); }
}
// 貓頭鷹＝通知中心。項目：主編來信 + 追蹤更新（收藏系列的新作品）。保留 30 天，讀過的留作歷史（灰掉）。
// 追蹤基準＝伺服器端「收藏該系列任一篇的最早時間」（favTimes），跨裝置一致，不再靠 localStorage。
async function renderFavUpdates() {
  const wrap = document.getElementById('fav-owl-wrap'); if (!wrap) return;
  const pop = document.getElementById('fav-owl-pop');
  const DAY = 86400000, cutoff = Date.now() - noticeDays() * DAY;
  const read = new Set(_readInstallments());
  const items = [];   // {kind:'letter'|'work', id, title, sub, at, unread}
  const ld = EDITOR_LETTER.date ? new Date(EDITOR_LETTER.date) : null;
  if (ld && ld.getTime() >= cutoff) {
    items.push({ kind: 'letter', key: `letter:${EDITOR_LETTER.id}`, title: '主編來信', sub: '本期更新與最新版本', at: EDITOR_LETTER.date, unread: !editorLetterSeen() });
  }
  const _writerPlus = currentUser && ['writer', 'admin', 'super_admin'].includes(currentUser.role);
  let all = null;
  if ((favIds && favIds.size) || _writerPlus) {
    try { all = await api('/novels/') || []; } catch (e) { all = null; }
  }
  if (favIds && favIds.size) {
    if (all) {
      const since = new Map();   // 系列 → 追蹤起點（最早收藏時間）
      all.forEach(n => {
        if (!n.series || !favIds.has(n.id)) return;
        const t = favTimes.get(n.id);
        if (t && (!since.has(n.series) || new Date(t) < new Date(since.get(n.series)))) since.set(n.series, t);
      });
      all.forEach(n => {
        if (!n.series || !n.created_at || !since.has(n.series) || n.kind === 'image') return;   // 畫作系列走留影走廊組圖，不推閱讀器式通知
        const c = new Date(n.created_at).getTime();
        if (c > new Date(since.get(n.series)).getTime() && c >= cutoff) {
          items.push({ kind: 'work', id: n.id, key: `work:${n.id}`, title: `系列《${n.series}》新作品`, sub: n.title, at: n.created_at, unread: !read.has(n.id) });
        }
      });
      // 直接收藏的作品加了新章節 → 通知（key 含時間戳：之後再更新會再次通知）
      all.forEach(n => {
        if (!n.last_chapter_at || !favIds.has(n.id)) return;
        const ft = favTimes.get(n.id); if (!ft) return;
        const t = new Date(n.last_chapter_at).getTime();
        if (isNaN(t) || t <= new Date(ft).getTime() || t < cutoff) return;
        const k = `chap:${n.id}:${n.last_chapter_at}`;
        items.push({ kind: 'chap', id: n.id, key: k, readKey: k, title: '追蹤的作品有新章節', sub: n.title, at: n.last_chapter_at, unread: !read.has(k) });
      });
    }
  }
  // 自己的作品審核刊出（執筆人以上）
  if (all && _writerPlus) {
    all.forEach(n => {
      if (!n.approved_at || !(n.owners || []).includes(currentUser.id)) return;
      const t = new Date(n.approved_at).getTime();
      if (isNaN(t) || t < cutoff) return;
      const k = `pub:${n.id}`;
      items.push({ kind: 'pub', id: n.id, key: k, readKey: k, title: '你的作品已刊出', sub: n.title, at: n.approved_at, unread: !read.has(k) });
    });
  }
  // 許願池：我自己的願望被回應（文字回覆 或 狀態變動）→ 通知
  try { favWishReplies = await api('/feedback/my-wish-replies') || []; } catch (e) { favWishReplies = []; }
  favWishReplies.forEach(w => {
    const isUnread = _wishReplyUnread(w);
    const at = w.created_at, atMs = at ? new Date(at).getTime() : 0;
    if (!isUnread && atMs < cutoff) return;   // 已讀且過期才隱藏；未讀一律顯示（回應可能落在舊願望上）
    const reply = (w.admin_reply || '').trim();
    const st = (FB_STATUS.wish && FB_STATUS.wish[w.status]) || '';
    const sub = reply || (st ? `願望狀態：${st}` : '有新回應');
    items.push({ kind: 'wishreply', id: w.id, key: `wish:${w.id}:${_wishReplySig(w)}`, title: '你的願望有了回音', sub, at, unread: isUnread });
  });
  // 授權信（writer 以上）：收到待回覆的信＋自己寄的信有了回音
  if (_writerPlus) {
    try {
      const mine = await loadMyAuths(true);
      (mine.received || []).forEach(a => {
        if (a.status !== 'pending') return;   // 待回覆的信一直提醒到處理為止（不受保留天數影響）
        const k = `authin:${a.id}`;
        items.push({ kind: 'authin', id: a.id, key: k, readKey: k, title: '收到一封授權信',
          sub: a.direction === 'use_image' ? `${a.requester_name} 想借《${a.artwork_title || '畫作'}》作文首圖` : `${a.requester_name} 想為《${a.work_title || '文章'}》作畫`,
          at: a.created_at, unread: !read.has(k) });
      });
      (mine.sent || []).forEach(a => {
        if (a.status === 'pending' || !a.decided_at) return;
        const t = new Date(a.decided_at).getTime();
        const k = `authout:${a.id}:${a.status}`;
        if (read.has(k) && t < cutoff) return;
        items.push({ kind: 'authout', id: a.id, key: k, readKey: k, title: '你的授權信有了回音',
          sub: (a.status === 'approved' ? '已同意' : '已婉拒') + ((a.reply_note || '').trim() ? `：${a.reply_note.trim()}` : ''),
          at: a.decided_at, unread: !read.has(k) });
      });
    } catch (e) {}
  }
  // 使用者按叉叉刪掉的不再出現；其餘依時間新到舊，最多顯示 5 則（列表才不會無限長）。
  const dismissed = new Set(_dismissedNotices());
  const visible = items.filter(it => !dismissed.has(it.key));
  visible.sort((a, b) => new Date(b.at) - new Date(a.at));
  _owlItems = visible.slice(0, 5);
  const unread = visible.filter(i => i.unread).length;
  // 預設只在有未讀時現身；小工具「貓頭鷹常駐」打開則一直在（即使全已讀／無通知）。
  if (!unread && !owlAlways()) { wrap.style.display = 'none'; if (pop) { pop.hidden = true; pop.innerHTML = ''; } return; }
  wrap.style.display = 'block';
  pop.hidden = true;
  if (!_owlItems.length) { pop.innerHTML = `<p class="fav-pop-empty">目前沒有新通知</p>`; return; }
  pop.innerHTML = `<p class="fav-pop-title">通知</p>` + _owlItems.map((it, i) => {
    const gold = it.kind === 'letter' || it.kind === 'wishreply' || it.kind === 'pub' || it.kind === 'authin' || it.kind === 'authout';   // 個人信件類＝金點
    const dotClass = it.unread ? (gold ? 'fav-dot gold' : 'fav-dot') : 'fav-dot read';
    const cls = `fav-row${it.unread ? '' : ' read'}`;
    // 叉叉用索引指到 _owlItems（key 可能含任意文字，不能塞進屬性）
    const inner = `<span class="${dotClass}"></span>`
      + `<span class="fav-row-main"><span class="fav-row-t">${escapeHtml(it.title)}</span>`
      + `<span class="fav-row-s">${escapeHtml(it.sub)}・${fmtUpdated(it.at)}</span></span>`
      + `<button class="fav-row-del" data-onclick="dismissNotice(${i});return false" aria-label="移除這則通知">${ic('ic-x', 13)}</button>`;
    if (it.kind === 'letter') return `<a href="#" data-onclick="openEditorLetter();return false" class="${cls}">${inner}</a>`;
    if (it.kind === 'chap' || it.kind === 'pub') return `<a href="#" data-onclick="owlOpenIdx(${i});return false" class="${cls}">${inner}</a>`;
    if (it.kind === 'wishreply') return `<a href="#" data-onclick="wishReplyOpen('${it.id}');return false" class="${cls}">${inner}</a>`;
    if (it.kind === 'authin' || it.kind === 'authout') return `<a href="#" data-onclick="owlOpenAuth(${i});return false" class="${cls}">${inner}</a>`;
    return `<a href="#" data-onclick="favOwlOpen('${it.id}');return false" class="${cls}">${inner}</a>`;
  }).join('');
}
// 被叉掉的通知（key 清單，localStorage，最多留 100 筆舊紀錄）。
// 願望回音的 key 含回覆簽章：之後回覆若有變動會換 key → 重新出現，不會漏掉新回應。
let _owlItems = [];
function _dismissedNotices() { try { return JSON.parse(localStorage.getItem('pd_dismissed_notices') || '[]'); } catch (e) { return []; } }
function dismissNotice(i) {
  const it = _owlItems[i]; if (!it) return;
  const arr = _dismissedNotices();
  if (!arr.includes(it.key)) arr.push(it.key);
  try { localStorage.setItem('pd_dismissed_notices', JSON.stringify(arr.slice(-100))); } catch (e) {}
  pushClientState({ dismissed_add: [it.key] });
  // 重畫後把浮層留在開啟狀態，讓使用者能連續清理；貓頭鷹若因此整個沒通知則收起。
  renderFavUpdates().then(() => {
    const w = document.getElementById('fav-owl-wrap'), p = document.getElementById('fav-owl-pop');
    if (w && w.style.display !== 'none' && p && p.innerHTML) p.hidden = false;
  });
}
function toggleFavOwl() { const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = !p.hidden; }
function owlOpenIdx(i) {   // 章節更新/作品刊出：標記已讀（帶前綴 key）並打開作品
  const it = _owlItems[i]; if (!it) return;
  const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = true;
  if (it.readKey) _markInstallmentRead(it.readKey);
  openNovel(it.id);
}
function favOwlOpen(id) { const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = true; _markInstallmentRead(id); openNovel(id); }
function owlOpenAuth(i) {   // 授權信通知 → 打開信箱（writer 進授權分頁；admin 進審核的授權信膠囊）
  const it = _owlItems[i]; if (!it) return;
  const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = true;
  if (it.readKey) _markInstallmentRead(it.readKey);
  const adminBtn = document.getElementById('admin-nav-btn');
  showPage('admin', adminBtn);
  if (isAdminUser()) { switchAdminTab('review'); setReviewMode('auths'); }
  else switchAdminTab('auths');
}
// 許願回音的已讀狀態：以「status＋回覆內容」當簽章，回覆有變動就再次變未讀。
function _readWishReplies() { try { return JSON.parse(localStorage.getItem('pd_read_wishreplies') || '{}'); } catch (e) { return {}; } }
function _wishReplySig(w) { return `${w.status || ''}||${(w.admin_reply || '').trim()}`; }
function _wishReplyUnread(w) { return _readWishReplies()[w.id] !== _wishReplySig(w); }
function _markWishReplyRead(id) {
  const w = favWishReplies.find(x => x.id === id); if (!w) return;
  const m = _readWishReplies(); m[id] = _wishReplySig(w);
  try { localStorage.setItem('pd_read_wishreplies', JSON.stringify(m)); } catch (e) {}
  pushClientState({ read_wishes_set: { [id]: _wishReplySig(w) } });
}
function wishReplyOpen(id) {
  const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = true;
  _markWishReplyRead(id);
  openWishPool(id);   // 帶 id → 開許願池並跳到那一則願望
}
// ── 主編來信（單封更新公告）──────────────────────────────────────────
// 換新一封時把 id 改掉即可：已讀狀態以 id 存 localStorage，每封只自動跳一次。
const EDITOR_LETTER = {
  id: 'v3.11',
  date: '2026-07-09',   // 通知中心保留 30 天起算日（換新一封時連同 id 一起更新）
  lead: '本期更新，重點如下：',
  items: [
    '貓頭鷹如今也會捎來許願池的回音——你的願望被回覆時，牠會第一時間通知你。',
    '通知可以整理了：輕點叉號即可送走一則，最多保留五則。',
    '新增「語言選擇」：檔案 → 閱讀偏好，可在原文、繁體、簡體之間切換。',
    '心動封面大批上新。',
    '讀報最好的方式：用 Safari 開啟本站，點「分享」、選「加入主畫面」——之後像 App 一樣一鍵翻開。',
  ],
  closing: '版本更新至 v3.11。',
};
function editorLetterSeen() { return localStorage.getItem('pd_letter_seen') === EDITOR_LETTER.id; }
function markEditorLetterSeen() { try { localStorage.setItem('pd_letter_seen', EDITOR_LETTER.id); } catch (e) {} pushClientState({ letter_seen: EDITOR_LETTER.id }); }
function openEditorLetter() {
  const m = document.getElementById('editor-letter'); if (!m) return;
  const pop = document.getElementById('fav-owl-pop'); if (pop) pop.hidden = true;   // 從貓頭鷹點進來時收起浮層
  const body = document.getElementById('editor-letter-body');
  if (body) body.innerHTML =
    `<div class="el-lead">${escapeHtml(EDITOR_LETTER.lead)}</div>` +
    EDITOR_LETTER.items.map(t => `<div class="el-item"><span class="el-dot">·</span><span>${escapeHtml(t)}</span></div>`).join('') +
    `<div class="el-foot">${escapeHtml(EDITOR_LETTER.closing)}<span class="el-sign">—— 主編</span></div>`;
  // 一次性更新鈕：這台裝置按過（記在 pd_letter_upd）就不再出現，之後從貓頭鷹回看只剩「知道了」。
  const ub = document.getElementById('letter-update-btn');
  if (ub) ub.style.display = localStorage.getItem('pd_letter_upd') === EDITOR_LETTER.id ? 'none' : '';
  m.style.display = 'flex';
}
function letterUpdateOnce() {
  try { localStorage.setItem('pd_letter_upd', EDITOR_LETTER.id); } catch (e) {}
  markEditorLetterSeen();
  updateToLatest();   // 清快取＋重載，拿最新一期
}
// ── 月末讀報回顧：每月第一次打開時回顧上一個月；帳號級只跳一次，上月沒讀就靜靜略過 ──
async function maybeShowMonthlyRecap() {
  if (!currentUser) return;
  if (!editorLetterSeen()) return;   // 主編來信優先，回顧留到下次開啟
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  const cs = (currentUser && currentUser.client_state) || {};
  if (cs.recap_seen === key || localStorage.getItem('pd_recap_seen') === key) return;
  let r = null;
  try { r = await api('/auth/me/monthly-recap'); } catch (e) { return; }
  const markSeen = () => { try { localStorage.setItem('pd_recap_seen', key); } catch (e) {} pushClientState({ recap_seen: key }); };
  if (!r || r.month !== key || !r.reads) { markSeen(); return; }
  const zh = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  let charPart = '';
  if (r.top_char) {
    const c = (typeof CHAR_LIST !== 'undefined' ? CHAR_LIST : []).find(x => x.code === r.top_char);
    if (c && c.name) charPart = `，最常相遇的是 ${c.name}`;
  }
  const body = document.getElementById('recap-body');
  if (body) body.textContent = `${zh[prev.getMonth()]}月，你翻開日報 ${r.active_days} 天，讀過 ${r.works} 篇作品${charPart}。`;
  const m = document.getElementById('recap-card'); if (m) m.style.display = 'flex';
  markSeen();
}
function dismissRecap() { const m = document.getElementById('recap-card'); if (m) m.style.display = 'none'; }
function dismissEditorLetter() {
  markEditorLetterSeen();
  const m = document.getElementById('editor-letter'); if (m) m.style.display = 'none';
  renderFavUpdates();   // 已讀後貓頭鷹收起「主編來信」一條
}
// 版本狀態（檔案頁）：抓 service-worker.js 的 CACHE_NAME 版本，跟執行中的 APP_VERSION 比。
async function fetchLatestVersion() {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('./service-worker.js?cb=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    const m = (await res.text()).match(/prophet-daily-(v[\d.]+)/);
    return m ? m[1] : null;   // 'vN.NN'
  } catch (e) { return null; }
}
async function renderVersionStatus() {
  const el = document.getElementById('version-status'); if (!el) return;
  el.disabled = true; el.className = 'version-btn checking'; el.textContent = '檢查更新中…';
  const latest = await fetchLatestVersion();
  if (latest && latest !== APP_VERSION) {   // 過時 → 可按，點了更新
    el.className = 'version-btn outdated'; el.disabled = false;
    el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg> 獲取一份新的預言家日報`;
  } else {   // 最新（或抓不到 → 不誤報）→ 純狀態，不可按
    el.className = 'version-btn latest'; el.disabled = true;
    el.innerHTML = `${ic('ic-check', 14)} 您已收到最新一期的預言家日報`;
  }
}
// 檔案頁「更新」鈕：只在確定過時時可按，使用者主動更新 → 徹底清快取＋SW 重載，保證拿到最新一期。
async function updateToLatest() {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        // 抓最新 service-worker.js → 安裝新版 SW（它會用版本戳 no-store 預抓，拿到「真的」新檔，
        // 不受鏡像／CDN 舊快取影響）。等它 activated 再重載，讓它 cache-first 供應剛預抓的新檔。
        // 不再 unregister＋清全部快取——那會退回瀏覽器的舊 HTTP 快取，正是鏡像一直換不動的原因。
        await reg.update();
        const sw = reg.installing || reg.waiting;
        if (sw) await new Promise((res) => {
          sw.addEventListener('statechange', () => { if (sw.state === 'activated') res(); });
          setTimeout(res, 4000);   // 保底：等不到就直接重載
        });
      }
    }
  } catch (e) { /* best effort */ }
  location.reload();
}
function maybeShowEditorLetter() {
  if (editorLetterSeen()) return;
  // 只在「首次自動導覽即將出現」時讓路（全新讀者/作家帳號），避免兩個彈窗疊在一起；
  // 其餘人——管理員、超管、以及看過任何版本導覽的讀者/作家——都會跳。
  if (['reader', 'writer'].includes(currentUser?.role) && !tourSeenAnyForRole()) return;
  openEditorLetter();
}
function toggleShelfFav() {
  shelfFav = !shelfFav;
  document.getElementById('shelf-fav-btn').classList.toggle('on', shelfFav);
  renderShelf();
}
// Reader: favorite the whole work (意若思鏡 only).
function updateReaderFavBtn() {
  const b = document.getElementById('reader-fav-btn');
  if (!b) return;
  b.style.display = currentNovelKind === 'novel' ? '' : 'none';   // 意若思鏡 works only
  const fav = favIds.has(currentNovelId);
  b.innerHTML = fav ? ic('ic-starfill',22) : ic('ic-starline',22);
  b.style.color = fav ? 'var(--gold)' : 'var(--gold-lt)';
}
async function toggleReaderFavorite() {
  if (!currentNovelId) return;
  try {
    const r = await api(`/novels/${currentNovelId}/favorite`, { method: 'POST' });
    if (r.favorited) favIds.add(currentNovelId); else favIds.delete(currentNovelId);
    updateReaderFavBtn();
    if (r.favorited) likeBurst(document.getElementById('reader-fav-btn'));   // 同款發散火花
    toast(r.favorited ? '已加入收藏夾' : '已從收藏夾移除');
  } catch (e) { toast(e.message); }
}

// ── 許願池 / 回報問題 / 常見問題 (feedback) ────────────────────
const FB_LIMIT = { wish: { max: 140, perDay: 3 }, bug: { max: 600, perDay: 10 } };
const FB_STATUS = {
  wish: { open: '待回應', considering: '考慮中', done: '已實現', declined: '婉拒' },
  bug:  { open: '待處理', in_progress: '處理中', fixed: '已修復', declined: '婉拒' },
};
function isAdminUser() { return ['admin', 'super_admin'].includes(currentUser?.role); }

let wishFilter = 'all';   // 'open' | 'done' | 'all'
let _wishItems = [], _wishFocusId = null;
function openWishPool(focusId) {
  document.getElementById('wish-modal').classList.add('open');
  document.getElementById('wish-input').value=''; updateWishCount();
  _wishFocusId = (typeof focusId === 'string') ? focusId : null;
  // 從貓頭鷹通知點進來 → 用「全部」確保那則願望一定顯示並跳到它；否則維持預設。
  wishFilter = _wishFocusId ? 'all' : (isAdminUser() ? 'open' : 'all');
  loadFeedback('wish');
}
function setWishFilter(f) { wishFilter = f; renderWishFiltered(); }
function renderWishFiltered() {
  // tabs with live counts
  const c = { open: 0, done: 0, all: _wishItems.length };
  _wishItems.forEach(i => { if (i.status === 'done') c.done++; else if (i.status !== 'declined') c.open++; });
  const tabs = [['open', `待處理 ${c.open}`], ['done', `已實現 ${c.done}`], ['all', `全部 ${c.all}`]];
  document.getElementById('wish-tabs').innerHTML = tabs.map(([k, l]) =>
    `<button data-onclick="setWishFilter('${k}')" style="font-size:12px;padding:5px 12px;border-radius:14px;cursor:pointer;border:1px solid var(--gold-lt);background:${wishFilter === k ? 'var(--scarlet)' : 'none'};color:${wishFilter === k ? 'var(--on-dark)' : 'var(--ink-light)'}">${l}</button>`).join('');
  let items = _wishItems.slice();
  if (wishFilter === 'open') items = items.filter(i => i.status !== 'done' && i.status !== 'declined');
  else if (wishFilter === 'done') items = items.filter(i => i.status === 'done');
  else { const rank = s => s === 'done' ? 1 : s === 'declined' ? 2 : 0; items.sort((a, b) => rank(a.status) - rank(b.status)); }
  if (!items.length) {
    const msg = wishFilter === 'open' ? '沒有待處理的願望' : wishFilter === 'done' ? '還沒有實現的願望,加油' : '還沒有人許願,當第一個吧';
    document.getElementById('wish-list').innerHTML = `<p style="color:var(--ink-light);font-size:13px;text-align:center;padding:14px">${msg}</p>`;
    return;
  }
  renderFeedbackList('wish', items);
}
function openBugReport() { document.getElementById('bug-modal').classList.add('open'); document.getElementById('bug-input').value=''; updateBugCount(); loadFeedback('bug'); }
function updateWishCount() { document.getElementById('wish-count').textContent = `${document.getElementById('wish-input').value.length}/140`; }
function updateBugCount() { document.getElementById('bug-count').textContent = `${document.getElementById('bug-input').value.length}/600`; }

async function loadFeedback(kind) {
  const listEl = document.getElementById(kind + '-list');
  listEl.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';
  let items = [];
  try { items = await api(`/feedback/?kind=${kind}`) || []; }
  catch (e) { listEl.innerHTML = `<p style="color:var(--accent);font-size:13px">載入失敗：${escapeHtml(e.message || '')}</p>`; return; }
  // daily quota — counted on the viewer's OWN local calendar day (resets at their midnight).
  const localDay = ts => { const d = ts ? new Date(ts) : new Date(); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const today = localDay();
  const usedToday = items.filter(i => i.mine && localDay(i.created_at) === today).length;
  const left = Math.max(0, FB_LIMIT[kind].perDay - usedToday);
  const qEl = document.getElementById(kind + '-quota');
  if (qEl) {
    if (kind === 'wish') {
      const coins = Array(left).fill('<img src="./coin.svg" alt="許願幣" style="width:20px;height:20px;vertical-align:-4px;margin-right:2px">').join('');
      qEl.innerHTML = left > 0 ? coins : '<span style="color:var(--ink-light)">今天的許願已用完,午夜 12:00 重置</span>';
    } else {
      qEl.textContent = `今天還可回報 ${left} 次`;
    }
  }
  const sub = document.getElementById(kind + '-submit');
  if (sub) sub.disabled = left <= 0;
  if (kind === 'wish') { _wishItems = items; renderWishFiltered(); }
  else renderFeedbackList(kind, items);
}

function renderFeedbackList(kind, items) {
  const listEl = document.getElementById(kind + '-list');
  if (!items.length) { listEl.innerHTML = `<p style="color:var(--ink-light);font-size:13px;text-align:center;padding:14px">${kind === 'wish' ? '還沒有人許願,當第一個吧' : '目前沒有回報'}</p>`; return; }
  const admin = isAdminUser();
  // 作家獲得「許願池回覆權」後，也能回覆許願並標記「考慮中」（不能婉拒，且僅限許願）。
  const wishReplier = !admin && kind === 'wish' && currentUser?.role === 'writer' && !!currentUser?.wish_reply;
  const canReply = admin || wishReplier;
  listEl.innerHTML = items.map(it => {
    const label = (FB_STATUS[kind][it.status] || '');
    const badge = it.status && it.status !== 'open'
      ? `<span style="font-size:11px;padding:1px 8px;border-radius:9px;background:rgba(45,74,30,.15);color:var(--series)">${label}</span>` : '';
    // 多重回覆：完整串在 replies；沒有 replies 欄位的舊資料退回單則 admin_reply
    const _rs = (Array.isArray(it.replies) && it.replies.length) ? it.replies
      : ((it.admin_reply || '').trim() ? [{ t: it.admin_reply }] : []);
    const reply = _rs.map(r => `<div style="font-size:12px;color:var(--accent);margin-top:5px;padding-left:8px;border-left:2px solid var(--gold-lt)">${ic('ic-megaphone',12)} ${escapeHtml(r.t || '')}</div>`).join('');
    const _statusKeys = admin ? Object.keys(FB_STATUS[kind]) : (wishReplier ? ['considering'] : []);
    const statusBtns = _statusKeys.map(s =>
      `<button data-onclick="setFeedbackStatus('${it.id}','${kind}','${s}')" style="font-size:11px;padding:2px 7px;border:1px solid var(--gold-lt);background:${it.status===s?'var(--scarlet)':'none'};color:${it.status===s?'var(--on-dark)':'var(--ink-light)'};border-radius:10px;cursor:pointer">${FB_STATUS[kind][s].replace(/^[^\s]+\s/, '')}</button>`).join('');
    const adminRow = canReply ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;align-items:center">${statusBtns}<button data-onclick="replyFeedback('${it.id}','${kind}')" style="font-size:11px;padding:2px 8px;border:1px solid var(--gold);background:none;color:var(--ink-light);border-radius:10px;cursor:pointer">${ic('ic-megaphone',12)} 回覆</button></div>` : '';
    const del = (admin || it.mine) ? `<button data-onclick="deleteFeedbackItem('${it.id}','${kind}')" style="font-size:11px;background:none;border:none;color:var(--ink-light);cursor:pointer;flex-shrink:0">${ic('ic-trash',14)}</button>` : '';
    // Wishes are anonymous and dateless — show only a status badge (if any). Bug reports keep author + date.
    const metaInner = kind === 'wish'
      ? badge
      : `<span>${escapeHtml(it.author || '讀者')}</span><span>${fmtUpdated(it.created_at)}</span>${badge}`;
    const meta = metaInner ? `<div style="font-size:11px;color:var(--ink-light);margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${metaInner}</div>` : '';
    return `<div id="fb-item-${it.id}" style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08)">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div style="font-size:14px;color:var(--ink);line-height:1.5;white-space:pre-wrap;flex:1">${escapeHtml(it.content)}</div>${del}
      </div>${meta}${reply}${adminRow}
    </div>`;
  }).join('');
  // 從貓頭鷹通知跳轉：捲到那一則願望並短暫高亮。
  if (kind === 'wish' && _wishFocusId) {
    const target = _wishFocusId; _wishFocusId = null;
    requestAnimationFrame(() => {
      const el = document.getElementById('fb-item-' + target);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.add('fb-focus'); setTimeout(() => el.classList.remove('fb-focus'), 2400); }
    });
  }
}

async function submitFeedback(kind) {
  const inp = document.getElementById(kind + '-input');
  let content = (inp.value || '').trim();
  if (!content) { toast('請先輸入內容'); return; }
  if (kind === 'bug') content += `\n\n— ${navigator.userAgent} · ${APP_VERSION}`;   // auto device+version
  try {
    await api('/feedback/', { method: 'POST', body: JSON.stringify({ kind, content, tz_offset: new Date().getTimezoneOffset() }) });
    inp.value = ''; (kind === 'wish' ? updateWishCount : updateBugCount)();
    toast(kind === 'wish' ? '願望已送出' : '已送出回報,謝謝!');
    loadFeedback(kind);
  } catch (e) { toast('' + e.message); }
}

async function setFeedbackStatus(id, kind, status) {
  try { await api(`/feedback/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); loadFeedback(kind); }
  catch (e) { toast(e.message); }
}
let _replyCtx = null;
function replyFeedback(id, kind) {
  _replyCtx = { id, kind };
  const ta = document.getElementById('fb-reply-text');
  const cnt = document.getElementById('fb-reply-count');
  if (ta) {
    ta.value = '';
    if (cnt) cnt.textContent = '0';
    ta.oninput = () => { if (cnt) cnt.textContent = String(ta.value.length); };
  }
  document.getElementById('fb-reply-modal').classList.add('open');
  if (ta) setTimeout(() => ta.focus(), 50);
}
async function saveFeedbackReply() {
  if (!_replyCtx) return;
  const { id, kind } = _replyCtx;
  const ta = document.getElementById('fb-reply-text');
  const reply = ta ? ta.value.trim() : '';
  try {
    await api(`/feedback/${id}`, { method: 'PATCH', body: JSON.stringify({ admin_reply: reply || ' ' }) });
    document.getElementById('fb-reply-modal').classList.remove('open');
    _replyCtx = null;
    loadFeedback(kind);
  } catch (e) { toast(e.message); }
}
async function deleteFeedbackItem(id, kind) {
  if (!confirm('確定刪除?')) return;
  try { await api(`/feedback/${id}`, { method: 'DELETE' }); loadFeedback(kind); }
  catch (e) { toast(e.message); }
}

// ── FAQ ──
async function openFaq() { document.getElementById('faq-modal').classList.add('open'); loadFaqs(); }
async function loadFaqs() {
  const listEl = document.getElementById('faq-list');
  const addEl = document.getElementById('faq-admin-add');
  listEl.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';
  const admin = isAdminUser();
  addEl.style.display = admin ? '' : 'none';
  if (admin) addEl.innerHTML = `<button class="btn-primary" style="width:auto;padding:7px 14px;font-size:13px" data-onclick="addFaq()">＋ 新增問答</button>`;
  let faqs = [];
  try { faqs = await api('/feedback/faqs') || []; }
  catch (e) { listEl.innerHTML = `<p style="color:var(--accent);font-size:13px">載入失敗：${escapeHtml(e.message || '')}</p>`; return; }
  if (!faqs.length) { listEl.innerHTML = '<p style="color:var(--ink-light);font-size:13px;text-align:center;padding:14px">尚無常見問題</p>'; return; }
  listEl.innerHTML = faqs.map(f => `
    <details style="border-bottom:1px solid rgba(26,10,0,.08);padding:8px 0">
      <summary style="font-size:14px;font-weight:bold;color:var(--ink);cursor:pointer">${escapeHtml(f.question)}</summary>
      <div style="font-size:13px;color:var(--ink-light);line-height:1.7;margin-top:8px;white-space:pre-wrap">${escapeHtml(f.answer)}</div>
      ${admin ? `<div style="margin-top:6px;display:flex;gap:8px"><button data-onclick="editFaq('${f.id}')" style="font-size:11px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:10px;padding:2px 10px;cursor:pointer">編輯</button><button data-onclick="deleteFaq('${f.id}')" style="font-size:11px;background:none;border:none;color:var(--accent);cursor:pointer">${ic('ic-trash',12)} 刪除</button></div>` : ''}
    </details>`).join('');
}
let _faqEditId = null;   // null = 新增；否則為編輯中的 id
function _openFaqEditor(id, q, a) {
  _faqEditId = id || null;
  document.getElementById('faq-edit-title').innerHTML = `<svg width="18" height="18" aria-hidden="true" style="vertical-align:-3px"><use href="#ic-help"/></svg> ${id ? '編輯問答' : '新增問答'}`;
  document.getElementById('faq-edit-q').value = q || '';
  document.getElementById('faq-edit-a').value = a || '';
  document.getElementById('faq-edit-modal').classList.add('open');
  setTimeout(() => document.getElementById('faq-edit-q').focus(), 50);
}
function addFaq() { _openFaqEditor(null, '', ''); }
async function editFaq(id) {
  const faqs = await api('/feedback/faqs').catch(() => []);
  const f = (faqs || []).find(x => x.id === id) || {};
  _openFaqEditor(id, f.question || '', f.answer || '');
}
async function saveFaqEditor() {
  const q = document.getElementById('faq-edit-q').value.trim();
  const a = document.getElementById('faq-edit-a').value.trim();
  if (!q) { toast('請輸入問題'); return; }
  if (!a) { toast('請輸入答案'); return; }
  const btn = document.getElementById('faq-edit-save');
  btn.disabled = true;
  try {
    if (_faqEditId) await api(`/feedback/faqs/${_faqEditId}`, { method: 'PATCH', body: JSON.stringify({ question: q, answer: a }) });
    else await api('/feedback/faqs', { method: 'POST', body: JSON.stringify({ question: q, answer: a }) });
    document.getElementById('faq-edit-modal').classList.remove('open');
    loadFaqs();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}
async function deleteFaq(id) {
  if (!confirm('刪除這則問答?')) return;
  try { await api(`/feedback/faqs/${id}`, { method: 'DELETE' }); loadFaqs(); }
  catch (e) { toast(e.message); }
}
let adminNovelScope = null;   // null = manage my own works; {id,name} = managing another user's works (#3)
function resetAdminNovelScope(tab) {
  adminNovelScope = null;
  switchAdminTab(tab);
}

// Map character codes -> display names (e.g. ['sean'] -> 'Sean')
function charNames(codes) {
  return (codes || []).map(c => (CHAR_LIST.find(x => x.code === c) || {}).name || c).join('、');
}

// Site search: match a work/post by title, author, series, or character (name or code).
function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [
    item.title, item.author, item.series,
    charNames(item.characters), (item.characters || []).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// Filter by category, plus characters with OR semantics.
// All chips lit (default) or none lit = no character filtering (show everything);
// deselect chips to narrow down to works featuring ANY still-lit character.
let charAnd = false;   // false = 任一角色 (OR); true = 同框 (AND — every selected character must appear)
function applyClassFilter(list, cat, chars) {
  const sel = (chars || []).filter(Boolean);
  const noFilter = sel.length === 0 || (!charAnd && sel.length === CHAR_LIST.length);
  return list.filter(n => {
    if (cat && n.category !== cat) return false;
    if (!noFilter) {
      const have = n.characters || [];
      const checks = sel.map(c => have.includes(c));
      const ok = charAnd ? checks.every(Boolean) : checks.some(Boolean);
      if (!ok) return false;
    }
    return true;
  });
}
// 「同框」toggle — mounted on the 「角色」 label row in every filter bar.
function charAndBtnHtml() {
  return `<button type="button" class="char-and-btn${charAnd ? ' on' : ''}" data-onclick="toggleCharAnd()" title="開啟後只顯示所選角色「同時出現」的文，不看單人">`
    + `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg> 同框</button>`;
}
function mountCharAndBtn(id) { const e = document.getElementById(id); if (e) e.innerHTML = charAndBtnHtml(); }
function toggleCharAnd() {
  charAnd = !charAnd;
  if (document.getElementById('page-scroll').classList.contains('active')) renderShelf();
  else if (document.getElementById('page-forum').classList.contains('active')) {
    // 羊皮紙頁有兩個檢視：留影走廊模式重畫牆面，論壇模式重畫貼文列表
    if (forumTab === 'gallery') renderGallery();
    else renderForumList();
  }
  else if (document.getElementById('page-admin').classList.contains('active')) renderAdminNovels();
}

function renderFilterBar(catEl, chipEl, curCat, curChars, onChange) {
  catEl.innerHTML =
    CATEGORIES.map(c => `<button class="cat-pill ${curCat === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('')
    // beta：羊皮紙（論壇）併入意若思鏡，與故事類型並列；只有開了實驗功能的人看得到
    + (catEl.id === 'shelf-cat-pills' ? `<button class="cat-pill ${curCat === '羊皮紙' ? 'active' : ''}" data-c="羊皮紙">羊皮紙</button>` : '');
  catEl.querySelectorAll('.cat-pill').forEach(b => b.onclick = () => onChange('cat', b.dataset.c));
  chipEl.innerHTML = CHAR_LIST.map(ch =>
    `<div class="char-chip ${curChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}">
       <img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span>
     </div>`).join('');
  chipEl.querySelectorAll('.char-chip[data-ch]').forEach(el => el.onclick = () => officialCharTap(el.dataset.ch, onChange));
  mountCharAndBtn('shelf-char-and');
}

let _shelfForumLoaded = false, _shelfForumFavLoaded = false;
function renderShelfForum(grid, fav) {
  // 論壇資料尚未載入 → 先載一次（全部貼文用 kind=forum；收藏用 my-liked，與羊皮紙頁同一套）
  const err = () => { grid.innerHTML = '<p style="padding:40px 8px;color:var(--accent);text-align:center;cursor:pointer" data-onclick="renderShelf()">載入失敗，點此重試</p>'; };
  if (fav ? (!_shelfForumFavLoaded && !forumLiked.length) : (!_shelfForumLoaded && !forumPosts.length)) {
    grid.innerHTML = '<div class="spinner"></div>';
    if (fav) {
      _shelfForumFavLoaded = true;
      api('/novels/my-liked').then(d => { forumLiked = d || []; if (shelfCat === '羊皮紙' && shelfFav) renderShelf(); }).catch(err);
    } else {
      _shelfForumLoaded = true;
      api('/novels/?kind=forum').then(d => { forumPosts = d || []; if (shelfCat === '羊皮紙' && !shelfFav) renderShelf(); }).catch(err);
    }
    return;
  }
  const q = (document.getElementById('shelf-search-input')?.value || '').trim().toLowerCase();
  let posts = fav ? [...forumLiked] : [...forumPosts].sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
  posts = applyClassFilter(posts, '', shelfChars);   // 共用意若思鏡的角色篩選
  if (q) posts = posts.filter(p => matchesQuery(p, q));
  const empty = fav
    ? (q ? '找不到符合的貼文' : '你還沒收藏任何羊皮紙<br><small>在喜歡的留言點羽毛筆就會收進這裡</small>')
    : (q ? '找不到符合的貼文' : '目前還沒有論壇貼文');
  // 包一層 .forum-list：沿用羊皮紙頁的左右留白（novel-list 是 padding:0，直接放會貼邊）
  grid.innerHTML = `<div class="forum-list">${posts.length ? forumPostsHTML(posts)
    : `<p style="padding:40px 8px;color:#888;text-align:center">${empty}</p>`}</div>`;
}

function onShelfFilter(type, val) {
  if (type === 'cat') shelfCat = (shelfCat === val) ? '' : val;   // 再點同一顆 = 取消 = 全部顯示
  else shelfChars = shelfChars.includes(val) ? shelfChars.filter(c => c !== val) : [...shelfChars, val];
  renderShelf();
}

function openMqjDisclaimer() {
  const cb = document.getElementById('mqj-age-check');
  if (cb) cb.checked = false;
  const btn = document.getElementById('mqj-confirm-btn');
  if (btn) btn.disabled = true;
  const inner = document.querySelector('#mqj-disclaimer-modal .perm-modal-inner');
  if (inner) inner.scrollTop = 0;
  document.getElementById('mqj-disclaimer-modal').classList.add('open');
}

// Re-fetch the caller's profile to pick up a freshly-granted 迷情劑 approval without
// a re-login. If it flipped to approved, unlock the shelf live + toast.
let _mqjChecking = false;
async function refreshMqjStatus() {
  if (_mqjChecking || !currentUser) return;
  _mqjChecking = true;
  try {
    const me = await api('/auth/me');
    if (me && me.mqj_access !== currentUser.mqj_access) {
      const becameApproved = me.mqj_access === 'approved';
      currentUser.mqj_access = me.mqj_access;
      if (becameApproved) { toast('你的迷情劑權限已開放'); loadNovels(); }
      else renderShelf();
    }
  } catch (e) { /* ignore */ }
  finally { _mqjChecking = false; }
}

async function requestMqj() {
  document.getElementById('mqj-disclaimer-modal').classList.remove('open');
  try {
    const res = await api('/permissions/me/request-mqj', { method: 'POST' });
    currentUser.mqj_access = res.mqj_access;
    toast(res.mqj_access === 'approved' ? '你已可閱讀迷情劑' : '已送出申請，等管理員開放');
    renderShelf();
  } catch (e) { toast(e.message); }
}

// Shared 迷情劑 access-gate body — used by the 迷情 shelf tab AND the in-reader 上下篇 gate.
// Rejected users KEEP the right to re-apply; we never strip their button.
function mqjGateBody() {
  const a = currentUser?.mqj_access;
  const eIc = (id) => `<span style="display:block;margin-bottom:8px">${ic(id, 30)}</span>`;
  const applyBtn = (label) => `<button class="btn-primary" style="width:auto;padding:8px 20px;font-size:13px" data-onclick="openMqjDisclaimer()">${ic('ic-send', 14)} ${label}</button>`;
  if (a === 'pending')
    return `${eIc('ic-clock')}你已申請開放「迷情劑」<br><small>請至微信群私訊《預言家日報》客服完成年齡驗證<br>驗證通過後，管理員才會開放</small>`;
  if (a === 'rejected') {
    // 被拒後 7 天冷卻：期間不給按鈕，只留說明；期滿恢復再次申請
    const ra = currentUser?.mqj_rejected_at ? new Date(currentUser.mqj_rejected_at) : null;
    const left = ra ? 7 - Math.floor((Date.now() - ra.getTime()) / 86400000) : 0;
    if (left > 0)
      return `${eIc('ic-ban')}你的「迷情劑」閱讀申請未通過<br><small>通常是尚未完成年齡驗證——請先至微信群私訊客服驗證<br>${left} 天後可再次提出申請</small>`;
    return `${eIc('ic-ban')}你的「迷情劑」閱讀申請未通過<br><small style="display:block;margin-bottom:14px">請先至微信群私訊客服完成年齡驗證，再提出申請</small>${applyBtn('再次申請')}`;
  }
  return `${eIc('ic-key')}「迷情劑」分類需開放才能閱讀<br><small style="display:block;margin-bottom:14px">點下方按鈕申請，並至微信群私訊客服完成年齡驗證</small>${applyBtn('要求管理員開放')}`;
}

// 自創角色（custom character）功能與實驗開關（isBeta/setBetaFlag/?beta/pd_beta）已於 2026-07-13 全數下架。

// 後台上傳：讀一個 .txt 進內文框(取代原本暫不支持的圖片辨識）
function loadTxtIntoUpload(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    document.getElementById('new-novel-content').value = r.result || '';
    const t = document.getElementById('new-novel-title');
    if (t && !t.value.trim()) t.value = f.name.replace(/\.txt$/i, '');
  };
  r.readAsText(f);
  input.value = '';
}


function renderShelf() {
  renderFilterBar(
    document.getElementById('shelf-cat-pills'), document.getElementById('shelf-char-chips'),
    shelfCat, shelfChars, onShelfFilter);
  const grid = document.getElementById('novel-grid');
  // beta：選到「羊皮紙」類型 → 下方書架改渲染論壇貼文（收藏檢視留給階段 1b）
  if (shelfCat === '羊皮紙') { renderShelfForum(grid, shelfFav); return; }
  if (novelsError && !novels.length) {
    grid.innerHTML = '<div class="empty-shelf" style="color:var(--accent);cursor:pointer" data-onclick="loadNovels()">載入失敗，點此重試</div>';
    return;
  }
  // 收藏夾 view: only favorited works (skip the 迷情劑 gate — favorites are already accessible).
  if (shelfFav) {
    let list = applyClassFilter(novels.filter(n => favIds.has(n.id)), shelfCat === '迷情劑' ? '' : shelfCat, shelfChars);
    const q = (document.getElementById('shelf-search-input')?.value || '').trim().toLowerCase();
    if (q) list = list.filter(n => matchesQuery(n, q));
    renderNovelBlocks(list, grid, '收藏夾還是空的<br><small>讀小說時，點右上角的 ☆ 就能收藏整篇</small>');
    return;
  }
  // 迷情劑 gate for readers without access.
  if (shelfCat === '迷情劑' && ['reader', 'writer'].includes(currentUser?.role) && currentUser?.mqj_access !== 'approved') {
    refreshMqjStatus();   // live re-check: if an admin just approved, unlock without re-login
    grid.innerHTML = `<div class="empty-shelf">${mqjGateBody()}</div>`;
    return;
  }
  if (!novels.length) {
    grid.innerHTML = `<div class="empty-shelf"><span style="display:block;margin-bottom:8px">${ic('ic-books', 30)}</span>目前沒有作品<br><small>等管理員上傳作品</small></div>`;
    return;
  }
  let list = applyClassFilter(novels, shelfCat, shelfChars);
  const q = (document.getElementById('shelf-search-input')?.value || '').trim().toLowerCase();
  if (q) list = list.filter(n => matchesQuery(n, q));
  // Only on the plain default view (no search, 全部, no character filter), float the 24h hot
  // works to the front — silently, no label.
  const noCharFilter = (shelfChars.length === 0 || shelfChars.length === CHAR_LIST.length);
  if (!q && shelfCat === '' && noCharFilter && hotIds.length) {
    const hot = hotIds.map(id => list.find(n => n.id === id)).filter(Boolean);
    if (hot.length) {
      const hotSet = new Set(hot.map(n => n.id));
      list = [...hot, ...list.filter(n => !hotSet.has(n.id))];
    }
  }
  renderNovelBlocks(list, grid, `<span style="display:block;margin-bottom:8px">${ic('ic-mirror', 30)}</span>沒有符合的作品`);
}

// 系列展開狀態（默認全收合）。點系列標題切換，不重繪整個書架——只翻該區塊的 class，保住捲動位置。
let _expandedSeries = new Set();
function toggleSeries(headEl) {
  const block = headEl.closest('.series-block');
  if (!block) return;
  const name = block.dataset.series || '';
  const nowExpanded = block.classList.toggle('expanded');
  if (nowExpanded) _expandedSeries.add(name); else _expandedSeries.delete(name);
  headEl.setAttribute('aria-expanded', nowExpanded);
}

// 書名號剝除：只在「整個字串正好被一對外層《》包住、且中間沒有其他書名號」時剝掉外層那對。
// 《枕边夜话》→ 枕边夜话；重讀《小王子》的午後 → 原樣；《A》與《B》→ 原樣。
// 《》是系列的專屬訊號（顯示層自動加），單篇標題預設剝掉、系列名存檔前剝乾淨，避免《《》》。
function stripOuterBookQuotes(title) {
  const t = String(title || '').trim();
  if (t.length >= 2 && t.startsWith('《') && t.endsWith('》')) {
    const inner = t.slice(1, -1);
    if (inner && !inner.includes('《') && !inner.includes('》')) return inner;   // inner 非空才剝，避免《》變空標題
  }
  return t;
}

// Render a list of novels into the grid, grouping series members under a header.
function renderNovelBlocks(list, grid, emptyMsg) {
  if (!list.length) { grid.innerHTML = `<div class="empty-shelf">${emptyMsg}</div>`; return; }
  const seen = new Set();
  const blocks = [];
  for (const n of list) {
    if (seen.has(n.id)) continue;
    if (n.series) {
      const members = list.filter(m => m.series === n.series).sort((a, b) => (a.series_order || 0) - (b.series_order || 0));
      members.forEach(m => seen.add(m.id));
      // 收合的系列列＝與單篇同款卡片，只靠三個訊號區分：《》書名號、副標「系列合集 · 共 N 篇」、列尾 chevron。
      // 標籤列＝成員的 類型＋角色 去重彙整（類型前、角色後，保持首次出現順序）。
      const expanded = _expandedSeries.has(n.series);
      const cats = [], chars = [], authorCount = new Map();
      members.forEach(m => {
        if (m.category && !cats.includes(m.category)) cats.push(m.category);
        (m.characters || []).forEach(c => { if (!chars.includes(c)) chars.push(c); });
        const a = m.author || '佚名'; authorCount.set(a, (authorCount.get(a) || 0) + 1);   // 依「篇數」統計署名
      });
      const tags = cats.map(c => `<span class="t-cat${catCls(c)}">${escapeHtml(c)}</span>`).join('')
        + chars.map(c => charPill(c)).join('');
      // 系列作者：一般同一人。取成員署名中「最多篇用的那個」（Map 保插入序，平手取序號最小的那篇），
      // 避免個別篇署名打錯字（例：利/莉）被誤湊成「共同作者」。日期 = 系列最新更新那篇的日期。
      let author = '佚名', _best = -1;
      for (const [a, c] of authorCount) { if (c > _best) { _best = c; author = a; } }
      const newest = members.reduce((x, m) => (!x || new Date(m.created_at || 0) > new Date(x.created_at || 0)) ? m : x, null);
      const meta = `${escapeHtml(author)}${ownerTag(newest)}${newest && newest.created_at ? ` · ${ic('ic-calendar',11)} ${fmtUpdated(newest.created_at)}` : ''}`;
      blocks.push(`
        <div class="series-block${expanded ? ' expanded' : ''}" data-series="${escapeHtml(n.series)}">
          <div class="novel-row series-head" data-onclick="toggleSeries(this)" role="button" aria-expanded="${expanded}">
            <div class="series-title-line">
              <h4>《${escapeHtml(stripOuterBookQuotes(n.series))}》</h4>
              <span class="series-sub">系列合集 · 共 ${members.length} 篇 <span class="series-chev" aria-hidden="true"></span></span>
            </div>
            <div class="row-meta">${meta}</div>
            <div class="row-tags">${tags}</div>
          </div>
          <div class="series-members">${members.map(m => shelfRow(m, true)).join('')}</div>
        </div>`);
    } else {
      seen.add(n.id);
      blocks.push(shelfRow(n, false));
    }
  }
  grid.innerHTML = blocks.join('');
}

function shelfRow(n, inSeries) {
  return `
    <div class="novel-row${inSeries ? ' series-member' : ''}" data-onclick="openNovel('${n.id}')">
      <h4>${inSeries && n.series_order ? `<span style="color:var(--ink-light);font-weight:normal">#${n.series_order}　</span>` : ''}${escapeHtml(stripOuterBookQuotes(n.title))}</h4>
      <div class="row-meta">${escapeHtml(n.author || '佚名')}${ownerTag(n)}${n.created_at ? ` · ${ic('ic-calendar',11)} ${fmtUpdated(n.created_at)}` : ''}</div>
      <div class="row-tags">
        ${n.category ? `<span class="t-cat${catCls(n.category)}">${escapeHtml(n.category)}</span>` : ''}
        ${(n.characters || []).map(c => charPill(c)).join('')}
      </div>
    </div>`;
}

// ── Reader ───────────────────────────────────────────────────
let _artSeq = 0;   // 文首插圖探測序號（防切章後舊回呼誤插）
let currentNovelKind = 'novel';
let currentNovelTitle = '';
let currentNovelHeader = null;   // 目前作品的頁首圖 URL（image_url）；閱讀器優先用它，沒有才退回 artwork/<id>.jpg
let currentNovelByline = null;   // 授權畫作雙署名 {text:作者, art:畫師}；頁首圖非授權畫作時為 null

// Stable, obscure per-account watermark code (first 8 hex of the UUID). Nicknames can be
// changed by the user, so they can't be used for attribution; the UUID can't. An admin maps
// a leaked code back to a user via 用戶管理 → 水印碼.
function wmCode(id) { return ((id || '').replace(/-/g, '').slice(0, 8).toUpperCase()) || '訪客'; }
let _mqjActive = false;
// 迷情劑 guard: tile a dense per-reader watermark (account code + date) over the reader so any
// leaked screenshot is traceable, and block casual copy/select/save. (Cannot stop screenshots
// — no web API allows that; this is a deterrent + attribution.)
function applyMqjGuard(on) {
  const ov = document.querySelector('#reader-view .watermark-overlay');
  const content = document.getElementById('reader-content');
  if (!ov || !content) return;
  if (on) {
    const code = wmCode(currentUser && currentUser.id);
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dark = document.documentElement.classList.contains('dark');
    // Spaced tiling: a larger tile so the FULL code+date fits inside each stamp (no clipping) and
    // the watermark is woven less densely through the prose. Soft opacity keeps reading comfortable.
    const color = dark ? 'rgba(242,227,184,0.26)' : 'rgba(138,45,45,0.22)';
    const text = code + ' ' + stamp;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='210' height='100'><text x='105' y='54' text-anchor='middle' transform='rotate(-24 105 50)' fill='${color}' font-size='14' font-weight='bold' font-family='sans-serif'>${escapeHtml(text)}</text></svg>`;
    ov.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
    ov.style.backgroundRepeat = 'repeat';
    content.classList.add('noselect');
    content.oncontextmenu = (e) => e.preventDefault();
    _mqjActive = true;
  } else {
    ov.style.backgroundImage = '';
    ov.style.backgroundRepeat = '';
    content.classList.remove('noselect');
    content.oncontextmenu = null;
    _mqjActive = false;
  }
}

async function openNovel(novelId) {
  currentNovelId = novelId;
  let novel = [...forumPosts, ...novels].find(n => n.id === novelId);
  if (!novel) { try { novel = await api(`/novels/${novelId}`); } catch {} }
  markSeriesSeenForWork(novel);   // opening a new series installment clears its 追蹤更新 flag
  currentNovelKind = (novel && novel.kind) || 'novel';
  currentNovelTitle = (novel && novel.title) || '';
  currentNovelHeader = (novel && novel.kind === 'novel' && novel.image_url) || null;   // 頁首圖（僅小說）
  // 雙署名：文首圖來自授權畫作時（image_caption＝畫師署名），標題圖下顯示「文／X　圖／Y」
  currentNovelByline = (currentNovelHeader && novel.image_caption)
    ? { text: novel.author || '佚名', art: novel.image_caption } : null;
  // 授權信：篇末「想為這篇作畫」入口（writer 以上、非本篇作者、已發佈的小說）。先算好目標但「不顯示」，
  // 等內容載入完成才浮現，否則會在 spinner 還在轉時就飄在讀取畫面上（同 reader-series-nav 的處理）。
  { const aw = document.getElementById('reader-auth-wrap'); if (aw) aw.style.display = 'none';
    const canAsk = _isWriterPlus() && novel && novel.kind === 'novel'
      && novel.status === 'approved' && !(novel.owners || []).includes(currentUser.id);
    window._readerAuthTarget = canAsk ? { id: novel.id, title: novel.title, author: novel.author || '佚名' } : null; }
  applyMqjGuard(true);   // personalized watermark + copy guard on EVERY work now (was 迷情劑-only)
  updateReaderFavBtn();   // show ☆/★ for 意若思鏡 works
  updateReaderDarkBtn();  // /reflects current 夜間模式
  try { currentChapters = await api(`/chapters/novel/${novelId}`) || []; }
  catch { toast('無法載入內容'); return; }
  if (!currentChapters.length) { toast('此作品尚無內容'); return; }
  currentChapterIdx = 0;
  // Single-piece reads (forum posts, or novels with only one chapter): hide chapter chrome.
  const single = currentNovelKind === 'forum' || currentChapters.length <= 1;
  document.getElementById('reader-chapter-nav').style.display = single ? 'none' : '';
  document.getElementById('reader-toc-panel').style.display = single ? 'none' : '';
  renderToc();
  document.getElementById('reader-series-nav').style.display = 'none';   // hide until content loads (don't float over the spinner)
  document.getElementById('reader-view').classList.add('open');
  loadChapter(0).then(() => {
    updateSeriesNav(novel);                                     // 上一篇/下一篇 only after the content is in
    const aw = document.getElementById('reader-auth-wrap');     // 篇末「想為這篇作畫」也等內容進來才浮現
    if (aw) aw.style.display = window._readerAuthTarget ? '' : 'none';
    api(`/novels/${novelId}/view`, { method: 'POST' }).catch(() => {});   // 記 view 移到首屏顯示後，不跟章節請求搶連線
  });
}

// ── 系列(上下集)導覽 ─────────────────────────────────────────
let _seriesSibs = [], _seriesIdx = -1;
async function updateSeriesNav(novel) {
  const nav = document.getElementById('reader-series-nav');
  _seriesSibs = []; _seriesIdx = -1;
  // Only for 小說 that belong to a series. The server returns the FULL part list — including 迷情劑
  // parts the reader can't open yet (as locked stubs) — so 上下篇 surfaces an access gate for them
  // instead of silently skipping. Fall back to the visible shelf list if the call fails.
  if (novel && novel.series && novel.kind !== 'forum' && novel.kind !== 'image') {
    let sibs = null;
    try { sibs = await api(`/novels/${novel.id}/siblings`); } catch {}
    if (sibs && sibs.length > 1) {
      _seriesSibs = sibs;
    } else {
      _seriesSibs = novels.filter(n => n.series === novel.series)
        .sort((a, b) => (a.series_order || 0) - (b.series_order || 0) || new Date(a.created_at) - new Date(b.created_at));
    }
    _seriesIdx = _seriesSibs.findIndex(n => n.id === novel.id);
  }
  if (_seriesIdx >= 0 && _seriesSibs.length > 1) {
    document.getElementById('prev-series-btn').disabled = !_seriesSibs[_seriesIdx - 1];
    document.getElementById('next-series-btn').disabled = !_seriesSibs[_seriesIdx + 1];
    document.getElementById('reader-series-label').textContent = `${_seriesIdx + 1} / ${_seriesSibs.length}`;
    nav.style.display = '';
  } else {
    nav.style.display = 'none';
  }
}
function navigateSeries(delta) {
  const target = _seriesSibs[_seriesIdx + delta];
  if (!target) return;
  if (target.locked) showMqjGateInReader(target);     // 迷情劑 with no access → gate page, nav stays
  else openNovel(target.id);                          // openNovel→loadChapter resets the reader scroll to top
}

// 上下篇 landed on a 迷情劑 part the reader can't open: show an in-reader access gate (no title,
// no content, no ☆) but KEEP 上一篇/下一篇 so they can still move to the other parts.
function showMqjGateInReader(target) {
  currentNovelId = target.id;
  currentChapters = [];
  applyMqjGuard(false);          // nothing protected to read here
  refreshMqjStatus();            // re-check in case an admin just approved
  document.getElementById('reader-title').textContent = '迷情劑內容';
  document.getElementById('reader-fav-btn').style.display = 'none';   // no favouriting without read access
  document.getElementById('reader-chapter-nav').style.display = 'none';
  document.getElementById('reader-toc-panel').style.display = 'none';
  const content = document.getElementById('reader-content');
  content.style.display = 'flex'; content.style.flexDirection = 'column'; content.style.justifyContent = 'center';
  content.innerHTML = `<div class="empty-shelf">${mqjGateBody()}</div>`;
  document.getElementById('reader-view').scrollTo(0, 0);
  // point the series nav at this locked part so 上一篇/下一篇 keep working
  _seriesIdx = _seriesSibs.findIndex(n => n.id === target.id);
  document.getElementById('prev-series-btn').disabled = !_seriesSibs[_seriesIdx - 1];
  document.getElementById('next-series-btn').disabled = !_seriesSibs[_seriesIdx + 1];
  document.getElementById('reader-series-label').textContent = `${_seriesIdx + 1} / ${_seriesSibs.length}`;
  document.getElementById('reader-series-nav').style.display = '';
  document.getElementById('reader-view').classList.add('open');
}

// Parse a forum-體 post into the original post (intro) + the running comments.
// Feather-pen like icon. Colored fills carry their real colour as a `fill=` attribute
// (lower priority than CSS), so .fp-like:not(.liked) can override them to a grey line-art.
const PEN_SVG = `<svg class="pen" viewBox="0 0 434.317 434.317" aria-hidden="true">
<path class="pf" fill="#E6B263" d="M402.039,384.767c2.22,0,3.97,1.92,3.74,4.13c-2.07,19.9-18.89,35.42-39.33,35.42H68.069c18.03,0,33.23-12.05,38.01-28.54c1.87-6.46,7.62-11.01,14.35-11.01h206.45H402.039z"/>
<path class="pf" fill="#FF7124" d="M403.079,20.787l-0.03,0.07c-77.04-14.81-173.77,47.27-229.91,153.36c-17.65,33.34-29.46,67.55-35.61,100.51c-0.01,0.1-0.03,0.19-0.05,0.28c-0.02-0.08-0.04-0.16-0.06-0.23c-4.66-16.26-7.38-33.36-7.91-51.03c-1.88-62.57,24.14-119.51,66.81-158.84c35.44-32.69,82.37-53.25,134.35-54.81C355.999,9.337,380.389,13.147,403.079,20.787z"/>
<path class="pf" fill="#8ECAC1" d="M403.049,20.857c-12.35,24.13-26.82,48.18-43.39,71.72c-10.49,14.9-21.44,29.08-32.78,42.48c-17.43,20.64-35.74,39.46-54.58,56.32l-58.27-6.33l15.29,40.75c-30.46,21.68-61.53,38.2-91.79,48.93c6.15-32.96,17.96-67.17,35.61-100.51C229.279,68.127,326.009,6.047,403.049,20.857z"/>
<path class="pf" fill="#F2D59F" d="M326.879,135.057v249.71h-206.45c-6.73,0-12.48,4.55-14.35,11.01c-4.78,16.49-19.98,28.54-38.01,28.54c-21.84,0-39.55-17.71-39.55-39.55V79.907c0-8.28,6.72-15,15-15h151.32h1.48c-42.67,39.33-68.69,96.27-66.81,158.84c0.53,17.67,3.25,34.77,7.91,51.03c0.02,0.07,0.04,0.15,0.06,0.23c0.02-0.09,0.04-0.18,0.05-0.28c30.26-10.73,61.33-27.25,91.79-48.93l-15.29-40.75l58.27,6.33C291.139,174.517,309.449,155.697,326.879,135.057z M132.609,336.287l4.87-61.27C133.559,296.147,131.949,316.747,132.609,336.287z"/>
<path class="pf" fill="#FFFFFF" d="M137.479,275.017l-4.87,61.27C131.949,316.747,133.559,296.147,137.479,275.017z"/>
<path class="pl" fill="#5E2A41" d="M68.069,434.317c-27.322,0-49.55-22.229-49.55-49.551c0-5.522,4.477-10,10-10c5.522,0,10,4.478,10,10c0,16.294,13.256,29.551,29.55,29.551c5.522,0,10,4.478,10,10C78.069,429.84,73.591,434.317,68.069,434.317z"/>
<path class="pl" fill="#5E2A41" d="M366.449,434.317H68.069c-5.523,0-10-4.478-10-10c0-5.522,4.478-10,10-10c13.085,0,24.766-8.769,28.405-21.324c3.155-10.9,12.782-18.227,23.954-18.227h281.61c3.891,0,7.617,1.658,10.225,4.55c2.601,2.885,3.863,6.754,3.462,10.613C413.092,415.235,391.909,434.317,366.449,434.317z M107.82,414.317h258.629c12.76,0,23.719-8.033,27.822-19.551H120.428c-2.181,0-4.088,1.523-4.744,3.792C114.005,404.351,111.307,409.66,107.82,414.317z"/>
<path class="pl" fill="#5E2A41" d="M326.878,394.767c-5.522,0-10-4.478-10-10v-249.71c0-5.522,4.478-10,10-10c5.522,0,10,4.478,10,10v249.71C336.878,390.289,332.401,394.767,326.878,394.767z"/>
<path class="pl" fill="#5E2A41" d="M28.519,394.767c-5.523,0-10-4.478-10-10V79.907c0-13.785,11.215-25,25-25h152.8c5.522,0,10,4.478,10,10c0,5.522-4.478,10-10,10h-152.8c-2.757,0-5,2.243-5,5v304.859C38.519,390.289,34.042,394.767,28.519,394.767z"/>
<path class="pl" fill="#5E2A41" d="M137.479,284.997c-4.559,0-8.553-3.078-9.688-7.51h0.001c-4.957-17.337-7.735-35.289-8.279-53.44c-1.895-63.042,23.63-123.726,70.028-166.492c38.46-35.477,88.474-55.882,140.827-57.453c25.885-0.783,51.341,2.968,75.672,11.131c4.078,1.263,7.043,5.063,7.043,9.555c0,5.522-4.473,10-9.995,10c-1.085,0-2.173-0.177-3.201-0.523c-22.143-7.457-45.334-10.879-68.919-10.173c-47.536,1.428-92.948,19.953-127.869,52.166c-42.137,38.838-65.315,93.943-63.596,151.188c0.482,16.018,2.872,31.855,7.111,47.1c0.718,1.556,1.045,3.317,0.867,5.147c-0.059,0.604-0.153,1.079-0.229,1.426c-0.988,4.528-4.959,7.794-9.593,7.877C137.6,284.997,137.539,284.997,137.479,284.997z"/>
<path class="pl" fill="#5E2A41" d="M132.603,346.287c-5.367,0-9.806-4.258-9.988-9.662c-0.688-20.38,1.004-41.722,5.032-63.433c1.007-5.431,6.223-9.015,11.656-8.008c5.43,1.007,9.016,6.226,8.008,11.656c-3.764,20.288-5.348,40.175-4.708,59.108c0.187,5.52-4.137,10.145-9.656,10.332C132.832,346.285,132.716,346.287,132.603,346.287z"/>
<path class="pl" fill="#5E2A41" d="M137.53,284.727c-2.347,0-4.659-0.826-6.498-2.398c-2.719-2.323-3.989-5.921-3.333-9.436c6.541-35.06,18.855-69.833,36.603-103.354c27.697-52.341,66.923-96.978,110.449-125.687c43.788-28.882,90.025-40.534,130.186-32.815c3.09,0.594,5.72,2.607,7.1,5.436c1.38,2.827,1.348,6.14-0.085,8.94c-12.754,24.921-27.597,49.455-44.115,72.921c-10.583,15.031-21.794,29.561-33.323,43.184c-17.441,20.653-36.132,39.939-55.545,57.313c-2.112,1.89-4.922,2.796-7.749,2.489l-42.12-4.575l9.583,25.541c1.593,4.245,0.131,9.03-3.564,11.66c-31.192,22.2-62.901,39.093-94.247,50.207C139.781,284.538,138.652,284.727,137.53,284.727z M379.569,28.661c-69.636,0-149.658,59.652-197.591,150.232c-13.767,26.003-24.072,52.763-30.741,79.771c21.947-9.297,44.056-21.563,65.994-36.619l-12.564-33.486c-1.22-3.25-0.666-6.901,1.463-9.644c2.127-2.743,5.522-4.182,8.979-3.811l53.815,5.846c17.544-15.974,34.455-33.566,50.314-52.347c11.155-13.181,22.002-27.236,32.244-41.784c13.182-18.726,25.257-38.149,36.002-57.897C384.862,28.747,382.223,28.661,379.569,28.661z"/>
</svg>`;

function renderForumContent(content) {
  // Normalise line separators — pasted text often uses U+2028/U+2029 (or \r), which break
  // line-based parsing (the regexes' `.`/`$` don't cross them) and hide the floor markers.
  let norm = (content || '').replace(/[\u2028\u2029\r]/g, '\n');
  // The app appends its own 封存 box, so auto-strip a self-written ending — but only on a
  // specific marker (羊皮纸自动折叠提示 / 羊皮紙自動折疊提示) to avoid cutting normal content.
  const fold = norm.search(/羊皮[纸紙]自[动動]折[叠疊]提示/);
  if (fold >= 0) norm = norm.slice(0, norm.lastIndexOf('\n', fold) + 1).replace(/\n+$/, '');
  const lines = norm.split('\n');
  // A new floor (樓層) starts on any of these; text before the first one is the 主文/引言:
  //   第N笔｜暱稱                         (oldest format)
  //   1L / 01L / 2L … [暱稱｜內容]          (floor-number format)
  //   --- / *** separator → next non-blank line (often **暱稱｜標題**) heads the floor
  const BIJI = /^第\s*\d+\s*笔\s*[｜|]\s*(.+)$/;
  const FLOOR = /^0?\d{1,3}\s*[Ll](?![A-Za-z])\s*(.*)$/;
  const SEP = /^[-—–_*]{3,}$/;
  const BOLD = /^\*\*(.+?)\*\*$/;
  const stripMd = s => (s || '').replace(/\*\*/g, '').trim();
  // split "暱稱｜內容" → {name, first}
  const splitHead = s => { const i = s.search(/[｜|]/); return i >= 0 ? { name: s.slice(0, i).trim(), first: s.slice(i + 1).trim() } : { name: s.trim(), first: '' }; };
  const intro = [];
  const comments = [];
  let cur = null, sep = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (SEP.test(t)) { sep = true; continue; }
    const mb = t.match(BIJI);
    if (mb) { cur = { name: stripMd(mb[1]), body: [] }; comments.push(cur); sep = false; continue; }
    const mf = t.match(FLOOR);
    if (mf) {
      const rest = mf[1];
      let h;
      if (/^\s*[｜|]/.test(rest)) {
        // "001L｜身份｜組別…" → the whole identity (after the leading ｜) is the 暱稱
        h = { name: rest.replace(/^\s*[｜|]\s*/, '').trim(), first: '' };
      } else {
        // "1L 暱稱｜內容" → split 暱稱 from inline 內容
        h = splitHead(rest.trim());
      }
      cur = { name: stripMd(h.name), body: h.first ? [stripMd(h.first)] : [] };
      comments.push(cur); sep = false; continue;
    }
    if (sep) {
      if (t === '') continue;          // skip blank lines between separator and the floor header
      const bold = t.match(BOLD);
      const h = splitHead(bold ? bold[1].trim() : t);
      cur = { name: stripMd(h.name), body: h.first ? [stripMd(h.first)] : [] };
      comments.push(cur); sep = false; continue;
    }
    if (cur) cur.body.push(stripMd(raw)); else intro.push(stripMd(raw));
  }
  const introHtml = intro.filter(l => l.trim()).map(l => `<p>${escapeHtml(l)}</p>`).join('');
  const commentsHtml = comments.map((c, i) => {
    const liked = (forumLikes.mine || []).includes(i);
    const count = (forumLikes.counts || {})[i] || 0;
    return `
    <div class="fp-comment">
      <div class="fp-name-row">
        <div class="fp-name"><span class="fp-floor">${String(i + 1).padStart(2, '0')}L</span>${escapeHtml(c.name)}</div>
      </div>
      <div class="fp-bottom">
        <div class="fp-body">${c.body.filter(l => l.trim()).map(l => `<p>${escapeHtml(l)}</p>`).join('')}</div>
        <button id="like-${i}" class="fp-like${liked ? ' liked' : ''}" data-onclick="event.stopPropagation();toggleLike(${i})" aria-label="收藏這則留言">
          <svg class="star" width="22" height="22" aria-hidden="true"><use href="#ic-star${liked ? 'fill' : 'line'}"/></svg><span class="cnt">${count || ''}</span>
        </button>
      </div>
    </div>`;
  }).join('');
  const endBox = `
    <div class="fp-end">
      <div class="fp-end-title">本羊皮紙已自動封存</div>
      <p>如需繼續傳閱，請滴一滴墨水。</p>
      <p>如被級長發現，請說這是魔法史筆記。</p>
    </div>`;
  return (introHtml ? `<div class="fp-intro">${introHtml}</div>` : '') +
    (comments.length ? `<div class="fp-divider">✦ ✦ ✦</div>${commentsHtml}` : '') +
    endBox;
}

function renderToc() {
  document.getElementById('reader-toc').innerHTML = currentChapters.map((c, i) =>
    `<li class="${i === currentChapterIdx ? 'current' : ''}" data-onclick="loadChapter(${i});document.querySelector('#reader-view details').removeAttribute('open')">${escapeHtml(String(c.chapter_num))}. ${escapeHtml(c.title || '章節 ' + c.chapter_num)}</li>`
  ).join('');
}

async function loadChapter(idx) {
  currentChapterIdx = idx;
  const ch = currentChapters[idx];
  // Single-piece (forum or 1-chapter novel) → just the work title; multi-chapter → the chapter title.
  document.getElementById('reader-title').textContent = (currentNovelKind === 'forum' || currentChapters.length <= 1)
    ? (currentNovelTitle || ch.title || '貼文')
    : (ch.title || `第 ${ch.chapter_num} 章`);
  document.getElementById('reader-ch-label').textContent = `${idx + 1} / ${currentChapters.length}`;
  const _rc = document.getElementById('reader-content');
  _rc.style.display = ''; _rc.style.justifyContent = '';   // clear 迷情 gate centering if it was active
  _rc.innerHTML = '<div class="spinner"></div>';
  document.getElementById('prev-ch-btn').disabled = idx === 0;
  document.getElementById('next-ch-btn').disabled = idx === currentChapters.length - 1;
  renderToc();
  try {
    const full = await api(`/chapters/${ch.id}`);
    const el = document.getElementById('reader-content');
    if (currentNovelKind === 'forum') {
      try { forumLikes = await api(`/novels/${currentNovelId}/likes`) || { counts: {}, mine: [] }; }
      catch { forumLikes = { counts: {}, mine: [] }; }
      el.style.whiteSpace = '';
      el.innerHTML = renderForumContent(full.content);
    } else {
      // Render exactly as the author typed it — preserve blank lines & spacing (WYSIWYG with the editor).
      el.style.whiteSpace = 'pre-wrap';
      el.textContent = full.content;
    }
    // 羊皮紙貼文沒有 sticky 上下篇導覽，不需 100px 底部留白（否則封存框下方一大片空）→ 收小
    el.classList.toggle('rc-forum', currentNovelKind === 'forum');
  } catch { document.getElementById('reader-content').textContent = '載入失敗'; }
  // 文首插圖：優先用上傳的頁首圖（image_url）；沒有才退回舊約定 artwork/<作品id>.jpg
  // （管理員手放 repo、走 Pages/鏡像＋SW 快取）。只在第一章文首顯示；載入失敗＝靜靜略過。
  if (idx === 0) {
    const artSrc = currentNovelHeader || `./artwork/${currentNovelId}.jpg`;
    const artSeq = ++_artSeq, artNid = currentNovelId;
    const artIm = new Image();
    artIm.onload = () => {
      if (artSeq !== _artSeq || artNid !== currentNovelId) return;   // 已切到別的作品/章節
      const rc = document.getElementById('reader-content');
      if (!rc || rc.querySelector('.reader-artwork')) return;
      const img = document.createElement('img');
      img.src = artSrc; img.className = 'reader-artwork'; img.alt = '';
      rc.prepend(img);
      // 授權畫作的雙署名：緊貼文首圖下方（自己上傳的頁首圖沒有畫師署名，不顯示）
      if (currentNovelByline && artSrc === currentNovelHeader) {
        const by = document.createElement('div');
        by.className = 'reader-byline';
        by.textContent = `文／${currentNovelByline.text}　圖／${currentNovelByline.art}`;
        img.after(by);
      }
    };
    artIm.src = artSrc;
  }
  const rv = document.getElementById('reader-view');
  rv.scrollTo(0, pendingScroll || 0);   // resume to saved spot; 0 for a fresh chapter
  pendingScroll = 0;
  // save progress (including current scroll position)
  const novel = [...forumPosts, ...novels].find(n => n.id === currentNovelId);
  if (novel) {
    localStorage.setItem('pd_last_read', JSON.stringify({
      novelId: currentNovelId, novelTitle: novel.title, kind: currentNovelKind,
      category: novel.category || null,
      chapterIdx: idx, chapterId: ch.id, chapterCount: currentChapters.length,
      chapterTitle: ch.title || `第 ${ch.chapter_num} 章`,
      scrollTop: Math.round(rv.scrollTop),
      at: Date.now(),
    }));
    renderContinueBar();
    _pushReadingSoon();   // 續讀進度回寫帳號（防抖）
  }
}

// Continuously remember how far down the current chapter the reader has scrolled.
let pendingScroll = 0;
(function setupReaderScrollSave() {
  const rv = document.getElementById('reader-view');
  let t;
  rv.addEventListener('scroll', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const raw = localStorage.getItem('pd_last_read');
      if (!raw) return;
      const p = JSON.parse(raw);
      const cur = currentChapters[currentChapterIdx];
      if (cur && p.chapterId === cur.id) {
        p.scrollTop = Math.round(rv.scrollTop);
        localStorage.setItem('pd_last_read', JSON.stringify(p));
      }
    }, 250);
  });
})();

function renderContinueBar() {
  const raw = localStorage.getItem('pd_last_read');
  const bar = document.getElementById('continue-bar');
  if (!raw) { bar.style.display = 'none'; return; }
  const p = JSON.parse(raw);
  // Dismissed (swiped/✕ away) for this exact read → stay hidden until a different chapter is read.
  if (localStorage.getItem('pd_continue_dismissed') === p.novelId + '|' + p.chapterId) { bar.style.display = 'none'; return; }
  // Single-piece work → just the title; multi-chapter → title・chapter.
  const label = (p.chapterCount > 1)
    ? ([p.novelTitle, p.chapterTitle].filter(Boolean).join('・') || '繼續上次的閱讀')
    : (p.novelTitle || p.chapterTitle || '繼續上次的閱讀');
  document.getElementById('continue-bar-text').textContent = label;
  bar.style.transition = ''; bar.style.transform = ''; bar.style.opacity = '';   // reset any leftover swipe
  bar.style.display = 'flex';
}

// Dismiss the 繼續閱讀 bar (✕ or swipe). Remembers this read so it stays hidden, but a
// different chapter brings it back. Reading position itself is NOT forgotten.
let _continueSwiped = false;
function dismissContinueBar() {
  const raw = localStorage.getItem('pd_last_read');
  if (raw) { try { const p = JSON.parse(raw); localStorage.setItem('pd_continue_dismissed', p.novelId + '|' + p.chapterId); } catch {} }
  const bar = document.getElementById('continue-bar');
  bar.style.display = 'none';
  bar.style.transition = ''; bar.style.transform = ''; bar.style.opacity = '';
}
(function setupContinueSwipe() {
  const bar = document.getElementById('continue-bar');
  if (!bar) return;
  let x0 = null, y0 = null, dx = 0, swiping = false;
  bar.addEventListener('touchstart', e => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; swiping = false; _continueSwiped = false; bar.style.transition = ''; }, { passive: true });
  bar.addEventListener('touchmove', e => {
    if (x0 === null) return;
    const t = e.touches[0]; const ndx = t.clientX - x0, ndy = t.clientY - y0;
    if (!swiping && Math.abs(ndx) > 10 && Math.abs(ndx) > Math.abs(ndy)) { swiping = true; _continueSwiped = true; }
    if (swiping) { dx = ndx; bar.style.transform = `translateX(${dx}px)`; bar.style.opacity = String(Math.max(0, 1 - Math.abs(dx) / 180)); }
  }, { passive: true });
  bar.addEventListener('touchend', () => {
    if (swiping && Math.abs(dx) > 80) {                      // far enough → dismiss
      bar.style.transition = 'transform .2s ease, opacity .2s ease';
      bar.style.transform = `translateX(${dx > 0 ? 500 : -500}px)`; bar.style.opacity = '0';
      setTimeout(dismissContinueBar, 200);
    } else if (swiping) {                                    // not far enough → snap back
      bar.style.transition = 'transform .2s ease, opacity .2s ease';
      bar.style.transform = ''; bar.style.opacity = '';
    }
    x0 = null;
  }, { passive: true });
})();

async function resumeReading() {
  if (_continueSwiped) { _continueSwiped = false; return; }   // that tap was actually a swipe
  const raw = localStorage.getItem('pd_last_read');
  if (!raw) return;
  const p = JSON.parse(raw);
  currentNovelId = p.novelId;
  currentNovelKind = p.kind || 'novel';
  currentNovelTitle = p.novelTitle || '';
  // 迷情劑 watermark + copy guard — continue-reading used to bypass openNovel and skip this.
  let _nv = [...forumPosts, ...novels].find(n => n.id === p.novelId);
  let _cat = _nv ? _nv.category : p.category;
  if (_cat === undefined) { try { _nv = await api(`/novels/${p.novelId}`); _cat = _nv && _nv.category; } catch {} }
  applyMqjGuard(true);   // watermark + copy guard on every work (was 迷情劑-only)
  updateReaderFavBtn();   // show ☆/★ for 意若思鏡 works
  updateReaderDarkBtn();  // /reflects current 夜間模式
  try { currentChapters = await api(`/chapters/novel/${p.novelId}`) || []; }
  catch { toast('無法載入章節'); return; }
  const single = currentNovelKind === 'forum' || currentChapters.length <= 1;
  document.getElementById('reader-chapter-nav').style.display = single ? 'none' : '';
  document.getElementById('reader-toc-panel').style.display = single ? 'none' : '';
  document.getElementById('reader-series-nav').style.display = 'none';   // updateSeriesNav decides after load
  renderToc();
  const idx = currentChapters.findIndex(c => c.id === p.chapterId);
  pendingScroll = p.scrollTop || 0;   // jump back to where you stopped
  loadChapter(idx >= 0 ? idx : p.chapterIdx).then(() => updateSeriesNav(_nv));   // 上下篇 also work from 繼續閱讀
  document.getElementById('reader-view').classList.add('open');
}

function navigateChapter(dir) {
  const next = currentChapterIdx + dir;
  if (next >= 0 && next < currentChapters.length) loadChapter(next);
}

function closeReader() {
  document.getElementById('reader-view').classList.remove('open');
  _pushReadingNow();   // 離開閱讀器＝把最新進度（含捲動位置）回寫帳號
}

// ── Forum ────────────────────────────────────────────────────
let forumPosts = [];
let forumLikes = { counts: {}, mine: [] };

// Celebratory burst when you 點讚: the star pops and scarlet/gold sparks radiate out. Only on
// like (not unlike), and skipped under prefers-reduced-motion (via the .like-spark CSS).
function likeBurst(btn) {
  if (!btn) return;
  const star = btn.querySelector('.star') || btn.querySelector('svg') || btn;   // forum .star or reader-fav svg
  if (!star) return;
  if (star.animate) star.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(1.45)' }, { transform: 'scale(1)' }],
    { duration: 420, easing: 'cubic-bezier(.3,1.4,.5,1)' });
  const r = star.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const colors = ['var(--accent)', 'var(--gold)', 'var(--accent)'];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('span');
    p.className = 'like-spark';
    const ang = (2 * Math.PI * i) / N + (Math.random() - 0.5) * 0.5;
    const dist = 16 + Math.random() * 16, sz = 4 + Math.random() * 3;
    p.style.left = cx + 'px'; p.style.top = cy + 'px';
    p.style.width = p.style.height = sz.toFixed(1) + 'px';
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
    p.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 650);
  }
}

async function toggleLike(idx) {
  try {
    const res = await api(`/novels/${currentNovelId}/comments/${idx}/like`, { method: 'POST' });
    forumLikes.counts = forumLikes.counts || {};
    forumLikes.counts[idx] = res.count;
    forumLikes.mine = (forumLikes.mine || []).filter(x => x !== idx);
    if (res.liked) forumLikes.mine.push(idx);
    const btn = document.getElementById('like-' + idx);
    if (btn) {
      btn.classList.toggle('liked', res.liked);
      btn.querySelector('.cnt').textContent = res.count || '';
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', res.liked ? '#ic-starfill' : '#ic-starline');   // ☆ ↔ ★
      if (res.liked) likeBurst(btn);   // 發散小火花 — only when liking, not un-liking
    }
  } catch (e) { toast(e.message); }
}

let forumChars = [];   // default: none lit = show everything; tap a character to filter to them (OR)
let forumView = 'all';   // 'all' | 'liked'
let forumLiked = [];

async function loadForumPosts() {
  // entering the forum always resets to the 論壇·全部 view（若上次停在留影走廊，切回論壇分頁）
  if (forumTab === 'gallery') setForumMode('forum');
  forumView = 'all';
  const ffb = document.getElementById('forum-fav-btn'); if (ffb) ffb.classList.remove('on');
  const fb = document.querySelector('#forum-normal .filter-bar'); if (fb) fb.style.display = '';
  const el = document.getElementById('forum-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    forumPosts = await api('/novels/?kind=forum') || [];
    renderForumList();
  } catch {
    // Don't fake an empty list on a fetch error (e.g. server cold-start) — offer a retry.
    el.innerHTML = '<p style="padding:40px 8px;color:var(--accent);text-align:center;cursor:pointer" data-onclick="loadForumPosts()">載入失敗，點此重試</p>';
  }
}

function onForumFilter(type, val) {
  forumChars = forumChars.includes(val) ? forumChars.filter(c => c !== val) : [...forumChars, val];
  renderForumList();
}

async function toggleForumFav() {
  // 羊皮紙頁的收藏夾鈕是兩用的：留影走廊模式下改為切換「已收藏畫作」檢視
  if (forumTab === 'gallery') { toggleGalleryFav(); return; }
  forumView = forumView === 'liked' ? 'all' : 'liked';
  const btn = document.getElementById('forum-fav-btn'); if (btn) btn.classList.toggle('on', forumView === 'liked');
  document.querySelector('#forum-normal .filter-bar').style.display = forumView === 'liked' ? 'none' : '';
  if (forumView === 'liked') {
    const el = document.getElementById('forum-list');
    el.innerHTML = '<div class="spinner"></div>';
    try { forumLiked = await api('/novels/my-liked') || []; } catch { forumLiked = []; }
  }
  renderForumList();
}

function renderForumList() {
  const el = document.getElementById('forum-list');
  const liked = forumView === 'liked';
  // character chips only in the 全部 view
  if (!liked) {
    const chipEl = document.getElementById('forum-char-chips');
    chipEl.innerHTML = CHAR_LIST.map(ch =>
      `<div class="char-chip ${forumChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}">
         <img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span>
       </div>`).join('');
    chipEl.querySelectorAll('.char-chip').forEach(el => el.onclick = () => officialCharTap(el.dataset.ch, onForumFilter));
    mountCharAndBtn('forum-char-and');
  }
  const q = (document.getElementById('forum-search-input').value || '').trim().toLowerCase();
  let posts;
  if (liked) {
    posts = [...forumLiked];   // already sorted by liked_count from the server
  } else {
    posts = [...forumPosts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    posts = applyClassFilter(posts, '', forumChars);
  }
  if (q) posts = posts.filter(p => matchesQuery(p, q));
  if (!posts.length) {
    const msg = liked
      ? (q ? '找不到符合的貼文' : '你還沒收藏任何羊皮紙<br><small>在喜歡的留言點羽毛筆就會收進這裡</small>')
      : (q ? '找不到符合的貼文' : '目前還沒有論壇貼文');
    el.innerHTML = `<p style="padding:40px 8px;color:#888;text-align:center">${msg}</p>`;
    return;
  }
  el.innerHTML = forumPostsHTML(posts);
}
// 論壇貼文卡片 HTML（renderForumList 與意若思鏡「羊皮紙」分頁共用）
function forumPostsHTML(posts) {
  return posts.map(p => `
    <div class="forum-post-row" data-onclick="openNovel('${p.id}')">
      <h4>${escapeHtml(p.title)}</h4>
      <div class="meta">
        <span>${escapeHtml(p.author || '匿名')}</span>
        <span>${ic('ic-calendar',11)} ${fmtUpdated(p.created_at)}</span>
        ${p.liked_count ? `<span style="color:var(--accent)">${ic('ic-feather', 11)} 收藏了 ${p.liked_count} 則</span>` : ''}
        ${p.status === 'pending' ? '<span class="pending-tag">' + ic('ic-clock',11) + ' 待審核</span>' : ''}
      </div>
      ${(p.characters || []).length ? `<div class="row-tags" style="margin-top:7px">${(p.characters || []).map(c => charPill(c)).join('')}</div>` : ''}
    </div>`).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Inline an icon from the sprite (currentColor → inherits text colour). For use in JS templates.
function ic(id, size = 16) { return `<svg width="${size}" height="${size}" aria-hidden="true" style="vertical-align:-2px"><use href="#${id}"/></svg>`; }
// Role badge as HTML (icon + name). NOTE: <select><option> can't hold SVG, so the role dropdown stays emoji.
const ROLE_ICON = { reader: 'ic-books', writer: 'ic-quill', admin: 'ic-castle', super_admin: 'ic-crown' };
const ROLE_NAME = { reader: '讀者', writer: '作家', admin: '管理員', super_admin: '最高管理員' };
function roleBadge(role, size = 14) {
  const id = ROLE_ICON[role];
  return `${id ? ic(id, size) : ''} ${escapeHtml(ROLE_NAME[role] || role || '未知身份')}`;
}

// ── Settings ─────────────────────────────────────────────────

// App-wide UI scale (settings page) — zooms content pages uniformly
function applyAppFontSize(scale) {
  document.documentElement.style.setProperty('--app-zoom', scale);
  localStorage.setItem('pd_app_zoom', scale);
}

// Reader-only chapter font size (reader controls)
function applyReaderFontSize(size) {
  size = Math.max(13, Math.min(28, size));
  document.documentElement.style.setProperty('--reader-font', size + 'px');
  localStorage.setItem('pd_reader_font', size);
  const lbl = document.getElementById('reader-font-label');
  if (lbl) lbl.textContent = size;
}

function stepReaderFont(delta) {
  const cur = parseInt(localStorage.getItem('pd_reader_font')) || 15;
  applyReaderFontSize(cur + delta);
}

function toggleDark(on) {
  const r = document.documentElement.style;
  r.setProperty('--parchment',  on ? '#1e1508' : '#f4e8c1');
  r.setProperty('--parchment2', on ? '#16100a' : '#efe2c4');
  r.setProperty('--ink',        on ? '#f4e8c1' : '#1a0a00');
  r.setProperty('--ink-light',  on ? '#e8d5a3' : '#3d1f0d');
  r.setProperty('--series',     on ? '#9fcf7a' : '#2d4a1e');
  r.setProperty('--accent',     on ? '#d9b85c' : '#8a2d2d');   // 酒紅文字/邊框 → 夜間金色
  r.setProperty('--reader-overlay', on ? 'rgba(20,12,4,0.90)' : 'rgba(244,232,193,0.80)');
  r.colorScheme = on ? 'dark' : 'light';   // native pickers (select/date) render dark in 夜間模式
  document.documentElement.classList.toggle('dark', on);
  localStorage.setItem('pd_dark', on ? '1' : '0');
  if (_mqjActive) applyMqjGuard(true);   // rebake the watermark colour for the new theme
}

// Reader-header shortcut: flip 夜間模式 without leaving the reader, kept in sync with the 檔案 toggle.
function toggleReaderDark() {
  const on = localStorage.getItem('pd_dark') !== '1';
  toggleDark(on);
  const cb = document.getElementById('dark-toggle');
  if (cb) cb.checked = on;
  updateReaderDarkBtn();
}
function updateReaderDarkBtn() {
  const b = document.getElementById('reader-dark-btn');
  if (b) b.innerHTML = localStorage.getItem('pd_dark') === '1' ? ic('ic-sun',19) : ic('ic-moon',19);
}

// ── Admin ────────────────────────────────────────────────────
const AUDIT_LABELS = {
  approve_novel: '核准作品', retract_novel: '退件作品', reject_novel: '退回修改', resubmit_novel: '重新送審', delete_novel: '刪除作品', lock: '鎖上作品', unlock: '解鎖作品',
  ban: '封禁帳號', unban: '解除封禁', temp_ban: '臨時封禁', temp_unban: '解除臨時封禁',
  archive: '封存帳號', unarchive: '取消封存',
  change_role: '變更身份', reset_password: '重設密碼',
  delete_user: '刪除帳號', auto_publish: '自動審核', wish_reply: '許願池回覆權', mqj: '迷情劑權限', clear_flag: '已審回鍋標記',
  generate_invite: '產生邀請', revoke_invite: '撤銷邀請',
};
async function loadAuditLog() {
  const el = document.getElementById('admin-audit-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [rows, users] = await Promise.all([
      api('/permissions/audit-log'),
      api('/permissions/users').catch(() => []),
    ]);
    const nameById = {};
    (users || []).forEach(u => { nameById[u.id] = u.username; });
    if (!rows || !rows.length) { el.innerHTML = '<p style="font-size:13px;color:var(--ink-light)">尚無紀錄</p>'; return; }
    el.innerHTML = rows.map(r => {
      const label = AUDIT_LABELS[r.action] || r.action;
      const when = r.created_at ? new Date(r.created_at).toLocaleString('zh-TW', { hour12: false }) : '';
      const tgt = r.target_type === 'user'
        ? (nameById[r.target_id] || (r.target_id ? '#' + String(r.target_id).slice(0, 8) : ''))
        : (r.detail || (r.target_id ? '#' + String(r.target_id).slice(0, 8) : ''));
      // For user-target rows the detail (e.g. temp-ban duration 24h/72h) is shown as a muted suffix.
      const meta = (r.target_type === 'user' && r.detail) ? ` <span style="color:var(--ink-light);opacity:.8">${escapeHtml(r.detail)}</span>` : '';
      return `<div class="log-line"><span class="log-time">${escapeHtml(when)}</span><span class="log-actor">${escapeHtml(r.actor_name || '?')}</span><span class="log-act">${escapeHtml(label)}${tgt ? ` <span class="log-tgt">${escapeHtml(String(tgt))}</span>` : ''}${meta}</span></div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<p style="color:var(--accent);font-size:13px">載入失敗：${escapeHtml((e && e.message) || '')}</p>`; }
}

// 監看：全站授權信一覽（超管）——誰向誰借圖／求畫、同意與否，以及雙方留給對方的話。
async function loadAuthMonitor() {
  const el = document.getElementById('admin-auth-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const rows = await api('/authorizations/all', { background: true });
    if (!rows || !rows.length) { el.innerHTML = '<p style="font-size:13px;color:var(--ink-light)">尚無授權往來</p>'; return; }
    const DIR = { use_image: '借圖', derive_art: '求畫' };
    const STAT = { pending: ['待回覆', 'var(--ink-light)'], approved: ['已同意', 'var(--series)'], declined: ['已婉拒', 'var(--accent)'] };
    el.innerHTML = rows.map(a => {
      const dir = DIR[a.direction] || a.direction;
      const st = STAT[a.status] || [a.status, 'var(--ink-light)'];
      const when = a.created_at ? new Date(a.created_at).toLocaleString('zh-TW', { hour12: false }) : '';
      const target = a.direction === 'use_image'
        ? `借《${escapeHtml(a.artwork_title || '畫作')}》用於《${escapeHtml(a.work_title || '文章')}》`
        : `為《${escapeHtml(a.work_title || '文章')}》作畫`;
      const noteLine = a.note ? `<div style="font-size:12.5px;color:var(--ink);margin-top:4px">${escapeHtml(a.requester_name)}：「${escapeHtml(a.note)}」</div>` : '';
      const replyLine = a.reply_note ? `<div style="font-size:12.5px;color:var(--ink);margin-top:2px">${escapeHtml(a.recipient_name)}：「${escapeHtml(a.reply_note)}」</div>` : '';
      return `<div style="padding:9px 2px;border-bottom:1px solid rgba(26,10,0,.07)">
        <div style="font-size:13px;color:var(--ink)"><b>${escapeHtml(a.requester_name)}</b> <span style="color:var(--gold)">→</span> <b>${escapeHtml(a.recipient_name)}</b>　<span style="font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(201,168,76,.2);color:var(--ink-light)">${dir}</span> <span style="font-size:11px;color:${st[1]}">${st[0]}</span></div>
        <div style="font-size:12px;color:var(--ink-light);margin-top:3px">${target}</div>
        ${noteLine}${replyLine}
        <div style="font-size:11px;color:var(--ink-light);opacity:.7;margin-top:3px">${escapeHtml(when)}</div>
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<p style="color:var(--accent);font-size:13px">載入失敗：${escapeHtml((e && e.message) || '')}</p>`; }
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('admin-' + tab).classList.add('active');
  stopMonitor();                       // leaving any tab cancels the live monitor poll
  if (tab === 'monitor') { startMonitor(); loadAuthMonitor(); loadAuditLog(); }   // 作品互授＋操作紀錄 lives at the bottom of 監看
  if (tab === 'novels') loadAdminNovelList();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'upload') { setUploadKind('novel'); initUploadDraftWatch(); restoreUploadDraft(); }
  if (tab === 'review') { setReviewMode('works'); loadReviewList(); }
  if (tab === 'auths') renderAuthMailbox('auth-mailbox');
  if (tab === 'invites') {
    // super_admin only: 管理員邀請 button + 批次數量 selector (admins generate one at a time)
    const isSuper = currentUser.role === 'super_admin';
    document.getElementById('invite-admin-btn').style.display = isSuper ? '' : 'none';
    document.getElementById('invite-qty-row').style.display = isSuper ? 'flex' : 'none';
    if (!isSuper) document.getElementById('invite-qty').value = '1';
    loadInviteList();
    loadWriterApps();
  }
}

// ── SA 監看面板 ─────────────────────────────────────────────
// Force-refresh: wipe the SW caches + unregister the worker, then hard-reload so this client
// pulls the very latest build/assets (bypasses any stale cache). SA-only — lives in 監看.
async function forceRefresh() {
  if (!confirm('強制刷新：清除本機快取並重新載入最新版本？')) return;
  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) { /* best effort — reload regardless */ }
  // cache-busting query so even the HTTP cache can't hand back a stale document
  location.replace(location.pathname + '?fresh=' + Date.now());
}
// Download a full content backup (all tables as JSON). SA-only. Best run on desktop.
async function exportBackup() {
  if (!confirm('下載一份全站內容備份（JSON）？\n（含作品、留言、用戶資料；不含登入密碼）')) return;
  const btn = document.getElementById('export-backup-btn');
  const label = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = '匯出中…'; }
  try {
    const data = await api('/permissions/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date(), p = n => String(n).padStart(2, '0');
    a.href = url;
    a.download = `prophet-daily-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const n = data && data.tables ? Object.values(data.tables).reduce((s, v) => s + (Array.isArray(v) ? v.length : 0), 0) : 0;
    toast(`備份已下載（${n} 筆）`);
  } catch (e) {
    toast('' + (e.message || '匯出失敗'));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}
let _monitorTimer = null;
function stopMonitor() { if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; } }
function startMonitor() {
  loadMonitor();
  _monitorTimer = setInterval(loadMonitor, 10000);   // refresh every 10s while viewing
}
function _fmtUptime(s) {
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h + ' 小時 ' + m + ' 分';
}
async function runDbLatency() {
  const el = document.getElementById('db-latency-out');
  if (!el) return;
  el.style.display = 'block';
  el.innerHTML = '<div class="spinner" style="margin:8px auto"></div>';
  try {
    const r = await api('/permissions/db-latency', { background: true });
    const s = r.samples_ms || [];
    const first = r.first_ms, warm = r.warm_median_ms || 0;
    const coldPenalty = warm ? first / warm : 1;
    const coldExtra = Math.max(0, Math.round(first - warm));
    const fastest = s.length ? Math.min(...s) : warm;   // 最快那次≈連線暖了的真穩態
    // 穩態暖往返在 ~120 ms 上下（歷史多次量測確立）。單一 burst 整組偏高，多半是剛部署／低流量
    // 連線閒置掉、還在反覆 TLS 握手，不是 region 問題——所以「搬 region」只在「暖機後多次量測仍穩定
    // 偏高」時才用條件句提，絕不從一次冷 burst 下斷言（那正是每次部署都誤報搬家的老毛病）。
    // 判讀順序：真穩態快 → 從沒落回穩態（冷／低流量）→ 有暖有冷的暖機曲線 → 連線建立成本 → 穩定。
    const warmedUp = fastest < 200;   // 這組裡有沒有出現過一次接近穩態的暖往返
    const verdict = (fastest < 160 && warm < 220)
      ? ['#2d4a1e', `Supabase 連線穩定，單次小型查詢約 ${warm} ms（首發僅多 ${coldExtra} ms）。慢是慢在「多次連續查詢」與較大回傳的累積——優化方向是把 sequential 合成一次，不必搬 region。`]
      : !warmedUp
      ? ['#a8761f', `整組偏高（最快 ${fastest}、首發 ${first} ms）且沒有一次落回穩態 → 多半是剛部署／低流量下連線閒置、還在暖機（反覆 TLS 握手），不是 region。穩態應在 ~120 ms；隔幾分鐘、有點流量後再測一次。若多次量測都穩定這麼高，才需要考慮把 Supabase 搬到與 Render 同區。`]
      : (warm >= 250)
      ? ['#a8761f', `樣本忽快忽慢（最快 ${fastest}、中位 ${warm} ms）→ 連線還在暖機（keep-alive 未建、反覆 TLS 握手）。穩態接近最快值 ~${fastest} ms，等跑穩幾分鐘再測，別被暖機數字誤導成要搬 region。`]
      : coldPenalty >= 2
      ? ['#a8761f', `首發 ${first} 明顯比熱查詢 ${warm} 慢 → 往返稅來自連線建立（TLS 握手），修連線重用即可，不必搬。`]
      : ['#2d4a1e', `Supabase 連線穩定，單次小型查詢約 ${warm} ms（首發僅多 ${coldExtra} ms）。慢是慢在「多次連續查詢」與較大回傳的累積——優化方向是把 sequential 合成一次，不必搬 region。`];
    el.innerHTML = `<div style="font-size:12px;color:var(--ink-light);margin-bottom:4px">${ic('ic-gear', 12)} Supabase 往返（連續 6 次撈一行，ms；首發粗體）</div>
      <div style="font-size:14px;color:var(--ink);font-family:monospace">${s.map((v, i) => i === 0 ? `<b>${v}</b>` : v).join('　·　')}</div>
      <div style="font-size:12px;margin-top:6px;color:var(--ink-light)">首發 <b style="color:var(--ink)">${first}</b> ms　｜　熱查詢中位數 <b style="color:var(--ink)">${warm}</b> ms</div>
      <div style="font-size:12.5px;color:${verdict[0]};margin-top:7px;line-height:1.55">${verdict[1]}</div>`;
  } catch (e) { el.innerHTML = `<span style="color:var(--scarlet)">測試失敗：${escapeHtml(e.message || '')}</span>`; }
}
let _monSnap = null;     // 最近一次 server-stats 快照（視窗切換時免重抓）
let _monWin = '15m';     // 慢表視窗：'15m' | '24h'
function setMonWin(w) { _monWin = w === '24h' ? '24h' : '15m'; renderMonitorBody(); }
async function loadMonitor() {
  const el = document.getElementById('monitor-body');
  if (!el) return;
  if (!el.dataset.loaded) el.innerHTML = '<div class="spinner"></div>';
  try {
    _monSnap = await api('/permissions/server-stats', { background: true });
    el.dataset.loaded = '1';
    renderMonitorBody();
  } catch (e) {
    el.innerHTML = `<p style="color:var(--scarlet);padding:14px">載入失敗：${escapeHtml(e.message || '')}</p>`;
  }
}
function renderMonitorBody() {
  const el = document.getElementById('monitor-body');
  const s = _monSnap;
  if (!el || !s) return;
  {
    // Latency is a 2-min window, so the cold-boot requests age out by ~150s → shorter grace.
    const warming = s.uptime_seconds < 150;
    const latSamples = s.samples_5m || 0;            // samples in the recent 2-min latency window
    const insufficient = !warming && latSamples < 5; // too little recent traffic to judge → 閒置, don't cry 吃緊
    const authTotal = s.auth_total_5m || 0;
    const jwtPct = authTotal ? Math.round((s.auth_local_5m || 0) / authTotal * 100) : null;
    const ms = s.p50_ms_5m || 0;       // MEDIAN — robust to a single cold-start outlier
    const p95 = s.p95_ms_5m || 0;
    const p95High = p95 >= 2000 && !warming && !insufficient;
    const health = warming ? ['var(--gold)', '暖機中']
      : insufficient || ms === 0 ? ['var(--ink-light)', '閒置']
      : ms < 400 ? ['#2d4a1e', '順暢']
      : ms < 1000 ? ['#a8761f', '略慢']
      : ['var(--scarlet)', '吃緊'];
    const card = (label, val, sub, wide) => `
      <div style="${wide ? 'flex-basis:100%;' : 'flex:1;min-width:128px;'}box-sizing:border-box;background:var(--parchment);border:1px solid var(--gold-lt);border-radius:10px;padding:12px 14px">
        <div style="font-size:12px;color:var(--ink-light)">${label}</div>
        <div style="font-size:22px;font-weight:bold;color:var(--ink);line-height:1.3">${val}</div>
        ${sub ? `<div style="font-size:11px;color:var(--ink-light);opacity:.85;margin-top:3px;line-height:1.5">${sub}</div>` : ''}
      </div>`;
    // 效能定位：最慢 Endpoint／Supabase 查詢（15 分鐘窗，p95 由高到低）。p95 上色：紅≥1s、橙≥500ms。
    const slowTable = (title, rows, col1, right) => {
      if (!rows || !rows.length) return '';
      const cell = v => `<td style="padding:3px 7px;text-align:right;color:${v >= 1000 ? 'var(--scarlet)' : v >= 500 ? '#a8761f' : 'inherit'}">${v}</td>`;
      // 標題列：一行到底不換行——標題可縮（過長才省略號），右側膠囊固定不縮，
      // 這樣切換視窗不會因標題字數變化而讓按鈕跳行。
      return `<div style="margin-top:14px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;margin-bottom:5px">
          <div style="font-size:12px;font-weight:bold;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</div>
          ${right ? `<div style="flex-shrink:0;display:inline-flex;gap:5px;margin-left:auto">${right}</div>` : ''}
        </div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="color:var(--ink-light)">
            <th style="text-align:left;padding:3px 7px;font-weight:normal">${col1}</th>
            <th style="text-align:right;padding:3px 7px;font-weight:normal">次數</th>
            <th style="text-align:right;padding:3px 7px;font-weight:normal">p50</th>
            <th style="text-align:right;padding:3px 7px;font-weight:normal">p95</th>
            <th style="text-align:right;padding:3px 7px;font-weight:normal">max</th>
          </tr></thead>
          <tbody>${rows.map(r => `<tr style="border-top:1px solid var(--gold-lt)">
            <td style="padding:3px 7px;color:var(--ink)">${escapeHtml(r.name)}</td>
            <td style="padding:3px 7px;text-align:right;color:var(--ink-light)">${r.count}</td>
            <td style="padding:3px 7px;text-align:right">${r.p50}</td>${cell(r.p95)}
            <td style="padding:3px 7px;text-align:right;color:var(--ink-light)">${r.max}</td>
          </tr>`).join('')}</tbody>
        </table></div></div>`;
    };
    const rtSub = warming
      ? `<span style="color:${health[0]};font-weight:bold">● 暖機中</span>　剛啟動，數據穩定前先不評級`
      : insufficient
      ? `<span style="color:${health[0]};font-weight:bold">● 閒置</span>　近 2 分鐘流量太少，暫不評級`
      : `<span style="color:${health[0]};font-weight:bold">● ${health[1]}</span>（中位數）　｜　最慢5% (p95)：<span style="color:${p95High ? 'var(--scarlet)' : 'inherit'}">${p95} ms${p95High ? ' ' : ''}</span>`;
    const rtVal = insufficient ? '—' : ms + ' ms';
    const memMb = s.mem_mb, memLimit = s.mem_limit_mb || 512;
    const memPct = memMb != null ? Math.round(memMb / memLimit * 100) : null;
    const memColor = memPct == null ? 'var(--ink-light)' : memPct < 70 ? '#2d4a1e' : memPct < 88 ? '#a8761f' : 'var(--scarlet)';
    const memSub = memMb != null
      ? `<span style="color:${memColor};font-weight:bold">${memPct}%</span> / ${memLimit} MB${memPct >= 88 ? ' 接近上限' : ''}`
      : '無法取得';
    // 今日（24h 滾動）總覽卡：process 不休眠後才有意義的長窗統計。窗未滿 24h 時註明已收集時數。
    const winH = s.window_hours || 0;
    // 標籤保持極短（否則窄卡片會折行）；「已收集 N 小時」這種補充放副標。
    const dayCard = s.total_24h == null ? '' :
      card(ic('ic-calendar', 12) + ' 今日',
           s.total_24h + ' 請求',
           `活躍 ${s.active_24h ?? '—'} 人　·　5xx <span style="color:${s.errors_24h ? 'var(--scarlet)' : 'inherit'}">${s.errors_24h ?? 0}</span>`
           + (winH >= 24 ? '' : `<br>已收集 ${winH} 小時`));
    // 每小時請求長條（24 桶，舊→新）：高度 ∝ 請求數；該小時有 5xx 染紅。克制的純 div，無圖表庫。
    let hourlyRow = '';
    if (s.hourly && s.hourly.some(b => b.n > 0)) {
      const mx = Math.max(...s.hourly.map(b => b.n), 1);
      hourlyRow = `<div style="margin-top:10px">
        <div style="font-size:11px;color:var(--ink-light);margin-bottom:4px">${ic('ic-clock', 11)} 每小時請求（近 24 小時）</div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:30px">${s.hourly.map(b => {
          const h = b.n ? Math.max(3, Math.round(b.n / mx * 30)) : 1;
          const t = new Date(b.t * 1000).getHours();
          return `<div title="${t} 時：${b.n} 請求${b.err ? '，' + b.err + ' 次 5xx' : ''}${b.p50 ? '，p50 ' + b.p50 + 'ms' : ''}" style="flex:1;height:${h}px;border-radius:1px;background:${b.err ? 'var(--scarlet)' : b.n ? 'var(--gold)' : 'var(--gold-lt)'};opacity:${b.n ? '.9' : '.35'}"></div>`;
        }).join('')}</div>
      </div>`;
    }
    // 慢表視窗切換：15 分鐘看「現在」、24 小時看「全貌」（樣本足、p95 有代表性）。
    const is24 = _monWin === '24h' && s.endpoints_24h;
    const winBtn = (w, label) => `<button data-onclick="setMonWin('${w}')" style="font-size:11px;padding:2px 10px;border:1px solid ${(_monWin === w) ? 'var(--scarlet)' : 'var(--gold-lt)'};background:${(_monWin === w) ? 'var(--scarlet)' : 'none'};color:${(_monWin === w) ? 'var(--on-dark)' : 'var(--ink-light)'};border-radius:10px;cursor:pointer">${label}</button>`;
    const winToggle = s.endpoints_24h ? `${winBtn('15m', '15 分鐘')}${winBtn('24h', '24 小時')}` : '';
    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${card(ic('ic-clock', 12) + ' 回應時間', rtVal, rtSub, true)}
        ${card(ic('ic-gear', 12) + ' 記憶體', memMb != null ? memMb + ' MB' : '—', memSub)}
        ${card(ic('ic-users', 12) + ' 在線（5 分鐘）', s.active_5m, '15 分鐘內 ' + s.active_15m + ' 人')}
        ${card(ic('ic-send', 12) + ' 請求量', s.req_1m + ' /分', '近 5 分 ' + s.req_5m + '　' + s.rps_1m + ' req/s')}
        ${card(ic('ic-shield', 12) + ' 錯誤（5 分鐘）', s.errors_5m, s.errors_5m ? '伺服器錯誤，請留意' : '無 5xx 錯誤')}
        ${dayCard}
        ${card(ic('ic-castle', 12) + ' 已運行', _fmtUptime(s.uptime_seconds), s.uptime_seconds < 90 ? '剛啟動' : '累計請求 ' + s.total_since_boot)}
      </div>
      ${hourlyRow}
      ${jwtPct === null ? '' : (jwtPct >= 80
        ? `<div style="font-size:11px;color:#2d4a1e;margin-top:10px">${ic('ic-shield', 11)} JWT 本機驗證：<b>啟用中</b>（${jwtPct}%）— 已省去每次請求對 Supabase 的一次往返</div>`
        : `<div style="font-size:12px;color:var(--scarlet);margin-top:10px;line-height:1.5">${ic('ic-shield', 11)} JWT 本機驗證：<b>未啟用</b>（本機僅 ${jwtPct}%）— 請把 Render 的 <b>JWT_SECRET</b> 設成你的 Supabase JWT 密鑰，回應時間才會降下來</div>`)}
      ${slowTable(ic('ic-clock', 12) + ' 最慢 Endpoint', is24 ? s.endpoints_24h : s.endpoints, 'Endpoint', winToggle)}
      ${slowTable(ic('ic-gear', 12) + ' 最慢 Supabase 查詢', is24 ? s.queries_24h : s.queries, '查詢')}
      <div style="font-size:11px;color:var(--ink-light);opacity:.7;margin-top:10px">※「在線」以近 5 分鐘有送出請求的登入用戶計；純閱讀時前端不送請求，故為活躍下限值。慢表可切 15 分鐘（看現在）／24 小時（看全貌，樣本足）。</div>`;
  }
}

// Admins always; readers & writers need an approved 迷情劑 toggle. Mirrors the backend.
function canSeeMqj() {
  return !!currentUser && (['admin', 'super_admin'].includes(currentUser.role) || currentUser.mqj_access === 'approved');
}

// Populate a category <select> and a character multi-select in an admin form.
function initClassPicker(catSelId, charDivId) {
  const sel = document.getElementById(catSelId);
  if (sel && !sel.dataset.init) {
    // Hide 迷情劑 from people who don't have access (they can't upload it anyway).
    const cats = canSeeMqj() ? CATEGORIES : CATEGORIES.filter(c => c !== '迷情劑');
    sel.innerHTML = '<option value="">— 選擇類型 —</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.dataset.init = '1';
  }
  const div = document.getElementById(charDivId);
  if (div && !div.dataset.init) {
    div.innerHTML = CHAR_LIST.map(ch => `<span class="opt" data-ch="${ch.code}" data-onclick="this.classList.toggle('on')">${ch.name}</span>`).join('');
    div.dataset.init = '1';
  }
}
function readChars(charDivId) {
  return [...document.querySelectorAll(`#${charDivId} .opt.on`)].map(el => el.dataset.ch);
}
function resetClassPicker(catSelId, charDivId) {
  const sel = document.getElementById(catSelId); if (sel) sel.value = '';
  document.querySelectorAll(`#${charDivId} .opt.on`).forEach(el => el.classList.remove('on'));
}

// 作者署名預設＝作者在站內的暱稱（沒暱稱退回帳號）。只在欄位空時填，作者仍可改。
// 羊皮紙貼文默認匿名（placeholder「留空則匿名」），故不套用。
function defaultAuthorName() { return (currentUser && (currentUser.nickname || currentUser.username)) || ''; }
function prefillAuthor(id) { const el = document.getElementById(id); if (el && !el.value) el.value = defaultAuthorName(); }

function setUploadKind(kind) {
  initClassPicker('forum-post-category', 'forum-post-chars');
  initClassPicker('new-novel-category', 'new-novel-chars');
  initImageUpload();
  const isNovel = kind === 'novel', isForum = kind === 'forum', isImage = kind === 'image';
  document.getElementById('upload-kind-novel').style.display = isNovel ? '' : 'none';
  document.getElementById('upload-kind-forum').style.display = isForum ? '' : 'none';
  document.getElementById('upload-kind-image').style.display = isImage ? '' : 'none';
  const paint = (btn, on) => { const b = document.getElementById(btn); if (!b) return;
    b.style.background = on ? 'var(--scarlet)' : 'var(--parchment2)'; b.style.color = on ? 'var(--on-dark)' : 'var(--ink-light)'; };
  paint('kind-novel-btn', isNovel); paint('kind-forum-btn', isForum); paint('kind-image-btn', isImage);
  // 小說／畫作的作者署名預設帶入暱稱（仍可改）；羊皮紙維持匿名默認。
  if (isNovel) prefillAuthor('new-novel-author');
  if (isImage) { prefillAuthor('new-image-author'); renderImageSourceRow(); }   // 授權信：源自下拉（沒有可用授權就隱藏）
  const writerNote = (currentUser.role === 'writer')
    ? (currentUser.auto_publish ? '你已獲得自動審核，作品送出後直接公開、免等待' : '作品需經管理員審核通過才公開')
    : '';
  const fh = document.getElementById('forum-post-hint'); if (fh) fh.textContent = writerNote;
  const nh = document.getElementById('new-novel-hint'); if (nh) nh.textContent = writerNote;
}


// ═══════════════════════════════════════════════════════════════════════════
// 留影走廊（Gallery）— 純圖像投稿，掛在羊皮紙頁；P1 僅管理員／超管可見。
// ═══════════════════════════════════════════════════════════════════════════
const GALLERY_FRAMES = [
  ['ebony', '墨檀'], ['oak', '橡木'], ['oakmat', '橡木襯白'], ['gilt', '鎏金襯白'], ['none', '無框'],
];
const _imgWork = { data: null, frame: 'ebony' };

function initImageUpload() {
  const picker = document.getElementById('image-frame-picker');
  if (picker && !picker.dataset.init) {
    picker.innerHTML = GALLERY_FRAMES.map(([code, name]) => `
      <div class="frame-swatch-wrap">
        <div class="frame-swatch ${code === 'none' ? '' : 'gframe fr-' + code}${code === _imgWork.frame ? ' sel' : ''}" data-frame="${code}" data-onclick="pickFrame('${code}')"><div></div></div>
        <small>${name}</small>
      </div>`).join('');
    picker.dataset.init = '1';
  }
  const chars = document.getElementById('new-image-chars');
  if (chars && !chars.dataset.init) {
    chars.innerHTML = CHAR_LIST.map(ch => `<span class="opt" data-ch="${ch.code}" data-onclick="this.classList.toggle('on')">${ch.name}</span>`).join('');
    chars.dataset.init = '1';
  }
}

function pickFrame(code) {
  _imgWork.frame = code;
  document.querySelectorAll('#image-frame-picker .frame-swatch').forEach(el => el.classList.toggle('sel', el.dataset.frame === code));
}

function pickImageFile() { const el = document.getElementById('image-file'); if (el) el.click(); }

// ── 小說頁首圖：新增小說時選圖，送出建立後再 PATCH 上傳 ─────────────────────
const _novelHeader = { data: null };
function pickNovelHeader() { const el = document.getElementById('nh-file'); if (el) el.click(); }
async function onNovelHeaderPick(input) {
  const f = input.files[0]; input.value = '';
  if (!f) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast('請選擇 JPG、PNG 或 WebP 圖片'); return; }
  try {
    _novelHeader.data = await resizeImageContain(f, 1080, 0.82);   // 同 artwork 工具：≤1080 寬
    const wrap = document.getElementById('nh-preview');
    wrap.style.display = '';
    wrap.innerHTML = `<img src="${_novelHeader.data}" alt="" style="max-width:100%;max-height:220px;border-radius:6px" /><div style="margin-top:6px"><button type="button" data-onclick="clearNovelHeader()" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">移除頁首圖</button></div>`;
    document.getElementById('nh-drop').textContent = '已選擇頁首圖，點此可更換';
  } catch (e) { toast('圖片讀取失敗'); }
}
function clearNovelHeader() {
  _novelHeader.data = null;
  const wrap = document.getElementById('nh-preview'); if (wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
  const drop = document.getElementById('nh-drop'); if (drop) drop.textContent = '選擇頁首圖';
}

// ── 作品編輯視窗的頁首圖：即時 PATCH（換／移除），跟標題/內文的儲存分開 ─────────
function renderEditHeaderPreview(url) {
  const box = document.getElementById('editwork-header-preview');
  const rm = document.getElementById('editwork-header-remove');
  if (!box) return;
  if (url) { box.innerHTML = `<img src="${escapeHtml(url)}" alt="" style="max-width:100%;max-height:180px;border-radius:6px" />`; if (rm) rm.style.display = ''; }
  else { box.innerHTML = '<span style="font-size:12px;color:var(--ink-light)">尚無頁首圖</span>'; if (rm) rm.style.display = 'none'; }
}
function pickEditHeader() { const el = document.getElementById('editwork-header-file'); if (el) el.click(); }
async function onEditHeaderPick(input) {
  const f = input.files[0]; input.value = '';
  if (!f || !editWork.id) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast('請選擇 JPG、PNG 或 WebP 圖片'); return; }
  try {
    const data = await resizeImageContain(f, 1080, 0.82);
    const r = await api(`/novels/${editWork.id}/header-image`, { method: 'PATCH', body: JSON.stringify({ image: data }) });
    editWork.headerUrl = (r && r.image_url) || null;
    renderEditHeaderPreview(r && r.image_url);
    _syncAdminNovelField(editWork.id, 'image_url', r && r.image_url);
    _syncAdminNovelField(editWork.id, 'image_caption', null);   // 自傳頁首圖沒有畫師署名（後端已清）
    renderEditAuthArts();   // 換成自己的圖＝授權畫作退回「可選用」
    toast('頁首圖已更新');
  } catch (e) { toast(e.message || '上傳失敗'); }
}
async function removeEditHeader() {
  if (!editWork.id) return;
  try {
    await api(`/novels/${editWork.id}/header-image`, { method: 'PATCH', body: JSON.stringify({ image: null }) });
    editWork.headerUrl = null;
    renderEditHeaderPreview(null);
    _syncAdminNovelField(editWork.id, 'image_url', null);
    _syncAdminNovelField(editWork.id, 'image_caption', null);
    renderEditAuthArts();   // 移除後授權畫作退回「可選用」
    toast('已移除頁首圖');
  } catch (e) { toast(e.message || '移除失敗'); }
}
// 同步本地快取，讓重開編輯視窗／閱讀器立即反映（不必重抓整份清單）
function _syncAdminNovelField(id, key, val) {
  [...(window._adminNovels || []), ...(typeof novels !== 'undefined' ? novels : [])]
    .forEach(o => { if (o && o.id === id) o[key] = val; });
}

// 保留長寬比、限制最長邊，輸出 JPEG data URL（畫作無需透明背景）。
function resizeImageContain(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (Math.max(w, h) > maxDim) { const r = maxDim / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject; img.src = reader.result;
    };
    reader.onerror = reject; reader.readAsDataURL(file);
  });
}

async function onImagePick(input) {
  const f = input.files[0]; input.value = '';
  if (!f) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast('請選擇 JPG、PNG 或 WebP 圖片'); return; }
  try {
    const data = await resizeImageContain(f, 1400, 0.85);
    _imgWork.data = data;
    const wrap = document.getElementById('image-preview-wrap');
    wrap.style.display = ''; wrap.innerHTML = `<img src="${data}" alt="" style="max-width:100%;max-height:300px;border-radius:6px" />`;
    document.getElementById('image-drop').textContent = '已選擇畫作，點此可更換';
  } catch (e) { toast('圖片讀取失敗'); }
}

// 防重複送出：投稿常一次送多篇、手殘連點會把同一篇送兩次。一個共用 in-flight 旗標——上一筆
// 還在飛就忽略後續點擊；同時把按鈕鎖住、改字「送出中…」給即時回饋，送完（成功或失敗）再復原。
let _uploadBusy = false;
function _btnBusy(btn) {
  if (!btn) return () => {};
  const html = btn.innerHTML, wasDisabled = btn.disabled, op = btn.style.opacity;
  btn.disabled = true; btn.style.opacity = '.6'; btn.innerHTML = '送出中…';
  return () => { btn.disabled = wasDisabled; btn.style.opacity = op; btn.innerHTML = html; };
}

async function submitImageWork(btn) {
  const title = document.getElementById('new-image-title').value.trim();
  // 後端 author/caption 型別是 str（非 Optional），留白時送 '' 而非 null，否則 422（後端一樣把 '' 當佚名）
  const author = document.getElementById('new-image-author').value.trim();
  const caption = document.getElementById('new-image-caption').value.trim();
  const characters = readChars('new-image-chars');
  if (!_imgWork.data) { toast('請先選擇一幅畫作'); return; }
  if (!title) { toast('請輸入畫作標題'); return; }
  if (!characters.length && currentUser.role !== 'super_admin') { toast('請至少為畫作選一位角色'); return; }
  if (_uploadBusy) return;   // 防連點：上一筆還在送就忽略
  _uploadBusy = true;
  const _restore = _btnBusy(btn);
  const hint = document.getElementById('new-image-hint');
  if (hint) hint.textContent = '正在上傳畫作…';
  try {
    const srcSel = document.getElementById('new-image-source');
    const source_auth_id = (srcSel && srcSel.closest('#new-image-source-row').style.display !== 'none' && srcSel.value) || null;
    const res = await api('/novels/image', { method: 'POST', body: JSON.stringify({
      title, author, caption, frame: _imgWork.frame, characters, image: _imgWork.data, source_auth_id }) });
    toast(res && res.status === 'pending' ? '已送出，待管理員審核' : '畫作已送出');
    _imgWork.data = null; _imgWork.frame = 'ebony';
    ['new-image-title', 'new-image-author', 'new-image-caption'].forEach(id => document.getElementById(id).value = '');
    prefillAuthor('new-image-author');   // 清空後重新帶回暱稱（同小說）
    document.querySelectorAll('#new-image-chars .opt.on').forEach(el => el.classList.remove('on'));
    document.querySelectorAll('#image-frame-picker .frame-swatch').forEach(el => el.classList.toggle('sel', el.dataset.frame === 'ebony'));
    const wrap = document.getElementById('image-preview-wrap'); wrap.style.display = 'none'; wrap.innerHTML = '';
    document.getElementById('image-drop').textContent = '選擇畫作';
    _myAuths = null; renderImageSourceRow();   // 掛了源自的授權信已用掉，下拉重整
  } catch (e) { toast(e.message); }
  finally { _uploadBusy = false; _restore(); if (hint) hint.textContent = ''; }
}

// ── 授權信：文字作者與製圖師的雙向授權（一來一回即封緘，不是對話）──────────
// use_image＝作者借畫作文首圖（綁定一篇已完成、尚未發佈的文章）；derive_art＝製圖師為文作畫。
// 信箱：writer 在編輯部「授權」分頁；admin 併入「審核」分頁的授權信膠囊。
let _myAuths = null;          // {sent, received} 快取；寄信／裁決後設 null 重抓
let _authBoxEl = null;        // 最後渲染的信箱容器 id（裁決後原地重畫）
function _isWriterPlus() { return currentUser && ['writer', 'admin', 'super_admin'].includes(currentUser.role); }
async function loadMyAuths(force) {
  if (!_isWriterPlus()) return { sent: [], received: [] };
  if (_myAuths && !force) return _myAuths;
  try { _myAuths = await api('/authorizations/mine') || { sent: [], received: [] }; }
  catch (e) { _myAuths = { sent: [], received: [] }; }
  return _myAuths;
}
const AUTH_STATUS = { pending: '待回覆', approved: '已同意', declined: '已婉拒' };
// 信件一句話摘要。received=true 用「你的」視角。
function _authSummary(a, received) {
  const art = escapeHtml(a.artwork_title || '畫作');
  const wk = escapeHtml(a.work_title || '文章');
  if (a.direction === 'use_image') {
    return received
      ? `<b>${escapeHtml(a.requester_name)}</b> 想將你的畫作《${art}》用作《${wk}》的文首圖`
      : `你向 <b>${escapeHtml(a.recipient_name)}</b> 請求《${art}》的文首圖授權（用於《${wk}》）`;
  }
  return received
    ? `<b>${escapeHtml(a.requester_name)}</b> 想為你的文章《${wk}》作衍生畫作`
    : `你向 <b>${escapeHtml(a.recipient_name)}</b> 請求為《${wk}》作畫的授權`;
}
async function renderAuthMailbox(elId) {
  const el = document.getElementById(elId); if (!el) return;
  _authBoxEl = elId;
  el.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';
  const box = await loadMyAuths(true);
  const admin = isAdminUser();
  const noteLine = (t, label) => (t || '').trim()
    ? `<div style="font-size:12px;color:var(--ink-light);margin-top:4px;padding-left:8px;border-left:2px solid var(--gold-lt)">${label}「${escapeHtml(t.trim())}」</div>` : '';
  const badge = a => `<span style="font-size:11px;padding:1px 8px;border-radius:9px;background:${a.status === 'approved' ? 'rgba(45,74,30,.15)' : a.status === 'declined' ? 'rgba(122,42,42,.12)' : 'rgba(160,130,60,.18)'};color:${a.status === 'approved' ? 'var(--series)' : a.status === 'declined' ? 'var(--accent)' : 'var(--ink-light)'}">${AUTH_STATUS[a.status] || ''}</span>`;
  const thumb = a => a.artwork_url ? `<img src="${escapeHtml(a.artwork_url)}" alt="" style="width:46px;height:60px;object-fit:cover;border-radius:3px;border:3px solid var(--gold-lt);flex-shrink:0" />` : '';
  const card = (a, received) => {
    const acts = [];
    if (received && a.status === 'pending') {
      acts.push(`<button data-onclick="openAuthDecide('${a.id}', false)" style="flex:1;font-size:12px;padding:6px;border:1px solid var(--gold);background:none;color:var(--ink-light);border-radius:6px;cursor:pointer">婉拒</button>`);
      acts.push(`<button data-onclick="openAuthDecide('${a.id}', true)" style="flex:1;font-size:12px;padding:6px;border:1px solid #2d4a1e;background:#2d4a1e;color:#e9f0dd;border-radius:6px;cursor:pointer">同意授權</button>`);
    }
    if (!received && a.status === 'pending') {
      acts.push(`<button data-onclick="withdrawAuth('${a.id}')" style="font-size:12px;padding:6px 14px;border:1px solid var(--ink-light);background:none;color:var(--ink-light);border-radius:6px;cursor:pointer">撤回</button>`);
    }
    if (admin && received && a.status === 'declined') {
      acts.push(`<button data-onclick="adminResetAuth('${a.id}')" style="font-size:12px;padding:6px 14px;border:1px solid var(--accent);background:none;color:var(--accent);border-radius:6px;cursor:pointer">刪除信（允許重寄）</button>`);
    }
    const inUse = a.direction === 'use_image' && a.status === 'approved' && a.in_use
      ? `<span style="font-size:11px;padding:1px 8px;border-radius:9px;background:rgba(160,130,60,.18);color:var(--ink-light)">畫作使用中</span>` : '';
    return `<div style="background:var(--parchment2);border:1px solid var(--gold-lt);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;gap:10px">
      ${thumb(a)}
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;line-height:1.6">${_authSummary(a, received)} ${badge(a)} ${inUse}</div>
        ${noteLine(a.note, '附言：')}
        ${noteLine(a.reply_note, '回覆：')}
        <div style="font-size:11px;color:var(--ink-light);margin-top:4px">${fmtUpdated(a.created_at)}</div>
        ${acts.length ? `<div style="display:flex;gap:8px;margin-top:8px">${acts.join('')}</div>` : ''}
      </div>
    </div>`;
  };
  const sec = (title, rows, received) => `
    <div style="font-size:13px;font-weight:bold;margin:14px 0 8px">${title}<span style="font-weight:normal;color:var(--ink-light)">（${rows.length}）</span></div>
    ${rows.length ? rows.map(a => card(a, received)).join('') : '<p style="font-size:12.5px;color:var(--ink-light);padding:2px 0 6px">目前沒有信件</p>'}`;
  el.innerHTML = sec('收到的信', box.received || [], true) + sec('寄出的信', box.sent || [], false);
}
// 審核分頁的膠囊：待審作品 ⇄ 授權信（僅管理員）
function setReviewMode(mode) {
  const auths = mode === 'auths';
  const pw = document.getElementById('review-pill-works'), pa = document.getElementById('review-pill-auths');
  if (pw) pw.classList.toggle('active', !auths);
  if (pa) pa.classList.toggle('active', auths);
  const note = document.getElementById('review-works-note');
  if (note) note.style.display = auths ? 'none' : '';
  document.getElementById('admin-review-list').style.display = auths ? 'none' : '';
  document.getElementById('admin-review-auths').style.display = auths ? '' : 'none';
  if (auths) renderAuthMailbox('admin-review-auths');
}
// 寫信彈窗
let _authReqCtx = null;
async function openAuthRequest(direction, targetId, targetTitle, targetOwnerName) {
  const mine = await loadMyAuths(true);   // 強制重抓：對方同意/婉拒發生在別的 session，快取不會自己更新
  const dupe = (mine.sent || []).find(a => a.direction === direction
    && (direction === 'use_image' ? a.artwork_id === targetId : a.work_id === targetId));
  if (dupe) {
    toast(dupe.status === 'pending' ? '授權信已寄出，等待對方回覆'
      : dupe.status === 'approved' ? '你已獲得這件作品的授權'
      : '這封授權信曾被婉拒，無法重寄');
    return;
  }
  _authReqCtx = { direction, targetId };
  const head = document.getElementById('auth-req-target');
  if (head) head.innerHTML = direction === 'use_image'
    ? `向 <b>${escapeHtml(targetOwnerName || '作者')}</b> 請求畫作《${escapeHtml(targetTitle || '')}》的文首圖授權`
    : `向 <b>${escapeHtml(targetOwnerName || '作者')}</b> 請求為《${escapeHtml(targetTitle || '')}》作衍生畫作的授權`;
  const row = document.getElementById('auth-req-work-row');
  const send = document.getElementById('auth-req-send');
  const hint = document.getElementById('auth-req-work-hint');
  const sel = document.getElementById('auth-req-work');
  const note = document.getElementById('auth-req-note');
  if (note) note.value = '';
  if (direction === 'use_image') {
    row.style.display = '';
    sel.style.display = ''; hint.style.display = 'none'; send.disabled = true;
    sel.innerHTML = '<option>載入中…</option>';
    document.getElementById('auth-request-modal').classList.add('open');
    let works = [];
    try { works = await api('/authorizations/eligible-works') || []; } catch (e) {}
    if (!works.length) { sel.style.display = 'none'; hint.style.display = ''; send.disabled = true; return; }
    sel.innerHTML = works.map(w => `<option value="${w.id}">《${escapeHtml(w.title)}》${w.status === 'approved' ? '' : '（待發佈）'}</option>`).join('');
    send.disabled = false;
  } else {
    row.style.display = 'none'; send.disabled = false;
    document.getElementById('auth-request-modal').classList.add('open');
  }
}
async function sendAuthRequest() {
  if (!_authReqCtx) return;
  const { direction, targetId } = _authReqCtx;
  const body = { direction, target_id: targetId, note: (document.getElementById('auth-req-note').value || '').trim() };
  if (direction === 'use_image') {
    const wid = document.getElementById('auth-req-work').value;
    if (!wid) { toast('請選擇要用這幅畫的文章'); return; }
    body.work_id = wid;
  }
  try {
    await api('/authorizations/', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('auth-request-modal').classList.remove('open');
    _authReqCtx = null; _myAuths = null;
    toast('授權信已寄出');
    if (_galleryDetailItem) renderGdAuth(_galleryDetailItem);   // 詳情卡開著就更新鈕狀態
  } catch (e) { toast(e.message); }
}
// 裁決彈窗（同意／婉拒各可附一句話）
let _authDecideCtx = null;
function openAuthDecide(id, approve) {
  _authDecideCtx = { id, status: approve ? 'approved' : 'declined' };
  const t = document.getElementById('auth-decide-title');
  const s = document.getElementById('auth-decide-sub');
  const c = document.getElementById('auth-decide-confirm');
  if (t) t.textContent = approve ? '同意這封授權信' : '婉拒這封授權信';
  if (s) s.textContent = approve ? '同意後，對方即可依信上所寫使用你的作品。' : '婉拒後對方無法再為同一件作品寄信。';
  if (c) c.textContent = approve ? '同意授權' : '確定婉拒';
  const note = document.getElementById('auth-decide-note'); if (note) note.value = '';
  document.getElementById('auth-decide-modal').classList.add('open');
}
async function saveAuthDecide() {
  if (!_authDecideCtx) return;
  try {
    await api(`/authorizations/${_authDecideCtx.id}`, { method: 'PATCH', body: JSON.stringify({
      status: _authDecideCtx.status, reply_note: (document.getElementById('auth-decide-note').value || '').trim() }) });
    document.getElementById('auth-decide-modal').classList.remove('open');
    toast(_authDecideCtx.status === 'approved' ? '已同意授權' : '已婉拒');
    _authDecideCtx = null; _myAuths = null;
    if (_authBoxEl) renderAuthMailbox(_authBoxEl);
  } catch (e) { toast(e.message); }
}
async function withdrawAuth(id) {
  if (!confirm('撤回這封授權信？')) return;
  try { await api(`/authorizations/${id}`, { method: 'DELETE' }); _myAuths = null; toast('已撤回'); if (_authBoxEl) renderAuthMailbox(_authBoxEl); }
  catch (e) { toast(e.message); }
}
async function adminResetAuth(id) {
  if (!confirm('刪除這封信？刪除後對方可以重新寄一封。')) return;
  try { await api(`/authorizations/${id}`, { method: 'DELETE' }); _myAuths = null; toast('已刪除'); if (_authBoxEl) renderAuthMailbox(_authBoxEl); }
  catch (e) { toast(e.message); }
}
// 留影詳情卡：請求授權鈕（writer 以上、非擁有者）＋「授權予／源自」連結
async function renderGdAuth(it) {
  const al = document.getElementById('gd-authlinks');
  if (al) {
    const links = it.auth_links || [];
    if (links.length) {
      al.style.display = '';
      al.innerHTML = links.map(l =>
        `<a href="#" data-onclick="galleryOpenWork('${l.work_id}');return false" style="color:var(--accent)">${l.kind === 'source' ? '源自' : '授權予'}《${escapeHtml(l.work_title)}》</a>`).join('　');
    } else { al.style.display = 'none'; al.innerHTML = ''; }
  }
  const b = document.getElementById('gd-auth'); if (!b) return;
  const isOwner = currentUser && (it.owners || []).includes(currentUser.id);
  if (!_isWriterPlus() || isOwner) { b.style.display = 'none'; return; }
  b.style.display = '';
  b.disabled = true; b.textContent = '請求授權';
  b.setAttribute('data-onclick', '');
  const mine = await loadMyAuths(true);   // 強制重抓：對方同意/婉拒發生在別的 session，快取不會自己更新
  if (!_galleryDetailItem || _galleryDetailItem.id !== it.id) return;   // 已切到別幅
  const dupe = (mine.sent || []).find(a => a.direction === 'use_image' && a.artwork_id === it.id);
  if (dupe) {
    b.textContent = dupe.status === 'pending' ? '授權信已寄出' : dupe.status === 'approved' ? '已獲授權' : '已婉拒';
    b.disabled = true; b.style.opacity = '.6';
  } else {
    b.disabled = false; b.style.opacity = '';
    b.setAttribute('data-onclick', 'galleryAuthAsk()');   // 標題含引號會弄壞屬性傳參，改由全域讀
  }
}
function galleryAuthAsk() {
  const it = _galleryDetailItem; if (!it) return;
  openAuthRequest('use_image', it.id, it.title || '', it.author || '佚名');
}
function galleryOpenWork(id) { closeGalleryDetail(); openNovel(id); }
// 閱讀器篇末：向文章作者請求衍生創作授權
function readerAuthClick() {
  const t = window._readerAuthTarget; if (!t) return;
  openAuthRequest('derive_art', t.id, t.title, t.author);
}
// 編輯視窗：本篇的「獲授權畫作」區（僅信上那一篇看得到；選用＝掛成文首圖）
async function renderEditAuthArts() {
  const box = document.getElementById('editwork-auth-arts'); if (!box) return;
  box.style.display = 'none'; box.innerHTML = '';
  if (!editWork.id || editWork.kind !== 'novel') return;
  // 依「這篇文章」抓已同意的文首圖授權（不論登入者是不是當初的請求人）——擁有者／管理員都能代選。
  // 後端 for-work 端點還沒部署時，退回舊行為（強制重抓自己寄出的信）。
  let grants = [];
  try {
    grants = await api(`/authorizations/for-work/${editWork.id}`) || [];
  } catch {
    const mine = await loadMyAuths(true);
    grants = (mine.sent || []).filter(a => a.direction === 'use_image' && a.status === 'approved' && a.work_id === editWork.id);
  }
  if (!grants.length) return;
  box.style.display = '';
  box.innerHTML = '<div style="font-size:12px;color:var(--ink-light);margin-bottom:6px">獲授權畫作（僅限本篇）</div>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap">'
    + grants.map(a => {
      const inUse = a.artwork_url && editWork.headerUrl === a.artwork_url;
      return `<div style="text-align:center">
        <img src="${escapeHtml(a.artwork_url || '')}" alt="" style="width:64px;height:84px;object-fit:cover;border-radius:3px;border:3px solid ${inUse ? 'var(--gold)' : 'var(--gold-lt)'}" />
        <div style="margin-top:4px">${inUse
          ? '<span style="font-size:11px;color:var(--series)">使用中</span>'
          : `<button data-onclick="applyAuthArt('${a.id}')" style="font-size:11px;padding:3px 12px;border:1px solid var(--gold);background:none;color:var(--ink-light);border-radius:4px;cursor:pointer">選用</button>`}</div>
      </div>`;
    }).join('') + '</div>';
}
async function applyAuthArt(authId) {
  try {
    const r = await api(`/authorizations/${authId}/apply`, { method: 'POST' });
    editWork.headerUrl = r.image_url;
    renderEditHeaderPreview(r.image_url);
    _syncAdminNovelField(editWork.id, 'image_url', r.image_url);
    _syncAdminNovelField(editWork.id, 'image_caption', r.image_caption);
    _myAuths = null;
    renderEditAuthArts();
    toast('已掛上獲授權的畫作');
  } catch (e) { toast(e.message); }
}
// 上傳畫作的「源自」下拉：只列自己已同意、還沒掛過畫的 derive_art 授權信
async function renderImageSourceRow() {
  const row = document.getElementById('new-image-source-row'); if (!row) return;
  row.style.display = 'none';
  const mine = await loadMyAuths(true);   // 強制重抓：對方同意/婉拒發生在別的 session，快取不會自己更新
  const opts = (mine.sent || []).filter(a => a.direction === 'derive_art' && a.status === 'approved' && !a.artwork_id);
  if (!opts.length) return;
  row.style.display = '';
  document.getElementById('new-image-source').innerHTML = '<option value="">不掛（一般投稿）</option>'
    + opts.map(a => `<option value="${a.id}">源自《${escapeHtml(a.work_title || '')}》</option>`).join('');
}

// ── 羊皮紙頁：收藏夾旁的小藥丸切換 論壇 ⇄ 留影走廊（僅管理員可見）──
function toggleForumMode() {
  setForumMode(forumTab === 'gallery' ? 'forum' : 'gallery');
}
function showGalleryPage(btn) {
  showPage('forum', btn);      // 進羊皮紙頁容器 + nav 高亮到「留影」
  setForumMode('gallery');     // 立刻切留影（同步隱藏論壇部分，不閃）
}
function setForumMode(mode) {
  const isGallery = mode === 'gallery';
  forumTab = mode;   // 唯一寫入點：之後 toggleForumFav / toggleCharAnd 都讀這個，不看 DOM
  document.getElementById('forum-normal').style.display = isGallery ? 'none' : '';
  document.getElementById('forum-gallery').style.display = isGallery ? '' : 'none';
  // 木紋牆鋪到滾動容器：留影走廊模式下連 .page 底部留白與 overscroll 回彈都是木紋，不露羊皮紙底
  const pa = document.getElementById('page-area'); if (pa) pa.classList.toggle('gallery-bg', isGallery);
  if (isGallery) galleryView = 'all';   // 進留影走廊一律回「全部」檢視（與羊皮紙進頁行為一致）
  const fav = document.getElementById('forum-fav-btn');
  if (fav) fav.classList.toggle('on', isGallery ? false : forumView === 'liked');
  const title = document.getElementById('forum-title');
  if (title) title.innerHTML = isGallery
    ? ic('ic-gallery', 20).replace('-2px', '-3px') + ' 留影走廊'
    : ic('ic-scroll', 20).replace('-2px', '-3px') + ' 匿名羊皮紙';
  const pill = document.getElementById('forum-gallery-toggle');
  if (pill) {
    pill.innerHTML = isGallery ? ic('ic-scroll', 15) + ' 羊皮紙' : ic('ic-gallery', 15) + ' 留影走廊';
    pill.style.display = 'none';   // 留影已是獨立 nav 入口（正式版），頁頂藥丸不再需要
  }
  if (isGallery) loadGallery();
}

let _galleryItems = [];
let galleryChars = [];      // 留影走廊角色篩選（同羊皮紙：不亮 = 全部；亮 = OR，同框開啟 = AND）
let galleryView = 'all';    // 'all' | 'fav'
let forumTab = 'forum';     // 羊皮紙頁目前分頁：'forum' | 'gallery'。setForumMode 是唯一寫入點，
                            // 其餘地方一律讀這個變數判斷模式，不再嗅探 DOM 的 display 狀態。

function onGalleryFilter(type, val) {
  galleryChars = galleryChars.includes(val) ? galleryChars.filter(c => c !== val) : [...galleryChars, val];
  renderGallery();
}

function toggleGalleryFav() {
  // 收藏夾鈕：不在收藏夾 → 進「已收藏」；已在收藏夾（含已隱藏子分頁）→ 回全部
  galleryView = (galleryView === 'fav' || galleryView === 'hidden') ? 'all' : 'fav';
  renderGallery();
}
// 收藏夾內的小分頁：已收藏 ⇄ 已隱藏（已隱藏＝回收站，在詳情卡取消隱藏可找回）。高亮交給 renderGallery。
function setGalleryView(v) { galleryView = v; renderGallery(); }
async function loadGallery() {
  const wall = document.getElementById('gallery-wall');
  wall.style.columns = '1';
  wall.innerHTML = '<div class="spinner"></div>';
  try {
    _galleryItems = (await api('/novels/gallery', { background: true })) || [];
    renderGallery();
  } catch (e) { wall.innerHTML = '<div class="gwall-empty">載入失敗</div>'; }
}

function renderGallery() {
  const wall = document.getElementById('gallery-wall');
  const inFav = galleryView === 'fav';
  const inHidden = galleryView === 'hidden';
  const chromeOff = inFav || inHidden;   // 收藏夾／已隱藏檢視都收起角色列（同羊皮紙）
  const favBtn = document.getElementById('forum-fav-btn'); if (favBtn) favBtn.classList.toggle('on', chromeOff);
  const favTabs = document.getElementById('gallery-fav-tabs');
  if (favTabs) {
    favTabs.style.display = chromeOff ? 'flex' : 'none';
    const gf = document.getElementById('gtab-fav'); if (gf) gf.classList.toggle('on', inFav);
    const gh = document.getElementById('gtab-hidden'); if (gh) gh.classList.toggle('on', inHidden);
  }
  const fb = document.getElementById('gallery-filter-bar');
  if (fb) {
    fb.style.display = chromeOff ? 'none' : '';
    if (!chromeOff) {
      const chipEl = document.getElementById('gallery-char-chips');
      chipEl.innerHTML = CHAR_LIST.map(ch =>
        `<div class="char-chip ${galleryChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}">
           <img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span>
         </div>`).join('');
      chipEl.querySelectorAll('.char-chip').forEach(el => el.onclick = () => officialCharTap(el.dataset.ch, onGalleryFilter));
      mountCharAndBtn('gallery-char-and');
    }
  }
  const hid = hiddenGallery();
  const notHidden = it => !hid.has(photoKey(it.image_url));
  const items = inHidden
    ? _galleryItems.filter(it => hid.has(photoKey(it.image_url)))
    : inFav
      ? _galleryItems.filter(it => favIds.has(it.id)).filter(notHidden)
      : applyClassFilter(_galleryItems, '', galleryChars).filter(notHidden);
  if (!items.length) {
    wall.style.columns = '1';
    const msg = inHidden
      ? '沒有已隱藏的畫作<br><small>在畫作詳情點眼睛鈕，就能把不想看到的圖藏起來</small>'
      : inFav
        ? '你還沒收藏任何畫作<br><small>打開畫作詳情，點標題旁的 ☆ 就能收進這裡</small>'
        : (_galleryItems.length ? '沒有符合篩選的畫作' : '留影走廊還空著，等待第一幅畫作掛上牆。');
    wall.innerHTML = `<div class="gwall-empty">${msg}</div>`;
    return;
  }
  wall.style.columns = '';   // 交回 CSS 的雙欄
  // 組圖：all 檢視下同系列收成一組，只露首圖（series_order 最小）當封面、角標顯示張數。
  // 收藏／已隱藏檢視不分組（那是個人挑選，可能只含組內部分），一張張列。
  let cells;
  if (chromeOff) {
    cells = items.map(it => ({ rep: it, count: 1 }));
  } else {
    const seen = new Set();
    cells = [];
    items.forEach(it => {
      if (it.series) {
        // 綁原投稿者(created_by)：同名系列但不同投稿者不混組（擋撞名）
        const gkey = it.series + '\u0000' + (it.created_by || '');
        if (seen.has(gkey)) return;
        seen.add(gkey);
        const members = items.filter(x => x.series === it.series && x.created_by === it.created_by).sort((x, y) => (x.series_order || 0) - (y.series_order || 0));
        cells.push({ rep: members[0], count: members.length });
      } else {
        cells.push({ rep: it, count: 1 });
      }
    });
  }
  const _stackBadge = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15l5-5 4 4"/></svg>`;
  wall.innerHTML = cells.map(cell => {
    const it = cell.rep;
    const fr = GALLERY_FRAMES.some(([c]) => c === it.image_frame) ? it.image_frame : 'ebony';
    const grp = cell.count > 1;
    return `<div class="gwall-item${grp ? ' gwall-stack' : ''}" data-onclick="openGalleryItem('${it.id}')">
      <div class="gframe fr-${fr}"><img src="${escapeHtml(it.image_url)}" alt="${escapeHtml(it.title || '')}" loading="lazy" /></div>
      ${grp ? `<div class="gstack-badge">${_stackBadge}${cell.count}</div>` : ''}
    </div>`;
  }).join('');
  // 圖載到才淡入（配 CSS 的 3:4 佔位畫框）；載失敗也解除佔位，避免永遠空框
  wall.querySelectorAll('.gframe img').forEach(img => {
    const done = () => img.classList.add('g-ld');
    if (img.complete && img.naturalWidth) done();
    else { img.addEventListener('load', done); img.addEventListener('error', done); }
  });
}

let _galleryDetailItem = null;   // 詳情卡目前開的畫作（下載鈕用）
let _galleryGroup = [];        // 目前詳情卡所屬系列的成員（依 series_order）；單張時就一個元素
let _galleryGroupIdx = 0;
let _gdFromAdmin = false;   // 詳情卡是不是從作品管理開的（決定要不要顯示時段/裁切等策展工具）
function openGalleryItem(id, fromAdmin) {
  const it = _galleryItems.find(x => x.id === id) || (window._adminNovels || []).find(x => x.id === id);
  if (!it) return;
  _gdFromAdmin = !!fromAdmin;
  _galleryDetailItem = it;
  // 組圖：同系列成員（依 series_order；隱藏的不算入組），供詳情卡左右切換
  const hid = hiddenGallery();
  _galleryGroup = it.series
    ? _galleryItems.filter(x => x.series === it.series && x.created_by === it.created_by && !hid.has(photoKey(x.image_url))).sort((x, y) => (x.series_order || 0) - (y.series_order || 0))
    : [it];
  _galleryGroupIdx = Math.max(0, _galleryGroup.findIndex(x => x.id === it.id));
  const sEl = document.getElementById('gd-series');
  if (sEl) {
    if (_galleryGroup.length > 1) {
      sEl.style.display = 'flex';
      sEl.innerHTML = `<button class="gd-snav" data-onclick="galleryGroupNav(-1)" aria-label="上一幅">‹</button>`
        + `<span class="gd-stxt">系列《<b>${escapeHtml(it.series)}</b>》· 第 <b>${_galleryGroupIdx + 1}</b> / ${_galleryGroup.length} 幅</span>`
        + `<button class="gd-snav" data-onclick="galleryGroupNav(1)" aria-label="下一幅">›</button>`;
    } else { sEl.style.display = 'none'; sEl.innerHTML = ''; }
  }
  updateGdFavBtn();
  const fr = GALLERY_FRAMES.some(([c]) => c === it.image_frame) ? it.image_frame : 'ebony';
  const frameEl = document.getElementById('gd-frame');
  frameEl.className = 'gd-frame fr-' + fr;
  document.getElementById('gd-img').src = it.image_url;
  document.getElementById('gd-title').textContent = it.title || '';
  document.getElementById('gd-author').textContent = it.author ? ('— ' + it.author) : '— 佚名';
  document.getElementById('gd-chars').innerHTML = (it.characters || []).map(c => charPill(c)).join('');
  const cap = document.getElementById('gd-caption');
  cap.textContent = it.image_caption || ''; cap.style.display = it.image_caption ? '' : 'none';
  renderGdAuth(it);   // 授權信：請求授權鈕＋「授權予／源自」連結
  renderGdHideBtn();
  renderGdRetractBtn();   // 超管退件鈕（退回待審）
  const adminBox = document.getElementById('gd-admin');
  const adminish = currentUser && ['admin', 'super_admin'].includes(currentUser.role);
  const isOwner = currentUser && (it.owners || []).includes(currentUser.id);
  // 時段是策展動作，只有管理員能排；裁切框是作者對自己作品的顯示調整，作者或管理員都能開。
  if (_gdFromAdmin && (adminish || isOwner)) {
    const cur = effectiveImageSlot(it);
    const slots = [['am', '早晨'], ['pm', '下午'], ['night', '夜晚']];
    const slotBox = adminish
      ? '<div style="font-size:12px;color:var(--ink-light);margin-bottom:6px">心動封面時段</div>'
        + '<div style="display:flex;gap:8px">' + slots.map(([v, n]) =>
          `<button data-onclick="setImageSlot('${it.id}','${v}')" style="flex:1;font-size:12px;padding:6px;border:1px solid var(--gold);border-radius:4px;cursor:pointer;background:${cur === v ? 'var(--scarlet)' : 'var(--parchment2)'};color:${cur === v ? 'var(--on-dark)' : 'var(--ink-light)'}">${n}</button>`).join('') + '</div>'
      : '';
    adminBox.style.display = '';
    adminBox.innerHTML = slotBox
      + `<button data-onclick="openCoverCrop('${escapeHtml(it.image_url)}')" style="width:100%;margin-top:${adminish ? '8px' : '0'};font-size:12px;padding:7px;border:1px solid var(--gold);border-radius:4px;cursor:pointer;background:var(--parchment2);color:var(--ink-light)">調整心動封面顯示（裁切框）</button>`;
  } else { adminBox.style.display = 'none'; }
  document.getElementById('gallery-detail').style.display = 'flex';
}
// 詳情卡的「隱藏／取消隱藏」眼睛鈕：把不喜歡的畫作從留影走廊牆與心動封面一起藏起（只影響本人）。
const _EYE_OFF = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
const _EYE_ON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
function renderGdHideBtn() {
  const b = document.getElementById('gd-hide');
  if (!b) return;
  const it = _galleryDetailItem;
  if (!it || !it.image_url) { b.style.display = 'none'; return; }
  const hidden = hiddenGallery().has(photoKey(it.image_url));
  b.style.display = 'inline-flex';
  b.innerHTML = hidden ? `${_EYE_ON} 取消隱藏` : `${_EYE_OFF} 從留影走廊隱藏`;
  b.style.color = hidden ? 'var(--accent)' : 'var(--ink-light)';
  b.style.borderColor = hidden ? 'var(--accent)' : 'var(--ink-light)';
}
// 超管退件鈕：把這幅已通過的畫作退回待審（下架＋回審核佇列，作者可修改重送）。只有超管看得到；
// 牆上的圖都是已審核（/novels/gallery 只回 approved、item 無 status 欄），從作品管理開的則看 status。
function renderGdRetractBtn() {
  const b = document.getElementById('gd-retract');
  if (!b) return;
  const it = _galleryDetailItem;
  const isSuper = currentUser && currentUser.role === 'super_admin';
  const approved = it && (it.status === undefined || it.status === 'approved');
  if (isSuper && it && approved) {
    b.style.display = 'inline-flex';
    b.innerHTML = `${ic('ic-clock', 13)} 退件（退回待審）`;
  } else {
    b.style.display = 'none';
  }
}
async function toggleHideGalleryImage() {
  const it = _galleryDetailItem;
  if (!it || !it.image_url) return;
  const key = photoKey(it.image_url);
  const set = hiddenGallery();
  const wasHidden = set.has(key);
  if (wasHidden) set.delete(key); else set.add(key);
  try {
    const r = await api('/auth/me/hidden-gallery', { method: 'PATCH', body: JSON.stringify({ keys: [...set] }) });
    if (currentUser) currentUser.hidden_gallery = (r && r.hidden_gallery) || '';
    renderGdHideBtn();
    toast(wasHidden ? '已取消隱藏' : '已從留影走廊隱藏');
    // 隱藏一張圖 = 牆上與心動封面都要更新
    renderGallery();
    if (typeof renderGreeting === 'function') renderGreeting();
    if (wasHidden ? false : galleryView !== 'hidden') closeGalleryDetail();   // 剛隱藏就關卡片（牆上已撤下）
  } catch (e) { toast(e.message); }
}
// 詳情卡標題旁的 ☆：收藏整幅畫作，走與意若思鏡整篇收藏相同的 /novels/{id}/favorite。
function updateGdFavBtn() {
  const b = document.getElementById('gd-fav');
  if (!b || !_galleryDetailItem) return;
  const fav = favIds.has(_galleryDetailItem.id);
  b.innerHTML = fav ? ic('ic-starfill', 22) : ic('ic-starline', 22);
  b.style.color = fav ? 'var(--gold)' : 'var(--gold-lt)';
}
async function toggleGalleryFavorite() {
  if (!_galleryDetailItem) return;
  const id = _galleryDetailItem.id;
  // 樂觀更新：先翻星星＋火花，讓點擊即時有反應；失敗再回滾（不然等 API 來回感覺很鈍）
  const wasFav = favIds.has(id);
  const nowFav = !wasFav;
  if (nowFav) favIds.add(id); else favIds.delete(id);
  updateGdFavBtn();
  if (nowFav) likeBurst(document.getElementById('gd-fav'));
  try {
    const r = await api(`/novels/${id}/favorite`, { method: 'POST' });
    // 以伺服器實際結果為準（極少數與樂觀值不一致時校正）
    if (r.favorited) favIds.add(id); else favIds.delete(id);
    updateGdFavBtn();
    toast(r.favorited ? '已加入收藏夾' : '已從收藏夾移除');
    if (galleryView === 'fav') renderGallery();   // 收藏夾檢視中取消收藏 → 即時從牆上撤下
  } catch (e) {
    if (wasFav) favIds.add(id); else favIds.delete(id);   // 回滾
    updateGdFavBtn();
    toast(e.message);
  }
}
// 下載畫作：即時把金色徽記壓進圖檔（右下角、寬 40%、邊距 2%，與全螢幕觀看一致），
// 再走與心動桌布相同的 分享/下載 流程。跨來源圖（Supabase Storage）需 crossOrigin。
function _loadImgCors(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im); im.onerror = reject;
    im.src = src;
  });
}
async function downloadGalleryImage() {
  const it = _galleryDetailItem;
  if (!it || !it.image_url) return;
  try {
    const [img, logo] = await Promise.all([_loadImgCors(it.image_url), _loadImgCors('./assets/watermark_logo.png')]);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const lw = Math.max(40, Math.round(c.width * 0.30));
    const lh = Math.round(logo.naturalHeight * lw / logo.naturalWidth);
    const pad = Math.round(c.width * 0.02);
    ctx.globalAlpha = 0.95;
    ctx.drawImage(logo, c.width - lw - pad, c.height - lh - pad, lw, lh);
    ctx.globalAlpha = 1;
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('no blob');
    const url = URL.createObjectURL(blob);
    try { await shareOrDownload(url, '預言家日報-' + (it.title || '畫作') + '.jpg'); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
  } catch (e) { toast('下載失敗，請稍後再試'); }
}

function galleryGroupNav(dir) {
  const g = _galleryGroup;
  if (!g || g.length < 2) return;
  const i = (_galleryGroupIdx + dir + g.length) % g.length;   // 循環
  openGalleryItem(g[i].id, _gdFromAdmin);
}
function closeGalleryDetail() { document.getElementById('gallery-detail').style.display = 'none'; }
let _fullGroupOn = false;   // 這次全螢幕是不是留影走廊組圖（決定要不要顯示左右箭頭）
function openGalleryFull() { openImageFull(document.getElementById('gd-img').src, true); }
// 組內切換（左右按鈕，非滑動——與全站慣例一致）：切到同組上一/下一幅，循環。
function galleryFullNav(dir) {
  if (!_fullGroupOn) return;
  const g = _galleryGroup;
  if (!g || g.length < 2) return;
  const i = (_galleryGroupIdx + dir + g.length) % g.length;
  openGalleryItem(g[i].id, _gdFromAdmin);   // 更新詳情卡與 _galleryGroupIdx
  openGalleryFull();          // 用新的 gd-img 重繪全螢幕（維持組模式＝箭頭續顯示）
}
// 任意圖片全螢幕（右下角金色徽記浮水印，即時疊、不改檔案）；留影走廊詳情與角色頁封面共用。
// fromGallery=true 且該畫屬於多幅組圖時，顯示組內切換箭頭；角色頁封面等直接呼叫（無箭頭）。
function openImageFull(src, fromGallery, hideMark) {
  _fullGroupOn = !!fromGallery && Array.isArray(_galleryGroup) && _galleryGroup.length > 1;
  const mark = document.getElementById('gf-mark');   // 審核看大圖時隱藏浮水印，看清畫作
  if (mark) mark.style.display = hideMark ? 'none' : '';
  const prev = document.getElementById('gf-prev'), next = document.getElementById('gf-next');
  if (prev) prev.style.display = _fullGroupOn ? 'flex' : 'none';
  if (next) next.style.display = _fullGroupOn ? 'flex' : 'none';
  const img = document.getElementById('gf-img');
  const stage = document.getElementById('gf-stage');
  // 橫幅圖＋直式螢幕：把整個 stage（圖＋右下角浮水印）旋 90° 填滿螢幕（旋轉後 pre-rotation 寬對到螢幕高、高對到螢幕寬）
  const applyRot = () => {
    const landscape = img.naturalWidth > img.naturalHeight;
    const portraitScreen = window.innerHeight > window.innerWidth;
    if (landscape && portraitScreen) {
      img.style.maxWidth = '100vh'; img.style.maxHeight = '100vw';
      stage.style.transform = 'rotate(90deg)';
    } else {
      img.style.maxWidth = '100vw'; img.style.maxHeight = '100vh';
      stage.style.transform = '';
    }
  };
  img.style.maxWidth = '100vw'; img.style.maxHeight = '100vh'; stage.style.transform = '';
  img.onload = applyRot;
  img.src = src;
  if (img.complete && img.naturalWidth) applyRot();
  document.getElementById('gallery-full').style.display = 'flex';
}
function closeGalleryFull() { document.getElementById('gallery-full').style.display = 'none'; }
// 審核畫作：點縮圖看全螢幕大圖（單張、無組導覽、無浮水印，方便看清品質再決定通過）
function openReviewImage(id) {
  const n = (window._reviewPending || []).find(x => x.id === id);
  if (!n || !n.image_url) return;
  _galleryGroup = [];
  openImageFull(n.image_url, false, true);
}

// ── 心動封面裁切框編輯器 ────────────────────────────────────────────────────
// 拖動＋縮放（同頭像裁切的手感，但方框、非破壞性）。存的是 z,x,y（見 loadCoverCrops 註解）。
// 權限由後端把關；前端只對「有入口鈕的圖」開這個編輯器。
const _ccrop = { url: null, nw: 0, nh: 0, fw: 0, fh: 0, scale: 0, minScale: 0, tx: 0, ty: 0 };
function openCoverCrop(url) {
  if (!url) return;
  _ccrop.url = url;
  const modal = document.getElementById('cover-crop-modal');
  const imgEl = document.getElementById('cc-img');
  const im = new Image();
  im.onload = () => {
    _ccrop.nw = im.naturalWidth; _ccrop.nh = im.naturalHeight;
    _imgNat[photoKey(url)] = { w: im.naturalWidth, h: im.naturalHeight };
    imgEl.src = url;
    imgEl.style.width = im.naturalWidth + 'px';
    imgEl.style.height = im.naturalHeight + 'px';
    modal.classList.add('open');
    requestAnimationFrame(_ccrInit);   // 開窗後才量得到方框尺寸
  };
  im.onerror = () => toast('圖片讀取失敗');
  im.src = url;
}
function _ccrInit() {
  const frame = document.getElementById('cc-frame');
  const fw = frame.clientWidth, fh = frame.clientHeight;
  _ccrop.fw = fw; _ccrop.fh = fh;
  const cover = Math.max(fw / _ccrop.nw, fh / _ccrop.nh);
  _ccrop.minScale = cover;
  const existing = getCoverCrop(_ccrop.url);
  if (existing) {
    _ccrop.scale = cover * existing.z;
    _ccrop.tx = fw / 2 - existing.x * _ccrop.nw * _ccrop.scale;
    _ccrop.ty = fh / 2 - existing.y * _ccrop.nh * _ccrop.scale;
  } else {
    _ccrop.scale = cover;
    _ccrop.tx = (fw - _ccrop.nw * _ccrop.scale) / 2;
    _ccrop.ty = (fh - _ccrop.nh * _ccrop.scale) / 2;
  }
  _ccrClamp();
  document.getElementById('cc-zoom').value = (_ccrop.scale / _ccrop.minScale).toFixed(2);
  _ccrApply();
}
function _ccrApply() {
  document.getElementById('cc-img').style.transform = `translate(${_ccrop.tx}px, ${_ccrop.ty}px) scale(${_ccrop.scale})`;
}
function _ccrClamp() {
  const { fw, fh, scale, nw, nh } = _ccrop;
  _ccrop.tx = Math.min(0, Math.max(fw - nw * scale, _ccrop.tx));
  _ccrop.ty = Math.min(0, Math.max(fh - nh * scale, _ccrop.ty));
}
function ccrZoom(mult) {
  const { fw, fh } = _ccrop;
  const cx = (fw / 2 - _ccrop.tx) / _ccrop.scale, cy = (fh / 2 - _ccrop.ty) / _ccrop.scale;
  _ccrop.scale = _ccrop.minScale * parseFloat(mult);
  _ccrop.tx = fw / 2 - cx * _ccrop.scale; _ccrop.ty = fh / 2 - cy * _ccrop.scale;
  _ccrClamp(); _ccrApply();
}
function ccrDragStart(ev) {
  ev.preventDefault();
  const p = ev.touches ? ev.touches[0] : ev;
  let lastX = p.clientX, lastY = p.clientY;
  const move = (e) => {
    const q = e.touches ? e.touches[0] : e;
    _ccrop.tx += q.clientX - lastX; _ccrop.ty += q.clientY - lastY;
    lastX = q.clientX; lastY = q.clientY;
    _ccrClamp(); _ccrApply();
  };
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
}
function closeCoverCrop() { document.getElementById('cover-crop-modal').classList.remove('open'); }
async function saveCoverCrop() {
  const { fw, fh, scale, minScale, tx, ty, nw, nh, url } = _ccrop;
  if (!url || !scale) return;
  const z = Math.max(1, scale / minScale);
  const x = Math.min(1, Math.max(0, (fw / 2 - tx) / (scale * nw)));
  const y = Math.min(1, Math.max(0, (fh / 2 - ty) / (scale * nh)));
  const crop = `${z.toFixed(3)},${x.toFixed(4)},${y.toFixed(4)}`;
  try {
    await api('/novels/cover-crops', { method: 'PATCH', body: JSON.stringify({ image_url: url, crop }) });
    _coverCrops[photoKey(url)] = crop;
    closeCoverCrop();
    toast('已更新心動封面顯示');
    _afterCropChange(url);
  } catch (e) { toast(e.message); }
}
async function clearCoverCrop() {
  const url = _ccrop.url;
  if (!url) return;
  try {
    await api('/novels/cover-crops', { method: 'PATCH', body: JSON.stringify({ image_url: url, crop: null }) });
    delete _coverCrops[photoKey(url)];
    closeCoverCrop();
    toast('已清除裁切框');
    _afterCropChange(url);
  } catch (e) { toast(e.message); }
}
function _afterCropChange(url) {
  document.querySelectorAll('#cp-body .cp-shot[data-full]').forEach(el => {
    if (photoKey(el.dataset.full) === photoKey(url)) applyCoverCropToEl(el, el.dataset.full);
  });
  if (typeof renderGreeting === 'function') renderGreeting(false);   // 心動 hero 依新框重繪同一張，不重抽
}

async function setImageSlot(id, slot) {
  try {
    await api(`/novels/${id}/image-slot`, { method: 'PATCH', body: JSON.stringify({ slot }) });
    // 更新所有可能持有這件作品的快取，讓高亮即時反映（含審核清單 _reviewPending——沒更新它，
    // 審核頁選了時段按鈕不會高亮，看起來像沒反應；approveNovel 的必選檢查也會讀到舊值）。
    [_galleryDetailItem, ...(_galleryItems || []), ...(window._adminNovels || []), ...(window._reviewPending || [])]
      .forEach(o => { if (o && o.id === id) o.image_slot = slot; });
    // 審核清單：就地重刷這列三顆時段鈕的高亮（不整個重載、不閃 spinner）。
    document.querySelectorAll(`#admin-review-list button[data-onclick^="setImageSlot('${id}'"]`).forEach(btn => {
      const m = (btn.getAttribute('data-onclick') || '').match(/,'(\w+)'\)/);
      const on = m && m[1] === slot;
      btn.style.background = on ? 'var(--scarlet)' : 'var(--parchment2)';
      btn.style.color = on ? 'var(--on-dark)' : 'var(--ink-light)';
    });
    // 留影走廊詳情卡若正開著這件作品 → 重繪它的高亮（審核清單的項目不在詳情卡快取裡，不會誤開浮層）。
    if (_galleryDetailItem && _galleryDetailItem.id === id && document.getElementById('gallery-detail')?.style.display === 'flex') {
      openGalleryItem(id, _gdFromAdmin);
    }
    loadHomeGalleryCovers();   // 立刻反映到心動封面池
    toast('已設定心動封面時段');
  } catch (e) { toast(e.message); }
}

// Turn a <input type="date"> value (YYYY-MM-DD) into an instant anchored at NOON Taipei (UTC+8) of
// that day — independent of the author's browser timezone. The backend gates 上架/排程 on the TW
// date, and fmtUpdated() displays in TW too, so the chosen day IS the day everyone sees and the day
// it goes live (at 00:00 TW). Anchoring at noon keeps it clear of the midnight boundary. A US-East
// author picking the 11th no longer stores their local-midnight (which read as the 10th elsewhere).
// 12:00 +08:00 == 04:00 UTC.
function dateToIso(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day, 4, 0, 0)).toISOString();
}
function isFutureIso(ts) { return !!ts && new Date(ts) > new Date(); }

// ── Upload draft autosave ────────────────────────────────────
// Keeps the in-progress 上傳 form in localStorage so a self-heal reload or token
// logout never loses a half-written chapter. Saved on edit, restored on tab open,
// cleared on successful submit.
const DRAFT_KEY = 'pd_upload_draft';
const _dval = id => { const e = document.getElementById(id); return e ? e.value : ''; };
const _dset = (id, v) => { const e = document.getElementById(id); if (e) e.value = v || ''; };
function _setChars(divId, arr) {
  document.querySelectorAll(`#${divId} .opt`).forEach(el => el.classList.toggle('on', (arr || []).includes(el.dataset.ch)));
}
function currentUploadKind() {
  return document.getElementById('upload-kind-forum').style.display === 'none' ? 'novel' : 'forum';
}
let _draftTimer;
function initUploadDraftWatch() {
  const pane = document.getElementById('admin-upload');
  if (!pane || pane.dataset.draftWatch) return;
  pane.dataset.draftWatch = '1';
  const trig = () => { clearTimeout(_draftTimer); _draftTimer = setTimeout(saveUploadDraft, 400); };
  pane.addEventListener('input', trig);
  pane.addEventListener('change', trig);
  pane.addEventListener('click', e => { if (e.target.classList?.contains('opt')) trig(); });  // character chips
}
function saveUploadDraft() {
  const d = {
    kind: currentUploadKind(), ts: Date.now(),
    novel: { title: _dval('new-novel-title'), author: _dval('new-novel-author'), date: _dval('new-novel-date'),
             content: _dval('new-novel-content'), category: _dval('new-novel-category'), chars: readChars('new-novel-chars') },
    forum: { title: _dval('forum-post-title'), author: _dval('forum-post-author'), date: _dval('forum-post-date'),
             content: _dval('forum-post-content'), comments: _dval('forum-post-comments'),
             category: _dval('forum-post-category'), chars: readChars('forum-post-chars') },
  };
  const has = o => o.title || o.content || o.comments;
  if (!has(d.novel) && !has(d.forum)) { localStorage.removeItem(DRAFT_KEY); return; }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}
function restoreUploadDraft() {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
  const banner = document.getElementById('upload-draft-banner');
  const meaningful = d && ((d.novel && (d.novel.title || d.novel.content)) || (d.forum && (d.forum.title || d.forum.content || d.forum.comments)));
  if (!meaningful) { if (banner) banner.style.display = 'none'; return; }
  setUploadKind(d.kind || 'novel');   // renders pickers + sets kind/visibility first
  if (d.novel) { _dset('new-novel-title', d.novel.title); _dset('new-novel-author', d.novel.author); _dset('new-novel-date', d.novel.date);
                 _dset('new-novel-content', d.novel.content); _dset('new-novel-category', d.novel.category); _setChars('new-novel-chars', d.novel.chars); }
  if (d.forum) { _dset('forum-post-title', d.forum.title); _dset('forum-post-author', d.forum.author); _dset('forum-post-date', d.forum.date);
                 _dset('forum-post-content', d.forum.content); _dset('forum-post-comments', d.forum.comments);
                 _dset('forum-post-category', d.forum.category); _setChars('forum-post-chars', d.forum.chars); }
  if (banner) banner.style.display = 'flex';
}
function clearUploadDraft() {
  localStorage.removeItem(DRAFT_KEY);
  const banner = document.getElementById('upload-draft-banner'); if (banner) banner.style.display = 'none';
}
function discardUploadDraft() {
  clearUploadDraft();
  ['new-novel-title', 'new-novel-author', 'new-novel-date', 'new-novel-content'].forEach(id => _dset(id, ''));
  resetClassPicker('new-novel-category', 'new-novel-chars');
  ['forum-post-title', 'forum-post-author', 'forum-post-date', 'forum-post-content', 'forum-post-comments'].forEach(id => _dset(id, ''));
  resetClassPicker('forum-post-category', 'forum-post-chars');
  setUploadKind('novel');
  toast('已清空草稿');
}

async function submitForumPost(btn) {
  const title = document.getElementById('forum-post-title').value.trim();
  const author = document.getElementById('forum-post-author').value.trim() || null;
  const main = document.getElementById('forum-post-content').value.trim();
  const replies = document.getElementById('forum-post-comments').value.trim();
  // Store as one body: 主文 (intro) then the 留言區 floors; the reader parser splits them.
  const content = replies ? (main + '\n' + replies) : main;
  const published_at = dateToIso(document.getElementById('forum-post-date').value);
  const characters = readChars('forum-post-chars');
  if (!title) { toast('請輸入貼文標題'); return; }
  if (!main) { toast('請輸入主文'); return; }
  if (_uploadBusy) return;   // 防連點：上一筆還在送就忽略
  _uploadBusy = true;
  const _restore = _btnBusy(btn);
  try {
    const res = await api('/novels/forum', { method: 'POST', body: JSON.stringify({ title, author, content, published_at, characters }) });
    toast(res.status === 'pending' ? '已送出，待管理員審核' : '貼文已發佈');
    document.getElementById('forum-post-title').value = '';
    document.getElementById('forum-post-author').value = '';
    document.getElementById('forum-post-date').value = '';
    document.getElementById('forum-post-content').value = '';
    document.getElementById('forum-post-comments').value = '';
    resetClassPicker(null, 'forum-post-chars');
    clearUploadDraft();
  } catch (e) { toast(e.message); }
  finally { _uploadBusy = false; _restore(); }
}

async function loadReviewList() {
  const el = document.getElementById('admin-review-list');
  // 記住各區目前的展開狀態：按「通過/不通過」重畫列表時原樣還原，不會自己收合。
  const prevOpen = {};
  el.querySelectorAll('details.review-sec').forEach(d => {
    const t = (d.querySelector('summary') || {}).textContent || '';
    prevOpen[t.includes('迷情劑') ? 'mqj' : 'novel'] = d.open;
  });
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [pending, users] = await Promise.all([
      api('/novels/pending').catch(() => []),
      api('/permissions/users').catch(() => []),
    ]);
    const mqjReqs = (users || []).filter(u => u.mqj_access === 'pending');
    const novelsPending = pending || [];
    window._reviewPending = novelsPending;
    const arrow = `<svg class="rv-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
    const section = (icon, title, count, bodyHtml, open) => `
      <details class="review-sec"${open ? ' open' : ''}>
        <summary>${arrow}${ic(icon, 14)} ${title}<span class="rv-count${count ? '' : ' zero'}">${count}</span></summary>
        <div class="rv-body">${count ? bodyHtml : '<p style="color:var(--ink-light);font-size:13px;padding:8px 0 14px">目前沒有待審核的項目</p>'}</div>
      </details>`;

    const mqjBody = mqjReqs.map(u => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(26,10,0,.1)">
          <div style="font-size:14px;font-weight:bold">${escapeHtml(u.nickname || u.username)} <span style="font-size:12px;color:var(--ink-light);font-weight:normal">@${escapeHtml(u.username)}</span></div>
          <div style="font-size:12px;color:var(--ink-light);margin-top:3px">申請閱讀「迷情劑」分類${(u.mqj_request_count || 0) > 1 ? `・第 ${u.mqj_request_count} 次申請` : ''}${u.mqj_rejected_at ? `・上次未通過：${fmtUpdated(u.mqj_rejected_at)}` : ''}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button data-onclick="reviewMqj('${u.id}', true)" style="font-size:12px;padding:4px 12px;background:#2d4a1e;border:none;color:#fff;border-radius:3px;cursor:pointer">${ic('ic-check',12)} 通過</button>
            <button data-onclick="reviewMqj('${u.id}', false)" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-x',12)} 不通過</button>
          </div>
        </div>`).join('');

    const _kindTag = n => n.kind === 'image' ? ic('ic-gallery', 12) + ' 畫作'
                        : n.kind === 'forum' ? ic('ic-scroll', 12) + ' 論壇貼文'
                        : ic('ic-book', 12) + ' 小說';
    const _slotBtns = n => { const slots = [['am', '早晨'], ['pm', '下午'], ['night', '夜晚']]; const cur = effectiveImageSlot(n);
      return '<div style="font-size:12px;color:var(--ink-light);margin:8px 0 4px">心動封面時段（必選）</div><div style="display:flex;gap:6px">'
        + slots.map(([v, name]) => `<button data-onclick="setImageSlot('${n.id}','${v}')" style="flex:1;font-size:12px;padding:5px;border:1px solid var(--gold);border-radius:4px;cursor:pointer;background:${cur === v ? 'var(--scarlet)' : 'var(--parchment2)'};color:${cur === v ? 'var(--on-dark)' : 'var(--ink-light)'}">${name}</button>`).join('') + '</div>'; };
    const novelBody = novelsPending.map(n => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(26,10,0,.1)">
          <div style="font-size:14px;font-weight:bold">${escapeHtml(n.title)}</div>
          <div style="font-size:12px;color:var(--ink-light);margin-top:3px">${_kindTag(n)}・${escapeHtml(n.author || '匿名')}・${fmtUpdated(n.created_at)}</div>
          ${n.kind === 'image' && n.image_url ? `<div style="margin-top:8px"><img src="${escapeHtml(n.image_url)}" alt="" data-onclick="openReviewImage('${n.id}')" style="max-width:160px;max-height:180px;border-radius:6px;cursor:zoom-in" title="點擊看大圖" /></div>` : ''}
          <div class="row-tags" style="margin-top:6px">
            ${n.category ? `<span class="t-cat${catCls(n.category)}">${escapeHtml(n.category)}</span>` : ''}
            ${(n.characters || []).map(c => charPill(c)).join('')}
          </div>
          ${n.kind === 'image' ? _slotBtns(n) : ''}
          <div style="display:flex;gap:8px;margin-top:8px">
            ${n.kind === 'image' ? '' : `<button data-onclick="openNovel('${n.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">預覽</button>`}
            <button data-onclick="approveNovel('${n.id}')" style="font-size:12px;padding:4px 12px;background:#2d4a1e;border:none;color:#fff;border-radius:3px;cursor:pointer">${ic('ic-check',12)} 通過</button>
            <button data-onclick="rejectNovel('${n.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">${ic('ic-x',12)} 退回修改</button>
            <button data-onclick="deleteNovel('${n.id}', true)" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-trash',12)} 刪除</button>
          </div>
        </div>`).join('');

    // 首次載入：迷情劑預設收起、作品審核有件數才展開；重畫（審核操作後）：還原剛才的狀態。
    const mqjOpen = prevOpen.mqj !== undefined ? prevOpen.mqj : false;
    const novelOpen = prevOpen.novel !== undefined ? prevOpen.novel : novelsPending.length > 0;
    el.innerHTML = section('ic-wine', '迷情劑閱讀權申請', mqjReqs.length, mqjBody, mqjOpen)
                 + section('ic-book', '作品審核', novelsPending.length, novelBody, novelOpen);
  } catch (e) { el.innerHTML = '<p>載入失敗</p>'; }
}

async function reviewMqj(userId, approve) {
  try {
    await api(`/permissions/users/${userId}/mqj`, { method: 'PATCH', body: JSON.stringify({ access: approve ? 'approved' : 'rejected' }) });
    toast(approve ? '已通過迷情劑申請' : '已標記為不通過');
    loadReviewList();
  } catch (e) { toast(e.message); }
}

async function approveNovel(id) {
  const n = (window._reviewPending || []).find(x => x.id === id);
  if (n && n.kind === 'image' && !['am', 'pm', 'night'].includes(n.image_slot)) {
    toast('請先為這幅畫作選擇心動封面時段，再通過');
    return;
  }
  try { await api(`/novels/${id}/approve`, { method: 'PATCH' }); toast('已通過審核'); loadReviewList(); }
  catch (e) { toast(e.message); }
}
// 退回修改（不刪除）：開彈窗讓管理員留一段修改建議給作者，標記 rejected 退回作者的作品管理。
let _rejectingId = null;
function rejectNovel(id) {
  const n = (window._reviewPending || []).find(x => x.id === id);
  _rejectingId = id;
  document.getElementById('reject-note-work').textContent = `《${(n && n.title) || '這篇稿件'}》`;
  const ta = document.getElementById('reject-note-text'); ta.value = '';
  document.getElementById('reject-note-count').textContent = '0';
  document.getElementById('reject-note-modal').classList.add('open');
  setTimeout(() => ta.focus(), 50);
}
function updateRejectCount() {
  const ta = document.getElementById('reject-note-text');
  document.getElementById('reject-note-count').textContent = ta ? ta.value.length : 0;
}
async function saveRejectNote() {
  if (!_rejectingId) return;
  const note = document.getElementById('reject-note-text').value.trim();
  try {
    await api(`/novels/${_rejectingId}/reject`, { method: 'PATCH', body: JSON.stringify({ note }) });
    document.getElementById('reject-note-modal').classList.remove('open');
    toast(note ? '已退回，並附上修改建議' : '已退回作者修改');
    _rejectingId = null;
    loadReviewList();
  } catch (e) { toast(e.message); }
}
// 作者把已退回的稿重新送審（rejected→pending）。
async function resubmitNovel(id) {
  const title = (adminWorkById(id).title) || '這篇作品';
  if (!confirm(`把《${title}》重新送審？\n\n將回到審核佇列，等管理員再次審核。`)) return;
  try {
    await api(`/novels/${id}/resubmit`, { method: 'PATCH' });
    toast('已重新送審，等待審核');
    loadAdminNovelList();
  } catch (e) { toast(e.message || '重送失敗'); }
}

// Create a single-piece novel: work metadata + body text in one shot (body becomes chapter 1).
async function submitNewNovel(btn) {
  const title = document.getElementById('new-novel-title').value.trim();
  const content = document.getElementById('new-novel-content').value.trim();
  const category = document.getElementById('new-novel-category').value;
  if (!title) { toast('請輸入作品名稱'); return; }
  if (!category) { toast('請選擇故事類型'); return; }
  if (!content) { toast('請輸入內文'); return; }
  if (!readChars('new-novel-chars').length && currentUser.role !== 'super_admin') { toast('請至少為作品選一位角色'); return; }
  if (_uploadBusy) return;   // 防連點：上一筆還在送就忽略
  _uploadBusy = true;
  const _restore = _btnBusy(btn);
  try {
    const novel = await api('/novels/', { method: 'POST', body: JSON.stringify({
      title,
      author: document.getElementById('new-novel-author').value.trim() || null,
      published_at: dateToIso(document.getElementById('new-novel-date').value),
      category,
      characters: readChars('new-novel-chars'),
    }) });
    try {
      await api(`/chapters/novel/${novel.id}/text`, { method: 'POST', body: JSON.stringify({ chapter_num: 1, title: null, content }) });
    } catch (chErr) {
      // Compensate: the novel row exists but its first chapter failed — delete the orphan so we
      // never leave a chapterless draft, then surface the error.
      try { await api(`/novels/${novel.id}`, { method: 'DELETE' }); } catch (_e) {}
      throw chErr;
    }
    // 頁首圖：作品建立後才有 id，補 PATCH 上傳（失敗不擋作品建立，提示即可）
    if (_novelHeader.data) { try { await api(`/novels/${novel.id}/header-image`, { method: 'PATCH', body: JSON.stringify({ image: _novelHeader.data }) }); } catch (e) { toast('頁首圖上傳失敗：' + (e.message || '')); } }
    toast(novel.status === 'pending' ? '已送出，待管理員審核' : '小說已建立');
    ['new-novel-title', 'new-novel-author', 'new-novel-date', 'new-novel-content'].forEach(id => document.getElementById(id).value = '');
    prefillAuthor('new-novel-author');   // 清空後重新帶回暱稱：連續上傳系列時署名保持一致，免重打（避免手滑打錯）
    clearNovelHeader();
    document.querySelectorAll('#new-novel-cc .cc-pick.on').forEach(b => b.classList.remove('on'));
    resetClassPicker('new-novel-category', 'new-novel-chars');
    clearUploadDraft();
    loadNovels();
  } catch (e) { toast(e.message); }
  finally { _uploadBusy = false; _restore(); }
}

async function loadAdminNovelList() {
  const el = document.getElementById('admin-novel-list');
  const note = document.getElementById('admin-novel-scope-note');
  el.innerHTML = '<div class="spinner"></div>';
  adminKind = ''; adminCat = ''; adminChars = [];   // fresh load → start unfiltered
  { const _s = document.getElementById('admin-novel-search'); if (_s) _s.value = ''; }
  document.getElementById('admin-novel-filters').style.display = 'none';
  const isAdmin = ['admin', 'super_admin'].includes(currentUser.role);
  try {
    let ns;
    if (adminNovelScope) {
      // Admin viewing a member's detail (entered by tapping their name in 用戶管理).
      const all = await api('/novels/') || [];
      ns = all.filter(n => (n.owners || []).includes(adminNovelScope.id));
      const sc = adminNovelScope;
      let head = `${ic('ic-books', 16)} <b>${escapeHtml(sc.name)}</b> 的作品　<a data-onclick="resetAdminNovelScope('users')" style="color:var(--accent);cursor:pointer">← 返回成員名單</a>`;
      if (sc.joined) head += `<div style="font-size:12px;color:var(--ink-light);margin-top:4px">${ic('ic-calendar',12)} 加入日期 ${fmtUpdated(sc.joined)}</div>`;
      if (sc.role === 'reader' || sc.role === 'writer') {
        const approved = sc.mqj === 'approved';
        const statusLabel = sc.mqj === 'pending' ? '（' + ic('ic-clock',11) + ' 申請中）' : sc.mqj === 'rejected' ? '（' + ic('ic-ban',11) + ' 未通過）' : '';
        head += `<div style="display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 0;border-top:1px solid rgba(26,10,0,.08)">
          <span style="font-size:13px;color:var(--ink-light)">${ic('ic-wine',13)} 迷情劑閱讀權${statusLabel}</span>
          <label class="toggle green" style="flex-shrink:0">
            <input type="checkbox" ${approved ? 'checked' : ''} data-onchange="setMqjAccess('${sc.id}',this.checked)" />
            <span class="slider"></span>
          </label>
        </div>`;
      }
      if (sc.role === 'writer') {
        head += `<div style="display:flex;align-items:center;gap:10px;margin-top:8px;padding:8px 0;border-top:1px solid rgba(26,10,0,.08)">
          <span style="font-size:13px;color:var(--ink-light)">${ic('ic-check',13)} 自動審核<span style="opacity:.7">（開啟後此作家發文免審核、直接公開）</span></span>
          <label class="toggle green" style="flex-shrink:0">
            <input type="checkbox" ${sc.auto ? 'checked' : ''} data-onchange="setAutoPublish('${sc.id}',this.checked)" />
            <span class="slider"></span>
          </label>
        </div>
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(26,10,0,.08)">
          <span style="font-size:13px;color:var(--ink-light)">${ic('ic-megaphone',13)} 許願池回覆權<span style="opacity:.7">（開啟後此作家可回覆許願、標記「考慮中」；不能婉拒）</span></span>
          <label class="toggle green" style="flex-shrink:0">
            <input type="checkbox" ${sc.wish ? 'checked' : ''} data-onchange="setWishReply('${sc.id}',this.checked)" />
            <span class="slider"></span>
          </label>
        </div>`;
      }
      const RANK = { reader: 0, writer: 1, admin: 2, super_admin: 3 };
      const isSuper = currentUser.role === 'super_admin';
      // Admins (and the owner) may act only on a strictly lower rank — never each other or the owner.
      const canAct = sc.id !== currentUser.id && (RANK[currentUser.role] || 0) > (RANK[sc.role] || 0);
      if (canAct) {
        const tempActive = sc.banned && sc.ban_until && new Date(sc.ban_until) > new Date();
        const permActive = sc.banned && !sc.ban_until;
        const sTemp = 'font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink);border-radius:3px;cursor:pointer';
        const sBan = 'font-size:12px;padding:4px 12px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer';
        let banBtns;
        if (permActive) {
          // Permanent ban: only the owner can release it.
          banBtns = isSuper
            ? `<button data-onclick="banUser('${sc.id}',1)" style="${sBan}">${ic('ic-check',12)} 解除永久封禁</button>`
            : `<span style="font-size:12px;color:var(--accent);align-self:center">${ic('ic-ban',12)} 已永久封禁（需擁有者解除）</span>`;
        } else if (tempActive) {
          banBtns = `<button data-onclick="tempBan('${sc.id}',0)" style="${sBan}">${ic('ic-check',12)} 解除臨時封禁</button>`
            + (isSuper ? `<button data-onclick="banUser('${sc.id}',0)" style="${sBan}">${ic('ic-ban',12)} 改為永久封禁</button>` : '');
        } else {
          banBtns = `<button data-onclick="tempBan('${sc.id}',1,24)" style="${sTemp}">${ic('ic-clock',12)} 臨時封禁 24 小時</button>`
            + `<button data-onclick="tempBan('${sc.id}',1,72)" style="${sTemp}">${ic('ic-clock',12)} 臨時封禁 72 小時</button>`
            + (isSuper ? `<button data-onclick="banUser('${sc.id}',0)" style="${sBan}">${ic('ic-ban',12)} 永久封禁</button>` : '');
        }
        // 封存：非懲罰、可復原（gold 邊框，與 scarlet 刪除區分）。作者不玩了時優雅停用、保留作品。
        const archiveBtn = isSuper
          ? (sc.archived
             ? `<button data-onclick="archiveUser('${sc.id}',0)" style="${sTemp}">${ic('ic-check',12)} 取消封存</button>`
             : `<button data-onclick="archiveUser('${sc.id}',1)" style="${sTemp}">${ic('ic-moon',12)} 封存帳號</button>`)
          : '';
        head += `<div style="display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(26,10,0,.08);flex-wrap:wrap">`
          + (isSuper ? `<button data-onclick="resetPassword('${sc.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">${ic('ic-key',12)} 重設密碼</button>` : '')
          + banBtns
          + archiveBtn
          + (isSuper ? `<button data-onclick="deleteUser('${sc.id}')" style="font-size:12px;padding:4px 12px;background:var(--scarlet);border:none;color:var(--on-dark);border-radius:3px;cursor:pointer">${ic('ic-trash',12)} 刪除帳號</button>` : '')
          + `</div>`;
        if (tempActive) head += `<div style="font-size:12px;color:var(--accent);margin-top:8px">${ic('ic-clock',12)} 臨時封禁中，${new Date(sc.ban_until).toLocaleString('zh-TW')} 自動解除</div>`;
        if (sc.archived) head += `<div style="font-size:12px;color:var(--ink-light);margin-top:8px">${ic('ic-moon',12)} 此帳號已封存——無法登入，作品與資料保留中，可隨時取消封存恢復。</div>`;
        if (isSuper) head += `<div style="font-size:12px;color:var(--ink-light);margin-top:8px">${ic('ic-shield',12)} 水印碼 <code style="font-size:12px;color:var(--ink)">${wmCode(sc.id)}</code><span style="opacity:.7"> — 迷情劑外流截圖上的代碼對得上此人</span></div>`;
      }
      note.innerHTML = head;
    } else {
      ns = await api('/novels/?mine=true') || [];
      note.textContent = '';
    }
    window._adminNovels = ns;
    renderAdminNovels();
  } catch { el.innerHTML = '<p>載入失敗</p>'; }
}

// 作品管理篩選：種類分頁（全部/小說/羊皮紙/留影）＋ 分類子篩（僅小說）＋ 標題/作者搜尋 ＋ 角色。
function adminIsNovelKind(n) { return n.kind !== 'forum' && n.kind !== 'image'; }
function applyAdminFilter(list) {
  const sel = adminChars.filter(Boolean);
  const noFilter = sel.length === 0 || (!charAnd && sel.length === CHAR_LIST.length);
  const q = ((document.getElementById('admin-novel-search') || {}).value || '').trim().toLowerCase();
  return list.filter(n => {
    // 種類分頁
    if (adminKind === 'forum') { if (n.kind !== 'forum') return false; }
    else if (adminKind === 'image') { if (n.kind !== 'image') return false; }
    else if (adminKind === 'novel') { if (!adminIsNovelKind(n)) return false; }
    // 分類子篩（僅小說種類）
    if (adminKind === 'novel' && adminCat && n.category !== adminCat) return false;
    // 搜尋（標題／作者）
    if (q && !(((n.title || '') + ' ' + (n.author || '')).toLowerCase().includes(q))) return false;
    if (!noFilter) {
      const have = n.characters || [];
      const checks = sel.map(c => have.includes(c));
      const ok = charAnd ? checks.every(Boolean) : checks.some(Boolean);
      if (!ok) return false;
    }
    return true;
  });
}
function renderAdminFilterBar(ns) {
  const wrap = document.getElementById('admin-novel-filters');
  if (!wrap) return;
  const sbar = document.getElementById('admin-novel-searchbar');
  if (!ns.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; if (sbar) sbar.style.display = 'none'; return; }
  if (sbar) sbar.style.display = '';
  // 種類分頁（附件數，件數為名下總數、不受其他篩選影響）
  const counts = { novel: 0, forum: 0, image: 0 };
  ns.forEach(n => { if (n.kind === 'forum') counts.forum++; else if (n.kind === 'image') counts.image++; else counts.novel++; });
  // 沒有「全部」pill：不選任何種類 = 全部；再點亮著的 pill 取消回全部
  const KINDS = [['novel', 'ic-book', '小說', counts.novel], ['forum', 'ic-scroll', '羊皮紙', counts.forum], ['image', 'ic-gallery', '留影', counts.image]];
  const showCat = adminKind === 'novel';
  wrap.style.display = 'block';
  wrap.innerHTML = `<div class="admin-kind-row">${KINDS.map(([k, icn, label, cnt]) =>
      `<button class="kind-pill ${adminKind === k ? 'active' : ''}" data-k="${k}">${ic(icn, 14)} ${label} <span class="cnt">${cnt}</span></button>`).join('')}</div>`
    + (showCat ? `<div class="filter-label">${ic('ic-sparkles', 12)} 分類</div><div class="cat-pills" id="admin-cat-pills"></div>` : '')
    + `<div class="filter-label" style="margin-top:8px;display:flex;align-items:center;gap:10px"><span>${ic('ic-sparkles', 12)} 角色</span><span id="admin-char-and"></span></div><div class="char-chips" id="admin-char-chips"></div>`;
  wrap.querySelectorAll('.kind-pill').forEach(b => b.onclick = () => {
    adminKind = (adminKind === b.dataset.k) ? '' : b.dataset.k;   // 再點同一顆 = 取消（回全部）
    if (adminKind !== 'novel') adminCat = '';   // 離開小說就清掉分類子篩
    renderAdminNovels();
  });
  if (showCat) {
    const catEl = document.getElementById('admin-cat-pills');
    catEl.innerHTML = ADMIN_CATS.map(c => `<button class="cat-pill ${adminCat === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('');
    catEl.querySelectorAll('.cat-pill').forEach(b => b.onclick = () => { adminCat = (adminCat === b.dataset.c) ? '' : b.dataset.c; renderAdminNovels(); });   // 再點同一顆 = 取消
  }
  const chipEl = document.getElementById('admin-char-chips');
  chipEl.innerHTML = CHAR_LIST.map(ch =>
    `<div class="char-chip ${adminChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}"><img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span></div>`).join('');
  chipEl.querySelectorAll('.char-chip[data-ch]').forEach(el => el.onclick = () => {
    adminChars = adminChars.includes(el.dataset.ch) ? adminChars.filter(c => c !== el.dataset.ch) : [...adminChars, el.dataset.ch];
    renderAdminNovels();
  });
  mountCharAndBtn('admin-char-and');
}

// Render the 作品管理 list from cached works, applying the filter. Filter clicks re-render
// (no re-fetch). renderAdminNovels reads window._adminNovels.
function renderAdminNovels() {
  const el = document.getElementById('admin-novel-list');
  const ns = window._adminNovels || [];
  const isAdmin = ['admin', 'super_admin'].includes(currentUser.role);
  renderAdminFilterBar(ns);
  const list = applyAdminFilter(ns);
  el.innerHTML = list.map(n => {
      const statusTag = (n.status === 'pending'
        ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.15);color:var(--accent)">' + ic('ic-clock',11) + ' 待審核</span>'
        : n.status === 'rejected'
        ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.28);color:var(--ink-light)">' + ic('ic-x',11) + ' 已退回·可修改重送</span>' : '')
        + (isFutureIso(n.created_at) ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(45,74,30,.15);color:var(--series)">' + ic('ic-clock',11) + ' 排程·' + fmtUpdated(n.created_at) + '公開</span>' : '');
      // 退件說明：管理員退回時留給作者的修改建議（只在已退回且有留言時顯示）。
      const rejectNoteRow = (n.status === 'rejected' && n.reject_note)
        ? `<div style="margin-top:6px;font-size:12.5px;color:var(--ink-light);background:rgba(201,168,76,.14);border-left:3px solid var(--gold);border-radius:4px;padding:7px 10px;line-height:1.7"><b style="color:var(--accent)">${ic('ic-edit',11)} 退件說明</b>　${escapeHtml(n.reject_note)}</div>`
        : '';
      // 編輯 is for everyone here (the list only shows works the viewer owns, or an admin's scoped view).
      const editBtn = `<button data-onclick="openEditWork('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">${ic('ic-edit',12)} 編輯</button>`;
      // Owners manage their own works (mine view) — admins also in the scoped member view.
      const canManage = isAdmin || !adminNovelScope;
      const manageBtns = canManage ? `
          <button data-onclick="openEditClass('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-tag',12)} 分類</button>
          <button data-onclick="openSeries('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--series);color:var(--series);border-radius:3px;cursor:pointer">${ic('ic-link',12)} 系列</button>` : '';
      const ownerAssignBtn = isAdmin ? `
          <button data-onclick="openOwners('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">${ic('ic-users',12)} 作者</button>` : '';
      const delBtn = canManage ? `
          <button data-onclick="deleteNovel('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-trash',12)} 刪除</button>` : '';
      // 鎖上：作者本人(owner)或超管才有；鎖住後其他人完全看不到這篇存在。
      const canLock = !adminNovelScope || currentUser.role === 'super_admin';
      const lockBtn = canLock ? `<button data-onclick="toggleLock('${n.id}', ${!n.locked})" style="font-size:12px;padding:3px 10px;background:none;border:1px solid ${n.locked ? 'var(--series)' : 'var(--accent)'};color:${n.locked ? 'var(--series)' : 'var(--accent)'};border-radius:3px;cursor:pointer">${ic('ic-key',12)} ${n.locked ? '解鎖' : '鎖上'}</button>` : '';
      // 退件：僅超管、且作品已通過（覆核其他管理員放行的作品，退回待審而非刪除）。
      const canRetract = currentUser.role === 'super_admin' && n.status === 'approved';
      const retractBtn = canRetract ? `<button data-onclick="retractNovel('${n.id}')" style="font-size:12px;padding:3px 10px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-clock',12)} 退件</button>` : '';
      // 重新送審：已退回的稿，作者（owner）或管理員可送回審核佇列（rejected→pending）。
      const canResubmit = n.status === 'rejected' && canManage;
      const resubmitBtn = canResubmit ? `<button data-onclick="resubmitNovel('${n.id}')" style="font-size:12px;padding:3px 10px;background:#2d4a1e;border:none;color:#fff;border-radius:3px;cursor:pointer">${ic('ic-check',12)} 重新送審</button>` : '';
      // 種類徽章配色：小說=紅、羊皮紙(論壇體)=黃、畫作=綠
      const badges = (n.kind === 'forum'
          ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.25);color:var(--ink-light)">' + ic('ic-scroll', 12) + ' 論壇體</span>'
          : n.kind === 'image'
          ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(45,74,30,.15);color:var(--series)">' + ic('ic-gallery', 12) + ' 畫作</span>'
          : '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.15);color:var(--accent)">' + ic('ic-book', 12) + ' 小說</span>')
        + statusTag
        + (n.is_guide ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.25);color:var(--ink-light)">' + ic('ic-book', 12) + ' 範例·可刪除</span>' : '')
        + (n.locked ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.2);color:var(--accent)">' + ic('ic-key',11) + ' 已鎖 · 唯你可見</span>' : '');
      const tags = (n.series ? `<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(45,74,30,.15);color:var(--series)">${escapeHtml(n.series)}${n.series_order ? ' #' + n.series_order : ''}</span>` : '')
        + (n.category ? `<span class="t-cat${catCls(n.category)}">${escapeHtml(n.category)}</span>` : '')
        + (n.characters || []).map(c => charPill(c)).join('');
      // 畫作：緊湊橫排卡 — 大縮圖靠左，資訊集中右側，動作列一排圖示圓鈕（省一半以上高度）
      if (n.kind === 'image') {
        // handler 必須寫成字面量（安全測試靜態掃 data-onclick），所以只抽共用的圓鈕樣式
        const ibs = (border, color) => `width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;background:none;border:1px solid ${border};color:${color};border-radius:50%;cursor:pointer;padding:0;flex-shrink:0`;
        const lockCol = n.locked ? 'var(--series)' : 'var(--accent)';
        const acts = `<button data-onclick="openEditWork('${n.id}')" aria-label="編輯" title="編輯" style="${ibs('var(--gold)', 'var(--ink-light)')}">${ic('ic-edit', 15)}</button>`
          + (canManage ? `<button data-onclick="openEditClass('${n.id}')" aria-label="分類" title="分類" style="${ibs('var(--accent)', 'var(--accent)')}">${ic('ic-tag', 15)}</button>
            <button data-onclick="openSeries('${n.id}')" aria-label="系列" title="系列" style="${ibs('var(--series)', 'var(--series)')}">${ic('ic-link', 15)}</button>` : '')
          + (isAdmin ? `<button data-onclick="openOwners('${n.id}')" aria-label="作者" title="作者" style="${ibs('var(--gold)', 'var(--ink-light)')}">${ic('ic-users', 15)}</button>` : '')
          + (canLock ? `<button data-onclick="toggleLock('${n.id}', ${!n.locked})" aria-label="${n.locked ? '解鎖' : '鎖上'}" title="${n.locked ? '解鎖' : '鎖上'}" style="${ibs(lockCol, lockCol)}">${ic('ic-key', 15)}</button>` : '')
          + (canResubmit ? `<button data-onclick="resubmitNovel('${n.id}')" aria-label="重新送審" title="重新送審" style="${ibs('var(--series)', 'var(--series)')}">${ic('ic-check', 15)}</button>` : '')
          + (canRetract ? `<button data-onclick="retractNovel('${n.id}')" aria-label="退件" title="退件（退回待審）" style="${ibs('var(--accent)', 'var(--accent)')}">${ic('ic-clock', 15)}</button>` : '')
          + (canManage ? `<button data-onclick="deleteNovel('${n.id}')" aria-label="刪除" title="刪除" style="${ibs('var(--accent)', 'var(--accent)')}">${ic('ic-trash', 15)}</button>` : '');
        return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08)">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <img src="${escapeHtml(n.image_url || '')}" alt="" data-onclick="openGalleryItem('${n.id}', true)" style="width:84px;height:84px;object-fit:cover;border-radius:6px;flex-shrink:0;cursor:pointer" />
          <div style="flex:1;min-width:0">
            <div style="display:flex;gap:5px;flex-wrap:wrap">${badges}</div>
            <div data-onclick="openGalleryItem('${n.id}', true)" style="font-size:14px;font-weight:bold;cursor:pointer;margin-top:3px">${escapeHtml(n.title)} <span style="font-size:11px;font-weight:normal;color:var(--accent)">${ic('ic-eye',11)} 預覽</span></div>
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px">${tags}</div>
            <div style="font-size:12px;color:var(--ink-light);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(n.author || '佚名')}${ownerTag(n)}${n.created_at ? ' · ' + ic('ic-calendar',11) + ' ' + fmtUpdated(n.created_at) : ''}</div>
          </div>
        </div>
        ${rejectNoteRow}
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${acts}</div>
      </div>`;
      }
      return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08)">
        <div style="margin-bottom:3px;display:flex;gap:5px;flex-wrap:wrap">${badges}</div>
        <div data-onclick="openNovel('${n.id}')" style="font-size:14px;font-weight:bold;cursor:pointer">${escapeHtml(n.title)} <span style="font-size:11px;font-weight:normal;color:var(--accent)">${ic('ic-eye',11)} 預覽</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px">${tags}</div>
        <div style="font-size:12px;color:var(--ink-light);margin-top:3px">${escapeHtml(n.author || '佚名')}${ownerTag(n)}</div>
        ${n.created_at ? `<div style="font-size:12px;color:var(--ink-light);margin-top:2px">${ic('ic-calendar',11)} 發佈日期 ${fmtUpdated(n.created_at)}</div>` : ''}
        ${rejectNoteRow}
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">${resubmitBtn}${editBtn}${manageBtns}${ownerAssignBtn}${lockBtn}${retractBtn}${delBtn}</div>
      </div>`;
    }).join('') || `<p style="color:#888;padding:14px;text-align:center">${ns.length ? '此篩選沒有作品' : '尚無作品'}</p>`;
}

// 作者把自己的作品鎖上：鎖住後除了作者本人和超管,其他人完全看不到這篇存在。
function adminWorkById(id) { return (window._adminNovels || []).find(n => n.id === id) || {}; }

async function toggleLock(id, locked) {
  const title = adminWorkById(id).title || '這篇作品';
  const msg = locked
    ? `鎖上《${title}》？\n\n鎖上後，這篇作品會從書架、搜尋與連結中隱去，只有你能看見。`
    : `解鎖《${title}》？\n\n解鎖後，這篇作品會恢復原本的公開狀態。`;
  if (!confirm(msg)) return;
  try {
    await api(`/novels/${id}/lock`, { method: 'PATCH', body: JSON.stringify({ locked }) });
    toast(locked ? '已鎖上' : '已解鎖');
    loadAdminNovelList();
  } catch (e) { toast('' + e.message); }
}

let ownersNovelId = null;

async function openOwners(novelId) {
  const work = adminWorkById(novelId);
  const title = work.title || '';
  const owners = work.owners || [];
  ownersNovelId = novelId;
  document.getElementById('transfer-novel-title').textContent = title || '';
  document.getElementById('transfer-modal').classList.add('open');
  const el = document.getElementById('transfer-user-list');
  el.innerHTML = '<div class="spinner"></div>';
  const owned = new Set(owners || []);
  try {
    const users = await api('/permissions/users') || [];
    // Only accounts that can own a work (writer+); readers can't be authors. Keep any
    // existing owner in the list so they can still be unchecked. Show nickname, no role.
    const canOwn = r => ['writer', 'admin', 'super_admin'].includes(r);
    el.innerHTML = users.filter(u => canOwn(u.role) || owned.has(u.id)).map(u => `
      <label class="user-row" style="cursor:pointer">
        ${avatarHTML(u, 32)}
        <div class="u-name" style="flex:1">${escapeHtml(u.nickname || u.username)}</div>
        <input type="checkbox" class="owner-cb" value="${u.id}" ${owned.has(u.id) ? 'checked' : ''} style="width:20px;height:20px;accent-color:var(--accent)" />
      </label>`).join('') || '<p style="color:#888;padding:20px">尚無可指定的作者</p>';
  } catch { el.innerHTML = '<p>載入失敗</p>'; }
}

async function saveOwners() {
  const owner_ids = [...document.querySelectorAll('#transfer-user-list .owner-cb:checked')].map(c => c.value);
  if (!owner_ids.length) { toast('至少要保留一位作者'); return; }
  try {
    await api(`/novels/${ownersNovelId}/owners`, { method: 'PATCH', body: JSON.stringify({ owner_ids }) });
    toast(`作者已更新（${owner_ids.length} 人）`);
    document.getElementById('transfer-modal').classList.remove('open');
    loadAdminNovelList();
  } catch (e) { toast(e.message); }
}

let seriesNovelId = null;

function openSeries(novelId) {
  const work = adminWorkById(novelId);
  const title = work.title || '';
  const series = work.series || '';
  const order = work.series_order || 0;
  seriesNovelId = novelId;
  document.getElementById('series-novel-title').textContent = title || '';
  document.getElementById('series-name-input').value = series || '';
  document.getElementById('series-order-input').value = order || 0;
  // suggest existing series names
  const names = [...new Set((window._adminNovels || []).map(n => n.series).filter(Boolean))];
  document.getElementById('series-name-list').innerHTML = names.map(s => `<option value="${escapeHtml(s)}">`).join('');
  document.getElementById('series-modal').classList.add('open');
}

async function saveSeries() {
  // 存乾淨的名字（外層《》剝掉）：《》由列表顯示層統一加，存了會變《《…》》
  const series = stripOuterBookQuotes(document.getElementById('series-name-input').value);
  const series_order = parseInt(document.getElementById('series-order-input').value) || 0;
  try {
    await api(`/novels/${seriesNovelId}/series`, { method: 'PATCH', body: JSON.stringify({ series: series || null, series_order }) });
    toast(series ? `已綁定系列「${series}」` : '已設為單篇');
    document.getElementById('series-modal').classList.remove('open');
    loadAdminNovelList(); loadNovels();
  } catch (e) { toast(e.message); }
}

let editClassNovelId = null;

function openEditClass(id) {
  const work = adminWorkById(id);
  const title = work.title || '';
  const kind = work.kind || 'novel';
  const category = work.category || '';
  const characters = work.characters || [];
  editClassNovelId = id;
  document.getElementById('editclass-novel-title').textContent = title || '';
  const sel = document.getElementById('editclass-category');
  if (!sel.dataset.init) {
    sel.innerHTML = '<option value="">— 選擇類型 —</option>' + CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('');
    sel.dataset.init = '1';
  }
  const div = document.getElementById('editclass-chars');
  if (!div.dataset.init) {
    div.innerHTML = CHAR_LIST.map(ch => `<span class="opt" data-ch="${ch.code}" data-onclick="this.classList.toggle('on')">${ch.name}</span>`).join('');
    div.dataset.init = '1';
  }
  // forum posts have no 故事類型
  document.getElementById('editclass-cat-group').style.display = kind === 'forum' ? 'none' : '';
  sel.value = category || '';
  const have = new Set(characters || []);
  div.querySelectorAll('.opt').forEach(el => el.classList.toggle('on', have.has(el.dataset.ch)));
  document.getElementById('editclass-modal').classList.add('open');
}

async function saveEditClass() {
  const category = document.getElementById('editclass-category').value;
  const characters = [...document.querySelectorAll('#editclass-chars .opt.on')].map(el => el.dataset.ch);
  // category null is ignored by the backend (PATCH skips null), so only novels send it.
  const body = { characters };
  if (category) body.category = category;
  try {
    await api(`/novels/${editClassNovelId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast('分類已更新');
    document.getElementById('editclass-modal').classList.remove('open');
    loadAdminNovelList(); loadNovels();
  } catch (e) { toast(e.message); }
}

let editWork = { id: null, chapterId: null, chapterNum: 1, chapterTitle: null, kind: 'novel' };

// Split forum content into 主文 (intro, before the first floor marker) + 留言區 (the floors).
function splitForumContent(content) {
  const lines = (content || '').replace(/[\u2028\u2029\r]/g, '\n').split('\n');
  const BIJI = /^第\s*\d+\s*笔\s*[｜|]/, FLOOR = /^0?\d{1,3}\s*[Ll](?![A-Za-z])/, SEP = /^[-—–_*]{3,}$/;
  const i = lines.findIndex(l => { const t = l.trim(); return BIJI.test(t) || FLOOR.test(t) || SEP.test(t); });
  if (i < 0) return { intro: lines.join('\n').trim(), comments: '' };
  return { intro: lines.slice(0, i).join('\n').trim(), comments: lines.slice(i).join('\n').trim() };
}

async function openEditWork(id) {
  const n = (window._adminNovels || []).find(x => x.id === id) || {};
  editWork = { id, chapterId: null, chapterNum: 1, chapterTitle: null, kind: n.kind || 'novel' };
  const isForum = n.kind === 'forum';
  const isImage = n.kind === 'image';   // 畫作：純圖片投稿，沒有頁首圖、也沒有內文／章節
  // 複製作品編號（admin-only）：給文首插圖 artwork/<id>.jpg 等「以編號對應」的用途
  { const cp = document.getElementById('editwork-copyid'); if (cp) cp.setAttribute('data-onclick', `copyText('${id}', '已複製作品編號')`); }
  document.getElementById('editwork-title').value = n.title || '';
  document.getElementById('editwork-author').value = n.author || '';
  document.getElementById('editwork-date').value = (n.created_at || '').slice(0, 10);   // 發佈日期
  document.getElementById('editwork-content-label').textContent = isForum ? '主文（開場白）' : '內文';
  document.getElementById('editwork-comments-group').style.display = isForum ? '' : 'none';
  // 內文：畫作沒有內文，整組收起（避免出現一個空的編輯框）
  { const cg = document.getElementById('editwork-content-group'); if (cg) cg.style.display = isImage ? 'none' : ''; }
  // 頁首圖：僅小說；論壇與畫作都沒有（畫作的 image_url 是作品本身，不是頁首圖）
  { const hg = document.getElementById('editwork-header-group'); if (hg) hg.style.display = (isForum || isImage) ? 'none' : ''; }
  { const ig = document.getElementById('editwork-image-group'); if (ig) ig.style.display = isImage ? '' : 'none'; }
  if (!isForum && !isImage) {
    editWork.headerUrl = n.image_url || null;   // 授權畫作「使用中」判定用
    renderEditHeaderPreview(n.image_url || null);
    renderEditAuthArts();                       // 本篇的獲授權畫作區（沒有就自動隱藏）
  } else {
    const ab = document.getElementById('editwork-auth-arts');
    if (ab) { ab.style.display = 'none'; ab.innerHTML = ''; }
  }
  document.getElementById('editwork-comments').value = '';
  const ct = document.getElementById('editwork-content');
  document.getElementById('editwork-modal').classList.add('open');
  if (isImage) {
    ct.value = '';
    editWork.imageFrame = GALLERY_FRAMES.some(([c]) => c === n.image_frame) ? n.image_frame : 'ebony';
    renderEditFramePicker();
    document.getElementById('editwork-caption').value = n.image_caption || '';
    { const cb = document.getElementById('editwork-crop-btn'); if (cb) cb.setAttribute('data-onclick', `openCoverCrop('${escapeHtml(n.image_url || '')}')`); }
    return;   // 畫作：標題／署名／日期／說明／畫框／裁切框，無章節
  }
  ct.value = '載入中…'; ct.disabled = true;
  try {
    const chs = await api(`/chapters/novel/${id}`) || [];
    const ch = chs[0];
    if (ch) {
      const full = await api(`/chapters/${ch.id}`);
      editWork.chapterId = ch.id; editWork.chapterNum = ch.chapter_num || 1; editWork.chapterTitle = ch.title || null;
      const raw = (full && full.content) || '';
      if (isForum) {
        const { intro, comments } = splitForumContent(raw);
        ct.value = intro; document.getElementById('editwork-comments').value = comments;
      } else { ct.value = raw; }
    } else { ct.value = ''; }
  } catch (e) { ct.value = ''; toast('內文載入失敗：' + ((e && e.message) || e || '未知錯誤')); }   // 顯示後端實際錯誤，方便診斷
  ct.disabled = false;
}

function renderEditFramePicker() {
  const picker = document.getElementById('editwork-frame-picker');
  if (!picker) return;
  picker.innerHTML = GALLERY_FRAMES.map(([code, name]) => `
    <div class="frame-swatch-wrap">
      <div class="frame-swatch ${code === 'none' ? '' : 'gframe fr-' + code}${code === editWork.imageFrame ? ' sel' : ''}" data-frame="${code}" data-onclick="pickEditFrame('${code}')"><div></div></div>
      <small>${name}</small>
    </div>`).join('');
}
function pickEditFrame(code) {
  editWork.imageFrame = code;
  document.querySelectorAll('#editwork-frame-picker .frame-swatch').forEach(el => el.classList.toggle('sel', el.dataset.frame === code));
}
async function saveEditWork() {
  const title = document.getElementById('editwork-title').value.trim();
  const author = document.getElementById('editwork-author').value.trim();
  if (editWork.kind === 'image') {
    if (!title) { toast('請輸入標題'); return; }
    const caption = document.getElementById('editwork-caption').value.trim().slice(0, 50);
    const published_at = dateToIso(document.getElementById('editwork-date').value);
    try {
      await api(`/novels/${editWork.id}`, { method: 'PATCH', body: JSON.stringify({ title, author, published_at, image_frame: editWork.imageFrame, image_caption: caption }) });
      toast('作品已更新');
      document.getElementById('editwork-modal').classList.remove('open');
      loadAdminNovelList(); loadNovels();
      // 同步留影走廊快取：畫作編輯後，留影牆／詳情卡即時反映。原本只刷新作品管理與意若思鏡（畫作根本
      // 不在意若思鏡），漏了留影走廊，作者改了署名會以為「改不了名字」——其實已存進 DB，只是留影沒刷新。
      const gi = (_galleryItems || []).find(x => x.id === editWork.id);   // 頂層 let 不會掛到 window，寫成 window._galleryItems 等於永遠取到 undefined
      if (gi) { gi.title = title; gi.author = author; gi.image_caption = caption; gi.image_frame = editWork.imageFrame; }
      if (typeof forumTab !== 'undefined' && forumTab === 'gallery' && typeof renderGallery === 'function') renderGallery();
    } catch (e) { toast(e.message); }
    return;
  }
  let content;
  if (editWork.kind === 'forum') {
    const main = document.getElementById('editwork-content').value.trim();
    const replies = document.getElementById('editwork-comments').value.trim();
    content = replies ? (main + '\n' + replies) : main;
  } else {
    content = document.getElementById('editwork-content').value;
  }
  if (!title) { toast('請輸入標題'); return; }
  const published_at = dateToIso(document.getElementById('editwork-date').value);
  try {
    await api(`/novels/${editWork.id}`, { method: 'PATCH', body: JSON.stringify({ title, author, published_at }) });
    if (editWork.chapterId) {
      await api(`/chapters/${editWork.chapterId}/text`, { method: 'PUT', body: JSON.stringify({ chapter_num: editWork.chapterNum, title: editWork.chapterTitle, content }) });
    }
    toast('作品已更新');
    document.getElementById('editwork-modal').classList.remove('open');
    loadAdminNovelList(); loadNovels();
  } catch (e) { toast('' + e.message); }
}

// 真刪除（唯一會真的刪掉作品的動作）。fromReview 只決定刪完刷新哪個清單——訊息一律是「刪除」，
// 不再借用舊的「退回」字眼（退回已獨立成 rejectNovel，退回不刪稿）。後端 delete_novel 只允許
// owner 或 admin，別人一律 403。
async function deleteNovel(id, fromReview) {
  if (!confirm('確定刪除此作品及所有內容？此操作無法復原！')) return;
  try {
    await api(`/novels/${id}`, { method: 'DELETE' });
    toast('已刪除');
    if (fromReview) loadReviewList(); else { loadAdminNovelList(); loadNovels(); }
  } catch (e) { toast(e.message); }
}

// 超管退件：把已通過的作品退回待審——從公開處下架、回到審核佇列，作者可在作品管理修改後重送。
// 不刪除、不動內容（與 deleteNovel 的「退回並刪除」不同）。留影走廊詳情頁與作品管理卡片都有此鈕。
async function retractNovel(id) {
  if (!id) id = _galleryDetailItem && _galleryDetailItem.id;   // 詳情頁的鈕無參呼叫，讀目前開啟的畫作
  if (!id) return;
  const it = (_galleryDetailItem && _galleryDetailItem.id === id) ? _galleryDetailItem : adminWorkById(id);
  const title = (it && it.title) || '這件作品';
  if (!confirm(`退件《${title}》？\n\n退件後會從公開書架與留影走廊下架、退回待審，作者可在「作品管理」修改後重新送審。作品與內容不會刪除。`)) return;
  try {
    await api(`/novels/${id}/retract`, { method: 'PATCH' });
    toast('已退件，退回待審');
    if (typeof closeGalleryDetail === 'function') closeGalleryDetail();
    if (typeof loadGallery === 'function') loadGallery();
    if (typeof loadAdminNovelList === 'function') loadAdminNovelList();
    if (typeof loadNovels === 'function') loadNovels();
  } catch (e) { toast(e.message || '退件失敗'); }
}

async function loadAdminUsers() {
  const el = document.getElementById('user-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    window._adminUsers = await api('/permissions/users') || [];   // looked up by viewUserNovels
    renderUserStats();
    renderUserRows(document.getElementById('user-search')?.value || '');
  } catch { el.innerHTML = '<p>載入失敗</p>'; }
}

// ── 用戶活躍度 / 不活躍清理 ─────────────────────────────────
// last_seen_at is recorded on every app open (backend /auth/me). For accounts with no record
// yet (e.g. before this feature shipped) we estimate from 註冊日 so the report still works;
// it becomes exact as people open the app.
let userActivityFilter = '';   // '' | '15' | '30'  (≥N 天未上線)
let userRoleFilter = '';       // '' | 'reader' | 'writer' | 'manage' (按身份篩選)
function setUserRole(role) {
  userRoleFilter = (userRoleFilter === role) ? '' : role;   // 再點同一個＝取消
  renderUserStats();
  renderUserRows(document.getElementById('user-search')?.value || '');
}
function _daysSince(ts) {
  if (!ts) return null;
  const t = new Date(ts);
  if (isNaN(t.getTime())) return null;
  // Calendar-day difference in the viewer's local time, so 今天/昨天 flip at local midnight
  // — a 23:00 login reads 今天 until midnight, then 昨天 — instead of a rolling 24h window.
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((dayStart(new Date()) - dayStart(t)) / 86400000);
}
function userInactiveDays(u) { const d = _daysSince(u.last_seen_at); return d != null ? d : _daysSince(u.created_at); }
function lastSeenLabel(u) {
  const d = _daysSince(u.last_seen_at);
  if (d == null) return '尚無上線紀錄';
  if (d <= 0) return '今天上線';
  if (d === 1) return '昨天上線';
  return `${d} 天前上線`;
}
function setUserFilter(v) {
  userActivityFilter = v;
  renderUserStats();
  renderUserRows(document.getElementById('user-search')?.value || '');
}
function renderUserStats() {
  const box = document.getElementById('user-stats');
  if (!box) return;
  const all = window._adminUsers || [];
  const total = all.length;
  const rc = { reader: 0, writer: 0, admin: 0, super_admin: 0 };
  let in15 = 0, in30 = 0, noRec = 0;
  all.forEach(u => {
    rc[u.role] = (rc[u.role] || 0) + 1;
    if (!u.last_seen_at) noRec++;
    const d = userInactiveDays(u);
    if (d != null && d >= 30) in30++;
    else if (d != null && d >= 15) in15++;
  });
  const in15cum = in15 + in30;   // ≥15 天包含 ≥30 天
  const chip = (v, label, n) => `<button class="uf-chip${userActivityFilter === v ? ' on' : ''}" data-onclick="setUserFilter('${v}')">${label}${n != null ? `（${n}）` : ''}</button>`;
  const roleLink = (key, label, n) => `<span data-onclick="setUserRole('${key}')" style="cursor:pointer;${userRoleFilter === key ? 'color:var(--accent);font-weight:bold' : 'border-bottom:1px dashed var(--gold-lt)'}">${label} ${n}</span>`;
  box.innerHTML =
    `<div style="font-size:13px;color:var(--ink-light);line-height:1.8">共 <b style="color:var(--ink);font-size:15px">${total}</b> 位用戶`
    + ` · ${roleLink('reader', '讀者', rc.reader)} · ${roleLink('writer', '作家', rc.writer)} · ${roleLink('manage', '管理', rc.admin + rc.super_admin)}</div>`
    + `<div style="display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;margin-top:7px">`
    + chip('', '全部', total) + chip('15', '≥15天未上線', in15cum) + chip('30', '≥30天未上線', in30) + `</div>`
    + (noRec ? `<div style="font-size:11px;color:var(--ink-light);opacity:.7;margin-top:6px">※ ${noRec} 位尚無上線紀錄，暫以註冊日估算（之後自動精準）</div>` : '');
}
async function clearUserFlag(userId) {
  try {
    await api(`/permissions/users/${userId}/clear-flag`, { method: 'PATCH' });
    toast('已標記為已審');
    loadAdminUsers();
  } catch (e) { toast(e.message); }
}

// Render (optionally filtered) user rows. Search matches 巫師暱稱 or 入學全名.
function renderUserRows(q) {
  const el = document.getElementById('user-list');
  const all = window._adminUsers || [];
  const ROLES = [['reader','讀者'],['writer','作家'],['admin','管理員'],['super_admin','超級管理員']];
  const isSuper = currentUser.role === 'super_admin';
  const needle = (q || '').trim().toLowerCase();
  let users = needle ? all.filter(u => (u.nickname || '').toLowerCase().includes(needle) || (u.username || '').toLowerCase().includes(needle)) : all;
  if (userRoleFilter === 'reader') users = users.filter(u => u.role === 'reader');
  else if (userRoleFilter === 'writer') users = users.filter(u => u.role === 'writer');
  else if (userRoleFilter === 'manage') users = users.filter(u => u.role === 'admin' || u.role === 'super_admin');
  if (userActivityFilter) {
    const min = parseInt(userActivityFilter, 10);
    users = users.filter(u => { const d = userInactiveDays(u); return d != null && d >= min; });
    users = [...users].sort((a, b) => (userInactiveDays(b) || 0) - (userInactiveDays(a) || 0));   // 最久未上線在前
  }
    el.innerHTML = users.map(u => {
      const display = u.nickname || u.username;
      const isSelf = u.id === currentUser.id;
      const picker = (isSuper && !isSelf)
        ? `<select data-onchange="changeUserRole('${u.id}',this.value)" style="font-size:12px;padding:4px 6px;border:1px solid var(--gold-lt);border-radius:3px;background:var(--parchment2);color:var(--ink)">
             ${ROLES.map(([v,l]) => `<option value="${v}" ${u.role===v?'selected':''}>${l}</option>`).join('')}
           </select>`
        : `<div class="u-role">${u.role}${isSelf ? '（你）' : ''}</div>`;
      // Tap the name to drill into this member's detail (their works + 迷情劑 toggle for readers).
      const open = `viewUserNovels('${u.id}')`;
      const isTempBan = u.banned && u.ban_until && new Date(u.ban_until) > new Date();
      const banTag = u.banned ? '<span style="font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(138,45,45,.18);color:var(--accent);margin-left:6px">' + ic(isTempBan ? 'ic-clock' : 'ic-ban',10) + (isTempBan ? ' 臨時封禁' : ' 已封禁') + '</span>' : '';
      const archTag = u.archived ? '<span style="font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(61,31,13,.12);color:var(--ink-light);margin-left:6px">' + ic('ic-moon',10) + ' 已封存</span>' : '';
      const flagBadge = (u.flag_note && isSuper) ? '<span style="font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(201,168,76,.3);color:var(--ink);margin-left:6px">' + ic('ic-shield',10) + ' 疑似回鍋</span>' : '';
      const flagRow = (u.flag_note && isSuper) ? `<div style="margin-top:5px;font-size:12px;color:var(--accent);background:rgba(138,45,45,.10);padding:6px 8px;border-radius:6px;display:flex;align-items:center;gap:8px;justify-content:space-between"><span>${escapeHtml(u.flag_note)}</span><button data-onclick="clearUserFlag('${u.id}')" style="flex-shrink:0;font-size:11px;padding:3px 9px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;cursor:pointer;white-space:nowrap">已審</button></div>` : '';
      const _joined = u.created_at ? `加入 ${fmtUpdated(u.created_at)}・` : '';
      const seen = `<div style="font-size:11px;color:var(--ink-light);font-weight:normal;opacity:.8">${_joined}${lastSeenLabel(u)}</div>`;
      // In an inactivity view, super_admin gets an inline 刪除 for quick manual cleanup (never automatic).
      const delBtn = (isSuper && !isSelf && userActivityFilter)
        ? `<button class="uf-del" data-onclick="deleteUser('${u.id}')">${ic('ic-trash', 11)} 刪除</button>`
        : '';
      // Destructive actions (重設密碼/封禁/刪除) live inside the member's detail page too —
      // tap the row to enter — so scrolling the list can't mis-fire them.
      return `
      <div style="padding:8px 0;border-bottom:1px solid rgba(26,10,0,.07)">
        <div class="user-row" style="border:none;padding:0">
          <span data-onclick="${open}" style="cursor:pointer;flex-shrink:0">${avatarHTML(u, 32)}</span>
          <div class="u-name" data-onclick="${open}" style="cursor:pointer;line-height:1.3">${escapeHtml(display)}${banTag}${archTag}${flagBadge}<span style="color:var(--gold);font-weight:bold;margin-left:6px">›</span><div style="font-size:12px;color:var(--ink-light);font-weight:normal">@${escapeHtml(u.username)}</div>${seen}</div>
          ${delBtn || picker}
        </div>
        ${flagRow}
      </div>`;
    }).join('') || `<p style="color:#888;padding:20px">${needle ? '找不到符合的用戶' : (userActivityFilter || userRoleFilter ? '沒有符合的用戶' : '尚無用戶')}</p>`;
}

// Admin taps a member's name → their detail (scoped 作品管理 + 迷情劑 toggle for readers).
function viewUserNovels(id) {
  const u = (window._adminUsers || []).find(x => x.id === id) || {};
  adminNovelScope = { id, name: u.nickname || u.username || '', role: u.role, mqj: u.mqj_access, banned: u.banned, ban_until: u.ban_until || null, archived: !!u.archived, auto: !!u.auto_publish, wish: !!u.wish_reply, joined: u.created_at || null };
  switchAdminTab('novels');
}

function adminUserById(id) {
  return (window._adminUsers || []).find(u => u.id === id)
    || (adminNovelScope && adminNovelScope.id === id ? adminNovelScope : {}) || {};
}
function adminUserName(id) {
  const u = adminUserById(id);
  return u.nickname || u.name || u.username || '此成員';
}

async function changeUserRole(userId, role) {
  const username = adminUserName(userId);
  if (!confirm(`確定把「${username}」的角色改成 ${role}？`)) { loadAdminUsers(); return; }
  try {
    await api(`/permissions/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
    toast(`${username} 已設為 ${role}`);
    loadAdminUsers();
  } catch (e) { toast(e.message); loadAdminUsers(); }
}

async function resetPassword(id) {
  const name = adminUserName(id);
  const pw = prompt(`為「${name}」設定新的密碼（至少 8 字）。\n設定後請私下告訴對方，讓他用這組登入：`);
  if (pw === null) return;
  if (pw.trim().length < 8) { toast('密碼至少 8 字'); return; }
  try {
    await api(`/permissions/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password: pw.trim() }) });
    toast(`已重設 ${name} 的密碼`);
  } catch (e) { toast('' + e.message); }
}

async function tempBan(id, on, hours) {
  hours = (hours === 24 || hours === 72) ? hours : 72;
  const name = adminUserName(id);
  if (on && !confirm(`臨時封禁「${name}」${hours} 小時？\n對方暫時無法登入，${hours} 小時後自動解除。`)) return;
  if (!on && !confirm(`解除「${name}」的臨時封禁？`)) return;
  try {
    const r = await api(`/permissions/users/${id}/temp-ban`, { method: 'POST', body: JSON.stringify({ banned: !!on, hours }) });
    toast(on ? `已臨時封禁 ${name} ${hours} 小時` : `已解除 ${name} 的臨時封禁`);
    if (adminNovelScope && adminNovelScope.id === id) { adminNovelScope.banned = !!on; adminNovelScope.ban_until = (r && r.ban_until) || null; loadAdminNovelList(); }
    else loadAdminUsers();
  } catch (e) { toast(e.message); }
}

async function banUser(id, isBanned) {
  const name = adminUserName(id);
  const ban = !isBanned;
  if (!confirm(ban ? `確定封禁「${name}」？\n對方將無法登入或使用本站，可隨時解除。` : `解除「${name}」的封禁？`)) return;
  try {
    await api(`/permissions/users/${id}/ban`, { method: 'PATCH', body: JSON.stringify({ banned: ban }) });
    toast(ban ? `已封禁 ${name}` : `已解除 ${name} 的封禁`);
    if (adminNovelScope && adminNovelScope.id === id) { adminNovelScope.banned = ban; loadAdminNovelList(); }
    else loadAdminUsers();
  } catch (e) { toast(e.message); }
}

// 封存：非懲罰、可復原。作者不玩了時優雅停用帳號——對方無法登入，但作品與資料全部保留，隨時可取消封存。
async function archiveUser(id, on) {
  const name = adminUserName(id);
  const arch = on === 1 || on === true;
  if (!confirm(arch
    ? `封存「${name}」的帳號？\n\n對方將無法登入，但 TA 的作品與資料全部保留、不會刪除，日後隨時可取消封存恢復。適合「作者不玩了、想安靜離開」的情況。`
    : `取消「${name}」的封存？\n\n帳號恢復，可正常登入。`)) return;
  try {
    await api(`/permissions/users/${id}/archive`, { method: 'PATCH', body: JSON.stringify({ archived: arch }) });
    toast(arch ? `已封存 ${name}` : `已取消 ${name} 的封存`);
    if (adminNovelScope && adminNovelScope.id === id) { adminNovelScope.archived = arch; loadAdminNovelList(); }
    else loadAdminUsers();
  } catch (e) { toast(e.message); }
}

async function deleteUser(id) {
  const name = adminUserName(id);
  if (!confirm(`永久刪除「${name}」的帳號？\n此操作無法復原（帳號會被移除，作品內容會保留）。`)) return;
  if (!confirm(`再次確認：真的要刪除「${name}」嗎？`)) return;
  try {
    await api(`/permissions/users/${id}`, { method: 'DELETE' });
    toast(`已刪除 ${name}`);
    adminNovelScope = null;            // they're gone — return to the member list
    switchAdminTab('users');
  } catch (e) { toast(e.message); }
}

async function setMqjAccess(userId, on) {
  const username = adminUserName(userId);
  const access = on ? 'approved' : 'none';
  // The toggle now lives inside the member-detail view (scoped 作品管理).
  const refresh = () => { if (adminNovelScope) { adminNovelScope.mqj = access; loadAdminNovelList(); } else loadAdminUsers(); };
  try {
    await api(`/permissions/users/${userId}/mqj`, { method: 'PATCH', body: JSON.stringify({ access }) });
    toast(on ? `已開放 ${username} 的迷情劑閱讀權` : `已關閉 ${username} 的迷情劑閱讀權`);
    refresh();
  } catch (e) { toast(e.message); refresh(); }
}

async function setAutoPublish(userId, on) {
  const username = adminUserName(userId);
  const refresh = () => { if (adminNovelScope) { adminNovelScope.auto = on; loadAdminNovelList(); } else loadAdminUsers(); };
  try {
    await api(`/permissions/users/${userId}/auto-publish`, { method: 'PATCH', body: JSON.stringify({ auto_publish: on }) });
    toast(on ? `已開啟 ${username} 的自動審核（發文免審）` : `已關閉 ${username} 的自動審核`);
    refresh();
  } catch (e) { toast(e.message); refresh(); }
}

async function setWishReply(userId, on) {
  const username = adminUserName(userId);
  const refresh = () => { if (adminNovelScope) { adminNovelScope.wish = on; loadAdminNovelList(); } else loadAdminUsers(); };
  try {
    await api(`/permissions/users/${userId}/wish-reply`, { method: 'PATCH', body: JSON.stringify({ wish_reply: on }) });
    toast(on ? `已開啟 ${username} 的許願池回覆權` : `已關閉 ${username} 的許願池回覆權`);
    refresh();
  } catch (e) { toast(e.message); refresh(); }
}

// (removed) The per-work 授權管理 modal (openPerm/togglePerm/closePerm) was dead, unreachable code:
// it had no caller, and reading access is governed by deps.check_novel_access — never the permissions table.

// ── Admin: role badge helper ──────────────────────────────────
const ROLE_LABEL = { super_admin: '最高管理員', admin: '管理員', writer: '作家', reader: '讀者' };

function renderSettings() {
  const nick = currentUser.nickname || currentUser.username || '巫師';
  const av = document.getElementById('settings-avatar');
  const avatar = safeAvatarDataUrl(currentUser.avatar_url);
  if (avatar) {
    av.textContent = '';
    av.style.background = `url("${avatar}") center/cover no-repeat`;
  } else {
    av.style.background = 'var(--scarlet)';
    av.textContent = nick[0].toUpperCase();
  }
  document.getElementById('settings-username').textContent = nick;
  document.getElementById('settings-email').textContent = currentUser.created_at ? '加入於 ' + fmtUpdated(currentUser.created_at) : '';
  document.getElementById('settings-role').innerHTML = roleBadge(currentUser.role, 15);
  document.getElementById('app-version').textContent = '版本 ' + APP_VERSION;
  renderVersionStatus();   // 檔案頁的「最新一期／已過時」狀態按鈕
  document.getElementById('profile-fullname').textContent = currentUser.username || '—';
  document.getElementById('nick-display').textContent = nick;
  document.getElementById('profile-nickname').value = currentUser.nickname || currentUser.username || '';
  // reset to view (not edit) mode
  document.getElementById('nick-view').style.display = 'flex';
  document.getElementById('nick-edit').style.display = 'none';
}

function editNick() {
  document.getElementById('nick-view').style.display = 'none';
  document.getElementById('nick-edit').style.display = 'flex';
  const inp = document.getElementById('profile-nickname');
  inp.focus();
  inp.select();
}

async function saveNickname() {
  const nickname = document.getElementById('profile-nickname').value.trim();
  if (!nickname) { toast('請輸入巫師暱稱'); return; }
  try {
    const updated = await api('/auth/me/nickname', { method: 'PATCH', body: JSON.stringify({ nickname }) });
    currentUser.nickname = updated.nickname || nickname;
    toast('巫師暱稱已更新');
    renderSettings();
    renderGreeting(false);   // 只更新問候語，不重抽封面
  } catch (e) { toast('' + e.message); }
}

function togglePwEdit(on) {
  document.getElementById('pw-view').style.display = on ? 'none' : 'flex';
  document.getElementById('pw-edit').style.display = on ? 'flex' : 'none';
  if (on) ['pw-current', 'pw-new', 'pw-new2'].forEach(id => document.getElementById(id).value = '');
}
async function saveMyPassword() {
  const cur = document.getElementById('pw-current').value;
  const nw = document.getElementById('pw-new').value.trim();
  const nw2 = document.getElementById('pw-new2').value.trim();
  if (!cur) { toast('請輸入目前的密碼'); return; }
  if (nw.length < 8) { toast('新密碼至少 8 字'); return; }
  if (nw !== nw2) { toast('兩次輸入的新密碼不一致'); return; }
  try {
    await api('/auth/me/password', { method: 'PATCH', body: JSON.stringify({ current: cur, new: nw }) });
    toast('密碼已更新');
    togglePwEdit(false);
  } catch (e) { toast('' + e.message); }
}

// ── Admin: invites ────────────────────────────────────────────
function inviteLink(token) { return `${window.location.origin}${window.location.pathname}?invite=${token}`; }

const GRAB_QTY_MAX = 50;   // 要跟 routers/invites.py 的 _GROUP_MAX 一致

// 搶名額連結：一輪＝N 張共用 group_code 的單次 token，一條連結先搶先贏。
async function generateGroupInvite(role) {
  const el = document.getElementById('grab-qty');
  const raw = parseInt(el.value, 10);
  if (!raw || raw < 1 || raw > GRAB_QTY_MAX) {   // 後端也夾一次；這裡先講清楚，別讓她打 50 卻默默拿到別的數字
    toast(`名額請填 1～${GRAB_QTY_MAX} 之間的整數`);
    el.focus();
    return;
  }
  const qty = raw;

  // 開放時間：datetime-local 給的是「本機時間」字串（無時區）。交給 Date 解析後轉 ISO，
  // 時區換算由瀏覽器處理——她在 UTC+8 填晚上 7 點，送出去就是正確的 11:00Z。
  const opensEl = document.getElementById('grab-opens');
  let opensAt = '';
  if (opensEl && opensEl.value) {
    const d = new Date(opensEl.value);
    if (isNaN(d.getTime())) { toast('開放時間格式不正確'); return; }
    if (d.getTime() <= Date.now()) { toast('開放時間已經過了——若要立刻開放，請把時間清空'); return; }
    opensAt = d.toISOString();
  }

  try {
    const res = await api('/invites/generate-group', { method: 'POST', body: JSON.stringify({ role, count: qty, opens_at: opensAt }) });
    const box = document.getElementById('grab-result');
    box.style.display = '';
    box.innerHTML = `
      <div style="font-size:12px;color:var(--accent);margin-bottom:6px">已開出 ${res.count} 份${ROLE_NAME_INV[role] || ''}邀請函（開放後 3 天有效，領完即止）</div>
      <div style="font-size:12.5px;color:var(--ink);background:var(--parchment);border:1px solid var(--gold-lt);border-radius:6px;padding:8px 10px;line-height:1.7">${
        res.opens_at
          ? `${ic('ic-clock',12)} 已排定 <b>${new Date(res.opens_at).toLocaleString('zh-TW')}</b> 開放——時間一到，守則頁自動亮起領取入口，你不必再做任何事。`
          : `${ic('ic-check',12)} 入站守則頁已自動亮起領取入口——群組裡貼過的守則頁連結<b>即刻生效，不需再發新連結</b>。`
      }</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn-primary" style="flex:1;padding:8px 4px;font-size:13px;white-space:nowrap" data-onclick="copyText('https://surf0912.github.io/prophet-daily/rules','已複製 守則頁連結（GitHub）')">${ic('ic-link',13)} GitHub 守則頁</button>
        <button class="btn-primary" style="flex:1;padding:8px 4px;font-size:13px;white-space:nowrap;background:var(--chrome)" data-onclick="copyText('https://the-prophet-daily.onrender.com/rules','已複製 守則頁連結（鏡像）')">${ic('ic-link',13)} 鏡像 守則頁</button>
      </div>`;
    loadInviteList();
  } catch (e) { toast('' + e.message); }
}

async function revokeGroupInvite(code) {
  if (!confirm(`撤銷這一輪開放（${code}）？\n\n未被領取的邀請函立即失效；已領取入站的人不受影響。`)) return;
  try { await api(`/invites/group/${code}`, { method: 'DELETE' }); toast('已撤銷這一輪'); loadInviteList(); }
  catch (e) { toast(e.message); }
}
function copyText(text, label) { navigator.clipboard.writeText(text).then(() => toast(label || '已複製')); }
let _lastInviteLinks = [];
function copyAllInvites() { copyText(_lastInviteLinks.join('\n'), `已複製全部 ${_lastInviteLinks.length} 條連結`); }
const ROLE_NAME_INV = { reader: '讀者', writer: '作家', admin: '管理員' };

async function generateInvite(role) {
  const qty = parseInt(document.getElementById('invite-qty').value, 10) || 1;
  try {
    const res = await api('/invites/generate', { method: 'POST', body: JSON.stringify({ role, count: qty }) });
    const tokens = res.tokens || (res.token ? [res.token] : []);
    _lastInviteLinks = tokens.map(inviteLink);
    const box = document.getElementById('invite-result');
    box.style.display = '';
    const rows = tokens.map(t => `
      <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
        <code style="flex:1;font-size:13px;color:var(--ink);background:var(--parchment);border:1px solid var(--gold-lt);border-radius:4px;padding:6px 8px;word-break:break-all">${t}</code>
        <button data-onclick="copyText('${inviteLink(t)}', '已複製（${t}）')" style="padding:6px 10px;background:var(--scarlet);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:12px;white-space:nowrap">複製</button>
      </div>`).join('');
    const all = tokens.length > 1 ? `<button data-onclick="copyAllInvites()" style="margin-top:10px;width:100%;padding:9px;background:var(--scarlet);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px">複製全部 ${tokens.length} 條</button>` : '';
    box.innerHTML = `<div style="font-size:12px;color:var(--accent);margin-bottom:2px">已產生 ${tokens.length} 個${ROLE_NAME_INV[role] || ''}邀請（3 天有效、各用一次）</div>${rows}${all}`;
    loadInviteList();
  } catch (e) { toast('' + e.message); }
}

// ── 作家申請（守則頁的公開表單）─────────────────────────────
// 留的是聯絡方式而非帳號，所以只在管理介面顯示，且不回傳送出者 IP（IP 只在後端做限流）。
let _writerApps = [];
function clearGrabOpens() {
  const el = document.getElementById('grab-opens');
  if (el) { el.value = ''; toast('已清除——將立刻開放'); }
}

async function loadWriterApps() {
  const el = document.getElementById('writer-app-list');
  if (!el) return;
  el.innerHTML = '<div class="spinner"></div>';
  let list;
  try {
    list = await api('/applications/writer') || [];
  } catch (e) {
    el.innerHTML = `<p style="color:#888;font-size:13px">讀取失敗：${escapeHtml(e.message)}</p>`;
    return;
  }
  _writerApps = list;
  if (!list.length) { el.innerHTML = '<p style="color:#888;font-size:13px">尚無申請</p>'; return; }
  el.innerHTML = list.map(r => {
    const done = r.status === 'handled';
    return `<div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08);font-size:13px;${done ? 'opacity:.55' : ''}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
        <span style="font-weight:bold;color:var(--ink);word-break:break-all;min-width:0">${escapeHtml(r.contact || '')}</span>
        ${done ? '<span style="background:rgba(201,168,76,.28);color:var(--ink-light);padding:2px 8px;border-radius:10px;font-size:11px;flex-shrink:0;margin-left:auto">已處理</span>' : ''}
      </div>
      <div style="color:var(--ink-light);font-size:12px;margin-bottom:6px">${new Date(r.created_at).toLocaleString('zh-TW')}</div>
      ${r.note ? `<div style="color:var(--ink-light);line-height:1.7;margin-bottom:6px;white-space:pre-wrap">${escapeHtml(r.note)}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button data-onclick="copyWriterApp('${r.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:5px;cursor:pointer">複製</button>
        <button data-onclick="setWriterAppHandled('${r.id}',${done ? 'false' : 'true'})" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:5px;cursor:pointer">${done ? '標記未處理' : '標記已處理'}</button>
        <button data-onclick="deleteWriterApp('${r.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--scarlet);color:var(--scarlet);border-radius:5px;cursor:pointer">刪除</button>
      </div>
    </div>`;
  }).join('');
}

function copyWriterApp(id) {
  const r = _writerApps.find(x => x.id === id);
  if (r) copyText(r.contact, '已複製聯絡方式');
}

async function setWriterAppHandled(id, on) {
  try { await api(`/applications/writer/${id}`, { method: 'PATCH', body: JSON.stringify({ handled: on }) }); loadWriterApps(); }
  catch (e) { toast(e.message); }
}

async function deleteWriterApp(id) {
  if (!confirm('刪除這筆申請？\n\n刪除後無法復原，聯絡方式也一併消失。')) return;
  try { await api(`/applications/writer/${id}`, { method: 'DELETE' }); toast('已刪除'); loadWriterApps(); }
  catch (e) { toast(e.message); }
}

async function loadInviteList() {
  const el = document.getElementById('invite-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const list = await api('/invites/list') || [];
    if (!list.length) { el.innerHTML = '<p style="color:#888;font-size:13px">尚無邀請連結</p>'; return; }
    // 搶名額輪次：同 group_code 的 token 聚合成一張卡（在該組第一次出現的位置渲染一次）
    const groups = {};
    list.forEach(inv => { if (inv.group_code) (groups[inv.group_code] = groups[inv.group_code] || []).push(inv); });
    const groupCard = (code) => {
      const g = groups[code];
      const used = g.filter(x => x.used_at);
      const expired = new Date(g[0].expires_at) < new Date();
      const remaining = expired ? 0 : g.length - used.length;
      // 排定但尚未到點：名額已備好，對外還不存在。不算 dim——它不是失效，是還沒輪到。
      const opensAt = g[0].opens_at ? new Date(g[0].opens_at) : null;
      const pending = !!(opensAt && opensAt > new Date());
      const dim = !pending && remaining <= 0;
      const names = used.map(x => escapeHtml(x.profiles?.username || '?')).join('、');
      return `<div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08);font-size:13px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="background:${dim ? '#ccc' : 'var(--scarlet)'};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;flex-shrink:0;white-space:nowrap">${roleBadge(g[0].role, 12)}</span>
          <span style="background:rgba(201,168,76,.28);color:var(--ink-light);padding:2px 8px;border-radius:10px;font-size:11px;flex-shrink:0">${pending ? `${ic('ic-clock',10)} 排定開放` : `${ic('ic-star-shine',10)} 開放領取`}</span>
          <span style="color:${dim ? '#aaa' : 'var(--ink-light)'}">${
            pending
              ? `${opensAt.toLocaleString('zh-TW')} 放出 ${g.length} 份`
              : `${dim ? (used.length >= g.length ? '已領完' : '已過期/撤銷') : `尚餘 ${remaining} / 共 ${g.length} 份`}・到期：${new Date(g[0].expires_at).toLocaleDateString('zh-TW')}`
          }</span>
        </div>
        ${names ? `<div style="font-size:12px;color:var(--ink-light);margin-bottom:4px">${ic('ic-check',11)} 已領取：${names}</div>` : ''}
        <div style="display:flex;align-items:center;gap:6px">
          <code style="font-size:13px;color:${dim ? '#aaa' : 'var(--ink)'};word-break:break-all;flex:1">${code}</code>
          ${!dim ? `<button data-onclick="revokeGroupInvite('${code}')" style="font-size:12px;padding:3px 8px;background:none;border:1px solid #ccc;border-radius:3px;cursor:pointer;white-space:nowrap">撤銷</button>` : ''}
        </div>
      </div>`;
    };
    const seenGroups = new Set();
    el.innerHTML = list.map(inv => {
      if (inv.group_code) {
        if (seenGroups.has(inv.group_code)) return '';
        seenGroups.add(inv.group_code);
        return groupCard(inv.group_code);
      }
      const used = !!inv.used_at;
      const usedBy = escapeHtml(inv.profiles?.username || '');
      const expired = !used && new Date(inv.expires_at) < new Date();
      const expires = new Date(inv.expires_at).toLocaleDateString('zh-TW');
      const dim = used || expired;
      return `<div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08);font-size:13px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="background:${dim ? '#ccc' : 'var(--scarlet)'};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px;flex-shrink:0;white-space:nowrap">${roleBadge(inv.role, 12)}</span>
          <span style="color:${dim ? '#aaa' : 'var(--ink-light)'}">到期：${expires}</span>
          ${used ? `<span style="color:#aaa">${ic('ic-check',11)} 已使用（${usedBy}）</span>` : (expired ? `<span style="color:#aaa">已過期</span>` : '')}
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <code style="font-size:13px;color:${dim ? '#aaa' : 'var(--ink)'};word-break:break-all;flex:1">${inv.token}</code>
          ${!used && !expired ? `<button data-onclick="copyText('${inviteLink(inv.token)}', '已複製（${inv.token}）')" style="font-size:12px;padding:3px 10px;background:var(--scarlet);color:#fff;border:none;border-radius:3px;cursor:pointer;white-space:nowrap">複製</button>` : ''}
          ${!used ? `<button data-onclick="revokeInvite('${inv.id}')" style="font-size:12px;padding:3px 8px;background:none;border:1px solid #ccc;border-radius:3px;cursor:pointer;white-space:nowrap">撤銷</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch { el.innerHTML = '<p style="color:#888">載入失敗</p>'; }
}

async function revokeInvite(id) {
  try { await api(`/invites/${id}`, { method: 'DELETE' }); toast('已撤銷'); loadInviteList(); }
  catch (e) { toast(e.message); }
}

// ── Self-heal: if this device is running a stale cached build, nuke the
// cache + SW and reload once so non-technical users never get stuck. The
// latest version is read from service-worker.js (cache-busted) and compared
// to the APP_VERSION baked into the running HTML.
async function selfHealIfStale() {
  try {
    if (sessionStorage.getItem('pd_healed')) return;   // only attempt once per launch
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);    // never hang boot on a slow network
    const res = await fetch('./service-worker.js?cb=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return;
    const m = (await res.text()).match(/prophet-daily-(v[\d.]+)/);
    if (!m || m[1] === APP_VERSION) return;             // up to date (or can't tell) → carry on
    sessionStorage.setItem('pd_healed', m[1]);          // guard against reload loops
    // 讓新版 SW（cache-busting 預抓到真新檔）上線後由它 cache-first 供應；不再 unregister＋清全部快取——
    // 那會把剛裝好的新版 SW 砍掉、退回鏡像的舊 HTTP 快取，反而讓裝置永遠卡在舊版更新不了。
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
        const sw = reg.installing || reg.waiting;
        if (sw) await new Promise((r) => {
          sw.addEventListener('statechange', () => { if (sw.state === 'activated') r(); });
          setTimeout(r, 3000);   // 保底：等不到就直接重載
        });
      }
    }
    location.reload();
    await new Promise(() => {});   // freeze the rest of boot; the reload takes over
  } catch (e) {}
}

// Tap the dim backdrop (outside the sheet) to close any .perm-modal — applies to all modals.
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('perm-modal')) e.target.classList.remove('open');
});

// ── Boot ─────────────────────────────────────────────────────
(async () => {
  fetch(API + '/health', { cache: 'no-store' }).catch(() => {});  // wake Render FIRST so a backgrounded→resumed reload isn't cold
  // Don't let the stale-check block the boot on a slow network: if it hasn't resolved in
  // 1.5s, show the app now and let self-heal finish (and reload only if stale) in the background.
  await Promise.race([selfHealIfStale(), new Promise(r => setTimeout(r, 1500))]);
  const appZoom = localStorage.getItem('pd_app_zoom') || '1.12';
  document.getElementById('font-size-select').value = appZoom; applyAppFontSize(appZoom);
  const readerFs = localStorage.getItem('pd_reader_font');
  if (readerFs) applyReaderFontSize(parseInt(readerFs)); else applyReaderFontSize(15);
  if (localStorage.getItem('pd_dark') === '1') { document.getElementById('dark-toggle').checked = true; toggleDark(true); }
  { const ss = document.getElementById('script-select'); if (ss) ss.value = uiScript; }

  // Check for invite token in URL
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  if (inviteToken) {
    // Show the form IMMEDIATELY so the user can start filling it while the backend
    // wakes; validate in the background with a raw fetch (no blocking 喚醒 overlay).
    document.getElementById('signin-form').style.display = 'none';
    document.getElementById('invite-form').style.display = '';
    fetch(`${API}/invites/validate/${inviteToken}`)
      .then(async r => {
        if (r.ok) {
          const res = await r.json();
          const roleLabels = { reader: '讀者', writer: '作家+讀者', admin: '管理員' };
          document.getElementById('invite-role-badge').innerHTML = `身份：${roleBadge(res.role, 13)}`;
        } else {
          // server explicitly rejected the token (used/expired/unknown) → show invalid
          const e = await r.json().catch(() => ({}));
          document.getElementById('invite-form').style.display = 'none';
          document.getElementById('invite-invalid-msg').textContent = e.detail || '此邀請連結已失效';
          document.getElementById('invite-invalid').style.display = '';
        }
      })
      .catch(() => { /* network error / cold start: keep the form — register re-validates on submit */ });
    return; // don't auto-login, show invite UI
  }

  // 搶名額連結（?grab=CODE）：同一張註冊表單，附剩餘名額；額滿/過期顯示失效訊息
  const grabCode = new URLSearchParams(window.location.search).get('grab');
  if (grabCode) {
    document.getElementById('signin-form').style.display = 'none';
    document.getElementById('invite-form').style.display = '';
    fetch(`${API}/invites/group/${grabCode}`)
      .then(async r => {
        if (r.ok) {
          const res = await r.json();
          document.getElementById('invite-role-badge').innerHTML = `身份：${roleBadge(res.role, 13)}`;
        } else {
          const e = await r.json().catch(() => ({}));
          document.getElementById('invite-form').style.display = 'none';
          document.getElementById('invite-invalid-msg').textContent = e.detail || '此領取連結已失效';
          document.getElementById('invite-invalid').style.display = '';
        }
      })
      .catch(() => { /* 網路錯誤：留著表單，送出時後端會再驗 */ });
    return;
  }

  if (token) await initApp();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
