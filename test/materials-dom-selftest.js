#!/usr/bin/env node
/* materials-dom-selftest.js -- 在迷你 DOM 里真的把 materials.js 跑起来。
 *
 * 为什么需要它：静态断言能证明「源码里写了 10 个 tab」，但证明不了「跑起来不白屏」。
 * 面板是宿主 iframe 里的纯 ES5 脚本，没有构建步骤，一个 DOM API 用错就是整块空白。
 * 这里用 ~160 行最小 DOM 桩把脚本跑一遍，然后按真实渲染结果断言：
 *
 *   1. 外壳挂载成功（#materials-root 里有 .mt-shell）—— 任何未捕获异常都会让它为空；
 *   2. 10 个导航全部渲染；
 *   3. 8 个参数界面累计 90 行（= materials.py 的参数总数），逐页对上；
 *   4. 预览真的把后端返回的变量写进容器（--nts-mt-* + data-nts-mt 属性）；
 *   5. 预设 7 张、组件 10 张，点预设会变脏，重置回基线。
 *
 *    node test/materials-dom-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
var pass = 0;
var fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

/* ---------------- 最小 DOM ---------------- */

function El(tag) {
  this.tagName = String(tag || 'div').toUpperCase();
  this.children = [];
  this.attributes = {};
  this.style = { props: {}, setProperty: function (k, v) { this.props[k] = String(v); }, removeProperty: function (k) { delete this.props[k]; }, getPropertyValue: function (k) { return this.props[k] || ''; } };
  this.value = '';
  this.checked = false;
  this.disabled = false;
  this.children.length = 0;
  this._class = '';
  this._text = '';
  this._handlers = {};
  this.parentNode = null;
}
El.prototype.appendChild = function (child) {
  if (child === null || child === undefined) return child;
  if (child.tagName && child.tagName === 'TEXTNODE') this._text += child.data;
  this.children.push(child);
  child.parentNode = this;
  return child;
};
El.prototype.removeChild = function (child) {
  var at = this.children.indexOf(child);
  if (at >= 0) this.children.splice(at, 1);
  return child;
};
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    var out = this._text;
    for (var i = 0; i < this.children.length; i += 1) out += textOf(this.children[i]);
    return out;
  },
  set: function (value) { this.children = []; this._text = String(value === undefined || value === null ? '' : value); }
});
/* className 必须与 attributes.class 双向同步：materials.js 的 el() 直接写 node.className，
 * 而选择器/断言读的是 attributes.class —— 不同步就会出现「页面渲染了但查不到」。 */
Object.defineProperty(El.prototype, 'className', {
  get: function () { return this._class || ''; },
  set: function (value) {
    this._class = String(value === undefined || value === null ? '' : value);
    if (this._class) this.attributes.class = this._class;
    else delete this.attributes.class;
  }
});

El.prototype.setAttribute = function (key, value) {
  this.attributes[key] = String(value);
  if (key === 'class') this.className = this.attributes[key];
  if (key === 'value') this.value = this.attributes[key];
};
El.prototype.getAttribute = function (key) {
  return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
};
El.prototype.removeAttribute = function (key) {
  delete this.attributes[key];
  if (key === 'class') this._class = '';
};
El.prototype.addEventListener = function (type, fn) {
  if (!this._handlers[type]) this._handlers[type] = [];
  this._handlers[type].push(fn);
};
El.prototype.dispatchEvent = function (type) {
  var list = this._handlers[type] || [];
  var event = { type: type, target: this, currentTarget: this };
  for (var i = 0; i < list.length; i += 1) list[i].call(this, event);
};
El.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 320, height: 240, right: 320, bottom: 240 };
};
/* classList 必须按实例绑定 this：直接挂在 prototype 上时，badge.classList.add() 里的
 * this 会指向那个共享的 classList 对象，写 this.attributes 就炸。 */
Object.defineProperty(El.prototype, 'classList', {
  get: function () {
    var self = this;
    function sync(name, add) {
      var list = String(self.className || '').split(' ').filter(function (item) {
        return item && (add || item !== name);
      });
      if (add && list.indexOf(name) < 0) list.push(name);
      self.className = list.join(' ');
      if (self.className) self.attributes.class = self.className;
      else delete self.attributes.class;
    }
    return {
      add: function (name) { sync(name, true); },
      remove: function (name) { sync(name, false); },
      contains: function (name) {
        return String(self.className || '').split(' ').indexOf(name) >= 0;
      }
    };
  }
});

function TextNode(data) { this.tagName = 'TEXTNODE'; this.data = String(data); this.children = []; }
TextNode.prototype.getAttribute = function () { return null; };
TextNode.prototype.setAttribute = function () {};
TextNode.prototype.addEventListener = function () {};

function textOf(node) {
  if (!node) return '';
  if (node.tagName === 'TEXTNODE') return node.data;
  var out = ' ' + (node._text || '');
  for (var i = 0; i < node.children.length; i += 1) out += ' ' + textOf(node.children[i]);
  return out;
}

function classListOf(node) {
  var raw = node.getAttribute('class');
  return raw ? String(raw).split(' ') : [];
}

function walk(node, visit) {
  visit(node);
  for (var i = 0; i < node.children.length; i += 1) walk(node.children[i], visit);
}

function matches(node, selector) {
  if (selector.charAt(0) === '.') return classListOf(node).indexOf(selector.slice(1)) >= 0;
  return node.tagName === selector.toUpperCase();
}

function queryAll(root, selector) {
  var out = [];
  walk(root, function (node) { if (node !== root && matches(node, selector)) out.push(node); });
  return out;
}

var documentStub = {
  readyState: 'complete',
  documentElement: null,
  createElement: function (tag) { return new El(tag); },
  createTextNode: function (text) { return new TextNode(text); },
  getElementById: function (id) {
    var found = null;
    walk(documentStub.body, function (node) { if (!found && node.getAttribute && node.getAttribute('id') === id) found = node; });
    return found;
  },
  querySelector: function () { return null; },
  querySelectorAll: function (selector) { return queryAll(documentStub.body, selector); },
  addEventListener: function () {}
};
documentStub.body = new El('body');
documentStub.documentElement = new El('html');

var root = new El('div');
root.setAttribute('id', 'materials-root');
documentStub.body.appendChild(root);

/* ---------------- 后端参数表（从 materials.py 解析） ---------------- */

var pyText = fs.readFileSync(path.join(ROOT, 'plugin/materials.py'), 'utf8');
var pyLines = pyText.split(String.fromCharCode(10));
var params = [];
var inParams = false;
pyLines.forEach(function (line) {
  var t = line.trim();
  if (t.indexOf('_RAW_PARAMS') === 0) { inParams = true; return; }
  if (!inParams) return;
  if (t === ')') { inParams = false; return; }
  if (t.indexOf('Param(') !== 0) return;
  var inner = t.slice(6, t.lastIndexOf(')'));
  var pieces = inner.split(', ');
  var key = pieces[0].replace(/"/g, '');
  var section = pieces[1].replace(/"/g, '');
  var kind = pieces[2].replace(/"/g, '');
  var rawDefault = pieces[3];
  var def;
  if (rawDefault.charAt(0) === '"') def = rawDefault.replace(/"/g, '');
  else if (rawDefault === 'True') def = true;
  else if (rawDefault === 'False') def = false;
  else def = parseFloat(rawDefault);
  // label 必须取后端的真实中文标签：桩里用 key 兜底会让「参数名显示」与「搜索」两件事一起失真。
  var labelMatch = t.match(/label="([^"]*)"/);
  var label = labelMatch ? labelMatch[1] : key;
  params.push({ key: key, section: section, kind: kind, default: def, min: 0, max: 1, choices: [], label: label, var: '--nts-mt-' + key });
});

var SECTION_IDS = ['global', 'lighting', 'refraction', 'surface', 'animation'];
var COMPONENTS = ['chat', 'bubble', 'input', 'sidebar', 'topbar', 'settings', 'dialog', 'button', 'plugin', 'menu'];

function defaultTable() {
  var out = {};
  SECTION_IDS.forEach(function (section) { out[section] = {}; });
  params.forEach(function (param) { out[param.section][param.key] = param.default; });
  return out;
}

var blank = defaultTable();
var presets = {};
['clear', 'frosted', 'liquid', 'smoke', 'soft', 'prism', 'custom'].forEach(function (id) {
  presets[id] = { label: id, params: JSON.parse(JSON.stringify(blank)) };
});

var spec = {
  version: 1,
  params: params,
  sections: SECTION_IDS.map(function (id) { return { id: id, label: id }; }),
  components: COMPONENTS.map(function (id) { return { id: id, label: id }; }),
  component_params: ['opacity', 'blur', 'radius', 'borderWidth', 'shadowStrength'],
  quality: ['saver', 'balanced', 'high', 'ultra'].map(function (id) { return { id: id, label: id }; }),
  presets: presets,
  preset_labels: { clear: 'Clear', frosted: 'Frosted' },
  easings: ['ease', 'linear', 'ease-in-out'],
  blur_levels: { low: 1, medium: 2, high: 3 },
  current: { version: 1, enabled: false, preset: 'custom', quality: 'balanced', dark: {}, components: {}, custom_presets: { '我的玻璃': JSON.parse(JSON.stringify(blank)) }, global: blank.global, lighting: blank.lighting, refraction: blank.refraction, surface: blank.surface, animation: blank.animation }
};

var previewVars = {};
params.forEach(function (param) { previewVars['--nts-mt-' + param.key] = '1'; });
// 玻璃底色 alpha 决定「实心程度」，可读性提示就靠它；默认给一个偏透的值。
var bgValue = 'rgba(255, 255, 255, 0.25)';

var windowStub = {};
windowStub.NekoPanel = {
  call: function (entry, args) {
    if (entry === 'material_spec') return Promise.resolve(spec);
    if (entry === 'preview_materials') {
      previewVars['--nts-mt-bg'] = bgValue;
      return Promise.resolve({ mode: (args && args.mode) || 'light', vars: previewVars, attrs: { 'data-nts-mt': '1', 'data-nts-mt-quality': 'balanced', 'data-nts-mt-preset': 'custom' }, warnings: [], materials: args && args.materials });
    }
    if (entry === 'delete_material_preset') {
      var after = JSON.parse(JSON.stringify(spec.current));
      after.custom_presets = {};
      after.preset = 'custom';
      return Promise.resolve({ deleted: args && args.name, names: [], materials: after });
    }
    return Promise.resolve({});
  },
  toast: function () {}
};

var sandbox = {
  window: windowStub,
  document: documentStub,
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};
vm.createContext(sandbox);
var mtSource = fs.readFileSync(path.join(ROOT, 'plugin/static/materials.js'), 'utf8');
mtSource = mtSource.split('}).catch(function (error) {').join('}).catch(function (error) { console.log("BOOT_ERR", error && error.stack);');
vm.runInContext(mtSource, sandbox, { filename: 'materials.js' });

function tabNodes() { return queryAll(root, '.mt-tab'); }
function rowsInPane() {
  var pane = documentStub.getElementById('mt-pane');
  return pane ? queryAll(pane, '.mt-row') : [];
}
function clickTab(label) {
  var tabs = tabNodes();
  for (var i = 0; i < tabs.length; i += 1) {
    if (textOf(tabs[i]).indexOf(label) >= 0) { tabs[i].dispatchEvent('click'); return true; }
  }
  return false;
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

async function main() {
  await sleep(60);


  ok('window.NekoMaterials 已挂载', !!(windowStub.NekoMaterials && windowStub.NekoMaterials.snapshot));
  ok('外壳挂载成功（#materials-root 有 .mt-shell）', queryAll(root, '.mt-shell').length === 1);
  ok('10 个导航全部渲染', tabNodes().length === 10, '实际 ' + tabNodes().length);

  var tabs = ['基础材质', '玻璃染色', '光线反射', '折射色散', '液态动态', '表面细节', '动画交互'];
  var expected = {
    '基础材质': params.filter(function (p) { return p.section === 'global' && ['opacity', 'tint', 'tintStrength', 'blur', 'blurLevel', 'saturation', 'brightness'].indexOf(p.key) >= 0; }).length + 0,
    '玻璃染色': 6,
    '光线反射': params.filter(function (p) { return p.section === 'lighting'; }).length,
    '折射色散': params.filter(function (p) { return p.section === 'refraction'; }).length - 6,
    '液态动态': 6,
    '表面细节': params.filter(function (p) { return p.section === 'surface'; }).length,
    '动画交互': params.filter(function (p) { return p.section === 'animation'; }).length
  };
  expected['基础材质'] = 7;

  var total = 0;
  for (var i = 0; i < tabs.length; i += 1) {
    ok('切到「' + tabs[i] + '」', clickTab(tabs[i]));
    await sleep(10);
    var rows = rowsInPane().length;
    total += rows;
    ok('「' + tabs[i] + '」渲染 ' + expected[tabs[i]] + ' 个参数行', rows === expected[tabs[i]], '实际 ' + rows);
    // 参数行没有名字 = 一排没有标签的滑块。源码改错一行就可能静默发生，必须逐页断言。
    var labeled = rowsInPane().filter(function (row) { return queryAll(row, '.mt-row-label').length === 1; }).length;
    ok('「' + tabs[i] + '」每行都有参数名', labeled === rows, labeled + '/' + rows);
  }
  ok('8 个参数界面累计 90 行', total === 90, '实际 ' + total);

  // 暗色玻璃底是编译侧隐式行为（0.15.36）：面板必须说清楚，否则用户以为「暗色怎么变深了」。
  ok('切回「基础材质」', clickTab('基础材质'));
  await sleep(10);
  var basePaneText = textOf(documentStub.getElementById('mt-pane'));
  ok('基础材质页有暗色玻璃说明', basePaneText.indexOf('暗色主题下玻璃底会自动压暗') >= 0);

  ok('切到「预设与画质」', clickTab('预设'));
  await sleep(10);
  // 预设卡与画质卡共用 .mt-preset 样式，所以这里分别按名称认：
  // 7 套预设（含 custom）+ 4 档画质 = 11 张。
  var cards = queryAll(root, '.mt-preset');
  ok('预设 7 张 + 我的预设 1 张 + 画质 4 张', cards.length === 12, '实际 ' + cards.length);

  // 我的预设：卡片必须包一层 .mt-preset-wrap（右上角删除按钮不能点卡片本体时误触整套套用）
  ok('自定义预设包在 .mt-preset-wrap 里', queryAll(root, '.mt-preset-wrap').length === 1, '实际 ' + queryAll(root, '.mt-preset-wrap').length);
  ok('自定义预设带删除按钮', queryAll(root, '.mt-preset-del').length === 1, '实际 ' + queryAll(root, '.mt-preset-del').length);
  ok('预设页有命名输入框', !!documentStub.getElementById('mt-preset-name'));

  var wraps = queryAll(root, '.mt-preset-wrap');
  var customCard = wraps.length ? queryAll(wraps[0], '.mt-preset')[0] : null;
  ok('自定义预设卡片可点击', !!customCard);
  if (customCard) customCard.dispatchEvent('click');
  await sleep(10);
  ok('切到自定义预设后 preset 标签为该名字', windowStub.NekoMaterials.snapshot().preset === '我的玻璃', windowStub.NekoMaterials.snapshot().preset);

  // 删除走独立 entry，且必须立即从界面消失（后端返回的 materials 里已经没有这一条）
  var delBtn = queryAll(root, '.mt-preset-del')[0];
  ok('删除按钮可点击', !!delBtn);
  if (delBtn) delBtn.dispatchEvent('click');
  await sleep(40);
  ok('删除后自定义预设卡片消失', queryAll(root, '.mt-preset-wrap').length === 0, '实际 ' + queryAll(root, '.mt-preset-wrap').length);
  ok('删除后显示「还没有自定义预设」提示', textOf(documentStub.getElementById('mt-pane')).indexOf('还没有自定义预设') >= 0);
  var presetIds = ['clear', 'frosted', 'liquid', 'smoke', 'soft', 'prism', 'custom'];
  var seen = 0;
  presetIds.forEach(function (id) {
    for (var i = 0; i < cards.length; i += 1) {
      if (textOf(cards[i]).indexOf(id) >= 0) { seen += 1; return; }
    }
  });
  ok('七套预设都能在卡上认出来', seen === 7, '实际 ' + seen);

  if (cards.length > 1) cards[1].dispatchEvent('click');
  await sleep(20);
  ok('点预设后标记为待应用', windowStub.NekoMaterials.isDirty() === true);

  ok('切到「组件材质」', clickTab('组件'));
  await sleep(10);
  ok('组件 10 张卡', queryAll(root, '.mt-comp').length === 10, '实际 ' + queryAll(root, '.mt-comp').length);

  // 组件缩略块：拖组件参数时总得有个东西动，否则又是「改了看不到」。
  var stripEl = documentStub.getElementById('mt-comp-strip');
  ok('组件页有缩略块', !!stripEl);
  ok('缩略块 10 个', !!stripEl && queryAll(stripEl, '.mt-comp-chip').length === 10,
    stripEl ? '实际 ' + queryAll(stripEl, '.mt-comp-chip').length : 'no-strip');
  ok('每个缩略块都有组件名', !!stripEl && queryAll(stripEl, '.mt-comp-chip-name').length === 10);


  await sleep(220);
  var stage = documentStub.getElementById('mt-pv');
  ok('预览容器存在', !!stage);
  ok('预览写入了材质变量', !!(stage && stage.style.getPropertyValue('--nts-mt-opacity')));
  ok('预览按后端 attrs 打了属性', !!(stage && stage.getAttribute('data-nts-mt') === '1'));
  ok('缩略块也吃同一批变量', !!(stripEl && stripEl.style.getPropertyValue('--nts-mt-opacity')),
    stripEl ? stripEl.style.getPropertyValue('--nts-mt-opacity') : 'no-strip');

  // 组件批量重置：10 张卡逐个点「继承全局」太慢，批量出口是必需品。
  var resetAll = documentStub.getElementById('mt-comp-reset-all');
  ok('组件页有「全部继承全局」按钮', !!resetAll);
  ok('没有自定义时按钮禁用', !!resetAll && resetAll.disabled === true, resetAll && resetAll.disabled);
  var barText = queryAll(root, '.mt-comp-bar-text')[0];
  ok('组件条说明当前继承状态', !!barText && textOf(barText).indexOf('全部组件跟随全局') >= 0, barText && textOf(barText));
  var compHead = queryAll(root, '.mt-comp-head')[0];
  var compModeSel = compHead ? queryAll(compHead, '.mt-select')[0] : null;
  ok('组件卡有模式选择', !!compModeSel);
  if (compModeSel) { compModeSel.value = 'custom'; compModeSel.dispatchEvent('change'); }
  await sleep(10);
  ok('自定义写进了 components', Object.keys(windowStub.NekoMaterials.snapshot().components || {}).length === 1, JSON.stringify(Object.keys(windowStub.NekoMaterials.snapshot().components || {})));
  var barText2 = queryAll(root, '.mt-comp-bar-text')[0];
  ok('组件条显示已自定义数量', !!barText2 && textOf(barText2).indexOf('已自定义 1') >= 0, barText2 && textOf(barText2));
  var resetAll2 = documentStub.getElementById('mt-comp-reset-all');
  ok('有自定义后按钮可用', !!resetAll2 && resetAll2.disabled === false, resetAll2 && resetAll2.disabled);
  if (resetAll2) resetAll2.dispatchEvent('click');
  await sleep(10);
  ok('批量重置后 components 清空', Object.keys(windowStub.NekoMaterials.snapshot().components || {}).length === 0);

  // 预览壁纸可切深浅：深壁纸检查白玻璃反光，浅壁纸检查浅色场景下还看不看得清。
  // 只给一种背景等于让用户盲猜玻璃在另一类界面上的观感。
  var bgBtn = documentStub.getElementById('mt-pv-bg');
  ok('预览有背景深浅切换按钮', !!bgBtn && textOf(bgBtn).indexOf('背景') >= 0, bgBtn && textOf(bgBtn));
  ok('初始壁纸跟随编辑模式（亮色 → 浅色壁纸）', stage.getAttribute('data-bg') === 'light', stage && stage.getAttribute('data-bg'));
  if (bgBtn) bgBtn.dispatchEvent('click');
  await sleep(10);
  ok('点按钮后壁纸切成深色', stage.getAttribute('data-bg') === 'dark', stage && stage.getAttribute('data-bg'));
  ok('按钮文案跟着变成「背景：深色」', textOf(bgBtn).indexOf('深色') >= 0, textOf(bgBtn));

  // 规范十一：预览至少覆盖 6 类组件，并且能对比「原始 vs 当前」。
  // 只画一张卡片，用户调组件材质和全局材质时都无法确认自己在改什么。
  ok('预览有玻璃卡片', queryAll(stage, '.mt-pv-chat').length >= 1, 'chat ' + queryAll(stage, '.mt-pv-chat').length);
  ok('预览有聊天气泡', queryAll(stage, '.mt-pv-msg').length >= 1, 'msg ' + queryAll(stage, '.mt-pv-msg').length);
  ok('预览有普通按钮', queryAll(stage, '.mt-pv-btn').length >= 1, 'btn ' + queryAll(stage, '.mt-pv-btn').length);
  ok('预览有输入框', queryAll(stage, '.mt-pv-input').length >= 1, 'input ' + queryAll(stage, '.mt-pv-input').length);
  ok('预览有弹窗', queryAll(stage, '.mt-pv-pop').length >= 1, 'pop ' + queryAll(stage, '.mt-pv-pop').length);
  ok('预览有侧边栏', queryAll(stage, '.mt-pv-side').length >= 1, 'side ' + queryAll(stage, '.mt-pv-side').length);
  var cmpBtn = documentStub.getElementById('mt-pv-compare');
  ok('有原始 / 当前对比按钮', !!cmpBtn && textOf(cmpBtn).indexOf('对比') >= 0, cmpBtn && textOf(cmpBtn));
  ok('默认不显示对比层', stage.getAttribute('data-compare') === '0', stage.getAttribute('data-compare'));
  if (cmpBtn) cmpBtn.dispatchEvent('click');
  await sleep(30);
  var refLayer = documentStub.getElementById('mt-pv-ref');
  ok('点对比后右半屏出现原始层', stage.getAttribute('data-compare') === '1' && !!refLayer);
  ok('原始层写了编译出来的变量', !!refLayer && Object.keys(refLayer.style.props).length > 0, refLayer && Object.keys(refLayer.style.props).length);
  if (cmpBtn) cmpBtn.dispatchEvent('click');
  await sleep(10);
  ok('再点一次收起对比', stage.getAttribute('data-compare') === '0', stage.getAttribute('data-compare'));

  // 文字可读性（验收第 9 条）：玻璃基底调太实，压在上面的字就看不清。
  // 不阻止用户，但必须说出来 —— 静默变糊等于验收条款空转。
  var warnBox = documentStub.getElementById('mt-pv-warn');
  ok('偏透的玻璃没有可读性警告', !!warnBox && warnBox.style.display === 'none', warnBox && warnBox.style.display);
  ok('切回「预设与画质」', clickTab('预设'));
  await sleep(10);
  bgValue = 'rgba(255, 255, 255, 0.9)';
  var presetCards2 = queryAll(root, '.mt-preset');
  if (presetCards2.length > 1) presetCards2[1].dispatchEvent('click');
  await sleep(320);
  warnBox = documentStub.getElementById('mt-pv-warn');
  ok('玻璃太实时提示文字可能看不清', !!warnBox && warnBox.style.display === '' && textOf(warnBox).indexOf('不透明度') >= 0, warnBox && textOf(warnBox));
  bgValue = 'rgba(255, 255, 255, 0.25)';

  windowStub.NekoMaterials.resetLocal();
  await sleep(10);
  ok('重置后不再是脏状态', windowStub.NekoMaterials.isDirty() === false);

  // 主题总开关关着时，勾着材质的「启用」也不会生效（加载器整块撤样式），
  // 面板必须说出来，否则就是静默失效。
  var snapForMaster = windowStub.NekoMaterials.snapshot();
  snapForMaster.enabled = true;
  var masterWarn = documentStub.getElementById('mt-master-warn');
  windowStub.NekoMaterials.sync({ enabled: false, materials: snapForMaster });
  await sleep(10);
  ok('总开关关闭时提示材质不会生效', !!masterWarn && masterWarn.style.display === 'block', masterWarn && masterWarn.style.display);
  windowStub.NekoMaterials.sync({ enabled: true, materials: snapForMaster });
  await sleep(10);
  ok('总开关打开后提示收起', !!masterWarn && masterWarn.style.display === 'none', masterWarn && masterWarn.style.display);

  // 暗色只存「与亮色不同」的覆盖：必须给显式清除入口。
  // 否则想让某一项回到继承亮色，只能把 34 个 number / 14 个 percent 参数手动调成一样 —— 没人做得到。
  ok('切到「基础材质」', clickTab('基础材质'));
  ok('头部有参数搜索框', !!documentStub.getElementById('mt-search'));
  var searchBox = documentStub.getElementById('mt-search');
  var totalRows = rowsInPane().length;
  searchBox.value = '色散';
  searchBox.dispatchEvent('input');
  await sleep(10);
  var hits = rowsInPane().length;
  ok('搜索命中少于全部参数', hits > 0 && hits < 90, '命中 ' + hits);
  ok('搜索有结果提示', textOf(documentStub.getElementById('mt-pane')).indexOf('找到') >= 0);
  searchBox.value = '';
  searchBox.dispatchEvent('input');
  await sleep(10);
  ok('清空搜索恢复当前界面', rowsInPane().length === totalRows);
  await sleep(10);
  var firstRange = queryAll(documentStub.getElementById('mt-pane'), '.mt-range')[0];
  ok('基础材质有可编辑滑块', !!firstRange);
  if (firstRange) {
    firstRange.value = '0.55';
    firstRange.dispatchEvent('input');
    var modeSel = documentStub.getElementById('mt-mode');
    ok('头部有亮 / 暗切换', !!modeSel);
    modeSel.value = 'dark';
    modeSel.dispatchEvent('change');
    await sleep(10);
    ok('暗色没有覆盖时不显示清除按钮', queryAll(root, '.mt-row-clear').length === 0, '实际 ' + queryAll(root, '.mt-row-clear').length);
    var darkRange = queryAll(documentStub.getElementById('mt-pane'), '.mt-range')[0];
    darkRange.value = '0.9';
    darkRange.dispatchEvent('input');
    await sleep(10);
    var clears = queryAll(root, '.mt-row-clear');
    ok('暗色改了值后出现清除按钮', clears.length === 1, '实际 ' + clears.length);
    if (clears.length) {
      clears[0].dispatchEvent('click');
      await sleep(10);
      ok('点清除后按钮消失', queryAll(root, '.mt-row-clear').length === 0, '实际 ' + queryAll(root, '.mt-row-clear').length);
      var backRange = queryAll(documentStub.getElementById('mt-pane'), '.mt-range')[0];
      ok('清除后值回到亮色', backRange && String(backRange.value) === '0.55', backRange && backRange.value);
      }
      // 批量清除：一页调过十几项暗色后，逐项点太慢。
      var darkRange2 = queryAll(documentStub.getElementById('mt-pane'), '.mt-range')[0];
      darkRange2.value = '0.8';
      darkRange2.dispatchEvent('input');
      await sleep(10);
      var darkClear = documentStub.getElementById('mt-dark-clear');
      ok('暗色有覆盖时出现批量清除按钮', !!darkClear && darkClear.style.display === '', darkClear && darkClear.style.display);
      ok('批量清除按钮显示覆盖数', !!darkClear && textOf(darkClear).indexOf('1') >= 0, darkClear && textOf(darkClear));
      if (darkClear) darkClear.dispatchEvent('click');
      await sleep(10);
      ok('批量清除后暗色为空', Object.keys(windowStub.NekoMaterials.snapshot().dark || {}).length === 0, JSON.stringify(windowStub.NekoMaterials.snapshot().dark));
      ok('批量清除后按钮隐藏', documentStub.getElementById('mt-dark-clear').style.display === 'none');
    modeSel.value = 'light';
    modeSel.dispatchEvent('change');
    await sleep(10);
  }

  // 材质随主题：头部「跟随主题」是 lock 的反面（关掉 = 锁定材质，切主题不覆盖）。
  var followBox = documentStub.getElementById('mt-follow');
  ok('头部有「跟随主题」开关', !!followBox);
  ok('跟随主题默认勾上（未锁定）', !!followBox && followBox.checked === true, followBox && String(followBox.checked));
  if (followBox) {
    followBox.checked = false;
    followBox.dispatchEvent('change');
    await sleep(10);
    ok('关掉跟随主题后材质被锁定', windowStub.NekoMaterials.snapshot().lock === true,
      JSON.stringify(windowStub.NekoMaterials.snapshot().lock));
    ok('锁定算一项待应用改动', textOf(documentStub.getElementById('mt-dirty')).indexOf('待应用') >= 0,
      textOf(documentStub.getElementById('mt-dirty')));
    followBox.checked = true;
    followBox.dispatchEvent('change');
    await sleep(10);
    ok('重新打开跟随主题后解锁', windowStub.NekoMaterials.snapshot().lock !== true,
      JSON.stringify(windowStub.NekoMaterials.snapshot().lock));
  }

  windowStub.NekoMaterials.resetLocal();
  await sleep(10);

  console.log('');  console.log('----------------------------------------');
  console.log('materials-dom-selftest: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (error) {
  console.log('  FAIL 运行时异常 -- ' + (error && error.stack ? error.stack.split(String.fromCharCode(10))[0] : error));
  console.log('materials-dom-selftest: PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
});
