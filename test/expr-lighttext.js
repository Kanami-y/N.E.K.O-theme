(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [] };

  // Force LIGHT mode the same way the app does it: remove the attribute.
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  await sleep(200);

  const link = document.querySelector('link[href*="neko-theme-studio.css"]');
  out.sheetLinkFound = !!link;
  out.sheetHref = link ? link.getAttribute('href') : null;

  // Build a realistic assistant bubble: bubble > markdown > block-text
  const build = () => {
    const old = document.getElementById('__nts_probe_root');
    if (old) old.remove();
    const root = document.createElement('div');
    root.id = '__nts_probe_root';
    root.style.position = 'fixed';
    root.style.left = '0px';
    root.style.top = '0px';
    root.style.zIndex = '2147483646';
    root.innerHTML =
      '<div class="message-bubble-assistant"><div class="message-block-markdown">' +
      '<div class="message-block-text" id="__t">\u5bf9\u8bdd\u6b63\u6587 sample text</div>' +
      '</div></div>';
    document.body.appendChild(root);
  };

  const read = () => {
    const t = document.getElementById('__t');
    const md = document.querySelector('#__nts_probe_root .message-block-markdown');
    const bub = document.querySelector('#__nts_probe_root .message-bubble-assistant');
    const g = (el) => el ? getComputedStyle(el) : null;
    return {
      textColor: g(t) ? g(t).color : null,
      markdownColor: g(md) ? g(md).color : null,
      bubbleBg: g(bub) ? g(bub).backgroundColor : null,
      bodyColor: getComputedStyle(document.body).color,
    };
  };

  build();
  await sleep(150);
  out.withSheet = read();

  if (link) { link.disabled = true; await sleep(200); }
  build();               // rebuild so inherited values are recomputed cleanly
  await sleep(200);
  out.withSheetDisabled = read();
  out.sheetActuallyDisabled = link ? link.disabled : null;

  if (link) { link.disabled = false; await sleep(200); }
  build();
  await sleep(200);
  out.restored = read();

  // Any other sheets that mention .message-block-text ?
  out.nativeColorSources = [];
  for (const ss of Array.from(document.styleSheets)) {
    const href = ss.href || '(inline)';
    if (String(href).includes('neko-theme-studio')) continue;
    let rules; try { rules = ss.cssRules; } catch (e) { continue; }
    if (!rules) continue;
    const walk = (rs, media) => {
      for (const r of Array.from(rs)) {
        if (r.cssRules) { walk(r.cssRules, (r.conditionText || r.media && r.media.mediaText || media)); continue; }
        if (!r.selectorText) continue;
        if (!/\.message-block-(text|markdown)\b/.test(r.selectorText)) continue;
        if (!/color/.test(r.style && r.style.cssText || '')) continue;
        out.nativeColorSources.push({ href: String(href).split('/').pop(), sel: r.selectorText, css: r.style.cssText });
      }
    };
    try { walk(rules, ''); } catch (e) {}
  }

  const root = document.getElementById('__nts_probe_root');
  if (root) root.remove();
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 2);
})()
