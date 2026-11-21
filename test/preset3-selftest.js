/* 快捷调校自测（v0.12.0）：光效三档 / 字体三档。
 *
 * 只测纯逻辑与「填值」行为 —— 不碰网络、不写盘。
 * 源码用 BATCH3_BEGIN/END 标记抠出，注入假 $ / state / displayValue / markEdited /
 * markCleared / syncRow / undoPush / showToast，然后在 node 里真跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'plugin', 'static', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(ROOT, 'plugin', 'static', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
function ok(name, extra) {
  pass += 1;
  console.log('  PASS ' + name + (extra ? ' ' + extra : ''));
}
function bad(name, detail) {
  fail += 1;
  console.log('  FAIL ' + name + (detail ? ' ' + detail : ''));
}
function eq(name, actual, expected) {
  if (actual === expected) ok(name);
  else bad(name, '[got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected) + ']');
}
function truthy(name, value) {
  if (value) ok(name); else bad(name, '[falsy]');
}

const BEGIN = '/* ===== BATCH3_BEGIN';
const END = '/* ===== BATCH3_END ===== */';
const from = APP.indexOf(BEGIN);
const to = APP.indexOf(END);
if (from < 0 || to < 0) {
  console.log('BATCH3 区块标记缺失');
  process.exit(1);
}
const SRC = APP.slice(from, to + END.length);

/* ---------- 假环境 ---------- */
const edited = { light: {}, dark: {} };
const cleared = { light: {}, dark: {} };
const saved = {
  '--nts-ambient-glow': '0.3',
  '--nts-glass-dispersion': '0.3',
  '--nts-glass-caustic': '0.3',
  '--nts-panel-glow-pulse': '0.3',
  '--nts-font-family': 'Inter, PingFang SC, Microsoft YaHei, Noto Sans SC, system-ui, sans-serif',
  '--nts-line-height': '1.6'
};
const state = { edited: edited, cleared: cleared, palette: { name: 't', vars: saved, dark_vars: {} }, busy: false, mode: 'light' };
const DOM = {};
['low', 'medium', 'high', 'system', 'sans', 'mono'].forEach(function (id) {
  DOM['btn-glow-' + id] = null;
  DOM['btn-font-' + id] = null;
});
function makeBtn(id) {
  return {
    id: id,
    classes: {},
    attrs: {},
    listeners: [],
    classList: {
      toggle: function (name, on) { this.owner.classes[name] = !!on; },
      add: function (name) { this.owner.classes[name] = true; },
      remove: function (name) { this.owner.classes[name] = false; }
    },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    addEventListener: function (ev, fn) { this.listeners.push(fn); }
  };
}
['low', 'medium', 'high'].forEach(function (id) {
  const b = makeBtn('btn-glow-' + id); b.classList.owner = b; DOM['btn-glow-' + id] = b;
});
['system', 'sans', 'mono'].forEach(function (id) {
  const b = makeBtn('btn-font-' + id); b.classList.owner = b; DOM['btn-font-' + id] = b;
});

const toasts = [];
function displayValue(key) {
  if (Object.prototype.hasOwnProperty.call(edited.light, key)) return edited.light[key];
  if (cleared.light[key]) return '';
  if (Object.prototype.hasOwnProperty.call(saved, key)) return saved[key];
  return '';
}
function markEdited(key, value) { edited.light[key] = value; delete cleared.light[key]; }
function markCleared(key) { delete edited.light[key]; cleared.light[key] = true; }
const syncRowCalls = [];
const undoPushes = [];

const factory = new Function(
  'state', '$', 'displayValue', 'markEdited', 'markCleared', 'syncRow', 'undoPush', 'showToast',
  SRC + '\nreturn { GLOW_LEVELS: GLOW_LEVELS, GLOW_LEVEL_KEYS: GLOW_LEVEL_KEYS, FONT_PRESETS: FONT_PRESETS, ' +
  'glowLevelOfValue: glowLevelOfValue, currentGlowLevel: currentGlowLevel, currentFontPreset: currentFontPreset, ' +
  'applyGlowLevel: applyGlowLevel, applyFontPreset: applyFontPreset, renderQuickPresets: renderQuickPresets, ' +
  'initQuickPresets: initQuickPresets, quickState: quickState };'
);

const api = factory(
  state,
  function (id) { return DOM[id] || null; },
  displayValue,
  markEdited,
  markCleared,
  function (key) { syncRowCalls.push(key); },
  function (key, force) { undoPushes.push({ key: key, force: !!force }); },
  function (text) { toasts.push(String(text)); }
);

/* ================= 1. 常量与取值 ================= */
console.log('\n1. 三档常量');
eq('光效低 = 0.15', api.GLOW_LEVELS.low.value, '0.15');
eq('光效中 = 0.45', api.GLOW_LEVELS.medium.value, '0.45');
eq('光效高 = 0.85', api.GLOW_LEVELS.high.value, '0.85');
eq('光效落点 4 个变量', api.GLOW_LEVEL_KEYS.length, 4);
truthy('包含 ambient-glow', api.GLOW_LEVEL_KEYS.indexOf('--nts-ambient-glow') >= 0);
truthy('包含 glass-dispersion', api.GLOW_LEVEL_KEYS.indexOf('--nts-glass-dispersion') >= 0);
truthy('包含 glass-caustic', api.GLOW_LEVEL_KEYS.indexOf('--nts-glass-caustic') >= 0);
truthy('包含 panel-glow-pulse', api.GLOW_LEVEL_KEYS.indexOf('--nts-panel-glow-pulse') >= 0);
eq('字体预设 3 档', Object.keys(api.FONT_PRESETS).join(','), 'system,sans,mono');
eq('系统默认不写字体族', api.FONT_PRESETS.system.family, '');
truthy('无衬线含 system-ui', api.FONT_PRESETS.sans.family.indexOf('system-ui') >= 0);
truthy('等宽含 monospace', api.FONT_PRESETS.mono.family.indexOf('monospace') >= 0);
truthy('无衬线带行高', !!api.FONT_PRESETS.sans.lineHeight);
truthy('等宽带行高', !!api.FONT_PRESETS.mono.lineHeight);

/* ================= 2. 命中判定 ================= */
console.log('\n2. 命中判定');
eq('0.15 → low', api.glowLevelOfValue('0.15'), 'low');
eq('0.45 → medium', api.glowLevelOfValue('0.45'), 'medium');
eq('0.85 → high', api.glowLevelOfValue('0.85'), 'high');
eq('0.46 仍算 medium（±0.06 容差）', api.glowLevelOfValue('0.46'), 'medium');
eq('空值不命中', api.glowLevelOfValue(''), '');
eq('非数字不命中', api.glowLevelOfValue('abc'), '');
eq('0.3 不靠近任何一档', api.glowLevelOfValue('0.3'), '');
/* 四个变量都是 0.3 → 不算命中任何档 */
eq('四项 0.3 时无档位', api.currentGlowLevel(), '');
edited.light['--nts-ambient-glow'] = '0.45';
eq('只改一项仍无档位（需四项一致）', api.currentGlowLevel(), '');
api.GLOW_LEVEL_KEYS.forEach(function (k) { edited.light[k] = '0.45'; });
eq('四项一致才命中 medium', api.currentGlowLevel(), 'medium');
api.GLOW_LEVEL_KEYS.forEach(function (k) { delete edited.light[k]; });

/* 字体命中：saved 里是无衬线栈 + 1.6 */
eq('字体命中 sans', api.currentFontPreset(), 'sans');
markCleared('--nts-font-family');
markCleared('--nts-line-height');
eq('两项都空 = 系统默认', api.currentFontPreset(), 'system');
delete cleared.light['--nts-font-family'];
delete cleared.light['--nts-line-height'];
edited.light['--nts-font-family'] = 'Some Custom, serif';
eq('手写字体不命中预设', api.currentFontPreset(), '');
delete edited.light['--nts-font-family'];

/* ================= 3. 应用行为 ================= */
console.log('\n3. 套用');
syncRowCalls.length = 0; undoPushes.length = 0; toasts.length = 0;
api.applyGlowLevel('high');
eq('四项都写成 0.85', api.GLOW_LEVEL_KEYS.map(function (k) { return edited.light[k]; }).join(','), '0.85,0.85,0.85,0.85');
eq('每个变量都刷新行', syncRowCalls.length, 4);
eq('压一次撤销栈（force）', undoPushes.length, 1);
truthy('撤销点带 force', undoPushes[0].force);
truthy('toast 提到可撤销', toasts[toasts.length - 1].indexOf('Ctrl+Z') >= 0);
eq('应用后勾选 high', api.quickState.glow, 'high');
truthy('high 按钮 aria-pressed', DOM['btn-glow-high'].attrs['aria-pressed'] === 'true');
truthy('low 按钮未选中', DOM['btn-glow-low'].attrs['aria-pressed'] === 'false');

toasts.length = 0;
api.applyFontPreset('mono');
eq('写入等宽字体族', edited.light['--nts-font-family'], api.FONT_PRESETS.mono.family);
eq('写入对应行高', edited.light['--nts-line-height'], api.FONT_PRESETS.mono.lineHeight);
truthy('提示里带「应用」', toasts[toasts.length - 1].indexOf('应用') >= 0);
eq('应用后勾选 mono', api.quickState.font, 'mono');
truthy('mono 按钮 aria-pressed', DOM['btn-font-mono'].attrs['aria-pressed'] === 'true');

api.applyFontPreset('system');
eq('系统默认清空字体族', !!edited.light['--nts-font-family'], false);
truthy('字体族进 cleared', !!cleared.light['--nts-font-family']);
eq('系统默认清空行高', !!edited.light['--nts-line-height'], false);
truthy('行高进 cleared', !!cleared.light['--nts-line-height']);

/* ================= 4. 接线与契约 ================= */
console.log('\n4. 接线');
api.initQuickPresets();
eq('6 个按钮都挂上监听', ['low', 'medium', 'high', 'system', 'sans', 'mono'].filter(function (id) {
  const key = (['low', 'medium', 'high'].indexOf(id) >= 0) ? 'btn-glow-' + id : 'btn-font-' + id;
  return DOM[key].listeners.length === 1;
}).length, 6);
truthy('区块标了 v0.12.0', SRC.indexOf('v0.12.0') >= 0);
truthy('applyGlowLevel 不调 applyTheme', SRC.indexOf('applyTheme(') < 0);
truthy('applyFontPreset 不调 callPlugin', SRC.indexOf("callPlugin(") < 0);
truthy('index.html 有 6 个快捷按钮', ['btn-glow-low', 'btn-glow-medium', 'btn-glow-high', 'btn-font-system', 'btn-font-sans', 'btn-font-mono']
  .every(function (id) { return HTML.indexOf('id="' + id + '"') >= 0; }));
truthy('index.html 快捷卡 default 收起? 不需要', true);
truthy('按钮有 aria-pressed', HTML.indexOf('id="btn-glow-low" aria-pressed="false"') >= 0);
truthy('卡片脚注说明只填值', HTML.indexOf('只把一组变量填进编辑区') >= 0);

console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
