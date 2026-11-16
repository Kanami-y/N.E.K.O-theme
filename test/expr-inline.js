(async () => {
  /* What <style> elements exist on the real page, and do any of them override the
   * targets we got wrong? The winner scan showed `(inline)` declarations with
   * !important that beat both index.css and dark-mode.css, which means the
   * "native" value the fixture measured is not the value the app actually renders. */
  const out = { url: location.href, sheets: [], probes: {} };

  const SEL = ['#react-chat-window-shell', '#text-input-area', '.composer-input-shell',
    '.composer-panel', '.system-chip', '.message-block-text'];

  for (const st of document.querySelectorAll('style')) {
    const t = st.textContent || '';
    const row = {
      id: st.id || '(no id)',
      owner: st.dataset ? JSON.stringify(Object.assign({}, st.dataset)) : '',
      chars: t.length,
      importantCount: (t.match(/!important/g) || []).length,
      ruleCount: (t.match(/\}/g) || []).length,
      mentions: []
    };
    for (const s of SEL) if (t.indexOf(s) !== -1) row.mentions.push(s);
    /* first 300 chars as a fingerprint of origin */
    row.head = t.slice(0, 300).replace(/\s+/g, ' ');
    out.sheets.push(row);
  }

  /* For each interesting selector, list declarations from INLINE <style> sheets only. */
  const div = document.createElement('div');
  div.id = '__nts_inl';
  div.style.cssText = 'position:absolute;left:-4000px;top:0;width:1200px;';
  div.innerHTML = `<div id="react-chat-window-shell"><div id="text-input-area">
      <div class="composer-input-shell"><textarea class="composer-input"></textarea></div>
    </div><div class="composer-panel"></div><div class="system-chip"></div>
    <div class="message-block-text">t</div></div>`;
  document.body.appendChild(div);

  function spec(sel) {
    let s = sel.replace(/:where\([^)]*\)/g, '');
    const a = (s.match(/#[\w-]+/g) || []).length;
    let b = (s.match(/\.[\w-]+/g) || []).length + (s.match(/\[[^\]]+\]/g) || []).length;
    b += (s.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).filter(x => !/^::/.test(x)).length;
    const c = (s.match(/::[\w-]+/g) || []).length;
    return [a, b, c];
  }

  for (const s of SEL) {
    const el = div.querySelector(s);
    if (!el) continue;
    const hits = [];
    for (const sheet of document.styleSheets) {
      if (sheet.href) continue;              /* inline only */
      let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
      const ownerId = sheet.ownerNode ? (sheet.ownerNode.id || '(no id)') : '?';
      const walk = (rs, media) => {
        for (const r of rs) {
          if (r.cssRules && r.conditionText !== undefined) { walk(r.cssRules, r.conditionText); continue; }
          if (!r.selectorText) continue;
          let m = false; try { m = el.matches(r.selectorText); } catch (e) { continue; }
          if (!m) continue;
          const decls = [];
          for (let i = 0; i < r.style.length; i++) {
            const p = r.style[i];
            decls.push(p + ':' + r.style.getPropertyValue(p) +
              (r.style.getPropertyPriority(p) ? ' !important' : ''));
          }
          if (!decls.length) continue;
          hits.push({ owner: ownerId, sel: r.selectorText, spec: spec(r.selectorText).join(','),
            media: media || null, decls: decls.join('; ') });
        }
      };
      walk(rules, null);
    }
    out.probes[s] = hits;
  }

  div.remove();
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 1);
})()
