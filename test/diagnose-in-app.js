/* =====================================================================
 * diagnose-in-app.js -- 在「应用窗口」里跑的一次性自检表达式
 * ---------------------------------------------------------------------
 * 用法 A（推荐）：在 N.E.K.O 应用窗口按 Ctrl+Shift+I 打开 DevTools，
 *   切到 Console，把这个文件的内容整段粘进去回车；会打印一个 JSON 结论。
 * 用法 B：node theme-studio/tools/page-eval.js --url http://127.0.0.1:48911/chat \
 *           --js theme-studio/test/diagnose-in-app.js --wait "!!window.NekoThemeStudio"
 *
 * 它按顺序检查整条链路，并在第一条失败处给出 verdict：
 *   loader 挂载 → 样式表 link → 拉 theme.json(CORS) → 调色板非空
 *   → enabled → 当前模式与配置组匹配 → <style id="nts-dynamic"> 注入
 *   → 门控属性 → 变量在当前文档可解析 → 真实气泡的计算色
 * ===================================================================== */

(async function () {
  var PLUGIN_ID = 'neko_theme_studio';
  var out = { at: new Date().toISOString(), checks: [], theme: null, loader: null };
  function push(name, ok, detail, fix) {
    out.checks.push({ name: name, ok: !!ok, detail: String(detail == null ? '' : detail), fix: ok ? '' : (fix || '') });
  }
  function parseRGB(v) {
    // '#123456' / '#abc' / 'rgb(1, 2, 3)' / 'rgba(1,2,3,0.5)' → [r,g,b,a]；解析不了返回 null。
    if (!v) return null;
    var s = String(v).trim();
    var m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var parts = m[1].split(/[,\s/]+/).filter(function (x) { return x !== ''; });
      if (parts.length >= 3) {
        return [parseFloat(parts[0]), parseFloat(parts[1]), parseFloat(parts[2]), parts[3] === undefined ? 1 : parseFloat(parts[3])];
      }
      return null;
    }
    var h = /^#([0-9a-fA-F]{3,8})$/.exec(s);
    if (h) {
      var x = h[1];
      if (x.length === 3) x = x.split('').map(function (c) { return c + c; }).join('');
      if (x.length === 8) x = x.slice(0, 6);
      if (x.length === 6) {
        return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), 1];
      }
    }
    return null;
  }
  function sameColor(a, b) {
    var pa = parseRGB(a), pb = parseRGB(b);
    if (!pa || !pb) return false;
    for (var i = 0; i < 3; i++) if (Math.abs(pa[i] - pb[i]) > 2) return false;
    return true;
  }

  // ---- 1. loader -------------------------------------------------------
  var L = window.NekoThemeStudio;
  push('loader-mounted', !!L,
    L ? 'window.NekoThemeStudio 存在' : 'window.NekoThemeStudio 不存在（脚本没加载或执行报错）',
    '先看 REST: curl http://127.0.0.1:48911/static/neko-theme-studio.js；再 run install.ps1');

  // ---- 1b. loader 版本（部署漂移自查，仅比较、不判死）--------------------
  // 旧版 loader 没有 scriptVersion 字段：那时 CSS 条纹还未按 data-nts-l-*/
  // data-nts-d-* 门控，新 CSS + 旧 loader 会让「每条规则都门控失败」→ 全无颜色。
  // 当前应装 1.5.0。这里只做版本比较并把结论写进 detail / drift，
  // 不再把「版本不对」当成链路断裂（ok 恒为 true）：旧 loader 也能跑出其余检查结果，
  // 让用户一次看到全貌，而不是在第一条就被拦住。
  var EXPECTED_LOADER = '1.5.0';
  function cmpVersion(a, b) {
    var pa = String(a || '').split('.'), pb = String(b || '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10), nb = parseInt(pb[i], 10);
      if (isNaN(na)) na = 0;
      if (isNaN(nb)) nb = 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }
  var lv = L && L.scriptVersion;
  if (!lv) {
    out.loaderVersionDrift = 'missing';
    push('loader-version', true,
      'loader 没有 scriptVersion 字段（旧版，期望 ' + EXPECTED_LOADER + '）',
      'loader 可能是旧版：static\neko-theme-studio.js 没被更新。重跑 install.ps1（§D 复制两件套）后重启应用窗口。');
  } else {
    var vcmp = cmpVersion(lv, EXPECTED_LOADER);
    out.loaderVersionDrift = vcmp === 0 ? 'none' : (vcmp < 0 ? 'older' : 'newer');
    push('loader-version', true,
      'loader v' + lv + (vcmp === 0 ? '（与期望一致）'
        : (vcmp < 0 ? '（比期望的 ' + EXPECTED_LOADER + ' 旧）'
          : '（比期望的 ' + EXPECTED_LOADER + ' 新）')),
      vcmp < 0 ? 'loader 是旧版：static\neko-theme-studio.js 没被更新。重跑 install.ps1（§D 复制两件套）后重启应用窗口。' : '');
  }

  // ---- 2. 样式表 <link> ------------------------------------------------
  var link = null;
  try { link = document.querySelector('link[href*="neko-theme-studio.css"]'); } catch (e) { /* ignore */ }
  push('css-link', !!link,
    link ? String(link.href) : '页面里没有 <link ... neko-theme-studio.css>',
    '模板补丁没生效：查 chat.html 里 <!-- NTS:BEGIN --> 段，重跑 install.ps1');

  // ---- 2b. 样式表真的解析出规则了吗（<link> 存在 ≠ CSS 加载成功）--------
  var sheetRules = -1;
  try {
    var sheets = document.styleSheets || [];
    for (var si = 0; si < sheets.length; si++) {
      if (String(sheets[si].href || '').indexOf('neko-theme-studio.css') === -1) continue;
      try { sheetRules = sheets[si].cssRules ? sheets[si].cssRules.length : 0; } catch (e1) { sheetRules = -2; }
      break;
    }
  } catch (e2) { sheetRules = -1; }
  if (link) {
    push('css-sheet', sheetRules > 0,
      sheetRules > 0 ? '样式表解析出 ' + sheetRules + ' 条规则'
        : (sheetRules === 0 ? '样式表存在但 0 条规则（多半是 404 拿到空/HTML）'
          : (sheetRules === -2 ? '跨源无法读取 cssRules（异常）' : '找不到对应 styleSheet 对象')),
      'CSS 没真正生效：确认 /static/css/neko-theme-studio.css 返回 200 且是 CSS 文本；重跑 install.ps1（§D）。');
  }

  // ---- 3. 拉 theme.json ------------------------------------------------
  var base = (L && L.baseUrl) || 'http://127.0.0.1:48916';
  var url = base + '/plugin/' + PLUGIN_ID + '/ui/theme.json?_=' + Date.now();
  var palette = null;
  try {
    var res = await fetch(url, { cache: 'no-store', credentials: 'omit', mode: 'cors' });
    out.httpStatus = res.status;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    palette = await res.json();
    out.theme = palette;
    push('fetch-theme-json', true, 'HTTP ' + res.status + ' ← ' + url, '');
  } catch (e) {
    push('fetch-theme-json', false, '拉取失败：' + (e && e.message),
      '插件服务没起 / 端口不是 48916 / 跨源被拒。主题色永远不会变，先修这里。');
  }

  // ---- 4. 调色板内容 ----------------------------------------------------
  if (palette) {
    var nL = Object.keys(palette.vars || {}).length;
    var nD = Object.keys(palette.dark_vars || {}).length;
    out.counts = { light: nL, dark: nD };
    push('palette-nonempty', nL + nD > 0,
      '亮色 ' + nL + ' 项 / 暗色 ' + nD + ' 项（updated_at ' + (palette.updated_at || '—') + '）',
      '调色板是空的：面板里「应用」没有真的写进去。回面板改一项→应用→再跑本自检。');
    push('enabled', palette.enabled !== false, 'enabled=' + palette.enabled,
      '「启用主题」开关是关的：面板里打开它再应用。');
    var mode = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    var mine = mode === 'dark' ? nD : nL;
    out.mode = mode;
    push('mode-has-values', mine > 0,
      '当前是「' + (mode === 'dark' ? '暗色' : '亮色') + '」模式，该组有 ' + mine + ' 项',
      '当前模式那一组一项都没有：亮/暗两组各管各的，必须在面板里切到同名的页签再配一遍。');
  }

  // ---- 5. 注入层 -------------------------------------------------------
  var diag = (L && typeof L.diagnose === 'function') ? L.diagnose() : null;
  out.loader = diag;
  var styleLen = diag ? diag.styleLen : ((document.getElementById('nts-dynamic') || {}).textContent || '').length;
  push('style-injected', styleLen > 0, '<style id="nts-dynamic"> ' + styleLen + ' 字符',
    'loader 没有注入样式：看 console 里 [theme-studio] 的告警；也可能版本号相同被跳过了（NekoThemeStudio.refresh() 强制重拉）。');
  var gates = (diag && diag.gates) || [];
  push('gates-applied', gates.length > 1, gates.join(',') || '（无）',
    '门控属性没打上：CSS 每条规则都门控在 data-nts-l-*/data-nts-d-*，没有属性 = 规则全空转。');

  // ---- 6. 变量是否在当前文档可解析 --------------------------------------
  var varName = '--nts-user-bubble-bg';
  var varVal = '';
  try { varVal = getComputedStyle(document.documentElement).getPropertyValue(varName).trim(); } catch (e) { /* ignore */ }
  out.varValue = varVal;
  if (palette && out.counts && (out.counts.light + out.counts.dark) > 0) {
    push('var-resolves', !!varVal,
      varName + ' = ' + (varVal || '(空)'),
      '变量解析为空：这个变量在当前模式下不该生效（多半是模式不匹配），或样式表没被浏览器接受。');
  }

  // ---- 7. 真实元素的计算色 ---------------------------------------------
  var bubble = null;
  try {
    bubble = document.querySelector('.message-bubble-user, .message-bubble-assistant, .message.user, .message.gemini');
  } catch (e) { /* ignore */ }
  if (bubble) {
    var cs = getComputedStyle(bubble);
    var cls = String(bubble.className || '');
    var isUser = /-user\b|message user|\buser\b/.test(cls);
    var target = isUser ? '--nts-user-bubble-bg' : '--nts-ai-bubble-bg';
    var targetVal = '';
    try { targetVal = getComputedStyle(document.documentElement).getPropertyValue(target).trim(); } catch (e) { /* ignore */ }
    out.bubble = { cls: cls, bg: cs.backgroundColor, color: cs.color, wantVar: target, want: targetVal || '(未配置)' };
    if (!targetVal) {
      push('bubble-colored', true, '这个气泡对应的变量（' + target + '）没配置，跳过色值比对（链路其余项已检查）', '');
    } else {
      push('bubble-colored', sameColor(cs.backgroundColor, targetVal),
        target + ' = ' + targetVal + ' ，元素实际计算值 ' + cs.backgroundColor,
        '文档里的变量已经对了但元素颜色没跟上：说明有更高的 !important 规则压住了它，或该元素的底色不在 background-color 上。把这段贴出来即可定位。');
    }
  } else {
    push('bubble-colored', true, '页面上暂时没有消息气泡，跳过色值比对（发一条消息后再跑一次即可看到色值项）', '');
  }

  // ---- verdict ---------------------------------------------------------
  var failed = out.checks.filter(function (c) { return !c.ok; });
  out.verdict = failed.length ? ('BREAK AT: ' + failed[0].name) : 'CHAIN OK';
  out.failed = failed.map(function (c) { return c.name; });
  // 版本漂移单独列出来：它不是链路断裂，但值得一眼看到。
  if (out.loaderVersionDrift && out.loaderVersionDrift !== 'none') {
    out.drift = ['loader-version:' + out.loaderVersionDrift];
  }
  var text = JSON.stringify(out, null, 2);
  try { console.log('[nts-diagnose] ' + out.verdict); console.log(text); } catch (e) { /* ignore */ }
  return text;
})()
