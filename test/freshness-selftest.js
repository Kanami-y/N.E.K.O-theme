#!/usr/bin/env node
/* 面板版本自检（v0.9.0）自测：抠 app.js 的 PANEL_FRESHNESS 区块真跑。
 *
 * 为什么值得单独测：这段逻辑一旦写错，最坏情况是「面板反复自己刷新」，
 * 用户会以为插件坏了。所以把「只刷一次」「版本相同不刷」「拿不到不刷」
 * 三条退路都钉死。
 * 运行：node test/freshness-selftest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT, 'plugin', 'static', 'app.js');
const src = fs.readFileSync(APP_JS, 'utf8');

const beginMark = '/* ===== PANEL_FRESHNESS_BEGIN';
const endMark = '/* ===== PANEL_FRESHNESS_END ===== */';
const begin = src.indexOf(beginMark);
const end = src.indexOf(endMark);
if (begin < 0 || end < 0 || end < begin) {
  console.error('FAIL 找不到 PANEL_FRESHNESS 区块');
  process.exit(1);
}
const block = src.slice(begin, end + endMark.length);

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error('FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

// ---- 假环境 ---------------------------------------------------------------

function makeHarness(options) {
  const opts = options || {};
  const notices = [];
  const timers = [];
  const reloads = [];
  const versionNode = opts.localVersion === null ? null : { textContent: opts.localVersion };
  const storage = opts.storage || { data: Object.create(null), getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } };
  const fetchCalls = [];

  const factory = new Function(
    '$', 'fetchWithTimeout', 'showNotice', 'setTimeout', 'window', 'Date',
    block + '\nreturn { checkPanelFreshness: checkPanelFreshness, panelVersionOf: panelVersionOf,' +
    ' PANEL_FRESHNESS_DELAY_MS: PANEL_FRESHNESS_DELAY_MS };'
  );

  const api = factory(
    function (id) { return id === 'panel-version' ? versionNode : null; },
    opts.fetch || async function () { throw new Error('no fetch'); },
    function (kind, text) { notices.push({ kind: kind, text: text }); },
    function (fn, delay) { timers.push({ fn: fn, delay: delay }); },
    { sessionStorage: opts.noStorage ? undefined : storage, location: { replace: function (url) { reloads.push(url); } } },
    { now: () => 1700000000000 }
  );
  return { api: api, notices: notices, timers: timers, reloads: reloads, storage: storage, fetchCalls: fetchCalls };
}

function htmlResponse(versionText) {
  return async function () {
    return {
      ok: true,
      status: 200,
      text: async () => '<span class="pill pill-mini" id="panel-version">' + versionText + '</span>'
    };
  };
}

// ---- [1] 版本解析 --------------------------------------------------------

(function testParse() {
  const h = makeHarness();
  eq('从「插件 v0.9.0」取出 0.9.0', h.api.panelVersionOf('插件 v0.9.0'), '0.9.0');
  eq('没有版本号返回空串', h.api.panelVersionOf('插件'), '');
  eq('非三位版本不算', h.api.panelVersionOf('v0.9'), '');
  eq('空输入返回空串', h.api.panelVersionOf(null), '');
  check('延迟常量合理（1~10 秒）', h.api.PANEL_FRESHNESS_DELAY_MS >= 1000 && h.api.PANEL_FRESHNESS_DELAY_MS <= 10000);
})();

// ---- [2] 各种「不该动」的情况 --------------------------------------------

async function testQuietPaths() {
  const noNode = makeHarness({ localVersion: null });
  eq('没有版本节点 → false', await noNode.api.checkPanelFreshness(), false);

  const noVersionText = makeHarness({ localVersion: '插件' });
  eq('页面版本解析不出来 → false', await noVersionText.api.checkPanelFreshness(), false);

  const failing = makeHarness({ localVersion: '插件 v0.9.0', fetch: async () => { throw new Error('断了'); } });
  eq('请求失败 → false', await failing.api.checkPanelFreshness(), false);
  eq('请求失败不弹提示', failing.notices.length, 0);
  eq('请求失败不重载', failing.reloads.length, 0);

  const notOk = makeHarness({ localVersion: '插件 v0.9.0', fetch: async () => ({ ok: false, status: 503 }) });
  eq('非 2xx → false', await notOk.api.checkPanelFreshness(), false);
  eq('非 2xx 不重载', notOk.reloads.length, 0);

  const same = makeHarness({ localVersion: '插件 v0.9.0', fetch: htmlResponse('插件 v0.9.0') });
  eq('版本相同 → false', await same.api.checkPanelFreshness(), false);
  eq('版本相同不弹提示', same.notices.length, 0);
  eq('版本相同不重载', same.reloads.length, 0);

  const noHolder = makeHarness({
    localVersion: '插件 v0.9.0',
    fetch: async () => ({ ok: true, status: 200, text: async () => '<div>没有版本节点</div>' })
  });
  eq('远端页面没有版本节点 → false', await noHolder.api.checkPanelFreshness(), false);
}

// ---- [3] 版本不一致：提示 + 只重载一次 ------------------------------------

async function testOutdated() {
  const h = makeHarness({ localVersion: '插件 v0.9.0', fetch: htmlResponse('插件 v0.9.1') });
  eq('版本不一致 → true', await h.api.checkPanelFreshness(), true);
  eq('弹了一条提示', h.notices.length, 1);
  check('提示里带上新版本', h.notices[0].text.indexOf('v0.9.1') >= 0, h.notices[0].text);
  check('提示里带上旧版本', h.notices[0].text.indexOf('v0.9.0') >= 0, h.notices[0].text);
  eq('级别是 warn', h.notices[0].kind, 'warn');
  eq('安排了一次重载', h.timers.length, 1);
  check('重载延迟很短（<= 2 秒）', h.timers[0].delay <= 2000, 'delay=' + h.timers[0].delay);
  eq('还没执行时地址没动', h.reloads.length, 0);

  h.timers[0].fn();
  eq('执行后重载一次', h.reloads.length, 1);
  check('重载地址是 index.html 且带时间戳', /^index\.html\?v=\d+$/.test(h.reloads[0]), h.reloads[0]);
  check('sessionStorage 记住了这次刷新',
    Object.keys(h.storage.data).some((k) => k.indexOf('nts.panel.refreshed.') === 0));
}

// ---- [4] 已经刷过一次就不再刷（防循环） ----------------------------------

async function testNoLoop() {
  const h = makeHarness({ localVersion: '插件 v0.9.0', fetch: htmlResponse('插件 v0.9.1') });
  await h.api.checkPanelFreshness();
  h.timers.forEach((t) => t.fn());
  const reloadsAfterFirst = h.reloads.length;
  eq('第二次调用（同一页面生命周期）→ false', await h.api.checkPanelFreshness(), false);
  eq('不会再加一次重载', h.reloads.length, reloadsAfterFirst);
}

// ---- [5] 隐私模式：没有 sessionStorage 也不能崩、仍然刷一次 ---------------

async function testNoStorage() {
  const h = makeHarness({ localVersion: '插件 v0.9.0', fetch: htmlResponse('插件 v0.9.1'), noStorage: true });
  eq('没有 sessionStorage 也能工作', await h.api.checkPanelFreshness(), true);
  eq('仍然提示并重载', h.notices.length, 1);
}

// ---- [6] 区块边界：不写盘、不动调色板 ------------------------------------

(function testNoSideEffects() {
  check('不调 applyTheme', block.indexOf('applyTheme(') < 0);
  check('不调 callPlugin', block.indexOf('callPlugin(') < 0);
  check('不碰 state.edited', block.indexOf('state.edited') < 0);
  check('只用 no-store 拉 index.html', block.indexOf("cache: 'no-store'") >= 0);
  check('拉的是 index.html', block.indexOf("'index.html?_='") >= 0);
})();

(async function run() {
  try {
    await testQuietPaths();
    await testOutdated();
    await testNoLoop();
    await testNoStorage();
  } catch (error) {
    fail += 1;
    console.error('FAIL 未捕获异常：' + (error && error.stack ? error.stack : error));
  }
  console.log('freshness-selftest: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
