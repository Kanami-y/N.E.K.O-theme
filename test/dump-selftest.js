#!/usr/bin/env node
/**
 * dump-selftest.js -- v0.4.21「当前调色板 JSON 折叠时惰性重建」自测
 *
 * 为什么要这个自测：折叠时跳过重建，最容易写错的两处是
 *   ① 展开后忘了补渲染 —— 用户看到空白 / 旧 JSON；
 *   ② 折叠期间复制 —— 复制到的是旧的 JSON。
 * 这两个都不报错，只是「看到的东西不对」，真机上手点很难稳定复现，
 * 所以把 DUMP_LAZY 块抠出来，用假 DOM + 假 localStorage 真跑一遍。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var APP_JS = path.join(ROOT, 'plugin', 'static', 'app.js');
var HTML = path.join(ROOT, 'plugin', 'static', 'index.html');

var src = fs.readFileSync(APP_JS, 'utf8');
var html = fs.readFileSync(HTML, 'utf8');

var pass = 0;
var fail = 0;
var failures = [];

function ok(name) {
  pass += 1;
  console.log('  · ' + name + '：通过');
}

function bad(name, detail) {
  fail += 1;
  failures.push(name + (detail ? '（' + detail + '）' : ''));
  console.log('  ✗ ' + name + '：失败' + (detail ? ' —— ' + detail : ''));
}

function check(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail);
}

// ---------------------------------------------------------------- 抠源码
var begin = src.indexOf('/* ===== DUMP_LAZY_BEGIN ===== */');
var end = src.indexOf('/* ===== DUMP_LAZY_END ===== */');
if (begin < 0 || end < 0 || end <= begin) {
  console.log('PASS 0/0');
  console.log('FAIL 1/1');
  console.log('  ✗ 找不到 DUMP_LAZY_BEGIN/END 标记');
  process.exit(1);
}
var blockSrc = src.slice(begin, end);

// ---------------------------------------------------------------- 假环境
function makeEl(id) {
  return {
    id: id,
    textContent: '',
    hidden: false,
    title: '',
    attrs: {},
    setAttribute: function (name, value) { this.attrs[name] = String(value); },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }
  };
}

function makeEnv() {
  var els = {
    'btn-toggle-dump': makeEl('btn-toggle-dump'),
    'dump-body': makeEl('dump-body')
  };
  var store = {};
  var storage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); }
  };
  var renders = [];
  var env = {
    els: els,
    store: store,
    renders: renders,
    $: function (id) { return Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null; },
    libraryStorage: function () { return storage; },
    renderDump: function (force) { renders.push(!!force); }
  };
  var factory = new Function(
    '$', 'libraryStorage', 'renderDump',
    blockSrc + '\nreturn {' +
      'DUMP_COLLAPSE_KEY: DUMP_COLLAPSE_KEY,' +
      'dumpState: dumpState,' +
      'dumpLazyPlan: dumpLazyPlan,' +
      'loadDumpCollapsed: loadDumpCollapsed,' +
      'saveDumpCollapsed: saveDumpCollapsed,' +
      'applyDumpCollapsed: applyDumpCollapsed,' +
      'toggleDumpCard: toggleDumpCard };'
  );
  env.api = factory(env.$, env.libraryStorage, env.renderDump);
  return env;
}

// ---------------------------------------------------------------- 1. dumpLazyPlan 真值表
console.log('[1] dumpLazyPlan：什么时候可以跳过');
(function () {
  var env = makeEnv();
  var plan = env.api.dumpLazyPlan;

  check('展开 + 干净 → render', plan(false, false) === 'render', plan(false, false));
  check('展开 + 脏 → render（要补上漏掉的那次）', plan(false, true) === 'render', plan(false, true));
  check('折叠 + 干净 → skip', plan(true, false) === 'skip', plan(true, false));
  check('折叠 + 脏 → 仍然 skip（已经脏了，再标一次也没用）', plan(true, true) === 'skip', plan(true, true));
  check('只返回两个取值', ['render', 'skip'].indexOf(plan(true, true)) >= 0 &&
    ['render', 'skip'].indexOf(plan(false, false)) >= 0);
})();

// ---------------------------------------------------------------- 2. 折叠 / 展开
console.log('[2] toggleDumpCard：折叠省渲染、展开补渲染');
(function () {
  var env = makeEnv();
  var api = env.api;
  var btn = env.els['btn-toggle-dump'];
  var body = env.els['dump-body'];

  check('初始默认展开（block 里 collapsed=false）', api.dumpState.collapsed === false);
  check('初始按钮箭头是 ▾', btn.textContent === '' || btn.textContent === '▾', btn.textContent);

  // 折叠
  api.toggleDumpCard();
  check('折叠后状态为真', api.dumpState.collapsed === true);
  check('折叠后按钮变成 ▸', btn.textContent === '▸', btn.textContent);
  check('折叠后 aria-expanded=false', btn.getAttribute('aria-expanded') === 'false', btn.getAttribute('aria-expanded'));
  check('折叠后 body 隐藏', body.hidden === true);
  check('折叠时 dirty=false 不触发补渲染', env.renders.length === 0, JSON.stringify(env.renders));
  check('折叠状态持久化为 "1"', env.store[api.DUMP_COLLAPSE_KEY] === '1', env.store[api.DUMP_COLLAPSE_KEY]);

  // 折叠期间有刷新（标脏），展开时应补渲染一次
  api.dumpState.dirty = true;
  api.toggleDumpCard();
  check('展开后状态为假', api.dumpState.collapsed === false);
  check('展开后箭头回到 ▾', btn.textContent === '▾', btn.textContent);
  check('展开后 aria-expanded=true', btn.getAttribute('aria-expanded') === 'true', btn.getAttribute('aria-expanded'));
  check('展开后 body 可见', body.hidden === false);
  check('展开且脏 → 补渲染一次（force=true）', env.renders.length === 1 && env.renders[0] === true, JSON.stringify(env.renders));
  check('展开后持久化为 "0"', env.store[api.DUMP_COLLAPSE_KEY] === '0', env.store[api.DUMP_COLLAPSE_KEY]);

  // 干净状态展开 → 不多余重建
  env.renders.length = 0;
  api.dumpState.dirty = false;
  api.toggleDumpCard(); // 折叠
  api.toggleDumpCard(); // 再展开
  check('干净状态来回切换不重建', env.renders.length === 0, JSON.stringify(env.renders));
})();

// ---------------------------------------------------------------- 3. 记住上次的折叠状态
console.log('[3] 持久化：上次折叠，下次打开还是折叠');
(function () {
  var env = makeEnv();
  env.store[env.api.DUMP_COLLAPSE_KEY] = '1';
  check('读到 "1" → collapsed=true', env.api.loadDumpCollapsed() === true);
  delete env.store[env.api.DUMP_COLLAPSE_KEY];
  check('没有记录 → 默认展开', env.api.loadDumpCollapsed() === false);
  env.store[env.api.DUMP_COLLAPSE_KEY] = '0';
  check('读到 "0" → false', env.api.loadDumpCollapsed() === false);

  // localStorage 抛异常（隐私模式）不能把面板打崩
  var env2 = makeEnv();
  env2.api.libraryStorage = function () { throw new Error('denied'); };
  var crashed = false;
  var value;
  try {
    value = new Function('libraryStorage', blockSrc + '\nreturn loadDumpCollapsed();')(function () {
      throw new Error('denied');
    });
  } catch (error) {
    crashed = true;
  }
  check('localStorage 抛错时返回 false 而不是抛出去', !crashed && value === false, crashed ? 'throws' : String(value));
})();

// ---------------------------------------------------------------- 4. renderDump 闸门接线
console.log('[4] renderDump：闸门在 JSON.stringify 之前');
(function () {
  var head = src.indexOf('function renderDump(force) {');
  check('renderDump 接受 force 参数', head > 0);
  var body = src.slice(head, head + 1400);
  check('闸门调用 dumpLazyPlan', body.indexOf("dumpLazyPlan(dumpState.collapsed, dumpState.dirty) === 'skip'") > 0);
  check('跳过时标脏', /dumpState\.dirty = true;/.test(body));
  check('跳过时计数 skipped', /dumpState\.skipped \+= 1;/.test(body));
  check('跳过时 return（不重建）', /dumpState\.skipped \+= 1;\s*\r?\n\s*return;/.test(body));
  check('通过时清脏并计数 renders', /dumpState\.dirty = false;/.test(body) && /dumpState\.renders \+= 1;/.test(body));
  check('闸门在 JSON.stringify 之前', body.indexOf('dumpLazyPlan(') < body.indexOf('JSON.stringify('));
  check('force 能绕过闸门（!force 条件）', /if \(!force && dumpLazyPlan\(/.test(body));
})();

// ---------------------------------------------------------------- 5. 复制 / 首次渲染 / 接线
console.log('[5] 接线：复制前重建、启动读状态、按钮与调试钩子');
(function () {
  var copyHead = src.indexOf('function copyDump() {');
  var copyBody = src.slice(copyHead, copyHead + 420);
  check('copyDump 先强制重建（折叠时复制到旧 JSON 的 bug）', /function copyDump\(\) \{\s*\r?\n[\s\S]{0,240}renderDump\(true\);/.test(copyBody), copyBody.slice(0, 80));

  check('bootstrap 读折叠状态', src.indexOf('dumpState.collapsed = loadDumpCollapsed();') > 0);
  check('bootstrap 在读折叠状态之后才 buildEditor',
    src.indexOf('dumpState.collapsed = loadDumpCollapsed();') < src.indexOf('buildEditor();', src.indexOf('function bootstrap()')));

  check('#btn-toggle-dump 点击接到 toggleDumpCard', /\$\('btn-toggle-dump'\)\) \$\('btn-toggle-dump'\)\.addEventListener\('click', toggleDumpCard\)/.test(src));
  check('调试钩子暴露 dumpState', src.indexOf('dumpState: dumpState,') > 0);
  check('调试钩子暴露 dumpLazyPlan', src.indexOf('dumpLazyPlan: dumpLazyPlan,') > 0);
  check('调试钩子暴露 toggleDumpCard', src.indexOf('toggleDumpCard: toggleDumpCard,') > 0);
  check('dumpState 字段齐全', /var dumpState = \{ collapsed: false, dirty: false, renders: 0, skipped: 0 \};/.test(src));
})();

// ---------------------------------------------------------------- 6. 文案：JSON 其实包含未应用改动
console.log('[6] 脚注文案：不再谎称「JSON 不含未应用改动」');
(function () {
  check('脚注说 JSON 已按改动后的样子生成', src.indexOf('上面的 JSON 已经按改动后的样子生成') > 0);
  check('脚注不再出现「JSON 不含它们」', src.indexOf('上面的 JSON 不含它们') < 0);
  check('脚注仍提示点「应用」才写服务器', src.indexOf('点「应用」才会写进服务器') > 0);
  check('JSON 确实用的是 effectiveVars（含改动）', /vars: effectiveVars\('light'\)/.test(src));
})();

// ---------------------------------------------------------------- 7. a11y 收尾
console.log('[7] a11y：折叠按钮 aria-expanded、live region');
(function () {
  check('HTML 有折叠按钮且 aria-controls=dump-body', html.indexOf('id="btn-toggle-dump" aria-expanded="true" aria-controls="dump-body"') > 0);
  check('HTML 包了 #dump-body', html.indexOf('<div id="dump-body">') > 0);
  check('HTML 折叠按钮带 aria-label', /id="btn-toggle-dump"[^>]*aria-label="[^"]+"/.test(html));
  check('#audit-summary 是 live region', /id="audit-summary" role="status" aria-live="polite" aria-atomic="true"/.test(html));
  check('#schedule-now 是 live region', /id="schedule-now" role="status" aria-live="polite"/.test(html));

  var labelHead = src.indexOf('function updateGroupToggleLabel() {');
  var labelBody = src.slice(labelHead, labelHead + 420);
  check('分组折叠按钮同步 aria-expanded', /setAttribute\('aria-expanded', collapsed \? 'false' : 'true'\)/.test(labelBody), labelBody.slice(0, 120));
  check('分组折叠按钮空指针保护', /if \(!btn\) return;/.test(labelBody));
})();

// ---------------------------------------------------------------- 汇总
console.log('');
if (fail === 0) {
  console.log('PASS ' + pass + '/' + pass);
  process.exit(0);
}
console.log('PASS ' + pass + '/' + (pass + fail));
console.log('FAIL ' + fail + '/' + (pass + fail));
failures.forEach(function (f) { console.log('  - ' + f); });
process.exit(1);
