/* 液态玻璃静态层（v1.5.13）fake-DOM 注入自测
 *
 * 只读工程文件、只写 test/。做法：用 vm 在假 DOM 里跑一遍加载器，
 * 然后通过对外 API NekoThemeStudio.apply() 走真实注入路径（styleEl / 去重 /
 * lastAppliedCss / setGates），把 <style id="nts-dynamic"> 的最终文本抠出来断言。
 *
 * 跑：node test/glass-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

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
function eq(a, b, msg) { ok(a === b, msg, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

/* ------------------------------------------------------------------ 假 DOM */

function Element(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.id = '';
  this.className = '';
  this.textContent = '';
  this.parentNode = null;
  this.childNodes = [];
  this.attributes = [];
  this.style = {};
  this.classList = { contains: function () { return false; }, add: function () {}, remove: function () {} };
  this.value = '';
}
Element.prototype.setAttribute = function (name, value) {
  for (var i = 0; i < this.attributes.length; i++) {
    if (this.attributes[i].name === name) { this.attributes[i].value = String(value); return; }
  }
  this.attributes.push({ name: name, value: String(value) });
};
Element.prototype.getAttribute = function (name) {
  for (var i = 0; i < this.attributes.length; i++) {
    if (this.attributes[i].name === name) return this.attributes[i].value;
  }
  return null;
};
Element.prototype.hasAttribute = function (name) { return this.getAttribute(name) !== null; };
Element.prototype.removeAttribute = function (name) {
  var out = [];
  for (var i = 0; i < this.attributes.length; i++) {
    if (this.attributes[i].name !== name) out.push(this.attributes[i]);
  }
  this.attributes = out;
};
Element.prototype.appendChild = function (child) {
  if (child.parentNode) child.parentNode.removeChild(child);
  this.childNodes.push(child);
  child.parentNode = this;
  if (child.id) DOC.byId[child.id] = child;
  return child;
};
Element.prototype.removeChild = function (child) {
  for (var i = 0; i < this.childNodes.length; i++) {
    if (this.childNodes[i] === child) { this.childNodes.splice(i, 1); break; }
  }
  child.parentNode = null;
  if (child.id && DOC.byId[child.id] === child) delete DOC.byId[child.id];
  return child;
};
Element.prototype.querySelector = function () { return null; };
Element.prototype.querySelectorAll = function () { return []; };
Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 0, height: 0 }; };

var head = new Element('head');
var body = new Element('body');
var documentElement = new Element('html');

var DOC = {
  readyState: 'complete',
  byId: {},
  head: head,
  body: body,
  documentElement: documentElement,
  styleSheets: [],
  visibilityState: 'visible',
  createElement: function (tag) { return new Element(tag); },
  getElementById: function (id) { return DOC.byId[id] || null; },
  querySelector: function () { return null; },
  querySelectorAll: function (sel) {
    if (sel === 'style#nts-dynamic') {
      var el = DOC.byId['nts-dynamic'];
      return el ? [el] : [];
    }
    return [];
  },
  addEventListener: function () {},
  removeEventListener: function () {},
  elementsFromPoint: function () { return []; }
};

function makeStorage() {
  var map = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; }
  };
}

/* 永不 resolve 的 thenable：让启动期的 fetchPalette / 自愈链停在原地，
 * 既不产生异步噪声，也不需要模拟网络。 */
var neverFetch = {
  then: function () { return neverFetch; },
  catch: function () { return neverFetch; }
};

var consoleLog = [];
var fakeConsole = {
  log: function () { consoleLog.push(Array.prototype.slice.call(arguments)); },
  info: function () {},
  warn: function () {},
  error: function () { consoleLog.push(Array.prototype.slice.call(arguments)); }
};

var storage = makeStorage();
var timerQueue = [];
function runTimers() { var due = timerQueue.slice(); timerQueue = []; for (var ti = 0; ti < due.length; ti++) due[ti](); }
var WIN = {
  location: { href: 'http://127.0.0.1:48911/index.html', origin: 'http://127.0.0.1:48911', port: '48911' },
  localStorage: storage,
  sessionStorage: makeStorage(),
  document: DOC,
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () {},
  getComputedStyle: function () {
    return {
      getPropertyValue: function () { return '1'; },
      backgroundColor: '',
      color: '',
      paddingTop: '', paddingRight: '', paddingBottom: '', paddingLeft: '',
      overflow: '', zIndex: '', position: '', opacity: '', visibility: '',
      display: '', transform: '', pointerEvents: ''
    };
  },
  MutationObserver: function () { return { observe: function () {}, disconnect: function () {} }; },
  setTimeout: function (cb) { timerQueue.push(cb); return timerQueue.length; },
  clearTimeout: function () {},
  setInterval: function () { return 2; },
  clearInterval: function () {},
  innerWidth: 1280,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
  fetch: neverFetch,
  AbortController: undefined
};

var sandbox = {
  window: WIN,
  document: DOC,
  console: fakeConsole,
  fetch: neverFetch,
  setTimeout: WIN.setTimeout,
  clearTimeout: WIN.clearTimeout,
  setInterval: WIN.setInterval,
  clearInterval: WIN.clearInterval,
  MutationObserver: WIN.MutationObserver,
  URL: URL,
  CustomEvent: function () {},
  localStorage: storage,
  sessionStorage: WIN.sessionStorage,
  Date: Date
};

console.log('加载器：' + path.relative(ROOT, SRC_PATH));

/* 执行加载器（会同步跑一遍 boot：restoreFromCache / fetchPalette / 自检快照） */
vm.runInNewContext(SRC, sandbox, { filename: 'neko-theme-studio.js' });

var NTS = WIN.NekoThemeStudio;
ok(!!NTS, '加载器挂出了 window.NekoThemeStudio');

/* ------------------------------------------------------- 玻璃调色板（真实形态） */

var GLASS_PALETTE = {
  schema: 1,
  name: '玻璃自测',
  updated_at: 'selftest-glass',
  vars: {
    '--nts-glass-tint': 'rgba(240, 250, 255, 0.18)',
    '--nts-glass-highlight': 'rgba(255, 255, 255, 0.80)',
    '--nts-glass-rim': 'rgba(170, 235, 225, 0.50)',
    '--nts-glass-sheen': '0.55',
    '--nts-glass-noise': '18%',
    '--nts-glass-lens': '0.7',
    '--nts-glass-thickness': '80%',
    '--nts-glass-specular': '0.75'
  },
  dark_vars: {
    '--nts-glass-rim': 'rgba(150, 200, 255, 0.45)',
    '--nts-glass-sheen': '0.5',
    '--nts-glass-noise': '0.14',
    '--nts-glass-lens': '0.6',
    '--nts-glass-thickness': '0.7',
    '--nts-glass-specular': '0.6'
  }
};

function styleNode() { return DOC.byId['nts-dynamic'] || null; }
function styleText() { var el = styleNode(); return el ? (el.textContent || '') : ''; }
function count(search) {
  var text = styleText();
  var n = 0;
  var at = 0;
  while ((at = text.indexOf(search, at)) !== -1) { n++; at += search.length; }
  return n;
}
function gateNames() {
  var out = [];
  for (var i = 0; i < documentElement.attributes.length; i++) {
    var n = documentElement.attributes[i].name;
    if (n === 'data-nts-fade') continue; // 过渡标记不是调色板门控
    out.push(n);
  }
  return out;
}
function hasGate(name) { return gateNames().indexOf(name) !== -1; }
function hasAttrRaw(name) {
  for (var i = 0; i < documentElement.attributes.length; i++) {
    if (documentElement.attributes[i].name === name) return true;
  }
  return false;
}

console.log('\n[1] 注入一次（真实 applyPalette 路径）');
ok(/^\d+\.\d+\.\d+$/.test(String(NTS.scriptVersion)), 'SCRIPT_VERSION 是 semver（当前 ' + NTS.scriptVersion + '）');
eq(NTS.apply(GLASS_PALETTE), true, 'apply() 返回 true');
var text = styleText();
ok(!!styleNode(), '存在 <style id="nts-dynamic">');
eq(DOC.querySelectorAll('style#nts-dynamic').length, 1, '样式节点唯一');
eq(count('--nts-glass-rim:rgba(170, 235, 225, 0.50)'), 1, '亮色 --nts-glass-rim 被接受并写入');
eq(count('--nts-glass-sheen:0.55'), 1, '亮色 --nts-glass-sheen 被接受（number）');
eq(count('--nts-glass-noise:0.18'), 1, '亮色 --nts-glass-noise 百分比归一成 0.18');
eq(count('--nts-glass-lens:0.7'), 1, '亮色 --nts-glass-lens 被接受（number）');
eq(count('--nts-glass-thickness:0.8'), 1, '亮色 --nts-glass-thickness 百分比归一成 0.8');
eq(count('--nts-glass-specular:0.75'), 1, '亮色 --nts-glass-specular 被接受（number）');
eq(count('--nts-glass-rim:rgba(150, 200, 255, 0.45)'), 1, '暗色 --nts-glass-rim 被接受');
ok(text.indexOf('data-nts-l-glass-rim\'') === -1, '样式文本里没有 data-nts 赋值（门控只由 JS 打到 documentElement）');

console.log('\n[2] 门控属性（setGates 自动为新变量生成）');
var gates = gateNames();
ok(gates.indexOf('data-nts-active') !== -1, 'data-nts-active 已打上');
['rim', 'sheen', 'noise', 'lens', 'thickness', 'specular'].forEach(function (v) {
  ok(gates.indexOf('data-nts-l-glass-' + v) !== -1, 'data-nts-l-glass-' + v);
  ok(gates.indexOf('data-nts-d-glass-' + v) !== -1, 'data-nts-d-glass-' + v);
});

console.log('\n[3] GLASS_CSS 结构与只注入一次');
eq(count('@keyframes nts-glass-sheen'), 1, '@keyframes nts-glass-sheen 只出现 1 次（GLASS_CSS 只拼一次）');
eq(count('@media (prefers-reduced-motion: reduce)'), 2,
  '减少动态媒体查询 2 次（玻璃层 1 + 材质层 1，两层各自独立门控）');
ok(count('data-nts-fade') >= 20, '切换过渡规则已注入（data-nts-fade 出现 ≥20 次）', count('data-nts-fade'));
ok(count('transition: background-color .28s ease') === 1, '过渡属性写入了功能层', count('transition: background-color .28s ease'));
ok(count('transition: none !important') === 1, '减少动态偏好里关掉过渡（transition: none）', count('transition: none !important'));
eq(count('animation: var(--nts-anim-sheen, none), var(--nts-anim-caustic, none) !important;'), 4,
  '四个光效变量各生成一条规则（每条覆盖 7 个表面），动画由 --nts-anim-* 变量控制挂不挂');
eq(count('--nts-anim-sheen: nts-glass-sheen 7.5s ease-in-out infinite !important;'), 1,
  '扫光动画只在配置 sheen 时挂一次');
eq(count('--nts-anim-caustic: nts-glass-caustic 13s ease-in-out infinite !important;'), 1,
  '焦散动画只在配置 caustic 时挂一次（13s，与 7.5s 掠光不同步）');
eq(count('animation: none !important;'), 2, '减少动态：animation:none 规则 2 条（玻璃 + 材质）');
ok(count(':root:root:root:root body') >= 100, '抬 specificity 的玻璃选择器 ≥100 条', count(':root:root:root:root body'));
eq(count(':root[data-nts-active] body '), 6, '减少动态选择器 6 条（光效层只在 6 个有包含块的表面）');
ok(text.indexOf('0% { background-position: 0 0, 50% 50%, 0 0, 120% 0; }') !== -1,
  '扫光关键帧起点：掠光 120% 0，其余三层不动');
ok(text.indexOf('60%, 100% { background-position: 0 0, 50% 50%, 0 0, -40% 0; }') !== -1,
  '扫光关键帧 60%：掠光收在 -40% 0，镜面/光源/焦散不动');
ok(text.indexOf('50% { background-size: 100% 100%, 300% 260%, 100% 100%, 220% 100%; }') !== -1,
  '焦散关键帧 50%：第二层胀到 300% 260%');

function balanced(text, open, close) {
  var n = 0;
  for (var i = 0; i < text.length; i++) {
    if (text.charAt(i) === open) n++;
    else if (text.charAt(i) === close) { n--; if (n < 0) return false; }
  }
  return n === 0;
}
ok(balanced(text, '{', '}'), '花括号配对');
ok(balanced(text, '(', ')'), '圆括号配对');

console.log('\n[4] data URI（%23、无裸 #）');
var uris = text.match(/url\("data:image\/svg\+xml;utf8,[^"]*"\)/g) || [];
eq(uris.length, 5, 'noise data URI 出现 5 次（只留在 5 个 ::before 雾面规则里）');
var uriClean = true;
var uriReason = '';
for (var u = 0; u < uris.length; u++) {
  if (uris[u].indexOf('#') !== -1) { uriClean = false; uriReason = '含裸 #'; }
  if (uris[u].indexOf('feTurbulence') === -1) { uriClean = false; uriReason = '缺 feTurbulence'; }
  if (uris[u].indexOf('url(%23n)') === -1) { uriClean = false; uriReason = '缺 %23n'; }
}
ok(uriClean, 'data URI 内无裸 #，含 feTurbulence 与 url(%23n)', uriReason);

console.log('\n[5] 边缘 + 厚度 + 透镜（box-shadow 组合，不抢 outline）');
ok(text.indexOf('inset 0 1px 0 var(--nts-glass-rim, rgba(255, 255, 255, 0.55))') !== -1,
  '上缘 1px 高光用 --nts-glass-rim');
ok(text.indexOf('inset 0 -1px 0 rgba(0, 0, 0, calc(var(--nts-glass-thickness, 0) * 0.34))') !== -1,
  '下缘 1px 暗边绑 --nts-glass-thickness');
ok(text.indexOf('inset 0 0 0 1px rgba(255, 255, 255, calc(var(--nts-glass-lens, 0) * 0.50))') !== -1,
  '透镜亮环绑 --nts-glass-lens');
ok(text.indexOf('var(--nts-shadow, 0 0 0 0 rgba(0, 0, 0, 0)) !important;') !== -1,
  '气泡组保住 var(--nts-shadow) 主题投影');
ok(text.indexOf('outline: 1px solid var(--nts-glass-rim, rgba(255, 255, 255, 0.55)) !important;') !== -1,
  'C 组（2 个无冲突表面）保留 outline 写法');
ok(text.indexOf('outline-offset: -1px !important;') !== -1, 'outline-offset: -1px');
ok(text.indexOf('outline: 2px solid rgba(64, 197, 241, 0.62) !important;') !== -1, '焦点兜底 outline 规则存在');
ok(text.indexOf('.composer-input-shell:focus-within') !== -1, '焦点兜底覆盖 .composer-input-shell:focus-within');
ok(text.indexOf('.compact-export-history-bubble:focus-visible') !== -1, '焦点兜底覆盖 .compact-export-history-bubble:focus-visible');

console.log('\n[6] 镜面 + 掠光 + 雾面，伪元素层');
ok(/body \.message-bubble-user::before \{\ncontent: "" !important;/.test(text), '.message-bubble-user::before = noise 层');
ok(/body \.message-bubble-user::after,/.test(text) || extraHas('.message-bubble-user::after'), '.message-bubble-user::after = 四层光效层');
ok(text.indexOf('radial-gradient(120% 90% at var(--nts-spec-x, 28%) var(--nts-spec-y, 14%)') !== -1,
  '镜面高光是跟随 --nts-spec-x/y 的径向渐变');
ok(text.indexOf('calc(var(--nts-glass-specular, 0) * (1 - 0.45 * var(--nts-scroll-k, 0)))') !== -1,
  '镜面强度随滚动收敛（--nts-scroll-k）');
ok(text.indexOf('background-image: var(--nts-fx-amb, none), var(--nts-fx-caustic, none), var(--nts-fx-spec, none), var(--nts-fx-sheen, none) !important;') !== -1,
  '四层光效槽位：ambient → caustic → specular → sheen');
ok(text.indexOf('background-blend-mode: screen, screen, screen, screen !important;') !== -1,
  '四层全部 screen 混合');
ok(text.indexOf('background-size: 100% 100%, 240% 240%, 100% 100%, 220% 100% !important;') !== -1,
  '四层 size 各自正确');
ok(text.indexOf('background-position: 0 0, 50% 50%, 0 0, 120% 0 !important;') !== -1,
  '四层 position 各自正确');
ok(text.indexOf('--nts-glass-sheen, 0) * 0.55)') !== -1, '扫光强度写进 rgba alpha（--nts-glass-sheen）');
ok(text.indexOf('opacity: var(--nts-glass-noise, 0) !important;') !== -1, '雾面 opacity 绑 --nts-glass-noise');
ok(text.indexOf('mix-blend-mode: overlay !important;') !== -1, '雾面 mix-blend-mode: overlay');
ok(text.indexOf('background-size: 120px 120px !important;') !== -1, '雾面 120px 平铺');
ok(text.indexOf('position: absolute !important;') !== -1 && text.indexOf('inset: 0 !important;') !== -1, '绝对定位铺满');
ok(text.indexOf('pointer-events: none !important;') !== -1, 'pointer-events: none');
ok(text.indexOf('border-radius: inherit !important;') !== -1, 'border-radius: inherit');

console.log('\n[6a] 0.4.0 光效引擎：分光 / 指针光源 / 焦散 / 暂停');
ok(text.indexOf('inset 1px 1px 0 rgba(255, 196, 128, calc(var(--nts-glass-dispersion, 0) * 0.55))') !== -1,
  '边缘分光：左上暖色 1px 细线绑 --nts-glass-dispersion');
ok(text.indexOf('inset -1px -1px 0 rgba(140, 205, 255, calc(var(--nts-glass-dispersion, 0) * 0.50))') !== -1,
  '边缘分光：右下冷色 1px 细线绑 --nts-glass-dispersion');
ok(text.indexOf('var(--nts-light-x, 50%) var(--nts-light-y, 0%)') !== -1,
  '指针光源位置跟随 --nts-light-x/y（比镜面抬一点）');
ok(text.indexOf('calc(var(--nts-ambient-glow, 0) * 0.22)') !== -1, '环境光 alpha 绑 --nts-ambient-glow');
ok(text.indexOf('--nts-fx-caustic:') !== -1, '焦散层背景变量存在');
eq(count(':root[data-nts-paused]'), 12, '暂停动画选择器 12 条（6 表面 ::after + 5 雾面 ::before + 1 面板装饰层）');
eq(count('animation-play-state: paused !important;'), 1, '暂停动作用 animation-play-state 一次关掉');

ok(text.indexOf('.compact-export-history-scroll') === -1,
  '回归 0.4.3：历史消息浮层（按预留槽位定高、无圆角）不再出现在 GLASS_CSS 里');
ok(text.indexOf('.compact-chat-surface-frame::') !== -1 ||
   text.indexOf('compact-chat-surface-frame') !== -1,
  '面板级光效宿主已改为紧凑态真实面板 .compact-chat-surface-frame');

console.log('\n[6b] 「液」：按压形变');
ok(text.indexOf('transform: scale(0.965) !important;') !== -1, '.composer-icon-button 按压压扁 0.965');
ok(text.indexOf('transform: scale(0.985) !important;') !== -1, '.composer-overflow-popover 按压压扁 0.985');

console.log('\n[7] 定位补丁（只给 static 表面补 relative）');
var relAt = text.indexOf('position: relative !important;');
var relBlock = relAt === -1 ? '' : text.slice(Math.max(0, relAt - 2000), relAt);
ok(relAt !== -1, '存在 position:relative 规则块');
ok(relBlock.indexOf('body .composer-input-shell') !== -1, '.composer-input-shell 补 position:relative');
ok(relBlock.indexOf('body .message-bubble-user') !== -1, '.message-bubble-user 补 position:relative');
ok(relBlock.indexOf('body .message-bubble-assistant') !== -1, '.message-bubble-assistant 补 position:relative');
ok(text.indexOf('body .compact-export-history-scroll {\nposition: relative') === -1,
  '.compact-export-history-scroll 不加 relative（避免改变 ::before 磨砂层锚点）');
ok(text.indexOf('body .window-topbar {\nposition: relative') === -1, '.window-topbar 本就 relative，不重复写');

console.log('\n[7b] 九个目标覆盖 & 双槽占用者跳过伪元素');
var TARGETS = ['.window-topbar', '.composer-input-shell', '.compact-chat-surface-frame',
  '.composer-icon-button', '.composer-overflow-popover', '.message-bubble-user',
  '.message-bubble-assistant', '.compact-export-history-bubble'];
var missing = [];
for (var ti = 0; ti < TARGETS.length; ti++) {
  if (text.indexOf('body ' + TARGETS[ti]) === -1) missing.push(TARGETS[ti]);
}
ok(missing.length === 0, '八个光效目标选择器都出现在玻璃规则里（历史浮层已移出）', missing.join(','));
ok(count('.compact-chat-surface-frame::after') === 1 && text.indexOf('body .compact-chat-surface-frame::after { content') === -1,
  '.compact-chat-surface-frame 双槽被占 → GLASS_CSS 不给它挂装饰伪元素（只出现在暂停块）');
ok(text.indexOf('.composer-icon-button::') === -1, '.composer-icon-button 双槽被占 → 跳过伪元素');

fs.writeFileSync(path.join(__dirname, 'glass_css_dump.css'), styleText(), 'utf8');
console.log('  已导出注入后的完整 CSS → test/glass_css_dump.css（' + styleText().length + ' 字符）');

console.log('\n[8] 幂等 / 重建 / 关闭');
var firstText = text;
NTS.apply(GLASS_PALETTE);
eq(styleText(), firstText, '同一调色板再 apply：样式文本逐字不变');
eq(DOC.querySelectorAll('style#nts-dynamic').length, 1, '再 apply：样式节点仍唯一');
eq(count('@keyframes nts-glass-sheen'), 1, '再 apply：GLASS_CSS 仍未重复');
eq(NTS.diagnose().styleApplied, true, 'diagnose().styleApplied === true（styleIntact 没被破坏）');

// 模拟宿主重渲染删掉 style 节点 → 下一次 apply 必须重建且只重建一次
var removed = styleNode();
head.removeChild(removed);
eq(styleNode(), null, '模拟宿主删节点后 getElementById 为空');
NTS.apply(GLASS_PALETTE);
eq(DOC.querySelectorAll('style#nts-dynamic').length, 1, '节点丢失后 apply 重建，且仍唯一');
eq(count('@keyframes nts-glass-sheen'), 1, '重建后 GLASS_CSS 仍只出现 1 次');

// 非玻璃调色板：静态层不门控，不得产生任何 glass 门控属性
NTS.apply({ schema: 1, name: '普通主题', vars: { '--nts-chat-bg': '#ffffff' } });
var plainGates = gateNames();
var plainGlass = false;
for (var pg = 0; pg < plainGates.length; pg++) {
  if (plainGates[pg].indexOf('glass') !== -1) plainGlass = true;
}
ok(!plainGlass, '非玻璃调色板不上 glass 门控（静态层零效果）');
ok(count('@keyframes nts-glass-sheen') === 1, '非玻璃调色板时 GLASS_CSS 仍在但门控关闭（无副作用）');

// 关闭主题：样式节点与门控一起清掉
NTS.apply({ enabled: false });
eq(styleNode(), null, 'enabled:false 后 <style> 被移除');
eq(gateNames().length, 0, 'enabled:false 后门控属性清空');

/* ------------------------------------------------------------------ 汇总 */

console.log('\n[7] 主题切换过渡（v1.5.20）');
eq(hasAttrRaw('data-nts-fade'), false, '首次应用不打过渡标记');
NTS.apply({ schema: 1, name: '过渡基线', updated_at: 'fade-base',
  vars: { '--nts-glass-rim': 'rgba(255, 255, 255, 0.40)' } });
eq(hasAttrRaw('data-nts-fade'), false, '关闭后再开启的首次应用不闪（没有可比较的旧版本）');
var OTHER = { schema: 1, name: '换一套', updated_at: 'selftest-other',
  vars: { '--nts-glass-rim': 'rgba(255, 220, 170, 0.55)', '--nts-glass-specular': '0.4' },
  dark_vars: { '--nts-glass-rim': 'rgba(255, 200, 140, 0.5)' } };
NTS.apply(OTHER);
eq(hasAttrRaw('data-nts-fade'), true, '换主题后给根节点打上 data-nts-fade');
runTimers();
eq(hasAttrRaw('data-nts-fade'), false, '420ms 后过渡标记自动移除');
NTS.apply(OTHER);
eq(hasAttrRaw('data-nts-fade'), false, '内容未变（版本戳相同）不闪');
NTS.apply({ enabled: false });
eq(hasAttrRaw('data-nts-fade'), false, '关闭主题后不残留过渡标记');

console.log('\n[9] 高级材质层（v1.6.0）');
var MT_PALETTE = {
  schema: 1, name: '材质自测', updated_at: 'selftest-mt',
  vars: {}, dark_vars: {},
  material_vars: {
    light: {
      '--nts-mt-opacity': '0.55',
      '--nts-mt-bg': 'rgba(10, 20, 30, 0.55)',
      '--nts-mt-anim': 'none'
    },
    dark: {
      '--nts-mt-opacity': '0.40',
      '--nts-mt-bg': 'rgba(5, 10, 20, 0.60)'
    }
  },
  material_attrs: {
    'data-nts-mt': '1',
    'data-nts-mt-quality': 'balanced',
    'data-nts-mt-preset': 'frosted'
  }
};
eq(NTS.apply(MT_PALETTE), true, '只有材质、没有调色板变量也能应用');
var mtText = styleText();
ok(mtText.indexOf('--nts-mt-opacity:0.55') !== -1, '亮色材质变量写入 <style>');
ok(mtText.indexOf(':root:not([data-theme="dark"]){--nts-mt-opacity:0.55') !== -1,
  '亮色材质块限定在非暗色作用域（不会渗进暗色）');
ok(mtText.indexOf(':root[data-theme="dark"]{--nts-mt-opacity:0.40') !== -1,'暗色材质块限定在暗色作用域');
ok(mtText.indexOf('--nts-mt-bg-c: var(--nts-mt-c-bg-bubble, var(--nts-mt-bg))') !== -1,
  'MATERIAL_CSS 组件变量绑定已注入');
ok(mtText.indexOf(':root[data-nts-mt]:root:root body .message-bubble-assistant') !== -1,
  'MATERIAL_CSS 基础面规则已注入');
eq(documentElement.getAttribute('data-nts-mt'), '1', '根节点打上 data-nts-mt');
eq(documentElement.getAttribute('data-nts-mt-quality'), 'balanced', '画质模式写到 data-nts-mt-quality');
eq(documentElement.getAttribute('data-nts-mt-preset'), 'frosted', '预设名写到 data-nts-mt-preset');

var MT_BAD = JSON.parse(JSON.stringify(MT_PALETTE));
MT_BAD.updated_at = 'selftest-mt-bad';
MT_BAD.material_vars.light['--nts-mt-evil'] = 'red;color:blue';
MT_BAD.material_vars.light['--nts-not-mt'] = 'red';
NTS.apply(MT_BAD);
ok(styleText().indexOf('--nts-mt-evil') === -1, '含分号的材质值被丢弃（阻断 CSS 注入）');
ok(styleText().indexOf('--nts-not-mt') === -1, '非 --nts-mt- 前缀的键被丢弃');

NTS.apply({ schema: 1, name: '材质空', updated_at: 'selftest-mt-empty', vars: {}, dark_vars: {},
  material_vars: { light: {}, dark: {} }, material_attrs: { 'data-nts-mt': '1' } });
eq(hasAttrRaw('data-nts-mt'), false, '材质变量为空时撤掉 data-nts-mt（MATERIAL_CSS 零匹配）');

NTS.apply({ enabled: false });
eq(hasAttrRaw('data-nts-mt'), false, 'enabled:false 后 data-nts-mt 被撤');
eq(hasAttrRaw('data-nts-mt-quality'), false, 'enabled:false 后 data-nts-mt-quality 被撤');
eq(hasAttrRaw('data-nts-mt-preset'), false, 'enabled:false 后 data-nts-mt-preset 被撤');
console.log('\n----------------------------------------');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail);
if (fail) process.exitCode = 1;
