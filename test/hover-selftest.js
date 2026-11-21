#!/usr/bin/env node
/* 悬停预演（v0.9.0）自测：把 app.js 里 HOVER_PREVIEW 区块抠出来，在假环境里真跑。
 *
 * 覆盖：静态文件地址推导、可移植图片地址改写、当前模式的取值、
 *       请求成功 / 失败 / 过期请求丢弃、缓存命中、缓存上限、离开恢复。
 * 运行：node test/hover-selftest.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_JS = path.join(ROOT, 'plugin', 'static', 'app.js');

const src = fs.readFileSync(APP_JS, 'utf8');
const beginMark = '/* ===== HOVER_PREVIEW_BEGIN';
const endMark = '/* ===== HOVER_PREVIEW_END ===== */';
const begin = src.indexOf(beginMark);
const end = src.indexOf(endMark);
if (begin < 0 || end < 0 || end < begin) {
  console.error('FAIL 找不到 HOVER_PREVIEW 区块');
  process.exit(1);
}
const block = src.slice(begin, end + endMark.length);

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
  } else {
    fail += 1;
    console.error('FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
}

// ---- 假环境 ---------------------------------------------------------------

function makeHarness(options) {
  const opts = options || {};
  const renderCalls = [];
  const fetchCalls = [];
  const fakeState = { mode: opts.mode || 'light', busy: !!opts.busy };
  const fakeModal = { hidden: opts.modalOpen ? false : true };
  const fetchImpl = opts.fetch || async function () { throw new Error('no fetch'); };

  const factory = new Function(
    'fetchWithTimeout', 'state', 'modal', 'renderPreview', 'Date',
    block + '\nreturn { hoverPreview: hoverPreview, hoverPreviewMap: hoverPreviewMap,' +
    ' hoverPreviewValue: hoverPreviewValue, rewritePreviewRefs: rewritePreviewRefs,' +
    ' hoverPreviewFetchUrl: hoverPreviewFetchUrl, showHoverPreview: showHoverPreview,' +
    ' clearHoverPreview: clearHoverPreview };'
  );

  const api = factory(
    function (url, init, timeout) {
      fetchCalls.push({ url: url, init: init, timeout: timeout });
      if (opts.captureFetch) opts.captureFetch(url);
      return fetchImpl(url, init, timeout);
    },
    fakeState,
    fakeModal,
    function () { renderCalls.push(1); },
    { now: () => 1700000000000 }
  );
  return { api: api, state: fakeState, modal: fakeModal, renderCalls, fetchCalls };
}

function paletteJson(vars, dark) {
  return JSON.stringify({ vars: vars || {}, dark_vars: dark || {} });
}

async function okJson(body) {
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
}

// ---- [1] rewritePreviewRefs ----------------------------------------------

(function testRewrite() {
  const h = makeHarness();
  const builtin = h.api.rewritePreviewRefs({
    '--a': 'url("images/abc123.png")',
    '--b': 'url(images/def456.jpg)',
    '--c': '#123456'
  }, true);
  eq('内置主题的 images/ 改成 presets/images/', builtin, {
    '--a': 'url("presets/images/abc123.png")',
    '--b': 'url("presets/images/def456.jpg")',
    '--c': '#123456'
  });
  const custom = h.api.rewritePreviewRefs({
    '--img': 'url("/plugin/neko_theme_studio/ui/backgrounds/deadbeef.png")'
  }, false);
  eq('自定义主题的绝对地址保持原样', custom, {
    '--img': 'url("/plugin/neko_theme_studio/ui/backgrounds/deadbeef.png")'
  });
  eq('非对象返回空对象', h.api.rewritePreviewRefs(null, true), {});
})();

// ---- [2] 地址推导 --------------------------------------------------------

(function testUrl() {
  const h = makeHarness();
  eq('内置主题读 presets/', h.api.hoverPreviewFetchUrl({ id: 'starry-meow', builtin: true }),
    'presets/starry-meow.json');
  eq('自定义主题读 themes/', h.api.hoverPreviewFetchUrl({ id: 'my-theme-1', builtin: false }),
    'themes/my-theme-1.json');
  eq('非法 id 不请求', h.api.hoverPreviewFetchUrl({ id: '../etc/passwd', builtin: true }), '');
  eq('缺 id 不请求', h.api.hoverPreviewFetchUrl({}), '');
})();

// ---- [3] 按当前模式取值 --------------------------------------------------

(async function testValue() {
  const h = makeHarness({
    mode: 'dark',
    fetch: async function () {
      return okJson(paletteJson({ '--nts-chat-bg': '#ffffff' }, { '--nts-chat-bg': '#000011' }));
    }
  });
  check('没有预演时返回 null', h.api.hoverPreviewValue('--nts-chat-bg') === null);

  await h.api.showHoverPreview({ id: 'p1', builtin: true, name: '主题一' });
  eq('暗色模式取 dark_vars', h.api.hoverPreviewValue('--nts-chat-bg'), '#000011');
  check('未配置的键返回 null', h.api.hoverPreviewValue('--not-there') === null);

  h.state.mode = 'light';
  eq('切回亮色取 vars', h.api.hoverPreviewValue('--nts-chat-bg'), '#ffffff');

  h.api.clearHoverPreview();
  check('离开后恢复 null', h.api.hoverPreviewValue('--nts-chat-bg') === null);
  eq('进入与离开各重渲染一次预览', h.renderCalls.length, 2);
})().then(function () { return testsDone(); }, testsDone);

// ---- [4] 请求成功：缓存 + 只重渲染预览 ------------------------------------

async function testSuccess() {
  const fetchCalls = [];
  const h = makeHarness({
    fetch: async function (url) {
      fetchCalls.push(url);
      if (url.indexOf('presets/p1.json') === 0) {
        return okJson(paletteJson({ '--nts-chat-bg': '#111111' }, { '--nts-chat-bg': '#222222' }));
      }
      throw new Error('unexpected ' + url);
    }
  });
  await h.api.showHoverPreview({ id: 'p1', builtin: true, name: '主题一' });
  eq('请求地址带缓存穿透参数', fetchCalls.length, 1);
  check('请求走 no-store', h.fetchCalls[0].init.cache === 'no-store');
  check('请求 4 秒超时', h.fetchCalls[0].timeout === 4000);
  check('进入预演重渲染预览', h.renderCalls.length === 1);
  eq('主题名写进状态', h.api.hoverPreview.name, '主题一');

  await h.api.showHoverPreview({ id: 'p1', builtin: true, name: '主题一' });
  eq('同一主题第二次悬停命中缓存不再请求', fetchCalls.length, 1);

  await h.api.showHoverPreview({ id: 'p2', builtin: false, name: '我的主题' });
  eq('换一套主题仍会请求（且是 themes/）', fetchCalls.length, 2);
}

// ---- [5] 失败与让路 ------------------------------------------------------

async function testFailure() {
  const failing = makeHarness({
    fetch: async function () { throw new Error('网络断了'); }
  });
  await failing.api.showHoverPreview({ id: 'p9', builtin: true, name: '挂了' });
  check('请求失败不抛错、不设预演', failing.api.hoverPreview.palette === null);
  eq('失败不重渲染', failing.renderCalls.length, 0);
  eq('失败不缓存', Object.keys(failing.api.hoverPreview.cache).length, 0);

  const busyHarness = makeHarness({ busy: true, fetch: async function () { throw new Error('不该请求'); } });
  await busyHarness.api.showHoverPreview({ id: 'p1', builtin: true, name: '忙' });
  eq('忙碌时不发请求', busyHarness.fetchCalls.length, 0);

  const modalHarness = makeHarness({ modalOpen: true, fetch: async function () { throw new Error('不该请求'); } });
  await modalHarness.api.showHoverPreview({ id: 'p1', builtin: true, name: '弹窗' });
  eq('弹窗打开时不发请求', modalHarness.fetchCalls.length, 0);
}

// ---- [6] 过期请求丢弃 ----------------------------------------------------

async function testStale() {
  const resolvers = [];
  const h = makeHarness({
    fetch: function (url) {
      return new Promise((resolve) => { resolvers.push({ url: url, resolve: resolve }); });
    }
  });
  const first = h.api.showHoverPreview({ id: 'slow', builtin: true, name: '慢的' });
  const second = h.api.showHoverPreview({ id: 'fast', builtin: true, name: '快的' });
  // 后发的先回，先发的后回 —— 慢的那个不能盖掉新的
  resolvers[1].resolve(await okJson(paletteJson({ '--x': 'fast' }, {})));
  await second;
  eq('先拿到的是快主题', h.api.hoverPreview.name, '快的');
  resolvers[0].resolve(await okJson(paletteJson({ '--x': 'slow' }, {})));
  await first;
  eq('慢的回包被丢弃', h.api.hoverPreview.name, '快的');
}

// ---- [7] 缓存上限 --------------------------------------------------------

async function testCacheCap() {
  const h = makeHarness({
    fetch: async function () { return okJson(paletteJson({ '--nts-chat-bg': '#123456' }, {})); }
  });
  for (let i = 0; i < 65; i += 1) {
    await h.api.showHoverPreview({ id: 't' + i, builtin: true, name: 'T' + i });
  }
  const size = Object.keys(h.api.hoverPreview.cache).length;
  check('缓存有上限（<= 60）', size <= 60, 'size=' + size);
}

// ---- [8] 区块本身不写盘、不走 entry --------------------------------------

(function testNoSideEffects() {
  check('区块里不调 applyTheme', block.indexOf('applyTheme(') < 0);
  check('区块里不调 savePalette', block.indexOf('savePalette(') < 0);
  check('区块里不调 callPlugin', block.indexOf('callPlugin(') < 0);
  check('区块里不写 state.edited', block.indexOf('state.edited =') < 0);
  check('区块里不写 localStorage', block.indexOf('localStorage') < 0);
})();

async function testsDone() {
  try {
    await testSuccess();
    await testFailure();
    await testStale();
    await testCacheCap();
  } catch (error) {
    fail += 1;
    console.error('FAIL 未捕获异常：' + (error && error.stack ? error.stack : error));
  }
  console.log('hover-selftest: PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
}
