/*!
 * gen-css.js -- theme-studio/tools/gen-css.js -- do not edit the OUTPUT by hand.
 * ---------------------------------------------------------------------------
 * Reads:  build/native-light.json, build/native-dark.json   (measurement, INFORMATIONAL ONLY)
 *         test/targets.js                                   (the single source of truth)
 *         test/ab-baseline.json + build/ab.json             (real-page A/B history, informational)
 * Writes: <out.css>, <out.vars.json>
 *
 * ---------------------------------------------------------------------------
 * DESIGN (v3) -- the "unconfigured == not loaded" invariant is CONSTRUCTIVE
 * ---------------------------------------------------------------------------
 * v1/v2 tried to bake a measured native value into each declaration:
 *
 *     :root:root body SEL { prop: var(--nts-x, <measured native>) !important; }
 *
 * and claimed that with no variable set the rule resolves to the native value.
 * That claim was FALSE, and an independent verifier proved it on the real page:
 *
 *   - .chat-body        ours rgba(255,255,255,.91)  native rgba(0,0,0,0)
 *   - .composer-galgame-btn ours rgba(36,151,217,.45) native rgb(36,151,217)
 *   - .send-button-circle   ours rgba(0,0,0,0)      native rgba(160,220,255,.26)
 *   - .proactive-recommendation-card ours rgba(108,151,174,.18) native rgb(34,34,34)
 *
 * Root cause: getComputedStyle returns the RESOLVED value of the widget as it
 * exists in the MEASURING page. The measuring fixture cannot reproduce the real
 * page's cascade:
 *   * .chat-body in the real app sits under .chat-surface-mode-compact, where a
 *     LATER, equally-specific `.chat-window.chat-surface-mode-compact .chat-body
 *     { background: transparent }` wins -- the fixture had no such ancestor and
 *     recorded the earlier, losing rule.
 *   * .composer-galgame-btn in the real app sits under .compact-input-tool-fan,
 *     where a HIGHER-specificity rule wins.
 *   * The app's <body> carries .electron-chat-window, disabling a whole
 *     `body:not(.electron-chat-window) ...` rule; the fixture's body does not.
 *   * The app injects a runtime <style> layer with !important that the fixture
 *     cannot see at all.
 * So "the measured native value" is not a property of the target; it is a
 * property of the measuring page. Baking it in silently restyles an
 * unconfigured app. Every fallback we can measure can be wrong.
 *
 * v3 therefore emits NO fallbacks at all. Every declaration is gated on a
 * per-mode, per-variable attribute that the app-side loader sets only when the
 * user has actually configured that variable in that mode:
 *
 *   :root:not([data-theme="dark"])[data-nts-l-x]:root:root body SEL { prop: var(--nts-x) !important; }
 *   :root[data-theme="dark"][data-nts-d-x]:root:root body SEL       { prop: var(--nts-x) !important; }
 *
 * Consequences, all by construction rather than by measurement:
 *   1. No attribute set (empty palette) => the ruleset matches nothing => zero
 *      effect. The invariant is provable by reading the selector, and cannot
 *      regress when app CSS changes.
 *   2. Light-only palette: only data-nts-l-* are set, so the dark rules (which
 *      additionally require [data-theme="dark"] AND data-nts-d-*) never match.
 *      A light-only palette cannot damage dark mode. (Verifier counterexample
 *      CE-A: value defined only for dark left `backdrop-filter: var(--x)` with no
 *      value in light, which is invalid-at-computed-value-time and collapsed the
 *      native blur to `none`. Per-mode gates make that unreachable.)
 *   3. Dark-only palette: light rules require data-nts-l-*, which are not set,
 *      so light is untouched. (Verifier counterexample CE-B: the loader wrote
 *      light values into an unscoped `:root{...}`, leaking a light colour into
 *      dark mode. Light values are now scoped to :root:not([data-theme="dark"]).)
 *   4. The measured values are still written to <out.vars.json> as *reference
 *      text for the panel* (native / darkNative), and still checked by the
 *      fixture harness for coverage. They are never emitted as CSS.
 *
 * Per-mode semantics were chosen by the user: the "light" group affects light
 * mode only, the "dark" group affects dark mode only.
 */

var fs = require('fs');
var path = require('path');

var targetsMod = require(path.join(__dirname, '..', 'test', 'targets.js'));
var NTS_TARGETS = targetsMod.NTS_TARGETS;
var NTS_GATED = targetsMod.NTS_GATED;
var NTS_VEIL = targetsMod.NTS_VEIL;
var NTS_GLOW = targetsMod.NTS_GLOW;

var GATE_ATTR = 'data-nts-';
var ACTIVE_ATTR = 'data-nts-active';

/* Mode tag inside the gate attribute name. Must match the loader's gateAttrFor(). */
function gateAttrFor(varName, mode) {
  var suffix = String(varName).replace(/^--nts-/, '');
  return GATE_ATTR + (mode === 'dark' ? 'd-' : 'l-') + suffix;
}

/* Specificity is deliberately overkill: the native dark sheet uses
 * `[data-theme="dark"] SEL` (0,3,0) and some rules carry !important, and the
 * app's runtime <style> layer also uses !important. Native also uses plain
 * `SEL` and `#id SEL` forms. Repeating :root is legal (it matches the same
 * <html> element) and is the standard way to outrank them:
 *   light prefix = (0,4,1) + SEL      vs  native max (0,3,0) + SEL
 *   dark  prefix = (0,6,1) + SEL
 * Both sides carry !important, so specificity decides. */
function gatePrefix(varName, mode, hard) {
  var attr = gateAttrFor(varName, mode);
  /* hard：给「渐变 / 液态玻璃」这类必须压过白纱（NTS_VEIL，本表同层且后写）
   * 的规则再加两枚 :root。veil 的亮色选择器最高到 (0,5,1)，普通门控是
   * (0,4,1) 且写在前面，会输；hard 把它抬到亮 (0,6,1) / 暗 (0,8,1)。 */
  var extra = hard ? ':root:root' : '';
  return mode === 'dark'
    ? ':root[data-theme="dark"][' + attr + ']:root:root' + extra + ' body '
    : ':root:not([data-theme="dark"])[' + attr + ']:root:root' + extra + ' body ';
}

/* 顶层的逗号切分：括号/方括号/引号里的逗号不算（:is(a, b)、[title="x,y"]）。 */
function splitSelectorList(sel) {
  var out = [];
  var buf = '';
  var depth = 0;
  var quote = '';
  for (var i = 0; i < sel.length; i += 1) {
    var ch = sel.charAt(i);
    if (quote) { buf += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/* 把门控前缀贴到**每一个**选择器上。
 *
 * 旧实现是 prefix + sel：传进来的 "a h1, a h2, …, a h6" 只有第一个选择器吃到门控，
 * h2..h6 变成衣不蔽体的 `color: var(--nts-ai-bubble-text) !important` —— 未设变量时
 * var() 无效 → IACVT → unset → inherit，把宿主 h2..h6 的原生颜色整个压平（实测
 * 18 条规则 / 90 个裸选择器）。而这份 CSS 由 <link> 常驻，空主题也生效，等于
 * 破坏了 v3「未配置 = 不生效」的唯一不变量。
 *
 * 多选择器用 :is(...) 包住：门控前缀只写一次（省字节），:is 的特异性取最具体的那个
 * 参数 —— 这些列表里的参数特异性相同，所以与逐条贴前缀等价。 */
function joinSel(prefix, sel) {
  if (!sel) return prefix.replace(/\s+$/, '');
  var parts = splitSelectorList(sel);
  if (parts.length > 1) {
    /* 伪元素不能被 :is() 包（:is(::after) 是无效选择器）→ 退回逐条贴前缀。 */
    var hasPseudo = parts.some(function (p) { return p.indexOf('::') >= 0; });
    if (hasPseudo) return parts.map(function (p) { return joinSel(prefix, p); }).join(',');
    return prefix + ':is(' + parts.join(', ') + ')';
  }
  if (sel.indexOf('::') === 0) return prefix.replace(/\s+$/, '') + ' ' + sel;
  return prefix + sel;
}

/* Every property we are allowed to write, and how to write it. No fallbacks:
 * the whole point of v3 is that a gated rule only ever fires with a value the
 * user actually supplied. */
var GATE_DECL = {
  'background-color': function (v) { return ['background-color: var(' + v + ') !important;']; },
  /* 自定义渐变（v0.1.11）：值本身就是整条 `linear-gradient(...)`，
   * 所以直接桥到 background-image。面板只生成合法语法，校验在三端各有实现。 */
  'background-image': function (v) { return ['background-image: var(' + v + ') !important;']; },
  'color': function (v) { return ['color: var(' + v + ') !important;']; },
  'border-color': function (v) { return ['border-color: var(' + v + ') !important;']; },
  'border-top-color': function (v) { return ['border-top-color: var(' + v + ') !important;']; },
  'border-right-color': function (v) { return ['border-right-color: var(' + v + ') !important;']; },
  'border-bottom-color': function (v) { return ['border-bottom-color: var(' + v + ') !important;']; },
  'border-left-color': function (v) { return ['border-left-color: var(' + v + ') !important;']; },
  /* outline-color alone is inert (an outline also needs width+style), so the
   * whole shorthand is written from the one colour variable. */
  'outline-color': function (v) {
    return ['outline: 1.5px solid var(' + v + ') !important;',
            'outline-offset: -1.5px !important;'];
  },
  /* Native backdrop-filter is a specific blur+saturate chain, but that does not
   * matter any more: the rule only exists when the user set the variable. */
  'backdrop-filter': function (v) {
    return ['backdrop-filter: var(' + v + ') !important;',
            '-webkit-backdrop-filter: var(' + v + ') !important;'];
  },
  'box-shadow': function (v) { return ['box-shadow: var(' + v + ') !important;']; },
  'font-size': function (v) { return ['font-size: var(' + v + ') !important;']; },
  /* A user-set radius applies to all four corners; unset means native keeps its
   * own (frequently asymmetric) corners, because no rule matches. */
  'border-radius': function (v) {
    return ['border-top-left-radius: var(' + v + ') !important;',
            'border-top-right-radius: var(' + v + ') !important;',
            'border-bottom-right-radius: var(' + v + ') !important;',
            'border-bottom-left-radius: var(' + v + ') !important;'];
  }
};

/* 单个 target 的声明展开：自定义属性直接 var() 桥接，普通属性查 GATE_DECL。 */
function declLines(prop, v) {
  if (prop.indexOf('--') === 0) return [prop + ': var(' + v + ') !important;'];
  return GATE_DECL[prop](v);
}

function main() {
  var a = process.argv.slice(2);
  if (a.length < 4) {
    console.error('usage: node gen-css.js <light.json> <dark.json> <out.css> <out.vars.json> [ab.json]');
    process.exit(2);
  }
  var light = JSON.parse(fs.readFileSync(a[0], 'utf8'));
  var dark = JSON.parse(fs.readFileSync(a[1], 'utf8'));
  var outCss = a[2], outVars = a[3];

  var warn = [];
  var all = [];   /* emitted targets */
  var aux = [];   /* measurement-only */

  NTS_TARGETS.forEach(function (t) {
    if (t.aux) { aux.push(t); return; }
    if (!t.v) { warn.push('[SKIP no var] ' + t.sel + ' | ' + t.prop); return; }
    /* 自定义属性（--foo）走「桥接」：值永远是 var(--nts-x)。这是紧凑胶囊
     * （--compact-chat-surface-bg 等）能像普通属性一样被变量控制的关键。 */
    if (t.prop.indexOf('--') !== 0 && !GATE_DECL[t.prop]) { warn.push('[SKIP no template] ' + t.sel + ' | ' + t.prop); return; }
    all.push({ sec: t.sec, sel: t.sel, prop: t.prop, v: t.v, kind: t.kind, gate: true, hard: !!t.hard });
  });

  /* ---------- gradients that would paint over a colour we control ----------
   * If the element's background-image is a gradient, setting only
   * background-color leaves the user's colour invisible. Emit a matching
   * `background-image: none` under the SAME variable's gate, so it appears and
   * disappears together with the colour. */
  var killImage = [];
  var seenKill = {};
  aux.forEach(function (t) {
    if (t.prop !== 'background-image') return;
    var lr = null, dr = null;
    light.rows.forEach(function (r) { if (r.sel === t.sel && r.prop === 'background-image') lr = r; });
    dark.rows.forEach(function (r) { if (r.sel === t.sel && r.prop === 'background-image') dr = r; });
    var grad = false;
    [lr, dr].forEach(function (r) { if (r && r.val && r.val !== 'none') grad = true; });
    if (!grad) return;
    all.forEach(function (e) {
      if (e.sel !== t.sel || e.prop !== 'background-color') return;
      var key = e.v + '|' + e.sel;
      if (seenKill[key]) return;
      seenKill[key] = 1;
      killImage.push({ v: e.v, sel: e.sel });
    });
  });

  /* ---------- emit ---------- */
  var out = [];

  /* ---------------------------------------------------------------------------
   * THE CASCADE LAYER — this is not cosmetic, it is the fix for the single
   * largest class of "I changed a colour and nothing happened" reports.
   *
   * For NORMAL declarations, unlayered beats layered. For !important
   * declarations the order REVERSES: a layered !important beats an unlayered
   * !important. (CSS Cascade 5, §6.4.4; verified on this exact app build with a
   * live feature test — `importantInLayerWins === "2px"`.)
   *
   * The app's own index.css ships rules like
   *     body.subtitle-web-host #react-chat-window-shell[data-chat-surface-mode="compact"]:not(.is-minimized) #react-chat-window-root { background-color: transparent !important }
   * which carry TWO id selectors -> specificity (2,4,1). Our gated prefix
   *     :root:not([data-theme="dark"])[data-nts-l-x]:root:root body SEL
   * carries ZERO ids -> (0,4,1)+SEL. Repeating :root can never close that gap
   * (it only adds class-level weight). Both sides are !important, so specificity
   * decides and we lose every time — measured on the real page:
   *     #react-chat-window-root   background-color  stayed rgba(0,0,0,0)
   *     .chat-window              background-color  stayed rgba(0,0,0,0)
   *     .composer-panel           background-color  stayed rgba(0,0,0,0)
   *     .composer-panel           box-shadow        stayed none
   * Wrapping the whole sheet in a layer flips the !important order and all four
   * win, while the "unconfigured == not loaded" invariant is untouched: with an
   * empty palette no gate attribute exists, so no rule inside the layer matches.
   * ------------------------------------------------------------------------- */
  out.push('@layer nts-theme {');
  out.push('');
  out.push('/*!');
  out.push(' * neko-theme-studio.css -- N.E.K.O theme studio, static style layer');
  out.push(' * ---------------------------------------------------------------------------');
  out.push(' * GENERATED by theme-studio/tools/gen-css.js -- do not edit by hand.');
  out.push(' *');
  out.push(' * EVERY rule is gated on `data-nts-l-<var>` (light mode) or');
  out.push(' * `data-nts-d-<var>` (dark mode), attributes the app-side loader sets only');
  out.push(' * for variables the user actually configured IN THAT MODE. There are no');
  out.push(' * baked-in fallbacks, because a fallback measured in a synthetic fixture is');
  out.push(' * not the real page\'s computed value (see the generator header for the four');
  out.push(' * independent counterexamples). Therefore:');
  out.push(' *   * empty palette      -> no attributes -> no rule matches -> zero effect');
  out.push(' *   * light-only palette -> dark rules additionally require [data-theme="dark"]');
  out.push(' *                           and data-nts-d-*, so dark mode is untouched');
  out.push(' *   * dark-only palette  -> light rules additionally require');
  out.push(' *                           data-nts-l-*, so light mode is untouched');
  out.push(' *');
  out.push(' * Safety: colours, backgrounds, borders, radii, fonts, shadow, blur only.');
  out.push(' * Never display/position/width/height/flex/overflow/z-index/transform.');
  out.push(' * Loaded AFTER dark-mode.css (install.ps1 template patch guarantees the order).');
  out.push(' *');
  out.push(' * WRAPPED IN @layer nts-theme: for !important declarations a LAYERED rule');
  out.push(' * beats an UNLAYERED one, which is the only way to outrank the app\'s own');
  out.push(' * two-id !important rules (e.g. `... #react-chat-window-root{background-color:');
  out.push(' * transparent!important}` in index.css). Specificity alone can never win.');
  out.push(' */');
  out.push('');

  var emitted = 0;

  /* Section order mirrors targets.js so the file reads like the panel. */
  var secs = [];
  all.forEach(function (e) { if (secs.indexOf(e.sec) < 0) secs.push(e.sec); });

  secs.forEach(function (sec) {
    var list = all.filter(function (e) { return e.sec === sec; });
    out.push('/* ===================== ' + sec + ' ===================== */');
    out.push('');
    ['light', 'dark'].forEach(function (mode) {
      /* group rules by (var, sel) so one gate block carries all declarations
       * the same variable makes on the same element */
      var order = [], groups = {};
      list.forEach(function (e) {
        var k = e.v + '\u0000' + e.sel + '\u0000' + (e.hard ? 'H' : '-');
        if (!groups[k]) { groups[k] = { v: e.v, sel: e.sel, hard: !!e.hard, props: [] }; order.push(k); }
        groups[k].props.push(e.prop);
      });
      if (!order.length) return;
      out.push('/* --- ' + sec + ' : ' + mode + ' (' + order.length + ' rule(s)) --- */');
      out.push('');
      order.forEach(function (k) {
        var g = groups[k];
        out.push(joinSel(gatePrefix(g.v, mode, g.hard), g.sel) + ' {');
        g.props.forEach(function (p) {
          declLines(p, g.v).forEach(function (line) { out.push('  ' + line); });
        });
        out.push('}');
        out.push('');
        emitted++;
      });
    });
  });

  /* ---------- gradient killers (same gate as the colour they protect) ------ */
  if (killImage.length) {
    out.push('/* ===================== background-image kill (gradient would hide the colour) ===================== */');
    out.push('');
    killImage.forEach(function (k) {
      ['light', 'dark'].forEach(function (mode) {
        out.push(joinSel(gatePrefix(k.v, mode), k.sel) + ' { background-image: none !important; }');
      });
      out.push('');
    });
  }

  /* ---------- scrollbars ---------------------------------------------------
   * Chromium 121+ ignores ::-webkit-scrollbar-* once scrollbar-color is set,
   * and native dark uses `[data-theme="dark"] * { scrollbar-color: ... !important }`
   * as a finisher, so we must write scrollbar-color itself. */
  out.push('/* ===================== scrollbars ===================== */');
  out.push('');
  ['light', 'dark'].forEach(function (mode) {
    var thumb = NTS_GATED.scrollbar.thumbVar;
    var track = NTS_GATED.scrollbar.trackVar;
    var pair = 'var(' + thumb + ') var(' + track + ')';
    /* `body` colours the body's OWN scrollbar; `*` lets every descendant
     * scroll container inherit. The previous version emitted
     * `body > body` (impossible — body has no body child, so it matched
     * nothing) and `body > *`, which only worked by inheritance. */
    ['body', '*'].forEach(function (tgt) {
      /* require BOTH variables in this mode, so the pair is always fully defined */
      var attr = gateAttrFor(thumb, mode);
      var attr2 = gateAttrFor(track, mode);
      var head = mode === 'dark'
        ? ':root[data-theme="dark"][' + attr + '][' + attr2 + ']:root'
        : ':root:not([data-theme="dark"])[' + attr + '][' + attr2 + ']:root';
      out.push(head + ':root ' + tgt + ' { scrollbar-color: ' + pair + ' !important; }');
    });
  });
  out.push('');

  /* ---------- chat surface opacity ----------------------------------------
   * Bridges the native multiplier: native CSS reads
   * `rgba(..., calc(.91 * var(--neko-chat-opacity-factor, 1)))`, so overriding
   * the factor scales every surface at once. Requires a number 0-1. */
  out.push('/* ===================== chat surface opacity (native factor bridge) ===================== */');
  out.push('');
  ['light', 'dark'].forEach(function (mode) {
    var v = NTS_GATED.chatOpacity.varName;
    var attr = gateAttrFor(v, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']'
      : ':root:not([data-theme="dark"])[' + attr + ']';
    out.push(head + ' { --neko-chat-opacity-factor: var(' + v + ') !important; }');
  });
  out.push('');

  /* ---------- plugin view layer bridge ------------------------------------
   * agent-plugin-views.css already consumes five --neko-popup-* variables, so we
   * take those over. Each is gated on ITS OWN variable and mode: mapping one
   * colour must not drag the other four (and their baked fallbacks) into the
   * other mode. */
  out.push('/* ===================== plugin view layer bridge ===================== */');
  out.push('');
  Object.keys(NTS_GATED.popupBridge.map).forEach(function (target) {
    var m = NTS_GATED.popupBridge.map[target];
    var v = m[0];
    /* 可选第三项是模板：{v} 会被替换成 var(--nts-*)。
     * 用于 --neko-popup-border 这种「1px solid <colour>」简写变量。 */
    var value = m.length > 2 ? String(m[2]).replace('{v}', 'var(' + v + ')') : 'var(' + v + ')';
    ['light', 'dark'].forEach(function (mode) {
      var attr = gateAttrFor(v, mode);
      var head = mode === 'dark'
        ? ':root[data-theme="dark"][' + attr + ']'
        : ':root:not([data-theme="dark"])[' + attr + ']';
      NTS_GATED.popupBridge.sel.forEach(function (sel) {
        /* !important is NOT optional here. dark-mode.css assigns these same
         * --neko-popup-* variables itself (e.g. `[data-theme="dark"] #agent-task-hud
         * { background: var(--neko-popup-bg) !important }` plus the variable
         * definitions on :root). Both sides set a custom property on the same
         * element, so specificity/order decides — the bridge lost without it. */
        out.push(head + ' body ' + sel + ' { ' + target + ': ' + value + ' !important; }');
      });
    });
  });
  out.push('');

  /* ---------- global font family ------------------------------------------
   * TWO bridges, because `body { font-family }` alone does NOT reach the chat
   * content. The React sheet forces the content font explicitly:
   *   .message-block-text,.message-block-markdown,.composer-input,
   *   .compact-chat-capsule-text{font-family:var(--neko-chat-content-font)}
   * so a body-level declaration is overridden on exactly the elements the user
   * is looking at (bubble text and the input box). Measured before this fix:
   * body font-family became monospace while the input stayed
   * "Neko Chat Hand", "Segoe UI", ... — the setting looked dead.
   * Overriding --neko-chat-content-font hits every consumer at once (verified:
   * the input's computed font-family flips to monospace). */
  out.push('/* ===================== global font family ===================== */');
  out.push('');
  ['light', 'dark'].forEach(function (mode) {
    var v = NTS_GATED.fontFamily.varName;
    var attr = gateAttrFor(v, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    out.push(head + ' body { font-family: var(' + v + ') !important; }');
    /* The two app-level font variables must be overridden too: the React sheet
     * reads --neko-chat-content-font on bubble text / input, and --neko-ui-font
     * on .app-shell + every dialog. Without these two lines the setting changes
     * only parts of the UI (or nothing visible at all). */
    out.push(head + ' { --neko-chat-content-font: var(' + v + ') !important; }');
    out.push(head + ' { --neko-ui-font: var(' + v + ') !important; }');
    /* Font-size guard — NOT cosmetic.
     *
     * The React sheet has `:root{font-family:var(--neko-ui-font)}`, and our line
     * above points that variable at the user's family. When the user picks a
     * GENERIC family (monospace / serif / cursive), Chromium re-resolves :root's
     * initial `medium` size against that family's default table: monospace is
     * 13px, so the ENTIRE app shrinks from 16px to 13px — every rem, every
     * spacing token, the whole layout, not just the chat text. Measured: html
     * 16px -> 13px, .composer-panel 16px -> 13px.
     *
     * Pinning font-size:16px restores it (1rem/16px both work; medium/unset/100%
     * do NOT — they still resolve through the 13px table).
     *
     * Deliberately WITHOUT !important and inside @layer nts-theme: if the app
     * ever sets a root font-size itself, an unlayered (or unlayered !important)
     * declaration still wins — verified 20px and 22px !important both override
     * this guard. So the guard only repairs the collateral damage it caused. */
    out.push(head + ' { font-size: 16px; }');
  });
  out.push('');

  /* ---------- chat background image ---------------------------------------
   * 与「聊天背板底色」打在完全相同的四个面上（紧凑历史层两个容器 + 展开层两个
   * 容器）。图片天然画在 background-color 之上，所以「图片优先级高于颜色」不需要
   * z-index —— 同一元素的 background-image 永远盖住它自己的 background-color。
   * 四条声明必须成套出现：只写 background-image 时图片按原始像素平铺，一张 4K 图
   * 会把整个聊天区铺成马赛克。 */
  out.push('/* ===================== chat background image ===================== */');
  out.push('');
  ['light', 'dark'].forEach(function (mode) {
    var v = NTS_GATED.chatBackgroundImage.varName;
    var attr = gateAttrFor(v, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    NTS_GATED.chatBackgroundImage.sel.forEach(function (sel) {
      out.push(head + ' body ' + sel + ' { background-image: var(' + v + ') !important;'
        + ' background-size: cover !important;'
        + ' background-position: center center !important;'
        + ' background-repeat: no-repeat !important;'
        /* 背景"钉住"不跟着消息滚动：靠的是 **画在滚动容器自己身上 + attachment
         * scroll**，不是 fixed。
         *   - `scroll`：背景相对该元素的 border-box 定位，元素内部内容滚动时它不动。
         *     这就是"背景固定"的正确做法。
         *   - `fixed`：相对视口定位；Chrome 对这种自带合成滚动层的滚动容器会把
         *     fixed 降级成 local（跟着内容滚），而且祖先 `.compact-chat-surface-frame`
         *     带 backdrop-filter 又会重新定义 fixed 的包含块。v0.4.24 用 fixed 试过，
         *     用户 2026-11-19 反馈"背景图被伸缩、随着文字移动放大移动"，就是这个原因。
         * 另外只画在**尺寸固定**的容器上：`-content` 那种高度 = 内容总高的元素，
         * cover 会按它的盒子缩放，历史越长图越大（"被伸缩"）。 */
        + ' background-attachment: scroll !important; }');
    });
  });
  out.push('');

  /* ---------- chat background image brightness ----------------------------
   * 一个黑色蒙版叠在图片前面，alpha = calc(1 - 亮度)，所以：
   *     亮度 1   → 蒙版 alpha 0    → 原图
   *     亮度 0.6 → 蒙版 alpha 0.4  → 压暗四成
   *     亮度 0   → 蒙版 alpha 1    → 全黑
   * 为什么不用 filter: brightness()：图片是**容器自身的 background**，给容器加
   * filter 会把子元素（气泡、文字）一起调暗，等于把正文也压黑。线性渐变蒙版只
   * 影响 background-image 层，正文完全不受影响。
   * 门控同时要求「背景图」与「亮度」两个变量都设置了（requires）：只设亮度不设
   * 图片时，var(--nts-chat-bg-image) 未定义会让整条声明作废，连底色都丢掉。
   * 必须排在上面那条纯图片规则之后 —— 同特异性、同 !important，后者胜出。 */
  out.push('/* ===== chat background image brightness ===== */');
  ['light', 'dark'].forEach(function (mode) {
    var g = NTS_GATED.chatBackgroundImageBrightness;
    var vb = g.varName;
    var vimg = g.requires;
    var attrB = gateAttrFor(vb, mode);
    var attrI = gateAttrFor(vimg, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attrI + '][' + attrB + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attrI + '][' + attrB + ']:root:root';
    var scrim = 'rgba(0,0,0,calc(1 - var(' + vb + ')))';
    g.sel.forEach(function (sel) {
      out.push(head + ' body ' + sel + ' {'
        + ' background-image: linear-gradient(' + scrim + ',' + scrim + '), var(' + vimg + ') !important;'
        + ' background-size: cover !important;'
        + ' background-position: center center !important;'
        + ' background-repeat: no-repeat !important;'
        /* 同上：两层（蒙版 + 图片）必须同一套 attachment，否则一层动一层不动，错开。 */
        + ' background-attachment: scroll !important; }');
    });
  });
  out.push('');

  /* ---------- chat background image fit ---------------------------------
   * 只覆盖 background-size：cover（默认，铺满会裁切）或 contain（整图可见）。
   * 必须排在上两段之后 —— 同特异性 + 同 !important 下后者胜出；否则这段会被
   * 「background-size: cover」压回去，用户选了「整图可见」却看不到变化。
   * 门控只要求 fit 变量本身：不设背景图时这条规则没有可见效果，不需要
   * requires（也就不必担心「只设 fit 不设图」把声明写坏）。 */
  out.push('/* ===== chat background image fit ===== */');
  ['light', 'dark'].forEach(function (mode) {
    var g = NTS_GATED.chatBackgroundFit;
    var v = g.varName;
    var attr = gateAttrFor(v, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    g.sel.forEach(function (sel) {
      /* 只写一个值：CSS 的 background-size 在层数多于值数时会重复最后一个值，
       * 所以只设亮度（两层：蒙版 + 图片）时也是两层都按 fit 缩放。 */
      out.push(head + ' body ' + sel + ' { background-size: var(' + v + ') !important; }');
    });
  });
  out.push('');

  /* ---------- chat background position / repeat（v0.12.0）----------------
   * 各写一条子属性，因此可以和 image / brightness / fit 任意组合；
   * 与 fit 段一样必须排在前两段之后（同特异性同 !important 下后者胜）。
   */
  out.push('/* ===== chat background position / repeat ===== */');
  ['light', 'dark'].forEach(function (mode) {
    [NTS_GATED.chatBackgroundPosition, NTS_GATED.chatBackgroundRepeat].forEach(function (g) {
      var attr = gateAttrFor(g.varName, mode);
      var head = mode === 'dark'
        ? ':root[data-theme="dark"][' + attr + ']:root:root'
        : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
      var prop = g === NTS_GATED.chatBackgroundRepeat ? 'background-repeat' : 'background-position';
      g.sel.forEach(function (sel) {
        out.push(head + ' body ' + sel + ' { ' + prop + ': var(' + g.varName + ') !important; }');
      });
    });
  });
  out.push('');

  /* ---------- text gradient（文字渐变，v0.13.0）----------------------------
   * 做法是 CSS 里唯一可靠的「文字渐变」套路：
   *   background-image: <gradient>;  background-clip: text;
   *   -webkit-text-fill-color: transparent;
   *
   * 三个注意点：
   *  1. 只能打在**没有自己背景**的文本块上（见 targets.js 的注释）；
   *  2. `-webkit-text-fill-color` 会继承，所以代码块 / 行内代码必须显式复位成
   *     currentColor，否则它们会变成透明文字（不可见但选中可见）；
   *  3. 整段只在变量有值时输出（门控 attr 由加载器打），未设置时零规则、零影响。
   */
  out.push('/* ===== text gradient ===== */');
  ['light', 'dark'].forEach(function (mode) {
    var g = NTS_GATED.textGradient;
    var attr = gateAttrFor(g.varName, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    g.sel.forEach(function (sel) {
      out.push(head + ' body ' + sel + ' { background-image: var(' + g.varName + ') !important;'
        + ' -webkit-background-clip: text !important; background-clip: text !important;'
        + ' -webkit-text-fill-color: transparent !important; }');
      /* 代码块整块反悔：恢复自己的底色，并把字恢复成实色。 */
      out.push(head + ' body ' + sel + ' pre, ' + head + ' body ' + sel + ' code {'
        + ' background-image: none !important; -webkit-background-clip: border-box !important;'
        + ' background-clip: border-box !important; -webkit-text-fill-color: currentColor !important; }');
    });
  });
  out.push('');

  /* ---------- chat line height（v0.12.0）-----------------------------------
   * 无单位倍数直接喂给 line-height：CSS 会按元素自身 font-size 解析，
   * 用户改「聊天字号」时行高跟着走，不会出现「字变大、行距没变、文字粘在一起」。
   */
  out.push('/* ===== chat line height ===== */');
  ['light', 'dark'].forEach(function (mode) {
    var g = NTS_GATED.chatLineHeight;
    var attr = gateAttrFor(g.varName, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    g.sel.forEach(function (sel) {
      out.push(head + ' body ' + sel + ' { line-height: var(' + g.varName + ') !important; }');
    });
  });
  out.push('');

  /* ---------- continuous corner curvature（连续曲率圆角，v0.8.0）----------
   * --nts-corner-style: continuous 时，把「由 --nts-*radius 控制的面」的圆角从
   * 圆弧（quarter circle）换成超椭圆（squircle）—— iOS 那种转角过渡更顺的样子。
   *
   * 只有 Chrome 139+ 才有原生 `corner-shape`，所以整段包在 @supports 里：
   * 老内核上规则不生效、外观不变（加载器仍会打 data-nts-squircle，但没消费者）。
   *
   * 选择器列表**从 targets 里自动收集**所有 border-radius 的 target：以后新增
   * 圆角项不需要回来改这张表。属性值固定 squircle（不做 0-1 平滑度，避免再引入
   * 一个没人会调的旋钮）。
   */
  out.push('/* ===== continuous corner curvature (corner-shape) ===== */');
  (function () {
    var sels = [];
    var seen = {};
    NTS_TARGETS.forEach(function (t) {
      if (t.prop !== 'border-radius') return;
      if (!t.sel || seen[t.sel]) return;
      seen[t.sel] = 1;
      sels.push(t.sel);
    });
    if (!sels.length) return;
    out.push('@supports (corner-shape: squircle) {');
    sels.forEach(function (sel) {
      out.push('  :root[data-nts-squircle]:root:root body ' + sel + ' { corner-shape: squircle !important; }');
    });
    out.push('}');
  })();
  out.push('');

  /* ---------- chat top fade（背景图最上边那层雾） --------------------------
   * 应用在 .compact-export-history-scroll / .compact-export-preview-messages 上写了
   *     mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)
   * 本意是让滚到顶部的内容淡出。但背景图**画在同一个容器上**，图片顶上 28px 也被
   * 一起淡出，用户看到的就是「导入的图片最上边有一层雾」。
   * --nts-chat-top-fade 用 alpha 乘法把这个渐隐收回来：
   *     fade 1 → 0 / .78@12px / 1@28px   ← 与应用原生完全一致
   *     fade 0 → 1 / 1      / 1          ← 全不透明，雾消失
   * 中间值线性过渡，所以不需要第二条写 `none` 的规则。mask 必须与 -webkit- 前缀
   * 一起写：应用自己是两条并排写的。 */
  out.push('/* ===== chat top fade (background image top fog) ===== */');
  ['light', 'dark'].forEach(function (mode) {
    var g = NTS_GATED.chatTopFade;
    var vf = g.varName;
    var attr = gateAttrFor(vf, mode);
    var head = mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
    var at0 = 'rgba(0,0,0,calc(1 - var(' + vf + ')))';
    var at12 = 'rgba(0,0,0,calc(1 - 0.22 * var(' + vf + ')))';
    var grad = 'linear-gradient(to bottom,' + at0 + ' 0,' + at12 + ' 12px,rgba(0,0,0,1) 28px)';
    g.sel.forEach(function (sel) {
      out.push(head + ' body ' + sel + ' {'
        + ' mask-image: ' + grad + ' !important;'
        + ' -webkit-mask-image: ' + grad + ' !important; }');
    });
  });
  out.push('');


  /* ================= 面板边缘光效 + 玻璃拟态（v0.4.3：挂到真实的圆角面板）=================
   * 历史消息浮层（.compact-export-history-*）不是面板：没有 border-radius、没有自己
   * 的背景，高度是 `calc(--compact-export-history-region-height + 控件折叠增量)` 的
   * 预留槽位 —— 消息少时它比气泡实际占位高出一截。所以任何底色/渐变/伪元素装饰画在
   * 它身上，都会在最后一条气泡下方多出一块方角色块（用户 0.4.2 后反馈「面板下面又多了」）。
   *
   * 紧凑态真实面板是胶囊 .compact-chat-surface-frame：
   *   border-radius:999px; overflow:hidden; position:relative;
   *   ::before → 磨砂表面（--compact-chat-surface-bg，z-index:0）
   *   ::after  → 顶部高光渐变 + 4 条 inset 高光（装饰层，z-index:1）
   * overflow:hidden 保证装饰被裁在胶囊内，结构上不可能再「突出来」。
   *
   * 因此：装饰层挂 PANEL::after，磨砂/底色挂 PANEL::before。
   * 宿主 ::after 自带「顶部高光渐变 + 4 条 inset 高光」，我们覆盖 background-image /
   * box-shadow 时必须把原生层合成回去（HOST_AFTER_BG / HOST_AFTER_INSETS），否则
   * 未配置这些变量的主题也会掉一层原有高光，违反「未配置零变化」契约。
   *
   * 门控语义不变：任一相关变量被配置就生效，其余取主题默认值（CSS 没有 OR，
   * 同一段声明按每个触发变量各输出一份）。
   */
  (function emitGlowAndGlass() {
    var V = NTS_GLOW.vars;
    var PANEL = NTS_GLOW.anchorSel;
    var SURF = NTS_GLOW.frostSel;
    var DECO = PANEL + '::after';
    var FROST = SURF + '::before';

    function head(mode) {
      return mode === 'dark'
        ? ':root[data-theme="dark"]'
        : ':root:not([data-theme="dark"])';
    }

    function sel(mode, names) {
      var parts = [head(mode)];
      names.forEach(function (n) { parts.push('[' + gateAttrFor(n, mode) + ']'); });
      parts.push(':root:root body');
      return parts.join('');
    }

    function orRule(mode, triggers, target, decls) {
      triggers.forEach(function (t) {
        out.push(sel(mode, [t]) + ' ' + target + ' { ' + decls.join(' ') + ' }');
      });
    }

    function tint(colorVar, amountExpr, def) {
      return 'color-mix(in srgb, var(' + colorVar + ', ' + def + ')'
        + ' calc(' + amountExpr + ' * 100%), transparent)';
    }

    function tintLiteral(literal, amountExpr) {
      return 'color-mix(in srgb, ' + literal
        + ' calc(' + amountExpr + ' * 100%), transparent)';
    }

    out.push('/* ===== panel edge glow + glassmorphism ===== */');

    /* ---------- 呼吸动画（亮暗共用，只输出一次）----------
     * 挂在装饰层 ::after 上：opacity 只影响高光层，不影响面板本体。 */
    out.push('@keyframes ' + NTS_GLOW.breatheName + ' {'
      + ' 0%, 100% { opacity: 1; }'
      + ' 50% { opacity: calc(1 - var(' + V.glowPulse + ', 0.25)); }'
      + ' }');

    /* 内发光：inset 天然跟随 border-radius。亮色白发光打在浅底上看不见，
     * 所以先垫一层低透明中性暗晕做承托。 */
    function glowShadow(mode) {
      var colored = 'inset 0 0'
        + ' calc(var(' + V.glowSize + ', 24px) * var(' + V.glowStrength + ', 1))'
        + ' calc(var(' + V.glowSize + ', 24px) * 0.42 * var(' + V.glowStrength + ', 1))'
        + ' ' + tint(V.glowColor, 'var(' + V.glowStrength + ', 1)', '#ffffff');
      if (mode !== 'light') return colored;
      return 'inset 0 0'
        + ' calc(var(' + V.glowSize + ', 24px) * 1.35 * var(' + V.glowStrength + ', 1))'
        + ' calc(var(' + V.glowSize + ', 24px) * 0.55 * var(' + V.glowStrength + ', 1))'
        + ' rgba(24, 28, 38, calc(0.10 * var(' + V.glowStrength + ', 1))), '
        + colored;
    }

    /* 宿主 .compact-chat-surface-frame::after 的原生声明（逐字抄自宿主 CSS）。
     * 覆盖这两个属性时必须把它们排在最后合成回去。若宿主未来改动，最坏结果是
     * 面板少一层原生高光，不会破版。 */
    var HOST_AFTER_BG = 'linear-gradient(180deg, var(--compact-chat-surface-glow) 0%,'
      + ' rgba(255,255,255,calc(.05 * var(--neko-chat-opacity-factor, 1))) 16%,'
      + ' transparent 40%, transparent 82%,'
      + ' rgba(115,181,229,calc(.05 * var(--neko-chat-opacity-factor, 1))) 100%)';
    var HOST_AFTER_INSETS = 'inset 0 2px 6px var(--compact-chat-highlight-top),'
      + ' inset 0 -1px 3px var(--compact-chat-highlight-bottom),'
      + ' inset 2px 0 4px var(--compact-chat-highlight-left),'
      + ' inset -2px 0 4px var(--compact-chat-highlight-right)';

    var CORNER_C = 'calc(var(' + V.cornerGlow + ', 1) * 0.95)';
    var CORNERS = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'].map(function (pos) {
      return 'radial-gradient(circle at ' + pos + ', '
        + tint(V.glowColor, CORNER_C, '#ffffff') + ', transparent 34%)';
    }).join(', ');

    var SHEEN_BG = 'linear-gradient(135deg,'
      + ' ' + tintLiteral('#ffffff', 'var(' + V.sheen + ', 1) * 0.42')
      + ' 0%, transparent 46%)';

    var EDGE_SHADOW = 'inset 0 0'
      + ' calc(var(' + V.glowSize + ', 24px) * 0.9)'
      + ' calc(var(' + V.glowSize + ', 24px) * 0.12)'
      + ' ' + tint(V.glowColor, 'var(' + V.edgeGradient + ', 1)', '#ffffff');

    var INNER_SHADOW = 'inset 0 0'
      + ' calc(18px * var(' + V.innerGlow + ', 1))'
      + ' calc(2px * var(' + V.innerGlow + ', 1)) rgba(0,0,0,.35)';

    /* 装饰层结构：伪元素必须有 content 才会生成盒子；圆角直接 inherit 跟随胶囊。 */
    var DECO_STRUCT = [
      'content: "" !important;',
      'position: absolute !important;',
      'inset: 0 !important;',
      'pointer-events: none !important;',
      'border-radius: inherit !important;'
    ];

    var reducedMotion = [];
    ['light', 'dark'].forEach(function (mode) {
      /* ① 内发光 */
      orRule(mode, [V.glowColor, V.glowStrength, V.glowSize], DECO, DECO_STRUCT.concat([
        'box-shadow: ' + glowShadow(mode) + ', ' + HOST_AFTER_INSETS + ' !important;'
      ]));

      /* ② 呼吸（pulse 或 speed 任一触发；速度默认 3.2s） */
      orRule(mode, [V.glowPulse, V.glowSpeed], DECO, DECO_STRUCT.concat([
        'box-shadow: ' + glowShadow(mode) + ', ' + HOST_AFTER_INSETS + ' !important;',
        'animation: ' + NTS_GLOW.breatheName
        + ' var(' + V.glowSpeed + ', 3.2s) ease-in-out infinite !important;'
      ]));
      /* reduced-motion 的关动画选择器必须与动画规则一一对应（OR），
       * 不能写成 `[pulse][speed]` 双门控：动画是「任一变量」就会触发，
       * 而双门控只有「两个都设了」才生效，于是只设一个变量的用户在
       * 「减少动态效果」下照样看见呼吸动画。 */
      reducedMotion.push(sel(mode, [V.glowPulse]) + ' ' + DECO);
      reducedMotion.push(sel(mode, [V.glowSpeed]) + ' ' + DECO);

      /* ③ 半透明描边 */
      orRule(mode, [V.borderColor, V.borderWidth], DECO, DECO_STRUCT.concat([
        'border: var(' + V.borderWidth + ', 1.5px) solid'
        + ' var(' + V.borderColor + ', rgba(255,255,255,.55)) !important;'
      ]));

      /* ④ 四角高光 */
      orRule(mode, [V.cornerGlow], DECO, DECO_STRUCT.concat([
        '--nts-panel-corner-bg: ' + CORNERS + ' !important;'
      ]));

      /* ⑤ 玻璃反射高光 */
      orRule(mode, [V.sheen], DECO, DECO_STRUCT.concat([
        '--nts-panel-sheen-bg: ' + SHEEN_BG + ' !important;'
      ]));

      /* ④+⑤ 合成 background-image：我们的层在上，宿主原生高光渐变在最后 */
      orRule(mode, [V.cornerGlow, V.sheen], DECO, DECO_STRUCT.concat([
        'background-image: var(--nts-panel-sheen-bg, none),'
        + ' var(--nts-panel-corner-bg, none), ' + HOST_AFTER_BG + ' !important;',
        'background-repeat: no-repeat !important;'
      ]));

      /* ⑥ 边缘亮度内侧渐变 */
      orRule(mode, [V.edgeGradient], DECO, DECO_STRUCT.concat([
        '--nts-panel-edge-shadow: ' + EDGE_SHADOW + ' !important;'
      ]));

      /* ⑦ 轻微内阴影 */
      orRule(mode, [V.innerGlow], DECO, DECO_STRUCT.concat([
        '--nts-panel-inner-shadow: ' + INNER_SHADOW + ' !important;'
      ]));

      /* ⑥+⑦ 合成 box-shadow：内阴影/边缘光在上，宿主原生 inset 高光在最后 */
      orRule(mode, [V.edgeGradient, V.innerGlow], DECO, DECO_STRUCT.concat([
        'box-shadow: var(--nts-panel-inner-shadow, 0 0 0 0 transparent),'
        + ' var(--nts-panel-edge-shadow, 0 0 0 0 transparent), '
        + HOST_AFTER_INSETS + ' !important;'
      ]));

      /* ⑧ 玻璃底色：挂面板表面层 ::before 的 background-color */
      orRule(mode, [V.glassTint], FROST, [
        'background-color: var(' + V.glassTint + ') !important;'
      ]);

      /* ⑨ 磨砂：挂面板表面层 ::before 的 backdrop-filter */
      orRule(mode, [V.glassBlur], FROST, [
        'backdrop-filter: var(' + V.glassBlur + ') !important;',
        '-webkit-backdrop-filter: var(' + V.glassBlur + ') !important;'
      ]);
    });

    if (reducedMotion.length) {
      out.push('@media (prefers-reduced-motion: reduce) {');
      out.push('  ' + reducedMotion.join(',\n  ') + ' { animation: none !important; }');
      out.push('}');
    }
    out.push('');
  })();

  /* ---------- bubble veil（聊天背景上那层虚化的总开关） ---------------------
   * --nts-bubble-veil：0 = 完全清透，1 = 应用原生观感，中间值线性过渡。
   *
   * 为什么是乘子而不是开/关：一处变量要同时乘进「白纱 alpha」和「backdrop blur
   * 半径」两个完全不同的属性，只有 calc() 乘法能做到。已在真实运行时验证：
   *     rgba(255,255,255,calc(.88 * var(--v)))  →  v=0 得 alpha 0；v=1 得 .88
   *     blur(calc(8px * var(--v)))              →  v=0 得 blur(0px)；v=1 得 8px
   * 因此「关掉虚化」不需要第二条规则去写 `none`。
   *
   * yieldsTo 的语义（见 targets.js 的 NTS_VEIL 注释）：那一层如果已经有专门的
   * 控件在管（气泡底色 / 毛玻璃模糊），本段必须让位，用 :not([gate]) 静态表达。
   * 关键点：yieldsTo 里的门控必须与**实际生效**的模式同侧 —— 亮色变量只该被
   * 亮色门控让位。这里按每个 entry 自己的 mode 取门控名。
   */
  out.push('/* ===================== bubble veil (chat background fog) ===================== */');
  out.push('');

  function veilGateHead(mode) {
    var attr = gateAttrFor(NTS_VEIL.varName, mode);
    return mode === 'dark'
      ? ':root[data-theme="dark"][' + attr + ']:root:root'
      : ':root:not([data-theme="dark"])[' + attr + ']:root:root';
  }

  /* 让位条件：mode 下所有 yieldsTo 门控都**没**打上时本段才生效。
   * 注意这里用的是同侧门控：亮色条目查 data-nts-l-xxx，暗色条目查 data-nts-d-xxx。
   *
   * 为什么必须按声明分开算：`--nts-chat-blur` 只管 backdrop-filter，气泡底色变量
   * 只管 background。若把两类门控都挂在整条规则上，用户一旦设了「毛玻璃模糊」，
   * 连白纱底也一起失效 —— 表现就是「调了模糊，气泡突然变全透明」。
   * 所以 colors 与 blur 各自算自己的 :not() 后缀。 */
  function veilGateSuffix(vars, mode) {
    if (!vars || !vars.length) return '';
    return vars.map(function (v) {
      return ':not([' + gateAttrFor(v, mode) + '])';
    }).join('');
  }

  function veilColorYields(entry) {
    return (entry.yieldsTo || []).filter(function (v) { return v !== '--nts-chat-blur'; });
  }

  function veilBlurYields(entry) {
    return (entry.yieldsTo || []).indexOf('--nts-chat-blur') >= 0 ? ['--nts-chat-blur'] : [];
  }

  /* alpha 乘子写法：rgba(r, g, b, calc(A * var(--v))) */
  function veilColor(spec) {
    return 'rgba(' + spec.color[0] + ', ' + spec.color[1] + ', ' + spec.color[2] +
      ', calc(' + spec.a.toFixed(4) + ' * var(' + NTS_VEIL.varName + ')))';
  }

  /* 渐变写法：每个 stop 的 alpha 各自乘，颜色与角度原样保留。 */
  function veilGradient(spec) {
    var stops = spec.stops.map(function (s) {
      return 'rgba(' + s[0] + ', ' + s[1] + ', ' + s[2] +
        ', calc(' + s[3].toFixed(4) + ' * var(' + NTS_VEIL.varName + ')))';
    });
    return 'linear-gradient(' + spec.angle + ', ' + stops.join(', ') + ')';
  }

  ['light', 'dark'].forEach(function (mode) {
    NTS_VEIL.entries.forEach(function (entry) {
      var spec = entry[mode];
      if (!spec) return;                 /* 该层没有暗色变体 → 亮色值在暗色下同样生效 */

      var colorHead = veilGateHead(mode) + veilGateSuffix(veilColorYields(entry), mode);
      var sel = colorHead + ' body ' + entry.sel;

      /* 白纱底。渐变层用 background-image（不是 background-color），因为原生就是
       * 渐变；写 background-color 会在渐变下面多出一块实色。 */
      if (spec.stops) {
        out.push(sel + ' { background-image: ' + veilGradient(spec) + ' !important; }');
      } else {
        out.push(sel + ' { background-color: ' + veilColor(spec) + ' !important; }');
      }

      /* 背景模糊单独一条：只有原生带 blur 的层才发，且让位给 --nts-chat-blur。 */
      if (entry.blur) {
        var blurHead = veilGateHead(mode) + veilGateSuffix(veilBlurYields(entry), mode);
        var b = 'blur(calc(' + entry.blur.px + 'px * var(' + NTS_VEIL.varName + ')))';
        if (entry.blur.extra) b += ' ' + entry.blur.extra;
        out.push(blurHead + ' body ' + entry.sel +
          ' { backdrop-filter: ' + b + ' !important;' +
          ' -webkit-backdrop-filter: ' + b + ' !important; }');
      }
    });
  });
  out.push('');

  /* close the @layer nts-theme block opened right after `var out = []` */
  out.push('}');
  out.push('');

  fs.mkdirSync(path.dirname(outCss), { recursive: true });
  fs.writeFileSync(outCss, out.join('\n') + '\n', 'utf8');

  /* ---------- reference report for the panel ------------------------------
   * native/darkNative are DISPLAY TEXT ONLY. They are never emitted as CSS, and
   * they are only as trustworthy as the measuring page -- that is exactly why
   * they no longer appear in any declaration. */
  var LI = new Map(), DI = new Map();
  light.rows.forEach(function (r) { LI.set(r.sel + '|' + r.prop, r); });
  dark.rows.forEach(function (r) { DI.set(r.sel + '|' + r.prop, r); });

  var report = {};
  all.forEach(function (e) {
    var lr = LI.get(e.sel + '|' + e.prop);
    var dr = DI.get(e.sel + '|' + e.prop);
    if (!report[e.v]) {
      report[e.v] = { kind: e.kind, gate: true, native: null, darkNative: null, sels: [] };
    }
    var r = report[e.v];
    if (lr && lr.val && r.native === null) r.native = lr.val;
    if (dr && dr.val && r.darkNative === null) r.darkNative = dr.val;
    r.sels.push(e.sel + ' | ' + e.prop);
  });

  /* The two bridge variables are consumed by CSS but have no CATALOG control of
   * their own in targets.js; declare them so tooling can see them. */
  fs.writeFileSync(outVars, JSON.stringify(report, null, 2), 'utf8');

  var bytes = fs.statSync(outCss).size;
  console.log('generated : ' + outCss + '  (' + bytes + ' bytes)');
  console.log('targets   : ' + all.length + ' emitted (' + emitted + ' gated rule block(s)), ' +
              aux.length + ' aux-only');
  console.log('gradient kills: ' + killImage.length);
  console.log('vars      : ' + Object.keys(report).length + ' -> ' + outVars);
  console.log('fallbacks : 0 (v3 emits none by design)');
  if (warn.length) { console.log('warnings  : ' + warn.length); warn.forEach(function (w) { console.log('   ' + w); }); }
}

main();
