#!/usr/bin/env node
/* v0.10.0 批次一自测：撤销/重做、单行复制粘贴、悬停对比卡、给 AI 的提示词。
 *
 * 与其它 selftest 一致：把 app.js 里两个标记区块的源码抠出来，
 * 用 new Function 注入假 DOM / 假 state 后**真跑**，不是只 grep 字符串。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'plugin', 'static', 'app.js'), 'utf8');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  PASS ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}
function eq(label, actual, expected) {
  check(label, actual === expected, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

/* --------------- 抠源码：用完整注释标记，别把结尾的斜杠星号切掉 --------------- */
function sliceBlock(begin, end) {
  const at = APP.indexOf(begin);
  if (at < 0) throw new Error('找不到区块：' + begin);
  const stop = APP.indexOf(end, at);
  if (stop < 0) throw new Error('找不到区块结尾：' + end);
  return APP.slice(at, stop + end.length);
}
const UNDO_SRC = sliceBlock('var undoState = {', '/* ===== UNDO_END ===== */');
const BATCH_SRC = sliceBlock('var rowClipboard', '/* ===== BATCH1_END ===== */');

/* ---------------- 假环境 ---------------- */
function makeEl(tag) {
  return {
    tag: tag, children: [], attrs: {}, style: {}, textContent: '', className: '',
    hidden: false, disabled: false, title: '', value: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener() {}
  };
}

const DOM = {
  'btn-undo': makeEl('button'),
  'btn-redo': makeEl('button'),
  'pv-compare': makeEl('div'),
  'pv-compare-rows': makeEl('div'),
  'theme-name': makeEl('input')
};
DOM['pv-compare'].hidden = true;

const toasts = [];
const notices = [];
const flags = { hoverActive: false, safe: true };
const hooks = { undoPush: function () {} };
const hoverPreviewRef = { palette: null, name: '', themeId: '' };
const pendingRef = { list: [] };
let syncAllCalls = 0;
let renderChangesCalls = 0;

const CURRENT = {
  '--nts-chat-bg': '#eef3f8',
  '--nts-chat-panel-bg': '',
  '--nts-user-bubble-bg': '#44b7fe',
  '--nts-ai-bubble-bg': '#ffffff',
  '--nts-user-bubble-text': '#ffffff',
  '--nts-accent': '#2a7bc4',
  '--nts-shell-radius': '14px',
  '--nts-chat-blur': 'blur(18px)'
};
const HOVER = {
  '--nts-chat-bg': '#101820',
  '--nts-chat-panel-bg': '',
  '--nts-user-bubble-bg': '#2f7ff0',
  '--nts-ai-bubble-bg': '#1b2430',
  '--nts-user-bubble-text': '#ffffff',
  '--nts-accent': '#5aa9ff',
  '--nts-shell-radius': '22px',
  '--nts-chat-blur': 'blur(18px)'
};

const state = {
  mode: 'light',
  palette: { name: '默认', vars: { '--a': '#111111', '--b': '#222222' }, dark_vars: {} },
  edited: { light: {}, dark: {} },
  cleared: { light: {}, dark: {} },
  busy: false,
  metaName: '默认'
};

const factory = new Function(
  'state', '$', 'document', 'navigator', 'showToast', 'showNotice', 'syncAll', 'renderChanges',
  'markAllRowsValid', 'clearRgbMemory', 'displayValue', 'serverValue', 'hoverPreviewValue',
  'copyText', 'isSafeValue', 'normalizeTypedValue', 'markEdited', 'syncRow', 'el',
  'DEFAULT_THEME_NAME', 'effectiveVars', 'pendingChangeList', 'CHANGE_MODE_LABELS', 'changeKeyLabel',
  'hoverPreview', 'renderQuickPresets',
  UNDO_SRC + '\n' + BATCH_SRC + '\n' +
  'return { undoState: undoState, undoPush: undoPush, undoStep: undoStep, redoStep: redoStep, ' +
  'updateUndoButtons: updateUndoButtons, copyRowValue: copyRowValue, pasteRowValue: pasteRowValue, ' +
  'comparePairs: comparePairs, renderCompare: renderCompare, buildAiPrompt: buildAiPrompt, ' +
  'copyAiPrompt: copyAiPrompt, initUndoShortcuts: initUndoShortcuts };'
);

const api = factory(
  state,
  function (id) { return DOM[id] || null; },
  { createElement: makeEl },
  { clipboard: { readText: function () { return Promise.resolve(''); } } },
  function (text, kind) { toasts.push({ text: String(text), kind: kind || '' }); },
  function (kind, text) { notices.push({ kind: kind, text: String(text) }); },
  function () { syncAllCalls += 1; },
  function () { renderChangesCalls += 1; },
  function () {},
  function () {},
  function (key) { return Object.prototype.hasOwnProperty.call(CURRENT, key) ? CURRENT[key] : null; },
  function (key) { return Object.prototype.hasOwnProperty.call(state.palette.vars, key) ? state.palette.vars[key] : null; },
  function (key) {
    if (!flags.hoverActive) return null;
    return Object.prototype.hasOwnProperty.call(HOVER, key) ? HOVER[key] : null;
  },
  function () {},
  function (key, value) { return flags.safe && value !== 'not-a-value'; },
  function (key, value) { return String(value).trim(); },
  function (key, value) { state.edited.light[key] = value; hooks.undoPush(key); },
  function () {},
  function (tag, attrs, children) {
    const node = makeEl(tag);
    const spec = attrs || {};
    if (spec.text !== undefined) node.textContent = String(spec.text);
    if (spec.class) node.className = spec.class;
    if (spec.title) node.title = spec.title;
    if (spec.style) node.style = spec.style;
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  },
  '默认',
  function () { return { '--a': '#111111' }; },
  function () { return pendingRef.list; },
  { light: '亮色', dark: '暗色' },
  function (key) { return key; },
  hoverPreviewRef,
  function () {}
);
hooks.undoPush = api.undoPush;

/* ================= 1. 撤销 / 重做 ================= */
console.log('[1] 撤销栈');
eq('初始没有可撤销', api.undoState.past.length, 0);
api.updateUndoButtons();
eq('初始撤销按钮禁用', DOM['btn-undo'].disabled, true);

api.undoPush('--a');
state.edited.light['--a'] = '#333333';
eq('一次改动进栈', api.undoState.past.length, 1);
eq('撤销按钮变为可用', DOM['btn-undo'].disabled, false);
eq('快照是改动前的状态', api.undoState.past[0].edited.light['--a'], undefined);

api.undoPush('--a');
eq('同一行 900ms 内合并成一步', api.undoState.past.length, 1);
api.undoPush('--b');
eq('换一行就是新的一步', api.undoState.past.length, 2);

state.edited.light['--a'] = '#444444';
state.edited.light['--b'] = '#555555';
api.undoStep();
eq('撤销回到上一步快照 --a', state.edited.light['--a'], '#333333');
eq('撤销时 --b 一并回退', state.edited.light['--b'], undefined);
eq('重做栈里有一步', api.undoState.future.length, 1);
check('撤销触发重绘', syncAllCalls > 0);
check('撤销后刷新改动清单', renderChangesCalls > 0);

api.redoStep();
eq('重做恢复 --a', state.edited.light['--a'], '#444444');
eq('重做后重做栈清空', api.undoState.future.length, 0);

api.undoStep();
api.undoPush('--c');
eq('撤销后新改动清空重做栈', api.undoState.future.length, 0);

for (let i = 0; i < 60; i += 1) api.undoPush('--k' + i, true);
eq('撤销栈上限 50', api.undoState.past.length, 50);

state.busy = true;
const busyBefore = api.undoState.past.length;
api.undoStep();
eq('忙碌时不执行撤销', api.undoState.past.length, busyBefore);
state.busy = false;

/* ================= 2. 复制 / 粘贴 ================= */
console.log('[2] 复制粘贴');
const toastBeforeCopy = toasts.length;
api.copyRowValue({ key: '--nts-accent', label: '主色调' });
check('复制给出提示', toasts.length > toastBeforeCopy);
check('提示里带复制的值', String(toasts[toasts.length - 1].text).indexOf('#2a7bc4') >= 0,
  toasts[toasts.length - 1].text);

function runPasteTests() {
  api.pasteRowValue({ key: '--nts-accent', label: '主色调' }).then(function () {
    eq('粘贴写进编辑表', state.edited.light['--nts-accent'], '#2a7bc4');

    flags.safe = false;
    delete state.edited.light['--nts-accent'];
    const warnBefore = toasts.length;
    return api.pasteRowValue({ key: '--nts-accent', label: '主色调' }).then(function () {
      flags.safe = true;
      check('非法值给警告', toasts.length > warnBefore && toasts[toasts.length - 1].kind === 'warn',
        toasts[toasts.length - 1] && toasts[toasts.length - 1].kind);
      eq('非法值不写编辑表', state.edited.light['--nts-accent'], undefined);
      runCompareTests();
    });
  }).catch(function (error) { crash(error); });
}

/* ================= 3. 对比卡 ================= */
function runCompareTests() {
  console.log('[3] 对比卡');
  flags.hoverActive = true;
  hoverPreviewRef.palette = { vars: HOVER, dark_vars: {} };
  hoverPreviewRef.name = '星辰喵';
  const pairs = api.comparePairs();
  check('对比只列真正不同的项', pairs.length > 0 && pairs.length < 8, String(pairs.length));
  check('发现圆角差异', pairs.some(function (p) { return p.key === '--nts-shell-radius'; }));
  check('相同的项不列', !pairs.some(function (p) { return p.key === '--nts-chat-blur'; }));
  const radius = pairs.filter(function (p) { return p.key === '--nts-shell-radius'; })[0];
  eq('差异里带当前值', radius.before, '14px');
  eq('差异里带预演值', radius.after, '22px');

  DOM['pv-compare-rows'].children.length = 0;
  api.renderCompare();
  eq('有预演时对比卡显示', DOM['pv-compare'].hidden, false);
  eq('渲染行数等于差异数', DOM['pv-compare-rows'].children.length, pairs.length);

  flags.hoverActive = false;
  hoverPreviewRef.palette = null;
  api.renderCompare();
  eq('没有预演时对比卡隐藏', DOM['pv-compare'].hidden, true);

  runPromptTests();
}

/* ================= 4. AI 提示词 ================= */
function runPromptTests() {
  console.log('[4] AI 提示词');
  DOM['theme-name'].value = '我的主题';
  const text = api.buildAiPrompt();
  check('含主题名', text.indexOf('我的主题') >= 0);
  check('含变量契约字段', text.indexOf('dark_vars') >= 0);
  check('含 json 围栏', text.indexOf(String.fromCharCode(96, 96, 96) + 'json') >= 0);
  check('含当前配色', text.indexOf('#111111') >= 0);
  check('含对比度要求', text.indexOf('4.5') >= 0);
  pendingRef.list = [{ key: '--a', mode: 'light', before: '#111111', after: '#222222', kind: 'changed' }];
  const textWithChanges = api.buildAiPrompt();
  check('有改动时列出条数与明细', textWithChanges.indexOf('我这次改过的 1 项') >= 0 &&
    textWithChanges.indexOf('--a') >= 0);
  pendingRef.list = [];
  check('没有改动时不提改动', api.buildAiPrompt().indexOf('我这次改过的') < 0);
  runWiringTests();
}

/* ================= 5. 源码契约 ================= */
function runWiringTests() {
  console.log('[5] 接线');
  check('markEdited 记快照', /function markEdited\(key, value\) \{\r?\n  undoPush\(key\);/.test(APP));
  check('markCleared 记快照', /function markCleared\(key\) \{\r?\n  undoPush\(key\);/.test(APP));
  check('应用成功后清空撤销栈', /undoState\.past = \[\];[\s\S]{0,200}undoState\.future = \[\];/.test(APP));
  check('updateButtons 同步撤销按钮', /renderChanges\(\);\r?\n  updateUndoButtons\(\);/.test(APP));
  check('接撤销 / 重做', /addEventListener\('click', undoStep\)/.test(APP) &&
    /addEventListener\('click', redoStep\)/.test(APP));
  check('接 AI 提示词按钮', /addEventListener\('click', copyAiPrompt\)/.test(APP));
  check('快捷键初始化被调用', /initUndoShortcuts\(\);/.test(APP));
  check('输入框内不抢 Ctrl+Z', /tag === 'input' \|\| tag === 'textarea'/.test(APP));
  check('renderPreview 调对比卡', /renderCompare\(\);/.test(APP));
  check('调试钩子齐全',
    ['undoState: undoState', 'undoStep: undoStep', 'redoStep: redoStep',
      'copyRowValue: copyRowValue', 'pasteRowValue: pasteRowValue', 'comparePairs: comparePairs',
      'renderCompare: renderCompare', 'buildAiPrompt: buildAiPrompt', 'copyAiPrompt: copyAiPrompt']
      .every(function (needle) { return APP.indexOf(needle) >= 0; }));

  console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

function crash(error) {
  console.error('自测崩溃：' + (error && error.stack ? error.stack : error));
  process.exit(1);
}

runPasteTests();
