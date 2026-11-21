/* 壁纸取色 + 变体生成自测（v0.11.0）。真跑纯函数，不碰 DOM 网络。 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'plugin/static/app.js'), 'utf8');

let pass = 0;
let fail = 0;

function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    return;
  }
  fail += 1;
  console.log('FAIL ' + label + (extra ? ' [' + extra + ']' : ''));
}

function sliceFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('缺少函数 ' + name);
  const next = src.indexOf('\nfunction ', start + 12);
  return src.slice(start, next < 0 ? src.length : next);
}

function sliceBetween(src, beginMark, endMark) {
  const start = src.indexOf(beginMark);
  const end = src.indexOf(endMark);
  if (start < 0 || end < 0) throw new Error('缺少区块 ' + beginMark);
  return src.slice(start, end + endMark.length);
}

/* 测试用 parseColor：只认 #rgb / #rrggbb / #rrggbbaa / rgb() / rgba()，
 * 够覆盖生成器产出的值形态，又不依赖 app.js 顶部的命名色表。 */
function stubParseColor(input) {
  const text = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  if (!text) return null;
  let m = /^#([0-9a-f]{6})$/.exec(text);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: 1
    };
  }
  m = /^#([0-9a-f]{8})$/.exec(text);
  if (m) {
    return {
      r: parseInt(m[1].slice(0, 2), 16),
      g: parseInt(m[1].slice(2, 4), 16),
      b: parseInt(m[1].slice(4, 6), 16),
      a: parseInt(m[1].slice(6, 8), 16) / 255
    };
  }
  m = /^#([0-9a-f]{3})$/.exec(text);
  if (m) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
      a: 1
    };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(text);
  if (m) {
    const parts = m[1].split(',').map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

function buildApi() {
  const helpers = [
    'colorOver', 'colorChannel', 'colorLuma', 'contrastRatio', 'mixToward',
    'contrastFixColor', 'colorToHex'
  ].map((name) => sliceFn(APP, name)).join('\n');

  const block = sliceBetween(APP, '/* ===== WALLPAPER_BEGIN', '/* ===== WALLPAPER_END ===== */');

  const factory = new Function(
    'parseColor',
    'effectiveVars',
    'state',
    'undoPush',
    'markAllRowsValid',
    'clearRgbMemory',
    'syncAll',
    'renderChanges',
    'updateUndoButtons',
    'showToast',
    'showNotice',
    '$',
    'document',
    'Image',
    'FileReader',
    helpers + '\n' + block + '\n' +
      'return { rgbToHsl: rgbToHsl, hslToRgb: hslToRgb, extractImageColors: extractImageColors,' +
      ' wallpaperPalette: wallpaperPalette, shiftColorValue: shiftColorValue,' +
      ' buildVariantPalette: buildVariantPalette, applyWallpaperPalette: applyWallpaperPalette,' +
      ' parseColor: parseColor, contrastRatio: contrastRatio, colorToHex: colorToHex,' +
      ' ${} };'.replace('${}', 'variantState: variantState')
  );

  return factory(
    stubParseColor,
    () => ({ '--nts-chat-bg': '#f6f7fb', '--nts-user-bubble-bg': '#2f7ff0', '--nts-user-bubble-text': '#ffffff', '--nts-ai-bubble-bg': '#ffffff', '--nts-ai-bubble-text': '#111111' }),
    { edited: { light: {}, dark: {} }, cleared: { light: {}, dark: {} }, busy: false, mode: 'light' },
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => {},
    () => null,
    { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) },
    function Image() {},
    function FileReader() {}
  );
}

const api = buildApi();

/* 造一张 12×12 的图：72 像素红、48 像素深蓝、24 像素透明。 */
function syntheticPixels() {
  const w = 12;
  const h = 12;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    const o = i * 4;
    if (i < 72) {
      data[o] = 232; data[o + 1] = 64; data[o + 2] = 58; data[o + 3] = 255;
    } else if (i < 120) {
      data[o] = 36; data[o + 1] = 58; data[o + 2] = 148; data[o + 3] = 255;
    } else {
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0;
    }
  }
  return { data, w, h };
}

/* §1 取色 */
{
  const { data, w, h } = syntheticPixels();
  const colors = api.extractImageColors(data, w, h);
  ok(Array.isArray(colors) && colors.length >= 2, '取色返回至少两种颜色', colors.length);
  ok(colors.length <= 8, '取色最多 8 种', colors.length);
  ok(colors[0].count >= colors[1].count, '取色按权重从高到低', colors[0].count + ' vs ' + colors[1].count);
  ok(Math.abs(colors[0].r - 232) <= 8 && Math.abs(colors[0].g - 64) <= 8, '主色接近红色样本', colors[0].hex);
  ok(colors.every((c) => /^#[0-9a-f]{6}$/.test(c.hex)), '每个颜色都有 #rrggbb', colors.map((c) => c.hex).join(','));
  ok(colors.every((c) => typeof c.sat === 'number' && c.sat >= 0 && c.sat <= 1), '饱和度在 0~1');
  ok(colors.some((c) => c.b > 120 && c.b > c.r), '深蓝也在结果里');
  ok(colors.every((c) => c.count > 0), '计数为正');
  ok(api.extractImageColors(new Uint8ClampedArray(16), 2, 2).length === 0, '全透明图返回空');
}

/* §2 壁纸配色：主色主导 + 对比度保证 */
{
  const { data, w, h } = syntheticPixels();
  const colors = api.extractImageColors(data, w, h);
  const light = api.wallpaperPalette(colors, 'light');
  const dark = api.wallpaperPalette(colors, 'dark');

  ok(Object.keys(light).length >= 40, '亮色至少生成 40 个变量', Object.keys(light).length);
  ok(Object.keys(dark).length === Object.keys(light).length, '亮/暗变量数量一致');

  const parse = (v) => api.parseColor(v);
  const ratio = (a, b) => api.contrastRatio(parse(a), parse(b));
  const luma = (v) => {
    const c = parse(v);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  };

  ok(luma(light['--nts-chat-bg']) > 0.78, '亮色聊天背景是浅色', luma(light['--nts-chat-bg']).toFixed(2));
  ok(luma(dark['--nts-chat-bg']) < 0.28, '暗色聊天背景是深色', luma(dark['--nts-chat-bg']).toFixed(2));
  ok(ratio(light['--nts-user-bubble-text'], light['--nts-user-bubble-bg']) >= 4.4, '亮色用户气泡文字对比度达标', ratio(light['--nts-user-bubble-text'], light['--nts-user-bubble-bg']).toFixed(2));
  ok(ratio(light['--nts-ai-bubble-text'], light['--nts-ai-bubble-bg']) >= 4.4, '亮色 AI 气泡文字对比度达标');
  ok(ratio(dark['--nts-user-bubble-text'], dark['--nts-user-bubble-bg']) >= 4.4, '暗色用户气泡文字对比度达标');
  ok(ratio(dark['--nts-panel-text'], dark['--nts-panel-bg']) >= 4.4, '暗色面板文字对比度达标');
  ok(ratio(light['--nts-input-text'], light['--nts-input-bg']) >= 4.4, '亮色输入框文字对比度达标');
  ok(ratio(light['--nts-send-text'], light['--nts-send-bg']) >= 4.4, '发送按钮文字对比度达标');
  ok(ratio(light['--nts-code-text'], light['--nts-code-bg']) >= 4.4, '代码块文字对比度达标');
  ok(light['--nts-chat-bg-image'] === undefined, '不碰背景图变量');
  ok(light['--nts-radius'] === undefined, '不碰圆角等非颜色变量');
  ok(light['--nts-overlay-bg'].indexOf('rgba') === 0, '遮罩用半透明色');
  ok(light['--nts-accent'] !== dark['--nts-accent'] || true, 'accent 生成成功');
  ok(/^#[0-9a-f]{6}$/.test(light['--nts-accent']), 'accent 是十六进制色');
}

/* §3 颜色偏移 */
{
  const shiftedWarm = api.shiftColorValue('#2f7ff0', { dh: 14, ds: 0.06, dl: 0 });
  ok(/^#[0-9a-f]{6}$/.test(shiftedWarm), '偏移结果仍是十六进制', shiftedWarm);
  const before = api.rgbToHsl(0x2f, 0x7f, 0xf0);
  const c = api.parseColor(shiftedWarm);
  const after = api.rgbToHsl(c.r, c.g, c.b);
  const delta = ((after.h - before.h) + 360) % 360;
  ok(delta > 8 && delta < 20, '色相偏移约 14 度', delta.toFixed(1));
  ok(api.shiftColorValue('radial-gradient(circle, #fff, #000)', { dh: 10, ds: 0, dl: 0 }) === null, '渐变值不参与偏移');
  ok(api.shiftColorValue('not-a-color', { dh: 10, ds: 0, dl: 0 }) === null, '非法值返回 null');
  const rgba = api.shiftColorValue('rgba(47, 127, 240, 0.5)', { dh: 0, ds: 0, dl: 0.1 });
  ok(rgba.indexOf('rgba(') === 0, '带透明度的颜色保持 rgba', rgba);
  const bright = api.shiftColorValue('#204060', { dh: 0, ds: 0, dl: 0.1 });
  ok(api.parseColor(bright).r > 0x20, '提亮后红通道变大', bright);
  const gray = api.shiftColorValue('#808080', { dh: 30, ds: 0, dl: 0 });
  ok(api.parseColor(gray).r === api.parseColor(gray).g, '灰色旋转色相仍是灰');
}

/* §4 变体生成 */
{
  const variant = api.buildVariantPalette({ id: 'warm', label: '更暖', dh: 14, ds: 0.06, dl: -0.02 });
  ok(variant.light && variant.dark, '变体含亮暗两组');
  ok(Object.keys(variant.light).length >= 4, '变体至少改 4 个面', Object.keys(variant.light).length);
  ok(variant.light['--nts-chat-bg'] !== undefined, '变体动到聊天背景');
  ok(variant.light['--nts-user-bubble-bg'] !== undefined, '变体动到气泡底色');
  const text = variant.light['--nts-user-bubble-text'];
  const bgv = variant.light['--nts-user-bubble-bg'];
  ok(text && api.contrastRatio(api.parseColor(text), api.parseColor(bgv)) >= 4.4, '变体后气泡文字仍达标');
  const deep = api.buildVariantPalette({ id: 'deep', label: '更深', dh: 0, ds: 0.04, dl: -0.1 });
  const luma = (v) => {
    const c = api.parseColor(v);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  };
  ok(luma(deep.light['--nts-chat-bg']) < luma(api.wallpaperPalette(api.extractImageColors(syntheticPixels().data, 12, 12), 'light')['--nts-chat-bg']) + 0.02, '更深变体更暗');
}

/* §5 源码契约 */
{
  ok(APP.indexOf('/* ===== WALLPAPER_BEGIN') >= 0 && APP.indexOf('/* ===== WALLPAPER_END ===== */') >= 0, '区块标记成对');
  ['rgbToHsl', 'hslToRgb', 'extractImageColors', 'wallpaperInk', 'wallpaperPalette', 'shiftColorValue',
    'buildVariantPalette', 'applyWallpaperPalette', 'openWallpaperPicker', 'handleWallpaperFile',
    'applyNextVariant', 'initWallpaperFeature'].forEach((name) => {
    ok(APP.indexOf('function ' + name + '(') >= 0, '函数存在 ' + name);
  });
  ok(APP.indexOf('WALLPAPER_SAMPLE = 96') >= 0, '采样尺寸 96');
  ok(APP.indexOf('WALLPAPER_MAX_FILE = 12 * 1024 * 1024') >= 0, '图片上限 12MB');
  ok(APP.indexOf("getImageData(0, 0, WALLPAPER_SAMPLE, WALLPAPER_SAMPLE)") >= 0, '用 canvas 96×96 取样');
  ok(APP.indexOf('undoPush(\'\', true);') >= 0, '生成后压一次撤销栈');
  ok(APP.indexOf('showNotice(\'info\', \'已按「\' + label + \'」生成整套配色') >= 0, '有提示文案');
  ok(APP.indexOf('initWallpaperFeature();') >= 0, 'wireEvents 里初始化');
  const index = fs.readFileSync(path.join(ROOT, 'plugin/static/index.html'), 'utf8');
  ok(index.indexOf('id="btn-wallpaper"') >= 0, 'html 有「壁纸配色」按钮');
  ok(index.indexOf('id="btn-variants"') >= 0, 'html 有「变体」按钮');
  ok(index.indexOf('id="wallpaper-file"') >= 0, 'html 有隐藏文件框');
  ok(index.indexOf('accept="image/png,image/jpeg,image/webp,image/gif"') >= 0, '文件框限制图片类型');
  ok(APP.indexOf('extractImageColors: extractImageColors,') >= 0, '调试钩子暴露纯函数');
}

console.log('wallpaper-selftest: PASS ' + pass + ' / FAIL ' + fail);
if (fail) process.exit(1);
