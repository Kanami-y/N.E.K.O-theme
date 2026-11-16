/* Real-page check of the GATED targets, both themes.  [v3 semantics]
 *
 * In v3 EVERY generated declaration is gated per (mode, variable) on
 *   data-nts-l-<var>   (light group, matches only when NOT dark)
 *   data-nts-d-<var>   (dark group,  matches only when dark)
 * so this probe proves the bargain in both directions, separately per mode:
 *   - setting the variable IN THE CURRENT MODE moves the real page to the requested value,
 *   - clearing the palette returns the page EXACTLY to its untouched native rendering,
 *   - the light group alone must NOT be able to move the page in dark mode (and vice versa).
 *
 * Targets under test:
 *   #react-chat-window-shell  border-top-left-radius   --nts-shell-radius
 *   #text-input-area          background-color         --nts-input-bg
 *   .composer-input-shell     border-top-color         --nts-input-border
 *
 * A fresh /chat page has no .composer-input-shell (the composer is built on demand), so
 * absent targets get a stand-in mounted inside #text-input-area -- a real host element, so
 * the inherited context is preserved. display:none would zero the computed value, hence the
 * off-screen positioning. Every measurement records whether it read a real element.
 */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [], errors: [] };
  const PID = 'neko_theme_studio';
  const PLUGIN = 'http://127.0.0.1:48916';

  const TARGETS = [
    { name: 'shell',   sel: '#react-chat-window-shell', prop: 'border-top-left-radius', v: '--nts-shell-radius', want: '26px' },
    { name: 'inputbg', sel: '#text-input-area',         prop: 'background-color',      v: '--nts-input-bg',     want: 'rgba(10, 200, 30, 0.5)' },
    { name: 'cmpbord', sel: '.composer-input-shell',    prop: 'border-top-color',      v: '--nts-input-border', want: 'rgb(200, 0, 120)' }
  ];
  const suffix = (v) => v.replace(/^--nts-/, '');

  const STANDIN_ID = '__nts_standin';
  function ensureTargets() {
    const old = document.getElementById(STANDIN_ID);
    if (old) old.remove();
    const host = document.querySelector('#text-input-area') || document.body;
    const box = document.createElement('div');
    box.id = STANDIN_ID;
    /* off-screen but still rendered -- display:none would zero computed values */
    box.style.cssText = 'position:absolute;left:-4000px;top:0;width:1200px;';
    box.innerHTML = '<div class="composer-input-shell"><textarea class="composer-input" ' +
                    'placeholder="p"></textarea></div>';
    host.appendChild(box);
  }

  function resolve(t) {
    const real = document.querySelector(t.sel);
    if (real && !document.getElementById(STANDIN_ID).contains(real)) return { el: real, how: 'real' };
    const stand = document.querySelector('#' + STANDIN_ID + ' ' + t.sel);
    return stand ? { el: stand, how: 'stand-in' } : { el: null, how: 'absent' };
  }

  function snap(tag) {
    ensureTargets();
    const rows = {};
    for (const t of TARGETS) {
      const r = resolve(t);
      rows[t.name] = r.el
        ? { how: r.how, value: String(getComputedStyle(r.el).getPropertyValue(t.prop)).trim() }
        : { how: 'absent', value: null };
    }
    const g = document.documentElement;
    const row = {
      tag: tag,
      theme: g.getAttribute('data-theme') || '(light)',
      targets: rows,
      gates: Array.from(g.attributes).map(a => a.name)
        .filter(n => n.indexOf('data-nts') === 0).sort(),
      injectedText: (function () { const s = document.getElementById('nts-dynamic'); return s ? s.textContent.slice(0, 220) : null; })()
    };
    out.steps.push(row);
    return row;
  }

  async function csrf() {
    const r = await fetch(PLUGIN + '/security/csrf-token', { credentials: 'omit' });
    const j = await r.json();
    return j.csrf_token || (j.data && j.data.csrf_token);
  }
  async function callEntry(entryId, args) {
    const tok = await csrf();
    const r = await fetch(PLUGIN + '/runs', {
      method: 'POST', credentials: 'omit',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': tok },
      body: JSON.stringify({ plugin_id: PID, entry_id: entryId, args: args || {} })
    });
    if (!r.ok) throw new Error('POST /runs ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    const id = j.run_id || j.id;
    let st = null;
    for (let i = 0; i < 60; i++) {
      await sleep(400);
      st = await (await fetch(PLUGIN + '/runs/' + id, { credentials: 'omit' })).json();
      if (st.status === 'succeeded') break;
      if (['failed', 'canceled', 'timeout'].indexOf(st.status) >= 0) {
        throw new Error(entryId + ' -> ' + st.status + ' ' + JSON.stringify(st.error || {}).slice(0, 300));
      }
    }
    const ex = await (await fetch(PLUGIN + '/runs/' + id + '/export', { credentials: 'omit' })).json();
    const items = ex.items || [];
    const item = items.filter(x => x.type === 'json' && x.json)[0] || items[0];
    let raw = item && (item.json || item.data || item);
    while (raw && typeof raw === 'object' && raw.data && (('success' in raw) || ('error' in raw))) raw = raw.data;
    return raw;
  }

  /* the loader also listens for focus / visibilitychange, so we need not wait out its poll */
  async function settle() {
    for (let i = 0; i < 4; i++) { try { window.dispatchEvent(new Event('focus')); } catch (e) {} await sleep(400); }
  }
  /* stronger: wait until the injected style matches what we expect for this mode */
  async function settleUntil(mode, varName) {
    for (let i = 0; i < 30; i++) {
      const s = document.getElementById('nts-dynamic');
      const txt = s ? s.textContent : '';
      const hasVar = txt.indexOf(varName) >= 0;
      const isDarkScope = txt.indexOf(':root[data-theme="dark"]') >= 0;
      if (mode === 'empty') { if (!txt) return true; }
      else if (hasVar && (mode === 'dark' ? isDarkScope : txt.indexOf(':root:not([data-theme="dark"])') >= 0)) return true;
      await sleep(300);
    }
    return false;
  }
  async function settleEmpty() {
    for (let i = 0; i < 30; i++) {
      const s = document.getElementById('nts-dynamic');
      if (!s || !s.textContent) return true;
      await sleep(300);
    }
    return false;
  }
  function setTheme(isDark) {
    const de = document.documentElement;
    if (isDark) { de.setAttribute('data-theme', 'dark'); de.classList.add('dark'); }
    else { de.removeAttribute('data-theme'); de.classList.remove('dark'); }
  }

  async function round(isDark) {
    const label = isDark ? 'dark' : 'light';
    setTheme(isDark);
    await sleep(250);

    /* A. baseline: palette is empty in BOTH groups */
    await callEntry('reset_theme', {});
    out['settled_empty_' + label] = await settleEmpty();
    const A = snap(label + ' A: empty palette');

    /* B. set the variables IN THIS MODE ONLY */
    const WANT = {};
    for (const t of TARGETS) WANT[t.v] = t.want;
    const args = isDark ? { vars: {}, dark_vars: WANT, name: 'gated-' + label, enabled: true }
                        : { vars: WANT, dark_vars: {}, name: 'gated-' + label, enabled: true };
    const setRes = await callEntry('apply_theme', args);
    out['setResult_' + label] = (setRes && setRes.rejected && setRes.rejected.length) ? setRes.rejected : 'accepted (no rejects)';
    out['settled_' + label] = await settleUntil(label, '--nts-shell-radius');
    const B = snap(label + ' B: three gated variables set (' + label + ' group only)');

    /* C. the OTHER mode must be untouched by the same palette.
     * Correct method: toggle ONLY our stylesheet while sitting in that mode and require
     * zero differences. Comparing against a baseline taken in the *current* mode would be
     * meaningless -- these targets legitimately have different native values per mode
     * (#text-input-area is rgba(255,255,255,0.5) in light and rgba(40,40,40,0.65) in dark).
     * An inert sheet is exactly "toggling it changes nothing". */
    setTheme(!isDark);
    await sleep(350);
    const sheetEl = () => document.querySelector('link[href*="neko-theme-studio.css"]');
    function withSheet(on) { const s = sheetEl(); if (s) s.disabled = !on; }
    withSheet(false); await sleep(250);
    const OTHER_OFF = snap(label + ' C1: other mode, sheet OFF');
    withSheet(true); await sleep(250);
    const OTHER_ON = snap(label + ' C2: other mode, sheet ON');
    withSheet(true);
    const otherDiffs = TARGETS.filter(t => OTHER_ON.targets[t.name].value !== OTHER_OFF.targets[t.name].value)
      .map(t => t.name + ':' + OTHER_OFF.targets[t.name].value + '->' + OTHER_ON.targets[t.name].value);

    /* D. clear */
    setTheme(isDark);
    await sleep(200);
    await callEntry('reset_theme', {});
    await settleEmpty();
    const C = snap(label + ' D: palette cleared');

    const c = {};
    for (const t of TARGETS) {
      c[label + '_' + t.name + '_moved_when_set'] = B.targets[t.name].value !== A.targets[t.name].value;
      c[label + '_' + t.name + '_is_requested'] = B.targets[t.name].value === t.want;
      c[label + '_' + t.name + '_restored_when_cleared'] = C.targets[t.name].value === A.targets[t.name].value;
      c[label + '_' + t.name + '_measurable'] = B.targets[t.name].how !== 'absent';
    }
    /* the other mode must be inert: toggling our sheet there must change nothing */
    out['otherModeDiffs_' + label] = otherDiffs;
    for (const t of TARGETS) c[label + '_' + t.name + '_otherModeUntouched'] = otherDiffs.length === 0;
    const prefix = 'data-nts-' + (isDark ? 'd-' : 'l-');
    c[label + '_gates_set'] = TARGETS.every(t => B.gates.indexOf(prefix + suffix(t.v)) >= 0);
    c[label + '_gates_cleared'] = TARGETS.every(t => C.gates.indexOf(prefix + suffix(t.v)) < 0);
    /* the other group's attribute must never be set by a single-mode palette */
    const otherPrefix = 'data-nts-' + (isDark ? 'l-' : 'd-');
    c[label + '_otherGroupGatesAbsent'] = TARGETS.every(t => B.gates.indexOf(otherPrefix + suffix(t.v)) < 0);
    setTheme(isDark);
    await sleep(200);
    return c;
  }

  try {
    if (!/\belectron-chat-window\b/.test(document.body.className)) {
      out.errors.push('body lacks .electron-chat-window -- not the real app page');
    }
    out.bodyClass = String(document.body.className);
    const light = await round(false);
    const dark = await round(true);
    out.checks = Object.assign({}, light, dark);
    const bad = Object.keys(out.checks).filter(k => !out.checks[k]);
    out.failing = bad;
    out.ok = bad.length === 0;
    out.verdict = out.ok ? 'PASS' : 'FAIL';
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
    out.verdict = 'ERROR';
  }
  const s = document.getElementById(STANDIN_ID); if (s) s.remove();
  setTheme(true);
  return out;
})()
