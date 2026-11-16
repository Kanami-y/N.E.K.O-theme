/**
 * 面板 UI 行为测试：搜索过滤 / 只看改动 / 清空按钮 / 折叠 / 复制 dump。
 * 与 panel-smoke.js 同一套 jsdom 宿主桩，但只断言「面板自身的交互」，
 * 不重复验证提交协议（那部分在 panel-smoke.js 里）。
 *
 * 跑法：node theme-studio/test/panel-ui.js
 *   需要 jsdom。查找顺序：NTS_JSDOM_PATH → theme-studio\node_modules\jsdom → 默认解析；
 *   找不到时打印跳过说明并 exit 2（环境缺失，不是产品缺陷）。
 * 退出码：0=全过，1=有失败，2=缺少 jsdom。
 */
const fs = require('fs');
const path = require('path');

function loadJsdom() {
  const cands = [];
  if (process.env.NTS_JSDOM_PATH) { cands.push(process.env.NTS_JSDOM_PATH); }
  cands.push(path.resolve(__dirname, '..', 'node_modules', 'jsdom'));
  cands.push('jsdom');
  for (const c of cands) {
    try { return require(c); } catch (e) { /* try next */ }
  }
  console.error('SKIP: 找不到 jsdom（试过 NTS_JSDOM_PATH、theme-studio\\node_modules\\jsdom、默认解析）。');
  console.error('      npm install --no-save --prefix theme-studio jsdom  然后用 NTS_JSDOM_PATH 或直接重跑。');
  process.exit(2);
}
const { JSDOM } = loadJsdom();

const ROOT = path.resolve(__dirname, '..', 'plugin', 'static');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** 应用/重置后 mock 回写的 updated_at：单调递增，避免同一秒内两次 apply
 *  得到相同时间戳（面板只显示到秒，会让「时间戳已刷新」的断言假失败）。 */
let stampTick = 0;
function nextStamp() {
  stampTick += 1;
  return new Date(Date.UTC(2026, 10, 8, 0, 0, stampTick)).toISOString();
}

function resp(body, status, headers) {
  const text = JSON.stringify(body);
  const hdrs = headers || {};
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    headers: { get: (k) => hdrs[k] || hdrs[k.toLowerCase()] || null },
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    clone: () => resp(body, status, headers)
  };
}

function boot(initial) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://127.0.0.1:48916/plugin/neko_theme_studio/ui/' });
  const w = dom.window;
  w.confirm = () => true;
  let palette = JSON.parse(JSON.stringify(initial));
  const posts = [];
  const copied = [];
  Object.defineProperty(w.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } }
  });
  w.fetch = (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.indexOf('/security/csrf-token') !== -1) return Promise.resolve(resp({ csrf_token: 'tok-123' }));
    if (method === 'POST' && /\/runs$/.test(u)) {
      let body = {};
      try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ }
      posts.push(body);
      if (body.entry_id === 'apply_theme') {
        const vars = Object.assign({}, palette.vars);
        const dark = Object.assign({}, palette.dark_vars);
        Object.keys(body.args.vars || {}).forEach((k) => { if (body.args.vars[k] === '') delete vars[k]; else vars[k] = body.args.vars[k]; });
        Object.keys(body.args.dark_vars || {}).forEach((k) => { if (body.args.dark_vars[k] === '') delete dark[k]; else dark[k] = body.args.dark_vars[k]; });
        palette = { schema: 1, name: '默认', enabled: true, updated_at: nextStamp(), vars, dark_vars: dark };
        w.__lastResult = { rejected: [], vars: body.args.vars };
      } else if (body.entry_id === 'get_theme') {
        w.__lastResult = palette;
      } else {
        w.__lastResult = {};
      }
      return Promise.resolve(resp({ run_id: 'r1' }));
    }
    if (/\/runs\/r1$/.test(u)) return Promise.resolve(resp({ status: 'succeeded' }));
    if (/\/runs\/r1\/export$/.test(u)) return Promise.resolve(resp({ items: [{ type: 'json', json: { success: true, data: w.__lastResult } }] }));
    return Promise.resolve(resp({ detail: 'not stubbed: ' + u }, 404));
  };
  w.eval(APP);
  return { w, posts, copied, getPalette: () => palette };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) { if (fn()) return true; await sleep(20); }
  return false;
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   :: ' + (detail === undefined ? '' : detail)));
}

function visibleRows(w) {
  return Array.prototype.filter.call(w.document.querySelectorAll('.row-wrap'), (n) => !n.hidden);
}
function visibleSections(w) {
  return Array.prototype.filter.call(w.document.querySelectorAll('.group'), (n) => !n.hidden);
}
/** 按 CATALOG 的原始数据算出「应该命中多少行 / 多少组」，避免把期望值写死。 */
function expectedMatches(w, q) {
  const query = String(q).toLowerCase();
  let rows = 0;
  const groups = new Set();
  w.CATALOG.forEach((group) => group.items.forEach((item) => {
    const hay = (item.label + ' ' + item.key + ' ' + (item.hint || '')).toLowerCase();
    if (hay.indexOf(query) !== -1) { rows += 1; groups.add(group.group); }
  }));
  return { rows, groups: groups.size };
}

(async () => {
  const initial = {
    schema: 1, name: '默认', enabled: true, updated_at: '2026-11-07T23:00:00',
    vars: { '--nts-user-bubble-bg': '#123456' }, dark_vars: {}
  };
  const { w, posts, copied } = boot(initial);
  const $ = (id) => w.document.getElementById(id);
  // 版本计数已移除（0.1.5 起）：#meta-updated 由回读到的 updated_at 渲染，
  // 它变化 = 这一轮「提交 → 回读 → 重渲染」真的走完了，可替代旧的版本号信号。
  const metaUpdated = () => (($('meta-updated') || {}).textContent || '').trim();
  await until(() => w.__entries === undefined || true, 10);
  await until(() => { const t = (($('meta-updated') || {}).textContent || '').trim(); return t !== '' && t !== '—'; }, 4000);

  // A 初始状态：所有行可见，过滤界面元素都是「安静」的
  check('A 初始 59 行全部可见', visibleRows(w).length === 59, 'visible=' + visibleRows(w).length);
  check('A 初始 no-match 隐藏', $('no-match').hidden === true);
  check('A 初始 search-clear 隐藏', $('search-clear').hidden === true);
  check('A 初始组按钮是「全部收起」', /全部收起/.test($('btn-toggle-groups').textContent), $('btn-toggle-groups').textContent);

  // B 搜索「气泡」：只剩聊天气泡一组，命中 13 行
  const search = $('row-search');
  search.value = '气泡';
  search.dispatchEvent(new w.Event('input'));
  const rowsB = visibleRows(w);
  const secsB = visibleSections(w);
  const wantB = expectedMatches(w, '气泡');
  check('B 搜索「气泡」命中数与 CATALOG 一致', rowsB.length === wantB.rows && wantB.rows > 0,
    'visible=' + rowsB.length + ' want=' + wantB.rows);
  check('B 该命中的分组数一致', secsB.length === wantB.groups, 'sections=' + secsB.length + ' want=' + wantB.groups);
  check('B 可见分组里有聊天气泡', secsB.some((s) => /聊天气泡/.test(s.textContent.slice(0, 40))));
  check('B 搜索时 search-clear 出现', $('search-clear').hidden === false);
  const leaked = rowsB.filter((wrap) => !/气泡/.test(wrap.textContent));
  check('B 可见行都真的含关键词', leaked.length === 0, 'leaked=' + leaked.length);

  // C 搜不到：给 no-match 提示，且没有任何行/组可见
  search.value = 'zzzz-not-a-token';
  search.dispatchEvent(new w.Event('input'));
  check('C 无命中时 no-match 显示', $('no-match').hidden === false);
  check('C 无命中时 0 行可见', visibleRows(w).length === 0, 'visible=' + visibleRows(w).length);
  check('C 无命中时 0 组可见', visibleSections(w).length === 0, 'sections=' + visibleSections(w).length);

  // D 点 × 清空搜索：恢复全量
  $('search-clear').click();
  check('D 清空搜索后 59 行可见', visibleRows(w).length === 59, 'visible=' + visibleRows(w).length);
  check('D 清空搜索后 no-match 隐藏', $('no-match').hidden === true);
  check('D 清空搜索后 search-clear 隐藏', $('search-clear').hidden === true);
  check('D 清空搜索后输入框为空', $('row-search').value === '');

  // E 只看改动：改一项后只剩这一行
  const aiRow = w.rowsByKey['--nts-ai-bubble-bg'];
  check('E 存在 ai-bubble-bg 行', !!aiRow);
  aiRow.hexInput.value = '#00ff88';
  aiRow.hexInput.dispatchEvent(new w.Event('change'));
  $('only-dirty').checked = true;
  $('only-dirty').dispatchEvent(new w.Event('change'));
  const rowsE = visibleRows(w);
  check('E 只看改动时只剩 1 行', rowsE.length === 1, 'visible=' + rowsE.length);
  check('E 剩下的就是被改的那行', rowsE[0] === aiRow.container, rowsE[0] && rowsE[0].className);
  $('only-dirty').checked = false;
  $('only-dirty').dispatchEvent(new w.Event('change'));
  check('E 取消只看改动后恢复 59 行', visibleRows(w).length === 59, 'visible=' + visibleRows(w).length);

  // E2 先把刚才那项应用掉，让后面的「改动数」断言只受清空动作影响
  $('btn-apply').click();
  await until(() => posts.some((p) => p.entry_id === 'apply_theme'), 6000);
  await until(() => /已应用/.test(($('status') || {}).textContent || ''), 4000);

  // F 已保存的颜色行用清空按钮：值清空、标记「已清空」、提交空串
  const bubbleRow = w.rowsByKey['--nts-user-bubble-bg'];
  check('F 清空按钮存在（颜色行历史上没有）', !!bubbleRow.clearBtn);
  bubbleRow.clearBtn.click();
  check('F 清空后输入框为空', bubbleRow.hexInput.value === '', JSON.stringify(bubbleRow.hexInput.value));
  check('F 清空后状态标记为「已清空」', /已清空/.test(bubbleRow.stateTag.textContent), bubbleRow.stateTag.textContent);
  check('F 清空后应用按钮计 1 项改动', /1 项改动/.test($('btn-apply').textContent), $('btn-apply').textContent);
  const applyCountBefore = posts.filter((p) => p.entry_id === 'apply_theme').length;
  // 状态条此时还停在 E2 的「已应用」，等它不再是有效的完成信号，改等更新时间刷新。
  const stampBeforeF = metaUpdated();
  $('btn-apply').click();
  const applied = await until(() => posts.filter((p) => p.entry_id === 'apply_theme').length > applyCountBefore, 6000);
  check('F 清空触发了新的 apply_theme', applied);
  const apply = posts.filter((p) => p.entry_id === 'apply_theme').pop() || { args: {} };
  check('F 提交的是空串（=清除该变量）',
    apply.args && apply.args.vars && apply.args.vars['--nts-user-bubble-bg'] === '',
    JSON.stringify(apply.args && apply.args.vars));
  await until(() => metaUpdated() !== '' && metaUpdated() !== '—' && metaUpdated() !== stampBeforeF, 4000);
  check('F 清空应用后回读，更新时间已刷新',
    metaUpdated() !== '' && metaUpdated() !== '—' && metaUpdated() !== stampBeforeF,
    'before=' + stampBeforeF + ' after=' + metaUpdated());

  // G placeholder 显示原生参考值（非颜色行）
  const radius = w.rowsByKey['--nts-radius'];
  check('G radius 的 placeholder 含原生值', /^原生 /.test(radius.textInput.placeholder || ''), JSON.stringify(radius.textInput.placeholder));
  check('G radius 的 placeholder 含 px', /px/.test(radius.textInput.placeholder || ''), JSON.stringify(radius.textInput.placeholder));

  // H 分组折叠：全部收起 → 全部展开
  $('btn-toggle-groups').click();
  const collapsed = Array.prototype.every.call(w.document.querySelectorAll('.group'), (n) => n.classList.contains('is-collapsed'));
  check('H 全部收起生效', collapsed);
  check('H 按钮变成「全部展开」', /全部展开/.test($('btn-toggle-groups').textContent), $('btn-toggle-groups').textContent);
  check('H aria-expanded=false', Array.prototype.every.call(w.document.querySelectorAll('.group-head'), (n) => n.getAttribute('aria-expanded') === 'false'));
  $('btn-toggle-groups').click();
  const reopened = Array.prototype.every.call(w.document.querySelectorAll('.group'), (n) => !n.classList.contains('is-collapsed'));
  check('H 再点全部展开', reopened);

  // I 复制 dump
  $('btn-copy-dump').click();
  await until(() => copied.length > 0, 2000);
  check('I 复制 dump 调用了 clipboard', copied.length === 1, 'calls=' + copied.length);
  check('I 复制的内容是 JSON', copied[0] && copied[0].indexOf('"vars"') !== -1, String(copied[0]).slice(0, 120));
  check('I 复制后 toast 可见', $('toast').hidden === false && /复制/.test($('toast').textContent), $('toast').textContent);

  // J 弹窗焦点管理：打开聚焦文本域，取消后焦点回到触发按钮
  const importBtn = $('btn-import');
  importBtn.focus();
  importBtn.click();
  check('J 导入弹窗打开', $('modal').hidden === false);
  check('J 弹窗标题是「导入主题」', /导入主题/.test($('modal-title').textContent), $('modal-title').textContent);
  check('J 焦点落在文本域', w.document.activeElement === $('modal-text'),
    w.document.activeElement && (w.document.activeElement.id || w.document.activeElement.tagName));
  $('modal-cancel').click();
  check('J 取消后弹窗关闭', $('modal').hidden === true);
  check('J 焦点回到「导入」按钮', w.document.activeElement === importBtn,
    w.document.activeElement && (w.document.activeElement.id || w.document.activeElement.tagName));

  // K Esc 关弹窗
  importBtn.click();
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('K Esc 关闭弹窗', $('modal').hidden === true);

  console.log('');
  if (failures) {
    console.log(failures + ' 项失败');
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
})().catch((error) => {
  console.error('测试异常：', error && error.stack || error);
  process.exit(1);
});
