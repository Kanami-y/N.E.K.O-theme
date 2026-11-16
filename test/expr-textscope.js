/* Real-page isolation of the BUBBLE TEXT colours.  [scope regression guard]
 *
 * User complaint (fixed in 0.1.4): changing the AI text colour also recoloured the user's
 * own messages, and the user text colour seemed to do nothing.
 * Root causes were scope leaks in the generated CSS:
 *   - an UNSCOPED  body .message-block-text { color: var(--nts-ai-bubble-text) }  rule, and
 *   - the user text rules sitting only on dead selectors (.message.user ...).
 * This probe freezes the bargain so the leak cannot come back:
 *   - setting --nts-ai-bubble-text moves ONLY the assistant bubble's text,
 *   - setting --nts-user-bubble-text moves the user bubble's text AND its markdown,
 *   - setting --nts-tool-bubble-text moves only the tool/system bubbles,
 *   - clearing the palette restores the exact native rendering.
 *
 * It runs on the REAL /chat page with the REAL deployed CSS + loader. The bubbles are
 * mounted off-screen in the real shape produced by neko-chat-window.es.js
 * (message-row > message-stack > message-bubble > message-block-*), so the app's own
 * CSS and our !important rules both participate in the cascade.
 */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { steps: [], errors: [] };
  const PID = 'neko_theme_studio';
  const PLUGIN = 'http://127.0.0.1:48916';
  const FIX = '__nts_textscope';
  const ROLES = ['user', 'assistant', 'tool', 'system'];
  const COLORS = {
    ai:   { v: '--nts-ai-bubble-text',   rgb: 'rgb(1, 2, 3)' },
    user: { v: '--nts-user-bubble-text', rgb: 'rgb(4, 5, 6)' },
    tool: { v: '--nts-tool-bubble-text', rgb: 'rgb(7, 8, 9)' }
  };
  /* panel text / base font size: same family of scope leaks as the bubble colours. */
  const PANELV = '--nts-panel-text';
  const FONTV  = '--nts-font-size';
  const PANEL_RGB = 'rgb(11, 22, 33)';
  const FONT_SIZE = '21px';

  function fixtureHtml() {
    let h = '';
    for (const r of ROLES) {
      h += '<article class="message-row message-row-' + r + '">' +
           '<div class="avatar avatar-' + r + '"></div>' +
           '<div class="message-stack"><div class="message-bubble message-bubble-' + r + '">' +
           '<div class="message-block message-block-text"><span class="ts-text">plain ' + r + '</span></div>' +
           '<div class="message-block message-block-markdown" data-render-mode="markdown">' +
           '<p class="ts-md">markdown ' + r + '</p></div>' +
           '</div></div></article>';
    }
    return '<div class="message-list">' + h + '</div>';
  }
  function ensureFixture() {
    if (document.getElementById(FIX)) return;
    const box = document.createElement('div');
    box.id = FIX;
    /* off-screen but rendered: display:none would zero the computed colour */
    box.style.cssText = 'position:absolute;left:-4000px;top:0;width:900px;';
    box.innerHTML = fixtureHtml();
    document.body.appendChild(box);
  }
  function normColor(v) {
    const el = document.createElement('div');
    el.style.color = v;
    if (!el.style.color) return null;
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  }
  const EXPECT = {};
  for (const k of Object.keys(COLORS)) EXPECT[k] = normColor(COLORS[k].rgb);
  EXPECT.panel = normColor(PANEL_RGB);

  function snap(tag) {
    ensureFixture();
    const rows = {};
    for (const r of ROLES) {
      const bubble = document.querySelector('#' + FIX + ' .message-bubble-' + r);
      const t = document.querySelector('#' + FIX + ' .message-bubble-' + r + ' .ts-text');
      const m = document.querySelector('#' + FIX + ' .message-bubble-' + r + ' .ts-md');
      rows[r] = {
        measurable: !!(bubble && t && m),
        text: t ? String(getComputedStyle(t).color).trim() : null,
        md: m ? String(getComputedStyle(m).color).trim() : null,
        textSize: t ? String(getComputedStyle(t).fontSize).trim() : null,
        mdSize: m ? String(getComputedStyle(m).fontSize).trim() : null
      };
    }
    /* The compact capsule lives INSIDE .composer-panel. .composer-panel used to carry
     * color: var(--nts-panel-text), so the capsule text inherited the panel text colour.
     * Freeze the native capsule colours so that leak cannot come back. */
    const cap = document.querySelector('.compact-chat-capsule-text');
    const shell = document.querySelector('.compact-chat-surface-shell');
    const capsule = {
      measurable: !!(cap || shell),
      text: cap ? String(getComputedStyle(cap).color).trim() : null,
      shell: shell ? String(getComputedStyle(shell).color).trim() : null
    };
    const g = document.documentElement;
    const row = {
      tag: tag,
      capsule: capsule,
      theme: g.getAttribute('data-theme') || '(light)',
      rows: rows,
      gates: Array.from(g.attributes).map(a => a.name)
        .filter(n => n.indexOf('data-nts') === 0).sort(),
      injected: (function () { const s = document.getElementById('nts-dynamic'); return s ? s.textContent.slice(0, 200) : null; })()
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

  function setTheme(isDark) {
    const de = document.documentElement;
    if (isDark) { de.setAttribute('data-theme', 'dark'); de.classList.add('dark'); }
    else { de.removeAttribute('data-theme'); de.classList.remove('dark'); }
  }
  /* wait until the loader has applied the palette for THIS mode: the injected <style>
   * carries the variable and the per-variable gate attribute is on <html>. */
  async function settleFor(isDark, suffix) {
    const prefix = 'data-nts-' + (isDark ? 'd-' : 'l-') + suffix;
    for (let i = 0; i < 40; i++) {
      const de = document.documentElement;
      const s = document.getElementById('nts-dynamic');
      const txt = s ? s.textContent : '';
      const scopeOk = isDark ? txt.indexOf(':root[data-theme="dark"]') >= 0
                             : txt.indexOf(':root:not([data-theme="dark"])') >= 0;
      if (txt.indexOf('--nts-' + suffix) >= 0 && de.hasAttribute(prefix) && scopeOk) return true;
      try { window.dispatchEvent(new Event('focus')); } catch (e) {}
      await sleep(300);
    }
    return false;
  }
  async function settleEmpty() {
    for (let i = 0; i < 40; i++) {
      const s = document.getElementById('nts-dynamic');
      if (!s || !s.textContent) return true;
      try { window.dispatchEvent(new Event('focus')); } catch (e) {}
      await sleep(300);
    }
    return false;
  }

  const eq = (a, b) => !!a && !!b && a === b;
  const unchanged = (rowB, rowA, role) => eq(rowB.rows[role].text, rowA.rows[role].text) && eq(rowB.rows[role].md, rowA.rows[role].md);
  const touched = (row, role, key) => eq(row.rows[role].text, EXPECT[key]) && eq(row.rows[role].md, EXPECT[key]);

  async function round(isDark) {
    const label = isDark ? 'dark' : 'light';
    setTheme(isDark);
    await sleep(250);
    const c = {};

    /* A. baseline */
    await callEntry('reset_theme', {});
    c[label + '_settled_empty'] = await settleEmpty();
    await sleep(400);
    const A = snap(label + ' A: empty palette');

    /* B. only the AI text colour */
    const bArgs = isDark ? { vars: {}, dark_vars: { [COLORS.ai.v]: COLORS.ai.rgb }, name: 'scope-ai-' + label, enabled: true }
                         : { vars: { [COLORS.ai.v]: COLORS.ai.rgb }, dark_vars: {}, name: 'scope-ai-' + label, enabled: true };
    out['applied_' + label + '_ai'] = (await callEntry('apply_theme', bArgs) || {}).rejected || 'accepted';
    c[label + '_ai_settled'] = await settleFor(isDark, 'ai-bubble-text');
    await sleep(450);
    const B = snap(label + ' B: only --nts-ai-bubble-text set');

    c[label + '_ai_text_is_requested']   = touched(B, 'assistant', 'ai');
    c[label + '_ai_does_not_touch_user'] = unchanged(B, A, 'user');
    c[label + '_ai_does_not_touch_tool'] = unchanged(B, A, 'tool') && unchanged(B, A, 'system');

    /* C. only the USER text colour -- this is the setting that used to do nothing */
    const cArgs = isDark ? { vars: {}, dark_vars: { [COLORS.user.v]: COLORS.user.rgb }, name: 'scope-user-' + label, enabled: true }
                         : { vars: { [COLORS.user.v]: COLORS.user.rgb }, dark_vars: {}, name: 'scope-user-' + label, enabled: true };
    out['applied_' + label + '_user'] = (await callEntry('apply_theme', cArgs) || {}).rejected || 'accepted';
    c[label + '_user_settled'] = await settleFor(isDark, 'user-bubble-text');
    await sleep(450);
    const C = snap(label + ' C: only --nts-user-bubble-text set');

    c[label + '_user_plain_text_applies'] = eq(C.rows.user.text, EXPECT.user);
    c[label + '_user_markdown_applies']   = eq(C.rows.user.md, EXPECT.user);
    c[label + '_user_does_not_touch_ai']  = unchanged(C, B, 'assistant');

    /* D. only the TOOL text colour */
    const dArgs = isDark ? { vars: {}, dark_vars: { [COLORS.tool.v]: COLORS.tool.rgb }, name: 'scope-tool-' + label, enabled: true }
                         : { vars: { [COLORS.tool.v]: COLORS.tool.rgb }, dark_vars: {}, name: 'scope-tool-' + label, enabled: true };
    out['applied_' + label + '_tool'] = (await callEntry('apply_theme', dArgs) || {}).rejected || 'accepted';
    c[label + '_tool_settled'] = await settleFor(isDark, 'tool-bubble-text');
    await sleep(450);
    const D = snap(label + ' D: only --nts-tool-bubble-text set');

    c[label + '_tool_text_applies']       = touched(D, 'tool', 'tool');
    c[label + '_system_text_follows_tool'] = touched(D, 'system', 'tool');
    c[label + '_tool_does_not_touch_user'] = unchanged(D, C, 'user');

    /* E. panel text colour -- must NOT reach the compact capsule sitting inside
     *    .composer-panel (that was the second leak of the same family). */
    const eArgs = isDark ? { vars: {}, dark_vars: { [PANELV]: PANEL_RGB }, name: 'scope-panel-' + label, enabled: true }
                         : { vars: { [PANELV]: PANEL_RGB }, dark_vars: {}, name: 'scope-panel-' + label, enabled: true };
    out['applied_' + label + '_panel'] = (await callEntry('apply_theme', eArgs) || {}).rejected || 'accepted';
    c[label + '_panel_settled'] = await settleFor(isDark, 'panel-text');
    await sleep(600);
    const F = snap(label + ' E: only --nts-panel-text set');
    c[label + '_panel_keeps_capsule_text'] = (function () {
      if (!F.capsule.measurable) return true; /* compact mode only; nothing to leak into */
      return eq(F.capsule.text, A.capsule.text) && eq(F.capsule.shell, A.capsule.shell);
    })();
    out['capsule_' + label] = { base: A.capsule, panel: F.capsule };

    /* F. base font size -- must scale BOTH rendering paths (plain text and markdown),
     *    otherwise "font size" silently ignores every message without markdown. */
    const fArgs = isDark ? { vars: {}, dark_vars: { [FONTV]: FONT_SIZE }, name: 'scope-font-' + label, enabled: true }
                         : { vars: { [FONTV]: FONT_SIZE }, dark_vars: {}, name: 'scope-font-' + label, enabled: true };
    out['applied_' + label + '_font'] = (await callEntry('apply_theme', fArgs) || {}).rejected || 'accepted';
    c[label + '_font_settled'] = await settleFor(isDark, 'font-size');
    await sleep(600);
    const G = snap(label + ' F: only --nts-font-size set');
    c[label + '_font_applies_to_plain_text'] = ROLES.every(r => eq(G.rows[r].textSize, FONT_SIZE));
    c[label + '_font_applies_to_markdown']   = ROLES.every(r => eq(G.rows[r].mdSize, FONT_SIZE));
    c[label + '_font_leaves_panel_alone']    = eq(G.capsule.text, F.capsule.text);

    /* G. clear */
    await callEntry('reset_theme', {});
    c[label + '_settled_empty_end'] = await settleEmpty();
    await sleep(400);
    const E = snap(label + ' E: palette cleared');
    c[label + '_clear_restores_user'] = unchanged(E, A, 'user');
    c[label + '_clear_restores_ai']   = unchanged(E, A, 'assistant');
    c[label + '_fixture_measurable']  = ROLES.every(r => C.rows[r].measurable);
    setTheme(false);
    await sleep(200);
    return c;
  }

  try {
    if (!/\belectron-chat-window\b/.test(document.body.className)) {
      out.errors.push('body lacks .electron-chat-window -- not the real app page');
    }
    out.bodyClass = String(document.body.className);
    out.expected = EXPECT;
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
  const f = document.getElementById(FIX); if (f) f.remove();
  return out;
})()
