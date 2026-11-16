/*!
 * targets.js — 主题样式表的**唯一事实来源**（targets）
 *
 * 每条 target 描述「哪个选择器的哪个属性」由「哪个 --nts-* 变量」控制：
 *   { sec, sel, prop, v, kind, gate, note }
 *     sec   分组（生成 CSS 的分节注释）
 *     sel   CSS 选择器（不含特异性前缀，前缀由生成器统一加）
 *     prop  CSS 属性
 *     v     变量名（null / 省略 = 仅量测、不产出声明 → 「辅助项」）
 *     kind  color | image | length | blur | number | font | shadow | raw
 *     aux   true = 只量测原生值，供生成器决策（例如元素的 background-image 是否为
 *           gradient、原生 border-width 是否为 0），本身不产出任何 CSS 声明
 *     gate  true = 该声明不能无条件写（无条件写会改变未配置时的外观，或原生用
 *           outline/box-shadow 之外的手段表达），必须放进
 *           `:root[data-nts-<var>]:root body <sel>` 门控规则，仅当用户真的设置了
 *           这个变量时才生效。门控属性由 app 侧 JS 在写入变量时打。
 *
 * 生成器（tools/gen-css.js）用**实测的原生计算值**填充每个 target 的回退值，
 * 因此「变量未设置 → 解析出原生值」是算出来的，不是手写的。
 * 量测由 tools/measure.js 用真实 headless Chrome 完成（亮色 + 暗色两次）。
 */
var NTS_TARGETS = [
  /* ======================= A. 聊天气泡 · 旧版 ======================= */
  { sec: 'A 聊天气泡', sel: '.message.user',   prop: 'background-color', v: '--nts-user-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.user',   prop: 'color',            v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.gemini', prop: 'background-color', v: '--nts-ai-bubble-bg',     kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.gemini', prop: 'color',            v: '--nts-ai-bubble-text',   kind: 'color' },

  /* ======================= A. 聊天气泡 · React ======================= */
  { sec: 'A 聊天气泡', sel: '.message-bubble-user',      prop: 'background-color', v: '--nts-user-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user',      prop: 'color',            v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user',      prop: 'border-radius',    v: '--nts-bubble-radius',    kind: 'length' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant', prop: 'background-color', v: '--nts-ai-bubble-bg',     kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant', prop: 'color',            v: '--nts-ai-bubble-text',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant', prop: 'border-radius',    v: '--nts-bubble-radius',    kind: 'length' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool',      prop: 'background-color', v: '--nts-tool-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool',      prop: 'color',            v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool',      prop: 'border-radius',    v: '--nts-bubble-radius',    kind: 'length' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system',    prop: 'background-color', v: '--nts-tool-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system',    prop: 'color',            v: '--nts-tool-bubble-text', kind: 'color' },

  /* 气泡描边：原生多半没有边框 → 用 outline（不参与布局）门控实现，见 tools/gen-css.js */
  { sec: 'A 聊天气泡', sel: '.message-bubble-user',      prop: 'outline-color', v: '--nts-user-bubble-border', kind: 'color', gate: true },
  { sec: 'A 聊天气泡', sel: '.message.user',             prop: 'outline-color', v: '--nts-user-bubble-border', kind: 'color', gate: true },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant', prop: 'outline-color', v: '--nts-ai-bubble-border',   kind: 'color', gate: true },
  { sec: 'A 聊天气泡', sel: '.message.gemini',           prop: 'outline-color', v: '--nts-ai-bubble-border',   kind: 'color', gate: true },

  /* 气泡内富文本
     ⚠ AI 文本色不能挂在无作用域的 .message-block-* 上：用户气泡里的 markdown
     同样带 .message-block-markdown 类，未设置 --nts-user-bubble-text 时会被
     AI 文本色串染（实测同一文本节点同时命中 ai-bubble-text 与 user-bubble-text
     两条规则，后者门控未开时就只剩前者）。因此 AI 色只写进 AI / 工具 / 系统
     气泡的作用域里；font-size 是整体字号，保持在无作用域选择器上。 */
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-text',     prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-markdown', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  /* 工具/系统气泡的正文必须跟 --nts-tool-bubble-text 走（与上面气泡本身的
     color 声明一致）；以前错误地写成 --nts-ai-bubble-text，导致「改 AI 文字色
     连工具/系统气泡的正文也一起变」。 */
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool .message-block-text',          prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool .message-block-markdown',      prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system .message-block-text',        prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system .message-block-markdown',    prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.gemini .message-block-text',               prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.gemini .message-block-markdown',           prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  /* font-size 是「基础字号」，必须同时覆盖两条渲染路径：markdown 块与纯文本块。
     应用 CSS 里只有 .message-block-markdown 自带 font-size（.94rem），.message-block-text /
     .message-block-text-plain 是继承气泡字号 —— 只写 markdown 时「纯文本消息字号不变」，
     属于同类作用域遗漏（实测只命中 markdown 子树）。 */
  { sec: 'A 聊天气泡', sel: '.message-block-markdown',                       prop: 'font-size', v: '--nts-font-size', kind: 'length' },
  { sec: 'A 聊天气泡', sel: '.message-block-text',                           prop: 'font-size', v: '--nts-font-size', kind: 'length' },
  { sec: 'A 聊天气泡', sel: '.message-block-text-plain',                     prop: 'font-size', v: '--nts-font-size', kind: 'length' },
  /* 用户气泡正文：气泡本身的 color 已能给「普通文本」兜底，但 markdown 文本块
     （含链接/列表/URL 等，见 React 端 yne() 启发式）在应用层是独立元素，旧 CSS
     里 AI 文字色正是挂在无作用域的 .message-block-* 上，把用户正文串染成 AI 色。
     这里把用户文本色显式钉在用户气泡作用域内的两种文本块上，双保险。 */
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-text',     prop: 'color',     v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-text-plain', prop: 'color',   v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-markdown', prop: 'color',     v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.user .message-block-markdown',        prop: 'color',     v: '--nts-user-bubble-text', kind: 'color' },
  /* markdown 的**子元素**各自带 color，不吃气泡继承 —— 这是「AI 文字色只改了
     一部分」的直接原因（实测：--nts-ai-bubble-text 生效时 p/li/strong/em 跟随，
     但 h1..h6、blockquote、th 全部保持原生 #1f2c42 / #55657d / #233147）。
     neko-chat-window.css 里 `.message-block-markdown h1{...color:#1f2c42}` 是
     独立规则：继承本来就不参与竞争，元素自己一旦有 color 就绝不会继承父级，
     所以必须逐类显式钉进气泡作用域。
     ⚠ 作用域是必须的：AI 色写成裸 `.message-block-markdown h1` 会连用户气泡
     里的标题一起染成 AI 色 —— 那正是「用户文字和 AI 文字一起变色」。
     AI/工具/系统三面各自钉自己的变量，用户面单独钉用户变量。 */
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-markdown h1, .message-bubble-assistant .message-block-markdown h2, .message-bubble-assistant .message-block-markdown h3, .message-bubble-assistant .message-block-markdown h4, .message-bubble-assistant .message-block-markdown h5, .message-bubble-assistant .message-block-markdown h6', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-markdown blockquote', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-markdown th', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant .message-block-markdown td', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool .message-block-markdown h1, .message-bubble-tool .message-block-markdown h2, .message-bubble-tool .message-block-markdown h3, .message-bubble-tool .message-block-markdown h4, .message-bubble-tool .message-block-markdown h5, .message-bubble-tool .message-block-markdown h6', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-tool .message-block-markdown blockquote', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system .message-block-markdown h1, .message-bubble-system .message-block-markdown h2, .message-bubble-system .message-block-markdown h3, .message-bubble-system .message-block-markdown h4, .message-bubble-system .message-block-markdown h5, .message-bubble-system .message-block-markdown h6', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-system .message-block-markdown blockquote', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  /* 同理：用户气泡作用域内的标题/引用也要跟用户文字色，否则用户消息里的
     markdown 标题仍然是 AI 深蓝 → 这正是「用户文字和 AI 文字混色」的另一半。 */
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-markdown h1, .message-bubble-user .message-block-markdown h2, .message-bubble-user .message-block-markdown h3, .message-bubble-user .message-block-markdown h4, .message-bubble-user .message-block-markdown h5, .message-bubble-user .message-block-markdown h6', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-markdown blockquote', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user .message-block-markdown th', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  /* 旧 DOM（viewer.html 窗口）同理：.message.gemini 作用域。 */
  { sec: 'A 聊天气泡', sel: '.message.gemini .message-block-markdown h1, .message.gemini .message-block-markdown h2, .message.gemini .message-block-markdown h3, .message.gemini .message-block-markdown h4, .message.gemini .message-block-markdown h5, .message.gemini .message-block-markdown h6', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message.gemini .message-block-markdown blockquote', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  /* ======================= A. 聊天气泡 · 紧凑/历史层 =======================
   * ⚠ 这是用户**真正看到**的聊天记录层，也是「文字颜色改了不生效」的根因所在。
   *
   * 紧凑 / galgame 形态下消息不是 .message-bubble-*，真实 DOM（从
   * resources\bin\static\react\neko-chat\neko-chat-window.iife.js 的 Aoe()/Hy() 取证）：
   *   article.compact-export-history-message.is-user|.is-assistant|.is-visit-peer|.is-system
   *     > div.compact-export-history-bubble
   *       > div.compact-export-history-meta   (作者/时间，有自己的 color)
   *       > div.compact-export-history-content (font-size:.92rem)
   *         > div.message-block.message-block-text[.message-block-text-plain] | .message-block-markdown
   * 应用样式表里颜色是**写死**的（无桥接变量）：
   *   .compact-export-history-bubble              { background:#ffffffe0; color:#273042 }
   *   .is-user   .compact-export-history-bubble   { background:#d0e7ffe0; color:#142033 }
   *   .is-system .compact-export-history-bubble   { background:#f2f6fcf5; color:#2f435e }
   *   .is-visit-peer ... { background:linear-gradient(...);  color:#352557 }
   * 所以在补齐下面这些目标之前，--nts-user-bubble-text / --nts-ai-bubble-text 在这一层
   * **一条规则都命中不了**（实测：设哨兵后 bubbleColor 仍 rgb(20,32,51)/rgb(39,48,66)）。
   *
   * ⚠ 每条都必须带角色作用域（.is-user / .is-assistant / ...），否则就是
   * 「用户文字和 AI 文字一起变色」。 */

  /* --- 用户面 --- */
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-text',       prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-text-plain', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown',   prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h1, .compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h2, .compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h3, .compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h4, .compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h5, .compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown h6', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown blockquote', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown th', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble .message-block-markdown td', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble', prop: 'background-color', v: '--nts-user-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble', prop: 'border-radius',    v: '--nts-bubble-radius',   kind: 'length' },

  /* --- AI 面 --- */
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-text',       prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-text-plain', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown',   prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h1, .compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h2, .compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h3, .compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h4, .compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h5, .compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown h6', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown blockquote', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown th', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble .message-block-markdown td', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble', prop: 'background-color', v: '--nts-ai-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble', prop: 'border-radius',    v: '--nts-bubble-radius', kind: 'length' },

  /* --- 工具 / 系统面（tool 渲染成 .is-visit-peer；system 独立） --- */
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-visit-peer .compact-export-history-bubble', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-visit-peer .compact-export-history-bubble', prop: 'background-color', v: '--nts-tool-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-system .compact-export-history-bubble',     prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-system .compact-export-history-bubble .message-block-text',     prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-system .compact-export-history-bubble .message-block-markdown', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-system .compact-export-history-bubble',     prop: 'background-color', v: '--nts-tool-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-system .compact-export-history-bubble',     prop: 'border-radius',    v: '--nts-bubble-radius', kind: 'length' },

  /* 基础气泡（所有角色共用同一套圆角变量；.is-user 的原生圆角不同，单列一条更靠后输出） */
  { sec: 'A 聊天气泡', sel: '.compact-export-history-bubble', prop: 'border-radius', v: '--nts-bubble-radius', kind: 'length' },

  /* 气泡描边：与 React 气泡一致用 outline（不参与布局），门控 */
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-user .compact-export-history-bubble',      prop: 'outline-color', v: '--nts-user-bubble-border', kind: 'color', gate: true },
  { sec: 'A 聊天气泡', sel: '.compact-export-history-message.is-assistant .compact-export-history-bubble', prop: 'outline-color', v: '--nts-ai-bubble-border',   kind: 'color', gate: true },

  /* ======================= A. 聊天气泡 · 导出预览层 =======================
   * 「导出图片」前那一屏（iife 的 It() 生产），DOM 与历史层同构、类名前缀不同：
   *   article.compact-export-preview-message.is-user|.is-assistant|.is-visit-peer|.is-system
   *     > div.compact-export-preview-bubble > .compact-export-preview-meta + .compact-export-preview-content
   * 原生颜色同样写死（#273042 / #d0e7ffb3 / linear-gradient / #607086），主题表原先
   * 一条规则都没有 → 改了「用户/AI 文字颜色」在这一屏不生效。同样必须带角色作用域。 */
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-text',       prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-text-plain', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown',   prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h1, .compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h2, .compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h3, .compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h4, .compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h5, .compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown h6', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown blockquote', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown th', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble .message-block-markdown td', prop: 'color', v: '--nts-user-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble', prop: 'background-color', v: '--nts-user-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble', prop: 'border-radius',    v: '--nts-bubble-radius',   kind: 'length' },

  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-text',       prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-text-plain', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown',   prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h1, .compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h2, .compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h3, .compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h4, .compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h5, .compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown h6', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown blockquote', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown th', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble .message-block-markdown td', prop: 'color', v: '--nts-ai-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble', prop: 'background-color', v: '--nts-ai-bubble-bg', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble', prop: 'border-radius',    v: '--nts-bubble-radius', kind: 'length' },

  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-visit-peer .compact-export-preview-bubble', prop: 'color',            v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-visit-peer .compact-export-preview-bubble', prop: 'background-color', v: '--nts-tool-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble',     prop: 'color',            v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble .message-block-text',     prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble .message-block-markdown', prop: 'color', v: '--nts-tool-bubble-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble',     prop: 'background-color', v: '--nts-tool-bubble-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble',     prop: 'border-radius',    v: '--nts-bubble-radius',    kind: 'length' },

  /* 基础预览气泡（所有角色共用圆角变量） */
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-bubble', prop: 'border-radius', v: '--nts-bubble-radius', kind: 'length' },

  /* 预览层描边（与历史层一致用 outline） */
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble',      prop: 'outline-color', v: '--nts-user-bubble-border', kind: 'color', gate: true },
  { sec: 'A 聊天气泡', sel: '.compact-export-preview-message.is-assistant .compact-export-preview-bubble', prop: 'outline-color', v: '--nts-ai-bubble-border',   kind: 'color', gate: true },

  { sec: 'A 聊天气泡', sel: '.message-block-markdown a',                    prop: 'color',     v: '--nts-link',             kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-markdown-inline-code',                prop: 'background-color', v: '--nts-code-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-markdown-inline-code',                prop: 'color',     v: '--nts-code-text',        kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-markdown-pre',                        prop: 'background-color', v: '--nts-code-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-markdown-pre',                        prop: 'color',     v: '--nts-code-text',        kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-image',                         prop: 'background-color', v: '--nts-image-bg',  kind: 'color' },

  /* 状态块：4 个 tone 原生各不相同 → 各自成条，回退值独立 */
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-info',    prop: 'background-color', v: '--nts-status-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-info',    prop: 'color',            v: '--nts-status-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-success', prop: 'background-color', v: '--nts-status-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-success', prop: 'color',            v: '--nts-status-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-warning', prop: 'background-color', v: '--nts-status-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-warning', prop: 'color',            v: '--nts-status-text', kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-error',   prop: 'background-color', v: '--nts-status-bg',   kind: 'color' },
  { sec: 'A 聊天气泡', sel: '.message-block-status.tone-error',   prop: 'color',            v: '--nts-status-text', kind: 'color' },

  /* ======================= B. 聊天窗口 ======================= */
  { sec: 'B 聊天窗口', sel: '.chat-body',               prop: 'background-color', v: '--nts-chat-panel-bg', kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.chat-window',             prop: 'background-color', v: '--nts-chat-bg',       kind: 'color' },
  { sec: 'B 聊天窗口', sel: '#react-chat-window-root',  prop: 'background-color', v: '--nts-chat-bg',       kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.window-topbar',           prop: 'background-color', v: '--nts-topbar-bg',     kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.window-topbar',           prop: 'color',            v: '--nts-topbar-text',   kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.window-title',            prop: 'color',            v: '--nts-topbar-text',   kind: 'color' },
  { sec: 'B 聊天窗口', sel: '#react-chat-window-shell', prop: 'border-radius',    v: '--nts-shell-radius',  kind: 'length' },

  /* ======================= C. 输入区 =======================
     实测的真实输入结构（compact 形态，用户最常见）：
       footer.composer-panel > form.composer > div.compact-chat-surface-shell
         > div.compact-chat-surface-frame            ← 唯一画出输入胶囊的面
             (bg rgba(255,255,255,.035), border 2px solid rgba(255,255,255,.7), radius 999px)
           > textarea.composer-input                 ← 真正可见的输入框（点胶囊后挂载）
     `.composer-input-shell` 只在「非紧凑 / 展开」的另一种分支里出现，实测
     querySelectorAll('.composer-input-shell').length === 0；`#textInputBox` 是
     旧 DOM 的隐藏 textarea（visible:false，被 React adapter 绕过），对它的量测
     全部无效——之前把「输入文字色不生效」归因到选择器就是踩了这个坑。 */
  { sec: 'C 输入区', sel: '#text-input-area',          prop: 'background-color', v: '--nts-input-bg',          kind: 'color' },
  { sec: 'C 输入区', sel: '#text-input-area',          prop: 'border-top-color', v: '--nts-input-border',      kind: 'color' },
  /* 紧凑胶囊是真正可见的输入面：背景/描边都打在它身上，否则用户改「输入区
     背景」时屏幕上唯一看得见的那个框不会变色。 */
  { sec: 'C 输入区', sel: '.compact-chat-surface-frame', prop: 'background-color', v: '--nts-input-bg',        kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-input-shell',     prop: 'background-color', v: '--nts-input-bg',          kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-input-shell',     prop: 'border-top-color', v: '--nts-input-border',      kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-input',           prop: 'color',            v: '--nts-input-text',        kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-input::placeholder', prop: 'color',         v: '--nts-input-placeholder', kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-tool-btn',        prop: 'background-color', v: '--nts-button-bg',         kind: 'color' },
  /* :hover 无法在静态量测页触发（fixture 归因 NO-PSEUDO-STATE）→ 量不到回退值。
     但「量不到回退」不等于「不能支持」：把它改为 gate，就变成
     「只在用户真的设了这个变量时才写声明」，未配置时原生悬停色
     （#44b7fe1a 亮 / #44b7fe26 暗）原样保留，零变化不变量不受影响。 */
  { sec: 'C 输入区', sel: '.composer-tool-btn:hover',  prop: 'background-color', v: '--nts-button-hover-bg',   kind: 'color', gate: true },
  { sec: 'C 输入区', sel: '.composer-icon-button',     prop: 'background-color', v: '--nts-button-bg',         kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-icon-button',     prop: 'color',            v: '--nts-button-text',       kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-icon-button',     prop: 'border-radius',    v: '--nts-radius',            kind: 'length' },
  { sec: 'C 输入区', sel: '.composer-overflow-btn',    prop: 'color',            v: '--nts-button-text',       kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-galgame-btn',     prop: 'color',            v: '--nts-button-text',       kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-attachment-remove', prop: 'background-color', v: '--nts-button-bg',       kind: 'color' },
  { sec: 'C 输入区', sel: '.send-button-circle',       prop: 'background-color', v: '--nts-send-bg',           kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-panel',           prop: 'background-color', v: '--nts-panel-bg',          kind: 'color' },
  /* ⚠ 面板文字色不能挂在 .composer-panel 上：它是容器级 color 声明，会向所有
     没有自有 color 的后代继承。紧凑胶囊（.compact-chat-surface-shell /
     .compact-chat-surface-frame / span.compact-chat-capsule-text）正是
     .composer-panel 的后代，实测「改面板文字色」把胶囊文字一起改掉（跨面泄漏，
     与 AI 文字色串染同类）。输入区文字由 --nts-input-text 负责，面板文字只写
     真正的面板面（访问条 / 弹层 / HUD，见下面 .composer-visit-bar 与 popupBridge）。 */
  { sec: 'C 输入区', sel: '.composer-panel',           prop: 'border-radius',    v: '--nts-radius',            kind: 'length' },
  { sec: 'C 输入区', sel: '.composer-visit-bar',       prop: 'color',            v: '--nts-panel-text',        kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-visit-bar-badge', prop: 'background-color', v: '--nts-chip-bg',           kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-visit-bar-badge', prop: 'color',            v: '--nts-chip-text',         kind: 'color' },
  { sec: 'C 输入区', sel: '.composer-visit-bar-action',prop: 'color',            v: '--nts-chip-text',         kind: 'color' },
  { sec: 'C 输入区', sel: '#sendButton',               prop: 'background-color', v: '--nts-send-bg',           kind: 'color' },
  { sec: 'C 输入区', sel: '#sendButton',               prop: 'color',            v: '--nts-send-text',         kind: 'color' },
  { sec: 'C 输入区', sel: '#textSendButton',           prop: 'background-color', v: '--nts-send-bg',           kind: 'color' },

  /* ======================= D. 面板 / 弹层 / 弹窗 ======================= */
  { sec: 'D 面板弹层', sel: '.composer-icon-popover',     prop: 'background-color', v: '--nts-popover-bg',     kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-icon-popover',     prop: 'color',            v: '--nts-popover-text',   kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-overflow-popover', prop: 'background-color', v: '--nts-popover-bg',     kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-overflow-popover', prop: 'border-top-color', v: '--nts-popover-border', kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-overflow-popover', prop: 'border-radius',    v: '--nts-popover-radius', kind: 'length' },
  { sec: 'D 面板弹层', sel: '.composer-overflow-menu',    prop: 'background-color', v: '--nts-popover-bg',     kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-overflow-menu',    prop: 'color',            v: '--nts-popover-text',   kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-galgame-option',   prop: 'background-color', v: '--nts-chip-bg',        kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-galgame-option',   prop: 'color',            v: '--nts-chip-text',      kind: 'color' },
  { sec: 'D 面板弹层', sel: '.composer-galgame-option',   prop: 'border-radius',    v: '--nts-radius',         kind: 'length' },
  { sec: 'D 面板弹层', sel: '.modal-overlay',             prop: 'background-color', v: '--nts-overlay-bg',     kind: 'color' },
  { sec: 'D 面板弹层', sel: '.modal-dialog',              prop: 'background-color', v: '--nts-modal-bg',       kind: 'color' },
  { sec: 'D 面板弹层', sel: '.modal-dialog',              prop: 'color',            v: '--nts-modal-text',     kind: 'color' },
  { sec: 'D 面板弹层', sel: '.modal-dialog',              prop: 'border-radius',    v: '--nts-modal-radius',   kind: 'length' },
  { sec: 'D 面板弹层', sel: '.modal-title',               prop: 'color',            v: '--nts-modal-text',     kind: 'color' },

  /* ======================= E. 推荐 / chip ======================= */
  { sec: 'E 推荐与chip', sel: '.proactive-recommendation-card',   prop: 'background-color', v: '--nts-rec-bg',    kind: 'color' },
  { sec: 'E 推荐与chip', sel: '.proactive-recommendation-card',   prop: 'border-radius',    v: '--nts-rec-radius', kind: 'length' },
  { sec: 'E 推荐与chip', sel: '.proactive-recommendation-card',   prop: 'border-color',     v: '--nts-rec-border', kind: 'color' },
  { sec: 'E 推荐与chip', sel: '.proactive-recommendation-bubble', prop: 'color',            v: '--nts-rec-text',  kind: 'color' },
  { sec: 'E 推荐与chip', sel: '.music-recommendation-icon',       prop: 'background-color', v: '--nts-rec-bg',    kind: 'color' },
  { sec: 'E 推荐与chip', sel: '.system-chip',                     prop: 'background-color', v: '--nts-chip-bg',   kind: 'color' },
  { sec: 'E 推荐与chip', sel: '.system-chip',                     prop: 'color',            v: '--nts-chip-text', kind: 'color' },
  /* ⚠ 这里曾经有 4 条把「推荐卡片背景/文字」(--nts-rec-bg / --nts-rec-text) 打到
     `.compact-export-history-bubble` / `.compact-export-preview-bubble` 上的目标，已删除。
     原因（实测取证）：
       1) 语义错位——那两个类名是紧凑形态的**聊天消息气泡**（以及导出预览气泡），
          不是推荐卡片；用户调「推荐卡片文字」会把整段聊天记录染色。
       2) **这正是「用户文字和 AI 文字一起变色」的根源**：这两条规则没有角色作用域，
          用户气泡与 AI 气泡共用同一个变量，设一次两面全变。
       3) 真正该在这里生效的 --nts-user-bubble-text / --nts-ai-bubble-text 反而一条
          规则都没有 → 用户改「用户气泡文字」完全没反应。现已在 A 段按角色补齐。 */

  /* ======================= F. 全局 ======================= */
  /* 裸 a：**必须门控**。原生链接色是「上下文相关」的——亮色没有裸 a{color}（浏览器默认蓝），
     暗色由 dark-mode.css 的 a{color:#5cb8f0} 给值，而 .message-block-markdown a 另有自己的 #2f68df。
     一个通用选择器无法用「单一回退值 = 原生值」表达，实测也证明无条件写会改动未配置外观
     （.composer-panel a 从 rgb(0,0,238) 被改成 markdown 链接色）。门控后：仅在用户真的设了
     --nts-link 时才全局生效，未配置时严格不生效。 */
  { sec: 'F 全局', sel: 'a',           prop: 'color',         v: '--nts-link', kind: 'color', gate: true },
  /* 刻意不再单列 .composer-panel a：它的原生色是浏览器默认链接蓝（index.css 未声明），
     用一次量测出的字面量当回退既脆弱又无意义；上面门控的裸 a 已覆盖它。 */
  /* ::selection 也**必须门控**：亮色原生没有 ::selection 规则（浏览器默认高亮色），
     无条件写 background-color: var(--nts-highlight, transparent) 会让选中文字的高亮消失，
     即改动未配置外观。门控后仅在用户设了 --nts-highlight 时才接管。 */
  { sec: 'F 全局', sel: '::selection', prop: 'background-color', v: '--nts-highlight', kind: 'color', gate: true },
  { sec: 'F 全局', sel: ':focus-visible', prop: 'outline-color', v: '--nts-accent', kind: 'color', gate: true },

  /* 毛玻璃模糊：原生各自不同（有的 blur(48px) saturate、有的是 blur(6px)、有的 none）
     → 无法用「原生值回退」表达，全部门控；只在用户设了 --nts-chat-blur 时生效。 */
  { sec: 'B 聊天窗口', sel: '.window-topbar',                 prop: 'backdrop-filter', v: '--nts-chat-blur', kind: 'blur', gate: true },
  { sec: 'C 输入区',   sel: '.composer-icon-button',          prop: 'backdrop-filter', v: '--nts-chat-blur', kind: 'blur', gate: true },
  { sec: 'D 面板弹层', sel: '.composer-overflow-popover',     prop: 'backdrop-filter', v: '--nts-chat-blur', kind: 'blur', gate: true },
  { sec: 'E 推荐与chip', sel: '.compact-export-history-bubble', prop: 'backdrop-filter', v: '--nts-chat-blur', kind: 'blur', gate: true },

  /* 阴影：原生的 box-shadow 是复合值，回退即原生当然可以写，但为了让「未配置」
     严格等于「不加载」，仍然门控。 */
  { sec: 'D 面板弹层', sel: '.composer-panel',                prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'D 面板弹层', sel: '.composer-icon-popover',         prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'D 面板弹层', sel: '.composer-overflow-popover',     prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'D 面板弹层', sel: '.modal-dialog',                  prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'E 推荐与chip', sel: '.proactive-recommendation-card', prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'A 聊天气泡', sel: '.message-bubble-user',           prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },
  { sec: 'A 聊天气泡', sel: '.message-bubble-assistant',      prop: 'box-shadow', v: '--nts-shadow', kind: 'shadow', gate: true },

  /* ======================= G. 非颜色 ======================= */
  { sec: 'G 非颜色', sel: '.agent-plugin-view', prop: 'border-radius',    v: '--nts-card-radius', kind: 'length' },
  { sec: 'G 非颜色', sel: '.message-block',     prop: 'border-radius',    v: '--nts-radius',      kind: 'length' },
  { sec: 'G 非颜色', sel: '.chat-body',         prop: 'border-radius',    v: '--nts-radius',      kind: 'length' },

  /* ============ 聊天背板的圆角（--nts-chat-panel-radius） ============
     与--nts-chat-panel-bg 配套：底板上了颜色就必须能改成圆角，否则一整块
     直角色块压在圆角胶囊世界，观感非常割裂。

     刻意用**独立变量**而不是复用 --nts-radius：后者是「通用圆角」，同时打在
     .message-block / .composer-panel / .composer-icon-button / .composer-galgame-option
     上，改它会把按钮和输入框一起改圆，不能只圆背板。

     放在 G 段之后是有意的：.chat-body 也吃 --nts-radius(G 段)，两条特异性相同，
     同特异性下后出现者胜出 → 用户同时设了两者时，背板圆角优先。 */
  { sec: 'G 非颜色', sel: '.compact-export-history-scroll',         prop: 'border-radius', v: '--nts-chat-panel-radius', kind: 'length' },
  { sec: 'G 非颜色', sel: '.compact-export-history-scroll-content', prop: 'border-radius', v: '--nts-chat-panel-radius', kind: 'length' },
  { sec: 'G 非颜色', sel: '.message-list',                          prop: 'border-radius', v: '--nts-chat-panel-radius', kind: 'length' },
  { sec: 'G 非颜色', sel: '.chat-body',                             prop: 'border-radius', v: '--nts-chat-panel-radius', kind: 'length' },

  /* ======================= H. 紧凑胶囊（真实可见面） =======================
     紧凑态是用户实际最常见的形态：此时 .chat-window / .chat-body / .composer-panel
     都被 index.css 压成 0 高且 background: transparent !important，真正画出来的是
     .compact-chat-surface-frame 的 ::before（background: var(--compact-chat-surface-bg)）
     与 ::after 高光。这两个自定义属性由 app 定义在 frame 自身，用「同元素 + 更高特异性
     门控规则」把用户配色桥接进去，就能让聊天窗口背景/阴影/描边/毛玻璃在紧凑态真正
     可见（headless 实测通过）。每个桥接仍按变量独立门控：未设置时原生渐变原样保留。 */
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-surface-frame', prop: '--compact-chat-surface-bg',         v: '--nts-chat-bg',   kind: 'raw' },
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-surface-frame', prop: '--compact-chat-capsule-surface-bg', v: '--nts-chat-bg',   kind: 'raw' },
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-surface-frame', prop: '--compact-chat-surface-shadow',     v: '--nts-shadow',    kind: 'raw' },
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-surface-frame', prop: 'border-color',                      v: '--nts-accent',    kind: 'color', gate: true },
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-surface-frame', prop: 'backdrop-filter',                   v: '--nts-chat-blur', kind: 'blur', gate: true },
  /* 紧凑态发送/工具按钮：.send-button-circle 与 .compact-input-tool-toggle 是同一个元素，
     C 段已给 send-button-circle 设过背景，这里只补文字色，避免重复规则。
     工具按钮同样：背景色在 C 段已有，这里只补紧凑扇形按钮的文字色。 */
  { sec: 'H 紧凑胶囊', sel: '.compact-input-tool-toggle', prop: 'color',            v: '--nts-send-text',   kind: 'color' },
  { sec: 'H 紧凑胶囊', sel: '.composer-tool-btn',         prop: 'color',            v: '--nts-button-text', kind: 'color' },
  { sec: 'H 紧凑胶囊', sel: '.compact-chat-minimize-ball', prop: 'background-color', v: '--nts-button-bg',  kind: 'color' },

  /* 「聊天背板背景」（--nts-chat-panel-bg）= 消息列表背后那块底板。
     它不再挂在 .chat-body 上，理由是实测出的结构性事实：

       compact 形态   .chat-body 430x0   .message-list 不存在（消息画在 position:fixed 的
                                          .compact-export-history-scroll 里）
       full/expanded  .chat-body 430x794 .message-list 在 .chat-body 内，有真实高度

     也就是说 .chat-body 只在展开后才有高度，紧凑态（用户最常用的形态）永远是 0，
     背板色挂在它上面等于「在紧凑态完全看不到」。所以同时挂到两种形态的滚动容器上：
       - .compact-export-history-scroll   紧凑态真正装消息的容器
       - .message-list                    展开/全屏态真正装消息的容器
     两者都用 --nts-chat-panel-bg 门控，未配置时严格不加载。 */
  { sec: 'B 聊天窗口', sel: '.compact-export-history-scroll', prop: 'background-color', v: '--nts-chat-panel-bg', kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.compact-export-history-scroll-content', prop: 'background-color', v: '--nts-chat-panel-bg', kind: 'color' },
  { sec: 'B 聊天窗口', sel: '.message-list',                    prop: 'background-color', v: '--nts-chat-panel-bg', kind: 'color' },

  /* 紧凑胶囊的底色仍由「聊天窗口背景」独占 —— 背板是消息列表的地板，不是胶囊。
     两条规则的顺序无所谓，因为它们是不同的变量、不同的元素。 */

  /* ======================= I. 悬浮 HUD =======================
     猫爪任务 HUD 由 common-ui-hud.js 用 Object.assign(el.style, …) 内联写样式，
     值全部读 --neko-popup-* / --neko-hud-header-bg 等自定义属性；见
     NTS_GATED.popupBridge——那里把这些 --neko-* 变量桥接到 --nts-panel-* / --nts-shadow。
     这里额外补两条 accent 相关，让 HUD 的激活页签跟着主色走。 */
  { sec: 'I 悬浮HUD', sel: '#agent-content-tasks-tab', prop: 'background-color', v: '--nts-accent-bg', kind: 'color', gate: true },
  { sec: 'I 悬浮HUD', sel: '#agent-content-tasks-tab', prop: 'color',            v: '--nts-accent',    kind: 'color', gate: true },

  /* ======================= X. 辅助量测（不产出声明） =======================
     生成器靠这些事实做决策：
       · background-image 是 gradient 时，用户设了 background-color 也看不见
         → 必须再门控一条 background-image: none
       · 原生 border-width 为 0 时，设 border-color 完全无效 → 该用 outline
       · 原生 box-shadow / backdrop-filter 的原值，用于各自的门控回退 */
  { sec: 'X 辅助', sel: '.message.user',                  prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.message.gemini',                prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',           prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',      prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-tool',           prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-system',         prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.window-topbar',                 prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.window-topbar',                 prop: 'backdrop-filter',  aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',          prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',          prop: 'backdrop-filter',  aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover',     prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover',     prop: 'backdrop-filter',  aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',                prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-popover',         prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-menu',        prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.compact-export-history-bubble', prop: 'background-image', aux: true },
  /* visit-peer 气泡的原生背景是 linear-gradient → 只设 background-color 会被渐变盖住，
     必须让生成器在同一个门控下补 `background-image: none`。sel 必须与上面那条
     background-color 目标**逐字相同**，生成器才认得出这是同一个元素。 */
  { sec: 'X 辅助', sel: '.compact-export-history-message.is-visit-peer .compact-export-history-bubble', prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.compact-export-history-bubble', prop: 'backdrop-filter',  aux: true },
  { sec: 'X 辅助', sel: '.compact-export-preview-bubble', prop: 'background-image', aux: true },
  /* 导出预览层的 visit-peer 同样是 linear-gradient 背景，同理需要 kill。 */
  { sec: 'X 辅助', sel: '.compact-export-preview-message.is-visit-peer .compact-export-preview-bubble', prop: 'background-image', aux: true },
  /* 聊天背景图：background-image 不在 GATE_DECL 里（必须与 size/position/repeat
   * 四条一起写才成立），声明由 gen-css.js 的专门段落输出；这里登记为 aux，
   * 让覆盖率报告与部署审计能看到这四个重绘面（与 --nts-chat-panel-bg 同一批）。 */
  { sec: 'X 辅助', sel: '.compact-export-history-scroll',         prop: 'background-image', v: '--nts-chat-bg-image', aux: true },
  { sec: 'X 辅助', sel: '.compact-export-history-scroll-content', prop: 'background-image', v: '--nts-chat-bg-image', aux: true },
  { sec: 'X 辅助', sel: '.message-list',                          prop: 'background-image', v: '--nts-chat-bg-image', aux: true },
  { sec: 'X 辅助', sel: '.chat-body',                             prop: 'background-image', v: '--nts-chat-bg-image', aux: true },
  { sec: 'X 辅助', sel: '#text-input-area',               prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',          prop: 'background-image', aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',          prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',          prop: 'border-top-style', aux: true },
  { sec: 'X 辅助', sel: '#text-input-area',               prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover',     prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover',     prop: 'border-top-style', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',           prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',      prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.message.user',                  prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.message.gemini',                prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',                prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.compact-export-history-bubble', prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',                  prop: 'border-top-width', aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',                  prop: 'border-top-color', aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',                  prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-popover',         prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover',     prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',                prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '#react-chat-window-shell',       prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',           prop: 'box-shadow',       aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',      prop: 'box-shadow',       aux: true },
  /* 四角圆角：门控/展开需要逐角原生值 */
  { sec: 'X 辅助', sel: '.message-block',             prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.message-block',             prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.message-block',             prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.message-block',             prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',       prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',       prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',       prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-user',       prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',  prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',  prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',  prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.message-bubble-assistant',  prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',      prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',      prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',      prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.composer-input-shell',      prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',            prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',            prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',            prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',            prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',      prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',      prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',      prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-button',      prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.composer-galgame-option',   prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.composer-galgame-option',   prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-galgame-option',   prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.composer-galgame-option',   prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.agent-plugin-view',         prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.agent-plugin-view',         prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.agent-plugin-view',         prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.agent-plugin-view',         prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.chat-body',                 prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.chat-body',                 prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.chat-body',                 prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.chat-body',                 prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '#react-chat-window-shell',   prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '#react-chat-window-shell',   prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '#react-chat-window-shell',   prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '#react-chat-window-shell',   prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',              prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',              prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',              prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.modal-dialog',              prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.proactive-recommendation-card', prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover', prop: 'border-top-left-radius',     aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover', prop: 'border-top-right-radius',    aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover', prop: 'border-bottom-right-radius', aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-popover', prop: 'border-bottom-left-radius',  aux: true },
  { sec: 'X 辅助', sel: '.composer-overflow-menu',    prop: 'background-color', aux: true },
  { sec: 'X 辅助', sel: '.composer-icon-popover',     prop: 'background-color', aux: true },
  { sec: 'X 辅助', sel: '.composer-panel',            prop: 'background-color', aux: true },
  { sec: 'X 辅助', sel: '.composer-visit-bar',        prop: 'background-color', aux: true },
  { sec: 'X 辅助', sel: ':focus-visible',             prop: 'outline-width',    aux: true },
  { sec: 'X 辅助', sel: ':focus-visible',             prop: 'outline-style',    aux: true }
];

/* 需要 `[data-nts-active]` 门控、且非逐变量的全局规则：由 tools/gen-css.js 写进末尾。 */
var NTS_GATED = {
  /* scrollbar-color：Chromium 121+ 一旦设置就忽略 ::-webkit-scrollbar-*（dark-mode.css:2957-2964 注释），
     且原生暗色用 `[data-theme="dark"] * { scrollbar-color: … !important }` 终结。 */
  scrollbar: { thumbVar: '--nts-scrollbar-thumb', trackVar: '--nts-scrollbar-track' },
  /* --neko-popup-* 是应用自己的「悬浮层主题变量」：插件视图层（agent-plugin-views.css）
     与猫爪任务 HUD（common-ui-hud.js 内联 Object.assign(el.style, …)）都读它们。
     直接桥接到 --nts-* 即可一次覆盖整套悬浮层，无需逐元素写死属性。
     map 的值：[变量名, 原生回退文案] 或 [变量名, 回退, 模板]，模板里的 {v} 会被替换成
     var(--nts-*)——用于 --neko-popup-border 这类「1px solid …」简写。 */
  popupBridge: {
    sel: ['#agent-plugin-content', '#agent-plugin-views', '#agent-task-hud', '#agent-task-hud-header', '#status-toast'],
    map: {
      '--neko-popup-separator': ['--nts-panel-border', 'rgba(0, 0, 0, 0.08)'],
      '--neko-popup-text-sub':  ['--nts-panel-text-sub', '#667582'],
      '--neko-popup-text':      ['--nts-panel-text', '#333333'],
      '--neko-popup-accent':    ['--nts-accent', '#2a7bc4'],
      '--neko-popup-accent-bg': ['--nts-accent-bg', 'rgba(42, 123, 196, 0.08)'],
      '--neko-popup-bg':        ['--nts-panel-bg', 'rgba(255, 255, 255, 0.65)'],
      '--neko-hud-header-bg':   ['--nts-panel-bg', 'rgba(255, 255, 255, 0.85)'],
      '--neko-popup-hover':     ['--nts-accent-bg', 'rgba(68, 183, 254, 0.1)'],
      '--neko-popup-border':    ['--nts-panel-border', 'rgba(255, 255, 255, 0.18)', '1px solid {v}'],
      '--neko-popup-shadow':    ['--nts-shadow', '0 2px 4px rgba(0, 0, 0, 0.04)']
    }
  },
  /* 不透明度：复用原生机制 --neko-chat-opacity-factor（原生乘子）。实际写在 :root 上，
     展开态外壳与紧凑胶囊 ::before 的渐变都会继承到（见 gen-css.js 的 chat surface opacity 段）。
     sel 仅作说明用途，生成器不读它。 */
  chatOpacity: { sel: ':root', varName: '--nts-chat-opacity' },
  /* 聊天背景图：值只允许 none 或插件 backgrounds/ 下的绝对 url()。
     图片必须与「聊天背板底色」打在**同一批元素**上：CSS 绘制顺序里
     background-image 永远画在 background-color 之上，所以「图片优先级高于颜色」
     不需要 z-index，只需要两者作用于同一个盒子（gen-css.js 有专门段落输出）。 */
  chatBackgroundImage: {
    varName: '--nts-chat-bg-image',
    sel: [
      '.compact-export-history-scroll',
      '.compact-export-history-scroll-content',
      '.message-list',
      '.chat-body'
    ]
  },
  /* 背景图亮度：把「背景图」压暗，避免图片跟正文抢视线。
     值种类 number（0-1 乘子），1 = 原图，0 = 全黑，中间值线性压暗。
     它必须与「聊天背景图」同时生效 —— requires 表示生成器在门控里额外要求
     data-nts-l/d-chat-bg-image，否则用户只设亮度、不设图片时这条规则会写出
     `linear-gradient(...), var(--nts-chat-bg-image)` 而后者未定义，整条
     background-image 声明作废、连底色都没了。 */
  chatBackgroundImageBrightness: {
    varName: '--nts-chat-bg-image-brightness',
    requires: '--nts-chat-bg-image',
    sel: [
      '.compact-export-history-scroll',
      '.compact-export-history-scroll-content',
      '.message-list',
      '.chat-body'
    ]
  },
  /* 顶部渐隐（用户口中的「背景图最上边那层雾」）
   * 应用在 .compact-export-history-scroll 与 .compact-export-preview-messages 上写了
   *     mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)
   * 目的是让滚动到顶部的内容淡出。但背景图**画在同一个容器上**，于是图片顶上 28px 也被
   * 一起淡出，看起来就是一条白雾。--nts-chat-top-fade 用 alpha 乘法把这个渐隐收回来：
   *     1 = 与应用原生完全一致（0 → .78@12px → 1@28px）
   *     0 = 整条 mask 全不透明 = 雾消失
   * 中间值线性过渡，因此不需要第二条写 `none` 的规则。 */
  chatTopFade: {
    varName: '--nts-chat-top-fade',
    sel: ['.compact-export-history-scroll', '.compact-export-preview-messages']
  },
  /* 阴影：只打在这几个卡片面 */
  shadow: {
    varName: '--nts-shadow',
    sel: ['.modal-dialog', '.composer-panel', '.composer-icon-popover', '.composer-overflow-popover', '.proactive-recommendation-card']
  },
  /* 字体族：影响面大，只在用户显式设置时动 */
  fontFamily: { sel: '', varName: '--nts-font-family' }
};

/* ===========================================================================
 * 「聊天背景上那层虚化」= 气泡的半透明白纱底 + backdrop-filter 模糊。
 *
 * 实测（_probe/veil_bubble.py，棋盘格背景压在气泡下面，量气泡内部边缘能量）：
 *     原生（白纱 alpha .88 + blur(8px)）   edge =      0.1   ← 棋盘格被完全洗平
 *     只关 backdrop-filter                edge =    595.5   ← 仍被白纱洗掉
 *     白纱与模糊都关                       edge =  40291.9   ← 棋盘格完整可见
 * 所以「虚化」是这两者叠加，只关其中一个都不够 —— 这就是为什么要一个同时乘进
 * alpha 与 blur 半径的乘子。
 *
 * 变量 --nts-bubble-veil：0 = 完全清透，1 = 应用原生观感，中间值线性过渡。
 * 写法是 CSS calc() 乘法（已在本应用运行时验证：
 *     rgba(255,255,255,calc(0.88 * var(--v)))  →  v=0 得 alpha 0，v=1 得 .88
 *     blur(calc(8px * var(--v)))               →  v=0 得 blur(0px)，v=1 得 8px
 * ）
 *
 * yieldsTo：这一层被别的控件"接管"时，本表必须让位，否则会互相覆盖成
 * 「改了气泡底色却变透明」。用 :not([gate]) 静态实现，无需运行时逻辑：
 *   - 用户设了某个气泡底色  → 那一档气泡的白纱归用户，veil 不再动它的 alpha
 *   - 用户设了 --nts-chat-blur → 模糊强度归用户，veil 不再动 backdrop-filter
 *
 * a（alpha）与颜色都取自应用 CSS 的原生值，硬编码在下面并注明原始色值，
 * 因为生成器只读探针量到的**计算结果**，读不到"万一是 gradient"的语义。
 * ========================================================================= */
var NTS_VEIL = {
  varName: '--nts-bubble-veil',
  entries: [
    /* ---- 紧凑历史层（用户实际看到的那套界面） ---- */
    { sel: '.compact-export-history-bubble',
      light: { color: [255, 255, 255], a: 0.8784 },   // #ffffffe0
      dark: { color: [33, 45, 62], a: 0.8784 },       // #212d3ee0
      blur: { px: 8, extra: 'saturate(1.08)' },
      yieldsTo: ['--nts-chat-blur'] },
    { sel: '.compact-export-history-message.is-user .compact-export-history-bubble',
      light: { color: [208, 231, 255], a: 0.8784 },   // #d0e7ffe0
      dark: { color: [33, 72, 118], a: 0.9020 },      // #214876e6
      blur: { px: 8, extra: 'saturate(1.08)' },
      yieldsTo: ['--nts-chat-blur', '--nts-user-bubble-bg'] },
    { sel: '.compact-export-history-message.is-system .compact-export-history-bubble',
      light: { color: [242, 246, 252], a: 0.9608 },   // #f2f6fcf5
      dark: { color: [30, 42, 59], a: 0.9608 },       // #1e2a3bf5
      blur: { px: 8, extra: 'saturate(1.08)' },
      yieldsTo: ['--nts-chat-blur', '--nts-tool-bubble-bg'] },
    { sel: '.compact-export-history-message.is-visit-peer .compact-export-history-bubble',
      // 原生是渐变：两端的 alpha 一起乘，渐变本身保留（换成实色会丢外观）。
      light: { stops: [[243, 237, 255, 0.9608], [222, 208, 255, 0.9412]], angle: '135deg' },
      dark: { stops: [[57, 45, 80, 0.9412], [45, 35, 66, 0.9412]], angle: '135deg' },
      blur: { px: 8, extra: 'saturate(1.08)' },
      yieldsTo: ['--nts-chat-blur', '--nts-tool-bubble-bg'] },
    { sel: '.compact-export-history-empty',
      light: { color: [255, 255, 255], a: 0.2588 },   // #ffffff42
      dark: { color: [23, 35, 50], a: 0.2784 },       // #17233247
      blur: { px: 8, extra: 'saturate(1.08)' } },
    { sel: '.compact-export-history-controls',
      light: { color: [255, 255, 255], a: 0.1804 },   // #ffffff2e
      // 应用侧有 [data-theme=dark] .compact-export-history-controls{background:#17233247}
      // —— 不留 dark 的话，暗色下关虚化对这条控件带毫无作用（实测）。
      dark: { color: [23, 35, 50], a: 0.2784 },       // #17233247
      blur: { px: 8, extra: 'saturate(1.08)' } },
    /* ---- 导出预览层（同一个"白纱"机制，单独一套类名） ---- */
    { sel: '.compact-export-preview-region',
      light: { color: [255, 255, 255], a: 0.1804 },   // #ffffff2e
      dark: { color: [23, 35, 50], a: 0.2784 },       // #17233247（同上，暗色覆盖）
      blur: { px: 8, extra: 'saturate(1.08)' } },
    { sel: '.compact-export-preview-bubble',
      light: { color: [255, 255, 255], a: 0.6784 },   // #ffffffad
      dark: { color: [33, 45, 62], a: 0.7216 } },     // #212d3eb8
    { sel: '.compact-export-preview-message.is-user .compact-export-preview-bubble',
      light: { color: [208, 231, 255], a: 0.7020 },   // #d0e7ffb3
      dark: { color: [33, 72, 118], a: 0.7412 },      // #214876bd
      yieldsTo: ['--nts-user-bubble-bg'] },
    { sel: '.compact-export-preview-message.is-system .compact-export-preview-bubble',
      light: { color: [131, 148, 175], a: 0.1608 },   // #8394af29
      dark: { color: [80, 90, 110], a: 0.2196 },      // #505a6e38
      yieldsTo: ['--nts-tool-bubble-bg'] },
    { sel: '.compact-export-preview-message.is-visit-peer .compact-export-preview-bubble',
      light: { stops: [[243, 237, 255, 0.8392], [222, 208, 255, 0.8196]], angle: '135deg' },  // #f3edffd6,#ded0ffd1
      dark: { stops: [[57, 45, 80, 0.8392], [45, 35, 66, 0.8392]], angle: '135deg' },        // #392d50d6,#2d2342d6
      yieldsTo: ['--nts-tool-bubble-bg'] }
  ]
};


/* ============================================================================
 * 面板边缘光效 / 玻璃拟态（v0.1.11）
 * ============================================================================
 * 挂载点是实测选出来的，不是猜的：
 *
 *   1) 外发光不能挂 .compact-export-history-scroll —— 它自带
 *      mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)
 *      外发光会被这块遮罩裁掉，整图差分只测到 4 个像素变化（等于没画）。
 *      挂到父级 .compact-export-history-anchor::before 后能正常外溢 32px，
 *      且完全不碰 mask（顶部渐隐照旧）。
 *
 *   2) 描边 / 四角高光 / 反射高光 / 内阴影 放 anchor::after。
 *      这两个伪元素在应用侧占用数为 0（.compact-export-history-anchor::before
 *      与 ::after 各 0 次），可以安全征用。
 *
 *   3) 磨砂层（背景图本身的模糊）必须夹在「容器背景」和「消息内容」之间：
 *      - 挂 scroll 的 backdrop-filter → 模糊的是 app 白底，画在 scroll 自身背景上的
 *        图片模糊不到；
 *      - 挂 anchor::after 盖在上面 → 会连消息文字一起糊；
 *      - 挂 scroll::before + z-index:-1 → 负层正好在自身背景之上、in-flow 内容之下。
 *        实测：图片区域清晰度 -62%，文字区域仅 -1%。
 *
 * 变量全部可选；不配置则整块 CSS 不加载（契约「未配置零变化」）。
 */
var NTS_GLOW = {
  /* 外发光 + 描边等装饰层的宿主 */
  anchorSel: '.compact-export-history-anchor',
  /* 磨砂层宿主（背景图就画在它身上） */
  frostSel: '.compact-export-history-scroll',
  /* 圆角跟背板圆角一致：锚点矩形与 scroll 矩形实测完全重合 */
  radiusVar: '--nts-chat-panel-radius',
  /* 呼吸动画名（gen-css.js 输出 @keyframes 用） */
  breatheName: 'nts-panel-glow-breathe',
  vars: {
    glowColor: '--nts-panel-glow-color',
    glowStrength: '--nts-panel-glow-strength',
    glowSize: '--nts-panel-glow-size',
    glowPulse: '--nts-panel-glow-pulse',
    glowSpeed: '--nts-panel-glow-speed',
    borderColor: '--nts-panel-border-color',
    borderWidth: '--nts-panel-border-width',
    cornerGlow: '--nts-panel-corner-glow',
    edgeGradient: '--nts-panel-edge-gradient',
    glassTint: '--nts-panel-glass-tint',
    glassBlur: '--nts-panel-glass-blur',
    sheen: '--nts-panel-sheen',
    innerGlow: '--nts-panel-inner-glow'
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NTS_TARGETS: NTS_TARGETS, NTS_GATED: NTS_GATED, NTS_VEIL: NTS_VEIL, NTS_GLOW: NTS_GLOW };
}
