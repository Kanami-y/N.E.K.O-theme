(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { checks: [] };

  const mk = () => {
    const old = document.getElementById('__p'); if (old) old.remove();
    const root = document.createElement('div');
    root.id = '__p';
    root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;background:#fff';
    root.innerHTML =
      '<div class="message-bubble-assistant"><div class="message-block-markdown">' +
      '<div class="message-block-text" id="__t">chat body text</div></div></div>' +
      '<div class="proactive-recommendation"><div class="proactive-recommendation-card" id="__c">card</div></div>' +
      '<div class="composer-panel" id="__pn">panel</div>';
    document.body.appendChild(root);
  };
  const read = (label) => {
    const g = (id, p) => { const e = document.getElementById(id); return e ? getComputedStyle(e)[p] : null; };
    out.checks.push({
      label,
      textColor: g('__t', 'color'),
      cardBorderTop: g('__c', 'borderTopColor'),
      cardBorderWidth: g('__c', 'borderTopWidth'),
      panelColor: g('__pn', 'color'),
      activeAttr: document.documentElement.hasAttribute('data-nts-active'),
      gates: Array.from(document.documentElement.attributes).map(a => a.name).filter(n => n.indexOf('data-nts') === 0),
    });
  };

  // Light mode, sheet loaded, EMPTY palette
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('dark');
  await sleep(150);
  mk(); await sleep(150);
  read('1. light / EMPTY palette (must equal native)');

  // Now simulate the user configuring the text colour + card border.
  // The loader normally does exactly this: set the var on :root and add the gate attribute.
  const st = document.createElement('style');
  st.id = '__userpal';
  st.textContent = ':root{--nts-ai-bubble-text:#c0392b;--nts-rec-border:#00b894;--nts-panel-text:#8e44ad}';
  document.head.appendChild(st);
  document.documentElement.setAttribute('data-nts-ai-bubble-text', '1');
  document.documentElement.setAttribute('data-nts-rec-border', '1');
  document.documentElement.setAttribute('data-nts-panel-text', '1');
  document.documentElement.setAttribute('data-nts-active', '1');
  await sleep(250);
  mk(); await sleep(150);
  read('2. light / palette SET (gated rules must fire)');

  // Dark mode
  document.documentElement.setAttribute('data-theme', 'dark');
  await sleep(250);
  mk(); await sleep(150);
  read('3. dark / palette SET');

  // Remove palette + gates -> must return to native-by-attribute
  st.remove();
  ['data-nts-ai-bubble-text', 'data-nts-rec-border', 'data-nts-panel-text', 'data-nts-active']
    .forEach(a => document.documentElement.removeAttribute(a));
  await sleep(250);
  mk(); await sleep(150);
  read('4. dark / palette CLEARED');

  document.documentElement.removeAttribute('data-theme');
  await sleep(250);
  mk(); await sleep(150);
  read('5. light / palette CLEARED');

  const r = document.getElementById('__p'); if (r) r.remove();
  document.title = 'NTS-PROBE-DONE';
  return JSON.stringify(out, null, 2);
})()
