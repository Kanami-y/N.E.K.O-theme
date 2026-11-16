/* Reproduce the independent verifier's claims 1 and 4 on the REAL /chat page.
 * claim 1: with an EMPTY palette, merely loading our stylesheet changes rendered style.
 * claim 4: --nts-chat-opacity is a dead control (loader strips it).
 * Returns a JSON snapshot; everything is measured, nothing is asserted.
 */
(function () {
  var out = { url: location.href, body: document.body.className, checks: [], errors: [] };

  function link() {
    var ls = document.querySelectorAll('link[rel=stylesheet]');
    for (var i = 0; i < ls.length; i++) {
      if (String(ls[i].href).indexOf('neko-theme-studio.css') >= 0) return ls[i];
    }
    return null;
  }

  var ourLink = link();
  out.sheetFound = !!ourLink;
  out.sheetDisabled = ourLink ? ourLink.disabled : null;
  out.dynamicStyle = !!document.getElementById('nts-dynamic');
  out.gateAttrs = (function () {
    var a = [];
    var attrs = document.documentElement.attributes;
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].name.indexOf('data-nts') === 0) a.push(attrs[i].name);
    }
    return a;
  })();

  function measure(sel, prop, cssProp) {
    var el = document.querySelector(sel);
    if (!el) return { how: 'absent' };
    var v = getComputedStyle(el)[cssProp || prop];
    return { how: 'real', val: v };
  }

  var SPEC = [
    ['.chat-body', 'backgroundColor'],
    ['.composer-galgame-btn', 'color'],
    ['.send-button-circle', 'backgroundColor'],
    ['.proactive-recommendation-card', 'borderTopColor'],
    ['.window-topbar', 'backgroundColor'],
    ['#text-input-area', 'backgroundColor'],
    ['#react-chat-window-shell', 'borderTopLeftRadius'],
    ['.composer-tool-btn', 'backgroundColor'],
    ['.message-bubble-user', 'backgroundColor'],
    ['.system-chip', 'backgroundColor']
  ];

  function snap(tag) {
    var rows = [];
    SPEC.forEach(function (s) {
      var m = measure(s[0], s[1], s[2]);
      rows.push({ sel: s[0], prop: s[1], how: m.how, val: m.val || null });
    });
    return { tag: tag, rows: rows };
  }

  function withSheet(disabled, fn) {
    var prev = ourLink.disabled;
    ourLink.disabled = disabled;
    var r = fn();
    ourLink.disabled = prev;
    return r;
  }

  try {
    // ---- claim 1: sheet ON vs OFF, palette must be empty ----
    if (ourLink) {
      var ON = withSheet(false, function () { return snap('sheet-on'); });
      var OFF = withSheet(true, function () { return snap('sheet-off'); });
      var diffs = [];
      ON.rows.forEach(function (r, i) {
        var o = OFF.rows[i];
        if (r.how !== 'real' || o.how !== 'real') return;
        if (r.val !== o.val) diffs.push({ sel: r.sel, prop: r.prop, sheetOn: r.val, sheetOff: o.val });
      });
      out.claim1 = { paletteEmpty: !out.dynamicStyle, diffCount: diffs.length, diffs: diffs, on: ON, off: OFF };
      out.claim1.verdict = diffs.length === 0 ? 'PASS' : 'FAIL';
    }

    // ---- context: why could our fallback differ? show ancestor classes ----
    var cb = document.querySelector('.chat-body');
    if (cb) {
      var chain = [], n = cb;
      while (n && n !== document.documentElement) {
        chain.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\s+/).join('.') : ''));
        n = n.parentElement;
      }
      out.chatBodyChain = chain;
    }
    var f = document.querySelector('.compact-input-tool-fan');
    out.hasCompactToolFan = !!f;

    // ---- claim 4: is --nts-chat-opacity usable through the real loader? ----
    var NTS = window.NekoThemeStudio;
    out.loaderPresent = !!NTS;
    if (NTS && NTS._internals) {
      var it = NTS._internals;
      out.internalsKeys = Object.keys(it);
      var safe = null, safeErr = null;
      try {
        if (typeof it.isSafeValue === 'function') safe = it.isSafeValue('--nts-chat-opacity', '0.5');
      } catch (e) { safeErr = String(e); }
      out.claim4 = {
        isSafeValue_chat_opacity_05: safe,
        err: safeErr
      };
      // try to actually apply it and see if it lands
      try {
        if (typeof it.sanitizeVars === 'function') {
          var sv = it.sanitizeVars({ '--nts-chat-opacity': '0.5' });
          out.claim4.sanitizeVars_result = sv;
          out.claim4.keptCount = Object.keys(sv || {}).length;
        }
      } catch (e2) { out.claim4.sanitizeErr = String(e2); }
      if (NTS.apply) {
        try { NTS.apply({ vars: { '--nts-chat-opacity': '0.25', '--nts-user-bubble-bg': '#00c853' }, dark_vars: {}, enabled: true, version: 999 }); } catch (e3) { out.claim4.applyErr = String(e3); }
        var st = document.getElementById('nts-dynamic');
        out.claim4.afterApply = {
          dynamicPresent: !!st,
          text: st ? st.textContent : null,
          gateChatOpacity: document.documentElement.hasAttribute('data-nts-chat-opacity'),
          gateUserBubble: document.documentElement.hasAttribute('data-nts-user-bubble-bg'),
          factor: getComputedStyle(document.documentElement).getPropertyValue('--neko-chat-opacity-factor')
        };
        NTS.clear();
        out.claim4.afterClear = { dynamicPresent: !!document.getElementById('nts-dynamic') };
      }
    }
  } catch (e) {
    out.errors.push(String(e && e.stack || e));
  }
  return out;
})()
