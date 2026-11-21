#!/usr/bin/env node
/**
 * loader-warm-selftest.js -- 加载器 1.5.21+「背景图预热」自测
 *
 * 为什么要这个自测：预热逻辑是「异步 + 超时 + 只回调一次」的组合，写错时最典型的
 * 表现是「主题永远不切换」（预热回调没触发）或「回调触发两次导致重复应用」。
 * 这些在真机上很难稳定复现（要刚好在切主题时断网 / 图片慢），所以把纯逻辑抽出来跑。
 *
 * 做法：从加载器源码里抠出 IMAGE_WARM_BEGIN/END 之间的代码，注入假 Image、
 * 可控 setTimeout，然后真的去跑 imageUrlsOf / warmImages。
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var LOADER = path.join(ROOT, 'plugin', 'static', 'loader', 'neko-theme-studio.js');
var APP_JS = path.join(ROOT, 'plugin', 'static', 'app.js');

var src = fs.readFileSync(LOADER, 'utf8');
var appJs = fs.readFileSync(APP_JS, 'utf8');

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
var begin = src.indexOf('/* ===== IMAGE_WARM_BEGIN ===== */');
var end = src.indexOf('/* ===== IMAGE_WARM_END ===== */');
if (begin < 0 || end < 0 || end <= begin) {
  console.log('PASS 0/0');
  console.log('FAIL 1/1');
  console.log('  ✗ 找不到 IMAGE_WARM_BEGIN/END 标记');
  process.exit(1);
}
var blockSrc = src.slice(begin, end);

var reMatch = /var RE_BG_VALUE = (\/\^.*?\/i);/.exec(src);
if (!reMatch) {
  console.log('  ✗ 找不到 RE_BG_VALUE');
  process.exit(1);
}
/* eslint-disable no-new-func */
var RE_BG_VALUE = new Function('return ' + reMatch[1] + ';')();

// ---------------------------------------------------------------- 假环境
var images = [];       // 记录 new Image() 造出来的实例
function FakeImage() {
  images.push(this);
  this.src = '';
}
var timers = [];
function fakeSetTimeout(fn, ms) {
  timers.push({ fn: fn, ms: ms });
  return timers.length;
}
function fakeClearTimeout(id) {
  if (id > 0 && timers[id - 1]) timers[id - 1].cleared = true;
}

var logs = [];
function fakeLog() {
  logs.push(Array.prototype.slice.call(arguments).join(' '));
}

var factory = new Function(
  'RE_BG_VALUE', 'log', 'Image', 'setTimeout', 'clearTimeout',
  blockSrc + '\nreturn { imageUrlsOf: imageUrlsOf, warmImages: warmImages, warmedImages: warmedImages, IMAGE_WARM_TIMEOUT_MS: IMAGE_WARM_TIMEOUT_MS };'
);
var api = factory(RE_BG_VALUE, fakeLog, FakeImage, fakeSetTimeout, fakeClearTimeout);

function clearWarmed() {
  // warmedImages 是块内 var 指向的对象：重新赋值 api.warmedImages 只会换掉
  // 外面看的那个引用，块内仍然写原对象 —— 所以必须原地清空。
  Object.keys(api.warmedImages).forEach(function (k) { delete api.warmedImages[k]; });
}

// ---------------------------------------------------------------- 1. imageUrlsOf
console.log('[1] imageUrlsOf：只认本插件 backgrounds/');
(function () {
  clearWarmed();
  var plain = Object.create(null);

  check('空调色板 → 空数组', api.imageUrlsOf({}).length === 0);

  var one = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 'url("/plugin/neko_theme_studio/ui/backgrounds/abc123.png")' }
  });
  check('单个相对 URL 被取出', one.length === 1 && one[0] === '/plugin/neko_theme_studio/ui/backgrounds/abc123.png', JSON.stringify(one));

  var dup = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 'url("/plugin/neko_theme_studio/ui/backgrounds/same.png")' },
    dark_vars: { '--nts-chat-bg-image': 'url("/plugin/neko_theme_studio/ui/backgrounds/same.png")' }
  });
  check('亮暗两组引用同一张图只算一次', dup.length === 1, JSON.stringify(dup));

  var abs = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 'url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/x.jpg")' }
  });
  check('本机绝对地址被接受', abs.length === 1 && abs[0].indexOf('127.0.0.1') >= 0);

  var none = api.imageUrlsOf({ vars: { '--nts-chat-bg-image': 'none' } });
  check('none 不算图片', none.length === 0);

  var evil = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 'url("https://evil.example.com/track.png")' }
  });
  check('外链不被预热（不发出站请求）', evil.length === 0);

  var other = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 'url("/static/other/thing.png")' }
  });
  check('非 backgrounds/ 路径不算', other.length === 0);

  var bad = api.imageUrlsOf({
    vars: { '--nts-chat-bg-image': 42, '--nts-x': 'url("/plugin/neko_theme_studio/ui/backgrounds/ok.png")' }
  });
  check('非字符串值被跳过、其余仍取出', bad.length === 1 && bad[0].indexOf('ok.png') > 0);
  void plain;
}());

// ---------------------------------------------------------------- 2. warmImages
console.log('[2] warmImages：全部就绪 / 失败 / 超时都只回调一次');
(function () {
  clearWarmed();
  images = [];
  timers = [];

  var done = 0;
  api.warmImages(['/plugin/neko_theme_studio/ui/backgrounds/a.png', '/plugin/neko_theme_studio/ui/backgrounds/b.png'], function () { done += 1; });
  check('两张图 → 造了两个 Image', images.length === 2, String(images.length));
  check('还没就绪时回调没被调用', done === 0);
  check('登记了超时定时器', timers.length === 1 && timers[0].ms === api.IMAGE_WARM_TIMEOUT_MS, JSON.stringify(timers.map(function (t) { return t.ms; })));

  images[0].onload();
  check('只就绪一张时仍不回调', done === 0);
  check('第一张标记为 ok', api.warmedImages['/plugin/neko_theme_studio/ui/backgrounds/a.png'] === 'ok');

  images[1].onerror();
  check('第二张失败也会完成等待（不让主题卡住）', done === 1);
  check('失败被记成 fail', api.warmedImages['/plugin/neko_theme_studio/ui/backgrounds/b.png'] === 'fail');

  timers[0].fn();
  check('超时定时器再触发也不会二次回调', done === 1);

  // 已预热的 URL 不再发请求
  images = [];
  timers = [];
  var done2 = 0;
  api.warmImages(['/plugin/neko_theme_studio/ui/backgrounds/a.png'], function () { done2 += 1; });
  check('已 ok 的 URL 不重复请求', images.length === 0, String(images.length));
  check('已预热的集合直接完成', done2 === 1);
}());

// ---------------------------------------------------------------- 3. 超时兜底
(function () {
  clearWarmed();
  images = [];
  timers = [];
  var done = 0;
  api.warmImages(['/plugin/neko_theme_studio/ui/backgrounds/slow.png'], function () { done += 1; });
  check('慢图先挂起，不阻塞', done === 0);
  timers[0].fn();
  check('超时后回调一次', done === 1);
  check('超时后该 URL 仍未标记 ok（等真就绪时再记）', !api.warmedImages['/plugin/neko_theme_studio/ui/backgrounds/slow.png']);
  images[0].onload();
  check('迟到的 onload 只更新状态、不再回调', done === 1 && api.warmedImages['/plugin/neko_theme_studio/ui/backgrounds/slow.png'] === 'ok');
}());

// ---------------------------------------------------------------- 4. 接线
console.log('[3] 加载器接线');
check('脚本版本是 semver 且不低于 1.5.21', (function () {
  var m = /var SCRIPT_VERSION = '(\d+)\.(\d+)\.(\d+)';/.exec(src);
  if (!m) return false;
  var v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v[0] > 1 || (v[0] === 1 && (v[1] > 5 || (v[1] === 5 && v[2] >= 21)));
})());
check('GATE 在主流程里（applyPalette 内）', /var warmKey = stampOf\(p\) \+ '\|'/.test(src));
check('预热中直接返回、不改 DOM', /return true;\s*\r?\n\s*\}\s*\r?\n\s*lastWarmKey = warmKey;/.test(src));
check('预热完成后带着同一份调色板重进 applyPalette', /if \(queued\) applyPalette\(queued\);/.test(src));
check('超时兜底存在', /timer = setTimeout\(finish, IMAGE_WARM_TIMEOUT_MS\);/.test(src));
check('预热日志带上张数', /warming ' \+ warmUrls\.length \+ ' background image\(s\) before applying'/.test(src));
check('门控在 styleEl 之前（先预热再改 <style>）', src.indexOf('var warmKey = stampOf(p)') < src.indexOf('var el = styleEl();'));
check('超时阈值合理（500~5000ms）', api.IMAGE_WARM_TIMEOUT_MS >= 500 && api.IMAGE_WARM_TIMEOUT_MS <= 5000, String(api.IMAGE_WARM_TIMEOUT_MS));
check('app.js 未受影响（仍然没有 requestAnimationFrame 之外的定时器等改动迹象）', appJs.indexOf('editorSyncState') > 0);
check('预热不会改 localStorage 缓存键', src.indexOf("var CACHE_KEY = 'neko.themeStudio.palette';") > 0);

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
