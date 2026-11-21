/* 编辑区刷新合并自测（v0.4.17）
 *
 * 背景：syncRow() 以前每调用一次，末尾都要重算分组计数 / 预览 / JSON dump / 按钮
 * 状态。syncAll 遍历 95 行就是「96 遍」，逐键输入是「每敲一个字符一遍」。
 * v0.4.17 把全局刷新拆出来合并到下一帧，策略集中在 editorSyncPlan。
 *
 * 做法：把 app.js 里 EDITOR_SYNC_BEGIN…EDITOR_SYNC_END 之间的源码原样抠出来，
 * 用假 requestAnimationFrame + 计数桩求值，于是「合并」这件事是真的跑出来的，
 * 不是 grep 出来的。再补一层源码接线断言，防止有人把 oninput 改回立刻刷新。
 *
 * 运行：node test/editor-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var APP = path.join(ROOT, 'plugin', 'static', 'app.js');
var appSrc = fs.readFileSync(APP, 'utf8');

var failures = [];
var passes = 0;

function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    return;
  }
  failures.push(name + (detail === undefined ? '' : ' —— ' + detail));
}

function eq(name, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  check(name, a === e, 'actual=' + a + ' expected=' + e);
}

/* ---------- 1. 抠出 EDITOR_SYNC 区 ---------- */

var beginMark = '/* ===== EDITOR_SYNC_BEGIN ===== */';
var endMark = '/* ===== EDITOR_SYNC_END ===== */';
var beginAt = appSrc.indexOf(beginMark);
var endAt = appSrc.indexOf(endMark);
check('app.js 含 EDITOR_SYNC_BEGIN/END 标记', beginAt >= 0 && endAt > beginAt,
  'begin=' + beginAt + ' end=' + endAt);

// editorSyncState 在标记之前声明（注释块里），一并取进来
var stateAt = appSrc.indexOf('var editorSyncState = ');
check('editorSyncState 在 EDITOR_SYNC 标记之前声明', stateAt >= 0 && stateAt < beginAt,
  'stateAt=' + stateAt + ' beginAt=' + beginAt);

var coreSrc = appSrc.slice(stateAt, endAt + endMark.length);

function makeHarness() {
  var calls = { counts: 0, preview: 0, dump: 0, buttons: 0, filters: 0 };
  var frames = [];
  var stateObj = { onlyDirty: false };

  var factory = new Function(
    'requestAnimationFrame', 'setTimeout',
    'refreshCounts', 'renderPreview', 'renderDump', 'updateButtons', 'applyFilters', 'state',
    coreSrc + '\nreturn {\n' +
    '  editorSyncState: editorSyncState,\n' +
    '  editorSyncPlan: editorSyncPlan,\n' +
    '  nextFrame: nextFrame,\n' +
    '  flushEditorGlobals: flushEditorGlobals,\n' +
    '  scheduleEditorGlobals: scheduleEditorGlobals\n' +
    '};'
  );

  var api = factory(
    function (fn) { frames.push(fn); return frames.length; },
    function (fn) { frames.push(fn); return 0; },
    function () { calls.counts += 1; },
    function () { calls.preview += 1; },
    function () { calls.dump += 1; },
    function () { calls.buttons += 1; },
    function () { calls.filters += 1; },
    stateObj
  );

  return { api: api, calls: calls, frames: frames, state: stateObj };
}

/* ---------- 2. 策略函数真值表 ---------- */

var h0 = makeHarness();
eq('不带参数 → 立刻刷新', h0.api.editorSyncPlan(undefined), 'immediate');
eq('空对象 → 立刻刷新', h0.api.editorSyncPlan({}), 'immediate');
eq('{ silent: true } → 不刷新', h0.api.editorSyncPlan({ silent: true }), 'none');
eq('{ defer: true } → 合并到下一帧', h0.api.editorSyncPlan({ defer: true }), 'deferred');
eq('silent 优先于 defer', h0.api.editorSyncPlan({ silent: true, defer: true }), 'none');
eq('{ defer: false } → 立刻刷新', h0.api.editorSyncPlan({ defer: false }), 'immediate');
eq('{ keepHex: true } 不影响策略（未要求合并）', h0.api.editorSyncPlan({ keepHex: true }), 'immediate');

/* ---------- 3. flush 做什么 ---------- */

var h1 = makeHarness();
h1.api.editorSyncState.pending = true;
h1.api.flushEditorGlobals();
eq('flush 后 pending 复位', h1.api.editorSyncState.pending, false);
eq('flush 累计次数 +1', h1.api.editorSyncState.flushes, 1);
eq('flush 刷了分组计数', h1.calls.counts, 1);
eq('flush 刷了预览', h1.calls.preview, 1);
eq('flush 刷了 JSON dump', h1.calls.dump, 1);
eq('flush 刷了按钮状态', h1.calls.buttons, 1);
eq('onlyDirty 关闭时不跑 applyFilters', h1.calls.filters, 0);

var h2 = makeHarness();
h2.state.onlyDirty = true;
h2.api.flushEditorGlobals();
eq('onlyDirty 打开时 flush 会重跑过滤', h2.calls.filters, 1);

/* ---------- 4. 合并：同一帧内多次 schedule 只刷一次 ---------- */

var h3 = makeHarness();
for (var i = 0; i < 5; i += 1) h3.api.scheduleEditorGlobals();
eq('5 次 schedule 只发起 1 帧', h3.frames.length, 1);
eq('合并期间没有立刻刷新', h3.calls.dump, 0);
eq('scheduled 计数为 1', h3.api.editorSyncState.scheduled, 1);
eq('pending 为 true', h3.api.editorSyncState.pending, true);

h3.frames.shift()();
eq('帧回调后只刷了 1 次 dump', h3.calls.dump, 1);
eq('帧回调后只刷了 1 次预览', h3.calls.preview, 1);
eq('flushes 为 1', h3.api.editorSyncState.flushes, 1);
eq('刷新后 pending 复位', h3.api.editorSyncState.pending, false);

/* ---------- 5. 跨帧不串：每帧各刷一次 ---------- */

var h4 = makeHarness();
for (var round = 0; round < 3; round += 1) {
  for (var k = 0; k < 4; k += 1) h4.api.scheduleEditorGlobals();
  h4.frames.shift()();
}
eq('3 帧共 3 次刷新（不是 12 次）', h4.api.editorSyncState.flushes, 3);
eq('dump 也是 3 次', h4.calls.dump, 3);
eq('scheduled 累计 3 次', h4.api.editorSyncState.scheduled, 3);

/* ---------- 6. 退回 setTimeout ---------- */

var calls6 = { n: 0 };
var timerFns = [];
var factory6 = new Function(
  'requestAnimationFrame', 'setTimeout',
  'refreshCounts', 'renderPreview', 'renderDump', 'updateButtons', 'applyFilters', 'state',
  coreSrc + '\nreturn { nextFrame: nextFrame, editorSyncState: editorSyncState };'
);
var api6 = factory6(
  undefined,  // 没有 requestAnimationFrame
  function (fn) { timerFns.push(fn); return 0; },
  function () {}, function () {}, function () { calls6.n += 1; }, function () {},
  function () {}, { onlyDirty: false }
);
api6.nextFrame(function () {});
eq('无 rAF 时退回 setTimeout', timerFns.length, 1);

/* ---------- 7. 源码接线：这些地方必须走合并 / 静默 ---------- */

check('syncAll 逐行用 silent 同步',
  /Object\.keys\(rowsByKey\)\.forEach\(function \(key\) \{\s*\n\s*syncRow\(key, \{ silent: true \}\);\s*\n\s*\}\);/.test(appSrc));
check('syncAll 收尾只 flush 一次',
  /function syncAll\(\)[\s\S]{0,220}?flushEditorGlobals\(\);/.test(appSrc));
check('syncRow 尾部按策略分发',
  /var plan = editorSyncPlan\(opts\);[\s\S]{0,200}?plan === 'immediate'[\s\S]{0,200}?plan === 'deferred'/.test(appSrc));
check('syncRow 里不再直接连刷四件套',
  !/function syncRow\(key, opts\)[\s\S]{0,6000}?refreshCounts\(\);\s*\n\s*renderPreview\(\);\s*\n\s*renderDump\(\);\s*\n\s*updateButtons\(\);/.test(appSrc));

var hexDeferred = (appSrc.match(/syncRow\(item\.key, \{ keepHex: true, defer: true \}\);/g) || []).length;
var textDeferred = (appSrc.match(/syncRow\(item\.key, \{ keepText: true, defer: true \}\);/g) || []).length;
eq('hex 逐键输入 3 处合并', hexDeferred, 3);
eq('文本逐键输入 3 处合并', textDeferred, 3);
check('透明度的两处 syncRow 合并',
  (appSrc.match(/syncRow\(item\.key, \{ defer: true \}\);/g) || []).length >= 3);
check('取色器 input 走合并',
  /colorInput\.addEventListener\('input', function \(\) \{[\s\S]{0,400}?syncRow\(item\.key, \{ defer: true \}\);/.test(appSrc));
check('onchange 仍然是立刻刷新（定稿不能延迟）',
  /onchange: function \(\) \{[\s\S]{0,1200}?syncRow\(item\.key\);/.test(appSrc));
check('没有残留未合并的 keepHex 调用',
  appSrc.indexOf('syncRow(item.key, { keepHex: true });') === -1);
check('没有残留未合并的 keepText 调用',
  appSrc.indexOf('syncRow(item.key, { keepText: true });') === -1);
/* 调试钩子整块抠出来再断言：原来用「__ntsPanel 后 600 字符」这种固定窗口，
 * 每加一个新钩子就会把老钩子挤出窗口 —— 断言跟着版本号红，属于测试脆。 */
var hooksBlock = (function () {
  var start = appSrc.indexOf('window.__ntsPanel = window.__ntsPanel || {');
  if (start < 0) return '';
  var end = appSrc.indexOf('\n};', start);
  return end > 0 ? appSrc.slice(start, end) : appSrc.slice(start);
})();
check('调试钩子暴露 editorSyncState',
  /editorSyncState: editorSyncState,/.test(hooksBlock));
check('调试钩子暴露 flushEditorGlobals',
  /flushEditorGlobals: flushEditorGlobals,/.test(hooksBlock));

/* 其它调用点（失焦 / 清空 / 上传背景图 / 跳转）仍然是立刻刷新 */
eq('其余 syncRow 调用保持立刻刷新',
  (appSrc.match(/syncRow\(item\.key\);/g) || []).length +
  (appSrc.match(/syncRow\(row\.key\);/g) || []).length >= 8, true);

/* ---------- 8. 语法 ---------- */

var syntax = childProcess.spawnSync(process.execPath, ['--check', APP], { encoding: 'utf8' });
check('node --check app.js', syntax.status === 0, (syntax.stderr || '').trim());

/* ---------- 结果 ---------- */

if (failures.length) {
  console.error('FAIL ' + failures.length + ' / PASS ' + passes);
  failures.forEach(function (name) { console.error('  ✗ ' + name); });
  process.exit(1);
}
console.log('PASS ' + passes + ' / FAIL 0');
