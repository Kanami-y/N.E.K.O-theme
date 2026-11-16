#!/usr/bin/env node
/*
 * gen-realpage-probe.js -- emit a page-eval expression that measures every target
 * IN THE REAL APPLICATION PAGE with our stylesheet disabled.
 *
 * Why this exists
 * ---------------
 * The synthetic fixture's DOM context does not match the real page, so the computed
 * values it reports for some selectors are simply not the values the real app has.
 * A fallback frozen from a wrong value silently rewrites unconfigured appearance.
 *   Real incident: .message-block-text has no native `color` at all; the fixture
 *   inherited white and the frozen fallback produced white-on-white chat text.
 *   Remaining measured mismatches after that fix: #react-chat-window-shell radius
 *   14px vs real 22px; #text-input-area background 0.4 vs real 0.5; and more.
 *
 * So: measure the real page too, and only trust a fallback that EQUALS the real
 * page's value. Anything we cannot prove gets gated (no fallback at all), which
 * keeps the feature (the user can still set it) while guaranteeing that
 * "unconfigured" stays byte-identical to "stylesheet not loaded".
 *
 * Usage:
 *   node gen-realpage-probe.js <targets.js> <out-expr.js>
 * Then run it through tools/page-eval.js on /chat in light and dark.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const targetsPath = process.argv[2];
const outPath = process.argv[3];
if (!targetsPath || !outPath) {
  console.error('usage: node gen-realpage-probe.js <targets.js> <out-expr.js>');
  process.exit(2);
}

const targetsSrc = fs.readFileSync(targetsPath, 'utf8');

const expr = `(async () => {
  /* --- inlined targets.js --- */
  ${targetsSrc}

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* Make the page indistinguishable from "our stylesheet never loaded":
     disable the link and drop the dynamic style the loader would have injected. */
  const link = document.querySelector('link[href*="neko-theme-studio.css"]');
  if (link) link.disabled = true;
  const dyn = document.getElementById('nts-dynamic');
  if (dyn) dyn.remove();
  await sleep(400);

  function splitPseudo(sel) {
    const i = sel.indexOf('::');
    if (i >= 0) return { base: sel.slice(0, i), pseudo: sel.slice(i) };
    return { base: sel, pseudo: null };
  }

  function readTarget(t) {
    const s = splitPseudo(t.sel);
    if (/:(hover|focus|focus-visible|focus-within|active|visited|target)\\b/.test(s.base)) return 'NO-PSEUDO-STATE';
    if (s.pseudo === '::selection') return 'UNQUERYABLE';
    let el;
    try { el = s.base ? document.querySelector(s.base) : document.body; } catch (e) { return 'BAD-SELECTOR'; }
    if (!el) return 'MISSING-ELEMENT';
    try {
      const cs = getComputedStyle(el, s.pseudo);
      const v = String(cs.getPropertyValue(t.prop)).trim();
      return v === '' ? 'EMPTY' : v;
    } catch (e) { return 'BAD-SELECTOR'; }
  }

  /* Detect whether an element is actually RENDERED. An element inside a
     display:none subtree still resolves computed styles, but its values can
     differ from the rendered case for anything influenced by layout/state,
     so we record it and let the generator distrust those. */
  function rendered(el) {
    if (!el) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      n = n.parentElement;
    }
    return !!el.getClientRects().length;
  }

  const rows = [];
  for (let i = 0; i < NTS_TARGETS.length; i++) {
    const t = NTS_TARGETS[i];
    const s = splitPseudo(t.sel);
    let el = null, isRendered = false;
    try { el = s.base ? document.querySelector(s.base) : document.body; } catch (e) {}
    try { isRendered = rendered(el); } catch (e) {}
    rows.push({
      i: i, sel: t.sel, prop: t.prop, v: t.v || null, aux: !!t.aux, gate: !!t.gate,
      val: readTarget(t),
      present: !!el,
      rendered: isRendered
    });
  }

  if (link) link.disabled = false;

  return JSON.stringify({
    url: location.href,
    theme: document.documentElement.getAttribute('data-theme') || 'light',
    innerWidth: window.innerWidth,
    rows: rows
  });
})()
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, expr, 'utf8');
console.log('wrote ' + outPath + ' (' + expr.length + ' bytes)');
