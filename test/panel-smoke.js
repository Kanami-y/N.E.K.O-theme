
/**
 * 面板冒烟测试：用 jsdom 装上真实的 plugin/static/app.js + index.html，
 * 用桩 fetch 模拟插件宿主（/security/csrf-token、/runs、/runs/{id}、/runs/{id}/export），
 * 走一遍「读取 → 编辑 → 应用」的真实点击路径，断言发出去的 args 与提示文案。
 *
 * 跑法：node theme-studio/test/panel-smoke.js
 *   需要 jsdom。查找顺序：环境变量 NTS_JSDOM_PATH（jsdom 目录）→ 本仓库
 *   theme-studio\node_modules\jsdom → 标准 node_modules 解析。没有 jsdom 时
 *   打印跳过说明并以 exit 2 退出（不是失败：这是环境缺失，不是产品缺陷）。
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
  w.fetch = (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.indexOf('/security/csrf-token') !== -1) return Promise.resolve(resp({ csrf_token: 'tok-123' }));
    if (method === 'POST' && /\/runs$/.test(u)) {
      let body = {};
      try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ }
      posts.push(body);
      const entry = body.entry_id;
      if (entry === 'apply_theme') {
        const vars = Object.assign({}, palette.vars);
        Object.keys(body.args.vars || {}).forEach((k) => { if (body.args.vars[k] === '') delete vars[k]; else vars[k] = body.args.vars[k]; });
        const dark = Object.assign({}, palette.dark_vars);
        Object.keys(body.args.dark_vars || {}).forEach((k) => { if (body.args.dark_vars[k] === '') delete dark[k]; else dark[k] = body.args.dark_vars[k]; });
        palette = { schema: 1, name: body.args.name || palette.name || '默认', enabled: body.args.enabled !== false, updated_at: nextStamp(), vars, dark_vars: dark };
        w.__lastResult = { rejected: [], vars: body.args.vars };
      } else if (entry === 'reset_theme') {
        palette = { schema: 1, name: '默认', enabled: true, updated_at: nextStamp(), vars: {}, dark_vars: {} };
        w.__lastResult = palette;
      } else if (entry === 'get_theme') {
        w.__lastResult = palette;
      } else {
        w.__lastResult = {};
      }
      w.__entries = (w.__entries || []).concat([entry]);
      return Promise.resolve(resp({ run_id: 'r1' }));
    }
    if (/\/runs\/r1$/.test(u)) return Promise.resolve(resp({ status: 'succeeded' }));
    if (/\/runs\/r1\/export$/.test(u)) return Promise.resolve(resp({ items: [{ type: 'json', json: { success: true, data: w.__lastResult } }] }));
    return Promise.resolve(resp({ detail: 'not stubbed: ' + u }, 404));
  };
  w.eval(APP);
  return { w, posts, getPalette: () => palette };
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
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '   :: ' + (detail || '')));
}

(async () => {
  const empty = { schema: 1, name: '默认', enabled: true, updated_at: '2026-11-07T22:00:00', vars: {}, dark_vars: {} };
  const { w, posts } = boot(empty);

  // A 启动：get_theme 拉过一次，UI 显示调色板名与更新时间（版本计数已移除）
  const booted = await until(() => w.__entries && w.__entries.indexOf('get_theme') !== -1, 4000);
  check('A 启动后调用 get_theme', booted);
  const metaName = () => (w.document.getElementById('meta-name') || {}).textContent || '';
  const metaUpdated = () => (w.document.getElementById('meta-updated') || {}).textContent || '';
  const metaRead = () => metaName().indexOf('默认') !== -1 && metaUpdated().trim() !== '' && metaUpdated().trim() !== '—';
  await until(metaRead, 2000);
  check('A 元信息显示名称与更新时间', metaRead(), metaName() + ' / ' + metaUpdated());
  const metaBeforeApply = metaUpdated();

  // B 编辑颜色 → 应用：发出去的 args 必须含该变量
  const row = w.rowsByKey['--nts-user-bubble-bg'];
  check('B 编辑器里有 user-bubble-bg 行', !!row);
  row.hexInput.value = '#123456';
  row.hexInput.dispatchEvent(new w.Event('change'));
  check('B 应用按钮显示改动数', /1 项改动/.test(w.document.getElementById('btn-apply').textContent), w.document.getElementById('btn-apply').textContent);
  w.document.getElementById('btn-apply').click();
  const applied = await until(() => posts.some((p) => p.entry_id === 'apply_theme'), 6000);
  check('B 点击应用发出了 apply_theme', applied);
  const apply = posts.filter((p) => p.entry_id === 'apply_theme').pop() || { args: {} };
  check('B args 含 --nts-user-bubble-bg=rgba(18,52,86,1)',
    apply.args && apply.args.vars && apply.args.vars['--nts-user-bubble-bg'] === 'rgba(18,52,86,1)',
    JSON.stringify(apply.args && apply.args.vars));
  check('B args.enabled === true', apply.args && apply.args.enabled === true);
  await until(() => /已应用/.test(w.document.getElementById('notice').textContent || ''), 4000);
  check('B 提示「已应用」', /已应用/.test(w.document.getElementById('notice').textContent || ''), w.document.getElementById('notice').textContent);
  await until(() => /已应用/.test(w.document.getElementById('status').textContent || ''), 4000);
  check('B 状态条显示「已应用」', /已应用/.test(w.document.getElementById('status').textContent || ''), w.document.getElementById('status').textContent);
  // 版本计数已移除（0.1.5 起）：旧用例靠「版本 2」证明应用后回读过 theme.json，
  // 现在改看 #meta-updated 是否刷新——它由 get_theme 回读到的 updated_at 渲染。
  const restamped = await until(
    () => metaUpdated().trim() !== '' && metaUpdated().trim() !== '—' && metaUpdated() !== metaBeforeApply, 4000);
  check('B 应用后回读，更新时间已刷新', restamped, 'before=' + metaBeforeApply + ' after=' + metaUpdated());
  check('B 应用后 dump 含该颜色', /#123456|18, *52, *86|rgba\(18/.test(w.document.getElementById('dump').textContent || ''), (w.document.getElementById('dump').textContent || '').slice(0, 200));

  // C 非法负长度：面板必须标红，且应用被挡住（v0.1.4 起：红框行会阻止整次提交，
  //   旧版只标红却照样把上一个合法值提交上去，会假成功）
  const radius = w.rowsByKey['--nts-radius'];
  radius.textInput.value = '-8px';
  radius.textInput.dispatchEvent(new w.Event('input'));
  check('C 负长度被标红', radius.textInput.classList.contains('is-bad'));
  w.document.getElementById('btn-apply').click();
  await sleep(120);
  check('C 红框行阻止应用并说明原因', /不合法|红框/.test(w.document.getElementById('notice').textContent || ''), w.document.getElementById('notice').textContent);
  const applyCount = posts.filter((p) => p.entry_id === 'apply_theme').length;
  check('C 没有重复提交 apply_theme', applyCount === 1, 'count=' + applyCount);
  // 清掉红框，后面的用例才允许提交（否则每次 apply 都会被挡住）
  radius.textInput.value = '';
  radius.textInput.dispatchEvent(new w.Event('input'));
  await sleep(50);
  check('C 清空后红框消失', !radius.textInput.classList.contains('is-bad'));

  // D 百分比合法：50% 不标红；数字变量会被归一成小数（后端与 loader 同规则）
  const opacity = w.rowsByKey['--nts-chat-opacity'];
  opacity.textInput.value = '50%';
  opacity.textInput.dispatchEvent(new w.Event('input'));
  check('D 50% 不被标红', !opacity.textInput.classList.contains('is-bad'));
  w.document.getElementById('btn-apply').click();
  await until(() => posts.filter((p) => p.entry_id === 'apply_theme').length === 2, 6000);
  const apply2 = posts.filter((p) => p.entry_id === 'apply_theme').pop() || { args: {} };
  const dVal = apply2.args && apply2.args.vars && apply2.args.vars['--nts-chat-opacity'];
  check('D 50% 归一成 0.5 后提交', dVal === '0.5' || dVal === '50%', 'dVal=' + dVal + ' vars=' + JSON.stringify(apply2.args && apply2.args.vars));

  // E 999% 必须被拒（>100 无意义）
  const opacity2 = w.rowsByKey['--nts-chat-opacity'];
  opacity2.textInput.value = '999%';
  opacity2.textInput.dispatchEvent(new w.Event('input'));
  check('E 999% 被标红', opacity2.textInput.classList.contains('is-bad'));
  // 清掉红框，否则 F 的提交同样会被挡住（红框阻止整次应用是 v0.1.4 的预期行为）
  opacity2.textInput.value = '';
  opacity2.textInput.dispatchEvent(new w.Event('input'));
  await sleep(50);
  check('E 清空后红框消失', !opacity2.textInput.classList.contains('is-bad'));

  // F 4 位 hex 支持：#f008 → rgba(255,0,0,0.53)
  const hex4 = w.rowsByKey['--nts-ai-bubble-bg'];
  hex4.hexInput.value = '#f008';
  hex4.hexInput.dispatchEvent(new w.Event('change'));
  check('F #f008 被接受（alpha≈0.53）', !hex4.hexInput.classList.contains('is-bad'));
  w.document.getElementById('btn-apply').click();
  await until(() => posts.filter((p) => p.entry_id === 'apply_theme').length === 3, 6000);
  const apply3 = posts.filter((p) => p.entry_id === 'apply_theme').pop() || { args: {} };
  const v3 = apply3.args && apply3.args.vars && apply3.args.vars['--nts-ai-bubble-bg'];
  check('F #f008 → rgba(255,0,0,0.533)', v3 === 'rgba(255,0,0,0.53)' || v3 === 'rgba(255,0,0,0.533)', v3);

  w.close();
  console.log(failures ? ('\n' + failures + ' 项失败') : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
