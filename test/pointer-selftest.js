/* 指针光效行为自测（v1.5.19）：把 loader 里的指针段抠出来在受控假环境里跑。
 *
 * 覆盖「鼠标动了却没反应」的四种成因：
 *   1. pointermove → 平滑跟随并收敛到目标位置
 *   2. 指针静止、表面因滚动移动 → scroll 捕获阶段也要重绘
 *   3. 新表面挂载后 → refreshGlassPanels 立刻按当前指针补绘
 *   4. DOM 持续变动 → MutationObserver 触发重建是「节流」而不是防抖
 *
 * 跑：node test/pointer-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC_PATH = path.join(ROOT, 'plugin/static/loader/neko-theme-studio.js');
var SRC = fs.readFileSync(SRC_PATH, 'utf8');

var pass = 0;
var fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else {
    fail++;
    console.log('  FAIL  ' + msg + (extra === undefined ? '' : '  [' + extra + ']'));
  }
}
function eq(a, b, msg) {
  ok(a === b, msg, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

/* ---------------------------------------------------- 抠出指针段 */
var START = '// -------------------- 液态玻璃：指针镜面高光 + 滚动流动';
var startAt = SRC.indexOf(START);
if (startAt < 0) throw new Error('找不到指针段起始标记');
var initAt = SRC.indexOf('function initGlassPointer()', startAt);
if (initAt < 0) throw new Error('找不到 initGlassPointer');
// 从 initGlassPointer 起做花括号配对，找到函数结尾
var brace = 0, i = SRC.indexOf('{', initAt), endAt = -1;
for (; i < SRC.length; i++) {
  var ch = SRC.charAt(i);
  if (ch === '{') brace++;
  else if (ch === '}') {
    brace--;
    if (brace === 0) { endAt = i + 1; break; }
  }
}
if (endAt < 0) throw new Error('initGlassPointer 花括号不配对');
var BLOCK = SRC.slice(startAt, endAt);
console.log('指针段：' + BLOCK.split('\n').length + ' 行 / ' + BLOCK.length + ' 字符');

/* ---------------------------------------------------- 假环境 */
function makeEl(name, rect) {
  var props = {};
  return {
    name: name,
    rect: rect,
    style: {
      props: props,
      setProperty: function (k, v) { props[k] = String(v); },
      getPropertyValue: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : ''; }
    },
    getAttribute: function () { return null; },
    getBoundingClientRect: function () { return this.rect; }
  };
}

var surfaces = [];
var handlers = [];
var rafQueue = [];
var timers = [];
var timerSeq = 0;
var scrollK = null;
var attrs = {};

var gateSet = { 'data-nts-l-glass-specular': '' };
var rootEl = {
  style: { setProperty: function (k, v) { if (k === '--nts-scroll-k') scrollK = v; } },
  setAttribute: function (k, v) { attrs[k] = v; },
  removeAttribute: function (k) { delete attrs[k]; },
  hasAttribute: function (k) { return Object.prototype.hasOwnProperty.call(gateSet, k); }
};

var fakeDocument = {
  documentElement: rootEl,
  body: {},
  hidden: false,
  addEventListener: function (type, fn, opts) {
    handlers.push({ type: type, fn: fn, capture: !!(opts && opts.capture) });
  },
  querySelectorAll: function (sel) {
    // 只关心玻璃表面选择器；其它选择器（宿主查询）返回空
    return String(sel).indexOf('.window-topbar') !== -1 ? surfaces.slice() : [];
  }
};

var fakeWindow = {
  addEventListener: function (type, fn, opts) {
    handlers.push({ type: type, fn: fn, capture: !!(opts && opts.capture) });
  },
  requestAnimationFrame: function (cb) {
    rafQueue.push(cb);
    return rafQueue.length;
  }
};

function fakeSetTimeout(cb, ms) {
  timerSeq++;
  timers.push({ id: timerSeq, cb: cb, ms: ms || 0 });
  return timerSeq;
}
function fakeClearTimeout(id) {
  timers = timers.filter(function (t) { return t.id !== id; });
}
function runTimers() {
  var due = timers.slice();
  timers = [];
  for (var t = 0; t < due.length; t++) due[t].cb();
}
function flushFrames(n) {
  for (var f = 0; f < n; f++) {
    if (!rafQueue.length) return f;
    var cb = rafQueue.shift();
    cb(16 * (f + 1));
  }
  return n;
}
function byType(type) {
  return handlers.filter(function (h) { return h.type === type; });
}
function fire(type, evt, captureOnly) {
  var list = byType(type);
  for (var h = 0; h < list.length; h++) {
    if (captureOnly !== undefined && list[h].capture !== captureOnly) continue;
    list[h].fn(evt);
  }
}

var helperSrc = "var GATE_ATTR = 'data-nts-';\nvar ensureGlassContainment = function () {};\n";
var factory = new Function(
  'document', 'window', 'setTimeout', 'clearTimeout', 'Date', 'MutationObserver',
  helperSrc + BLOCK + '\nreturn { init: initGlassPointer, refresh: refreshGlassPanels, ' +
  'paint: paintGlassSpecular, panels: function () { return glassPanels; }, ' +
  'pointer: function () { return glassPointer; }, follow: GLASS_FOLLOW, ' +
  'rebuildMs: GLASS_REBUILD_MS };'
);

var api = factory(fakeDocument, fakeWindow, fakeSetTimeout, fakeClearTimeout, Date, undefined);

/* ---------------------------------------------------- 用例 */
console.log('\n[1] 绑定：捕获阶段 + 滚动/尺寸监听');
var top = makeEl('topbar', { left: 0, top: 0, width: 200, height: 100 });
surfaces = [top];
api.init();
flushFrames(3);
var pm = byType('pointermove');
ok(pm.length >= 1, '绑定了 pointermove');
ok(pm.length && pm[0].capture === true, 'pointermove 走捕获阶段（组件 stopPropagation 也吞不掉）');
ok(byType('pointerover').length >= 1, '绑定了 pointerover（进入元素也算一次移动）');
var sc = byType('scroll');
ok(sc.length >= 1 && sc[0].capture === true, 'scroll 走捕获阶段（能接住嵌套滚动容器）');
ok(byType('resize').length >= 1, '绑定了 resize');

console.log('\n[2] 平滑跟随：首帧到位、之后逐帧靠拢、最终收敛');
ok(api.panels().length === 1, '表面列表抓到 1 个表面');
eq(top.style.props['--nts-spec-x'], undefined, '还没收到指针事件 → 不写值');
fire('pointermove', { clientX: 100, clientY: 50 });
flushFrames(1);
eq(top.style.props['--nts-spec-x'], '50.0%', '首帧：镜面 x 直接落在指针处（不从 0 滑过来）');
eq(top.style.props['--nts-spec-y'], '50.0%', '首帧：镜面 y = 50.0%');
eq(top.style.props['--nts-light-x'], '50.0%', '指针光源 x 同步');
eq(top.style.props['--nts-light-y'], '32.0%', '指针光源比镜面抬 18%（50-18=32）');
var first = top.style.props['--nts-spec-x'];
fire('pointermove', { clientX: 180, clientY: 80 });
flushFrames(1);
var second = top.style.props['--nts-spec-x'];
ok(second !== first, '指针移动后镜面位置立刻变化', first + ' → ' + second);
var mid = parseFloat(second);
ok(mid > 50 && mid < 90, '第二帧是插值中间值（平滑，不是瞬移）', mid);
flushFrames(60);
eq(top.style.props['--nts-spec-x'], '90.0%', '最终收敛到指针位置 90.0%');
eq(top.style.props['--nts-spec-y'], '80.0%', '最终收敛到 80.0%');
ok(rafQueue.length === 0, '收敛后停止跑帧（不空转耗电）');

console.log('\n[3] 指针不动、表面滚动 → 也要重绘');
top.rect = { left: 0, top: -50, width: 200, height: 100 }; // 表面上移，指针仍在 (180,80)
scrollK = null;
fire('scroll', null, true);
eq(scrollK, '1', '滚动的第一件事：--nts-scroll-k = 1（镜面收敛）');
flushFrames(60);
eq(top.style.props['--nts-spec-y'], '125.0%', '表面移动后镜面跟着重算（80-(-50)=130/100，钳到 125% 上限）');
eq(top.style.props['--nts-light-y'], '107.0%', '指针光源同样重算（125-18=107）');
runTimers();
eq(scrollK, '0', '滚动停止 160ms 后 --nts-scroll-k = 0');

console.log('\n[4] 新表面挂载 → 重建后立刻按当前指针补绘（不用再动鼠标）');
var bubble = makeEl('bubble', { left: 0, top: 0, width: 100, height: 100 });
surfaces = [top, bubble];
api.refresh();
ok(api.panels().length === 2, '重建后列表 = 2 个表面');
eq(bubble.style.props['--nts-spec-x'], undefined, '重建前新表面还没有值');
flushFrames(5);
eq(bubble.style.props['--nts-spec-x'], '125.0%', '重建后新气泡立刻拿到镜面位置（指针 180/100 → 钳到 125%）');
eq(bubble.style.props['--nts-spec-y'], '80.0%', '新气泡镜面 y = 80.0%');
eq(bubble.style.props['--nts-light-y'], '62.0%', '新气泡指针光源 = 62.0%');
ok(top.style.props['--nts-spec-x'] === '90.0%', '老表面保留自己的坐标（没有被重置）');

console.log('\n[5] DOM 持续变动 → 重建是节流，不是防抖');
var observerCb = null;
var FakeMO = function (cb) { observerCb = cb; };
FakeMO.prototype.observe = function () {};

// 重新跑一遍（需要 MutationObserver 在环境里）：用一个只含 init 的最小环境验证节流
var timers2 = [];
var seq2 = 0;
var api2 = (function () {
  var doc2 = {
    documentElement: rootEl, body: {}, hidden: false,
    addEventListener: function () {}, querySelectorAll: function () { return surfaces.slice(); }
  };
  var win2 = {
    addEventListener: function () {},
    requestAnimationFrame: function (cb) { return 1; },
    MutationObserver: FakeMO
  };
  var factory2 = new Function(
    'document', 'window', 'setTimeout', 'clearTimeout', 'Date', 'MutationObserver',
    helperSrc + BLOCK + '\nreturn { init: initGlassPointer, panels: function () { return glassPanels; }, rebuildMs: GLASS_REBUILD_MS };'
  );
  return factory2(doc2, win2, function (cb, ms) {
    seq2++;
    timers2.push({ id: seq2, cb: cb, ms: ms || 0 });
    return seq2;
  }, function () {}, Date, FakeMO);
})();
api2.init();
ok(typeof observerCb === 'function', 'MutationObserver 已注册回调');
ok(api2.rebuildMs === 220, '重建节流 220ms');
ok(typeof observerCb === 'function', 'MutationObserver 回调可用');
for (var m = 0; m < 6; m++) observerCb();
eq(timers2.length, 1, '连续 6 次 DOM 变动只排 1 个重建定时器（节流；旧版防抖会一直重置）');
ok(timers2[0].ms === 220, '定时器延迟 = 220ms');

console.log('\n[6] 版本号与暴露面');
ok(/var SCRIPT_VERSION = '\d+\.\d+\.\d+';/.test(SRC), "SCRIPT_VERSION 是 semver");
ok(SRC.indexOf('_internals') !== -1 && SRC.indexOf('refreshGlassPanels: refreshGlassPanels') !== -1,
  '_internals 暴露 refreshGlassPanels 供真机回归');
ok(SRC.indexOf('glassPointer: {') !== -1, 'diagnose() 增加 glassPointer 自检块');

console.log('\n[6] 非玻璃主题 → 指针光效整套休眠（v1.5.20）');
gateSet = {};
api.refresh();
eq(api.panels().length, 0, '没有光效门控时表面列表为空（不扫 DOM）');
var beforeSpec = bubble.style.props['--nts-spec-x'];
fire('pointermove', { clientX: 60, clientY: 20 });
flushFrames(10);
eq(bubble.style.props['--nts-spec-x'], beforeSpec, '非玻璃主题下指针移动不写 --nts-spec-x');
eq(api.pointer().seen, true, '指针事件仍被记录（seen=true，供日后切回玻璃主题用）');
gateSet = { 'data-nts-l-glass-specular': '' };
api.refresh();
eq(api.panels().length, 2, '切回玻璃主题后重建表面列表');

console.log('\n----------------------------------------');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail);
if (fail) process.exitCode = 1;
