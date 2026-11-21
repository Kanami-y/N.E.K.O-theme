/* 外部改动感知的纯函数自测（v0.4.14）
 *
 * 从 plugin/static/app.js 抠出 paletteSignature / externalSyncDecision 两个纯函数，
 * 在 Node 里验证「什么时候该自动跟随、什么时候必须让路」。这段逻辑一旦写错，
 * 后果是「面板悄悄把用户没提交的改动覆盖掉」或「外部换主题后板面永远显示旧值」，
 * 两者用户都极难自己发现，所以必须锁住。
 *
 * 跑：node test/sync-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = fs.readFileSync(path.join(ROOT, 'plugin/static/app.js'), 'utf8');

var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra === undefined ? '' : '  [' + extra + ']')); }
}
function eq(name, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, name, 'actual=' + a + ' expected=' + e);
}

/* v0.5.0：签名从「updated_at + 键数」换成按内容算的 FNV-1a，所以要把
 * hashText 一起抠出来（paletteSignature 依赖它）。 */
var startAt = SRC.indexOf('function hashText(');
var endAt = SRC.indexOf('function externalSyncBlockers(');
if (startAt < 0 || endAt < 0 || endAt <= startAt) throw new Error('找不到外部同步纯函数段');
var BLOCK = SRC.slice(startAt, endAt);

var api = new Function(BLOCK +
  '\nreturn { paletteSignature: paletteSignature, hashText: hashText, externalSyncDecision: externalSyncDecision };')();

/* ---------------- 1. 签名 ---------------- */
console.log('[1] paletteSignature：按内容算（手改变量值也必须感知到）');
eq('缺参数返回空串', api.paletteSignature(null), '');
eq('非对象返回空串', api.paletteSignature('x'), '');
ok('空对象也是合法签名（8 位十六进制）', /^[0-9a-f]{8}$/.test(api.paletteSignature({})),
  'actual=' + api.paletteSignature({}));
ok('同样的内容 → 同样的签名（稳定，不受对象创建顺序影响）',
  api.paletteSignature({ vars: { a: '1', b: '2' }, dark_vars: { c: '3' } }) ===
  api.paletteSignature({ dark_vars: { c: '3' }, vars: { a: '1', b: '2' } }), '键序无关');
ok('值变了（时间戳不变）→ 签名必须变（旧实现这里是漏的）',
  api.paletteSignature({ updated_at: 'T1', vars: { a: '1' } }) !==
  api.paletteSignature({ updated_at: 'T1', vars: { a: '9' } }), '这就是 P1-6 的核心');
ok('键数变了 → 签名变',
  api.paletteSignature({ vars: { a: '1' } }) !== api.paletteSignature({ vars: { a: '1', b: '2' } }),
  '键数变化');
ok('暗色表变了 → 签名变',
  api.paletteSignature({ dark_vars: { a: '1' } }) !== api.paletteSignature({ dark_vars: { a: '2' } }),
  'dark_vars 参与');
ok('主题名变了 → 签名变',
  api.paletteSignature({ name: 'A' }) !== api.paletteSignature({ name: 'B' }), 'name 参与');
ok('enabled 变了 → 签名变',
  api.paletteSignature({ enabled: true }) !== api.paletteSignature({ enabled: false }), 'enabled 参与');
ok('只有 updated_at 变了 → 签名不变（文档化边界：内容是唯一依据）',
  api.paletteSignature({ updated_at: 'T1', vars: { a: '1' } }) ===
  api.paletteSignature({ updated_at: 'T2', vars: { a: '1' } }), '时间戳不参与');
ok('vars 非对象不抛',
  /^[0-9a-f]{8}$/.test(api.paletteSignature({ vars: null, dark_vars: 'x' })), '容错');
ok('hashText 自身稳定',
  api.hashText('hello') === api.hashText('hello') && api.hashText('hello') !== api.hashText('hellp'),
  'FNV-1a');

/* ---------------- 2. 决策 ---------------- */
console.log('[2] externalSyncDecision：该跟还是该让路');
eq('空签名不跟随', api.externalSyncDecision('', { lastSignature: 'X' }), { apply: false, reason: 'empty' });
eq('签名没变不跟随',
  api.externalSyncDecision('S1', { lastSignature: 'S1' }), { apply: false, reason: 'same' });
eq('变干净了 → 跟随',
  api.externalSyncDecision('S2', { lastSignature: 'S1', busy: false, dirty: 0, modalOpen: false }),
  { apply: true, reason: 'ok' });
eq('有未提交改动 → 不跟随（dirty 优先）',
  api.externalSyncDecision('S2', { lastSignature: 'S1', dirty: 3 }),
  { apply: false, reason: 'dirty' });
eq('正在忙 → 不跟随',
  api.externalSyncDecision('S2', { lastSignature: 'S1', busy: true }),
  { apply: false, reason: 'busy' });
eq('弹窗开着 → 不跟随',
  api.externalSyncDecision('S2', { lastSignature: 'S1', modalOpen: true }),
  { apply: false, reason: 'modal' });
eq('第一次检查（lastSignature 为空）→ 跟随',
  api.externalSyncDecision('S1', {}), { apply: true, reason: 'ok' });
eq('无 state 参数也不抛',
  api.externalSyncDecision('S1'), { apply: true, reason: 'ok' });
eq('dirty 与 busy 同时成立时报 busy（更靠前的判断赢）',
  api.externalSyncDecision('S2', { lastSignature: 'S1', busy: true, dirty: 5 }),
  { apply: false, reason: 'busy' });
eq('dirty=0 明确不算脏',
  api.externalSyncDecision('S2', { lastSignature: 'S1', dirty: 0 }), { apply: true, reason: 'ok' });

/* ---------------- 3. 接线结构 ---------------- */
console.log('[3] app.js 接线');
ok(SRC.indexOf('setInterval(function ()') >= 0, '用了 setInterval');
ok(SRC.indexOf('EXTERNAL_SYNC_INTERVAL_MS') >= 0, '轮询间隔是常量');
var intervalMatch = SRC.match(/var EXTERNAL_SYNC_INTERVAL_MS = (\d+);/);
ok(!!intervalMatch && Number(intervalMatch[1]) >= 1000 && Number(intervalMatch[1]) <= 15000,
  '轮询间隔在 1~15 秒（太密烧 CPU，太疏感知慢）', intervalMatch && intervalMatch[1]);
ok(SRC.indexOf("fetchWithTimeout('theme.json?_=' + Date.now()") >= 0,
  '直接 GET 静态 theme.json（不走 /runs，无插件调用开销）');
ok(/fetchWithTimeout\('theme\.json\?_=' \+ Date\.now\(\)[^(]*\{ cache: 'no-store'/.test(SRC),
  '轮询带 no-store 绕过缓存');
ok(SRC.indexOf('document.visibilityState === \'hidden\'') >= 0, '后台标签页不轮询');
ok(SRC.indexOf("document.addEventListener('visibilitychange'") >= 0, '切回前台立刻补查一次');
ok(SRC.indexOf('setTimeout(startExternalSync, EXTERNAL_SYNC_START_DELAY_MS)') >= 0,
  'bootstrap 延迟启动，避免和首屏请求抢');
ok(SRC.indexOf('externalSyncState.lastSignature = paletteSignature(palette);') >= 0,
  'reloadPalette 成功后就刷新基线签名（否则会把自己刚读的当成外部改动）');
ok(SRC.indexOf('externalSyncState.pending = null;') >= 0, '跟随后清 pending');
ok(SRC.indexOf("showToast('已同步外部改动：'") >= 0, '跟随时给可见反馈');
ok(SRC.indexOf('磁盘主题已变化，未自动覆盖') >= 0, '被脏改动挡住时有明确提示');
ok(SRC.indexOf('想放弃面板改动直接跟上，就点「重新读取」') >= 0, '提示里给了「怎么跟上」的出路');
ok(SRC.indexOf('for the') < 0, '无残留英文占位');
ok(SRC.indexOf('window.__ntsPanel') >= 0 && SRC.indexOf('checkExternalChange: checkExternalChange') >= 0,
  '调试钩子暴露 checkExternalChange');

/* ---------------- 4. 不覆盖用户改动 ---------------- */
console.log('[4] 绝不覆盖用户未提交的改动');
var reCheck = SRC.slice(SRC.indexOf('async function checkExternalChange()'),
  SRC.indexOf('function startExternalSync()'));
ok(reCheck.indexOf('reloadPalette({ silent: true })') >= 0, '跟随走 silent 回读');
ok(reCheck.indexOf('decision.apply') >= 0, '是否跟随一律由 externalSyncDecision 决定');
ok(reCheck.indexOf('externalSyncBlockers()') >= 0, '用实时 blockers 而不是缓存值');
ok(reCheck.indexOf('state.edited') < 0 && reCheck.indexOf('state.cleared') < 0,
  'checkExternalChange 自己不碰 edited/cleared（清脏只能由 applyTheme 的既有路径做）');
ok(SRC.indexOf('externalSyncState.failures += 1') >= 0, '失败计数（便于诊断，不打扰用户）');

console.log('');
console.log('PASS ' + pass + ' / FAIL ' + fail);
if (fail) process.exit(1);
