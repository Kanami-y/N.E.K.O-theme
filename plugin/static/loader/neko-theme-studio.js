/*!
 * neko-theme-studio.js — N.E.K.O 主题工坊 · 浏览器侧运行时
 * ---------------------------------------------------------------------------
 * 职责：把插件（48916）产出的调色板 JSON 变成应用各窗口里的 CSS 变量。
 *
 * 背景（为什么是轮询）：
 *   面板 iframe 的源是 http://127.0.0.1:48916，应用窗口的源是
 *   http://127.0.0.1:48911。两者跨源 → localStorage 不互通、
 *   BroadcastChannel 不互通、无法从面板直接 postMessage 到应用窗口。
 *   因此由本脚本（运行在应用窗口内）主动轮询插件静态端点。
 *
 * 设计要点：
 *   1. 变量注入 <style>，不写 CSS 文件 → 没有 HTTP 缓存问题。
 *   2. localStorage 缓存 → 启动瞬间即生效，无闪烁；插件服务不可用时主题仍在。
 *   3. fetch 用 cache:'no-store' + 时间戳查询串 → 穿透可能的启发式缓存。
 *   4. 只接受白名单内的值格式与 --nts- 前缀变量名（纵深防御，服务端也校验）。
 *   5. 无依赖、无副作用：任何失败都静默降级，绝不抛错影响宿主应用。
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- 配置常量

  var PLUGIN_ID = 'neko_theme_studio';
  var STYLE_ID = 'nts-dynamic';
  var CACHE_KEY = 'neko.themeStudio.palette';
  // 自检快照键：见文件末尾 persistSnapshot()。
  var SNAPSHOT_KEY = 'neko.themeStudio.lastDiagnose';
  var BASE_OVERRIDE_KEY = 'neko.themeStudio.baseUrl';
  var DEFAULT_PLUGIN_BASE = 'http://127.0.0.1:48916';
  var POLL_INTERVAL_MS = 1500;
  // 应用冷启动时插件生命周期可能还没起来（用户插件总开关是关的，或 registry
  // 尚未扫描），此时 /plugin/<id>/ui/theme.json 直接 404，主题就「永远不生效」。
  // 本加载器运行在应用窗口里，可以用带 Origin 的 CSRF 请求把插件服务叫醒：
  //   GET  /security/csrf-token  →  POST /plugins/refresh  →  POST /plugin/<id>/start
  // 三者都已实测可跨源调用（预检回显 allow-origin/allow-headers），因此无需
  // 依赖任何宿主开关。次数限流，避免 1.5s 轮询把服务打爆。
  var REVIVE_MIN_INTERVAL_MS = 12000;
  var REVIVE_MAX_ATTEMPTS = 40;
  // 自升级：已开窗口里的脚本无法被替换（浏览器已执行完），当磁盘上的加载器比
  // 本实例新时，唯一的接管办法是重新加载本页面。这是「面板新增了一个变量，用户
  // 不重启就永远看不到效果」的根治手段 —— 旧脚本会因为白名单里没有该变量而静默
  // 丢弃值，且 apply_theme 仍返回 succeeded，面板不报错，极难自查。
  var SELF_UPGRADE_MIN_INTERVAL_MS = 60000;
  // 守卫记录「版本@时间戳」。同一个版本在冷却期内不重复重载（防死循环），
  // 冷却期一过就再试一次 —— 否则一次缓存失误会把本会话的升级能力永久掐死。
  var SELF_UPGRADE_COOLDOWN_MS = 600000;
  var SELF_UPGRADE_GUARD_KEY = 'neko.themeStudio.selfUpgrade';
  var selfUpgradeAt = 0;
  var DEBUG = false;

  var VAR_PREFIX = '--nts-';
  // 脚本自身版本（不是调色板版本）。部署漂移是「面板改了色、本体没反应」的
  // 常见原因之一：static\neko-theme-studio.js 还是旧的、CSS 已是新的
  // （或反之），此时门控属性与样式表规则对不上，颜色永远不变且没有报错。
  // 把它暴露在 diagnose() 里，便于一眼看出是不是版本漂移。
  // 1.4.0: 打开页面时自检样式表是否陈旧并强制换新；气泡文字色彻底按角色作用域
  //        （AI 色不再串染用户/工具/系统正文），修复「改 AI 文字色用户文字也变」。
  // 1.4.2: 值校验不再默认按颜色处理（kind='auto' 兜底），并在检测到磁盘上有更新的
  //        加载器时自行刷新页面 —— 修复「新加变量在已开窗口里被静默丢弃」。
  // 1.5.0: theme.json 不再有 version 计数（改用 updated_at 标记 + 原始 JSON 逐字比较）；
  //        新增 image 类型（--nts-chat-bg-image，聊天背景图）。
  var SCRIPT_VERSION = '1.5.10';

  // 允许的颜色值形态。刻意保守：只放行纯颜色，杜绝把任意 CSS 注进变量。
  var RE_HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var RE_RGB = /^rgba?\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*(,\s*(0|1|0?\.[0-9]+)\s*)?\)$/i;
  var RE_HSL = /^hsla?\(\s*-?[0-9]{1,3}(\.[0-9]+)?\s*,\s*[0-9]{1,3}(\.[0-9]+)?%\s*,\s*[0-9]{1,3}(\.[0-9]+)?%\s*(,\s*(0|1|0?\.[0-9]+)\s*)?\)$/i;
  // CSS 命名颜色（含 currentcolor）。不收 inherit/initial/unset/revert：
  // 那四个会把颜色继承成父级，正文色被带偏就是「串色」投诉的来源。
  var COLOR_NAMES = ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson' +
    'currentcolor cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise' +
    'darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia' +
    'gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink' +
    'indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral' +
    'lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue' +
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose' +
    'moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod' +
    'palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal' +
    'thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' ');
  var NAMED_COLOR = Object.create(null);
  for (var ci = 0; ci < COLOR_NAMES.length; ci += 1) { NAMED_COLOR[COLOR_NAMES[ci]] = 1; }
  function isNamedColor(t) { return NAMED_COLOR[String(t).toLowerCase()] === 1; }
  var RE_PCT = /^[0-9]{1,3}(\.[0-9]+)?%$/;
  var RE_LEN = /^-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|%|pt|vh|vw)$/i;
  var RE_FONT = /^[A-Za-z0-9\u4e00-\u9fff ,'"\-_.]{1,200}$/;
  // --nts-chat-blur 的消费方是 `backdrop-filter: var(--nts-chat-blur)`，
  // 因此值必须是 blur(...) 形态；裸长度会被浏览器整条丢弃。
  var RE_BLUR = /^blur\(\s*-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|pt)\s*\)$/i;
  // 裸长度里对 blur 合法的写法：blur() 只接受绝对长度，% / vh / vw 会让
  // backdrop-filter 整条失效。RE_LEN 为 shadow 的偏移量必须放行它们，所以单独用这条
  // 更严的正则，避免生成 blur(18%) 这种「校验通过、CSS 无效」的值。
  var RE_BLUR_BARE = /^-?[0-9]{1,4}(\.[0-9]+)?(px|rem|em|pt)$/i;
  // --nts-chat-opacity 桥接到原生的 --neko-chat-opacity-factor（乘子），取值 0-1。
  // 曾经缺失这个 kind，导致面板/后端都接受、而本脚本按颜色校验后静默丢弃 ——
  // 一个「看起来能调、实际没反应」的死控件（由独立验证者实测发现）。
  // 允许 1.0 / 1.00 这类零填充写法（用户最自然地把「100%」写成 1.0）；
  // 仍拒绝 1.5 / 2 / -0.3 这类超出 0-1 的值。
  var RE_NUMBER = /^(?:0|1|0?\.[0-9]+|1\.0+)$/;
  // 时间值（v0.1.11，呼吸节奏）：3s / 1.5s / 800ms，裸数字按秒（3 = 3s）。
  // 上限 60s —— 再长的循环用户看不出"在动"，也没有实际意义。
  var RE_TIME = /^(?:(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?(?:s|ms))$/i;
  var RE_TIME_BARE = /^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?$/;
  var TIME_MAX_SECONDS = 60;
  // 百分比乘子解析：返回 0-1 的小数，非法或 >100% 返回 null。
  // 注意 RE_PCT 的捕获组是小数部分、不是整数部分（早期误用 pm[1] 导致
  // `50%` 被判非法、`33.3%` 被算成 0.003）。
  var RE_PCT_FULL = /^([0-9]{1,3}(?:\.[0-9]+)?)%$/;
  function pctToFraction(v) {
    var m = RE_PCT_FULL.exec(v);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!(n >= 0) || n > 100) return null;
    return Math.round(n / 100 * 10000) / 10000;
  }

  /**
   * 按「括号外空白」切分阴影串（面板 shadowTokens / 后端 _shadow_tokens 同构）。
   * 早期这里用 v.split(/\s+/)，会把 rgba(0, 0, 0, .35) 拆成 7 个碎 token，
   * 于是「面板接受、后端落盘、loader 静默丢弃」—— 最常见的 box-shadow 写法
   * 反而永远不生效。括号不配对返回 []。
   */
  function shadowTokens(value) {
    var tokens = [];
    var depth = 0;
    var buf = '';
    for (var i = 0; i < value.length; i += 1) {
      var ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth < 0) return []; }
      if (/\s/.test(ch) && depth === 0) {
        if (buf) { tokens.push(buf); buf = ''; }
        continue;
      }
      buf += ch;
    }
    if (buf) tokens.push(buf);
    if (depth !== 0) return [];
    return tokens;
  }

  // 非颜色项：这些变量允许长度/百分比/字体名/数值，而不是颜色。
  // 必须与插件端 __init__.py 的 _value_kind()/LENGTH_VARS/BLUR_VARS 保持一致，
  // 否则面板接受、应用侧静默丢弃（曾实测出两例：blur(24px) 被判非法；
  // --nts-chat-opacity 缺 number 分支而整项被丢）。
  var NON_COLOR_VARS = {
    '--nts-radius': 'length',
    '--nts-font-size': 'length',
    // Region-specific radii are independent knobs, not aliases of --nts-radius.
    '--nts-bubble-radius': 'length',
    '--nts-shell-radius': 'length',
    '--nts-card-radius': 'length',
    '--nts-modal-radius': 'length',
    '--nts-popover-radius': 'length',
    '--nts-rec-radius': 'length',
    // 聊天背板（消息列表底板）的圆角。和 --nts-radius 分开是因为后者是通用圆角，
    // 同时打在按钮/输入面板上；背板要能单独变圆而不能连带改圆按钮。
    '--nts-chat-panel-radius': 'length',
    // 聊天背景图：值是「none」或指向插件 backgrounds/ 的绝对 url(...)。
    // 它必须走单独的 image 分支：通用黑名单 RE_BAD 挡 url( 是给颜色值用的。
    '--nts-chat-bg-image': 'image',
    '--nts-font-family': 'font',
    '--nts-chat-blur': 'blur',
    '--nts-shadow': 'shadow',
    '--nts-chat-opacity': 'number',
    // 「聊天背景上那层虚化」的总开关（0 = 完全清透，1 = 原生白纱+背景模糊）。
    // 与 --nts-chat-opacity 同为 0–1 乘子，走同一个 number 分支。
    '--nts-bubble-veil': 'number',
    // 背景图亮度：0-1 乘子，1 = 原图，0 = 全黑。值种类 number，走同一个分支。
    '--nts-chat-bg-image-brightness': 'number',
    // 背景图顶上那层「雾」= 应用给历史列表容器加的 mask-image 顶部渐隐。
    // 1 = 与应用原生一致，0 = 渐隐完全取消。与上一个同走 number 分支。
    '--nts-chat-top-fade': 'number',
    // ===== 面板边缘光效 / 玻璃拟态（v0.1.11）=====
    // 全部可选；不配置则整块 CSS 不加载，外观与原生一致。
    // 挂载点见 targets.js 的 NTS_GLOW：
    //   外发光 -> anchor::before（scroll 自带 mask-image，外发光只能透出 4px）
    //   描边/四角/反射/内阴影 -> anchor::after
    //   磨砂层 -> scroll::before，z-index:-1（夹在容器背景与消息内容之间）
    '--nts-panel-glow-color': 'color',
    '--nts-panel-glow-strength': 'number',
    '--nts-panel-glow-size': 'length',
    '--nts-panel-glow-pulse': 'number',
    '--nts-panel-glow-speed': 'time',
    '--nts-panel-border-color': 'color',
    '--nts-panel-border-width': 'length',
    '--nts-panel-corner-glow': 'number',
    '--nts-panel-edge-gradient': 'number',
    '--nts-panel-glass-tint': 'color',
    '--nts-panel-glass-blur': 'blur',
    '--nts-panel-sheen': 'number',
    '--nts-panel-inner-glow': 'number'
  };

  // 明确拒绝的危险片段。
  // 注意：这里刻意 **不** 禁用圆括号 —— rgb()/hsl()/var() 合法值本身需要括号。
  // 安全性由下面每个 kind 的「整串锚定」正则保证：值必须整体匹配某个已知安全形态，
  // 因此 `)` 不可能被用来提前闭合声明。
  var RE_BAD = /[;{}<>\\]|\/\*|\*\/|url\s*:|expression\s*\(|@import|javascript:|&#/i;

  // 聊天背景图：整串锚定成「none」或本插件 backgrounds/ 下的 url(...)。
  // 只认 127.0.0.1/localhost 的绝对地址（backgrounds/ 由插件服务在 48916 提供）。
  var RE_BG_VALUE = /^(?:none|url\(\s*"?(?:https?:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5})?\/plugin\/neko_theme_studio\/ui\/backgrounds\/[A-Za-z0-9._-]{1,80}"?\s*\))$/i;

  // ---------------------------------------------------------------- 工具

  /**
   * 调色板的"新旧"标记。theme.json 不再有 version 字段，用 updated_at 充当：
   * 只用于日志/诊断展示，判等一律靠原始 JSON 文本。
   * @param {Object} p 调色板
   * @returns {string}
   */
  function stampOf(p) {
    if (!p || typeof p !== 'object') return '';
    return String(p.updated_at || p.name || '');
  }

  function log() {
    if (!DEBUG) return;
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('[theme-studio]');
      console.log.apply(console, a);
    } catch (e) { /* ignore */ }
  }

  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function safeSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  function pluginBase() {
    var o = safeGet(BASE_OVERRIDE_KEY);
    if (o && /^https?:\/\/[^\s"'<>]+$/i.test(o)) return o.replace(/\/+$/, '');
    if (typeof window.__NEKO_PLUGIN_BASE__ === 'string' && window.__NEKO_PLUGIN_BASE__) {
      return String(window.__NEKO_PLUGIN_BASE__).replace(/\/+$/, '');
    }
    // 若页面本身就在插件服务的源上（理论上不会），直接同源取。
    try {
      if (window.location && window.location.port === '48916') {
        return window.location.origin;
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_PLUGIN_BASE;
  }

  function themeUrl() {
    return pluginBase() + '/plugin/' + encodeURIComponent(PLUGIN_ID) + '/ui/theme.json';
  }

  // ---------------------------------------------------------------- 值校验

  /**
   * 判断一个值是否可以安全地写进给定变量。
   * @param {string} name  CSS 变量名
   * @param {string} value 候选值
   * @returns {boolean}
   */
  function isSafeValue(name, value) {
    if (typeof value !== 'string') return false;
    var v = value.trim();
    if (!v || v.length > 300) return false;

    var kind = NON_COLOR_VARS[name] || 'auto';
    if (kind === 'image') {
      // 背景图只有两种合法形态，整串锚定；不走 RE_BAD（url( 是它的正常写法）。
      return RE_BG_VALUE.test(v);
    }
    if (RE_BAD.test(v)) return false;

    if (kind === 'color' || kind === 'auto') {
      // 'auto' 是给「本版本之后新增、白名单里还没记录」的变量兜底。
      // 起因是一个真实事故：--nts-chat-panel-radius 加进面板与后端后，用户已开的
      // 窗口仍跑着旧 loader（浏览器缓存里是上一版脚本），旧 loader 的默认 kind
      // 是 'color'，于是把 '24px' 当成非法颜色静默丢弃 —— 背景色进去了、圆角没有，
      // 而 apply_theme 照样返回 succeeded，面板也不报错。要靠用户重启才恢复，
      // 这正是「面板改了应用里不生效」的一个系统性来源。
      // 兜底只放行 color 与 length 两种已锚定的安全形态，不降低其它安全性。
      var asColor =
        isNamedColor(v) || RE_HEX.test(v) ||
        RE_RGB.test(v) || RE_HSL.test(v);
      if (asColor) return true;
      if (kind === 'color') {
        // 刻意**不**支持 `var(--nts-*)` 派生色：面板与后端都只收具体色值，loader 单独放行
        // 会造出一条只有手改 theme.json 才走得通的路，且「颜色变量引用长度变量」这类
        // 组合会让声明整条失效（静默无色）。三处校验必须逐字一致，见 THEME_CONTRACT §9.10b。
        return false;
      }
      // kind === 'auto' 且不是颜色 → 再按长度试一次（与下面的 length 分支同判定）
      if (v.indexOf('-') !== -1) return false;
      return RE_LEN.test(v) || RE_PCT.test(v) || /^0$/.test(v);
    }
    if (kind === 'length') {
      // 负长度在 CSS 里一律非法（整条声明被丢掉 → 面板报成功、外观不变）。
      // 后端 _is_safe_value 与面板 isSafeValue 都单独拦 '-'，这里必须对齐；
      // RE_LEN 为了 shadow 偏移量才允许负号（shadow 走自己的 token 分支）。
      if (v.indexOf('-') !== -1) return false;
      if (RE_LEN.test(v) || RE_PCT.test(v)) return true;
      if (/^0$/.test(v)) return true;
      return false;
    }
    if (kind === 'blur') {
      // 面板统一输出 blur(...)，但契约 §3 允许裸长度；两者都收，存原样。
      // 负模糊值同样非法（backdrop-filter 整条失效），与后端/面板一致拒掉。
      if (v.indexOf('-') !== -1) return false;
      // % / vh / vw 不是合法的 blur 半径（CSS 会丢整条声明），与后端 RE_BLUR_BARE 一致拒掉。
      return RE_BLUR.test(v) || RE_BLUR_BARE.test(v) || /^0$/.test(v);
    }
    if (kind === 'time') {
      // 呼吸周期（v0.1.11）。裸数字按秒（3 = 3s），稍后 sanitizeVars 会补单位。
      // 只收 s / ms：呼吸节奏用不到其它单位，放宽只会放出无效 CSS。
      if (RE_TIME.test(v)) {
        var unit = v.slice(-2).toLowerCase();
        var sec = unit === 'ms' ? parseFloat(v.slice(0, -2)) / 1000
          : parseFloat(v.slice(0, -1));
        return isFinite(sec) && sec >= 0 && sec <= TIME_MAX_SECONDS;
      }
      if (RE_TIME_BARE.test(v)) return parseFloat(v) <= TIME_MAX_SECONDS;
      return false;
    }
    if (kind === 'number') {
      if (RE_NUMBER.test(v)) return true;
      // 面板的数值输入框允许写百分比（`50%` 表示半透明），后端也接受；
      // 本脚本早先只认 0-1 小数，于是「面板不标红、落盘成功、这里静默丢弃」。
      // 现在收 <=100%，并在 sanitizeVars 里归一成小数（乘子语义）。
      return pctToFraction(v) !== null;
    }
    if (kind === 'font') {
      return RE_FONT.test(v) && !RE_BAD.test(v);
    }
    if (kind === 'shadow') {
      // box-shadow 的语法是 <inset>? && <length>{2,4} && <color>?；只做 token
      // 白名单会放行 '0 0 10% #000'（百分比非法）、'1px'（长度不足）等，
      // 浏览器整条丢弃 → 面板报成功、外观不变。三处校验必须同判定。
      // 多层写法（逗号分隔）要先切层再逐层校验；只认单层会把
      // `0 0 20px rgba(...), 0 0 15px rgba(...)` 整串拒掉 → 门控不设 → 阴影静默消失。
      var layers = shadowLayers(v);
      if (!layers.length || layers.length > 4) return false;
      for (var li = 0; li < layers.length; li++) {
        if (!shadowLayerOk(shadowTokens(layers[li]))) return false;
      }
      return true;
    }
    return false;
  }

  /** 按「顶层逗号」切多层 box-shadow（后端 _split_shadow_layers 同构）。 */
  function shadowLayers(value) {
    var layers = [];
    var depth = 0;
    var buf = '';
    for (var i = 0; i < value.length; i += 1) {
      var ch = value[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth < 0) return []; }
      if (ch === ',' && depth === 0) {
        if (buf.replace(/\s+/g, '')) layers.push(buf.trim());
        buf = '';
        continue;
      }
      buf += ch;
    }
    if (depth !== 0) return [];
    if (buf.replace(/\s+/g, '')) layers.push(buf.trim());
    return layers;
  }

  /** 单层 box-shadow 的 token 校验（与后端 _shadow_layer_ok 同判定）。 */
  function shadowLayerOk(toks) {
    if (!toks.length || toks.length > 6) return false;
    var lengths = 0;
    var colors = 0;
    var insets = 0;
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      if (/^inset$/i.test(tk)) {
        if (++insets > 1) return false;
        continue;
      }
      if (isNamedColor(tk) || RE_HEX.test(tk) || RE_RGB.test(tk) || RE_HSL.test(tk)) {
        if (++colors > 1) return false;
        continue;
      }
      if (RE_PCT.test(tk) || tk.indexOf('%') !== -1) return false;
      if (RE_LEN.test(tk) || /^0$/.test(tk)) {
        lengths += 1;
        if (lengths > 4) return false;
        if (tk.charAt(0) === '-' && lengths > 2) return false;
        continue;
      }
      return false;
    }
    return lengths >= 2;
  }

  function isSafeVarName(name) {
    return typeof name === 'string' &&
      name.indexOf(VAR_PREFIX) === 0 &&
      /^--nts-[a-z0-9-]{1,60}$/.test(name);
  }

  /**
   * 过滤出一个安全的 vars 对象。
   * @returns {Object<string,string>}
   */
  function sanitizeVars(src) {
    var out = {};
    if (!src || typeof src !== 'object') return out;
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      if (!isSafeVarName(k)) { log('reject var name', k); continue; }
      if (!isSafeValue(k, src[k])) { log('reject value', k, src[k]); continue; }
      var v = String(src[k]).trim();
      // 与插件端 normalize_value() 对齐：裸长度补成 blur(...)，否则
      // `backdrop-filter: 18px` 整条声明非法而被浏览器丢弃。
      if (NON_COLOR_VARS[k] === 'blur' && RE_BLUR_BARE.test(v)) v = 'blur(' + v + ')';
      // 百分比乘子归一成小数：`50%` → `0.5`。存原样会让 CSS 拿到 `50%` 而整条失效。
      if (NON_COLOR_VARS[k] === 'number') {
        var frac = pctToFraction(v);
        if (frac !== null) v = String(frac);
      }
      // 时间值补单位：`animation-duration: 3` 是非法 CSS（时长必须带单位），
      // 不补的话整条 animation 声明被丢弃 → 「节奏填了但不动」。
      if (NON_COLOR_VARS[k] === 'time' && RE_TIME_BARE.test(v)) v = v + 's';
      out[k] = v;
    }
    return out;
  }

  // ---------------------------------------------------------------- 注入

  function styleEl() {
    var el = document.getElementById(STYLE_ID);
    if (el) return el;
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-nts', '1');
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  function removeStyle() {
    var el = document.getElementById(STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    clearGates();
  }

  // ------------------------------------------------------- 门控属性（gates）
  //
  // stylesheet 里有一批规则无法用"原生回退值"表达（原生是 gradient、或原生值
  // 随上下文变化、或需要整组属性一起换）。这些规则统一门控在
  //   :root[data-nts-<var>]      -- 该变量确实被用户配置过
  //   :root[data-nts-active]     -- 至少有一个变量被配置过
  // 上。因此 loader 必须把这些属性同步打到 documentElement，否则那部分规则
  // 永远不生效（曾实测出该缺陷：只有 data-nts="1"，规则全程空转）。

  // v3 起**每一条**生成的规则都门控在按模式分键的属性上：
  //   :root:not([data-theme="dark"])[data-nts-l-<var>]  -- 该变量在「亮色」组被配置过
  //   :root[data-theme="dark"][data-nts-d-<var>]        -- 该变量在「暗色」组被配置过
  // 且不再有任何回退值。原因：回退值是合成量测页里量到的，那不是真实页的计算值
  // （真实 .chat-body 处于 .chat-surface-mode-compact 下、body 带 .electron-chat-window、
  // 还有运行时注入的 !important style 层），任何量测回退都会静默改写未配置外观。
  // 门控后「未配置 == 未加载」是构造性成立的：没有属性 → 选择器不匹配 → 零效果。
  var GATE_ATTR = 'data-nts-';
  var ACTIVE_ATTR = 'data-nts-active';
  // 亮色值的限定作用域：非暗色时才是亮色。与生成器的亮色门控前缀保持一致语义。
  var LIGHT_SCOPE = ':root:not([data-theme="dark"])';
  var gateApplied = null; // Array<string> 上一次打上的属性名，用于精确撤销

  /** 变量名 + 模式 -> 门控属性名：data-nts-l-foo / data-nts-d-foo
   *  必须与 gen-css.js 的 gateAttrFor() 完全一致（去掉整个 `--nts-` 前缀）。 */
  function gateNameFor(varName, mode) {
    return GATE_ATTR + (mode === 'dark' ? 'd-' : 'l-') + String(varName).replace(/^--nts-/, '');
  }

  function clearGates() {
    var de = document.documentElement;
    if (!de) return;
    if (gateApplied) {
      for (var i = 0; i < gateApplied.length; i++) de.removeAttribute(gateApplied[i]);
    } else {
      // 没有记账时兜底扫描，避免残留陈旧门控（属性变化会触发样式重算）
      var names = [];
      for (var j = 0; j < de.attributes.length; j++) {
        var n = de.attributes[j].name;
        if (n.indexOf(GATE_ATTR) === 0) names.push(n);
      }
      for (var k = 0; k < names.length; k++) de.removeAttribute(names[k]);
    }
    gateApplied = null;
  }

  /**
   * 把当前调色板的变量同步成 documentElement 上的门控属性。
   * 幂等：集合不变则不碰 DOM（省掉一次整页样式重算）。
   * @param {Object<string,string>} light
   * @param {Object<string,string>} dark
   */
  function setGates(light, dark) {
    var de = document.documentElement;
    if (!de) return;
    var want = [];
    var seen = {};
    function add(o, mode) {
      var ks = [];
      for (var k in o) {
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        // 按 (模式, 变量) 去重：同一个变量可以在两组里都出现，那是两个独立门控。
        var key = mode + '|' + k;
        if (seen[key]) continue;
        seen[key] = 1;
        ks.push(k);
      }
      ks.sort();
      for (var i = 0; i < ks.length; i++) want.push(gateNameFor(ks[i], mode));
    }
    add(light, 'light');
    add(dark, 'dark');
    if (!want.length) { clearGates(); return; }
    want.unshift(ACTIVE_ATTR);

    var same = gateApplied && gateApplied.length === want.length;
    if (same) {
      for (var i = 0; i < want.length; i++) {
        if (gateApplied[i] !== want[i]) { same = false; break; }
      }
    }
    if (same) return;

    clearGates();
    for (var m = 0; m < want.length; m++) de.setAttribute(want[m], '1');
    gateApplied = want;
  }

  /**
   * 样式表是否真的加载了（href 里带 neko-theme-studio.css 的那张）。
   * 变量注入成功但样式表没加载时，门控属性照样打上、变量照样解析，
   * 却没有任何规则使用它们 —— 外观完全不变且控制台全静默。
   * 这是「面板改了色、本体没反应」最隐蔽的一种形态，必须大声报出来。
   */
  /** 数「真实样式规则」条数，穿透分组规则。
   *
   *  v3.1 起整张表被包在 `@layer nts-theme { … }` 里（为了用 layered !important
   *  压过 index.css 里那几条双 id !important 的原生规则），于是顶层 cssRules
   *  恒为 1。直接报 .length 会让 diagnose() 看起来"只加载了 1 条规则"，把正常
   *  状态误判成半残。这里递归展开 @layer / @media / @supports 再计数。 */
  function countStyleRules(sheet) {
    var n = 0;
    try {
      var rules = sheet && sheet.cssRules;
      if (!rules) return 0;
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        // 分组规则没有 selectorText，但有 cssRules
        if (r.selectorText === undefined && r.cssRules) {
          n += countStyleRules({ cssRules: r.cssRules });
        } else if (r.selectorText !== undefined) {
          n += 1;
        }
      }
    } catch (e) { /* cross-origin 或无权限 */ }
    return n;
  }

  function cssSheetInfo() {
    var info = { loaded: false, rules: 0 };
    try {
      var sheets = document.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        var href = sheets[i].href || '';
        if (href.indexOf('neko-theme-studio.css') !== -1) {
          info.loaded = true;
          info.rules = countStyleRules(sheets[i]);
          break;
        }
      }
    } catch (e3) { /* ignore */ }
    return info;
  }

  /** 样式表缺失只大声报一次，避免轮询刷屏。 */
  var warnedNoCss = false;
  function warnIfCssMissing() {
    if (warnedNoCss) return;
    var info = cssSheetInfo();
    if (info.loaded) return;
    warnedNoCss = true;
    try {
      console.warn('[theme-studio] 样式表 neko-theme-studio.css 未加载：CSS 变量已经注入，' +
        '但没有任何规则去使用它们，所以外观不会变化。' +
        '\n  多半是模板补丁没打上（install.ps1 的 §C），或 /static/css/neko-theme-studio.css 没复制到 static 目录。' +
        '\n  自查：在应用窗口执行 NekoThemeStudio.diagnose() 看 cssLoaded。');
    } catch (e) { /* ignore */ }
  }

  /**
   * 样式表新鲜度自愈（1.4.0）。
   *
   * 模板里的 <link href="/static/css/neko-theme-studio.css?v=<asset>-<css sha8>">
   * 会随每次部署变化，但**已经打开的窗口**不会重新加载页面：HTTP 头是
   * max-age=3600，渲染器还会再缓存一份。于是插件重启、CSS 已更新，用户看到的
   * 仍是旧规则 —— 这正是「面板里改了色，本体没反应」乃至「旧版的 bug 继续
   * 生效」的系统性原因（旧版把 AI 文字色挂在无作用域的 .message-block-* 上，
   * 用户即使已经部署了新 CSS，窗口里跑的还是旧表，串色照旧）。
   *
   * 做法：用 cache:'reload' 直接向服务端要当前文件，把它解析成一张构造样式表
   * 并与页面里已生效的那张比「规则数 + 规则文本长度」签名；不一致说明页面里的
   * 是旧的 → 把 link 的 href 换成一个带新查询串的 URL 强制换表。签名一致时不动
   * （正常加载零额外开销，也不会闪一下）。任何一步失败都静默降级。
   */
  // 自愈不能只做一次。这个函数原来用 `sheetChecked` 守成一次性：启动那一刻对不上
  // 就换表，之后再也不看。但「已经打开的窗口」才是最常见的受害者 —— 用户开着窗口
  // 时插件被更新，页面里的表永远是旧的，而 1500ms 的调色轮询照样在跑、变量照样在
  // 更新，于是面板显示成功、窗口纹丝不动。现在改成轮询里按 SHEET_CHECK_MS 节流复检。
  var SHEET_CHECK_MS = 15000;
  var lastSheetCheckAt = 0;
  var sheetSwapCount = 0;
  function sheetSignature(sheet) {
    try {
      var rules = sheet.cssRules || [];
      var total = 0;
      for (var i = 0; i < rules.length; i++) total += (rules[i].cssText || '').length;
      // 用「真实样式规则条数 + 全部规则文本长度」做签名：只数顶层时，整表被
      // @layer 包起来会让条数恒为 1，届时签名只剩文本长度一半信息，换表检测
      // 会变钝。countStyleRules 会穿透分组规则，签名对包 layer 与不包都可比。
      return countStyleRules(sheet) + ':' + total;
    } catch (e) { return null; }
  }

  function refreshStaleStylesheet(force) {    // 节流：轮询里每 15s 最多复检一次，避免每次心跳都去 fetch 一遍。
    // force=true（启动时）跳过节流。
    var now = Date.now();
    if (!force && now - lastSheetCheckAt < SHEET_CHECK_MS) return;
    lastSheetCheckAt = now;
    var link = null;
    try {
      var links = document.querySelectorAll('link[rel~="stylesheet"][href*="neko-theme-studio.css"]');
      if (!links || !links.length) return;
      link = links[0];
    } catch (e) { return; }

    var href = '';
    var abs = '';
    try {
      href = link.getAttribute('href') || '';
      abs = new URL(href, window.location.href).href;
      if (!/^https?:/i.test(abs)) return;
    } catch (e) { return; }

    // 找到页面里已经生效的那张表（href 含同名文件即可）。
    var loaded = null;
    try {
      var sheets = document.styleSheets || [];
      for (var i = 0; i < sheets.length; i++) {
        if ((sheets[i].href || '').indexOf('neko-theme-studio.css') !== -1) { loaded = sheets[i]; break; }
      }
    } catch (e) { /* ignore */ }
    if (!loaded) return;
    var loadedSig = sheetSignature(loaded);
    if (!loadedSig) return;

    // 构造样式表：Chromium 73+ 支持。解析失败就放弃自愈，绝不影响既有样式。
    var probe = null;
    try { probe = new window.CSSStyleSheet(); } catch (e) { return; }

    fetch(abs, { cache: 'reload', credentials: 'omit' }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.text();
    }).then(function (css) {
      if (!css) return;
      try { probe.replaceSync(css); } catch (e) { return; }
      var serverSig = sheetSignature(probe);
      if (!serverSig || serverSig === loadedSig) return;
      // 服务端的表与页面上生效的不是同一份（页面是旧的）→ 换表。
      // 先把上一次换表留下的 nts-refresh 参数剥掉再拼，否则每换一次 URL 就长一截。
      var base = abs.replace(/([?&])nts-refresh=\d+/g, '').replace(/[?&]$/, '');
      var sep = base.indexOf('?') === -1 ? '?' : '&';
      var busted = base + sep + 'nts-refresh=' + Date.now();
      sheetSwapCount += 1;
      link.setAttribute('href', busted);
      try {
        console.warn('[theme-studio] 页面里的 neko-theme-studio.css 与服务器上的不一致（窗口打开后插件更新过），' +
          '已强制换表（第 ' + sheetSwapCount + ' 次）。');
      } catch (e4) { /* ignore */ }
    })['catch'](function () { /* 静默降级 */ });
  }

  /**
   * 磁盘上的加载器是否比本实例新？新则重载本页面，让新脚本接管。
   *
   * 为什么必须重载而不是热替换：本脚本是一个已执行的 IIFE，闭包里的
   * NON_COLOR_VARS 白名单、正则与函数全被冻结。插件新增一个长度类变量后，
   * 旧实例会把它当颜色拒掉（`log('reject value', ...)` 只在 DEBUG 下可见），
   * 门控属性永不设置，于是「面板显示已应用、窗口毫无变化」。
   * 这正是用户反复遇到的「改了不生效」的根因，而且无法靠 CSS 侧补救 ——
   * 门控属性由本脚本写入，旧脚本不认识新变量就永远不会写。
   *
   * 安全阀：sessionStorage 记录「触发重载时正在运行的版本」。重载成功后本实例的
   * SCRIPT_VERSION 变成新版本，与记录不再相等，于是下一轮心跳照常比对 —— 这样
   * 才可能连续升级多次（1.4.2 → 1.5.0 → 1.5.2 → …）。只有在「重载了却仍然拿回
   * 同一个旧脚本」（HTTP 缓存没绕开）时两者才会相等，此时停下，避免无限刷新。
   * 另外两次尝试至少间隔 SELF_UPGRADE_MIN_INTERVAL_MS。
   */
  function selfUpgradeIfNeeded() {
    var now = Date.now();
    if (now - selfUpgradeAt < SELF_UPGRADE_MIN_INTERVAL_MS) return;

    var guard = '';
    try { guard = window.sessionStorage.getItem(SELF_UPGRADE_GUARD_KEY) || ''; } catch (e) { guard = ''; }
    if (guard) {
      var gPart = String(guard).split('@');
      var gVer = gPart[0] || '';
      var gAt = parseInt(gPart[1] || '0', 10) || 0;
      // 同一个版本 + 冷却期内 = 刚重载过却还是这个脚本（缓存没绕开），先停。
      // 冷却期过后允许再试一次，避免一次缓存失误永久锁死升级能力。
      if (gVer === SCRIPT_VERSION && (now - gAt) < SELF_UPGRADE_COOLDOWN_MS) return;
    }

    var src = '';
    try {
      var scripts = document.querySelectorAll('script[src*="neko-theme-studio.js"]');
      if (!scripts || !scripts.length) return;
      src = scripts[0].getAttribute('src') || '';
      if (!src) return;
    } catch (e2) { return; }

    var url = '';
    try {
      url = new URL(src, window.location.href).href;
      if (!/^https?:/i.test(url)) return;
      // 加时间戳绕开 HTTP 缓存，否则可能拿回同一份旧脚本。
      url = url.replace(/([?&])nts-upgrade=\d+/g, '').replace(/[?&]$/, '');
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'nts-upgrade=' + now;
    } catch (e3) { return; }

    selfUpgradeAt = now;

    fetch(url, { cache: 'reload', credentials: 'omit' }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.text();
    }).then(function (code) {
      if (!code) return;
      // 比版本号：只有服务端脚本确实更新了才重载，否则会无谓刷新页面。
      var m = /SCRIPT_VERSION\s*=\s*'([^']+)'/.exec(code);
      var remote = m ? m[1] : '';
      if (!remote || remote === SCRIPT_VERSION) return;
      try {
        // 存「正要离开的版本 + 现在」：重载后新实例的 SCRIPT_VERSION 变成 remote，
        // 与记录的 gVer 不等，于是下一轮照常比对（这是 1.5.0 卡死的修复点）；
        // 若重载后版本没变（缓存没绕开），则靠冷却期兜底，不会永久锁死。
        window.sessionStorage.setItem(SELF_UPGRADE_GUARD_KEY, SCRIPT_VERSION + '@' + now);
      } catch (e5) { /* ignore */ }
      // 不能把用户正在输入的草稿刷掉：输入框有内容就先不重载，等下一轮心跳
      // （节流 60s）再试。同理会话正在流式输出时也让路，避免打断回复。
      try {
        var ta = document.querySelector('textarea.composer-input, #textInputBox');
        if (ta && ta.value && String(ta.value).trim()) {
          log('self-upgrade deferred: composer has draft text');
          return;
        }
        if (document.querySelector('.message-block-status, [data-streaming="true"]')) {
          log('self-upgrade deferred: a reply is in flight');
          return;
        }
      } catch (e8) { /* ignore */ }
      try {
        console.warn('[theme-studio] 检测到加载器已升级：本窗口 ' + SCRIPT_VERSION +
          ' → ' + remote + '，正在重新加载本页面以接管（避免新变量被旧脚本丢弃）。');
      } catch (e6) { /* ignore */ }
      try { window.location.reload(); } catch (e7) { /* ignore */ }
    })['catch'](function () { /* 静默降级：拿不到就不升级，行为与旧版一致 */ });
  }

  /**
   * 当前外观模式。应用的主窗口用 html[data-theme="dark"] 切换暗色
   * （resources/bin/static/theme-manager.js），部分页面同时挂 .dark 类，
   * 两者都认；都没有时退回系统配色。
   */
  function currentMode() {
    try {
      var de = document.documentElement;
      if (de) {
        var t = de.getAttribute('data-theme');
        if (t === 'dark') return 'dark';
        if (t === 'light') return 'light';
        if (de.classList && de.classList.contains('dark')) return 'dark';
      }
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) { /* ignore */ }
    return 'light';
  }

  /**
   * 「当前模式这一组是空的、另一组却有值」—— 这是最常见的「面板显示已应用、
   * 本体一点没变」：亮色与暗色两组各管各的（已拍板的需求），用户只配了亮色
   * 而应用正跑在暗色，于是变量注入了、门控也打上了，可视区域却没有任何规则命中。
   * 每种组合只提醒一次，切换亮/暗时会重新检查。
   */
  var warnedMode = {};
  function warnIfModeUncovered(nLight, nDark) {
    var mode = currentMode();
    var miss = (mode === 'dark') ? nDark : nLight;
    var other = (mode === 'dark') ? nLight : nDark;
    if (miss !== 0 || other === 0) return;
    var key = mode + ':' + other;
    if (warnedMode[key]) return;
    warnedMode[key] = 1;
    var zh = (mode === 'dark') ? '暗色' : '亮色';
    var otherZh = (mode === 'dark') ? '亮色' : '暗色';
    try {
      console.warn('[theme-studio] 当前是' + zh + '模式，但调色板里' + zh + '这一组是空的' +
        '（' + otherZh + '组有 ' + other + ' 项）。两组互不影响，只配一组不会改变另一组的外观 —— ' +
        '请在主题工坊面板切到「' + zh + '」页签再配一遍，或把应用切到' + otherZh + '模式看看。');
    } catch (e) { /* ignore */ }
  }

  function declBlock(vars) {
    var buf = [];
    for (var k in vars) {
      if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
      buf.push(k + ':' + vars[k]);
    }
    return buf.join(';');
  }

  /**
   * 应用一个调色板。幂等：内容不变则不写 DOM。
   * @param {{vars?:Object,dark_vars?:Object,enabled?:boolean,name?:string,updated_at?:string}} p
   */
  function applyPalette(p) {
    if (!p || typeof p !== 'object') return false;

    if (p.enabled === false) {
      removeStyle();
      currentVersion = stampOf(p);
      lastApply = { light: 0, dark: 0, enabled: false, at: Date.now() };
      return true;
    }

    var light = sanitizeVars(p.vars);
    var dark = sanitizeVars(p.dark_vars);
    var nLight = Object.keys(light).length;
    var nDark = Object.keys(dark).length;

    if (!nLight && !nDark) {
      // 空调色板 = 恢复原样
      removeStyle();
      currentVersion = stampOf(p);
      lastApply = { light: 0, dark: 0, enabled: true, at: Date.now() };
      return true;
    }

    var css = '';
    var l = declBlock(light);
    // 亮色值必须限定在「非暗色」，否则只配了亮色时会渗进暗色模式
    // （独立验证者反例 CE-B：:root{} 里的亮色值在暗色下依然生效）。
    if (l) css += LIGHT_SCOPE + '{' + l + '}';
    var d = declBlock(dark);
    if (d) css += ':root[data-theme="dark"]{' + d + '}';

    var el = styleEl();
    if (el.textContent !== css) el.textContent = css;
    // 门控属性必须在样式生效前同步（同一帧内 setAttribute 与 <style> 内容变化
    // 都会被合并进同一次样式重算，不会闪一下未门控的状态）。
    setGates(light, dark);
    warnIfCssMissing();
    warnIfModeUncovered(nLight, nDark);
    currentVersion = stampOf(p);
    lastApply = { light: nLight, dark: nDark, enabled: true, at: Date.now() };
    // 应用成功后强制刷新一次自检快照：排查时最需要的正是「应用之后」的门控与
    // 注入内容状态，若只在启动时抓一次，快照会是空的、看不出问题。
    lastSnapAt = 0;
    persistSnapshot();
    return true;
  }

  // ---------------------------------------------------------------- 状态

  var currentVersion = null;
  var lastFetchAt = 0;
  var timer = null;
  var inflight = false;
  /** 最近一次成功应用的摘要（诊断用）。 */
  var lastApply = null;
  /** 最近一次拉取失败的原文 + 时间（诊断用）。 */
  var lastError = null;
  var lastErrorAt = 0;
  /** 已经向控制台大声报过的错误，避免 1.5s 一次的轮询刷屏。 */
  var lastWarnedError = null;
  /** 上次应用成功的调色板原文，用来识别「版本号没变但内容变了」。 */
  var lastRaw = null;

  function restoreFromCache() {
    var raw = safeGet(CACHE_KEY);
    if (!raw) return false;
    try {
      var p = JSON.parse(raw);
      if (!p || p.schema !== 1) return false;
      return applyPalette(p);
    } catch (e) {
      log('cache parse failed', e);
      return false;
    }
  }

  function saveToCache(p) {
    try { safeSet(CACHE_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------- 服务自愈（重启后拉起插件）
  //
  // 实测到的故障链：应用冷启动 → 用户插件总开关(user_plugin_enabled)默认关 →
  // 插件生命周期压根不启动 → GET /plugins 返回空 → /plugin/<id>/ui/theme.json
  // 直接 404 → 本加载器永远拉不到调色板 → 「面板能改、应用不变色」。
  //
  // 宿主没有给外部注入的接口，但插件服务(48916)的这三个端点都允许跨源调用，
  // 并且只要带合法 CSRF 令牌就接受带 Origin 的请求：
  //   GET  /security/csrf-token        取令牌（预检回显 allow-origin/allow-headers）
  //   POST /plugins/refresh            重新扫描插件目录 → registry 重新填充
  //   POST /plugin/<id>/start          启动本插件（同时把 auto_start 偏好落盘）
  // 于是加载器自己就能把整条链路救活，不依赖任何手工操作或宿主开关。
  var reviveAt = 0;
  var reviveCount = 0;
  var reviving = false;
  var lastReviveError = null;

  /** 只有「插件没注册 / 服务不可达」才值得自愈；其它 HTTP 错误自愈没有意义。 */
  function shouldRevive(msg) {
    if (!msg) return false;
    if (msg.indexOf('HTTP 404') === 0) return true;
    if (msg.indexOf('HTTP 503') === 0) return true;
    // fetch 抛 TypeError（Failed to fetch）= 连接被拒 / 服务没起来
    return msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1 ||
      msg.indexOf('Load failed') !== -1;
  }

  function reviveService(msg) {
    if (reviving) return;
    if (!shouldRevive(msg)) return;
    if (reviveCount >= REVIVE_MAX_ATTEMPTS) return;
    var now = Date.now();
    if (reviveAt && now - reviveAt < REVIVE_MIN_INTERVAL_MS) return;
    reviveAt = now;
    reviveCount += 1;
    reviving = true;
    var base = pluginBase();
    var token = null;
    var okHdrs = function (tok) {
      var h = { 'Content-Type': 'application/json' };
      if (tok) h['X-CSRF-Token'] = tok;
      return h;
    };
    var postJson = function (path, tok) {
      return window.fetch(base + path, {
        method: 'POST', headers: okHdrs(tok), body: '{}',
        cache: 'no-store', credentials: 'omit', mode: 'cors'
      }).then(function (r) { return r.ok; }, function () { return false; });
    };
    window.fetch(base + '/security/csrf-token', {
      cache: 'no-store', credentials: 'omit', mode: 'cors'
    }).then(function (r) {
      if (!r || !r.ok) throw new Error('csrf HTTP ' + (r ? r.status : '?'));
      return r.json();
    }).then(function (j) {
      token = (j && (j.csrf_token || j.token)) || null;
      if (!token) throw new Error('csrf token missing');
      // 1) 重新扫描插件目录，让 registry 从空恢复（冷启动后最常见的状态）
      return postJson('/plugins/refresh', token);
    }).then(function () {
      // 2) 启动本插件（已运行时返回 already_running，无副作用）
      return postJson('/plugin/' + encodeURIComponent(PLUGIN_ID) + '/start', token);
    }).then(function () {
      reviving = false;
      lastReviveError = null;
      log('service revived, refetching palette');
      // 3) 立刻重取一次调色板（插件启动后静态路由才可用）
      window.setTimeout(function () { fetchPalette(true); }, 600);
      window.setTimeout(function () { fetchPalette(true); }, 2500);
    }).catch(function (err) {
      reviving = false;
      lastReviveError = (err && err.message) || 'unknown';
      log('revive failed', lastReviveError);
    });
  }
  function fetchPalette(force) {
    if (inflight) return;
    inflight = true;
    var url = themeUrl() + '?_=' + Date.now();
    var opts = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
    var req;
    try {
      req = window.fetch(url, opts);
    } catch (e) {
      inflight = false;
      return;
    }
    req.then(function (res) {
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
      return res.json();
    }).then(function (p) {
      inflight = false;
      lastFetchAt = Date.now();
      if (!p || typeof p !== 'object') return;
      lastError = null;
      lastWarnedError = null;
      // 拉取成功 = 服务健康，重置自愈预算（下次真挂了还能再救）
      reviveCount = 0;
      reviveAt = 0;
      var raw = '';
      try { raw = JSON.stringify(p); } catch (e) { raw = ''; }
      // theme.json 不再有 version 字段（v0.1.5 起）：raw 是服务端返回 JSON 的精确
      // 文本，逐字相同就是「没变化」。这比版本号更严格 —— 手工改 theme.json、
      // 重置回同一份内容都能如实反映。
      if (!force && raw === lastRaw) {
        return; // 无变化
      }
      applyPalette(p);
      lastRaw = raw;
      saveToCache(p);
      log('palette updated', stampOf(p));
      try {
        window.dispatchEvent(new CustomEvent('neko-theme-studio-changed', {
          detail: { name: p.name, updatedAt: p.updated_at || '' }
        }));
      } catch (e) { /* ignore */ }
    }).catch(function (err) {
      inflight = false;
      var msg = (err && err.message) || 'unknown';
      lastError = msg;
      lastErrorAt = Date.now();
      // 轮询每 1.5s 一次，同一个错误只大声报一次，之后走 debug 日志。
      if (msg !== lastWarnedError) {
        lastWarnedError = msg;
        try {
          console.warn('[theme-studio] 拉取调色板失败（保留缓存，窗口内不会应用新主题）：' + msg +
            '\n  端点：' + url +
            '\n  如果是 CORS / 连接被拒，插件服务没起来或没允许跨源，颜色永远不会变。');
        } catch (e) { /* ignore */ }
      }
      log('fetch failed (keeping cache)', msg);
      // 插件没注册 / 服务不可达 → 自己把插件服务叫醒（节流，见 reviveService）
      reviveService(msg);
    });
  }

  function startPolling() {
    stopPolling();
    timer = window.setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      // 每次心跳都顺带复检一次样式表新鲜度（内部按 15s 节流）。这样用户在面板里
      // 改了色，即使窗口是在插件更新之前打开的，也能在十几秒内自己换到新规则表，
      // 不需要重启应用。
      refreshStaleStylesheet(false);
      // 顺带检查加载器本身是否已被插件更新（内部 60s 节流 + 会话内一次）。
      selfUpgradeIfNeeded();
      fetchPalette(false);
      // 把本窗口的自检状态定期落盘，便于外部排查（内部 60s 节流）。
      try { if (window.NekoThemeStudio && window.NekoThemeStudio.report) window.NekoThemeStudio.report(); } catch (e9) { /* ignore */ }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (timer !== null) { window.clearInterval(timer); timer = null; }
  }

  // ---------------------------------------------------------------- 引导

  // 1) 先用手上的缓存立刻渲染，避免启动闪烁。
  restoreFromCache();

  // 2) 再向插件服务要最新版。
  function boot() {
    // 一行「我还活着」——排查「本体到底加载到脚本没有」时控制台一眼可见。
    try {
      console.info('[theme-studio] loader v' + SCRIPT_VERSION + ' 已加载，端点 ' + themeUrl());
    } catch (e) { /* ignore */ }

    // 先确认样式表是当前版本（否则规则是旧的，注入再正确也不生效）。
    // 启动时强制检查一次，不看节流。
    refreshStaleStylesheet(true);

    fetchPalette(true);
    startPolling();
    // 启动时也查一次加载器新旧：用户可能已经很多天没重启应用，窗口里跑的是
    // 好几版之前的脚本，新变量全都被静默丢弃。
    selfUpgradeIfNeeded();

    // 应用切换亮/暗（html[data-theme]）时重新检查「当前模式那一组是否为空」，
    // 否则用户先配亮色、再切暗色，就永远看不到那条提示。
    try {
      if (window.MutationObserver) {
        var mo = new window.MutationObserver(function () {
          if (lastApply) warnIfModeUncovered(lastApply.light, lastApply.dark);
        });
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
      }
    } catch (e) { /* ignore */ }

    // 窗口重新获得焦点 / 重新可见 → 立即同步一次（用户刚在面板里改完色）
    window.addEventListener('focus', function () { fetchPalette(false); }, false);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') fetchPalette(false);
    }, false);

    // 同一源的其它窗口改了缓存 → 跟进（应用内多窗口场景）
    window.addEventListener('storage', function (ev) {
      if (!ev || ev.key !== CACHE_KEY || !ev.newValue) return;
      try {
        var p = JSON.parse(ev.newValue);
        if (!p || p.schema !== 1) return;
        // 与 fetchPalette 的判等口径保持一致：只比原始 JSON 文本。
        var raw = '';
        try { raw = JSON.stringify(p); } catch (e0) { raw = ''; }
        if (raw === lastRaw) return;
        applyPalette(p);
        lastRaw = raw;
      } catch (e) { /* ignore */ }
    }, false);

    // 暗色切换后变量本身不用重算（CSS 选择器负责），但给外部一个钩子
    window.addEventListener('neko-theme-changed', function () { /* no-op, 保留给后续扩展 */ }, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

  // ---------------------------------------------------------------- 对外 API

  window.NekoThemeStudio = {
    /** 立即重新拉取调色板 */
    refresh: function () { fetchPalette(true); },
    /** 直接应用一个调色板对象（调试/手工用） */
    apply: applyPalette,
    /** 清除本窗口注入的变量（回到应用原生外观；下次轮询会自动重新应用） */
    clear: function () {
      removeStyle();
      // 不清内容判等键的话，轮询会认为「没变化 = 不用重注入」，
      // 调用 clear() 之后调色板再也不会回来（只有调试 API 会踩到，但很隐蔽）。
      currentVersion = '';
      lastRaw = null;
      lastApply = null;
    },
    /** 当前调色板的 updated_at 标记（v0.1.5 起 theme.json 不再有 version 字段） */
    get updatedAt() { return currentVersion; },
    /** 加载器脚本自身版本（部署漂移自查用） */
    scriptVersion: SCRIPT_VERSION,
    /** 插件服务基址；写入 localStorage 可覆盖 */
    get baseUrl() { return pluginBase(); },
    setBaseUrl: function (u) {
      if (u) safeSet(BASE_OVERRIDE_KEY, String(u)); else {
        try { window.localStorage.removeItem(BASE_OVERRIDE_KEY); } catch (e) { /* ignore */ }
      }
    },
    /** 打开调试日志 */
    setDebug: function (on) { DEBUG = !!on; },
    /** 立刻手动叫醒插件服务（refresh + start），用于重启后不想等轮询 */
    revive: function () { reviveCount = 0; reviveAt = 0; reviveService('HTTP 404'); },
    /**
     * 自检：把「加载器 → 插件 → CSS」这条链路的运行时状态打成一个对象。
     * 在应用窗口的 DevTools 里执行 `NekoThemeStudio.diagnose()` 即可。
     * @returns {{version:*,mode:string,baseUrl:string,endpoint:string,gates:string[],
     *            styleLen:number,lastApply:*,lastFetchAgoMs:*,lastError:*,
     *            hasCache:boolean,bubbleBg:*,bubbleColor:*}}
     */
    diagnose: function () {
      var de = document.documentElement;
      var gates = [];
      if (de && de.attributes) {
        for (var i = 0; i < de.attributes.length; i++) {
          var n = de.attributes[i].name;
          if (n.indexOf(GATE_ATTR) === 0) gates.push(n);
        }
      }
      var el = document.getElementById(STYLE_ID);
      var bubble = null;
      try {
        bubble = document.querySelector('.message-bubble-user, .message.user');
      } catch (e) { /* ignore */ }
      var cs = bubble ? (window.getComputedStyle ? window.getComputedStyle(bubble) : null) : null;
      var hasCache = false;
      try { hasCache = !!safeGet(CACHE_KEY); } catch (e) { /* ignore */ }
      // 样式表是否真的加载了：CSS 没加载时门控属性照样打上，但没有任何规则
      // 匹配 → 变量生效、元素外观不变（最容易被误判成「插件没生效」）。
      var cssLoaded = false;
      var cssRules = 0;
      try {
        var sheets = document.styleSheets || [];
        for (var s = 0; s < sheets.length; s++) {
          var href = sheets[s].href || '';
          if (href.indexOf('neko-theme-studio.css') !== -1) {
            cssLoaded = true;
            cssRules = countStyleRules(sheets[s]);
            break;
          }
        }
      } catch (e3) { /* ignore */ }
      return {
        scriptVersion: SCRIPT_VERSION,
        cssLoaded: cssLoaded,
        cssRules: cssRules,
        updatedAt: currentVersion,
        mode: currentMode(),
        baseUrl: pluginBase(),
        endpoint: themeUrl(),
        gates: gates,
        styleLen: el ? (el.textContent || '').length : 0,
        lastApply: lastApply,
        lastFetchAgoMs: lastFetchAt ? Date.now() - lastFetchAt : null,
        lastError: lastError,
        lastErrorAgoMs: lastErrorAt ? Date.now() - lastErrorAt : null,
        hasCache: hasCache,
        reviveCount: reviveCount,
        lastReviveError: lastReviveError,
        // 样式表自愈状态：sheetSwapCount > 0 说明这个窗口曾经换过表（典型场景是
        // 窗口开着时插件被更新）。排查「面板改了但窗口不动」时先看这两个数。
        sheetSwapCount: sheetSwapCount,
        lastSheetCheckAgoMs: lastSheetCheckAt ? Date.now() - lastSheetCheckAt : null,
        selfUpgradeAt: selfUpgradeAt || null,
        selfUpgradeGuard: (function () {
          try { return window.sessionStorage.getItem(SELF_UPGRADE_GUARD_KEY) || ''; }
          catch (e) { return ''; }
        })(),
        bubbleFound: !!bubble,
        bubbleBg: cs ? cs.backgroundColor : null,
        bubbleColor: cs ? cs.color : null
      };
    },
    _internals: { isSafeValue: isSafeValue, sanitizeVars: sanitizeVars, themeUrl: themeUrl }
  };

  log('runtime ready; endpoint =', themeUrl());

  // ------------------------------------------------- 自检快照落盘（可远程读取）

  // 应用聊天窗是 Electron 窗口，没有开 CDP 端口，外部无法连进去看状态；用户也
  // 未必愿意/会开控制台。但同一个 localStorage 会被 Electron 落盘到
  // `Local Storage\leveldb`，所以把 diagnose() 快照定期写进去，排查
  // 「面板显示已应用、窗口毫无变化」时就能直接从磁盘读到那个窗口当时真实的
  // 门控属性、样式表 href 与注入内容长度，不用再猜。
  function rectOf(el) {
    if (!el) return null;
    var b = el.getBoundingClientRect();
    return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
  }
  function composerSnapshot() {
    var out = {};
    var frame = document.querySelector('.compact-chat-surface-frame');
    var shell = document.querySelector('.compact-chat-surface-shell');
    var capsule = document.querySelector('.compact-chat-capsule-button');
    var toggle = document.querySelector('.send-button-circle');
    out.state = frame ? (frame.getAttribute('data-compact-chat-state') || '') : 'no-frame';
    out.dpr = window.devicePixelRatio || 1;
    out.viewport = [window.innerWidth, window.innerHeight];
    out.shell = rectOf(shell);
    if (frame) {
      var fs = window.getComputedStyle(frame);
      out.frame = {
        rect: rectOf(frame),
        padding: [fs.paddingTop, fs.paddingRight, fs.paddingBottom, fs.paddingLeft],
        overflow: fs.overflow,
        zIndex: fs.zIndex,
        position: fs.position
      };
    }
    out.capsule = rectOf(capsule);
    if (toggle) {
      var ts = window.getComputedStyle(toggle);
      var img = toggle.querySelector('img');
      out.toggle = {
        exists: true,
        rect: rectOf(toggle),
        opacity: ts.opacity,
        visibility: ts.visibility,
        display: ts.display,
        zIndex: ts.zIndex,
        position: ts.position,
        bg: ts.backgroundColor,
        transform: ts.transform,
        ariaLabel: toggle.getAttribute('aria-label') || '',
        imgSrc: img ? (img.getAttribute('src') || '') : '',
        // 该按钮中心点上有哪些元素（自上而下），能一眼看出是否被别的层盖住
        stack: (function () {
          var b = toggle.getBoundingClientRect();
          var cx = Math.round(b.left + b.width / 2);
          var cy = Math.round(b.top + b.height / 2);
          var list = [];
          try {
            var els = document.elementsFromPoint(cx, cy) || [];
            for (var i = 0; i < els.length && i < 6; i++) {
              var e = els[i];
              var es = window.getComputedStyle(e);
              list.push({
                tag: e.tagName,
                cls: String(e.className || '').slice(0, 48),
                z: es.zIndex,
                pe: es.pointerEvents,
                bg: es.backgroundColor
              });
            }
          } catch (e4) { /* ignore */ }
          return list;
        })()
      };
    } else {
      out.toggle = { exists: false };
    }
    var tools = document.querySelectorAll('.composer-tool-btn');
    out.toolBtnCount = tools.length;
    out.toolBtnFirst = tools.length ? rectOf(tools[0]) : null;
    var fan = document.querySelector('.compact-input-tool-fan');
    out.fanOpen = fan ? fan.getAttribute('data-compact-input-tool-fan-open') : null;
    out.scroll = [window.scrollX, window.scrollY];
    return out;
  }

  var lastSnapAt = 0;
  function persistSnapshot() {
    var now = Date.now();
    if (now - lastSnapAt < 60000) return;
    lastSnapAt = now;
    try {
      var d = window.NekoThemeStudio.diagnose();
      var link = null;
      try { link = document.querySelector('link[href*="neko-theme-studio.css"]'); } catch (e1) { link = null; }
      d.sheetHref = link ? link.getAttribute('href') : '';
      d.scriptSrc = (function () {
        try {
          var s = document.querySelector('script[src*="neko-theme-studio.js"]');
          return s ? s.getAttribute('src') : '';
        } catch (e2) { return ''; }
      })();
      d.styleText = (document.getElementById(STYLE_ID) || {}).textContent || '';
      // 「输入框右侧按钮看不到」这类问题，只有真实窗口能回答：把 composer 的
      // 几何、那个圆形按钮的存在性与覆盖栈一起写进快照，事后从 leveldb 读。
      try {
        d.composer = composerSnapshot();
      } catch (e3) { d.composer = null; }
      d.at = new Date().toISOString();
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(d));
    } catch (e) { /* ignore */ }
  }
  window.NekoThemeStudio.report = persistSnapshot;
  persistSnapshot();
})();
