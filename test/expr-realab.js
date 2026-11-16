(async () => {
  /* Real-page A/B zero-change check.
   *
   * This is the instrument that was MISSING when a severe defect shipped: the synthetic
   * fixture measured an INHERITED value as if it were native and baked it into a fallback,
   * turning light-mode chat text white-on-white (contrast 1.00). The fixture cannot catch
   * that class of bug because its DOM context differs from the real page's.
   *
   * So this runs on the REAL /chat document (real stylesheets, real cascade), injects a
   * representative element for every themed selector into that document, then measures
   * computed styles with our stylesheet ENABLED vs DISABLED, palette empty, both themes.
   * Any difference is a defect: with no colours configured the sheet must be a no-op.
   *
   * `link.disabled = true` is a faithful "sheet absent" because with an empty palette the
   * loader also injects no dynamic style element.
   */

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { diffs: [], counts: {} };

  const MARKUP = `
    <div class="message user"><div class="message-block"><div class="message-block-text">t</div>
      <div class="message-block-markdown">md <a href="#">l</a> <code class="message-markdown-inline-code">c</code>
      <pre class="message-markdown-pre">p</pre></div></div></div>
    <div class="message gemini"><div class="message-block"><div class="message-block-markdown">ai</div></div></div>
    <div class="message-row message-row-user"><div class="message-stack">
      <div class="message-bubble message-bubble-user"><div class="message-block"><div class="message-block-markdown">u</div></div></div>
    </div></div>
    <div class="message-row"><div class="message-stack">
      <div class="message-bubble message-bubble-assistant"><div class="message-block"><div class="message-block-markdown">a <a href="#">l</a></div></div></div>
    </div></div>
    <div class="message-bubble message-bubble-tool">t</div>
    <div class="message-bubble message-bubble-system">s</div>
    <div class="message-block message-block-image">i</div>
    <div class="message-block-status tone-info">si</div>
    <div class="message-block-status tone-success">ss</div>
    <div class="message-block-status tone-warning">sw</div>
    <div class="message-block-status tone-error">se</div>
    <div id="react-chat-window-root"><div id="react-chat-window-shell"><div id="react-chat-window-backdrop"></div>
      <div class="window-topbar"><span class="window-title">t</span></div>
      <div class="chat-window"><div class="chat-body"></div></div>
      <div class="composer-panel">panel <a href="#">in-panel link</a></div>
      <div id="text-input-area">
        <div class="composer-input-shell"><textarea class="composer-input" placeholder="p"></textarea></div>
        <button class="composer-tool-btn"></button><button class="composer-icon-button"></button>
        <button class="composer-emoji-btn"></button><button class="composer-translate-btn"></button>
        <button class="composer-overflow-btn"></button><button class="composer-galgame-btn"></button>
        <button class="composer-tool-clear-btn"></button><button class="composer-attachment-remove"></button>
        <span class="send-button-circle"></span>
        <div class="composer-attachments"></div>
        <div class="composer-visit-bar">v<span class="composer-visit-bar-badge">b</span><button class="composer-visit-bar-action">a</button></div>
      </div>
      <div class="composer-icon-popover">ip</div>
      <div class="composer-overflow-popover">op</div>
      <div class="composer-overflow-menu">om</div>
      <div class="composer-galgame-options"><div class="composer-galgame-option">o</div></div>
      <div class="modal-overlay"><div class="modal-dialog"><h3 class="modal-title">t</h3></div></div>
      <div class="proactive-recommendation"><div class="proactive-recommendation-bubble">
        <div class="proactive-recommendation-card">c</div></div>
        <div class="music-recommendation-bubble"><div class="music-recommendation-icon">i</div></div>
        <div class="system-chip"><div class="system-chip-content">c</div></div>
        <div class="compact-export-history-bubble">h</div>
        <div class="compact-export-preview-bubble">p</div>
      </div>
      <div id="agent-plugin-views"><div id="agent-plugin-content"><div class="agent-plugin-view">v</div></div></div>
      <div id="textInputBox"><button id="sendButton">s</button><button id="textSendButton">t</button></div>
    </div></div>`;

  const SELECTORS = [
    '.message.user', '.message.gemini', '.message-block', '.message-block-text',
    '.message-block-markdown', '.message-block-markdown a', '.message-block-markdown code',
    '.message-block-markdown pre', '.message-markdown-inline-code', '.message-markdown-pre',
    '.message-block-image', '.message-bubble-user', '.message-bubble-assistant',
    '.message-bubble-tool', '.message-bubble-system',
    '.message-block-status.tone-info', '.message-block-status.tone-success',
    '.message-block-status.tone-warning', '.message-block-status.tone-error',
    '#react-chat-window-root', '#react-chat-window-shell', '#react-chat-window-backdrop',
    '.chat-body', '.window-topbar', '.window-title',
    '#text-input-area', '.composer-input-shell', '.composer-input',
    '.composer-icon-button', '.composer-tool-btn', '.composer-emoji-btn',
    '.composer-translate-btn', '.composer-overflow-btn', '.composer-galgame-btn',
    '.composer-tool-clear-btn', '.composer-attachment-remove',
    '.send-button-circle', '#sendButton', '#textSendButton',
    '.composer-panel', '.composer-panel a', '.composer-icon-popover',
    '.composer-overflow-popover', '.composer-overflow-menu', '.composer-galgame-option',
    '.composer-visit-bar', '.composer-visit-bar-badge', '.composer-visit-bar-action',
    '.composer-attachments',
    '.modal-overlay', '.modal-dialog', '.modal-title',
    '.proactive-recommendation', '.proactive-recommendation-card',
    '.proactive-recommendation-bubble', '.music-recommendation-bubble',
    '.system-chip', '.compact-export-history-bubble', '.compact-export-preview-bubble',
    '#agent-plugin-views', '#agent-plugin-content', '.agent-plugin-view',
    '#textInputBox'
  ];
  const PROPS = ['color', 'background-color', 'background-image', 'border-top-color',
    'border-top-width', 'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-right-radius', 'border-bottom-left-radius', 'outline-color',
    'outline-width', 'box-shadow', 'backdrop-filter', 'font-size', 'font-family',
    'scrollbar-color'];

  const link = document.querySelector('link[href*="neko-theme-studio.css"]');
  out.sheetFound = !!link;
  if (!link) { document.title = 'NTS-PROBE-DONE'; return JSON.stringify({ error: 'stylesheet link not found' }); }

  function mount() {
    const old = document.getElementById('__nts_ab');
    if (old) old.remove();
    const d = document.createElement('div');
    d.id = '__nts_ab';
    /* keep it out of the way but still rendered (display:none would zero out computed values) */
    d.style.cssText = 'position:absolute;left:-4000px;top:0;width:1200px;';
    d.innerHTML = MARKUP;
    document.body.appendChild(d);
    return d;
  }
  mount();

  function snap() {
    const res = {};
    for (const sel of SELECTORS) {
      let el = null;
      try { el = document.querySelector('#__nts_ab ' + sel) || document.querySelector(sel); }
      catch (e) { res[sel] = 'BAD-SELECTOR'; continue; }
      if (!el) { res[sel] = 'MISSING-ELEMENT'; continue; }
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { res[sel] = 'UNQUERYABLE'; continue; }
      const o = {};
      for (const p of PROPS) { try { o[p] = String(cs.getPropertyValue(p)).trim(); } catch (e) { o[p] = 'ERR'; } }
      res[sel] = o;
    }
    return res;
  }

  async function ab(themeLabel, isDark) {
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    else {
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.classList.remove('dark');
    }
    await sleep(250);
    mount(); await sleep(250);

    link.disabled = false; await sleep(400);
    const on = snap();

    link.disabled = true; await sleep(400);
    const off = snap();

    link.disabled = false; await sleep(250);

    for (const sel of SELECTORS) {
      const a = on[sel], b = off[sel];
      if (typeof a === 'string' || typeof b === 'string') {
        if (a !== b) out.diffs.push({ theme: themeLabel, sel, note: 'availability differs', on: a, off: b });
        continue;
      }
      for (const p of PROPS) {
        if (a[p] !== b[p]) out.diffs.push({ theme: themeLabel, sel, prop: p, sheetOn: a[p], sheetOff: b[p] });
      }
    }
  }

  out.paletteEmpty = !document.getElementById('nts-dynamic');
  out.gateAttrs = Array.from(document.documentElement.attributes)
    .map(a => a.name).filter(n => n.indexOf('data-nts') === 0);

  await ab('light', false);
  await ab('dark', true);

  document.documentElement.removeAttribute('data-theme');
  const r = document.getElementById('__nts_ab'); if (r) r.remove();
  out.diffCount = out.diffs.length;
  out.verdict = out.diffs.length === 0 ? 'PASS' : 'FAIL';
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 2);
})()
