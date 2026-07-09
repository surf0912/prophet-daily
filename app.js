// ── Block double-tap-to-zoom ─────────────────────────────────
// iOS Safari often ignores touch-action / user-scalable for double-tap zoom. Suppress the second
// of two quick taps; pinch-zoom and single taps still work. Skip form fields so text editing is
// unaffected.
(function () {
  let lastTap = 0;
  document.addEventListener('touchend', function (e) {
    const t = e.target;
    // .char-custom needs its real double-tap (= edit character); don't swallow the 2nd tap there.
    if (t && (t.closest('input, textarea, select, [contenteditable], .char-custom, .char-chip'))) { lastTap = 0; return; }
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
const API = 'https://prophet-daily.onrender.com';

// ── Font toggle ───────────────────────────────────────────────
const APP_VERSION = 'v3.13';   // MUST match service-worker CACHE_NAME (self-heal compares them). Bump as v1.13, v1.14…
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
  const btn = document.getElementById('font-toggle-btn');
  if (btn) btn.innerHTML = magicFont ? ic('ic-sparkles',13)+' 魔法字體' : ic('ic-sparkles',13)+' 系統字體';
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
// Render free tier sleeps when idle; the first request can take 30-50s to wake.
// Show a friendly overlay if any request runs longer than ~3.5s.
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
    // Render free tier sleeps when idle; the first hit can drop the connection while it wakes.
    // Retry network-level failures a few times (keeping the 喚醒中 overlay up) so cold starts are transparent.
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await fetch(API + path, { ...opts, headers }); break; }
      catch (netErr) {
        if (attempt >= 4) throw netErr;            // ~5 tries over ~30s, then give up
        if (!bg) _wakeToggle(true);
        await new Promise(r => setTimeout(r, 2000 + attempt * 2000));
      }
    }
    // A 401 from the login / invite-register forms means "wrong credentials" — surface that message
    // instead of treating it as an expired session (the refresh+logout path swallows it, so the user
    // saw nothing when they mistyped their 通關密語).
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
      throw new Error(e.detail || 'Request failed');
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
  if (_crop.target === 'customchar') {   // 自創角色頭像：存記憶體，等存角色時一起送
    _ccAvatar = dataUrl;
    setCcAvatarPreview(dataUrl);
    return;
  }
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
  if (!username) { shakeMsg('請輸入巫師入學全名'); return; }
  if (/\s/.test(username)) { shakeMsg('入學全名不能有空格'); return; }
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) { shakeMsg('入學全名只能用英文、數字、底線，2-20字'); return; }
  if (!nickname) { shakeMsg('請輸入巫師姓名（暱稱）'); return; }
  if (!invToken) { shakeMsg('找不到邀請令牌'); return; }
  msg.classList.remove('shake');
  msg.textContent = '建立帳號中…';
  try {
    await api('/invites/register', {
      method: 'POST',
      body: JSON.stringify({ token: invToken, username, password: pass, nickname, fingerprint: deviceFingerprint(), device: deviceToken() }),
    });
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
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
  document.querySelectorAll('.staff-only').forEach(el => el.style.display = staff ? '' : 'none');  // readers: no 防窺工坊
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = adminish ? '' : 'none');  // writers: only 作品管理 + 上傳
  document.querySelectorAll('.super-only').forEach(el => el.style.display = currentUser.role === 'super_admin' ? '' : 'none');  // 監看面板 + 實驗功能開關：只給 SA
  { const _bt = document.getElementById('beta-toggle'); if (_bt) _bt.checked = localStorage.getItem('pd_beta') === '1'; }
  { const _fx = document.getElementById('tapfx-toggle'); if (_fx) _fx.checked = localStorage.getItem('pd_tap_fx') !== '0'; }   // 點擊特效預設開
  { const _ow = document.getElementById('owl-toggle'); if (_ow) _ow.checked = localStorage.getItem('pd_owl_always') === '1'; }   // 貓頭鷹常駐預設關
  loadCustomChars().then(() => { if (typeof renderShelf === 'function') renderShelf(); });   // beta 自創角色載入後刷新角色列
  adminNovelScope = null;
  loadOwnerNames();   // super_admin only: map owner uuid → 巫師全名 for the owner hint
  loadFavIds().then(renderFavUpdates);   // 意若思鏡 收藏夾 ids + 追蹤更新 alert
  loadAppSettings();   // 全域設定（通知保留天數等）→ 載入後重算貓頭鷹
  renderSettings();
  renderGreeting();
  renderTourBanner();
  renderInstallHint();   // persistent home prompt for anyone not yet onboarded
  setTimeout(maybeShowEditorLetter, 700);   // 主編來信：登入後跳一次（已看過導覽的人才跳，不與新手導覽撞窗）
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
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  if (btn) btn.classList.add('active');
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
const TOUR_VERSION = '5';   // bump to re-show the (revised) tour to everyone
const TOUR_READER = [
  { page: 'home', target: '[data-tour="nav-home"]',
    html: "<span class='tour-h'>歡迎來到《預言家日報》</span>這裡是心動頁，封面會隨晨昏時段輪替登場。左上角若出現<b>貓頭鷹</b>，代表有信等你——追蹤的系列出了新作品、主編來信，或你的願望有了回音。" },
  { page: 'home', target: '#hero-heart',
    html: "<span class='tour-h'>他是誰？</span>點封面右上的<b>愛心</b>，走進角色設定頁——挑選你想在心動頁遇見的封面，也能下載帶浮水印的桌布。" },
  { page: 'scroll', target: '[data-tour="nav-scroll"]',
    html: "<span class='tour-h'>意若思鏡</span>這面鏡子映照出大家所有的作品——點這裡就能走進書架找文。" },
  { page: 'scroll', target: '#shelf-search-input',
    html: "<span class='tour-h'>召喚你想看的</span>輸入<b>篇名、作者或角色名</b>，想找的文章就會自己浮現，不必翻遍整座書庫。" },
  { page: 'scroll', target: '#shelf-char-chips',
    html: "<span class='tour-h'>只看某個人</span>點角色頭像，就只顯示有那位角色的故事，再點一次即可取消；選好兩個頭像再點「同框」，就只看兩人<b>同框</b>的文。<b>雙擊頭像</b>可直接開啟角色設定頁。" },
  { page: 'scroll', target: '#shelf-cat-pills',
    html: "<span class='tour-h'>故事分類</span><b>迷情劑</b>為受限內容、<b>吐真劑</b>為全年齡向、<b>儲思盆</b>是人物小傳與背景故事。迷情劑需先向管理員<b>申請開放</b>才看得到。" },
  { page: 'scroll', target: '#shelf-wish-btn',
    html: "<span class='tour-h'>許願池</span>想看的主題、主角，或想加的網站功能，都能在這裡許願——一律匿名，放心許。<b>被回覆時，貓頭鷹會叼信通知你</b>，點通知就能跳回那則願望。" },
  { page: 'forum', target: '[data-tour="nav-forum"]',
    html: "<span class='tour-h'>匿名羊皮紙</span>從這裡進入論壇體文章，看看大家都在討論些什麼——傳閱時小心點，別被級長抓到！讀文時點留言上的<b>羽毛筆</b>就能收藏，右上角「<b>收藏夾</b>」隨時找回來。" },
  { page: 'settings', target: '[data-tour="nav-settings"]',
    html: "<span class='tour-h'>個人檔案</span>字體大小、夜間模式、<b>語言選擇（原文／繁體／簡體）</b>都在閱讀偏好；頁面最下方能查看你手上的日報是否為最新一期。想<b>重看這份導覽</b>，到「檔案 → 小工具 → 新手導覽」。" },
];
const TOUR_WRITER_EXTRA = [
  { page: 'admin', target: '[data-tour="nav-admin"]',
    html: "<span class='tour-h'>編輯部</span>身為執筆人,你比讀者多了一個編輯部——你的創作基地就在這。" },
  { page: 'admin', before: () => switchAdminTab('upload'), target: '.admin-tab[data-tab="upload"]',
    html: "<span class='tour-h'>發表作品</span>點「上傳」就能開始發表你的故事。" },
  { page: 'admin', before: () => switchAdminTab('upload'), target: '[data-tour="upload-kind"]',
    html: "<span class='tour-h'>先選類型</span>先決定要發<b>小說</b>還是<b>論壇貼文</b>——兩種的欄位與格式不一樣,選錯了排版會怪怪的。" },
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
function tourSeen() {
  const need = tourTag();
  return _normTag(currentUser?.tour_seen) === need || _normTag(localStorage.getItem(tourSeenKey())) === need;
}
// Has this account seen ANY version of the tour for its CURRENT role? Used so a content/version
// bump doesn't force a full replay — auto-run only fires for genuinely new accounts (or a reader
// freshly promoted to writer). Existing users get the optional home banner instead.
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
  const steps = TOUR_READER.slice();
  if (currentUser && currentUser.role !== 'reader') steps.push(...TOUR_WRITER_EXTRA);
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
  const el = s.target ? document.querySelector(s.target) : null;
  if (!el) {  // missing target → centered bubble, no spotlight
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
  b.style.display = (currentUser && ['reader', 'writer'].includes(currentUser.role) && !tourSeen()) ? 'block' : 'none';
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
    name: 'Sean', emoji: '', img: './chars/sean_phone_2.JPG', imgs: ['./chars/sean_phone_1.JPG', './chars/sean_phone_2.JPG', './chars/sean_phone_3.JPG', './chars/sean_phone_4.JPG', './chars/sean_phone_5.JPG', './chars/sean_phone_6.JPG', './chars/sean_phone_7.JPG', './chars/sean_phone_8.JPG', './chars/sean_phone_10.JPG', './chars/sean_phone_11.JPG'], imgD: './chars/Sean_desktop_1.JPG', imgsD: ['./chars/Sean_desktop_1.JPG', './chars/sean_desktop_2.JPG', './chars/sean_desktop_3.JPG', './chars/sean_desktop_4.JPG'], bgPos: 'center 20%',
    quotes: [
      '早上好，今天也很漂亮。別懷疑，我說的是事實。',
      '中午好。終於下課了？我可以把你借走一會兒嗎？',
      '下午好。還撐得住嗎？不行的話，我帶你逃走十分鐘。',
      '晚上好。現在可以只看我了嗎？',
    ],
  },
  {
    name: 'Silas', emoji: '', img: './chars/silas_phone_2.JPG', imgs: ['./chars/silas_phone_1.JPG', './chars/silas_phone_2.JPG', './chars/silas_phone_3.JPG', './chars/silas_phone_4.JPG', './chars/silas_phone_5.JPG', './chars/silas_phone_6.JPG', './chars/silas_phone_7.JPG', './chars/silas_phone_8.JPG', './chars/silas_phone_9.JPG', './chars/silas_phone_10.JPG', './chars/silas_phone_11.JPG'], imgD: './chars/Silas_desktop_1.JPG', imgsD: ['./chars/Silas_desktop_1.JPG', './chars/silas_desktop_2.JPG', './chars/silas_desktop_3.JPG'], bgPos: 'center top', bgPosDesktop: 'center 30%',
    quotes: [
      '早上好。你的座位在這裡。',
      '中午好。先吃飯，你上午已經喝了兩杯咖啡了。',
      '下午好。你再看下去，今天晚上會頭疼。',
      '晚上好。門沒有鎖，但我想你會進來。',
    ],
  },
  {
    name: 'Eli', emoji: '', img: './chars/eli_phone_2.JPG', imgs: ['./chars/eli_phone_1.JPG', './chars/eli_phone_2.JPG', './chars/eli_phone_4.JPG', './chars/eli_phone_5.JPG', './chars/eli_phone_7.JPG', './chars/eli_phone_8.JPG', './chars/eli_phone_10.JPG', './chars/eli_phone_11.JPG'], imgD: './chars/Eli_desktop_1.JPG', imgsD: ['./chars/Eli_desktop_1.JPG', './chars/eli_desktop_2.JPG'], bgPos: 'center 20%',
    quotes: [
      '啊，早上好。你吃早飯了嗎？我這裡還有一塊餅乾。',
      '啊，中午好。剛剛有一隻蒲絨絨一直跟著我……我想它可能比較喜歡你。',
      '下午好。溫室現在有太陽，你要不要來看一下？',
      '晚上好……你冷不冷？',
    ],
  },
  {
    name: 'Adrian', emoji: '', img: './chars/adrian_phone_2.JPG', imgs: ['./chars/adrian_phone_1.JPG', './chars/adrian_phone_2.JPG', './chars/adrian_phone_3.JPG', './chars/adrian_phone_4.JPG', './chars/adrian_phone_7.JPG', './chars/adrian_phone_8.JPG', './chars/adrian_phone_10.JPG'], imgD: './chars/Adrian_desktop_1.JPG', imgsD: ['./chars/Adrian_desktop_1.JPG', './chars/adrian_desktop_2.JPG', './chars/adrian_desktop_3.JPG'], bgPos: 'center top', bgPosDesktop: 'center 20%',
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
  './chars/sean_phone_1.JPG',    // 水族箱：水面透亮、有日光
  './chars/sean_phone_3.JPG',    // 雨天陰天日光
  './chars/silas_phone_3.JPG',   // 窗邊明亮日光
  './chars/silas_phone_5.JPG',   // 臥室柔和日光
  './chars/eli_phone_1.JPG',     // 水族箱：偏亮有日光
  './chars/eli_phone_2.JPG',     // 溫室陽光
  './chars/eli_phone_5.JPG',     // 溫室日光（照料植物）
  './chars/sean_phone_5.JPG',    // 鬱金香花田＋風車、藍天大晴
  './chars/Silas_desktop_1.JPG', // 圖書館窗外日光（桌機）
  './chars/Eli_desktop_1.JPG',   // 教室窗光（桌機）
  './chars/eli_desktop_2.JPG',   // 溫室陽光（桌機）
  './chars/sean_desktop_3.JPG',  // 鬱金香花田（桌機橫版）
]);
const AFTERNOON_COVERS = new Set([ // 下午：日落/黃昏金色光
  './chars/sean_phone_6.JPG',    // 海邊日落（原 phone_4 改號）
  './chars/silas_phone_4.JPG',   // 金色逆光/黃昏
  './chars/adrian_phone_3.JPG',  // 佛羅倫斯日落
  './chars/adrian_desktop_3.JPG',// 佛羅倫斯日落（桌機橫版）
]);
// 傳回某封面的時段：am=早晨中午、pm=下午、night=夜晚(預設)。
function coverSlot(img) { return MORNING_COVERS.has(img) ? 'am' : AFTERNOON_COVERS.has(img) ? 'pm' : 'night'; }

// ── 角色設定頁 (beta) — 基本資料 + GitHub 圖庫。bio / gallery 由站長填寫；gallery 留空時自動用封面圖。
const CHAR_PROFILE = {
  Sean:   { bio: '', gallery: [] },
  Silas:  { bio: '', gallery: [] },
  Eli:    { bio: '', gallery: [] },
  Adrian: { bio: '', gallery: [] },
};
let _homeChar = null;   // 目前顯示在心動封面的角色(給封面愛心 → 角色頁用)
function excludedPhotos() {
  // beta：使用者逐張隱藏的心動封面照片(存照片路徑，含桌機版一起排除)。空 = 全部顯示。
  return new Set((currentUser && currentUser.home_chars ? String(currentUser.home_chars).split(',') : [])
    .map(s => s.trim()).filter(Boolean));
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
    html += `<div class="cp-cover-head"><h3>心動封面</h3><button class="cp-hint-btn" data-onclick="cpCoverHint()" aria-label="心動封面說明" title="心動封面說明">${ic('ic-help', 16)}</button><div class="cp-cover-note" id="cp-cover-note" hidden>點亮愛心即可加入心動封面；取消後不再出現。全部取消時，會恢復隨機輪替。</div></div>`;
    html += `<div class="cp-gallery">${photos.map((u, i) => {
      const on = !excluded.has(u);
      const dl = photoWallpaperUrl(u) ? `<button class="cp-download" data-onclick="downloadPhoto('${u}','${escapeHtml(name)}')" aria-label="下載桌布" title="下載桌布">${DL}</button>` : '';
      const heart = `<button class="cp-cover-toggle${on ? ' on' : ''}" data-onclick="toggleCoverPhoto('${name}', ${i}, this)" role="checkbox" aria-checked="${on}" aria-label="心動封面顯示這張">${HEART}</button>`;
      return `<div class="cp-shot" style="background-image:url('${u}')">${heart}${dl}</div>`;
    }).join('')}</div>`;
  }
  html += `<div class="cp-section"><h3>基本資料</h3><p class="cp-bio">${prof.bio ? escapeHtml(prof.bio) : '（基本資料待補充）'}</p></div>`;
  html += `<div class="cp-section"><h3>我為 ${escapeHtml(name)} 寫的文章</h3>`;
  html += myWorks.length
    ? myWorks.map(n => `<a class="cp-work" href="#" data-onclick="closeCharProfile();openNovel('${n.id}');return false;">${ic('ic-book', 14)} ${escapeHtml(n.title)}</a>`).join('')
    : `<p class="cp-hint">還沒有你為這個角色寫的文章。</p>`;
  html += `</div>`;
  document.getElementById('cp-body').innerHTML = html;
}
// 逐張開關：勾 = 這張出現在心動封面，取消 = 隱藏。連同同一序的桌機版一起排除(照顧桌機讀者)。
// 封面愛心說明(收進 tooltip:點 ⓘ 才出現,不直接佔版面)
function cpCoverHint() { const n = document.getElementById('cp-cover-note'); if (n) n.hidden = !n.hidden; }
async function toggleCoverPhoto(charName, index, btn) {
  const c = CHARS.find(x => x.name === charName) || {};
  const ids = [(c.imgs || [c.img])[index], (c.imgsD || [])[index]].filter(Boolean);
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
// ./chars/sean_phone_2.JPG → ./wallpapers/sean_phone_2_wall.jpg
function photoWallpaperUrl(img) {
  if (!img) return null;
  return img.replace('./chars/', './wallpapers/').replace(/\.(jpe?g)$/i, '_wall.jpg');
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

function renderGreeting() {
  const h = new Date().getHours();
  // 時段 index：0=早上(5-11) 1=中午(12-13) 2=下午(14-17) 3=晚上/深夜(18-4)
  const timeIdx = h >= 5 && h < 12 ? 0 : h >= 12 && h < 14 ? 1 : h >= 14 && h < 18 ? 2 : 3;
  const period = h < 5 ? '深夜好' : h < 12 ? '早安' : h < 18 ? '午安' : '晚安';
  const isWide = window.matchMedia('(min-width: 600px)').matches;
  const photosOf = c => ((isWide ? (c.imgsD || [c.imgD]) : (c.imgs || [c.img])) || []).filter(Boolean);
  // 以「照片」為單位建池：使用者未取消的照片(連同角色)都是候選。全被取消 → 退回全部隨機。
  const excluded = excludedPhotos();
  let selected = [];
  CHARS.forEach(c => photosOf(c).forEach(img => { if (!excluded.has(img)) selected.push({ char: c, img }); }));
  if (!selected.length) CHARS.forEach(c => photosOf(c).forEach(img => selected.push({ char: c, img })));
  // 時段門檻：06:00–14:30 早晨＆中午(am)、14:30–18:00 下午(pm)、其餘夜晚(night；無陽光者默認夜晚)。
  const mins = h * 60 + new Date().getMinutes();
  const slot = (mins >= 360 && mins < 870) ? 'am' : (mins >= 870 && mins < 1080) ? 'pm' : 'night';
  let pool = selected.filter(x => coverSlot(x.img) === slot);
  // 保底：使用者的選取在當前時段沒有任何圖 → 忽略時段，改在他選的那幾張裡隨機輪轉(不留白)。
  if (!pool.length) pool = selected;
  const pick = pool[Math.floor(Math.random() * pool.length)] || { char: CHARS[0], img: CHARS[0].img };
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
  const showHero = (url, pos) => {     // photo layered OVER the gradient (gradient stays as fallback)
    hero.style.backgroundImage = `url('${url}'), ${GRAD}`;
    hero.style.backgroundPosition = `${pos}, center`;
    hero.style.backgroundRepeat = 'no-repeat, no-repeat';
    hero.style.backgroundSize = `${char.bgSize || 'cover'}, cover`;
    emoji.style.display = 'none';
  };
  // 候選圖：先用挑中的那張，載入失敗時退回同角色其他「未隱藏」的照片，最後才是全部(避免空白)。
  const heroPos = isWide ? (char.bgPosDesktop || char.bgPos || 'center') : (char.bgPos || 'center');
  let candidates = [pick.img, ...photosOf(char).filter(u => !excluded.has(u)), ...photosOf(char)];
  candidates = [...new Set(candidates.filter(Boolean))];   // dedup, keep order
  (function tryLoad(i) {
    if (i >= candidates.length) return;   // all failed → keep the gradient + emoji
    const im = new Image();
    im.onload = () => showHero(candidates[i], heroPos);
    im.onerror = () => tryLoad(i + 1);
    im.src = candidates[i];
  })(0);
  const now = new Date();
  const db = document.getElementById('date-banner');   // element was removed; guard so renderGreeting can't throw
  if (db) db.textContent = `${now.getFullYear()} 年 ${now.getMonth()+1} 月 ${now.getDate()} 日 · 巫師界頭條`;
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
  try { novels = await api('/novels/?kind=novel') || []; novelsError = false; }
  catch { novels = []; novelsError = true; }
  try { hotIds = await api('/novels/hot') || []; } catch { hotIds = []; }
  renderShelf();
  renderContinueBar();
}

// ── Classification (category + characters) ───────────────────
const CATEGORIES = ['迷情劑', '吐真劑', '儲思盆'];
const CHAR_LIST = [
  { code: 'sean',   name: 'Sean',   img: './chars/sean_phone_2.JPG' },   /* phone_1 暫時下架 */
  { code: 'silas',  name: 'Silas',  img: './chars/silas_phone_2.JPG' },  /* phone_1 暫時下架 */
  { code: 'eli',    name: 'Eli',    img: './chars/eli_phone_2.JPG' },    /* phone_1 暫時下架 */
  { code: 'adrian', name: 'Adrian', img: './chars/adrian_phone_2.JPG' }, /* phone_1 暫時下架 */
];
let shelfCat = '';        // '' = 全部
let shelfChars = [];   // default: none lit = show everything; tap a character to filter to them (OR)
// 作品管理 (admin works) filter. Type pills include 羊皮紙 (=forum) on top of the 3 novel categories.
const ADMIN_CATS = ['迷情劑', '吐真劑', '儲思盆', '羊皮紙'];
let adminCat = '';        // '' | 迷情劑 | 吐真劑 | 儲思盆 | 羊皮紙
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
  if (favIds && favIds.size) {
    let all = null;
    try { all = await api('/novels/') || []; } catch (e) { all = null; }
    if (all) {
      const since = new Map();   // 系列 → 追蹤起點（最早收藏時間）
      all.forEach(n => {
        if (!n.series || !favIds.has(n.id)) return;
        const t = favTimes.get(n.id);
        if (t && (!since.has(n.series) || new Date(t) < new Date(since.get(n.series)))) since.set(n.series, t);
      });
      all.forEach(n => {
        if (!n.series || !n.created_at || !since.has(n.series)) return;
        const c = new Date(n.created_at).getTime();
        if (c > new Date(since.get(n.series)).getTime() && c >= cutoff) {
          items.push({ kind: 'work', id: n.id, key: `work:${n.id}`, title: `系列《${n.series}》新作品`, sub: n.title, at: n.created_at, unread: !read.has(n.id) });
        }
      });
    }
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
    const gold = it.kind === 'letter' || it.kind === 'wishreply';   // 主編來信、你的願望回音＝金點
    const dotClass = it.unread ? (gold ? 'fav-dot gold' : 'fav-dot') : 'fav-dot read';
    const cls = `fav-row${it.unread ? '' : ' read'}`;
    // 叉叉用索引指到 _owlItems（key 可能含任意文字，不能塞進屬性）
    const inner = `<span class="${dotClass}"></span>`
      + `<span class="fav-row-main"><span class="fav-row-t">${escapeHtml(it.title)}</span>`
      + `<span class="fav-row-s">${escapeHtml(it.sub)}・${fmtUpdated(it.at)}</span></span>`
      + `<button class="fav-row-del" data-onclick="dismissNotice(${i});return false" aria-label="移除這則通知">${ic('ic-x', 13)}</button>`;
    if (it.kind === 'letter') return `<a href="#" data-onclick="openEditorLetter();return false" class="${cls}">${inner}</a>`;
    if (it.kind === 'wishreply') return `<a href="#" data-onclick="wishReplyOpen('${it.id}');return false" class="${cls}">${inner}</a>`;
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
function favOwlOpen(id) { const p = document.getElementById('fav-owl-pop'); if (p) p.hidden = true; _markInstallmentRead(id); openNovel(id); }
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
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) { const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); }
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
async function replyFeedback(id, kind) {
  const reply = prompt('回覆內容(留白可清除):');
  if (reply === null) return;
  try { await api(`/feedback/${id}`, { method: 'PATCH', body: JSON.stringify({ admin_reply: reply || ' ' }) }); loadFeedback(kind); }
  catch (e) { toast(e.message); }
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
// ccSet: when a 自創角色 is selected, its tagged-novel Set. It joins the SAME 任一/同框 (OR/AND)
// evaluation as the official characters — it is NOT a separate AND gate (that made 自創+官方 an
// impossible intersection in OR mode).
function applyClassFilter(list, cat, chars, ccSet) {
  const sel = (chars || []).filter(Boolean);
  const ccActive = !!ccSet;
  const noFilter = (sel.length === 0 && !ccActive) || (!charAnd && sel.length === CHAR_LIST.length && !ccActive);
  return list.filter(n => {
    if (cat && n.category !== cat) return false;
    if (!noFilter) {
      const have = n.characters || [];
      const checks = sel.map(c => have.includes(c));
      if (ccActive) checks.push(ccSet.has(n.id));
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
  else if (document.getElementById('page-forum').classList.contains('active')) renderForumList();
  else if (document.getElementById('page-admin').classList.contains('active')) renderAdminNovels();
}

function renderFilterBar(catEl, chipEl, curCat, curChars, onChange) {
  catEl.innerHTML =
    CATEGORIES.map(c => `<button class="cat-pill ${curCat === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('');
  catEl.querySelectorAll('.cat-pill').forEach(b => b.onclick = () => onChange('cat', b.dataset.c));
  chipEl.innerHTML = CHAR_LIST.map(ch =>
    `<div class="char-chip ${curChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}">
       <img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span>
     </div>`).join('') +
    // 自創角色(意若思鏡篩選列)：有角色就顯示 chip 可篩選(含他人分享給讀者/作家的)；建立鈕只給管理員(isBeta)
    (chipEl.id === 'shelf-char-chips'
      ? _customChars.map(c => { const av = safeAvatarDataUrl(c.avatar); const sh = c.mine === false; return `<div class="char-chip char-custom${_ccFilter === c.id ? ' cc-on' : ''}${sh ? ' cc-shared' : ''}" data-onclick="ccTap('${c.id}')" title="${sh ? '他人分享（唯讀，可篩選）' : '單擊篩選・雙擊編輯'}"><div class="cc-ava"${av ? ` style="background-image:url(&quot;${av}&quot;)"` : ''}>${av ? '' : ic('ic-wand', 20)}</div><span>${escapeHtml(c.name)}${sh ? ' ' + ic('ic-users', 10) : ''}</span></div>`; }).join('')
        + (isBeta() ? `<div class="char-chip char-add" data-onclick="openCreateChar()" role="button" tabindex="0" aria-label="建立角色" title="建立自創角色"><div class="add-circle">＋</div></div>` : '')
      : '');
  chipEl.querySelectorAll('.char-chip[data-ch]').forEach(el => el.onclick = () => officialCharTap(el.dataset.ch, onChange));
  mountCharAndBtn('shelf-char-and');
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
    return `${eIc('ic-clock')}你已申請開放「迷情劑」<br><small>管理員通過後即可閱讀</small>`;
  if (a === 'rejected')
    return `${eIc('ic-ban')}你的「迷情劑」閱讀申請未通過<br><small style="display:block;margin-bottom:14px">如有異議，可再次提出申請</small>${applyBtn('再次申請')}`;
  return `${eIc('ic-key')}「迷情劑」分類需開放才能閱讀<br><small style="display:block;margin-bottom:14px">點下方按鈕向管理員申請</small>${applyBtn('要求管理員開放')}`;
}

// ── EXPERIMENTAL feature gate ──────────────────────────────────────────────
// isBeta() gates the 自創角色 (custom-character) beta UI only — the 心動 profile / cover-photo
// preference / wallpaper download are now public. Admins always have it (no toggle); the
// super_admin gates their own view with the pd_beta flag (the 實驗功能 switch, super-only). The flag
// lives in localStorage so it survives PWA launches; toggle in 檔案 → 小工具 → 實驗功能 or ?beta=1/0.
// Backend stays the real gate (require_admin).
(function () {
  const b = new URLSearchParams(location.search).get('beta');
  if (b === '1' || b === '') localStorage.setItem('pd_beta', '1');
  else if (b === '0') localStorage.removeItem('pd_beta');
})();
function isBeta() {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;   // admins: feature is just on, no toggle
  return currentUser.role === 'super_admin' && localStorage.getItem('pd_beta') === '1';   // super: behind their 實驗功能 switch
}
function setBetaFlag(on) {
  if (on) localStorage.setItem('pd_beta', '1'); else localStorage.removeItem('pd_beta');
  toast(on ? '實驗功能已開啟' : '實驗功能已關閉');
  loadCustomChars().then(() => { if (typeof renderShelf === 'function') renderShelf(); });   // 角色列出現/隱藏自創角色 + ＋
}

// ── 自創角色 (beta) — private custom characters: name + avatar, edit/delete ────────
let _customChars = [], _ccEditId = null, _ccAvatar = null, _ccTags = {}, _ccFilter = '', _ccTapTimer = null;
let _ccMembers = null, _ccShareInit = new Set();   // 分享：成員名單(快取) + 編輯時的初始分享對象
async function loadCustomChars() {
  // Load for EVERY member: admins get their own + shared; readers/writers get only chars shared
  // with them (read-only). Creating/managing still gates on isBeta() in the UI + backend.
  if (!currentUser) { _customChars = []; _ccTags = {}; _ccFilter = ''; return; }
  try {
    _customChars = await api('/custom-chars/') || [];
    const tags = await api('/custom-chars/tags') || [];
    _ccTags = {};   // char_id -> Set(novel_id)
    tags.forEach(t => { (_ccTags[t.char_id] = _ccTags[t.char_id] || new Set()).add(t.novel_id); });
  } catch (e) { _customChars = []; _ccTags = {}; }
  // if the active filter points at a character that no longer exists (e.g. just deleted),
  // drop it — otherwise renderShelf keeps filtering to an empty set and "沒有符合的作品" sticks.
  if (_ccFilter && !_customChars.some(c => c.id === _ccFilter)) _ccFilter = '';
  renderUploadCcPicker();
}
// 單擊 = 選取(篩選作品)；雙擊 = 打開編輯
function ccTap(id, rerender) {
  const draw = rerender || renderShelf;   // 意若思鏡用 renderShelf；作品管理傳 renderAdminNovels
  if (_ccTapTimer) {
    clearTimeout(_ccTapTimer); _ccTapTimer = null;
    const c = _customChars.find(x => x.id === id);
    if (c && c.mine !== false) editCustomChar(id);   // 只有擁有者能編輯；他人分享的 = 只能篩選
  } else {
    _ccTapTimer = setTimeout(() => { _ccTapTimer = null; _ccFilter = (_ccFilter === id) ? '' : id; draw(); }, 320);
  }
}
function setCcAvatarPreview(url) {
  const el = document.getElementById('cc-avatar-preview');
  const safe = safeAvatarDataUrl(url);
  if (safe) { el.style.backgroundImage = `url("${safe}")`; el.innerHTML = ''; }
  else { el.style.backgroundImage = 'none'; el.innerHTML = ic('ic-camera', 24); }
}
function openCreateChar() {
  _ccEditId = null; _ccAvatar = null;
  document.getElementById('cc-modal-title').textContent = '建立角色';
  document.getElementById('cc-name').value = '';
  setCcAvatarPreview('');
  _ccShareInit = new Set();
  document.getElementById('cc-share-toggle').checked = false;
  toggleCcShare(false);
  document.getElementById('cc-delete-btn').style.display = 'none';
  document.getElementById('custom-char-modal').classList.add('open');
}
function editCustomChar(id) {
  const c = _customChars.find(x => x.id === id);
  if (!c || c.mine === false) return;   // 他人分享的角色唯讀，不開編輯
  _ccEditId = id; _ccAvatar = c.avatar || null;
  document.getElementById('cc-modal-title').textContent = '編輯角色';
  document.getElementById('cc-name').value = c.name || '';
  setCcAvatarPreview(c.avatar || '');
  _ccShareInit = new Set(c.shared_with || []);
  const on = _ccShareInit.size > 0;
  document.getElementById('cc-share-toggle').checked = on;
  toggleCcShare(on);   // 有分享就展開名單(勾好現有對象)
  document.getElementById('cc-delete-btn').style.display = '';
  document.getElementById('custom-char-modal').classList.add('open');
}
// 取得全體成員(快取)，按身分高→低排序，給分享名單用
async function ensureCcMembers() {
  if (_ccMembers) return;
  try {
    const list = await api('/permissions/users') || [];
    const RANK = { super_admin: 3, admin: 2, writer: 1, reader: 0 };
    _ccMembers = list.slice().sort((a, b) =>
      (RANK[b.role] || 0) - (RANK[a.role] || 0)
      || (a.nickname || a.username || '').localeCompare(b.nickname || b.username || ''));
  } catch (e) { _ccMembers = []; }
}
function renderCcShareList(selected) {
  const el = document.getElementById('cc-share-list');
  const rows = (_ccMembers || []).filter(u => u.id !== currentUser.id).map(u => {
    const checked = selected.has(u.id) ? 'checked' : '';
    const role = ROLE_NAME[u.role] || u.role;
    return `<label style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:13px;border-top:1px solid rgba(26,10,0,.05)">
      <input type="checkbox" class="cc-share-cb" value="${u.id}" ${checked} style="flex-shrink:0;width:16px;height:16px" />
      <span style="flex:1;color:var(--ink)">${escapeHtml(u.nickname || u.username || '')}</span>
      <span style="font-size:11px;color:var(--ink-light)">${escapeHtml(role)}</span>
    </label>`;
  }).join('');
  el.innerHTML = rows || '<p style="font-size:12px;color:var(--ink-light);padding:8px 12px;margin:0">沒有其他成員</p>';
}
async function toggleCcShare(on) {
  const list = document.getElementById('cc-share-list');
  if (!on) { list.style.display = 'none'; return; }
  await ensureCcMembers();
  renderCcShareList(_ccShareInit);
  list.style.display = 'block';
}
function ccPickAvatar(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { toast('請選擇圖片檔'); return; }
  if (_crop.url) URL.revokeObjectURL(_crop.url);
  _crop.url = URL.createObjectURL(f);
  _crop.target = 'customchar';   // 裁切結果存到自創角色，不是個人頭像
  const img = new Image();
  img.onload = () => openAvatarCrop(img);
  img.onerror = () => toast('圖片讀取失敗');
  img.src = _crop.url;
}
async function saveCustomChar() {
  const name = document.getElementById('cc-name').value.trim();
  if (!name) { toast('請輸入角色名稱'); return; }
  // 分享對象：開了開關才分享。名單已展開 → 讀勾選；沒展開 → 沿用原本(_ccShareInit)。關閉 → 不分享([])。
  let shared_with = [];
  if (document.getElementById('cc-share-toggle').checked) {
    const cbs = document.querySelectorAll('#cc-share-list .cc-share-cb');
    shared_with = cbs.length ? [...cbs].filter(cb => cb.checked).map(cb => cb.value) : [..._ccShareInit];
  }
  try {
    const body = JSON.stringify({ name, avatar: _ccAvatar, shared_with });
    if (_ccEditId) await api('/custom-chars/' + _ccEditId, { method: 'PATCH', body });
    else await api('/custom-chars/', { method: 'POST', body });
    toast('已儲存');
    document.getElementById('custom-char-modal').classList.remove('open');
    await loadCustomChars();
    renderShelf();
  } catch (e) { toast(e.message || '儲存失敗'); }
}
async function deleteCustomChar() {
  if (!_ccEditId || !confirm('刪除這個角色？')) return;
  try {
    await api('/custom-chars/' + _ccEditId, { method: 'DELETE' });
    document.getElementById('custom-char-modal').classList.remove('open');
    await loadCustomChars();
    renderShelf();
  } catch (e) { toast(e.message); }
}
// 後台上傳：自創角色選擇器(只在 beta 顯示),上傳時把作品歸到選中的自創角色底下
// Shared 自創角色 picker — used by 上傳 and the 分類 editor. Only the user's OWN chars (shared-in
// ones are read-only). `selected` pre-lights the chars a work is already filed under.
function renderCcPickerInto(boxId, groupId, selected) {
  const group = document.getElementById(groupId);
  const box = document.getElementById(boxId);
  if (!group || !box) return;
  const mine = _customChars.filter(c => c.mine !== false);
  if (!isBeta() || !mine.length) { group.style.display = 'none'; return; }
  group.style.display = '';
  box.innerHTML = mine.map(c =>
    `<button type="button" class="cc-pick${selected && selected.has(c.id) ? ' on' : ''}" data-cc="${c.id}" data-onclick="this.classList.toggle('on')">${escapeHtml(c.name)}</button>`).join('');
}
function renderUploadCcPicker() { renderCcPickerInto('new-novel-cc', 'new-novel-cc-group', null); }
// Which custom chars a work is currently filed under (from the cached private tag map).
function ccTaggedSet(novelId) {
  const s = new Set();
  for (const cid in _ccTags) { if (_ccTags[cid] && _ccTags[cid].has(novelId)) s.add(cid); }
  return s;
}
function readUploadCc() {
  return [...document.querySelectorAll('#new-novel-cc .cc-pick.on')].map(b => b.dataset.cc);
}
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
  let list = applyClassFilter(novels, shelfCat, shelfChars, _ccFilter ? (_ccTags[_ccFilter] || new Set()) : null);
  const q = (document.getElementById('shelf-search-input')?.value || '').trim().toLowerCase();
  if (q) list = list.filter(n => matchesQuery(n, q));
  // Only on the plain default view (no search, 全部, no character filter), float the 24h hot
  // works to the front — silently, no label.
  const noCharFilter = (shelfChars.length === 0 || shelfChars.length === CHAR_LIST.length) && !_ccFilter;
  if (!q && shelfCat === '' && noCharFilter && hotIds.length) {
    const hot = hotIds.map(id => list.find(n => n.id === id)).filter(Boolean);
    if (hot.length) {
      const hotSet = new Set(hot.map(n => n.id));
      list = [...hot, ...list.filter(n => !hotSet.has(n.id))];
    }
  }
  renderNovelBlocks(list, grid, `<span style="display:block;margin-bottom:8px">${ic('ic-mirror', 30)}</span>沒有符合的作品`);
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
      blocks.push(`
        <div class="series-block">
          <div class="series-head">${ic('ic-books', 14)} ${escapeHtml(n.series)}</div>
          ${members.map(m => shelfRow(m, true)).join('')}
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
      <h4>${inSeries && n.series_order ? `<span style="color:var(--ink-light);font-weight:normal">#${n.series_order}　</span>` : ''}${escapeHtml(n.title)}</h4>
      <div class="row-meta">${escapeHtml(n.author || '佚名')}${ownerTag(n)}${n.created_at ? ` · ${ic('ic-calendar',11)} ${fmtUpdated(n.created_at)}` : ''}</div>
      <div class="row-tags">
        ${n.category ? `<span class="t-cat${n.category === '吐真劑' ? ' t-cat-green' : ''}">${escapeHtml(n.category)}</span>` : ''}
        ${(n.characters || []).map(c => `<span class="t-chr">${escapeHtml(charNames([c]))}</span>`).join('')}
      </div>
    </div>`;
}

function renderHomeNovels() {
  const el = document.getElementById('home-novels');
  if (!novels.length) { el.innerHTML = '<p style="font-size:13px;color:#888">尚無已授權作品</p>'; return; }
  el.innerHTML = novels.slice(0, 3).map(n => `
    <div class="novel-card-sm" data-onclick="openNovel('${n.id}')">
      <div class="cover">${ic('ic-book', 40)}</div>
      <div class="info"><h4>${escapeHtml(n.title)}</h4><p>${escapeHtml(n.author || '佚名')}</p></div>
    </div>`).join('');
}

// ── Reader ───────────────────────────────────────────────────
let currentNovelKind = 'novel';
let currentNovelTitle = '';

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
  api(`/novels/${novelId}/view`, { method: 'POST' }).catch(() => {});   // log a view (best-effort) for the hot ranking
  let novel = [...forumPosts, ...novels].find(n => n.id === novelId);
  if (!novel) { try { novel = await api(`/novels/${novelId}`); } catch {} }
  markSeriesSeenForWork(novel);   // opening a new series installment clears its 追蹤更新 flag
  currentNovelKind = (novel && novel.kind) || 'novel';
  currentNovelTitle = (novel && novel.title) || '';
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
  loadChapter(0).then(() => updateSeriesNav(novel));   // show 上一篇/下一篇 only after the content is in
}

// ── 系列(上下集)導覽 ─────────────────────────────────────────
let _seriesSibs = [], _seriesIdx = -1;
async function updateSeriesNav(novel) {
  const nav = document.getElementById('reader-series-nav');
  _seriesSibs = []; _seriesIdx = -1;
  // Only for 小說 that belong to a series. The server returns the FULL part list — including 迷情劑
  // parts the reader can't open yet (as locked stubs) — so 上下篇 surfaces an access gate for them
  // instead of silently skipping. Fall back to the visible shelf list if the call fails.
  if (novel && novel.series && novel.kind !== 'forum') {
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
  } catch { document.getElementById('reader-content').textContent = '載入失敗'; }
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
    }));
    renderContinueBar();
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

function closeReader() { document.getElementById('reader-view').classList.remove('open'); }

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
  // entering the forum always resets to the 全部 view
  forumView = 'all';
  const ffb = document.getElementById('forum-fav-btn'); if (ffb) ffb.classList.remove('on');
  const fb = document.querySelector('#page-forum .filter-bar'); if (fb) fb.style.display = '';
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
  forumView = forumView === 'liked' ? 'all' : 'liked';
  const btn = document.getElementById('forum-fav-btn'); if (btn) btn.classList.toggle('on', forumView === 'liked');
  document.querySelector('#page-forum .filter-bar').style.display = forumView === 'liked' ? 'none' : '';
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
  el.innerHTML = posts.map(p => `
    <div class="forum-post-row" data-onclick="openNovel('${p.id}')">
      <h4>${escapeHtml(p.title)}</h4>
      <div class="meta">
        <span>${escapeHtml(p.author || '匿名')}${ownerTag(p)}</span>
        <span>${ic('ic-calendar',11)} ${fmtUpdated(p.created_at)}</span>
        ${p.liked_count ? `<span style="color:var(--accent)">${ic('ic-feather', 11)} 收藏了 ${p.liked_count} 則</span>` : ''}
        ${p.status === 'pending' ? '<span class="pending-tag">' + ic('ic-clock',11) + ' 待審核</span>' : ''}
      </div>
      ${(p.characters || []).length ? `<div class="row-tags" style="margin-top:7px">${(p.characters || []).map(c => `<span class="t-chr">${escapeHtml(charNames([c]))}</span>`).join('')}</div>` : ''}
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
  approve_novel: '核准作品', delete_novel: '刪除作品', lock: '鎖上作品', unlock: '解鎖作品',
  ban: '封禁帳號', unban: '解除封禁', temp_ban: '臨時封禁', temp_unban: '解除臨時封禁',
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

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('admin-' + tab).classList.add('active');
  stopMonitor();                       // leaving any tab cancels the live monitor poll
  if (tab === 'monitor') { startMonitor(); loadAuditLog(); }   // 操作紀錄 lives at the bottom of 監看
  if (tab === 'novels') loadAdminNovelList();
  if (tab === 'users') loadAdminUsers();
  if (tab === 'upload') { setUploadKind('novel'); initUploadDraftWatch(); restoreUploadDraft(); }
  if (tab === 'review') loadReviewList();
  if (tab === 'invites') {
    // super_admin only: 管理員邀請 button + 批次數量 selector (admins generate one at a time)
    const isSuper = currentUser.role === 'super_admin';
    document.getElementById('invite-admin-btn').style.display = isSuper ? '' : 'none';
    document.getElementById('invite-qty-row').style.display = isSuper ? 'flex' : 'none';
    if (!isSuper) document.getElementById('invite-qty').value = '1';
    loadInviteList();
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
async function loadMonitor() {
  const el = document.getElementById('monitor-body');
  if (!el) return;
  if (!el.dataset.loaded) el.innerHTML = '<div class="spinner"></div>';
  try {
    const s = await api('/permissions/server-stats', { background: true });
    el.dataset.loaded = '1';
    // Latency is now a 2-min window, so the cold-boot requests age out by ~150s → shorter grace.
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
    el.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${card(ic('ic-clock', 12) + ' 回應時間', rtVal, rtSub, true)}
        ${card(ic('ic-gear', 12) + ' 記憶體', memMb != null ? memMb + ' MB' : '—', memSub)}
        ${card(ic('ic-users', 12) + ' 在線（5 分鐘）', s.active_5m, '15 分鐘內 ' + s.active_15m + ' 人')}
        ${card(ic('ic-send', 12) + ' 請求量', s.req_1m + ' /分', '近 5 分 ' + s.req_5m + '　' + s.rps_1m + ' req/s')}
        ${card(ic('ic-shield', 12) + ' 錯誤（5 分鐘）', s.errors_5m, s.errors_5m ? '伺服器錯誤，請留意' : '無 5xx 錯誤')}
        ${card(ic('ic-castle', 12) + ' 已運行', _fmtUptime(s.uptime_seconds), s.uptime_seconds < 90 ? '剛冷啟動' : '累計請求 ' + s.total_since_boot)}
      </div>
      ${jwtPct === null ? '' : (jwtPct >= 80
        ? `<div style="font-size:11px;color:#2d4a1e;margin-top:10px">${ic('ic-shield', 11)} JWT 本機驗證：<b>啟用中</b>（${jwtPct}%）— 已省去每次請求對 Supabase 的一次往返</div>`
        : `<div style="font-size:12px;color:var(--scarlet);margin-top:10px;line-height:1.5">${ic('ic-shield', 11)} JWT 本機驗證：<b>未啟用</b>（本機僅 ${jwtPct}%）— 請把 Render 的 <b>JWT_SECRET</b> 設成你的 Supabase JWT 密鑰，回應時間才會降下來</div>`)}
      <div style="font-size:11px;color:var(--ink-light);opacity:.7;margin-top:10px">※「在線」以近 5 分鐘有送出請求的登入用戶計；純閱讀時前端不送請求，故為活躍下限值。</div>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--scarlet);padding:14px">載入失敗：${escapeHtml(e.message || '')}</p>`;
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

function setUploadKind(kind) {
  initClassPicker('forum-post-category', 'forum-post-chars');
  initClassPicker('new-novel-category', 'new-novel-chars');
  const isNovel = kind === 'novel';
  document.getElementById('upload-kind-novel').style.display = isNovel ? '' : 'none';
  document.getElementById('upload-kind-forum').style.display = isNovel ? 'none' : '';
  document.getElementById('kind-novel-btn').style.background = isNovel ? 'var(--scarlet)' : 'var(--parchment2)';
  document.getElementById('kind-novel-btn').style.color = isNovel ? 'var(--on-dark)' : 'var(--ink-light)';
  document.getElementById('kind-forum-btn').style.background = isNovel ? 'var(--parchment2)' : 'var(--scarlet)';
  document.getElementById('kind-forum-btn').style.color = isNovel ? 'var(--ink-light)' : 'var(--on-dark)';
  // Default the novel author署名 to the uploader's nickname (still editable).
  const na = document.getElementById('new-novel-author');
  if (isNovel && na && !na.value) na.value = currentUser.nickname || currentUser.username || '';
  const writerNote = (currentUser.role === 'writer')
    ? (currentUser.auto_publish ? '你已獲得自動審核，作品送出後直接公開、免等待' : '作品需經管理員審核通過才公開')
    : '';
  const fh = document.getElementById('forum-post-hint'); if (fh) fh.textContent = writerNote;
  const nh = document.getElementById('new-novel-hint'); if (nh) nh.textContent = writerNote;
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

async function submitForumPost() {
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
}

async function loadReviewList() {
  const el = document.getElementById('admin-review-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const [pending, users] = await Promise.all([
      api('/novels/pending').catch(() => []),
      api('/permissions/users').catch(() => []),
    ]);
    const mqjReqs = (users || []).filter(u => u.mqj_access === 'pending');
    const novelsPending = pending || [];
    const arrow = `<svg class="rv-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
    const section = (icon, title, count, bodyHtml, openByDefault = true) => `
      <details class="review-sec"${count && openByDefault ? ' open' : ''}>
        <summary>${arrow}${ic(icon, 14)} ${title}<span class="rv-count${count ? '' : ' zero'}">${count}</span></summary>
        <div class="rv-body">${count ? bodyHtml : '<p style="color:var(--ink-light);font-size:13px;padding:8px 0 14px">目前沒有待審核的項目</p>'}</div>
      </details>`;

    const mqjBody = mqjReqs.map(u => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(26,10,0,.1)">
          <div style="font-size:14px;font-weight:bold">${escapeHtml(u.nickname || u.username)} <span style="font-size:12px;color:var(--ink-light);font-weight:normal">@${escapeHtml(u.username)}</span></div>
          <div style="font-size:12px;color:var(--ink-light);margin-top:3px">申請閱讀「迷情劑」分類</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button data-onclick="reviewMqj('${u.id}', true)" style="font-size:12px;padding:4px 12px;background:#2d4a1e;border:none;color:#fff;border-radius:3px;cursor:pointer">${ic('ic-check',12)} 通過</button>
            <button data-onclick="reviewMqj('${u.id}', false)" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-x',12)} 不通過</button>
          </div>
        </div>`).join('');

    const novelBody = novelsPending.map(n => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(26,10,0,.1)">
          <div style="font-size:14px;font-weight:bold">${escapeHtml(n.title)}</div>
          <div style="font-size:12px;color:var(--ink-light);margin-top:3px">${n.kind === 'forum' ? ic('ic-scroll', 12) + ' 論壇貼文' : ic('ic-book', 12) + ' 小說'}・${escapeHtml(n.author || '匿名')}・${fmtUpdated(n.created_at)}</div>
          <div class="row-tags" style="margin-top:6px">
            ${n.category ? `<span class="t-cat${n.category === '吐真劑' ? ' t-cat-green' : ''}">${escapeHtml(n.category)}</span>` : ''}
            ${(n.characters || []).map(c => `<span class="t-chr">${escapeHtml(charNames([c]))}</span>`).join('')}
          </div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button data-onclick="openNovel('${n.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">預覽</button>
            <button data-onclick="approveNovel('${n.id}')" style="font-size:12px;padding:4px 12px;background:#2d4a1e;border:none;color:#fff;border-radius:3px;cursor:pointer">${ic('ic-check',12)} 通過</button>
            <button data-onclick="deleteNovel('${n.id}', true)" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:3px;cursor:pointer">${ic('ic-x',12)} 退回</button>
          </div>
        </div>`).join('');

    el.innerHTML = section('ic-wine', '迷情劑閱讀權申請', mqjReqs.length, mqjBody, false)   // 預設收起
                 + section('ic-book', '作品審核', novelsPending.length, novelBody);
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
  try { await api(`/novels/${id}/approve`, { method: 'PATCH' }); toast('已通過審核'); loadReviewList(); }
  catch (e) { toast(e.message); }
}

// Create a single-piece novel: work metadata + body text in one shot (body becomes chapter 1).
async function submitNewNovel() {
  const title = document.getElementById('new-novel-title').value.trim();
  const content = document.getElementById('new-novel-content').value.trim();
  const category = document.getElementById('new-novel-category').value;
  if (!title) { toast('請輸入作品名稱'); return; }
  if (!category) { toast('請選擇故事類型'); return; }
  if (!content) { toast('請輸入內文'); return; }
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
    const _ccIds = readUploadCc();   // 把作品歸到選中的自創角色底下(私人)
    if (_ccIds.length) { try { await api('/custom-chars/tag', { method: 'POST', body: JSON.stringify({ novel_id: novel.id, char_ids: _ccIds }) }); await loadCustomChars(); } catch (e) {} }
    toast(novel.status === 'pending' ? '已送出，待管理員審核' : '小說已建立');
    ['new-novel-title', 'new-novel-author', 'new-novel-date', 'new-novel-content'].forEach(id => document.getElementById(id).value = '');
    document.querySelectorAll('#new-novel-cc .cc-pick.on').forEach(b => b.classList.remove('on'));
    resetClassPicker('new-novel-category', 'new-novel-chars');
    clearUploadDraft();
    loadNovels();
  } catch (e) { toast(e.message); }
}

async function loadAdminNovelList() {
  const el = document.getElementById('admin-novel-list');
  const note = document.getElementById('admin-novel-scope-note');
  el.innerHTML = '<div class="spinner"></div>';
  adminCat = ''; adminChars = [];   // fresh load → start unfiltered
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
        head += `<div style="display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(26,10,0,.08);flex-wrap:wrap">`
          + (isSuper ? `<button data-onclick="resetPassword('${sc.id}')" style="font-size:12px;padding:4px 12px;background:none;border:1px solid var(--gold);color:var(--ink-light);border-radius:3px;cursor:pointer">${ic('ic-key',12)} 重設密碼</button>` : '')
          + banBtns
          + (isSuper ? `<button data-onclick="deleteUser('${sc.id}')" style="font-size:12px;padding:4px 12px;background:var(--scarlet);border:none;color:var(--on-dark);border-radius:3px;cursor:pointer">${ic('ic-trash',12)} 刪除帳號</button>` : '')
          + `</div>`;
        if (tempActive) head += `<div style="font-size:12px;color:var(--accent);margin-top:8px">${ic('ic-clock',12)} 臨時封禁中，${new Date(sc.ban_until).toLocaleString('zh-TW')} 自動解除</div>`;
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

// Type (含羊皮紙) + 角色 filter for 作品管理. 羊皮紙 = forum kind; the 3 categories are novels.
function applyAdminFilter(list) {
  const sel = adminChars.filter(Boolean);
  // 自創角色 joins the SAME 任一/同框 evaluation as the official chars (not a separate AND gate).
  const ccActive = isBeta() && !!_ccFilter;
  const ccSet = ccActive ? (_ccTags[_ccFilter] || new Set()) : null;
  const noFilter = (sel.length === 0 && !ccActive) || (!charAnd && sel.length === CHAR_LIST.length && !ccActive);
  return list.filter(n => {
    if (adminCat === '羊皮紙') { if (n.kind !== 'forum') return false; }
    else if (adminCat) { if (n.kind === 'forum' || n.category !== adminCat) return false; }
    if (!noFilter) {
      const have = n.characters || [];
      const checks = sel.map(c => have.includes(c));
      if (ccActive) checks.push(ccSet.has(n.id));
      const ok = charAnd ? checks.every(Boolean) : checks.some(Boolean);
      if (!ok) return false;
    }
    return true;
  });
}
function renderAdminFilterBar(ns) {
  const wrap = document.getElementById('admin-novel-filters');
  if (!wrap) return;
  if (!ns.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = 'block';
  wrap.innerHTML = `<div class="filter-label">${ic('ic-sparkles', 12)} 故事類型</div><div class="cat-pills" id="admin-cat-pills"></div>`
    + `<div class="filter-label" style="margin-top:8px;display:flex;align-items:center;gap:10px"><span>${ic('ic-sparkles', 12)} 角色</span><span id="admin-char-and"></span></div><div class="char-chips" id="admin-char-chips"></div>`;
  const catEl = document.getElementById('admin-cat-pills');
  catEl.innerHTML = ADMIN_CATS.map(c => `<button class="cat-pill ${adminCat === c ? 'active' : ''}" data-c="${c}">${c}</button>`).join('');
  catEl.querySelectorAll('.cat-pill').forEach(b => b.onclick = () => { adminCat = (adminCat === b.dataset.c) ? '' : b.dataset.c; renderAdminNovels(); });   // 再點同一顆 = 取消 = 全部
  const chipEl = document.getElementById('admin-char-chips');
  chipEl.innerHTML = CHAR_LIST.map(ch =>
    `<div class="char-chip ${adminChars.includes(ch.code) ? 'active' : ''}" data-ch="${ch.code}"><img src="${ch.img}" alt="${ch.name}" /><span>${ch.name}</span></div>`).join('')
    // beta：官方角色之後接自創角色(單擊篩選・雙擊編輯)，與意若思鏡一致
    + (isBeta() ? _customChars.map(c => { const av = safeAvatarDataUrl(c.avatar); const sh = c.mine === false; return `<div class="char-chip char-custom${_ccFilter === c.id ? ' cc-on' : ''}${sh ? ' cc-shared' : ''}" data-onclick="ccTap('${c.id}', renderAdminNovels)" title="${sh ? '他人分享（唯讀，可篩選）' : '單擊篩選・雙擊編輯'}"><div class="cc-ava"${av ? ` style="background-image:url(&quot;${av}&quot;)"` : ''}>${av ? '' : ic('ic-wand', 20)}</div><span>${escapeHtml(c.name)}${sh ? ' ' + ic('ic-users', 10) : ''}</span></div>`; }).join('') : '');
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
        ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.15);color:var(--accent)">' + ic('ic-clock',11) + ' 待審核</span>' : '')
        + (isFutureIso(n.created_at) ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(45,74,30,.15);color:var(--series)">' + ic('ic-clock',11) + ' 排程·' + fmtUpdated(n.created_at) + '公開</span>' : '');
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
      return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(26,10,0,.08)">
        <div style="margin-bottom:3px;display:flex;gap:5px;flex-wrap:wrap">${n.kind === 'forum'
          ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.25);color:var(--ink-light)">' + ic('ic-scroll', 12) + ' 論壇體</span>'
          : '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.15);color:var(--accent)">' + ic('ic-book', 12) + ' 小說</span>'}${statusTag}${n.is_guide ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.25);color:var(--ink-light)">' + ic('ic-book', 12) + ' 範例·可刪除</span>' : ''}${n.locked ? '<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(138,45,45,.2);color:var(--accent)">' + ic('ic-key',11) + ' 已鎖 · 唯你可見</span>' : ''}</div>
        <div data-onclick="openNovel('${n.id}')" style="font-size:14px;font-weight:bold;cursor:pointer">${escapeHtml(n.title)} <span style="font-size:11px;font-weight:normal;color:var(--accent)">${ic('ic-eye',11)} 預覽</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:4px">
          ${n.series ? `<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(45,74,30,.15);color:var(--series)">${escapeHtml(n.series)}${n.series_order ? ' #' + n.series_order : ''}</span>` : ''}
          ${n.category ? `<span class="t-cat${n.category === '吐真劑' ? ' t-cat-green' : ''}">${escapeHtml(n.category)}</span>` : ''}
          ${(n.characters || []).map(c => `<span style="font-size:12px;padding:2px 8px;border-radius:10px;background:rgba(201,168,76,.18);color:var(--ink-light)">${escapeHtml(charNames([c]))}</span>`).join('')}
        </div>
        <div style="font-size:12px;color:var(--ink-light);margin-top:3px">${escapeHtml(n.author || '佚名')}${ownerTag(n)}</div>
        ${n.created_at ? `<div style="font-size:12px;color:var(--ink-light);margin-top:2px">${ic('ic-calendar',11)} 發佈日期 ${fmtUpdated(n.created_at)}</div>` : ''}
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">${editBtn}${manageBtns}${ownerAssignBtn}${lockBtn}${delBtn}</div>
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
  const series = document.getElementById('series-name-input').value.trim();
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
  renderCcPickerInto('editclass-cc', 'editclass-cc-group', ccTaggedSet(id));   // 自創角色標記(私人)
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
    // 更新自創角色標記(私人)。只在 picker 有顯示時(beta + 有自己的角色)才動，避免誤刪。
    if (document.getElementById('editclass-cc-group').style.display !== 'none') {
      const ccIds = [...document.querySelectorAll('#editclass-cc .cc-pick.on')].map(b => b.dataset.cc);
      try { await api('/custom-chars/tag', { method: 'POST', body: JSON.stringify({ novel_id: editClassNovelId, char_ids: ccIds }) }); await loadCustomChars(); } catch (e) {}
    }
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
  document.getElementById('editwork-title').value = n.title || '';
  document.getElementById('editwork-author').value = n.author || '';
  document.getElementById('editwork-date').value = (n.created_at || '').slice(0, 10);   // 發佈日期
  document.getElementById('editwork-content-label').textContent = isForum ? '主文（開場白）' : '內文';
  document.getElementById('editwork-comments-group').style.display = isForum ? '' : 'none';
  document.getElementById('editwork-comments').value = '';
  const ct = document.getElementById('editwork-content');
  ct.value = '載入中…'; ct.disabled = true;
  document.getElementById('editwork-modal').classList.add('open');
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
  } catch (e) { ct.value = ''; toast('內文載入失敗'); }
  ct.disabled = false;
}

async function saveEditWork() {
  const title = document.getElementById('editwork-title').value.trim();
  const author = document.getElementById('editwork-author').value.trim();
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

async function deleteNovel(id, isReject) {
  const msg = isReject ? '確定退回並刪除這篇待審內容？' : '確定刪除此作品及所有章節？此操作無法復原！';
  if (!confirm(msg)) return;
  try {
    await api(`/novels/${id}`, { method: 'DELETE' });
    toast(isReject ? '已退回' : '已刪除');
    if (isReject) loadReviewList(); else { loadAdminNovelList(); loadNovels(); }
  } catch (e) { toast(e.message); }
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
      const flagBadge = (u.flag_note && isSuper) ? '<span style="font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(201,168,76,.3);color:var(--ink);margin-left:6px">' + ic('ic-shield',10) + ' 疑似回鍋</span>' : '';
      const flagRow = (u.flag_note && isSuper) ? `<div style="margin-top:5px;font-size:12px;color:var(--accent);background:rgba(138,45,45,.10);padding:6px 8px;border-radius:6px;display:flex;align-items:center;gap:8px;justify-content:space-between"><span>${escapeHtml(u.flag_note)}</span><button data-onclick="clearUserFlag('${u.id}')" style="flex-shrink:0;font-size:11px;padding:3px 9px;background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;cursor:pointer;white-space:nowrap">已審</button></div>` : '';
      const seen = `<div style="font-size:11px;color:var(--ink-light);font-weight:normal;opacity:.8">${lastSeenLabel(u)}</div>`;
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
          <div class="u-name" data-onclick="${open}" style="cursor:pointer;line-height:1.3">${escapeHtml(display)}${banTag}${flagBadge}<span style="color:var(--gold);font-weight:bold;margin-left:6px">›</span><div style="font-size:12px;color:var(--ink-light);font-weight:normal">@${escapeHtml(u.username)}</div>${seen}</div>
          ${delBtn || picker}
        </div>
        ${flagRow}
      </div>`;
    }).join('') || `<p style="color:#888;padding:20px">${needle ? '找不到符合的用戶' : (userActivityFilter || userRoleFilter ? '沒有符合的用戶' : '尚無用戶')}</p>`;
}

// Admin taps a member's name → their detail (scoped 作品管理 + 迷情劑 toggle for readers).
function viewUserNovels(id) {
  const u = (window._adminUsers || []).find(x => x.id === id) || {};
  adminNovelScope = { id, name: u.nickname || u.username || '', role: u.role, mqj: u.mqj_access, banned: u.banned, ban_until: u.ban_until || null, auto: !!u.auto_publish, wish: !!u.wish_reply };
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
  const pw = prompt(`為「${name}」設定新的通關密語(至少 8 字)。\n設定後請私下告訴對方,讓他用這組登入:`);
  if (pw === null) return;
  if (pw.trim().length < 8) { toast('通關密語至少 8 字'); return; }
  try {
    await api(`/permissions/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password: pw.trim() }) });
    toast(`已重設 ${name} 的通關密語`);
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
  document.getElementById('settings-email').textContent = '';
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
    renderGreeting();
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
  if (!cur) { toast('請輸入目前的通關密語'); return; }
  if (nw.length < 8) { toast('新通關密語至少 8 字'); return; }
  if (nw !== nw2) { toast('兩次輸入的新通關密語不一致'); return; }
  try {
    await api('/auth/me/password', { method: 'PATCH', body: JSON.stringify({ current: cur, new: nw }) });
    toast('通關密語已更新');
    togglePwEdit(false);
  } catch (e) { toast('' + e.message); }
}

// ── Admin: invites ────────────────────────────────────────────
function inviteLink(token) { return `${window.location.origin}${window.location.pathname}?invite=${token}`; }
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

async function loadInviteList() {
  const el = document.getElementById('invite-list');
  el.innerHTML = '<div class="spinner"></div>';
  try {
    const list = await api('/invites/list') || [];
    if (!list.length) { el.innerHTML = '<p style="color:#888;font-size:13px">尚無邀請連結</p>'; return; }
    el.innerHTML = list.map(inv => {
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
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
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

  if (token) await initApp();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
