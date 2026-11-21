#!/usr/bin/env node
/**
 * materials-selftest.js -- 高级材质中心（面板侧）的静态契约测试。
 *
 * 面板不跑在 node 里（要 DOM + 宿主 iframe），所以这里测的不是渲染结果，
 * 而是三处最容易漂移的接缝：
 *
 *   1. 参数表：materials.py 定义 90 个参数，materials.js 的 GROUPS 必须恰好覆盖
 *      同一组 key —— 少一个 = 某个滑块根本没渲染（用户以为功能缺失）；
 *      多一个 = 渲染了一个后端编译不出来的键（拖了没反应）。
 *   2. 导航：需求要求 10 个设置界面，逐个钉住 id，防止后来合并/删除。
 *   3. 三条接线：app.js 暴露 window.NekoPanel（材质中心调 entry 的唯一通道）、
 *      applyTheme 提交 materials、reloadPalette 回灌材质基线。任一断掉都表现为
 *      「材质中心能改，但点了应用不生效」或「导入主题后材质仍显示未应用」。
 *
 * 另外校验 ?v= 的内容指纹与磁盘文件一致（否则 48911 的一年 immutable 缓存
 * 会让用户永远看到旧面板）。
 *
 *    node test/materials-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..');
var pass = 0;
var fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

var CR = String.fromCharCode(13);
var BT = String.fromCharCode(96);

function lines(text) {
  return text.split(String.fromCharCode(10)).map(function (line) {
    return line.split(CR).join('');
  });
}

/* ---------------- 1. 参数表对齐 ---------------- */

var pyKeys = [];
var inParams = false;
lines(read('plugin/materials.py')).forEach(function (line) {
  var t = line.trim();
  if (t.indexOf('_RAW_PARAMS') === 0) { inParams = true; return; }
  if (!inParams) return;
  if (t === ')') { inParams = false; return; }
  if (t.indexOf('Param("') !== 0) return;
  var end = t.indexOf('"', 7);
  if (end > 7) pyKeys.push(t.slice(7, end));
});

var jsText = read('plugin/static/materials.js');
var jsLines = lines(jsText);
var tabIds = [];
var inTabs = false;
jsLines.forEach(function (line) {
  var t = line.trim();
  if (t.indexOf('var TABS') === 0) { inTabs = true; return; }
  if (inTabs && t.indexOf('];') === 0) { inTabs = false; return; }
  if (!inTabs) return;
  var at = t.indexOf("id: '");
  if (at < 0) return;
  tabIds.push(t.slice(at + 5, t.indexOf("'", at + 5)));
});

var groupKeys = [];
var inGroups = false;
jsLines.forEach(function (line) {
  var t = line.trim();
  if (t.indexOf('var GROUPS') === 0) { inGroups = true; return; }
  if (inGroups && t.indexOf('};') === 0) { inGroups = false; return; }
  if (!inGroups) return;
  var at = t.indexOf('keys: [');
  if (at < 0) return;
  var body = t.slice(at + 7, t.lastIndexOf(']'));
  body.split(',').forEach(function (part) {
    var value = part.trim();
    while (value.charAt(0) === "'") value = value.slice(1);
    while (value.charAt(value.length - 1) === "'") value = value.slice(0, -1);
    if (value) groupKeys.push(value);
  });
});

var EXPECTED_TABS = ['overview', 'base', 'dye', 'light', 'refract', 'liquid', 'surface', 'anim', 'components', 'presets'];
ok('恰好 10 个导航界面', tabIds.length === 10, '实际 ' + tabIds.length + '：' + tabIds.join(','));
ok('10 个导航 id 与需求一致', EXPECTED_TABS.every(function (id) { return tabIds.indexOf(id) >= 0; }), tabIds.join(','));
ok('参数表共 90 个', pyKeys.length === 90, '实际 ' + pyKeys.length);

var missing = pyKeys.filter(function (key) { return groupKeys.indexOf(key) < 0; });
var extra = groupKeys.filter(function (key) { return pyKeys.indexOf(key) < 0; });
ok('面板覆盖后端的每一个参数', missing.length === 0, '缺 ' + missing.join(','));
ok('面板没有渲染不存在的参数', extra.length === 0, '多 ' + extra.join(','));
ok('参数没有重复渲染', groupKeys.length === pyKeys.length, groupKeys.length + ' vs ' + pyKeys.length);

/* ---------------- 2. 三条接线 ---------------- */

var appJs = read('plugin/static/app.js');
var html = read('plugin/static/index.html');

ok('app.js 暴露 window.NekoPanel', appJs.indexOf('window.NekoPanel = window.NekoPanel || {') >= 0);
ok('NekoPanel 提供 call / toast', appJs.indexOf('call: function (entryId, args)') >= 0 && appJs.indexOf('toast: function (message, kind)') >= 0);
// 0.15.48：失败结果必须剥掉宿主包装，否则用户只看到 INTERNAL + 两段 execution failed。
ok('失败结果走 pluginErrorMessage 剥宿主包装', appJs.indexOf('throw new Error(pluginErrorMessage(rec.error) || rec.message || rec.status);') >= 0);
ok('失败结果不再直传双层 execution failed 原文', appJs.indexOf('throw new Error((rec.error && rec.error.message) || rec.message || rec.status);') < 0);
ok('applyTheme 提交材质', appJs.indexOf('args.materials = materials') >= 0);
ok('reloadPalette 回灌材质基线', appJs.indexOf('syncMaterials(palette)') >= 0);
ok('重置失败时清材质编辑态', appJs.indexOf('resetMaterialsLocal()') >= 0);

ok('index.html 挂载 materials-root', html.indexOf('id="materials-root"') >= 0);
ok('index.html 引入 materials.css', html.indexOf('materials.css?v=') >= 0);
ok('index.html 引入 materials.js', html.indexOf('materials.js?v=') >= 0);

ok('材质中心调用 material_spec', jsText.indexOf("callEntry('material_spec'") >= 0);
ok('材质中心调用 preview_materials', jsText.indexOf("callEntry('preview_materials'") >= 0);
ok('预览变量前缀与加载器一致', jsText.indexOf('--nts-mt-') >= 0 && read('plugin/static/loader/neko-theme-studio.js').indexOf("--nts-mt-") >= 0);
/* 液态玻璃光学层：这些派生变量是「滑块真的动了观感」的载体。
   三处必须同时存在 —— 后端编译出来、加载器真的用它、面板预览也用它。
   任何一处缺失，表现就是预览里有玻璃、应用里没有（或反之）。 */
var loaderSrc = read('plugin/static/loader/neko-theme-studio.js');
var mtCssSrc = read('plugin/static/materials.css');
var pySrc = read('plugin/materials.py');
var OPTICS = [
  '--nts-mt-sheen-img', '--nts-mt-inner-img', '--nts-mt-ambient-img',
  '--nts-mt-lens-glow', '--nts-mt-lens-blur', '--nts-mt-heel',
  '--nts-mt-disp-blur', '--nts-mt-under-glow', '--nts-mt-drift-size'
];
for (var oi = 0; oi < OPTICS.length; oi++) {
  var ov = OPTICS[oi];
  ok('后端编译出 ' + ov, pySrc.indexOf(ov) >= 0);
  ok('加载器消费 ' + ov, loaderSrc.indexOf(ov) >= 0);
}
/* 预览不重算编译，所以它必须直接吃这些派生变量；drift-size 只用于应用侧动画，预览不需要。 */
var PREVIEW_OPTICS = OPTICS.slice(0, 8);
for (var pi = 0; pi < PREVIEW_OPTICS.length; pi++) {
  ok('面板预览消费 ' + PREVIEW_OPTICS[pi], mtCssSrc.indexOf(PREVIEW_OPTICS[pi]) >= 0);
}
/* liquid 预设必须是苹果液态玻璃那套观感（而不是模糊的磨砂），文案也要跟上。 */
ok('liquid 预设标注为 Apple Liquid Glass', pySrc.indexOf('Liquid Glass (Apple)') >= 0);
ok('liquid 预设大圆角', /liquid[\s\S]{0,4000}?radius=2[0-9]/.test(pySrc));

/* ---------------- 2a. 材质随主题（v0.15.67） ---------------- */
/* 主题 = 颜色 + 高级材质。每套内置主题都必须自带材质，否则「多套主题共用一套
   材质」就会回流 —— 切主题只换颜色、玻璃永远是上一次那套。 */
var presetDir = path.join(ROOT, 'plugin/static/presets');
var presetFiles = fs.readdirSync(presetDir).filter(function (f) { return /\.json$/.test(f); });
var withMaterials = 0;
var matPresets = {};
for (var pf = 0; pf < presetFiles.length; pf++) {
  var presetRec = JSON.parse(fs.readFileSync(path.join(presetDir, presetFiles[pf]), 'utf8'));
  if (presetRec && presetRec.materials && typeof presetRec.materials === 'object') {
    withMaterials += 1;
    matPresets[String(presetRec.materials.preset || '')] = 1;
  }
}
ok('内置主题数量不少于 43', presetFiles.length >= 43, '实际 ' + presetFiles.length);
/* 0.15.68：内置主题拆成两套独立主题 —— 原主题只带颜色，另有一套「(材质)」
   主题带该族的完整材质。所以文件数必须是颜色版的两倍，且一一配对。 */
var colorIds = [];
var variantIds = [];
for (var pv = 0; pv < presetFiles.length; pv++) {
  var pst = presetFiles[pv].slice(0, -5);
  if (/-material$/.test(pst)) { variantIds.push(pst); } else { colorIds.push(pst); }
}
var missingVariant = 0;
var missingBase = 0;
for (var ci = 0; ci < colorIds.length; ci++) {
  if (variantIds.indexOf(colorIds[ci] + '-material') < 0) { missingVariant += 1; }
}
for (var vi = 0; vi < variantIds.length; vi++) {
  if (colorIds.indexOf(variantIds[vi].slice(0, -9)) < 0) { missingBase += 1; }
}
ok('颜色版与 (材质) 版一一配对', missingVariant === 0 && missingBase === 0, '缺材质版 ' + missingVariant + ' / 缺颜色版 ' + missingBase);
/* 0.15.70：颜色版不是「不带 materials」，而是显式 {"enabled": false}。
   缺了这条，从 (材质) 版切回配色版时玻璃会一直留着（用户实测到的 bug）。 */
var MAT_KEYS = { enabled: 1, lock: 1, version: 1 };
var colorOffOk = 0;
var colorLeak = [];
for (var cj = 0; cj < colorIds.length; cj++) {
  var crec = JSON.parse(fs.readFileSync(path.join(presetDir, colorIds[cj] + '.json'), 'utf8'));
  var cm = crec && crec.materials;
  if (!cm || typeof cm !== 'object') { colorLeak.push(colorIds[cj] + ': 缺 materials'); continue; }
  if (cm.enabled !== false) { colorLeak.push(colorIds[cj] + ': enabled 不是 false'); continue; }
  var badKey = null;
  for (var kk in cm) {
    if (Object.prototype.hasOwnProperty.call(cm, kk) && !MAT_KEYS[kk]) { badKey = kk; }
  }
  if (badKey) { colorLeak.push(colorIds[cj] + ': 多了键 ' + badKey); continue; }
  colorOffOk += 1;
}
ok('颜色版显式关闭高级材质', colorOffOk === colorIds.length, colorLeak.slice(0, 4).join(' / '));
var variantFull = 0;
for (var ck2 = 0; ck2 < variantIds.length; ck2++) {
  var vrec = JSON.parse(fs.readFileSync(path.join(presetDir, variantIds[ck2] + '.json'), 'utf8'));
  if (vrec && vrec.materials && vrec.materials.enabled === true) { variantFull += 1; }
}
ok('(材质) 版默认启用材质', variantFull === variantIds.length, variantFull + ' / ' + variantIds.length);
ok('材质按风格族分布（不是全同一套）', Object.keys(matPresets).length >= 4, Object.keys(matPresets).join(','));

ok('materials.js 有「跟随主题」开关', jsText.indexOf("id: 'mt-follow'") >= 0);
ok('跟随主题 = lock 的反面', jsText.indexOf('CURRENT.lock = !followBox.checked') >= 0);
ok('头部状态同步跟随开关', jsText.indexOf('follow.checked = !(CURRENT && CURRENT.lock)') >= 0);
ok('lock 变化计入待应用项目', jsText.indexOf('!!CURRENT.lock !== !!BASELINE.lock') >= 0);
ok('app.js 卡片显示材质徽标', appJs.indexOf('lib-material-chip') >= 0);
ok('app.js 切换主题提示材质已替换', appJs.indexOf('material_applied') >= 0);
ok('app.js 切换主题提示材质已锁定', appJs.indexOf('material_locked') >= 0);
ok('style.css 有材质徽标样式', read('plugin/static/style.css').indexOf('.lib-material-chip') >= 0);
ok('后端默认材质带 lock', pySrc.indexOf('"lock": False') >= 0 && pySrc.indexOf('clean["lock"]') >= 0);
ok('切主题尊重材质锁定', read('plugin/__init__.py').indexOf('locked_materials.get("lock")') >= 0);
var initSrc = read('plugin/__init__.py');
ok('只带开关的 materials 走补丁语义', initSrc.indexOf('material_patch = (') >= 0
  && initSrc.indexOf('<= {"enabled", "lock", "version"}') >= 0);
ok('返回 material_enabled 供面板区分「已换」与「已关」', initSrc.indexOf('"material_enabled": bool(') >= 0);
ok('面板对无材质主题显示「无材质」徽标', appJs.indexOf('lib-material-chip is-off') >= 0);
ok('面板提示已关闭高级材质', appJs.indexOf('已关闭高级材质（这套主题不带材质）') >= 0);

/* 0.15.71：自己做的主题也要能写简介 —— 像内置主题那样，卡片上显示、分享包带走。
   之前只有「先保存 → 再点卡片上的编辑 → 再填 note」这条绕路。 */
var indexSrc = read('plugin/static/index.html');
ok('保存区有简介输入框', indexSrc.indexOf('id="lib-note"') >= 0);
ok('简介输入框有 120 字上限', indexSrc.indexOf('maxlength="120"') >= 0);
ok('保存时把简介一起提交', appJs.indexOf("if (note) args.note = note;") >= 0);
ok('保存成功后清空简介输入框', appJs.indexOf('if (noteInput) noteInput.value =') >= 0);
ok('自定义条目没写简介时给编辑入口提示', appJs.indexOf('lib-note is-empty') >= 0);
ok('后端 save_theme 把简介落到条目上',
  initSrc.indexOf('note=note,') >= 0 && initSrc.indexOf('tags=tags,') >= 0);
ok('摘要返回简介与标签（存完卡片立即有）',
  initSrc.indexOf('"note": _theme_note(record.get("note")),') >= 0);
ok('简介随分享包导出', initSrc.indexOf('note=record.get("note")') >= 0);
ok('style.css 有简介输入框样式', read('plugin/static/style.css').indexOf('.lib-save-note textarea') >= 0);

/* ---------------- 2b. 组件落点必须命中宿主真实 DOM ---------------- */
/* 0.15.1 之前「设置」组件写的是 .settings-panel / .settings-view —— 宿主里
   一条定义都没有，调了自然没反应。钉住真实容器，防止再退回猜的类名。 */
ok('设置组件绑定到真实设置窗口容器', loaderSrc.indexOf('body.api-key-settings-page #main-content') >= 0);
ok('设置窗口内层卡片也接入（圆角落点）', loaderSrc.indexOf('body.api-key-settings-page .container') >= 0);
ok('不再使用宿主不存在的 .settings-panel', loaderSrc.indexOf('.settings-panel') < 0);
ok('不再使用宿主不存在的 .settings-view', loaderSrc.indexOf('.settings-view') < 0);
ok('设置窗口内层内容区不再留白底', loaderSrc.indexOf('body.api-key-settings-page .container-content') >= 0);
ok('设置窗口配置卡片跟随材质', loaderSrc.indexOf('body.api-key-settings-page .model-config-container') >= 0);
ok('设置窗口输入框跟随材质', loaderSrc.indexOf('body.api-key-settings-page .field-row input') >= 0);
ok('不再使用宿主不存在的 .chat-sidebar', loaderSrc.indexOf('.chat-sidebar') < 0);
ok('不再使用宿主不存在的 .neko-sidebar', loaderSrc.indexOf('.neko-sidebar') < 0);
ok('消息区组件落在真实 .message-list 上', loaderSrc.indexOf(':root[data-nts-mt] .message-list {') >= 0);

/* 0.15.32：设置窗口此前是单独的 3 层背景规则（0.15.3 写的），后续给聊天窗加
    inner2/rim/spot/noise/ambient/refract 时没有同步 —— 开设置窗口就少 6 层玻璃。
   现在它直接进基础面选择器列表，改一处两边一起变。 */
ok('设置窗口并入基础面规则（不再单独写背景）',
  loaderSrc.indexOf(':root[data-nts-mt]:root:root:root:root body.api-key-settings-page #main-content,') >= 0);
ok('设置窗口不再保留旧的 3 层背景规则',
  loaderSrc.indexOf('background-image: var(--nts-mt-inner-img), var(--nts-mt-sheen-img), var(--nts-mt-dye)') < 0);
/* 0.15.36：暗色主题下玻璃底必须压暗 —— 宿主暗色文字是浅色，白玻璃高不透明度
   就是白底浅字。压暗混入深灰而不是换纯黑，用户染色仍要透得出来。 */
ok('暗色玻璃底压暗（不再用白色 tint）',
  pySrc.indexOf('if dark_mode:') >= 0 &&
  pySrc.indexOf('_mix_rgb(tint, (16, 20, 28, 1.0), 0.62)') >= 0);

/* 0.15.35：消息区是整块滚动大面，背后是同一块窗玻璃 —— 模糊看不出，但滚动时
   每次都要整块重算 backdrop-filter。去掉模糊、背景/圆角/阴影保留。 */
ok('消息区不再参与背景模糊（滚动开销）',
  loaderSrc.indexOf(':root[data-nts-mt]:root:root:root body .message-list {') >= 0 &&
  loaderSrc.indexOf('backdrop-filter: none !important;') >= 0);

/* 0.15.34：设置窗口的壳在内层仍是全局变量（bg / border-width / radius-card / shadow），
   组件材质里的「设置」自定义只影响外壳、影响不到配置卡片 —— 组件级覆盖形同残废。 */
ok('设置页配置卡片改用组件别名',
  loaderSrc.indexOf('background-color: var(--nts-mt-bg-c) !important;') >= 0 &&
  loaderSrc.indexOf('border: var(--nts-mt-bw-c) solid var(--nts-mt-border) !important;') >= 0 &&
  loaderSrc.indexOf('border-radius: var(--nts-mt-radius-c) !important;') >= 0 &&
  loaderSrc.indexOf('box-shadow: var(--nts-mt-shadow-c) !important;') >= 0);
ok('设置页输入框也吃组件别名（圆角保留细分值）',
  loaderSrc.indexOf('border-radius: var(--nts-mt-radius-input) !important;') >= 0 &&
  loaderSrc.indexOf('background-color: var(--nts-mt-bg) !important;') < 0);

ok('设置窗口全屏不加圆角（只收 #main-content）',
  loaderSrc.indexOf('body.api-key-settings-page #main-content {') >= 0 &&
  loaderSrc.indexOf('border-radius: 0 !important;') >= 0);

/* 画质 saver：一屏二十个气泡就是二十层 backdrop-filter，模糊看不出却要付 GPU。 */
ok('saver 档高频小元素不再声明 backdrop-filter',
  loaderSrc.indexOf('[data-nts-mt-quality="saver"]:root:root body .message-bubble-user') >= 0);
ok('saver 档省电规则同时覆盖输入框/顶栏/消息区',
  loaderSrc.indexOf('[data-nts-mt-quality="saver"]:root:root body .composer-input-shell') >= 0 &&
  loaderSrc.indexOf('[data-nts-mt-quality="saver"]:root:root body .message-list') >= 0);

/* ---------------- 2c. 组件级材质的变量必须真被消费 ---------------- */
/* 0.15.4 前组件透明度/阴影强度从没生效：编译产出 --nts-mt-opacity-chat 与
   --nts-mt-shadow-strength-chat，而 CSS 读的是 --nts-mt-shadow-chat；圆角还撞名
   （全局 radiusDialog 与组件 dialog 同名），回退值写成自己导致整条声明无效。
   现在统一 --nts-mt-c-<prop>-<comp>，逐个钉住 10 组件 × 5 属性。 */
var COMPONENTS = ['chat', 'bubble', 'input', 'sidebar', 'topbar', 'settings', 'dialog', 'button', 'plugin', 'menu'];
var COMP_PROPS = ['bg', 'blur', 'radius', 'border-width', 'shadow'];
var compMissing = [];
for (var ci = 0; ci < COMPONENTS.length; ci++) {
  for (var cpi = 0; cpi < COMP_PROPS.length; cpi++) {
    var cvar = "--nts-mt-c-" + COMP_PROPS[cpi] + "-" + COMPONENTS[ci];
    if (loaderSrc.indexOf(cvar) < 0) compMissing.push(cvar);
  }
}
ok("组件材质 50 个变量都被加载器消费", compMissing.length === 0, compMissing.join(", "));
ok("materials.py 编译组件透明度", pySrc.indexOf("--nts-mt-c-bg-") >= 0);
ok("materials.py 编译组件阴影强度", pySrc.indexOf("--nts-mt-c-shadow-") >= 0);
ok("不再出现旧命名 --nts-mt-opacity-<comp> 的 CSS 消费", !/--nts-mt-opacity-[a-z]+,/.test(loaderSrc));
ok("不再出现旧命名 --nts-mt-shadow-<comp> 的 CSS 消费", !/--nts-mt-shadow-[a-z]+,/.test(loaderSrc));
ok("组件变量无自引用回退值", !/var\(--nts-mt-c-([a-z-]+)-([a-z]+),\s*var\(--nts-mt-c-\1-\2\)/.test(loaderSrc));
/* 省电模式必须真的少画层：把变量调透明只是「画了看不见」，图层仍在合成里。 */
ok("省电模式把装饰性多层渐变置 none", pySrc.indexOf('"--nts-mt-inner-img", "--nts-mt-inner2", "--nts-mt-sheen-img"') >= 0);

/* ---------------- 2d. 卸载可逆 + 复活尊重宿主开关（0.15.5） ---------------- */
/* 外部评分报告扣分最重的两条：加载器 404 时无条件复活插件（绕过宿主总开关），
   以及「卸载」只存在于仓库根的 uninstall.ps1（市场装的包里没有）。这里钉住两条闸门
   与面板入口，任何一条被删掉都会让「用户已卸载」重新变成「被偷偷装回来」。 */
ok('加载器用宿主注册表判停用', loaderSrc.indexOf('probeRuntimeGate') >= 0 && loaderSrc.indexOf('runtime_enabled') >= 0);
ok('不再用「本窗口跑过就永不复活」兜底', loaderSrc.indexOf('everRanOnce') < 0 && loaderSrc.indexOf('EVER_RAN_KEY') < 0);
ok('探测结果缓存带 30s 过期', loaderSrc.indexOf('PROBE_TTL_MS = 30000') >= 0 && loaderSrc.indexOf('Date.now() - runtimeGateAt') >= 0);
ok('降级段 8 层背景自带 size/position', loaderSrc.indexOf('background-size: auto, auto, auto, auto, auto, auto, auto, var(--nts-mt-drift-size)') >= 0 && loaderSrc.indexOf('background-position: 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0 0, 0% 50%') >= 0);
ok('基础面消费边缘镜面环带', loaderSrc.indexOf('var(--nts-mt-rim-img)') >= 0);
ok('边缘收暗进 box-shadow', loaderSrc.indexOf('calc(var(--nts-mt-edge-width) * 6) var(--nts-mt-rim-shade)') >= 0);
ok('sheen 角度跟随光照方向', pySrc.indexOf('var(--nts-mt-light-angle, 162deg)') >= 0);
ok('指针运行时写光照方向', loaderSrc.indexOf('--nts-mt-light-angle') >= 0);
ok('双向色散分成 warm/cool', loaderSrc.indexOf('var(--nts-mt-disp-warm)') >= 0 && loaderSrc.indexOf('var(--nts-mt-disp-cool)') >= 0);
ok('后端编译出 rim 与色散分色变量', pySrc.indexOf('--nts-mt-rim-img') >= 0 && pySrc.indexOf('--nts-mt-rim-shade') >= 0 && pySrc.indexOf('--nts-mt-disp-warm') >= 0 && pySrc.indexOf('--nts-mt-disp-cool') >= 0);
ok('漂移是慢速流动而非抖动', /120\.0 \/ max\(0\.5, float\(liq\.get\("liquidSpeed", 9\.0\)\)/.test(pySrc));
ok('底部折光亮线进 box-shadow', loaderSrc.indexOf('inset 0 calc(var(--nts-mt-edge-width) * -1.2) calc(var(--nts-mt-edge-width) * 1.8) var(--nts-mt-under-glow)') >= 0);
ok('环带层随漂移动画轻微游走', /50%\s*\{ background-position: 0 0, 0 0, 3% 3%/.test(loaderSrc));
/* 四个曾经是死滑块的参数：改值必须能改到被 loader 消费的变量上 */
ok('染料冷暖混进 dye 渐变', pySrc.indexOf('warmth > 0.0') >= 0 && pySrc.indexOf('_mix_rgb(dye_a') >= 0);
ok('液态强度计入染料浓度', pySrc.indexOf('liquid_gain = 0.55 + liq_strength * 0.9') >= 0);
ok('色散透明度计入 warm/cool', pySrc.indexOf('0.35 + disp_alpha * 1.2') >= 0);
ok('双层高光是可画的渐变', pySrc.indexOf('radial-gradient(circle at 28% 24%') >= 0 && loaderSrc.indexOf('var(--nts-mt-inner2)') >= 0);
ok('预览也画第二层内高光', mtCssSrc.indexOf('var(--nts-mt-inner-img, none), var(--nts-mt-inner2, none)') >= 0);
ok('平滑度是连续曲线而非三档', pySrc.indexOf('def _ease_curve(') >= 0 && pySrc.indexOf('cubic-bezier(') >= 0 && pySrc.indexOf('ease-in-out' + String.fromCharCode(32) + 'if smooth') < 0);

ok('编译产物版本能让旧镜像失效重算', /COMPILE_VERSION = "[0-9]+[.][0-9]+[.][0-9]+"/.test(pySrc) && read('plugin/__init__.py').indexOf('material_compile_version') >= 0);
ok('加载器上报实际 computed 材质值', loaderSrc.indexOf("var samples = {}") >= 0 && loaderSrc.indexOf("getComputedStyle(de)") >= 0 && loaderSrc.indexOf("'--nts-mt-under-glow'") >= 0);
ok('后端把采样值写进诊断记录', read('plugin/__init__.py').indexOf('sample_clean[key[:40]] = str(val)[:160]') >= 0 && read('plugin/__init__.py').indexOf('"samples": sample_clean') >= 0);
ok('加载器复活前读 disabled.json 镜像', loaderSrc.indexOf('/ui/disabled.json') >= 0);
ok('加载器有 probeDisabled 探测函数', loaderSrc.indexOf('probeDisabled') >= 0);
ok('复活被宿主开关挡住时有日志', loaderSrc.indexOf('revive skipped') >= 0);
ok('不再声称复活不依赖宿主开关', loaderSrc.indexOf('不依赖任何手工操作或宿主开关') < 0);
ok('面板复活前检查 disabled.json', appJs.indexOf('patchDetached') >= 0);
ok('面板提供卸载入口', appJs.indexOf("callPlugin('detach_theme'") >= 0);
ok('面板提供恢复入口', appJs.indexOf("callPlugin('restore_theme_patch'") >= 0);
ok('自检卡有卸载按钮', html.indexOf('id="btn-health-detach"') >= 0);
ok('自检卡有重新接入按钮', html.indexOf('id="btn-health-restore"') >= 0);

/* 面板与 app.js 同为 ES5（宿主 iframe 里没有构建步骤，语法错误等于白屏）。 */
var es5Problems = [];
if (jsText.indexOf('=>') >= 0) es5Problems.push('箭头函数');
if (jsText.indexOf('const ') >= 0) es5Problems.push('const');
if (jsText.indexOf('let ') >= 0) es5Problems.push('let');
if (jsText.indexOf(BT) >= 0) es5Problems.push('模板字符串');
ok('materials.js 只用 ES5 语法', es5Problems.length === 0, es5Problems.join(','));

/* ---------------- 2b. 自定义预设（custom_presets） ---------------- */

var pyInit = read('plugin/__init__.py');
var pyMat = read('plugin/materials.py');
var cssText = read('plugin/static/materials.css');
ok('后端提供保存自定义预设的 entry', pyInit.indexOf('id="save_material_preset"') >= 0);
ok('面板预设名输入框限制 40 字（正常路径碰不到后端报错）', jsText.indexOf("maxlength: '40'") >= 0);
ok('后端提供删除自定义预设的 entry', pyInit.indexOf('id="delete_material_preset"') >= 0);
ok('超长预设名在 API 层被显式拒绝（不静默截断）', pyInit.indexOf('预设名最多 40 个字符') >= 0);
ok('material_spec 暴露 custom_presets', pyInit.indexOf('"custom_presets": dict(') >= 0);
ok('归一化不会抹掉自定义预设名',
  pyMat.indexOf('clean["preset"] not in PRESET_IDS and clean["preset"] not in clean["custom_presets"]') >= 0);
ok('面板能列出自己的预设', jsText.indexOf('function CUSTOM_ORDER()') >= 0);
ok('面板切换自定义预设走整套套用', jsText.indexOf('CURRENT.custom_presets[id]') >= 0);
ok('面板能保存当前材质为预设',
  jsText.indexOf('function saveCurrentAsPreset()') >= 0 &&
    jsText.indexOf('CURRENT.custom_presets[name] = copy;') >= 0);
ok('面板删除自定义预设走独立 entry',
  jsText.indexOf('delete_material_preset') >= 0);
ok('预设页有保存输入框', jsText.indexOf("id: 'mt-preset-name'") >= 0);

ok('同名自定义预设会被后端丢弃（内置预设不可覆盖）',
  pyMat.indexOf('title.lower() in PRESET_IDS') >= 0 &&
  pyMat.indexOf('与内置预设同名') >= 0);

ok('面板保存预设时按小写比对内置名',
  jsText.indexOf('SPEC.presets[name.toLowerCase()]') >= 0);
ok('自定义预设样式存在', cssText.indexOf('.mt-preset-del') >= 0 && cssText.indexOf('.mt-save-row') >= 0);
ok('预览壁纸可切深浅（浅色壁纸规则）', cssText.indexOf('.mt-pv[data-bg="light"] .mt-pv-wall') >= 0 && cssText.indexOf('.mt-pv[data-bg="light"] .mt-pv-card') >= 0);
ok('预览有深浅切换按钮与状态', jsText.indexOf("id: 'mt-pv-bg'") >= 0 && jsText.indexOf('var BG_MODE') >= 0 && jsText.indexOf('function applyBgMode()') >= 0);
ok('预览消费追光 spot（否则拖半径/强度没有反馈）', cssText.indexOf('var(--nts-mt-spot, none)') >= 0);
ok('预览消费折射染色 refract-tint', cssText.indexOf('var(--nts-mt-refract-tint, transparent)') >= 0);
ok('预览消费四边描边（上亮下暗的玻璃厚度）', cssText.indexOf('var(--nts-mt-edge-t, transparent)') >= 0 && cssText.indexOf('var(--nts-mt-edge-b, transparent)') >= 0 && cssText.indexOf('var(--nts-mt-edge-l, transparent)') >= 0 && cssText.indexOf('var(--nts-mt-edge-r, transparent)') >= 0);
ok('预览消费液态折射幅度 liquid-amp', cssText.indexOf('var(--nts-mt-liquid-amp, 0px)') >= 0);
ok('预览消费 hover / press 反馈', cssText.indexOf('var(--nts-mt-hover, .12)') >= 0 && cssText.indexOf('var(--nts-mt-press, .12)') >= 0);

/* 文字可读性（验收第 9 条）：玻璃基底调太实必须提示，否则字糊了用户还不知道原因 */
var jsText = fs.readFileSync(path.join(ROOT, 'plugin/static/materials.js'), 'utf8');
ok('预览有可读性提示容器', jsText.indexOf("'mt-pv-warn'") >= 0);
ok('提示从 --nts-mt-bg 的 alpha 判定实心程度', jsText.indexOf('--nts-mt-bg') >= 0 && jsText.indexOf('bgAlphaOf') >= 0);
ok('提示阈值固定为 0.62', jsText.indexOf('alpha >= 0.62') >= 0);
ok('提示样式存在且空时隐藏', cssText.indexOf('.mt-pv-warn') >= 0 && cssText.indexOf('.mt-pv-warn:empty') >= 0);

/* 预览请求并发抑制：拖滑块会连续触发，必须有 in-flight 闸门 + 尾随一次，
   否则每次 0.6 秒往返会堆出几十个 run，过期结果互相覆盖还压宿主。 */
ok('预览有 in-flight 闸门', jsText.indexOf('var PREVIEW_INFLIGHT = false;') >= 0);
ok('预览在闸门关闭时只记待补', jsText.indexOf('if (PREVIEW_INFLIGHT) { PREVIEW_PENDING = true; return; }') >= 0);
ok('预览有尾随补发函数', jsText.indexOf('function drainPreview() {') >= 0);
ok('成功与失败分支都会补发最新一次', (jsText.match(/drainPreview\(\);/g) || []).length >= 4,
   'drainPreview calls=' + (jsText.match(/drainPreview\(\);/g) || []).length);

/* 批量重置：10 个组件逐个点「继承全局」、十几项暗色逐个点清除都是体力活。 */
ok('组件页有「全部继承全局」按钮', jsText.indexOf("id: 'mt-comp-reset-all'") >= 0);
ok('组件条说明当前继承状态', jsText.indexOf('全部组件跟随全局') >= 0 && cssText.indexOf('.mt-comp-bar') >= 0);
ok('暗色有批量清除按钮', jsText.indexOf("id: 'mt-dark-clear'") >= 0 && jsText.indexOf('function clearAllDark(') >= 0);
ok('批量清除入口只在暗色且有覆盖时出现', jsText.indexOf("MODE === 'dark' && nDark > 0") >= 0);
ok('头部状态跟着编辑实时刷新', jsText.indexOf('renderHeadState();' + String.fromCharCode(10) + '    schedulePreview();') >= 0);

/* 参数搜索：90 个参数散在 8 个界面，没有搜索只能靠翻页找。 */
ok('头部有参数搜索框', jsText.indexOf("id: 'mt-search'") >= 0 && jsText.indexOf("class: 'mt-search'") >= 0);
ok('搜索跨全部参数而不是当前界面', jsText.indexOf('function renderSearch(') >= 0 && jsText.indexOf('if (SEARCH) return renderSearch(pane);') >= 0);
ok('切界面会清空搜索词', jsText.indexOf('SEARCH = ' + String.fromCharCode(39) + String.fromCharCode(39) + ';') >= 0);
ok('搜索框样式在 CSS 里', cssText.indexOf('.mt-search') >= 0);

/* 组件缩略块：拖组件参数必须能看到变化，否则「组件材质」页等于盲调。 */
ok('组件页有缩略块构建函数', jsText.indexOf('function buildComponentStrip()') >= 0);
ok('缩略块与主预览共用注入目标', jsText.indexOf('paintTargets') >= 0 && jsText.indexOf("byId('mt-comp-strip')") >= 0);
ok('缩略块吃组件别名并带全局回退', jsText.indexOf("'var(--nts-mt-c-bg-'") >= 0 && jsText.indexOf('var(--nts-mt-bg))') >= 0);
ok('缩略块样式在 CSS 里', cssText.indexOf('.mt-comp-chip-face') >= 0 && cssText.indexOf('--chip-bg') >= 0);

/* 暗色覆盖必须有显式清除入口：暗色只存「与亮色不同」的值，
   想回到继承只能调成完全一样 —— 34 个 number / 14 个 percent 没人对得齐。 */
ok('暗色覆盖有 clearDarkOverride', jsText.indexOf('function clearDarkOverride(') >= 0);
ok('暗色标记是可点击的清除按钮', jsText.indexOf("class: 'mt-row-clear'") >= 0 && cssText.indexOf('.mt-row-clear') >= 0);

/* 诚实性：预览在「材质未启用」时也会画（用来调参），但必须挂徽标说明它不代表窗口现状；
   切预设会清空暗色覆盖 —— 静默清空会让用户以为参数自己变了。 */
var loaderSrc = read('plugin/static/loader/neko-theme-studio.js');
var appSrc = read('plugin/static/app.js');
ok('加载器采样组件级材质变量', loaderSrc.indexOf("compProbe = ['#react-chat-window-shell'") >= 0 && loaderSrc.indexOf('--nts-mt-bg-c') >= 0);
ok('加载器在未应用主题前不上报诊断（否则 install 后首帧会写 css_len=0 的假快照）', loaderSrc.indexOf('if (!lastApply || !lastApply.at)') >= 0);
ok('材质中心加载失败有兜底提示', appSrc.indexOf('材质中心没能加载') >= 0 && appSrc.indexOf('window.NekoMaterials') >= 0);
ok('预览有「材质未启用」徽标', jsText.indexOf("id: 'mt-pv-off'") >= 0 && cssText.indexOf('.mt-pv-off') >= 0);
ok('徽标随启用状态切换', jsText.indexOf('function syncOffTag(') >= 0);
ok('切预设清黑暗色覆盖时有提示', jsText.indexOf('切换预设会清空暗色覆盖') >= 0 && jsText.indexOf('function countOverrides(') >= 0);

/* 规范十一：预览至少覆盖 6 类组件，并且能看到「原始 vs 当前」。
   只画一张卡片时，用户调组件参数和全局参数在预览里都看不出区别。 */
ok('预览覆盖玻璃卡片并吃 chat 组件别名', jsText.indexOf("class: 'mt-pv-card mt-pv-hero mt-pv-chat'") >= 0 && cssText.indexOf('var(--nts-mt-c-bg-chat') >= 0);
ok('预览覆盖气泡并吃 bubble 组件别名', cssText.indexOf('var(--nts-mt-c-bg-bubble') >= 0);
ok('预览覆盖普通按钮并吃 button 组件别名', jsText.indexOf("class: 'mt-pv-btn'") >= 0 && cssText.indexOf('var(--nts-mt-c-bg-button') >= 0);
ok('预览覆盖输入框并吃 input 组件别名', jsText.indexOf("class: 'mt-pv-input'") >= 0 && cssText.indexOf('var(--nts-mt-c-bg-input') >= 0);
ok('预览覆盖弹窗并吃 dialog 组件别名', jsText.indexOf("class: 'mt-pv-pop'") >= 0 && cssText.indexOf('var(--nts-mt-c-bg-dialog') >= 0);
ok('预览覆盖侧边栏并吃 sidebar 组件别名', jsText.indexOf("class: 'mt-pv-side'") >= 0 && cssText.indexOf('var(--nts-mt-c-bg-sidebar') >= 0);
ok('预览有原始 / 当前对比按钮', jsText.indexOf("id: 'mt-pv-compare'") >= 0 && jsText.indexOf('function toggleCompare(') >= 0);
ok('对比层按 mode 缓存原始变量（亮暗不能混用）', jsText.indexOf('REF_CACHE[mode]') >= 0 && jsText.indexOf('materials: deepDefaults()') >= 0);
ok('对比层只占右半屏', cssText.indexOf('clip-path: inset(0 0 0 50%)') >= 0 && cssText.indexOf('.mt-pv[data-compare="1"] .mt-pv-ref') >= 0);
ok('预览文案不再写「质材」错字', jsText.indexOf('质材未启用') < 0 && jsText.indexOf('材质未启用') >= 0);
/* 无障碍：系统要求减弱动效时，漂移 / 进入 / 展开动画必须全停。
   动画声明段（.chat-window 漂移、.composer-overflow-menu 展开）与
   reduced-motion 段的集合不一致时，主窗会在「已减弱」状态下继续慢飘。 */
var rmAt = loaderSrc.indexOf('材质不做任何流动');
var rmSeg = loaderSrc.slice(rmAt, rmAt + 1600);
ok('reduced-motion 段覆盖聊天主窗漂移', rmSeg.indexOf('.chat-window,') >= 0);
ok('reduced-motion 段覆盖展开菜单', rmSeg.indexOf('.composer-overflow-menu,') >= 0);
ok('reduced-motion 停掉全部材质动画', rmSeg.indexOf('animation: none !important') >= 0);

/* 组件页诚实说明：缩略块与主预览同吃组件变量，拖参数能立刻看到 */
ok('组件页说明缩略块只示意视觉项',
   jsText.indexOf('缩略块直接吃组件变量') >= 0 && jsText.indexOf('只示意颜色 / 圆角 / 模糊 / 边框 / 阴影') >= 0);

/* 焦点可见性：材质层给输入框设 border !important，会压掉宿主 :focus 的边框与光晕。 */
var focusSeg = loaderSrc.slice(loaderSrc.indexOf('field-row input:focus,'), loaderSrc.indexOf('field-row input:focus,') + 900);
ok('设置页输入框焦点有可见边框', loaderSrc.indexOf('body.api-key-settings-page .field-row input:focus,') >= 0);
ok('设置页下拉触发焦点有可见边框', loaderSrc.indexOf('body.api-key-settings-page .api-provider-dropdown-trigger:focus-visible {') >= 0);
ok('焦点边框走主题强调色', focusSeg.indexOf('border-color: var(--nts-accent, #40C5F1) !important;') >= 0);
ok('焦点光晕保留 3px 环', focusSeg.indexOf('box-shadow: 0 0 0 3px rgba(64, 197, 241, 0.18) !important;') >= 0);
ok('焦点规则不吞 outline', focusSeg.indexOf('outline: none') < 0);
var ldr = read('plugin/static/loader/neko-theme-studio.js');
var rootIdx = ldr.indexOf('body #react-chat-window-root {');
var rootSeg = rootIdx >= 0 ? ldr.slice(rootIdx, rootIdx + 900) : '';
var shellIdx = ldr.indexOf('body .compact-export-history-bubble {');
var shellSeg = shellIdx >= 0 ? ldr.slice(shellIdx - 400, shellIdx + 260) : '';
ok('外壳/弹出层/导出气泡共用禁模糊组（transform 容器上 backdrop-filter 会让整块不绘制）', shellSeg.indexOf('backdrop-filter: none !important;') >= 0 && shellSeg.indexOf('#react-chat-window-shell') >= 0 && shellSeg.indexOf('.composer-icon-popover') >= 0);
ok('内层 root 不做背景模糊（compact 模式下宿主给它上了 filter）', rootSeg.indexOf('backdrop-filter: none !important;') >= 0);
ok('高危容器（壳体/内层/弹出层/导出气泡）的模糊已从组规则剔除', ldr.indexOf('背景模糊只给自身不带 transform / filter 的容器') >= 0 && ldr.indexOf('audit_mt_backdrop_hazards.py') >= 0);
ok('内层 root 铺材质玻璃底而不是清成透明', rootSeg.indexOf('background-color: var(--nts-mt-bg-c, var(--nts-mt-bg)) !important;') >= 0 && rootSeg.indexOf('background-color: transparent') < 0);

/* ---------------- 3. 缓存指纹 ---------------- */

function contentHash8(rel) {
  var buf = fs.readFileSync(path.join(ROOT, rel));
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function declaredHash(name) {
  var key = name + '?v=';
  var at = html.indexOf(key);
  if (at < 0) return '';
  var tail = html.slice(at + key.length);
  var quote = tail.indexOf('"');
  var value = quote >= 0 ? tail.slice(0, quote) : tail;
  return value.slice(value.lastIndexOf('-') + 1);
}

ok('materials.js 的 ?v= 指纹与磁盘一致', declaredHash('materials.js') === contentHash8('plugin/static/materials.js'), declaredHash('materials.js') + ' vs ' + contentHash8('plugin/static/materials.js'));
ok('materials.css 的 ?v= 指纹与磁盘一致', declaredHash('materials.css') === contentHash8('plugin/static/materials.css'), declaredHash('materials.css') + ' vs ' + contentHash8('plugin/static/materials.css'));

console.log('');
console.log('----------------------------------------');
console.log('materials-selftest: PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
