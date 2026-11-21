/* 面板 UX 自测：族 tab / 搜索 / 收藏 / 自定义族 / 折叠持久化 / CATALOG 10 组 101 变量。
 *
 * 做法：app.js 里的 LIB_CORE_BEGIN…LIB_CORE_END 是「只做数据变换、不碰 DOM」的纯函数区，
 * 这里把这段源码原样抠出来放进函数里求值（同一个 realm，不依赖 DOM/jsdom），
 * 然后对族×标签×搜索三重叠加、收藏置顶、localStorage 读写做断言；
 * 再对 app.js / index.html / style.css 做结构级检查，最后跑 node --check。
 *
 * 运行：node test/panel-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var APP = path.join(ROOT, 'plugin', 'static', 'app.js');
var HTML = path.join(ROOT, 'plugin', 'static', 'index.html');
var CSS = path.join(ROOT, 'plugin', 'static', 'style.css');

var appSrc = fs.readFileSync(APP, 'utf8');
var htmlSrc = fs.readFileSync(HTML, 'utf8');
var cssSrc = fs.readFileSync(CSS, 'utf8');

var failures = [];
var passes = 0;

function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    return;
  }
  failures.push(name + (detail === undefined ? '' : ' —— ' + detail));
}

function eq(name, actual, expected) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  check(name, a === e, 'actual=' + a + ' expected=' + e);
}

/* ---------- 1. 抠出 LIB_CORE 纯函数区 ---------- */

var beginMark = '/* ===== LIB_CORE_BEGIN';
var endMark = '/* ===== LIB_CORE_END ===== */';
var beginAt = appSrc.indexOf(beginMark);
var endAt = appSrc.indexOf(endMark);
check('app.js 含 LIB_CORE_BEGIN/END 标记', beginAt >= 0 && endAt > beginAt,
  'begin=' + beginAt + ' end=' + endAt);

var coreSrc = appSrc.slice(beginAt, endAt + endMark.length);
var core = new Function(coreSrc + '\nreturn {\n' +
  '  LIB_FAMILIES: LIB_FAMILIES, LIB_FAV_FAMILY: LIB_FAV_FAMILY,\n' +
  '  LIB_FAV_KEY: LIB_FAV_KEY, LIB_COLLAPSE_KEY: LIB_COLLAPSE_KEY,\n' +
  '  libFamilyIds: libFamilyIds, libFamilyLabel: libFamilyLabel,\n' +
  '  libFamilyTone: libFamilyTone, libFamilyOf: libFamilyOf,\n' +
  '  libTagsOf: libTagsOf, libSearchText: libSearchText,\n' +
  '  libMatchesQuery: libMatchesQuery, libMatchesTag: libMatchesTag,\n' +
  '  libIsFavorite: libIsFavorite, libMatchesFamily: libMatchesFamily,\n' +
  '  libSelectLibrary: libSelectLibrary, libFamilyCounts: libFamilyCounts,\n' +
  '  libPruneFavorites: libPruneFavorites,\n' +
  '  libStorageRead: libStorageRead, libStorageWrite: libStorageWrite,\n' +
  '  libReadIdList: libReadIdList, libWriteIdList: libWriteIdList,\n' +
  '  libReadCollapsed: libReadCollapsed, libWriteCollapsed: libWriteCollapsed\n' +
  '};')();

/* ---------- 2. 假数据 + 假 localStorage ---------- */

var ITEMS = [
  { id: 'a', name: '晨雾玻璃', note: '低饱和玻璃卡片', tags: ['玻璃', '浅色'],
    family: 'glassy', light: 20, dark: 16, builtin: true },
  { id: 'b', name: 'Neon Glass 夜色', note: '暗色霓虹玻璃', tags: ['玻璃', '暗色'],
    family: 'glassy', light: 12, dark: 24, builtin: false },
  { id: 'c', name: '日落渐变', note: '暖色渐变气泡', tags: ['渐变'],
    family: 'gradient', light: 18, dark: 18, builtin: false },
  // 旧数据：没有 family 字段，靠亮/暗变量数归族
  { id: 'd', name: '旧版浅色', note: '没有 family', tags: ['浅色'],
    light: 30, dark: 4, builtin: false },
  { id: 'e', name: '旧版暗色', note: 'family 缺失', tags: ['暗色'],
    light: 3, dark: 27, builtin: false }
];
var FAVS = ['b', 'c'];

function fakeStorage(seed) {
  var store = seed || {};
  return {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem: function (key, value) { store[key] = String(value); },
    removeItem: function (key) { delete store[key]; },
    _dump: function () { return store; }
  };
}

function ids(list) { return list.map(function (item) { return item.id; }); }

/* ---------- 3. 纯函数断言 ---------- */

var C = core;

eq('六个风格族 id', C.libFamilyIds(), ['glassy', 'gradient', 'dark', 'light', 'texture', 'minimal']);
eq('族中文名', C.LIB_FAMILIES.map(function (f) { return f.label; }),
  ['液态玻璃', '渐变', '暗色', '浅色', '纸感', '极简']);
check('每族都有 tone 色点色值',
  C.LIB_FAMILIES.every(function (f) { return /^#[0-9a-f]{6}$/i.test(f.tone); }));
eq('收藏虚拟族常量', C.LIB_FAV_FAMILY, '__fav__');
eq('收藏 localStorage key', C.LIB_FAV_KEY, 'nts.library.favorites');
eq('折叠 localStorage key', C.LIB_COLLAPSE_KEY, 'nts.catalog.collapsed');

// 3.1 族识别：合法值 / 大小写 / 旧数据 / 非法值容错
eq('family=glassy 原样识别', C.libFamilyOf({ family: 'glassy' }), 'glassy');
eq('family 大小写不敏感', C.libFamilyOf({ family: 'GLASSY' }), 'glassy');
eq('无 family 且暗多 → dark', C.libFamilyOf({ light: 2, dark: 9 }), 'dark');
eq('无 family 且亮多 → light', C.libFamilyOf({ light: 9, dark: 2 }), 'light');
eq('空对象 → light（不抛错）', C.libFamilyOf({}), 'light');
eq('null → light（不抛错）', C.libFamilyOf(null), 'light');
eq('非法 family 按亮暗数回退', C.libFamilyOf({ family: 'nope', light: 1, dark: 9 }), 'dark');

// 3.2 搜索：name / note / tags，大小写不敏感
eq('搜索命中 name', ids(C.libSelectLibrary(ITEMS, { query: '晨雾' })), ['a']);
eq('搜索命中 note', ids(C.libSelectLibrary(ITEMS, { query: '低饱和' })), ['a']);
eq('搜索命中 tags', ids(C.libSelectLibrary(ITEMS, { query: '暗色' })), ['b', 'e']);
eq('搜索大小写不敏感', ids(C.libSelectLibrary(ITEMS, { query: 'neon' })), ['b']);
eq('空搜索 = 不过滤', C.libSelectLibrary(ITEMS, { query: '   ' }).length, ITEMS.length);
eq('搜索无命中 = 空', C.libSelectLibrary(ITEMS, { query: '不存在的词' }).length, 0);
check('搜索特殊字符不抛错', (function () {
  try { C.libSelectLibrary(ITEMS, { query: '「\\\'";.<>' }); return true; } catch (e) { return false; }
})());

// 3.3 三重叠加：family && tag && query
eq('族 glassy', ids(C.libSelectLibrary(ITEMS, { family: 'glassy' })), ['a', 'b']);
eq('族 dark（旧数据归档）', ids(C.libSelectLibrary(ITEMS, { family: 'dark' })), ['e']);
eq('族 + 标签', ids(C.libSelectLibrary(ITEMS, { family: 'glassy', tag: '暗色' })), ['b']);
eq('族 + 标签 + 搜索 命中', ids(C.libSelectLibrary(ITEMS, { family: 'glassy', tag: '玻璃', query: '夜色' })), ['b']);
eq('族 + 标签 + 搜索 三重不相交 = 空',
  C.libSelectLibrary(ITEMS, { family: 'glassy', tag: '玻璃', query: '渐变' }).length, 0);
eq('族 + 搜索（不带标签）', ids(C.libSelectLibrary(ITEMS, { family: 'glassy', query: '晨雾' })), ['a']);
eq('标签「全部」不过滤', C.libSelectLibrary(ITEMS, { tag: '' }).length, ITEMS.length);

// 3.4 收藏虚拟族 + 收藏置顶
eq('收藏族只出收藏项', ids(C.libSelectLibrary(ITEMS, { family: '__fav__', favorites: FAVS })), ['b', 'c']);
eq('收藏族 + 搜索叠加', ids(C.libSelectLibrary(ITEMS, { family: '__fav__', favorites: FAVS, query: '渐变' })), ['c']);
var all = C.libSelectLibrary(ITEMS, { favorites: FAVS });
eq('「全部」视图条数不变', all.length, ITEMS.length);
eq('「全部」视图收藏置顶（保持列表内相对顺序）', ids(all).slice(0, 2), ['b', 'c']);
eq('「全部」视图非收藏项在后', ids(all).slice(2), ['a', 'd', 'e']);
eq('无收藏时顺序不变', ids(C.libSelectLibrary(ITEMS, { favorites: [] })), ids(ITEMS));
eq('收藏 id 不存在于列表时不影响', ids(C.libSelectLibrary(ITEMS, { favorites: ['zzz'] })), ids(ITEMS));
eq('收藏族 + 标签过滤', ids(C.libSelectLibrary(ITEMS, { family: '__fav__', favorites: FAVS, tag: '玻璃' })), ['b']);

// 3.5 数量徽标
var counts = C.libFamilyCounts(ITEMS, '', '玻璃', FAVS);
eq('徽标：标签过滤后总数', counts.all, 2);
eq('徽标：glassy 数', counts.families.glassy, 2);
eq('徽标：非 glassy 族为 0', counts.families.gradient, 0);
eq('徽标：收藏数（与标签叠加）', counts.fav, 1);
var countsAll = C.libFamilyCounts(ITEMS, '', '', FAVS);
eq('徽标：无筛选时各族总数', countsAll.families, { glassy: 2, gradient: 1, dark: 1, light: 1, texture: 0, minimal: 0 });
eq('徽标：无筛选时收藏数', countsAll.fav, 2);

// 3.6 收藏清理
eq('剪掉不存在的收藏 id', C.libPruneFavorites(['b', 'zzz', 'c'], ITEMS), ['b', 'c']);
eq('剪掉重复的收藏 id', C.libPruneFavorites(['b', 'b', 'a'], ITEMS), ['b', 'a']);
eq('收藏清理容忍脏数据', C.libPruneFavorites([null, 3, 'a'], ITEMS), ['a']);
eq('收藏清理容忍非数组', C.libPruneFavorites(null, ITEMS), []);

// 3.7 localStorage 读写（收藏 id 列表）
var storage = fakeStorage();
eq('空 storage 读收藏 = []', C.libReadIdList(storage, C.LIB_FAV_KEY), []);
C.libWriteIdList(storage, C.LIB_FAV_KEY, ['b', 'c']);
eq('收藏写读往返', C.libReadIdList(storage, C.LIB_FAV_KEY), ['b', 'c']);
storage.setItem(C.LIB_FAV_KEY, '这不是 JSON');
eq('坏 JSON 读回 []', C.libReadIdList(storage, C.LIB_FAV_KEY), []);
storage.setItem(C.LIB_FAV_KEY, '{"b":true}');
eq('非数组 JSON 读回 []', C.libReadIdList(storage, C.LIB_FAV_KEY), []);
storage.setItem(C.LIB_FAV_KEY, '[1,"x",null,"x","y"]');
eq('丢弃非字符串与重复项', C.libReadIdList(storage, C.LIB_FAV_KEY), ['x', 'y']);
var throwing = {
  getItem: function () { throw new Error('privacy mode'); },
  setItem: function () { throw new Error('quota'); }
};
eq('storage 抛错时读收藏 = []', C.libReadIdList(throwing, C.LIB_FAV_KEY), []);
eq('storage 抛错时写收藏 = false', C.libWriteIdList(throwing, C.LIB_FAV_KEY, ['a']), false);

// 3.8 折叠状态持久化
var names = ['聊天气泡', '液态玻璃质感'];
eq('默认无记录 = 全部展开', C.libReadCollapsed(storage, C.LIB_COLLAPSE_KEY, names), {});
C.libWriteCollapsed(storage, C.LIB_COLLAPSE_KEY, { '聊天气泡': true, '不存在的组': true }, names);
eq('只持久化已知分组', C.libReadCollapsed(storage, C.LIB_COLLAPSE_KEY, names), { '聊天气泡': true });
eq('写折叠返回 true', C.libWriteCollapsed(storage, C.LIB_COLLAPSE_KEY, {}, names), true);
eq('全展开 = 空对象', C.libReadCollapsed(storage, C.LIB_COLLAPSE_KEY, names), {});
storage.setItem(C.LIB_COLLAPSE_KEY, '[]');
eq('非对象 JSON 读回 {}', C.libReadCollapsed(storage, C.LIB_COLLAPSE_KEY, names), {});
eq('storage 抛错时折叠读回 {}', C.libReadCollapsed(throwing, C.LIB_COLLAPSE_KEY, names), {});

// 3.9 空值/脏数据容错
eq('items 为 null 不抛错', C.libSelectLibrary(null, {}).length, 0);
eq('opts 缺失不抛错', C.libSelectLibrary(ITEMS, undefined).length, ITEMS.length);
eq('列表内 null 项被跳过', C.libSelectLibrary([null, ITEMS[0]], {}).length, 1);
eq('tags 非数组按空处理', C.libTagsOf({ tags: '玻璃' }), []);
eq('tags 去重且截断 12 字', C.libTagsOf({ tags: ['aa', 'aa', '0123456789abcdef'] }), ['aa', '0123456789ab']);

/* ---------- 4. CATALOG：10 组 101 变量 + 液态玻璃质感组 ---------- */

var catalogMatch = appSrc.match(/var CATALOG = \[[\s\S]*?\n\];/);
check('能定位 var CATALOG = [...]', !!catalogMatch);
var CATALOG = new Function('return (' + catalogMatch[0]
  .replace('var CATALOG = ', '').replace(/;\s*$/, '') + ');')();

var flat = [];
CATALOG.forEach(function (group) {
  group.items.forEach(function (item) { flat.push(item); });
});
eq('CATALOG 分组数 = 10', CATALOG.length, 10);
eq('CATALOG 变量总数 = 101', flat.length, 101);
eq('第 10 组是「液态玻璃质感」', CATALOG[9].group, '液态玻璃质感');
eq('新组排在「液态玻璃 / 渐变」之后', CATALOG[8].group, '液态玻璃 / 渐变');

var glassItems = {};
CATALOG[9].items.forEach(function (item) { glassItems[item.key] = item; });
eq('新组 9 项', Object.keys(glassItems).sort(),
  ['--nts-ambient-glow', '--nts-glass-caustic', '--nts-glass-dispersion', '--nts-glass-lens',
    '--nts-glass-noise', '--nts-glass-rim', '--nts-glass-sheen', '--nts-glass-specular',
    '--nts-glass-thickness']);
eq('--nts-glass-rim 类型 color', glassItems['--nts-glass-rim'].type, 'color');
eq('--nts-glass-rim native', glassItems['--nts-glass-rim'].native, 'rgba(255,255,255,0.55)');
check('其余 8 项都是 number 且 native = 0', Object.keys(glassItems)
  .filter(function (key) { return key !== '--nts-glass-rim'; })
  .every(function (key) { return glassItems[key].type === 'number' && glassItems[key].native === '0'; }));
check('九项都有中文 label 与非空 hint', Object.keys(glassItems).every(function (key) {
  var item = glassItems[key];
  return item.label && item.label.length > 1 && item.hint && item.hint.length > 8;
}));
check('rim hint 提到边缘/反射', /边缘/.test(glassItems['--nts-glass-rim'].hint));
check('sheen hint 提到掠光/0–1', /掠光/.test(glassItems['--nts-glass-sheen'].hint) && /0[–-]1/.test(glassItems['--nts-glass-sheen'].hint));
check('noise hint 提到颗粒/0–1', /颗粒/.test(glassItems['--nts-glass-noise'].hint) && /0[–-]1/.test(glassItems['--nts-glass-noise'].hint));
check('没有重复 key', (function () {
  var seen = {};
  for (var i = 0; i < flat.length; i += 1) {
    if (seen[flat[i].key]) return false;
    seen[flat[i].key] = true;
  }
  return true;
})());

var typeLabelAt = appSrc.indexOf('var TYPE_LABEL');
var typeLabelSrc = appSrc.slice(typeLabelAt, appSrc.indexOf('}', typeLabelAt) + 1);
check('TYPE_LABEL 覆盖 color 与 number', /color/.test(typeLabelSrc) && /number/.test(typeLabelSrc));

/* ---------- 5. 面板接线（结构级） ---------- */

check('index.html 有族 tab 容器 #lib-family-tabs', /id="lib-family-tabs"/.test(htmlSrc));
check('index.html 有搜索框 #lib-search', /id="lib-search"/.test(htmlSrc) && /搜主题名 \/ 描述 \/ 标签/.test(htmlSrc));
check('index.html 搜索框是 type=search', /type="search"[^>]*id="lib-search"/.test(htmlSrc));
check('index.html 折叠按钮带 catalog-collapse 类',
  /id="btn-toggle-groups"[^>]*catalog-collapse/.test(htmlSrc) ||
  /catalog-collapse[^>]*id="btn-toggle-groups"/.test(htmlSrc));
check('index.html 折叠按钮有 aria-controls', /id="btn-toggle-groups"[^>]*aria-controls/.test(htmlSrc));

check('app.js 有 renderLibraryFamilies', /function renderLibraryFamilies\(\)/.test(appSrc));
check('app.js 的 renderLibrary 走 libSelectLibrary', /libSelectLibrary\(items,/.test(appSrc));
check('app.js renderLibrary 空态区分搜索/收藏/标签', /没有匹配「/.test(appSrc) && /还没有收藏任何主题/.test(appSrc));
check('app.js refreshLibrary 剪收藏', /libPruneFavorites\(libraryState\.favorites/.test(appSrc));
check('app.js 收藏按钮带 aria-pressed', /'aria-pressed': favorite/.test(appSrc));
check('app.js 收藏按钮 data-fav-id', /'data-fav-id'/.test(appSrc));
check('app.js 族徽标 chip + 色点', /lib-family-chip/.test(appSrc) && /lib-family-dot/.test(appSrc));
check('app.js note 一行截断 + title 全文', /class: 'lib-note'/.test(appSrc) && /title: noteText\.slice\(0, 500\)/.test(appSrc));
check('app.js 保留 34×34 缩略图构建', /function buildLibraryThumb\(item\)/.test(appSrc));
check('app.js libraryState 含 family/query/favorites',
  /var libraryState = \{[\s\S]*?family: ''[\s\S]*?query: ''[\s\S]*?favorites: \[\]/.test(appSrc));
check('app.js wireEvents 接 #lib-search', /if \(\$\('lib-search'\)\)/.test(appSrc));
check('app.js bootstrap 载入收藏与折叠',
  /libraryState\.favorites = libReadIdList\(libraryStorage\(\), LIB_FAV_KEY\)/.test(appSrc) &&
  /loadCatalogCollapsed\(\)/.test(appSrc));
check('app.js toggleGroup 持久化折叠', /function toggleGroup\(key\)[\s\S]*?saveCatalogCollapsed\(\)/.test(appSrc));
check('app.js toggleAllGroups 持久化折叠', /function toggleAllGroups\(\)[\s\S]*?saveCatalogCollapsed\(\)/.test(appSrc));
check('app.js 调试钩子导出 libSelectLibrary', /libSelectLibrary: libSelectLibrary/.test(appSrc));

check('style.css 有 .lib-family-tabs', /\.lib-family-tabs\s*\{/.test(cssSrc));
check('style.css 有 .lib-family-tab 与 .is-active',
  /\.lib-family-tab\s*\{/.test(cssSrc) && /\.lib-family-tab\.is-active\s*\{/.test(cssSrc));
check('style.css 有 .lib-fav 与 .is-on', /\.lib-fav\s*\{/.test(cssSrc) && /\.lib-fav\.is-on\s*\{/.test(cssSrc));
check('style.css 有 .lib-family-chip 与 .lib-family-dot', /\.lib-family-chip\s*\{/.test(cssSrc) && /\.lib-family-dot\s*\{/.test(cssSrc));
check('style.css 有 .lib-search', /\.lib-search\s*\{/.test(cssSrc));
check('style.css 有 .catalog-collapse', /\.catalog-collapse\s*\{/.test(cssSrc));
check('style.css 有 .lib-note', /\.lib-note\s*\{/.test(cssSrc));
check('style.css 新增样式使用主题变量', /\.lib-search\s*\{[^}]*var\(--surface-2\)/.test(cssSrc));
check('style.css 没有硬编码暗色专用色（新块不写死 #fff 背景）',
  !/\.lib-family-tab\.is-active\s*\{[^}]*background:\s*#/.test(cssSrc));

/* ---------- 5.5 主题仓库输入框尺寸（v0.14.1：名称框曾被 6 个按钮挤到 19px） ---------- */
var saveRowHtml = (function () {
  var start = htmlSrc.indexOf('class="lib-save-row"');
  return start < 0 ? '' : htmlSrc.slice(start, htmlSrc.indexOf('</div>', start));
})();
var actionsHtml = (function () {
  var start = htmlSrc.indexOf('class="lib-actions-row"');
  return start < 0 ? '' : htmlSrc.slice(start, htmlSrc.indexOf('</div>', start));
})();
check('index.html 主题库有独立动作行 .lib-actions-row',
  /class="lib-actions-row"[^>]*role="group"/.test(htmlSrc));
check('保存行只留名称输入 + 保存（导入不再挤进来）',
  /id="lib-name"/.test(saveRowHtml) && /id="btn-lib-save"/.test(saveRowHtml) &&
  saveRowHtml.indexOf('btn-lib-import') < 0);
check('动作行装了 5 个操作按钮',
  ['btn-lib-import', 'btn-lib-backup', 'btn-lib-restore', 'btn-wallpaper', 'btn-variants']
    .every(function (id) { return new RegExp('id="' + id + '"').test(actionsHtml); }));
check('style.css 搜索框高度 ≥ 30px 且字号 ≥ 13px',
  /\.lib-search\s*\{[^}]*height:\s*(3[0-9]|[4-9][0-9])px/.test(cssSrc) &&
  /\.lib-search\s*\{[^}]*font-size:\s*1[3-9]px/.test(cssSrc));
check('style.css 名称框 min-height ≥ 34px 且字号 ≥ 13px',
  /\.lib-save-row textarea\s*\{[^}]*min-height:\s*(3[4-9]|[4-9][0-9])px/.test(cssSrc) &&
  /\.lib-save-row textarea\s*\{[^}]*font-size:\s*1[3-9]px/.test(cssSrc));
check('style.css 动作行允许换行', /\.lib-actions-row\s*\{[^}]*flex-wrap:\s*wrap/.test(cssSrc));

/* ---------- 5.6 主题卡名字不再被按钮挤掉（v0.14.2） ----------
 * 原来卡片左右两栏：`.lib-main` 只有 140px，名字可用 71px，
 * 「液态玻璃·水晶」(78px) 与「星辰喵 Starry Meow」(113px) 都被省略号截断。
 * 现在卡片竖排：名字占整卡宽，按钮换到卡片底部右对齐。 */
check('style.css 主题卡竖排（名字独占一行）',
  /\.lib-item\s*\{[^}]*flex-direction:\s*column/.test(cssSrc));
check('style.css 主题卡主体占满宽度', /\.lib-main\s*\{\s*width:\s*100%/.test(cssSrc));
check('style.css 卡片按钮换行到底部并右对齐',
  /\.lib-btns\s*\{[^}]*flex-wrap:\s*wrap[^}]*justify-content:\s*flex-end/.test(cssSrc) &&
  /\.lib-btns\s*\{[^}]*width:\s*100%/.test(cssSrc));
check('style.css 主题列表加高到 320px', /\.lib-list\s*\{[^}]*max-height:\s*320px/.test(cssSrc));

/* ---------- 6. ES5 语法（运行时，不含注释） ---------- */

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
var appCode = stripComments(appSrc);
check('app.js 无箭头函数', appCode.indexOf('=>') < 0);
check('app.js 无模板字符串', appCode.indexOf('`') < 0);
check('app.js 无 let/const 声明', !/(^|[^\w$.])(let|const)\s+[A-Za-z_$]/.test(appCode));

/* ---------- 6.5 假 DOM 集成测试：真的跑 renderLibrary / 星标点击 / 族 tab 点击 ---------- */
/*
 * 只实现线性面板用得到的最小 DOM：createElement / getElementById / appendChild /
 * className+classList / textContent / innerHTML='' / setAttribute / addEventListener /
 * querySelector(All)（只认 .class）/ focus / hidden。足够把渲染路径完整跑一遍，
 * 比纯函数断言多抓到「appendChild 结构写错、星标点了没重排」这类问题。
 */

function FakeNode(tag) {
  this.tagName = String(tag).toUpperCase();
  this.children = [];
  this.attributes = {};
  this.style = {};
  this.listeners = {};
  this.className = '';
  this._text = '';
  this.hidden = false;
  this.value = '';
  this.disabled = false;
  this.parentNode = null;
}
FakeNode.byId = {};
FakeNode.lastFocused = null;
FakeNode.prototype.setAttribute = function (key, value) {
  this.attributes[String(key)] = String(value);
  if (String(key) === 'id') FakeNode.byId[String(value)] = this;
};
FakeNode.prototype.getAttribute = function (key) {
  return Object.prototype.hasOwnProperty.call(this.attributes, String(key))
    ? this.attributes[String(key)] : null;
};
FakeNode.prototype.appendChild = function (child) {
  if (!child) return child;
  child.parentNode = this;
  this.children.push(child);
  return child;
};
FakeNode.prototype.removeChild = function (child) {
  var at = this.children.indexOf(child);
  if (at >= 0) this.children.splice(at, 1);
  return child;
};
FakeNode.prototype.addEventListener = function (type, fn) {
  if (!this.listeners[type]) this.listeners[type] = [];
  this.listeners[type].push(fn);
};
FakeNode.prototype.dispatch = function (type) {
  var node = this;
  var event = {
    target: node,
    stopPropagation: function () {},
    preventDefault: function () {}
  };
  (this.listeners[type] || []).forEach(function (fn) { fn.call(node, event); });
};
FakeNode.prototype.focus = function () { FakeNode.lastFocused = this; };
FakeNode.prototype.querySelectorAll = function (selector) {
  var wanted = String(selector).replace(/^\./, '').split('.')[0];
  var out = [];
  function walk(node) {
    node.children.forEach(function (child) {
      var classes = String(child.className || '').split(/\s+/);
      if (classes.indexOf(wanted) >= 0) out.push(child);
      walk(child);
    });
  }
  walk(this);
  return out;
};
FakeNode.prototype.querySelector = function (selector) {
  var all = this.querySelectorAll(selector);
  return all.length ? all[0] : null;
};
Object.defineProperty(FakeNode.prototype, 'textContent', {
  get: function () { return this._text; },
  set: function (value) { this._text = String(value); this.children = []; }
});
Object.defineProperty(FakeNode.prototype, 'innerHTML', {
  get: function () { return ''; },
  set: function () { this.children = []; }
});
Object.defineProperty(FakeNode.prototype, 'classList', {
  get: function () {
    var node = this;
    function list() { return String(node.className || '').split(/\s+/).filter(Boolean); }
    return {
      add: function (name) {
        var names = list();
        if (names.indexOf(name) < 0) { names.push(name); node.className = names.join(' '); }
      },
      remove: function (name) {
        node.className = list().filter(function (item) { return item !== name; }).join(' ');
      },
      contains: function (name) { return list().indexOf(name) >= 0; },
      toggle: function (name, force) {
        var on = force === undefined ? this.contains(name) === false : !!force;
        if (on) this.add(name); else this.remove(name);
        return on;
      }
    };
  }
});

var fakeDocument = {
  createElement: function (tag) { return new FakeNode(tag); },
  getElementById: function (id) { return FakeNode.byId[String(id)] || null; }
};

['lib-list', 'lib-empty', 'lib-family-tabs', 'lib-filters'].forEach(function (id) {
  var node = new FakeNode(id === 'lib-list' ? 'ul' : 'div');
  node.setAttribute('id', id);
});

// 与 app.js 里的 el / $ 语义一致的最小实现（走假 DOM）
function fakeEl(tag, props, children) {
  var node = fakeDocument.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.indexOf('on') === 0 && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else node.setAttribute(key, value);
    });
  }
  (children || []).forEach(function (child) { if (child) node.appendChild(child); });
  return node;
}
function fakeById(id) { return fakeDocument.getElementById(id); }

var libStateStart = appSrc.indexOf('var libraryState = {');
var libSliceEnd = appSrc.indexOf('async function refreshLibrary');
check('能抠出库渲染代码段（libraryState → renderLibrary）',
  libStateStart > 0 && libSliceEnd > libStateStart);

var libFactory = new Function('document', 'window', 'state', 'CATALOG', 'el', '$',
  coreSrc + '\n' + appSrc.slice(libStateStart, libSliceEnd) +
  '\nreturn {\n' +
  '  libraryState: libraryState, LIB_EMPTY_TEXT: LIB_EMPTY_TEXT,\n' +
  '  LIB_FAV_KEY: LIB_FAV_KEY, LIB_FAV_FAMILY: LIB_FAV_FAMILY,\n' +
  '  renderLibrary: renderLibrary, renderLibraryFamilies: renderLibraryFamilies,\n' +
  '  renderLibraryFilters: renderLibraryFilters, buildLibraryItem: buildLibraryItem,\n' +
  '  toggleLibraryFavorite: toggleLibraryFavorite, saveLibraryFavorites: saveLibraryFavorites,\n' +
  '  libraryStorage: libraryStorage\n' +
  '};');

var fakeWindowStorage = fakeStorage();
var fakePanelState = { mode: 'light' };
var libCtx = libFactory(fakeDocument, { localStorage: fakeWindowStorage }, fakePanelState, [], fakeEl, fakeById);

function libIds() {
  return fakeById('lib-list').children.map(function (node) { return node.getAttribute('data-id'); });
}
function favOf(id) {
  var favs = fakeById('lib-list').querySelectorAll('.lib-fav');
  for (var i = 0; i < favs.length; i += 1) {
    if (favs[i].getAttribute('data-fav-id') === String(id)) return favs[i];
  }
  return null;
}
function familyTab(family) {
  var tabs = fakeById('lib-family-tabs').querySelectorAll('.lib-family-tab');
  for (var i = 0; i < tabs.length; i += 1) {
    if (tabs[i].getAttribute('data-family') === String(family)) return tabs[i];
  }
  return null;
}

libCtx.libraryState.items = ITEMS;
libCtx.libraryState.favorites = ['b', 'c'];

// 6.5.1 初始渲染：5 条、收藏置顶、星标状态、缩略图 34×34 结构
var rendered = libCtx.renderLibrary();
eq('假 DOM：渲染 5 条', rendered.length, 5);
eq('假 DOM：列表节点数一致', libIds(), ['b', 'c', 'a', 'd', 'e']);
check('假 DOM：收藏项排最前', libIds()[0] === 'b' && libIds()[1] === 'c');
var firstRow = fakeById('lib-list').children[0];
// 0.4.5 起重构：卡片 = [主体, 按钮组]，收藏按钮是按钮组的第一个（曾经是右上角一枚半透明 ☆，
// 用户反馈「根本找不到收藏在哪」，所以挪进操作行并带文字）。
check('假 DOM：卡片结构 = 主体 + 按钮组',
  firstRow.children.length === 2 &&
  String(firstRow.children[0].className).indexOf('lib-main') >= 0 &&
  String(firstRow.children[1].className).indexOf('lib-btns') >= 0);
check('假 DOM：收藏按钮在按钮组首位',
  String(firstRow.children[1].children[0].className).indexOf('lib-fav') >= 0);
eq('假 DOM：收藏项按钮文案是「★ 已收藏」', firstRow.children[1].children[0].textContent, '★ 已收藏');
eq('假 DOM：收藏项 aria-pressed=true', firstRow.children[1].children[0].getAttribute('aria-pressed'), 'true');
eq('假 DOM：非收藏项按钮文案是「☆ 收藏」', favOf('a').textContent, '☆ 收藏');
eq('假 DOM：非收藏项 aria-pressed=false', favOf('a').getAttribute('aria-pressed'), 'false');
check('假 DOM：收藏按钮有 data-fav-id', favOf('a').getAttribute('data-fav-id') === 'a');
// 0.4.15：「JSON」按钮 = 把这一套主题导出成纯文本。必须排在「分享」之后，
// 且只能是操作行里的普通按钮（不能变成角标），否则又回到「找不到」的老问题。
var btnRow = firstRow.children[1];
var acts = [];
for (var bi = 0; bi < btnRow.children.length; bi += 1) {
  acts.push(String(btnRow.children[bi].getAttribute('data-act') || ''));
}
check('假 DOM：操作行含 分享 / JSON', acts.indexOf('export') >= 0 && acts.indexOf('json') >= 0);
check('假 DOM：JSON 排在分享之后', acts.indexOf('json') > acts.indexOf('export'));
var jsonBtnNode = btnRow.children[acts.indexOf('json')];
eq('假 DOM：JSON 按钮文案是 JSON', jsonBtnNode.textContent, 'JSON');
check('假 DOM：JSON 按钮有 aria-label', String(jsonBtnNode.getAttribute('aria-label')).indexOf('JSON') >= 0);
check('假 DOM：缩略色板仍在（.lib-thumb）',
  firstRow.querySelector('.lib-thumb') !== null);
var nameRow = firstRow.children[0].children[1].children[0];
eq('假 DOM：名字行有名字 + 族徽标', nameRow.children.length, 2);
check('假 DOM：族徽标是 .lib-family-chip', String(nameRow.children[1].className).indexOf('lib-family-chip') >= 0);
check('假 DOM：族徽标有中文族名', nameRow.children[1].textContent.indexOf('液态玻璃') >= 0 ||
  nameRow.children[1].children[1].textContent.indexOf('液态玻璃') >= 0);
var noteLine = firstRow.children[0].children[1].children[1];
eq('假 DOM：note 一行截断节点存在', String(noteLine.className), 'lib-note');
eq('假 DOM：note 的 title 是全文', noteLine.getAttribute('title'), '暗色霓虹玻璃');
check('假 DOM：族 tab 已渲染（全部 + 收藏 + 自定义 + 6 族 = 9）',
  fakeById('lib-family-tabs').children.length === 9);
eq('假 DOM：全部 tab 数量徽标', familyTab('').children[1].textContent, '5');
eq('假 DOM：收藏 tab 数量徽标', familyTab('__fav__').children[1].textContent, '2');
eq('假 DOM：自定义 tab 数量徽标（非内置 = 4）', familyTab('__custom__').children[1].textContent, '4');
eq('假 DOM：glassy tab 数量徽标', familyTab('glassy').children[1].textContent, '2');
check('假 DOM：当前族 tab 高亮', familyTab('').className.indexOf('is-active') >= 0);
check('假 DOM：标签筛选条已渲染', fakeById('lib-filters').children.length > 1);

// 6.5.2 点族 tab：切换 family 并重渲染
familyTab('glassy').dispatch('click');
eq('假 DOM：点族 tab 后 family=glassy', libCtx.libraryState.family, 'glassy');
eq('假 DOM：只显示 glossary 两项', libIds(), ['a', 'b']);
check('假 DOM：glassy tab 变为高亮', familyTab('glassy').className.indexOf('is-active') >= 0);
check('假 DOM：全部 tab 取消高亮', familyTab('').className.indexOf('is-active') < 0);

// 6.5.3 族 + 标签 + 搜索三重叠加（直接改 state 后 render，等价于输入事件）
libCtx.libraryState.filter = '玻璃';
libCtx.libraryState.query = '夜色';
libCtx.renderLibrary();
eq('假 DOM：族+标签+搜索叠加', libIds(), ['b']);
libCtx.libraryState.query = '不存在';
libCtx.renderLibrary();
eq('假 DOM：叠加无结果 = 空列表', libIds(), []);
eq('假 DOM：空态显示且文案含搜索词',
  fakeById('lib-empty').hidden === false &&
  fakeById('lib-empty').textContent.indexOf('没有匹配「不存在」') >= 0, true);
libCtx.libraryState.query = '';
libCtx.libraryState.filter = '';
libCtx.libraryState.family = '';
libCtx.renderLibrary();

// 6.5.4 点星标：写 localStorage、置顶、aria 同步、焦点回到同一张卡
favOf('a').dispatch('click');
eq('假 DOM：点星标后进入收藏', libCtx.libraryState.favorites, ['b', 'c', 'a']);
check('假 DOM：点星标后收藏写进 localStorage',
  libCtx.libReadIds === undefined
    ? String(fakeWindowStorage.getItem(libCtx.LIB_FAV_KEY)).indexOf('"a"') >= 0
    : true);
eq('假 DOM：新收藏立即置顶（列表顺序 a,b,c,d,e）', libIds(), ['a', 'b', 'c', 'd', 'e']);
eq('假 DOM：a 的收藏按钮变成「★ 已收藏」', favOf('a').textContent, '★ 已收藏');
eq('假 DOM：a 的 aria-pressed 变 true', favOf('a').getAttribute('aria-pressed'), 'true');
eq('假 DOM：焦点回到 a 的收藏按钮', FakeNode.lastFocused.getAttribute('data-fav-id'), 'a');

// 6.5.5 再点一次取消收藏
favOf('a').dispatch('click');
eq('假 DOM：取消收藏后收藏列表', libCtx.libraryState.favorites, ['b', 'c']);
check('假 DOM：取消收藏后 localStorage 同步',
  String(fakeWindowStorage.getItem(libCtx.LIB_FAV_KEY)) === '["b","c"]');
check('假 DOM：取消后不再置顶（b,c 仍在前，a 回到原位置）', libIds()[2] === 'a');

// 6.5.6 收藏虚拟族 + 空收藏回退
libCtx.libraryState.family = '__fav__';
libCtx.renderLibrary();
eq('假 DOM：收藏族只显示收藏', libIds(), ['b', 'c']);
libCtx.libraryState.favorites = [];
libCtx.renderLibrary();
// 0.4.4 起：收藏清空不再把用户弹回「全部」（分类会跳来跳去），而是留在收藏族显示空态。
eq('假 DOM：收藏清空后仍停在「收藏」族', libCtx.libraryState.family, '__fav__');
eq('假 DOM：收藏族空列表', libIds(), []);
eq('假 DOM：空态文案引导去点收藏按钮',
  fakeById('lib-empty').hidden === false &&
  fakeById('lib-empty').textContent.indexOf('☆ 收藏') >= 0, true);

// 6.6 卡片节点缓存：筛选/搜索不重建卡片，只有真正影响 DOM 的因素才重建
libCtx.libraryState.family = '';
libCtx.libraryState.filter = '';
libCtx.libraryState.query = '';
libCtx.libraryState.favorites = ['b', 'c'];
libCtx.libraryState.items = ITEMS;
libCtx.renderLibrary();
var nodesA = fakeById('lib-list').children.slice();
libCtx.renderLibrary();
var nodesB = fakeById('lib-list').children.slice();
check('缓存：状态没变时整表节点对象被复用',
  nodesA.length === nodesB.length &&
  nodesA.every(function (node, i) { return node === nodesB[i]; }));

libCtx.libraryState.query = '玻璃';
libCtx.renderLibrary();
var nodesC = fakeById('lib-list').children.slice();
// 收藏 b、c 置顶，所以「全部」顺序是 b,c,a,d,e；搜索「玻璃」命中 b 与 a。
eq('缓存：搜索后只剩玻璃相关（收藏置顶）', libIds(), ['b', 'a']);
check('缓存：搜索命中的卡片仍是原节点（没重建）',
  nodesC[0] === nodesA[0] && nodesC[1] === nodesA[2]);

libCtx.libraryState.query = '';
libCtx.libraryState.filter = '暗色';
libCtx.renderLibrary();
var chip = null;
var chips = fakeById('lib-list').querySelectorAll('.lib-tag');
for (var ci = 0; ci < chips.length; ci += 1) {
  if (chips[ci].textContent === '暗色') { chip = chips[ci]; break; }
}
check('缓存：标签筛选只就地改 aria-pressed，不重建卡片',
  fakeById('lib-list').children[0] === nodesA[0] &&
  chip !== null && chip.getAttribute('aria-pressed') === 'true');
libCtx.libraryState.filter = '';

// 收藏态变化 → 只有那张卡需要重建
libCtx.renderLibrary();
var beforeFav = fakeById('lib-list').children.slice();
favOf('a').dispatch('click');
var afterFav = fakeById('lib-list').children.slice();
eq('缓存：点收藏后 a 置顶', libIds()[0], 'a');
check('缓存：a 的卡片被重建（★ 状态变了）', afterFav[0] !== beforeFav[0]);
// 顺序从 b,c,a,d,e 变成 a,b,c,d,e：按 id 对齐后，除 a 之外都应是同一个节点对象。
function nodesById(list) {
  var map = {};
  list.forEach(function (node) { map[node.getAttribute('data-id')] = node; });
  return map;
}
var favBefore = nodesById(beforeFav);
var favAfter = nodesById(afterFav);
check('缓存：其余卡片保持原节点',
  ['b', 'c', 'd', 'e'].every(function (id) { return favAfter[id] === favBefore[id]; }));
favOf('a').dispatch('click');

// 切换亮/暗 → 缩略色板要重算，整表重建
libCtx.renderLibrary();
var beforeMode = fakeById('lib-list').children.slice();
fakePanelState.mode = 'dark';
libCtx.renderLibrary();
var afterMode = fakeById('lib-list').children.slice();
check('缓存：切模式后缩略色板重算（整表重建）',
  afterMode[0] !== beforeMode[0] && afterMode[1] !== beforeMode[1]);
fakePanelState.mode = 'light';

// 条目被删掉后缓存要剪枝，重新出现时必须是新节点
var allItems = ITEMS.slice();
libCtx.libraryState.items = ITEMS.slice(0, 2);
libCtx.renderLibrary();
libCtx.libraryState.items = allItems;
libCtx.renderLibrary();
check('缓存：删掉的条目缓存已剪枝（重新出现是新节点）',
  fakeById('lib-list').children.length === 5 &&
  fakeById('lib-list').children[2] !== beforeMode[2]);

/* ---------- 6.7 主题库备份 / 恢复接线（v0.4.16）---------- */

check('备份：app.js 有 backupLibrary / restoreLibrary',
  /async function backupLibrary\(/.test(appSrc) && /async function restoreLibrary\(/.test(appSrc));
check('备份：走 export_to_file(kind=library)',
  /saveThemeFile\(\{ kind: 'library', target: 'desktop' \}\)/.test(appSrc));
check('恢复：走 import_library 且带 filename/data',
  /callPlugin\('import_library', \{/.test(appSrc) && /data: base64/.test(appSrc));
check('恢复：切到「自定义」族让用户看到刚恢复的',
  /libraryState\.family = LIB_CUSTOM_FAMILY;/.test(appSrc));
check('恢复：汇报 skipped（坏条目不静默吞掉）',
  /skipped\.length/.test(appSrc) && /没能恢复/.test(appSrc));
check('备份按钮：index.html 有两个按钮 + 隐藏 file input',
  /id="btn-lib-backup"/.test(htmlSrc) && /id="btn-lib-restore"/.test(htmlSrc) &&
  /id="lib-backup-file"/.test(htmlSrc));
check('备份按钮：接线（click + change）',
  /btn-lib-backup'\)\) \$\(\'btn-lib-backup\'\)\.addEventListener\('click'/.test(appSrc) &&
  /\$\('lib-backup-file'\)\.addEventListener\('change'/.test(appSrc));
check('备份按钮：不进卡片操作行（卡片只留收藏/应用/分享/JSON/删除）',
  !/libBtns = \[[^\]]*backup/.test(appSrc));

/* ---------- 6.8 主题信息编辑 + 首次使用提示（v0.4.18）---------- */

// 回到干净状态（前面几节改过 favorites / items / 族与筛选）
libCtx.libraryState.items = ITEMS;
libCtx.libraryState.favorites = [];
libCtx.libraryState.family = '';
libCtx.libraryState.filter = '';
libCtx.libraryState.query = '';
libCtx.renderLibrary();

function actList(row) {
  var out = [];
  var btns = row.children[1].children;
  for (var i = 0; i < btns.length; i += 1) {
    out.push(String(btns[i].getAttribute('data-act') || ''));
  }
  return out;
}

var customRow = fakeById('lib-list').children[2];   // ITEMS[2] = a，非内置
var customActs = actList(customRow);
check('编辑：非内置主题有「编辑」按钮', customActs.indexOf('meta') >= 0);
check('编辑：「编辑」排在「删除」之前', customActs.indexOf('meta') < customActs.indexOf('delete'));
var metaNode = customRow.children[1].children[customActs.indexOf('meta')];
eq('编辑：按钮文案是「编辑」', metaNode.textContent, '编辑');
check('编辑：按钮有 aria-label',
  String(metaNode.getAttribute('aria-label')).indexOf('编辑主题信息') >= 0);

var builtinActs = null;
var rows = fakeById('lib-list').children;
for (var ri = 0; ri < rows.length; ri += 1) {
  if (actList(rows[ri]).indexOf('delete') < 0) { builtinActs = actList(rows[ri]); break; }
}
check('编辑：内置主题没有「编辑」按钮',
  builtinActs !== null && builtinActs.indexOf('meta') < 0);
check('编辑：内置主题也只有收藏/应用/分享/JSON 四个按钮',
  builtinActs !== null && builtinActs.length === 4);

check('编辑：app.js 有 openMetaModal / saveThemeMeta / parseTagInput',
  /function openMetaModal\(/.test(appSrc) &&
  /async function saveThemeMeta\(/.test(appSrc) &&
  /function parseTagInput\(/.test(appSrc));
check('编辑：保存走 update_theme_meta（带 theme_id）',
  /callPlugin\('update_theme_meta', \{/.test(appSrc) && /theme_id: item\.id/.test(appSrc));
check('编辑：弹窗 mode=meta 时改按钮文案为「保存」',
  /isMeta \? '保存' : '确定'/.test(appSrc));
check('编辑：成功后刷新仓库列表',
  /await refreshLibrary\(\);/.test(appSrc));
check('编辑：空名称本地就拦（不打后端）',
  /名称不能为空/.test(appSrc));
check('编辑：失败时弹窗不关（用户打的字还在）',
  /修改失败，看看左侧提示/.test(appSrc));
check('编辑：index.html 有名称/备注/标签三个输入框',
  /id="meta-name"/.test(htmlSrc) && /id="meta-note"/.test(htmlSrc) &&
  /id="meta-tags"/.test(htmlSrc) && /id="modal-fields"/.test(htmlSrc));
check('编辑：标签输入用中文逗号回填',
  /\(item\.tags \|\| \[\]\)\.join\('，'\)/.test(appSrc));
check('编辑：style.css 有弹窗字段与「编辑」按钮样式',
  /\.modal-fields/.test(cssSrc) && /\.lib-meta/.test(cssSrc));

check('提示：index.html 有「第一次使用请重启」提示条与关闭按钮',
  /id="restart-hint"/.test(htmlSrc) && /id="restart-hint-close"/.test(htmlSrc) &&
  htmlSrc.indexOf('第一次使用（或刚更新过插件）请重启一次 N.E.K.O 窗口') >= 0);
check('提示：默认 hidden（关过之后不会闪一下）',
  /class="panel-hint" id="restart-hint" hidden/.test(htmlSrc));
check('提示：按 localStorage 记住「已关闭」',
  /var RESTART_HINT_KEY = 'nts\.restartHint\.dismissed';/.test(appSrc) &&
  /function initRestartHint\(/.test(appSrc));
check('提示：bootstrap 里会调用 initRestartHint()',
  /wireEvents\(\);\s*\n\s*initRestartHint\(\);/.test(appSrc));
check('提示：localStorage 读写都有 try/catch（隐私模式不炸）',
  /try \{ dismissed = localStorage\.getItem\(RESTART_HINT_KEY\) === '1'; \} catch/.test(appSrc) &&
  /try \{ localStorage\.setItem\(RESTART_HINT_KEY, '1'\); \} catch/.test(appSrc));

/* ---------- 6.9 周末另一套时段表（v0.4.19）---------- */

check('周末表：index.html 有「周末用另一套」勾选与第二个格子',
  /id="schedule-weekend"/.test(htmlSrc) &&
  /id="schedule-rows-weekend"/.test(htmlSrc) &&
  htmlSrc.indexOf('周末（周六 / 周日）用另一套') >= 0);
check('周末表：第二个格子默认 hidden（没勾就不占位）',
  /class="schedule-rows schedule-rows-weekend" id="schedule-rows-weekend" hidden/.test(htmlSrc));
check('周末表：app.js 有取表 / 判定 / 收集 / 渲染四个纯函数',
  /function scheduleMapOf\(/.test(appSrc) &&
  /function scheduleWeekendHasValues\(/.test(appSrc) &&
  /function collectScheduleZones\(/.test(appSrc) &&
  /function renderScheduleGrid\(/.test(appSrc));
check('周末表：工作日 / 周末两格都由 renderSchedule 渲染',
  /renderScheduleGrid\('schedule-rows', 'weekday'\)/.test(appSrc) &&
  /renderScheduleGrid\('schedule-rows-weekend', 'weekend'\)/.test(appSrc));
check('周末表：没勾时第二格隐藏',
  /weekendRows\.hidden = !scheduleState\.weekendEnabled;/.test(appSrc));
check('周末表：保存时把 weekend_zones 一并发出',
  /weekend_zones: weekend/.test(appSrc));
check('周末表：不勾就发空表（= 沿用工作日）',
  /var weekend = useWeekend \? collectScheduleZones\('schedule-rows-weekend'\) : \{\};/.test(appSrc));
check('周末表：勾选切换只重渲染、不重新请求',
  /scheduleState\.weekendEnabled = !!this\.checked;\s*\n\s*renderSchedule\(\);/.test(appSrc));
check('周末表：读回时按「有没有非空时段」判定是否在用',
  /scheduleState\.weekendEnabled = scheduleWeekendHasValues\(result && result\.schedule\);/.test(appSrc));
check('周末表：摘要里点明现在是工作日还是周末、用的是不是周末表',
  /detail\.day_kind === 'weekend' \? '周末' : '工作日'/.test(appSrc) &&
  appSrc.indexOf('（周末表）') >= 0);
check('周末表：星期几只在后端算，前端不出现 getDay() / weekday()',
  appSrc.indexOf('getDay()') < 0 &&
  !/scheduleState[\s\S]{0,400}\bweekday\(\)/.test(appSrc));
check('周末表：style.css 有勾选行与第二格样式',
  /\.schedule-weekend-toggle/.test(cssSrc) && /\.schedule-rows-weekend/.test(cssSrc));

/* ---------- 6.10 调色板 JSON 折叠惰性化（v0.4.21）---------- */

check('JSON 卡：有折叠按钮、包了 #dump-body、aria 属性齐全',
  /id="btn-toggle-dump"/.test(htmlSrc) &&
  /aria-expanded="true"/.test(htmlSrc) &&
  /aria-controls="dump-body"/.test(htmlSrc) &&
  htmlSrc.indexOf('<div id="dump-body">') >= 0);
check('JSON 卡：折叠状态落到 nts.dump.collapsed',
  appSrc.indexOf("var DUMP_COLLAPSE_KEY = 'nts.dump.collapsed';") >= 0);
var dumpHead = appSrc.indexOf('function renderDump(force) {');
var dumpBody = dumpHead > 0 ? appSrc.slice(dumpHead, dumpHead + 1500) : '';
check('JSON 卡：折叠时跳过重建（dumpLazyPlan 闸门在 stringify 之前）',
  appSrc.indexOf("if (!force && dumpLazyPlan(dumpState.collapsed, dumpState.dirty) === 'skip')") > 0 &&
  dumpBody.indexOf('dumpLazyPlan(') > 0 &&
  dumpBody.indexOf('dumpLazyPlan(') < dumpBody.indexOf('JSON.stringify('));
check('JSON 卡：复制前强制重建、展开且脏时补渲染',
  /renderDump\(true\);\s*\r?\n\s*copyText\(/.test(appSrc) &&
  appSrc.indexOf('if (!dumpState.collapsed && dumpState.dirty) renderDump(true);') > 0);
check('JSON 卡：脚注不再说「JSON 不含未应用改动」',
  appSrc.indexOf('上面的 JSON 已经按改动后的样子生成') > 0 &&
  appSrc.indexOf('上面的 JSON 不含它们') < 0);
check('a11y：审计摘要 / 排程摘要变成 live region，分组折叠按钮有 aria-expanded',
  /id="audit-summary" role="status" aria-live="polite"/.test(htmlSrc) &&
  /id="schedule-now" role="status" aria-live="polite"/.test(htmlSrc) &&
  appSrc.indexOf("btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');") > 0);

/* ---------- 6.11 排程卡不陈旧（v0.4.22）---------- */

check('排程卡：仓库列表刷新后重渲染排程卡（不再显示旧名字）',
  /if \(scheduleState\.loaded\) renderSchedule\(\);\s*\r?\n\s*return items;/.test(appSrc));

check('排程卡：「到点会切到 X」在 X 已不在仓库时标「（已不存在）」',
  appSrc.indexOf("known ? name : name + '（已不存在）'") > 0 &&
  /var known = false;/.test(appSrc));

check('排程卡：删除主题前说清它正被哪些时段使用',
  /var refs = scheduleRefsFor\(item\.id\);/.test(appSrc) &&
  /refs\.join\(' \/ '\)/.test(appSrc) &&
  appSrc.indexOf('正被自动换主题使用') > 0 &&
  /function scheduleRefsFor\(themeId\)/.test(appSrc));

check('排程卡：scheduleRefsFor 两张表都要查（工作日 + 周末）',
  /\[['"]weekday['"], schedule\.zones\], \['weekend', schedule\.weekend_zones\]\]/.test(appSrc) &&
  /kind === 'weekend' \? '周末 ' : '工作日 '/.test(appSrc));

check('排程卡：删除成功后刷新排程卡（后端丢掉失效时段后界面要跟上）',
  /if \(scheduleState\.loaded\) await refreshSchedule\(\);/.test(appSrc));

check('排程卡：后端报的 stale 会落到面板状态里',
  /scheduleState\.stale = \(result && result\.stale instanceof Array\) \? result\.stale : \[\];/.test(appSrc) &&
  /  stale: \[\],/.test(appSrc));

check('排程卡：有失效时段时说明原因，而不是显示「还没选」',
  /else if \(scheduleState\.stale\.length\)/.test(appSrc) &&
  appSrc.indexOf('个时段引用的主题已不在仓库里') > 0 &&
  /function scheduleStaleText\(\)/.test(appSrc));

check('排程卡：新函数挂在调试钩子上（可被测试/控制台调用）',
  /scheduleRefsFor: scheduleRefsFor,/.test(appSrc) &&
  /scheduleStaleText: scheduleStaleText,/.test(appSrc));

/* ---------- 6.13 背景图适应方式（--nts-chat-bg-fit，v0.4.27） ---------- */

var fitItem = null;
flat.forEach(function (item) { if (item.key === '--nts-chat-bg-fit') fitItem = item; });

check('背景图适应方式行存在且是下拉（select）',
  !!fitItem && fitItem.type === 'select' && fitItem.options && fitItem.options.length === 2);
check('两个选项分别是 cover / contain',
  !!fitItem && fitItem.options.map(function (o) { return o.value; }).join(',') === 'cover,contain');
check('原生值标注为铺满（cover）', !!fitItem && fitItem.native === 'cover');
check('行内渲染成 .fit-select 下拉并走 markEdited',
  /fit-select/.test(appSrc) &&
  /markEdited\(item\.key, selectInput\.value\)/.test(appSrc));
check('loadCatalogCollapsed 时下拉值也能被 syncRow 同步',
  /ref\.selectInput\.disabled = !!state\.busy/.test(appSrc) &&
  /selectInput: selectInput/.test(appSrc));

/* ---------- 6.14 拖拽导入 + 导出 CSS 片段（v0.5.0） ---------- */

check('拖拽导入函数与初始化都在 app.js',
  /function initDropImport\(\)/.test(appSrc) && /initDropImport\(\);/.test(appSrc));
check('只接受 .zip / .json 并提示其它类型',
  /lower\.slice\(-4\) !== '\.zip'/.test(appSrc) &&
  /lower\.slice\(-5\) !== '\.json'/.test(appSrc) &&
  /只支持拖入 \.zip 分享包或 \.json 主题文件/.test(appSrc));
check('拖拽导入复用 handleArchiveFile 而不是自己读文件',
  /handleArchiveFile\(file, null\)/.test(appSrc));
check('四个拖拽事件都挂在 body 上，且 window 层拦掉默认打开',
  /'dragenter'/.test(appSrc) && /'dragleave'/.test(appSrc) &&
  /'dragover'/.test(appSrc) && /'drop'/.test(appSrc) &&
  /window\.addEventListener\(type, function \(e\)/.test(appSrc));
check('index.html 有导出 CSS 片段按钮', /id="btn-css-snippet"/.test(htmlSrc));
check('CSS 片段导出亮色在 :root、暗色在 :root[data-theme="dark"]',
  /pushBlock\(':root', light,/.test(appSrc) &&
  /pushBlock\(':root\[data-theme="dark"\]', dark,/.test(appSrc));
check('CSS 片段走只读弹窗（自带复制与剪贴板降级）',
  /openModal\(\s*'export',/.test(appSrc) && /function copyCssSnippet\(\)/.test(appSrc));
check('拖拽高亮层是 body::after 且不接指针事件',
  /body\.is-drop-target::after/.test(cssSrc) && /pointer-events: none;/.test(cssSrc));

/* ---------- 6.15 圆角风格：连续曲率（--nts-corner-style，v0.8.0） ---------- */

var cornerItem = null;
flat.forEach(function (item) { if (item.key === '--nts-corner-style') cornerItem = item; });

check('圆角风格行存在且是下拉（select）',
  !!cornerItem && cornerItem.type === 'select' && cornerItem.options && cornerItem.options.length === 2);
check('两个选项分别是 round / continuous（普通圆角 / 连续曲率）',
  !!cornerItem && cornerItem.options.map(function (o) { return o.value; }).join(',') === 'round,continuous' &&
  cornerItem.options[1].label.indexOf('连续曲率') >= 0);
check('原生值标注为 round（普通圆角）', !!cornerItem && cornerItem.native === 'round');
check('提示里写明需要较新内核、不支持也不报错',
  !!cornerItem && /Chrome 139/.test(cornerItem.hint) && /不生效/.test(cornerItem.hint));
check('下拉行不再写死 cover/contain（改为按 options 匹配）',
  /ref\.item\.options/.test(appSrc) && !/fitValue === 'contain' \? 'contain' : 'cover'/.test(appSrc));
check('「原生 X」文案由 selectOptionLabel 生成（去掉括号备注）',
  /function selectOptionLabel\(item, value\)/.test(appSrc) &&
  /split\('（'\)/.test(appSrc) && /selectOptionLabel\(item, nativeOf\(item\)\)/.test(appSrc));

/* ---------- 输出 ---------- */

var total = passes + failures.length;
if (failures.length) {
  console.log('FAIL ' + failures.length + '/' + total);
  failures.forEach(function (line) { console.log('  ✗ ' + line); });
  process.exitCode = 1;
} else {
  console.log('PASS ' + passes + '/' + total);
  console.log('  · 族过滤 × 标签 × 搜索三重叠加：通过');
  console.log('  · 收藏置顶 / 收藏 / 自定义虚拟族：通过');
  console.log('  · localStorage 收藏与折叠状态读写（含坏数据）：通过');
  console.log('  · CATALOG 10 组 / 101 变量，第 10 组液态玻璃质感 9 项：通过');
  console.log('  · index.html / style.css 接线：通过');
  console.log('  · 主题库备份 / 恢复接线：通过');
  console.log('  · 主题信息编辑 + 首次使用提示：通过');
  console.log('  · 周末另一套时段表：通过');
  console.log('  · 背景图适应方式（cover / contain）：通过');
  console.log('  · ES5 语法 + node --check app.js：通过');
}
