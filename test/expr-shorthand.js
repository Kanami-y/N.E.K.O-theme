(async () => {
  const out = { tests: [] };
  const st = document.createElement('style');
  st.textContent = `
    .t-border { border: 1px solid var(--recommendation-line, rgba(1,2,3,0.5)); }
    .t-bg { background: #123456; }
    .t-bgc { background-color: #654321; }
    .t-font { font: italic bold 14px/1.4 sans-serif; }
    .t-color { color: #abcdef; }
    .t-br { border-radius: 18px; }
    .t-1px { border-top: 2px solid rgb(9,9,9); }
    .probe-parent { --recommendation-line: rgba(108,151,174,.18); }
  `;
  document.head.appendChild(st);

  const mk = (cls) => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); return d; };
  const el1 = mk('t-border'), el2 = mk('t-bg'), el3 = mk('t-font'), el4 = mk('t-color'), el5 = mk('t-br'), el6 = mk('t-1px');

  // Find our injected sheet and read what CSSStyleDeclaration reports for shorthands.
  let sh = null;
  for (const ss of Array.from(document.styleSheets)) {
    try { if (String(ss.ownerNode && ss.ownerNode.textContent || '').indexOf('t-border') >= 0) sh = ss; } catch (e) {}
  }
  const rules = sh ? Array.from(sh.cssRules) : [];
  const report = (selPart, props) => {
    const r = rules.find(x => x.selectorText && x.selectorText.indexOf(selPart) >= 0);
    if (!r) return { selPart, found: false };
    const o = { selPart, found: true, cssText: r.style.cssText };
    for (const p of props) {
      let v = null; try { v = r.style.getPropertyValue(p); } catch (e) { v = 'THREW'; }
      o[p] = v === '' ? '(empty string)' : v;
    }
    return o;
  };

  out.tests.push(report('.t-border', ['border', 'border-color', 'border-top-color', 'border-style']));
  out.tests.push(report('.t-bg', ['background', 'background-color', 'background-image']));
  out.tests.push(report('.t-font', ['font', 'font-size', 'font-family']));
  out.tests.push(report('.t-color', ['color']));
  out.tests.push(report('.t-br', ['border-radius', 'border-top-left-radius']));
  out.tests.push(report('.t-1px', ['border', 'border-color', 'border-top-color', 'border-top-width']));

  // And what the computed values are, for reference.
  const cs = (el) => { const c = getComputedStyle(el); return { bc: c.borderTopColor, btc: c.backgroundColor, col: c.color, fs: c.fontSize, br: c.borderTopLeftRadius }; };
  out.computed = { t_border: cs(el1), t_bg: cs(el2), t_font: cs(el3), t_color: cs(el4), t_br: cs(el5), t_1px: cs(el6) };

  // The real question: for the REAL card rule, does getPropertyValue('border-color') resolve?
  out.realCardRules = [];
  for (const ss of Array.from(document.styleSheets)) {
    let rs; try { rs = ss.cssRules; } catch (e) { continue; }
    if (!rs) continue;
    const walk = (list) => {
      for (const r of Array.from(list)) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
        if (!r.selectorText || r.selectorText.indexOf('proactive-recommendation-card') < 0) continue;
        out.realCardRules.push({
          sheet: String(ss.href || '(inline)').split('/').pop(),
          sel: r.selectorText,
          cssText: String(r.style.cssText).slice(0, 260),
          'get border-color': (() => { try { return r.style.getPropertyValue('border-color') || '(empty)'; } catch (e) { return 'THREW'; } })(),
          'get border': (() => { try { return r.style.getPropertyValue('border') || '(empty)'; } catch (e) { return 'THREW'; } })(),
          'get background-color': (() => { try { return r.style.getPropertyValue('background-color') || '(empty)'; } catch (e) { return 'THREW'; } })(),
          'get background': (() => { try { return r.style.getPropertyValue('background') || '(empty)'; } catch (e) { return 'THREW'; } })(),
        });
      }
    };
    try { walk(rs); } catch (e) {}
  }

  st.remove();
  for (const e of [el1, el2, el3, el4, el5, el6]) e.remove();
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 2);
})()
