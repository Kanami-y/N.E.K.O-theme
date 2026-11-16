(async () => {
  /* Which declaration actually WINS on the real page for a target we got wrong?
   * Lists every matching declaration from every stylesheet with its specificity,
   * so we can see whether the fixture's measured value came from a rule that does
   * not win here (context-dependent) or from a sheet we do not load at all. */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const TARGETS = [
    { sel: '#react-chat-window-shell', props: ['border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'] },
    { sel: '#text-input-area', props: ['background-color', 'border-top-color'] },
    { sel: '.composer-input-shell', props: ['background-color', 'border-top-color'] },
  ];

  const MARKUP = `
    <div id="react-chat-window-root"><div id="react-chat-window-shell">
      <div id="text-input-area"><div class="composer-input-shell"><textarea class="composer-input"></textarea></div></div>
    </div></div>`;

  const div = document.createElement('div');
  div.id = '__nts_w';
  div.style.cssText = 'position:absolute;left:-4000px;top:0;width:1200px;';
  div.innerHTML = MARKUP;
  document.body.appendChild(div);
  await sleep(150);

  function spec(sel) {
    const m = sel.match(/:(?:where\([^)]*\))?/g) || [];
    let a = 0, b = 0, c = 0;
    let s = sel;
    s = s.replace(/:where\([^)]*\)/g, '');           /* :where() contributes 0 */
    a = (s.match(/#[\w-]+/g) || []).length;
    b = (s.match(/\.[\w-]+/g) || []).length;
    b += (s.match(/\[[^\]]+\]/g) || []).length;
    b += (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).filter(x => !/^::/.test(x)).length;
    c = (s.match(/::[\w-]+/g) || []).length;
    return [a, b, c];
  }
  const cmp = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

  const out = { url: location.href, theme: document.documentElement.getAttribute('data-theme') || 'light', results: [] };

  const link = document.querySelector('link[href*="neko-theme-studio.css"]');
  const oursHref = link ? link.getAttribute('href') : '(none)';
  out.ourSheet = oursHref;

  for (const t of TARGETS) {
    const el = div.querySelector(t.sel);
    if (!el) { out.results.push({ sel: t.sel, error: 'MISSING' }); continue; }
    const cs = getComputedStyle(el);
    const row = { sel: t.sel, computed: {}, declarations: {} };
    for (const p of t.props) row.computed[p] = String(cs.getPropertyValue(p)).trim();

    for (const p of t.props) {
      const hits = [];
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        const walk = (rs, media) => {
          for (const r of rs) {
            if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, r.conditionText); continue; }
            if (!r.selectorText) continue;
            /* does this rule even mention the element? */
            let m = false;
            try { m = el.matches(r.selectorText); } catch (e) { continue; }
            if (!m) continue;
            const v = r.style.getPropertyValue(p);
            const imp = r.style.getPropertyPriority(p);
            if (!v && !imp) continue;
            hits.push({
              sheet: (sheet.href || '(inline)').split('/').pop(),
              ours: sheet.href === oursHref,
              sel: r.selectorText,
              spec: spec(r.selectorText).join(','),
              val: v,
              imp: imp === 'important',
              media: media || null
            });
          }
        };
        walk(rules, null);
      }
      /* order: important first, then specificity, then document order */
      hits.sort((x, y) => {
        if (x.imp !== y.imp) return x.imp ? 1 : -1;
        const s = cmp(spec(y.sel), spec(x.sel));
        return s;
      });
      row.declarations[p] = hits;
    }
    out.results.push(row);
  }

  div.remove();
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 1);
})()
