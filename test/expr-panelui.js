/* Drive the plugin PANEL UI the way a user does -- not by calling the entries
 * over HTTP (test/accept.ps1 already covers that), but by touching the actual
 * controls the user touches:
 *
 *   1. type a colour into the "用户气泡背景" row's hex box
 *   2. click "应用"
 *   3. read the panel's own status line / notice
 *   4. confirm the value landed in theme.json on disk
 *   5. click "重置" and confirm the palette is empty again
 *
 * Runs inside the real panel document served from 48916, so the relative
 * /runs, /security/csrf-token and /plugin/... URLs resolve exactly as they do
 * for a user. This was the last link of the acceptance chain never exercised.
 *
 * Row structure (plugin/static/app.js buildRow): div.row > [label, input.swatch,
 * div.field > input.hex, div.field > alpha]. The panel is keyed by LABEL text,
 * not by data attributes, so the row is found through its label.
 */
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = { steps: [], errors: [] };
  const LABEL = '用户气泡背景';
  const WANT = '#e11d48';

  function txt(sel) {
    const e = document.querySelector(sel);
    return e ? String(e.textContent || '').trim().slice(0, 200) : null;
  }
  async function themeJson() {
    const r = await fetch('/plugin/neko_theme_studio/ui/theme.json?_=' + Date.now(), { cache: 'no-store' });
    return r.ok ? await r.json() : { error: 'HTTP ' + r.status };
  }
  function findRow() {
    const rows = Array.prototype.slice.call(document.querySelectorAll('#groups .row'));
    for (const r of rows) {
      const lbl = r.firstElementChild;
      const t = lbl ? String(lbl.textContent || '').trim() : '';
      if (t.indexOf(LABEL) === 0 || t === LABEL) return r;
    }
    return null;
  }

  function snap(tag) {
    const row = findRow();
    const hex = row ? row.querySelector('input.hex') : null;
    const swatch = row ? row.querySelector('input.swatch') : null;
    const o = {
      tag,
      status: txt('#status'),
      notice: txt('#notice'),
      /* 面板不再有版本 pill（0.1.5 起）：快照改记主题名与最后更新时间。 */
      metaName: txt('#meta-name'),
      metaUpdated: txt('#meta-updated'),
      applyLabel: txt('#btn-apply'),
      dirtyRows: document.querySelectorAll('#groups .row.is-dirty').length,
      rowFound: !!row,
      hexValue: hex ? hex.value : null,
      swatchValue: swatch ? swatch.value : null
    };
    out.steps.push(o);
    return o;
  }

  try {
    /* wait for the panel to finish its first load (it fetches theme.json and
       renders the rows) rather than sleeping a fixed time */
    for (let i = 0; i < 60; i++) {
      if (document.querySelectorAll('#groups .row').length > 0) break;
      await sleep(300);
    }
    out.rows = document.querySelectorAll('#groups .row').length;
    const A = snap('A: panel as loaded');

    const row = findRow();
    if (!row) { out.errors.push('row "' + LABEL + '" not found'); out.verdict = 'ERROR'; return out; }

    /* --- 1. type into the hex box, exactly as a user does -------------------- */
    const hex = row.querySelector('input.hex');
    if (!hex) { out.errors.push('row has no input.hex'); out.verdict = 'ERROR'; return out; }
    hex.focus();
    hex.value = WANT;
    hex.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const B = snap('B: hex box filled in');

    /* --- 2. press 应用 ------------------------------------------------------- */
    const applyBtn = document.querySelector('#btn-apply');
    if (!applyBtn) { out.errors.push('no #btn-apply'); out.verdict = 'ERROR'; return out; }
    applyBtn.click();
    for (let i = 0; i < 50; i++) {
      await sleep(400);
      const s = (txt('#status') || '') + (txt('#notice') || '');
      if (/已应用|失败|拒绝/.test(s)) break;
    }
    const C = snap('C: after clicking Apply');
    out.themeJsonAfterApply = await themeJson();

    /* --- 3. press 重置 ------------------------------------------------------- */
    const resetBtn = document.querySelector('#btn-reset');
    if (resetBtn) {
      resetBtn.click();
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        const s = (txt('#status') || '') + (txt('#notice') || '');
        if (/重置|失败|已清/.test(s)) break;
      }
    }
    const D = snap('D: after clicking Reset');
    out.themeJsonAfterReset = await themeJson();
    await sleep(1500);
    const E = snap('E: panel settled after reset');

    const vApply = (out.themeJsonAfterApply && out.themeJsonAfterApply.vars) || {};
    const vReset = (out.themeJsonAfterReset && out.themeJsonAfterReset.vars) || {};
    const got = vApply['--nts-user-bubble-bg'];

    /* The panel stores the colour through its own normaliser, so #e11d48 comes
       back as rgba(225,29,72,1). Compare on R,G,B, not on the literal. */
    function rgbOf(v) {
      if (!v) return null;
      let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
      if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(',');
      m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
      if (m) return [m[1], m[2], m[3]].join(',');
      return null;
    }
    const wantRgb = rgbOf(WANT);

    out.checks = {
      rows_rendered: out.rows > 20,
      row_found: A.rowFound,
      typed_value_accepted: B.hexValue === WANT || B.swatchValue === WANT,
      row_marked_dirty: B.dirtyRows >= 1,
      apply_label_counts_change: /项改动/.test(B.applyLabel || ''),
      apply_succeeded: /已应用|应用成功/.test((C.status || '') + (C.notice || '')),
      value_reached_theme_json: rgbOf(got) === wantRgb,
      reset_succeeded: /重置/.test((D.status || '') + (D.notice || '')),
      reset_emptied_the_palette: !vReset['--nts-user-bubble-bg'],
      no_dirty_rows_after_reset: E.dirtyRows === 0,
      swatch_neutralised_after_reset: E.swatchValue === '#000000',
      hex_box_emptied_after_reset: E.hexValue === ''
    };
    const bad = Object.keys(out.checks).filter(k => !out.checks[k]);
    out.failing = bad;
    out.ok = bad.length === 0;
    out.verdict = out.ok ? 'PASS' : 'FAIL';
    out.gotValue = got || null;
    out.wantRgb = wantRgb;
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
    out.verdict = 'ERROR';
  }
  return out;
})()
