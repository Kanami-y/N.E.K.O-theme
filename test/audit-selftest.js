/* 可读性自检的纯函数自测（v0.4.9）
 *
 * 从 plugin/static/app.js 抠出 colorOver / colorChannel / colorLuma / contrastRatio /
 * gradientMidColor 五个纯函数，在 Node 里用已知 WCAG 数值验证，避免「面板显示全绿但
 * 实际算错」。parseColor 用等价的最小实现（hex / rgb / rgba / transparent）。
 *
 * 跑：node test/audit-selftest.js
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var SRC = fs.readFileSync(path.join(ROOT, 'plugin/static/app.js'), 'utf8');

var pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra === undefined ? '' : '  [' + extra + ']')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps === undefined ? 0.02 : eps); }

var startAt = SRC.indexOf('function colorOver(');
var endAt = SRC.indexOf('function valueForMode(');
if (startAt < 0 || endAt < 0 || endAt <= startAt) throw new Error('找不到可读性纯函数段');
var BLOCK = SRC.slice(startAt, endAt);

/* 最小 parseColor：只覆盖自测用到的形态 */
function parseColor(v) {
  if (typeof v !== 'string') return null;
  v = v.trim();
  var m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = v.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    var p = m[1].split(',').map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  if (v.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (v.toLowerCase() === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (v.toLowerCase() === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

var factory = new Function('parseColor', BLOCK +
  '\nreturn { colorOver: colorOver, colorLuma: colorLuma, contrastRatio: contrastRatio, gradientMidColor: gradientMidColor,' +
  ' mixToward: mixToward, contrastFixColor: contrastFixColor, colorToHex: colorToHex };');
var api = factory(parseColor);

console.log('[1] 对比度与 WCAG 参考值对得上');
ok(near(api.contrastRatio({ r: 255, g: 255, b: 255 }, { r: 47, g: 127, b: 240 }), 3.88, 0.03),
  '白 on #2f7ff0 ≈ 3.88（低于 4.5，应报红）', api.contrastRatio(parseColor('#ffffff'), parseColor('#2f7ff0')).toFixed(2));
ok(near(api.contrastRatio(parseColor('#ffffff'), parseColor('#2569d4')), 5.19, 0.05),
  '白 on #2569d4 ≈ 5.19（通过）', api.contrastRatio(parseColor('#ffffff'), parseColor('#2569d4')).toFixed(2));
ok(near(api.contrastRatio(parseColor('#767676'), parseColor('#ffffff')), 4.54, 0.03),
  '#767676 on 白 ≈ 4.54（AA 临界值参考）', api.contrastRatio(parseColor('#767676'), parseColor('#ffffff')).toFixed(2));
ok(near(api.contrastRatio(parseColor('#000000'), parseColor('#ffffff')), 21, 0.01),
  '黑 on 白 = 21（理论极值）', api.contrastRatio(parseColor('#000000'), parseColor('#ffffff')).toFixed(2));
ok(api.contrastRatio(parseColor('#000'), parseColor('#000')) === 1,
  '同色对比度 = 1（除数保护不返回 NaN/Infinity）');

console.log('\n[2] 半透明前景先合成到背景');
var over = api.colorOver(parseColor('rgba(255,255,255,0.5)'), parseColor('#000000'));
ok(over && near(over.r, 127.5, 0.6) && over.a === 1, '50% 白 over 黑 ≈ 127 灰', over && over.r);
var full = api.colorOver(parseColor('rgba(255,255,255,1)'), parseColor('#000000'));
ok(full && full.r === 255, 'alpha=1 时保持原色');
var none = api.colorOver(null, parseColor('#000000'));
ok(none === null, '前景缺失返回 null（审计里跳过该项）');

console.log('\n[3] 渐变取中间色标');
var g = api.gradientMidColor('linear-gradient(135deg, #4b3ca6 0%, #1b5f80 60%, #0e2c40 100%)');
ok(g && g.r === 27 && g.b === 128, '三段渐变取中间色标 #1b5f80', g && (g.r + ',' + g.g + ',' + g.b));
var g2 = api.gradientMidColor('rgba(0, 0, 0, 0.4)');
ok(g2 && g2.r === 0, '单个 rgba 也能取到');
ok(api.gradientMidColor('') === null, '空值返回 null');

console.log('\n[4] 阈值判定（4.5 / 3.0）');
function verdict(fg, bg, need) { return api.contrastRatio(parseColor(fg), parseColor(bg)) >= need; }
ok(verdict('#e8eef7', '#101828', 4.5), '浅字 on 深底（暗色主题常见形态）通过');
ok(!verdict('#8a8a8a', '#ffffff', 4.5), '浅灰 on 白 正文不通过（但 #8a8a8a ≈ 3.5 可作次要文字）');
ok(verdict('#8a8a8a', '#ffffff', 3.0), '同一组作为次要文字 / placeholder 通过（≥3.0）');

console.log('\n[5] 自动修正（v0.4.10）');
var white = parseColor('#ffffff');
var blue = parseColor('#2f7ff0');
ok(api.contrastFixColor(null, blue, 4.5) === null && api.contrastFixColor(white, null, 4.5) === null, '缺前景/背景返回 null');
var fixedLight = api.contrastFixColor(white, blue, 4.5);
ok(fixedLight && api.contrastRatio(fixedLight.color, blue) >= 4.5, '白字压中蓝底：修正后 ≥ 4.5',
  fixedLight && api.contrastRatio(fixedLight.color, blue).toFixed(2));
ok(fixedLight && fixedLight.ratio < 4.9, '修正是「刚好达标」而不是一路压到极端',
  fixedLight && fixedLight.ratio.toFixed(3));
ok(fixedLight && api.colorLuma(fixedLight.color) < api.colorLuma(white), '纯白字无解时自动改走「压深」方向',
  fixedLight && fixedLight.toward);
ok(fixedLight && api.contrastFixColor(fixedLight.color, blue, 4.5) === null, '已达标的值再修一次返回 null（幂等）');
var darkBg = parseColor('#101828');
var darkText = parseColor('#1b2430');
var fixedDark = api.contrastFixColor(darkText, darkBg, 4.5);
ok(fixedDark && api.contrastRatio(fixedDark.color, darkBg) >= 4.5, '深底浅字方向：往白提亮而不是压黑',
  fixedDark && api.contrastRatio(fixedDark.color, darkBg).toFixed(2));
ok(fixedDark && api.colorLuma(fixedDark.color) > api.colorLuma(darkText), '修正后亮度上升');
ok(api.colorToHex({ r: 27, g: 95, b: 128, a: 1 }) === '#1b5f80', 'colorToHex 精确输出 #1b5f80');
ok(api.colorToHex({ r: -5, g: 300, b: 12.4, a: 1 }) === '#00ff0c', 'colorToHex 夹到 0–255 并四舍五入');
var mid = api.mixToward(parseColor('#000000'), parseColor('#ffffff'), 0.5);
ok(near(mid.r, 127.5, 0.01) && near(mid.g, 127.5, 0.01), 'mixToward 中点 = 127.5');
var hexRound = parseColor(api.colorToHex(fixedLight.color));
ok(api.contrastRatio(hexRound, blue) >= 4.5, '转成 hex 字符串再解析仍达标（面板写入的就是 hex）');

console.log('\n----------------------------------------');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
