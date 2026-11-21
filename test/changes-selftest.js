/**
 * 待应用改动清单（v0.5.1 / F1）自测 —— 把 app.js 里 CHANGES 段抠出来在假 DOM 里真跑。
 *
 * 只棚真环境（不引 jsdom）：
 *  - ``$`` 用一张 id → 假节点 的映射表；
 *  - ``el`` 与真实实现同规格：class / text / style / on* / 其它走 setAttribute；
 *  - ``state`` 是一份「已经改了三处」的假状态：改值 / 新增 / 清空各一。
 *
 * 断言分四组：
 *  1. ``changeEntryList`` 的真值表（含 draft 与已存值相同要跳过、亮暗分开、键排序）；
 *  2. ``renderChanges`` 的渲染面（卡片显隐、计数、行结构、撤销按钮接线）；
 *  3. ``revertChange`` / ``revertAllChanges`` 的副作用（清哪张表、调了谁、确认框拒绝时不动）；
 *  4. 真源码的接线（updateButtons 末尾、wireEvents、调试钩子、没有塞进 flushEditorGlobals）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(REPO, 'plugin', 'static', 'app.js'), 'utf8');

const BEGIN = '/* ===== CHANGES_BEGIN';
const END = '/* ===== CHANGES_END ===== */';
const start = APP.indexOf(BEGIN);
const end = APP.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  console.error('找不到 CHANGES 段标记（BEGIN/END）');
  process.exit(1);
}
const BLOCK = APP.slice(start, end + END.length);

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + label);
  } else {
    fail += 1;
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra));
  }
}
function eq(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, same, same ? '' : 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

/* ---------- 假 DOM ---------- */
function makeNode(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    textContent: '',
    title: '',
    hidden: false,
    attrs: {},
    children: [],
    listeners: {},
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) {
      this._html = String(value);
      if (value === '') this.children = [];
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'class') this.className = String(v);
      if (k === 'title') this.title = String(v);
      if (k === 'aria-label') this.ariaLabel = String(v);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  };
}

const DOM = {
  'changes-card': makeNode('section'),
  'changes-list': makeNode('ul'),
  'changes-count': makeNode('span')
};

function $(id) {
  return DOM[id] || null;
}

function el(tag, props, children) {
  const node = makeNode(tag);
  if (props) {
    Object.keys(props).forEach((k) => {
      const v = props[k];
      if (v === null || v === undefined) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.setAttribute('style', v);
      else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
  }
  (children || []).forEach((c) => { if (c) node.appendChild(c); });
  return node;
}

/* ---------- 被调用的外部函数（记录调用） ---------- */
const calls = { syncRow: [], toast: [], notice: [], syncAll: 0, markValid: 0, clearRgb: 0, confirm: [], renderChanges: 0 };
let confirmAnswer = true;

const CATALOG_BY_KEY = {
  '--a': { label: '主文字' },
  '--b': { label: '边框' }
};

const state = {
  palette: { vars: { '--a': '#111111', '--b': '#222222' }, dark_vars: { '--d': '#000000' } },
  edited: { light: { '--a': '#333333', '--new': '#444444' }, dark: { '--d': '#0a0a0a' } },
  cleared: { light: { '--b': true }, dark: {} }
};

function syncRow(key) { calls.syncRow.push(key); }
function showToast(msg) { calls.toast.push(msg); }
function showNotice(kind, msg) { calls.notice.push([kind, msg]); }
function syncAll() { calls.syncAll += 1; }
function markAllRowsValid() { calls.markValid += 1; }
function clearRgbMemory() { calls.clearRgb += 1; }

const api = new Function(
  'CATALOG_BY_KEY', 'state', '$', 'el', 'syncRow', 'showToast', 'showNotice',
  'syncAll', 'markAllRowsValid', 'clearRgbMemory', 'window', 'renderChangesSelf',
  BLOCK + '\nreturn { changeEntryList, pendingChangeList, changeValueText, changeKeyLabel, revertChange, revertAllChanges, renderChanges };'
)(
  CATALOG_BY_KEY, state, $, el, syncRow, showToast, showNotice,
  syncAll, markAllRowsValid, clearRgbMemory,
  { confirm(msg) { calls.confirm.push(msg); return confirmAnswer; } },
  null
);

/* ================= 1. changeEntryList 真值表 ================= */
console.log('[1] changeEntryList');
eq('没有改动 → 空清单',
  api.changeEntryList({ palette: { vars: { '--a': '#111' }, dark_vars: {} }, edited: {}, cleared: {} }),
  []);
eq('亮色改值 → changed',
  api.changeEntryList({ palette: { vars: { '--a': '#111' } }, edited: { light: { '--a': '#333' } }, cleared: {} }),
  [{ key: '--a', mode: 'light', before: '#111', after: '#333', kind: 'changed' }]);
eq('原先没有的键 → added',
  api.changeEntryList({ palette: { vars: {} }, edited: { light: { '--x': '#999' } }, cleared: {} }),
  [{ key: '--x', mode: 'light', before: '', after: '#999', kind: 'added' }]);
eq('原先有值被清空 → removed',
  api.changeEntryList({ palette: { vars: { '--b': '#222' } }, edited: {}, cleared: { light: { '--b': true } } }),
  [{ key: '--b', mode: 'light', before: '#222', after: '', kind: 'removed' }]);
eq('清空一个本来就没有的键 → 跳过',
  api.changeEntryList({ palette: { vars: {} }, edited: {}, cleared: { light: { '--z': true } } }), []);
eq('改成和已存值一样 → 跳过',
  api.changeEntryList({ palette: { vars: { '--a': '#111' } }, edited: { light: { '--a': '#111' } }, cleared: {} }), []);
eq('暗色用 dark_vars 作基线',
  api.changeEntryList({ palette: { vars: {}, dark_vars: { '--d': '#000' } }, edited: { dark: { '--d': '#0a0a0a' } }, cleared: {} }),
  [{ key: '--d', mode: 'dark', before: '#000', after: '#0a0a0a', kind: 'changed' }]);
eq('键按字典序（亮色在前）',
  api.changeEntryList({
    palette: { vars: { '--b': '1', '--a': '1' }, dark_vars: {} },
    edited: { light: { '--b': '2', '--a': '2' } }, cleared: {}
  }).map((e) => e.key),
  ['--a', '--b']);
eq('真实 state 的清单：亮色排序在前，暗色在后',
  api.pendingChangeList().map((e) => e.key + '/' + e.kind),
  ['--a/changed', '--b/removed', '--new/added', '--d/changed']);
eq('空值显示为（空）', [api.changeValueText(''), api.changeValueText('#fff')], ['（空）', '#fff']);
eq('中文名优先，取不到就显示变量名',
  [api.changeKeyLabel('--a'), api.changeKeyLabel('--unknown')], ['主文字', '--unknown']);

/* ================= 2. renderChanges 渲染面 ================= */
console.log('[2] renderChanges');
api.renderChanges();
ok('卡片显示', DOM['changes-card'].hidden === false);
eq('计数是 4', DOM['changes-count'].textContent, '4');
eq('列了 4 行', DOM['changes-list'].children.length, 4);
const row0 = DOM['changes-list'].children[0];
eq('行内 4 块：亮暗标签 / 名称 / 旧→新 / 撤销', row0.children.length, 4);
eq('行 0 名称是中文名', row0.children[1].textContent, '主文字');
eq('行 0 旧值', row0.children[2].children[0].textContent, '#111111');
eq('行 0 新值', row0.children[2].children[2].textContent, '#333333');
eq('行 1 是「清空」→ 空值文案', DOM['changes-list'].children[1].children[2].children[2].textContent, '（空）');
ok('行 1 的新值带 is-removed', DOM['changes-list'].children[1].children[2].children[2].className.indexOf('is-removed') >= 0);
ok('行 2（新增）带 is-added',
  DOM['changes-list'].children[2].children[2].children[2].className.indexOf('is-added') >= 0);
ok('行 3（暗色改值）标签是「暗色」',
  DOM['changes-list'].children[3].children[0].textContent === '暗色');
eq('撤销按钮文案', row0.children[3].textContent, '撤销');
ok('撤销按钮有 aria-label',
  String(row0.children[3].ariaLabel || '').indexOf('主文字') >= 0, row0.children[3].ariaLabel);

/* ================= 3. 撤销副作用 ================= */
console.log('[3] revertChange / revertAllChanges');
calls.syncRow.length = 0;
calls.toast.length = 0;
row0.children[3].listeners.click();
eq('点撤销 → 同步该行', calls.syncRow, ['--a']);
ok('点撤销 → 该键从 edited.light 移除', !('--a' in state.edited.light));
ok('点撤销 → toast 说明撤了哪项', calls.toast.length === 1 && calls.toast[0].indexOf('主文字') >= 0, calls.toast[0]);

confirmAnswer = false;
const beforeCount = api.pendingChangeList().length;
api.revertAllChanges();
ok('确认框拒绝 → 一条都不动', api.pendingChangeList().length === beforeCount);
ok('确认框拒绝 → 不调 syncAll', calls.syncAll === 0);

confirmAnswer = true;
calls.notice.length = 0;
api.revertAllChanges();
eq('确认 → edited/cleared 清空',
  [Object.keys(state.edited.light).length, Object.keys(state.edited.dark).length,
    Object.keys(state.cleared.light).length],
  [0, 0, 0]);
ok('确认 → 调了 syncAll', calls.syncAll === 1);
ok('确认 → 调了 markAllRowsValid / clearRgbMemory', calls.markValid === 1 && calls.clearRgb === 1);
ok('确认 → notice + toast', calls.notice.length === 1 && calls.toast.length >= 2);
ok('清空后卡片隐藏', DOM['changes-card'].hidden === true);
eq('清空后计数为空串', DOM['changes-count'].textContent, '');
eq('清空后列表也清掉', DOM['changes-list'].children.length, 0);

/* ================= 4. 真源码接线 ================= */
console.log('[4] 接线');
function bodyOf(fnName) {
  const at = APP.indexOf('function ' + fnName + '(');
  if (at < 0) return '';
  return APP.slice(at, at + 4000);
}
ok('updateButtons 末尾调 renderChanges',
  /node\.disabled = state\.busy;\s*\}\);\s*\/\/[^\n]*\n\s*renderChanges\(\);/.test(bodyOf('updateButtons')),
  '未在按钮循环之后看到 renderChanges()');
const flushAt = APP.indexOf('function flushEditorGlobals(');
const flushBody = APP.slice(flushAt, flushAt + 600);
ok('renderChanges 不在 flushEditorGlobals 里（否则假环境自测会炸）', flushBody.indexOf('renderChanges') < 0);
ok('wireEvents 接了 btn-revert-all',
  APP.indexOf("$('btn-revert-all').addEventListener('click', revertAllChanges)") >= 0);
ok('调试钩子暴露 5 个新符号',
  ['pendingChangeList: pendingChangeList', 'changeEntryList: changeEntryList',
    'renderChanges: renderChanges', 'revertChange: revertChange',
    'revertAllChanges: revertAllChanges'].every((s) => APP.indexOf(s) >= 0));
ok('空清单时不碰列表（提前 return）',
  /if \(!entries\.length\) \{[\s\S]{0,120}return;/.test(BLOCK));

console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
