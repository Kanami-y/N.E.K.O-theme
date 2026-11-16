// expr-verify-v3.js -- adversarial re-verification of the v3 gating design on the REAL /chat page.
//
//   node tools/page-eval.js --url http://127.0.0.1:48911/chat --js test/expr-verify-v3.js
//
// Independently checks, against the LIVE app (never a fixture):
//   A. empty palette    -> our sheet is a strict no-op                 [verifier CLAIM 1 + 3]
//   B. light-only       -> dark mode is bit-identical to no-sheet      [verifier CE-B]
//   C. dark-only        -> light mode is bit-identical to no-sheet     [verifier CE-A]
//   D. --nts-chat-opacity reaches the native multiplier                [verifier CLAIM 4]
//   E. reset_theme      -> bit-identical to no-sheet                   [verifier CLAIM 3]
//   F. hostile values   -> neutralised                                 [verifier CE-E, must stay PASS]
//
// Method: every claim is an A/B on the SAME page state, toggling only our stylesheet
// (`link.disabled`). If the palette is inert in a mode, toggling the sheet in that mode
// must produce ZERO property differences -- that is the definition being tested.
// Palettes are set through the plugin's own entry convention, so the app-side loader
// (which polls every 1.5s) is the one applying them: we never bypass the real path.
(function () {
  var STYLE_ID = 'nts-dynamic';
  var SHEET_SEL = 'link[href*="neko-theme-studio.css"]';
  var API = 'http://127.0.0.1:48916';
  var PLUGIN = 'neko_theme_studio';
  var CACHE_KEY = 'neko.themeStudio.palette';

  function styleEl() { return document.getElementById(STYLE_ID); }
  function injected() { var e = styleEl(); return e ? e.textContent : ''; }
  function sheet() { return document.querySelector(SHEET_SEL); }
  function setSheet(on) { var s = sheet(); if (s) s.disabled = !on; }
  function setDark(on) {
    var de = document.documentElement;
    if (on) { de.setAttribute('data-theme', 'dark'); de.classList.add('dark'); }
    else { de.removeAttribute('data-theme'); de.classList.remove('dark'); }
  }
  function gates() {
    var out = [], a = document.documentElement.attributes;
    for (var i = 0; i < a.length; i++) if (a[i].name.indexOf('data-nts-') === 0) out.push(a[i].name);
    return out.sort().join(',');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(pred, ms) {
    var t0 = Date.now();
    return (function loop() {
      if (pred()) return Promise.resolve(true);
      if (Date.now() - t0 > ms) return Promise.resolve(false);
      return sleep(60).then(loop);
    })();
  }

  // ---- measurement points ---------------------------------------------------
  var HOST_ID = 'nts-verify-host';
  function host() {
    var h = document.getElementById(HOST_ID);
    if (h) return h;
    h = document.createElement('div');
    h.id = HOST_ID;
    // off-screen, NOT display:none -- display:none zeroes every computed value
    h.setAttribute('style', 'position:absolute;left:-4000px;top:0;width:1200px');
    h.innerHTML =
      '<div class="message user"><div class="message-block"><div class="message-block-text">u</div>' +
        '<div class="message-block-markdown"><p>x <a href="#">l</a></p></div></div></div>' +
      '<div class="message-bubble-user">u</div>' +
      '<div class="message-bubble-assistant"><div class="message-block-text">a</div>' +
        '<div class="message-block-markdown"><p>a</p></div></div>' +
      '<div class="proactive-recommendation"><div class="proactive-recommendation-card">r</div></div>' +
      '<div class="system-chip">c</div>' +
      '<div class="composer-panel"><div class="composer-input-shell">' +
        '<input class="composer-input" placeholder="p"></div></div>' +
      '<div class="composer-tool-btn">t</div>' +
      '<div class="modal-overlay"><div class="modal-dialog"><div class="modal-title">m</div></div></div>' +
      '<div class="composer-galgame-btn">g</div>' +
      '<div class="window-topbar">tb</div>';
    document.body.appendChild(h);
    return h;
  }

  var SPEC = [
    { key: 'user-bubble-bg',   sel: '.message-bubble-user',            prop: 'backgroundColor' },
    { key: 'chat-body-bg',     sel: '.chat-body',                      prop: 'backgroundColor' },
    { key: 'input-bg',         sel: '#text-input-area',                prop: 'backgroundColor' },
    { key: 'shell-radius',     sel: '#react-chat-window-shell',        prop: 'borderTopLeftRadius' },
    { key: 'composer-border',  sel: '.composer-input-shell',           prop: 'borderTopColor' },
    { key: 'galgame-color',    sel: '.composer-galgame-btn',           prop: 'color' },
    { key: 'rec-card-border',  sel: '.proactive-recommendation-card',  prop: 'borderTopColor' },
    { key: 'rec-card-bg',      sel: '.proactive-recommendation-card',  prop: 'backgroundColor' },
    { key: 'topbar-backdrop',  sel: '.window-topbar',                  prop: 'backdropFilter' },
    { key: 'md-link-color',    sel: '.message-block-markdown a',       prop: 'color' },
    { key: 'block-text-color', sel: '.message-block-text',             prop: 'color' },
    { key: 'body-font',        sel: 'body',                            prop: 'fontFamily' },
    { key: 'toolbtn-bg',       sel: '.composer-tool-btn',              prop: 'backgroundColor' },
    { key: 'chip-bg',          sel: '.system-chip',                    prop: 'backgroundColor' },
    { key: 'modal-title-color',sel: '.modal-title',                    prop: 'color' },
    { key: 'root-chat-opacity',sel: 'html',                            prop: '--neko-chat-opacity-factor' }
  ];

  function read(spec) {
    var el = document.querySelector(spec.sel), how = 'real';
    if (!el) { el = host().querySelector(spec.sel); how = 'stand-in'; }
    if (!el) return { v: null, how: 'MISSING' };
    var cs = getComputedStyle(el);
    return { v: String(cs[spec.prop]), how: how };
  }
  function snap() { var o = {}; for (var i = 0; i < SPEC.length; i++) o[SPEC[i].key] = read(SPEC[i]); return o; }
  function diff(a, b) {
    var d = [];
    for (var i = 0; i < SPEC.length; i++) {
      var k = SPEC[i].key;
      if (String(a[k].v) !== String(b[k].v)) {
        d.push({ key: k, sel: SPEC[i].sel, prop: SPEC[i].prop, sheetOn: a[k].v, sheetOff: b[k].v });
      }
    }
    return d;
  }

  // ---- plugin entry driver (the documented panel convention) ---------------
  var csrf = null;
  function getCsrf() {
    if (csrf) return Promise.resolve(csrf);
    return fetch(API + '/security/csrf-token', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) { csrf = j.csrf_token; return csrf; });
  }
  function callEntry(entry, args) {
    return getCsrf().then(function (tok) {
      return fetch(API + '/runs', {
        method: 'POST', credentials: 'omit',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok },
        body: JSON.stringify({ plugin_id: PLUGIN, entry_id: entry, args: args || {} })
      }).then(function (r) { return r.json(); });
    }).then(function (j) {
      var id = j.run_id || j.id;
      if (!id) throw new Error('no run_id: ' + JSON.stringify(j).slice(0, 300));
      return new Promise(function (res, rej) {
        var n = 0;
        (function poll() {
          if (++n > 80) return rej(new Error('run timeout'));
          fetch(API + '/runs/' + id, { credentials: 'omit' }).then(function (r) { return r.json(); })
            .then(function (st) {
              if (st.status === 'succeeded') {
                fetch(API + '/runs/' + id + '/export', { credentials: 'omit' })
                  .then(function (r) { return r.json(); })
                  .then(function (ex) {
                    var items = (ex && ex.items) || [], it = null;
                    for (var i = 0; i < items.length; i++) if (items[i].type === 'json' && items[i].json) { it = items[i]; break; }
                    if (!it) it = items[0];
                    var raw = it && (it.json !== undefined ? it.json : it);
                    while (raw && typeof raw === 'object' && raw.data &&
                           (('success' in raw) || ('error' in raw))) raw = raw.data;
                    if (raw && raw.error) return rej(new Error(JSON.stringify(raw.error)));
                    res(raw);
                  }).catch(rej);
              } else if (st.status === 'failed' || st.status === 'canceled' || st.status === 'timeout') {
                rej(new Error('run ' + st.status + ': ' + JSON.stringify(st.error || {})));
              } else setTimeout(poll, 400);
            }).catch(rej);
        })();
      });
    });
  }

  // The loader polls the server every 1.5s and would re-apply a palette mid-measurement.
  // We never call apply() ourselves: the loader IS the writer, so we just wait for it to
  // settle, which also means we are testing the real path.
  function loaderSettledTo(expectSubstr, mode) {
    return waitFor(function () {
      var txt = injected();
      if (mode === 'empty') return !txt && !gates();
      return txt.indexOf(expectSubstr) !== -1;
    }, 8000);
  }

  var out = { api: {}, verdict: {} };

  return Promise.resolve()
    .then(function () { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} })
    .then(function () { return callEntry('reset_theme', {}); })
    .then(function () { return loaderSettledTo(null, 'empty'); })
    .then(function (ok) {
      out.api.resetSettled = ok;
      out.api.emptyGates = gates();
      out.api.emptyStylePresent = !!styleEl();

      // ============ A. empty palette: toggling the sheet must change NOTHING ============
      setDark(false); setSheet(false); var offL = null, onL = null;
      return sleep(250).then(function () {
        offL = snap(); setSheet(true); return sleep(250);
      }).then(function () {
        onL = snap();
        out.api.emptyLightDiffs = diff(onL, offL);
        setDark(true); setSheet(false); return sleep(250);
      }).then(function () {
        var offD = snap(); setSheet(true); return sleep(250).then(function () {
          var onD = snap();
          out.api.emptyDarkDiffs = diff(onD, offD);
          setSheet(true);
        });
      });
    })
    .then(function () {
      // ============ B. light-only palette: dark mode must stay native ============
      return callEntry('apply_theme', { vars: {
        '--nts-user-bubble-bg': '#ff8800',
        '--nts-chat-blur': 'blur(12px)',
        '--nts-chat-opacity': '0.25',
        '--nts-panel-text': '#00ff00',
        '--nts-link': '#00ffff'
      }, dark_vars: {} });
    })
    .then(function (res) {
      out.api.lightOnlySet = res;
      return loaderSettledTo('--nts-user-bubble-bg', 'x');
    })
    .then(function (ok) {
      out.api.lightOnlySettled = ok;
      out.api.lightOnlyGates = gates();
      out.api.lightOnlyInjected = injected();
      // dark mode A/B: with a light-only palette, the sheet must still be inert in dark
      var offD = null, onD = null, offL2 = null, onL2 = null;
      setDark(true); setSheet(false);
      return sleep(300).then(function () {
        offD = snap(); setSheet(true); return sleep(300);
      }).then(function () {
        onD = snap();
        out.api.lightOnlyDarkDiffs = diff(onD, offD);
        // and in light mode it MUST have an effect (otherwise the control is dead)
        setDark(false); setSheet(false); return sleep(300);
      }).then(function () {
        offL2 = snap(); setSheet(true); return sleep(300);
      }).then(function () {
        onL2 = snap();
        out.api.lightOnlyLightDiffs = diff(onL2, offL2);
        out.api.lightOnlyLightValues = {
          userBubble: onL2['user-bubble-bg'].v,
          topbarBackdrop: onL2['topbar-backdrop'].v,
          chatOpacityFactor: onL2['root-chat-opacity'].v,
          bodyFont: onL2['body-font'].v
        };
        out.api.lightOnlyDarkValues = {
          userBubble: onD['user-bubble-bg'].v,
          topbarBackdrop: onD['topbar-backdrop'].v,
          chatOpacityFactor: onD['root-chat-opacity'].v,
          bodyFont: onD['body-font'].v
        };
      });
    })
    .then(function () { return callEntry('reset_theme', {}); })
    .then(function () { return loaderSettledTo(null, 'empty'); })
    .then(function () {
      // ============ C. dark-only palette: light mode must stay native ============
      return callEntry('apply_theme', { vars: {}, dark_vars: {
        '--nts-user-bubble-bg': '#00c8ff',
        '--nts-chat-blur': 'blur(19px)',
        '--nts-chat-opacity': '0.6'
      } });
    })
    .then(function (res) {
      out.api.darkOnlySet = res;
      return loaderSettledTo('--nts-user-bubble-bg', 'x');
    })
    .then(function (ok) {
      out.api.darkOnlySettled = ok;
      out.api.darkOnlyGates = gates();
      out.api.darkOnlyInjected = injected();
      // light mode A/B: with a dark-only palette, the sheet must be inert in light
      var offL = null, onL = null, offD2 = null, onD2 = null;
      setDark(false); setSheet(false);
      return sleep(300).then(function () {
        offL = snap(); setSheet(true); return sleep(300);
      }).then(function () {
        onL = snap();
        out.api.darkOnlyLightDiffs = diff(onL, offL);
        setDark(true); setSheet(false); return sleep(300);
      }).then(function () {
        offD2 = snap(); setSheet(true); return sleep(300);
      }).then(function () {
        onD2 = snap();
        out.api.darkOnlyDarkDiffs = diff(onD2, offD2);
        out.api.darkOnlyLightValues = {
          userBubble: onL['user-bubble-bg'].v,
          topbarBackdrop: onL['topbar-backdrop'].v,
          chatOpacityFactor: onL['root-chat-opacity'].v,
          bodyFont: onL['body-font'].v
        };
        out.api.darkOnlyDarkValues = {
          userBubble: onD2['user-bubble-bg'].v,
          topbarBackdrop: onD2['topbar-backdrop'].v,
          chatOpacityFactor: onD2['root-chat-opacity'].v
        };
      });
    })
    .then(function () { return callEntry('reset_theme', {}); })
    .then(function () { return loaderSettledTo(null, 'empty'); })
    .then(function () {
      // ============ E. reset -> bit-identical to no-sheet, both modes ============
      out.api.afterResetGates = gates();
      out.api.afterResetStylePresent = !!styleEl();
      setDark(false); setSheet(true); var aL = null;
      return sleep(300).then(function () {
        aL = snap(); setSheet(false); return sleep(300);
      }).then(function () {
        var nL = snap();
        out.api.resetVsNativeLight = diff(aL, nL);
        setDark(true); setSheet(true); return sleep(300);
      }).then(function () {
        var aD = snap(); setSheet(false); return sleep(300).then(function () {
          var nD = snap();
          out.api.resetVsNativeDark = diff(aD, nD);
          setSheet(true);
        });
      });
    })
    .then(function () {
      // ============ D. --nts-chat-opacity must reach the native multiplier ============
      return callEntry('apply_theme', { vars: { '--nts-chat-opacity': '0.33' }, dark_vars: {} });
    })
    .then(function (res) {
      out.api.opacitySet = res;
      return loaderSettledTo('--nts-chat-opacity', 'x');
    })
    .then(function (ok) {
      out.api.opacitySettled = ok;
      out.api.opacityGates = gates();
      out.api.opacityInjected = injected();
      setDark(false);
      return sleep(300).then(function () {
        var cs = getComputedStyle(document.documentElement);
        out.api.opacityFactor = cs.getPropertyValue('--neko-chat-opacity-factor').trim();
        var s = styleEl();
        out.api.opacityDeclared = s ? s.textContent.indexOf('--nts-chat-opacity') : -1;
      });
    })
    .then(function () { return callEntry('reset_theme', {}); })
    .then(function () { return loaderSettledTo(null, 'empty'); })
    .then(function () {
      // ============ F. hostile values must be neutralised, SYNCHRONOUSLY ============
      // (read in the same tick so the 1.5s loader poll cannot overwrite the phase)
      var api = window.NekoThemeStudio;
      if (!api || typeof api.apply !== 'function') { out.api.hostile = 'NO API'; return; }
      setDark(false);
      api.apply({
        schema: 1, enabled: true, name: 'hostile', vars: {
          '--nts-user-bubble-bg': '#ff0000; position:fixed; top:0',
          '--nts-ai-bubble-bg': '0 0 0 9999px red) } body { display:none } .x{',
          '--nts-panel-text': 'Arial; } * { color: red',
          '--nts-link': 'url(javascript:alert(1))',
          '--nts-chat-opacity': '99; } html{display:none}'
        }, dark_vars: {}
      });
      out.api.hostileInjectedSync = injected();
      out.api.hostileGatesSync = gates();
      out.api.hostileStylePresentSync = !!styleEl();
      // also probe the internals directly
      if (api._internals) {
        out.api.hostileSanitized = JSON.stringify(api._internals.sanitizeVars({
          '--nts-user-bubble-bg': '#ff0000; position:fixed; top:0',
          '--nts-panel-text': 'Arial; } * { color: red',
          '--nts-link': 'url(javascript:alert(1))'
        }));
        out.api.opacitySanitized = JSON.stringify(api._internals.sanitizeVars({ '--nts-chat-opacity': '0.33' }));
        out.api.opacityRejected99 = JSON.stringify(api._internals.sanitizeVars({ '--nts-chat-opacity': '99; x' }));
      }
    })
    .then(function () {
      if (window.NekoThemeStudio) window.NekoThemeStudio.clear();
      setSheet(true);
      out.verdict = {
        A_emptyLightIsNoOp: (out.api.emptyLightDiffs || []).length === 0,
        A_emptyDarkIsNoOp: (out.api.emptyDarkDiffs || []).length === 0,
        B_lightOnlyLeavesDarkNative: (out.api.lightOnlyDarkDiffs || []).length === 0,
        B_lightOnlyDoesAffectLight: (out.api.lightOnlyLightDiffs || []).length > 0,
        C_darkOnlyLeavesLightNative: (out.api.darkOnlyLightDiffs || []).length === 0,
        C_darkOnlyDoesAffectDark: (out.api.darkOnlyDarkDiffs || []).length > 0,
        D_chatOpacityFactorIs033: out.api.opacityFactor === '0.33',
        E_resetLightEqualsNative: (out.api.resetVsNativeLight || []).length === 0,
        E_resetDarkEqualsNative: (out.api.resetVsNativeDark || []).length === 0,
        F_hostileBlocked: !out.api.hostileStylePresentSync &&
                          String(out.api.hostileGatesSync || '').indexOf('data-nts') === -1
      };
      return out;
    });
})();
