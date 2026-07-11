// CSP-safe replacement for inline event handlers.
//
// Markup uses data-onclick/data-onchange/... instead of executable `on*` attributes. This
// delegated dispatcher understands only a tiny, explicit grammar and an allowlist of existing
// UI functions. It never uses eval/Function, so injected markup cannot turn an attribute into
// arbitrary JavaScript even though the app still supports dynamically rendered controls.
(function () {
  'use strict';

  const ALLOWED_ACTIONS = new Set([
    'addFaq', 'applyAppFontSize', 'approveNovel', 'avatarDragStart', 'avatarZoom', 'banUser',
    'ccPickAvatar', 'ccTap', 'changeUserRole', 'clearUserFlag', 'closeCharProfile', 'closeReader', 'copyAllInvites',
    'copyText', 'deleteCustomChar', 'deleteFaq', 'deleteFeedbackItem', 'deleteNovel', 'deleteUser',
    'cpCoverHint', 'discardUploadDraft', 'dismissInstallHint', 'dismissNotice', 'dismissRecap', 'dismissContinueBar', 'dismissEditorLetter', 'dismissTourBanner', 'doInviteRegister', 'doLogout', 'downloadPhoto',
    'doSignIn', 'editFaq', 'editNick', 'endTour', 'exportBackup', 'favOwlOpen', 'forceRefresh', 'generateInvite',
    'handleAvatarUpload', 'installPwaNow', 'loadChapter', 'loadForumPosts', 'loadNovels', 'letterUpdateOnce', 'loadTxtIntoUpload',
    'navigateChapter', 'navigateSeries', 'openBugReport', 'openCharProfileFromHome', 'openCreateChar', 'openEditorLetter',
    'openEditClass', 'openEditWork', 'openFaq', 'openMqjDisclaimer', 'openNovel', 'openOwners',
    'openSeries', 'owlOpenIdx', 'openWishPool', 'renderAdminNovels', 'renderForumList', 'renderShelf', 'renderUserRows',
    'replyFeedback', 'requestMqj', 'resetAdminNovelScope',
    'resetPassword', 'resumeReading', 'reviewMqj', 'revokeInvite', 'saveAvatarCrop',
    'saveCustomChar', 'saveEditClass', 'saveEditWork', 'saveFaqEditor', 'saveMyPassword',
    'saveNickname', 'saveNoticeDays', 'saveOwners', 'saveSeries', 'setAutoPublish', 'setBetaFlag',
    'setFeedbackStatus', 'setMqjAccess', 'setUploadKind', 'setUserFilter', 'setUserRole', 'setUiScript', 'setWishReply', 'wishReplyOpen',
    'setWishFilter', 'showLoginForm', 'showPage', 'startTour', 'stepReaderFont', 'submitFeedback',
    'onImagePick', 'submitImageWork', 'pickFrame', 'pickImageFile', 'setForumMode', 'toggleForumMode',
    'openGalleryItem', 'closeGalleryDetail', 'openGalleryFull', 'closeGalleryFull', 'setImageSlot', 'downloadGalleryImage',
    'submitForumPost', 'submitNewNovel', 'switchAdminTab', 'tempBan', 'toggleCcShare', 'toggleCharAnd', 'toggleCoverPhoto',
    'toggleDark', 'toggleFavOwl', 'toggleFont', 'toggleForumFav', 'toggleGalleryFavorite', 'toggleLike', 'toggleLock', 'toggleOwlAlways', 'togglePwEdit', 'toggleTapFx',
    'toggleReaderDark', 'toggleReaderFavorite', 'toggleShelfFav', 'tourBack', 'tourNext',
    'updateBugCount', 'updateReaderDarkBtn', 'updateToLatest', 'updateWishCount', 'viewUserNovels',
  ]);

  const EVENT_ATTRIBUTES = {
    click: 'data-onclick',
    change: 'data-onchange',
    input: 'data-oninput',
    pointerdown: 'data-onpointerdown',
    touchstart: 'data-ontouchstart',
  };

  function splitOutsideQuotes(value, separator) {
    const out = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    let depth = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === separator && depth === 0) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(value.slice(start).trim());
    return out.filter(Boolean);
  }

  function parseArgument(token, event, element) {
    if ((token.startsWith("'") && token.endsWith("'")) ||
        (token.startsWith('"') && token.endsWith('"'))) {
      return token.slice(1, -1).replace(/\\([\\'\"])/g, '$1');
    }
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token === 'event') return event;
    if (token === 'this') return element;
    if (token === 'this.value') return element.value;
    if (token === 'this.checked') return element.checked;
    if (/^[A-Za-z_$][\w$]*$/.test(token) && ALLOWED_ACTIONS.has(token)) return window[token];
    throw new Error(`Unsupported declarative event argument: ${token}`);
  }

  function runStatement(statement, event, element) {
    if (statement === 'return false') {
      event.preventDefault();
      return;
    }
    if (statement === 'event.preventDefault()') { event.preventDefault(); return; }
    if (statement === 'event.stopPropagation()') { event.stopPropagation(); return; }
    if (statement === "this.classList.toggle('on')") { element.classList.toggle('on'); return; }

    let match = statement.match(/^document\.getElementById\('([A-Za-z0-9_-]+)'\)\.click\(\)$/);
    if (match) { document.getElementById(match[1])?.click(); return; }

    match = statement.match(/^document\.getElementById\('([A-Za-z0-9_-]+)'\)\.classList\.remove\('open'\)$/);
    if (match) { document.getElementById(match[1])?.classList.remove('open'); return; }

    match = statement.match(/^document\.getElementById\('([A-Za-z0-9_-]+)'\)\.disabled=!this\.checked$/);
    if (match) { document.getElementById(match[1]).disabled = !element.checked; return; }

    if (statement === "document.querySelector('#reader-view details').removeAttribute('open')") {
      document.querySelector('#reader-view details')?.removeAttribute('open');
      return;
    }

    match = statement.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/s);
    if (!match || !ALLOWED_ACTIONS.has(match[1])) {
      throw new Error(`Blocked declarative event statement: ${statement}`);
    }
    const fn = window[match[1]];
    if (typeof fn !== 'function') throw new Error(`Missing UI action: ${match[1]}`);
    const rawArgs = match[2].trim();
    const args = rawArgs ? splitOutsideQuotes(rawArgs, ',').map((arg) => parseArgument(arg, event, element)) : [];
    const result = fn.apply(window, args);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => console.error('UI action failed', error));
    }
  }

  function dispatch(event) {
    const attr = EVENT_ATTRIBUTES[event.type];
    if (!attr || !(event.target instanceof Element)) return;
    const element = event.target.closest(`[${attr}]`);
    if (!element) return;
    const code = element.getAttribute(attr) || '';
    try {
      splitOutsideQuotes(code, ';').forEach((statement) => runStatement(statement, event, element));
    } catch (error) {
      console.error('Blocked unsafe UI event', error);
    }
  }

  Object.keys(EVENT_ATTRIBUTES).forEach((type) => {
    // Chrome treats document-level touch listeners as passive unless told otherwise; the avatar
    // cropper intentionally prevents the initial touch from scrolling the page.
    document.addEventListener(type, dispatch, type === 'touchstart' ? { passive: false } : false);
  });
})();
