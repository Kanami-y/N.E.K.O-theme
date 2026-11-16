# N.E.K.O 主题插件 — 实现契约（唯一事实来源）

本文件是全队共用契约。**所有实现必须遵循本文件**；发现契约有误 → 先改本文件再改代码。

---

## 0. 已验证的硬事实（不要重新验证，直接依赖）

| 事实 | 证据 |
|---|---|
| 插件 SDK **没有**任何主题/CSS 注入 API | 556MB `projectneko_server.exe` 全量扫描 `inject_css`/`global_css`/`theme_override` 等 → 0 命中 |
| 插件 HTML 卡片渲染在**沙箱 iframe**，只继承 `color` + `font-family` | `neko-chat-window.es.js` 偏移 753502 `function QN({block:e})` |
| 应用**没有颜色 token 层**，颜色是硬编码字面量 | `static/css/index.css` 的 `:root` 只有 3 个非颜色变量 |
| 暗色靠 `dark-mode.css` 里的 `[data-theme="dark"]` 前缀规则 | `[data-theme="dark"] .message.user{background:#2a7bc4;color:#fff}` |
| 48911 **实时从磁盘**提供 `static/` 和 `templates/`（改文件立即生效，无需重启） | 向 `templates/chat.html` 注入 marker 后 `GET /chat` 立刻出现 |
| 48911 **没有任何 CSP 响应头** | `GET /` 与 `/chat` 只有 `Content-Type`/`Date`/`Server` |
| 48916 **跨源供给**插件 `static/` 且 CORS 回显任意 Origin | `GET :48916/plugin/wechat_integration/ui/style.css` → `200 text/css`；`Access-Control-Allow-Origin` 回显 |
| `/plugin/{id}/ui/<file>` 映射到插件 `static/<file>` | wechat 的 `static/style.css` ↔ `/plugin/wechat_integration/ui/style.css` |
| 主题切换信号 = `documentElement` 的 `data-theme="dark"` 属性 | `theme-manager.js` 实现；聊天窗口用 MutationObserver 监听 |
| 把样式状态推给所有窗口的官方范式 | `_asar_src/src/main/chat-font-preset-sync.js`（`executeJavaScript` 打属性 + 派发事件） |

**结论：插件单独无法改到聊天界面。必须给应用模板打一次极小补丁（加 `<link>`/`<script>`），这是设计前提，不是可选项。**

---

## 1. 交付物两个部分

### A. 插件（用户可编辑、升级安全）
```
D:\tools\enokoo\theme-studio\plugin\            ← 开发源（本仓库，唯一源）
  plugin.toml
  __init__.py
  build_info.py
  i18n\zh-CN.json  i18n\en.json
  static\index.html                              ← 面板（static，iframe 打开）
  static\app.js  static\style.css                ← 面板逻辑与样式（含 RGB 调色）
  static\theme.json                              ← 调色板（同时作为 48916 的 GET 端点）
  README.md
```
安装后落到 `C:\Users\曦\AppData\Local\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\`
（`plugin_id = neko_theme_studio`）

> **为什么面板是 `static` 而不是 `hosted-tsx`（决定性约束）**：应用侧 loader 必须用普通 HTTP
> `GET` 去读 `theme.json`，而 `/plugin/{id}/ui/*` **只为 `mode="static"` 的面板挂载**。
> 实测：`wechat_integration`/`app_launcher`（static）的 `/ui/style.css`、`/ui/` 都 200；
> 而 `netease_music`/`lifekit`/`mcp_adapter`/`neko_calabiqiu` 等 hosted-tsx 插件的
> `/ui/`、`/ui/theme.json`、`/ui/panel.tsx` **全部 404**。所以面板必须是 static。

### B. 应用侧两件套（插件自带 + 插件启动时自动同步进安装目录）
```
插件包内  <插件根>\static\loader\neko-theme-studio.css   → resources\bin\static\css\neko-theme-studio.css
插件包内  <插件根>\static\loader\neko-theme-studio.js    → resources\bin\static\neko-theme-studio.js
```
> 为什么放安装目录：48911 只从自己的安装目录供 `static/`；且这样**插件停用/卸载时主题依然生效**（回退到 localStorage 缓存）。
> 代价：升级 N.E.K.O 会覆盖 → 由插件 startup 的 `_app_patch.ensure_app_patch()` 每次启动幂等重刷（见 §6B），**不需要用户重跑脚本**。
> 源文件也保留在 `theme-studio\app\`（开发用），`install.ps1` 步骤 D 仍然复制它，两条路径产出**字节一致**的两件套。

---

## 2. 运行时数据流（关键机制）

```
[48916 面板 iframe]                          [48911 应用各窗口]
  static/index.html + static/app.js             <link  css/neko-theme-studio.css>   ← 静态规则，永不改写
      │ action:call                             <script neko-theme-studio.js>
      ▼                                              │
  __init__.py  entry apply_theme                     │ 1. 立刻用 localStorage 缓存渲染（无闪烁）
      │ 写 static/theme.json                          │ 2. fetch 48916 /plugin/neko_theme_studio/
      ▼                                               │    ui/theme.json?_=ts  (cache:'no-store', CORS ok)
  static/theme.json  ←── GET ────────────────────────┘ 3. 变化则应用 + 回写 localStorage
                                                      4. 每 1500ms 轮询（仅 visible 时）+ focus 时刷新
```

**为什么轮询**：面板在 48916 源，应用窗口在 48911 源 —— 两者 **localStorage 不互通**，`BroadcastChannel` 也跨源不通。跨源 `postMessage` 无法从面板直接找到所有应用窗口。轮询本机 JSON 是最简单可靠的活体同步方式。

**缓存穿透**：一律用注入 `<style>` 承载变量（不走 CSS 文件），所以只有 JSON 需要 `cache:'no-store'`。

---

## 3. 颜色变量契约（前缀 `--nts-`，nts = Neko Theme Studio）

### 3.0 门控规则（v3，唯一形态 —— 生成的样式表里**没有任何回退值**）

每条生成的声明都门控在**按 (模式, 变量) 分键**的 `<html>` 属性上：

```css
/* 亮色：仅当亮色组配了该变量，且当前不是暗色 */
:root:not([data-theme="dark"])[data-nts-l-<var>]:root:root body <SEL> { prop: var(--nts-<var>) !important }
/* 暗色：仅当暗色组配了该变量，且当前是暗色 */
:root[data-theme="dark"][data-nts-d-<var>]:root:root body <SEL> { prop: var(--nts-<var>) !important }
```

属性名 = `data-nts-l-`（亮色组）/ `data-nts-d-`（暗色组）+ 去掉 `--nts-` 前缀的变量名，
例如 `--nts-user-bubble-bg` → `data-nts-l-user-bubble-bg`。加载器只在用户**在该模式下**
真的配了该变量时才打对应属性（`applyPalette()` 里 `setGates(light, dark)`）。
另有 `data-nts-active` 表示「本窗口有非空调色板」。

**三个不变量因此是构造性的，不依赖量测**：

| 场景 | 为什么成立 |
|---|---|
| 空调色板 → 零视觉变化 | 没有任何门属性 → 所有选择器都不匹配 → 我方表完全惰性 |
| 只配亮色 → 暗色不受影响 | 暗色规则额外要求 `[data-theme="dark"]` **且** `data-nts-d-*` |
| 只配暗色 → 亮色不受影响 | 亮色规则要求 `data-nts-l-*`，暗色组不会打它 |

亮色/暗色**互不继承**（用户已拍板：两组各管各的；想两个模式同色就设两遍）。

特异性：亮色 `(0,4,1)+SEL`、暗色 `(0,6,1)+SEL`，稳赢原生最强的
`[data-theme="dark"] SEL`(0,3,0)，且两侧都带 `!important`。重复 `:root` 是合法的
特异性抬升手法（匹配同一个 `<html>`）。

### 3.1 为什么放弃了回退值（v1/v2 的失败史 —— 不要重走）

v1 手写回退值 → 实测空调色板下改变 25 处外观。v2 改为「用真实浏览器逐 (选择器,属性,亮/暗)
量测原生值再烘焙成回退」→ 独立验证者仍在真实 `/chat` 上抓到 4+ 条反例，因为
**合成量测页量不到真实页的计算值**，至少四类差异：

1. **层叠输家**：`neko-chat-window.css` 里 `.chat-body{background:rgba(255,255,255,calc(.91*var(--neko-chat-opacity-factor,1)))}`
   紧跟同特异性的 `.chat-body{background:transparent}`（后者胜）；量测取到了前者。
   `.composer-galgame-btn`（被 `.compact-input-tool-fan .composer-galgame-btn` 压过）、
   `.send-button-circle`（被 `.compact-chat-surface-frame[data-compact-tool-toggle-visible=true] .compact-input-tool-toggle[aria-haspopup=true]` 压过）同型。
2. **继承值陷阱**：原生对 `.message-block-text` 的 `color` **声明数为 0**，
   `getComputedStyle` 返回的是从祖先继承来的值；写死即改动未配置外观
   （曾导致亮色下聊天正文白字白底、对比度 1.00，原生 4.45）。
3. **真实页的 `<body>` 类**：真实 `/chat` 的 body 带 `.electron-chat-window`，
   使 `body:not(.electron-chat-window) …` 一族规则在真实页**根本不生效**。
4. **运行时注入的 `<style>` 层**：真实页有 4 个 inline `<style>`，其中一个是
   22541 字符 / 62 规则 / 99 处 `!important` 的运行时层，压过所有样式表；
   量测页完全看不到这一层（`#text-input-area` 的 .5→.65、`.composer-input-shell` 的 .25→.08 都源于此）。

v3 的结论：**量测不可靠就不要依赖量测**，把「未配置 == 未加载」做成选择器层面的构造性质。
现在量测只用于两件事：给面板提供参考文本、跑覆盖率哨兵。

### 3.2 实测值只作展示，不作 CSS

`build/vars.json` 里每个变量的 `native` / `darkNative` 仅用于面板展示与文档，
**永不写进生成的 CSS**。面板 CATALOG 的 `native` 字段甚至从不被读取，
只有 `.darkNative`（`displayValue()`）与 `.hint` 会到用户眼前。

### 3.3 变量分组

### 聊天气泡
| 变量 | 说明 |
|---|---|
| `--nts-user-bubble-bg` / `--nts-user-bubble-text` / `--nts-user-bubble-border` | 用户气泡 |
| `--nts-ai-bubble-bg` / `--nts-ai-bubble-text` / `--nts-ai-bubble-border` | AI 气泡 |

### 聊天窗口
`--nts-chat-bg`、`--nts-chat-panel-bg`、`--nts-chat-panel-radius`（背板圆角，与 `--nts-radius` 并列的独立旋钮）、`--nts-chat-bg-image`（聊天背景**图片**，值种类 `image`，见下）、`--nts-topbar-bg`、`--nts-topbar-text`、`--nts-chat-blur`（毛玻璃，**单位只接受 px/rem/em/pt 或 0**）、`--nts-chat-opacity`

`--nts-chat-bg-image` 是本契约里**唯一** `image` 种类（v0.1.4 新增）。合法值只有两种形态，整串锚定：

```
none
url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/<文件名>")
```

host 只认 `127.0.0.1` / `localhost`（端口 2–5 位、可省），文件名限制在 `[A-Za-z0-9._-]`、最长 80。
它**必须**在通用黑名单（含 `url(` 即拒，那条规则是给颜色值用的）**之前**判定，由专用正则整串锚定。
三处同名镜像正则：后端 `RE_BG_URL`、加载器 `RE_BG_VALUE`、面板 `RE_BG_VALUE`。

绘制面与 `--nts-chat-panel-bg` 完全一致，四条声明同进同退（缺 `size/position/repeat` 就会被平铺成马赛克）：

```css
background-image: var(--nts-chat-bg-image)       !important;
background-size: cover                            !important;
background-position: center center                !important;
background-repeat: no-repeat                      !important;
```

同盒上的 `background-image` 永远画在 `background-color` **之上**，所以
**图片天然优先于「背景色替换」—— 这是 CSS 背景层序的性质，不靠 z-index、不加额外开关**。
`background-image` **不进** `GATE_DECL` 逐条表（单写一条不成立），由 `tools/gen-css.js` 的
专门段落一次性输出，`test/targets.js` 里只登记 `background-image` 一条、四个目标。

### 紧凑胶囊 / 悬浮 HUD（真实聊天窗的可见面）
真实 `/chat` 默认处于**紧凑胶囊态**（`body.subtitle-web-host.react-chat-window-open` +
`.app-shell.chat-surface-mode-compact`）。该布局下 `.chat-window` / `#react-chat-window-root` /
`.chat-body` / `.composer-panel` 的高度为 0、背景被应用自己的
`background: transparent !important`（`resources/bin/static/index.css`，特异性 (2,3,1)）压平，
所以「直接给这些元素写 background-color」**永远看不到效果**（曾因此被判定为「主题完全失效」）。

可见面与桥接方式（`test/targets.js` H / I 段）：

- **胶囊底色**：不跟应用的 `background: transparent !important` 硬碰，而是**改写应用自己的
  桥接变量** —— `.compact-chat-surface-frame` 上写
  `--compact-chat-surface-bg: var(--nts-chat-bg) !important` 与
  `--compact-chat-capsule-surface-bg: var(--nts-chat-bg) !important`（`::before` 读它们）；
  `--compact-chat-surface-shadow` ← `--nts-shadow`、`border-color` ← `--nts-accent`、
  `backdrop-filter` ← `--nts-chat-blur`。
- **发送/工具按钮**：`.compact-input-tool-toggle`（与 `.send-button-circle` 同一元素）的
  `background-color` ← `--nts-send-bg` / `color` ← `--nts-send-text`；
  7 个 `.composer-tool-btn` 的 `color` ← `--nts-button-text`；`.compact-chat-minimize-ball` ← `--nts-button-bg`。
- **悬浮 HUD**：`common-ui-hud.js` 用 `Object.assign(el.style, …)` 内联写样式，值全部读
  `var(--neko-popup-*, 原生回退)` / `var(--neko-hud-header-bg, …)`。因此 `NTS_GATED.popupBridge`
  把这些自定义属性桥接到本插件变量（`#agent-plugin-content` / `#agent-plugin-views` /
  `#agent-task-hud` / `#agent-task-hud-header` / `#status-toast` 上按模式门控）：
  `--neko-popup-bg` ← `--nts-panel-bg`、`--neko-hud-header-bg` ← `--nts-panel-bg`、
  `--neko-popup-text` / `--neko-popup-text-sub` ← `--nts-panel-text`、
  `--neko-popup-border` ← `1px solid var(--nts-panel-border)`、
  `--neko-popup-accent` ← `--nts-accent`、`--neko-popup-accent-bg` ← `--nts-accent-bg`、
  `--neko-popup-hover` ← `--nts-accent-bg`、`--neko-popup-shadow` ← `--nts-shadow`。
- **坑**：`.compact-chat-surface-frame` 与 `#agent-task-hud-header` 带
  `transition: background-color .4s`，注入后同一帧读 `getComputedStyle` 仍是旧值
  （`getAnimations()` 显示 running），必须等 ≥400ms 再判定，否则会误判成「选择器特异性不够」。
- **气泡内正文按类型作用域**：`.message-block-text` / `.message-block-markdown` 的 `color` 必须写成
  `.message-bubble-assistant .message-block-markdown` 这类**带作用域**的形式；无作用域的全局规则会把
  用户气泡里的 markdown 正文一并染成 `--nts-ai-bubble-text`（v0.1.4 修复的真实 bug）。
  作用域映射是**一对二**：
  - `--nts-ai-bubble-text` → 仅 `.message-bubble-assistant`（`.message.gemini` 兼容保留）内正文；
  - `--nts-user-bubble-text` → 仅 `.message-bubble-user` 内正文，且纯文本 `.message-block-text`、
    `.message-block-text-plain` 与 `.message-block-markdown` 三条都要写（普通文字默认是纯文本块，
    只有含链接/列表/代码/URL 时才走 markdown 渲染，缺一条就等于「设置不起作用」）；
  - `--nts-tool-bubble-text` → `.message-bubble-tool` 与 `.message-bubble-system` 内正文（与它们的气泡
    底色同一变量组，不要复用 AI 色）。
  > 真实 DOM 里**没有** `.message.user` / `.message.gemini` 这种类名（真实类是 `.message-bubble-<role>`
  > 挂在 `article.message-row > div.message-stack > div.message-bubble` 上）；旧 CSS 把用户文字规则挂在
  > `.message.user .message-block-markdown` 上，所以用户文字色一直是无效设置。

### 输入区
`--nts-input-bg`、`--nts-input-text`、`--nts-input-border`、`--nts-input-placeholder`、`--nts-button-bg`、`--nts-button-text`、`--nts-button-hover-bg`、`--nts-send-bg`、`--nts-send-text`

### 面板 / 弹窗 / 菜单
`--nts-panel-bg`、`--nts-panel-text`、`--nts-panel-border`、`--nts-popover-bg`、`--nts-popover-text`、`--nts-popover-border`、`--nts-modal-bg`、`--nts-modal-text`

### 推荐 / 系统 chip
`--nts-rec-bg`、`--nts-rec-text`、`--nts-rec-border`、`--nts-chip-bg`、`--nts-chip-text`

### 全局
`--nts-accent`、`--nts-link`、`--nts-highlight`、`--nts-scrollbar-thumb`、`--nts-scrollbar-track`

### 非颜色项
`--nts-radius`（通用圆角：按钮/输入面板）、`--nts-font-family`、`--nts-font-size`、`--nts-shadow`

分区圆角（与 `--nts-radius` **并列**的独立旋钮，**各自门控**，留空即保持原生）：
`--nts-bubble-radius`（聊天气泡）、`--nts-shell-radius`（聊天窗外壳）、`--nts-card-radius`（插件卡片）、
`--nts-modal-radius`（弹窗）、`--nts-popover-radius`（浮层）、`--nts-rec-radius`（推荐卡）

### 特殊项
- `--nts-chat-opacity`：取值 `0`–`1`。**桥接到原生乘子** `--neko-chat-opacity-factor`
  （`:root[data-nts-l-chat-opacity]` / `:root[data-theme="dark"][data-nts-d-chat-opacity]`
  下写 `--neko-chat-opacity-factor: var(--nts-chat-opacity) !important`）。
  加载器必须把它的值种类识别为 `number`（自 v0.1.6 起是
  `RE_NUMBER = /^(?:0|1|0?\.[0-9]+|1\.0+)$/` —— 放行 `1.0` / `1.00` 这类零填充写法），
  否则会被当颜色值拒绝而**静默失效**（真实发生过的死控件：面板报成功、用户看不到任何变化）。
- `--nts-scrollbar-thumb` / `--nts-scrollbar-track`：**必须成对配置**。
  生成器只在**同一模式**下两个变量都配置时才输出 `scrollbar-color`，
  否则色对不完整反而改坏原生滚动条（Chromium 121+ 设置了 `scrollbar-color` 后会忽略
  `::-webkit-scrollbar-*` 伪元素）。
- `--nts-highlight`：`::selection` 的颜色。`::selection` 在静态量测页**无法量测**（UNQUERYABLE），
  只能靠真实页人工确认。
- `--nts-button-hover-bg`：只在悬停时生效，静态页无法触发（NO-PSEUDO-STATE）。
  验证要用 CDP `DOM.querySelector` + `CSS.forcePseudoState{forcedPseudoClasses:['hover']}`
  （`Input.dispatchMouseEvent` 的 `mouseMoved` **不产生** `:hover`）。

> 变量命名**不得**与 `--compact-*`（布局几何）、`--xy-*`（XYFlow 三方库）冲突。绝不覆盖 `--compact-*`。
> `--neko-popup-*`（由 `agent-plugin-views.css` 与 `common-ui-hud.js` 使用）以桥接方式按变量、按模式各自门控。
> v0.1.4 起桥接目标从 5 个扩到 9 个，并覆盖 `.compact-chat-surface-frame` 的胶囊变量与 `#agent-task-hud` 一族（见上）。

---

### 4.2b `--nts-bubble-veil`（v0.1.6 新增，值种类 `number`）

聊天背景之上那层"虚化"由**气泡自己**的两条声明构成：白纱 `background`（alpha 0.878）
与 `backdrop-filter: blur(8px)`。只关其中一个都不足以让背景图透出来（实测边缘能量
0.1 → 595.5 → 40291.9），因此本契约把它建模成 **0–1 乘子**，由 CSS `calc()` 同时
乘进 alpha 与模糊半径：

- `1` / 不设 = 原生；`0` = 完全清透；中间值线性过渡。
- 覆盖 11 个白纱层（历史层 5 + 空态/controls/预览层 6），清单在 `test/targets.js` 的 `NTS_VEIL`。
- **让位**：`--nts-chat-blur` 存在时模糊交给它；`--nts-user-bubble-bg` /
  `--nts-ai-bubble-bg` / `--nts-tool-bubble-bg` 存在时对应角色的白纱交给它们。
  两段各算各自的 `:not([data-nts-*-gate])` 后缀，互不牵连。
- 三处白名单必须同步：后端 `NUMBER_VARS`、loader `NON_COLOR_VARS` 的 `'number'`、面板 `CATALOG` 的开关行。

## 4. 调色板 JSON 格式（`static/theme.json`）

```json
{
  "schema": 1,
  "name": "樱花粉",
  "enabled": true,
  "updated_at": "2026-11-15T14:00:00+08:00",
  "vars":      { "--nts-accent": "#ff8ab0", "--nts-user-bubble-bg": "rgba(255,138,176,0.92)" },
  "dark_vars": { "--nts-chat-bg": "rgba(28,20,26,0.86)" }
}
```

**只有这六个键。`version` 已被移除**（v0.1.4）。这一条是「theme.json」/「version」关系的唯一权威表述：
老文件里的 `"version"` 被读方忽略、被写方丢掉，取代它的是 `updated_at` 与「整份 JSON 文本判等」——

- 写方（`_normalize()` / `default_palette()`）只产出上面六个键，不再有版本计数器；
- 老文件里残留的 `"version"` 键被**刻意忽略**（读路径不报错、不拒收），下一次任何落盘
  （`apply_theme` / `reset_theme` / `apply_saved_theme` / `import_theme`）都会让它自然消失 ——
  不需要迁移脚本。出厂的那份 `static/theme.json` 已在本轮清成六个键（`name` 也从
  `empty` 改回 `默认`），新装用户不会再看到残留字段；
- 读方（加载器）**不再比较版本号**，改为比对每次轮询到的 `theme.json` **原始 JSON 文本**：
  `raw = JSON.stringify(p)` → `if (!force && raw === lastRaw) return;` → `applyPalette(p); lastRaw = raw;`。
  轮询间隔仍是 1500ms（仅窗口可见时），因此**手改文件最迟 1.5 秒生效**；
  `storage` 事件旁路同样按 `raw === lastRaw` 判；
- `updated_at` **不参与判等**，只作日志/诊断展示（加载器 `stampOf()` 的注释：「只用于日志/诊断展示，
  判等一律靠原始 JSON 文本」）。所以「重置」不再需要靠改版本号让应用侧感知。
- `vars` → 注入 `:root:not([data-theme="dark"]){...}`（**必须限定非暗色**，
  否则只配亮色时会渗进暗色模式）
- `dark_vars` → 注入 `:root[data-theme="dark"]{...}`
- 两组**互不影响**：只配亮色时暗色保持 N.E.K.O 原生配色，反之亦然
- `enabled:false` → 视为未启用（loader 清空自己注入的 `<style>`，并撤销全部门控属性）
- 浏览器侧**不做校验**，非法值要静默忽略（用 `CSSStyleDeclaration.setProperty` 逐条设置，失败即跳过）

### 4.1 主题仓库（library）与背景图在磁盘上的位置

`static/theme.json` 只是「当前生效的调色板」。仓库与背景图是**另外两处目录**，都在插件自己的 `static/` 下：

```text
plugin/static/
├── theme.json                 # 当前生效的调色板（加载器唯一读取的来源）
├── themes/<id>.json           # 主题仓库：一条一个文件（_ensure_dirs() 启动时创建）
└── backgrounds/<sha256-16>.<ext>   # 背景图：内容寻址、去重（首次上传时创建）
```

仓库条目只有五个键（**不含 `enabled` / `updated_at`**，与 `theme.json` 不同）：

```json
{
  "schema": 1,
  "id": "sakura-pink-20261115140211",
  "name": "樱花粉",
  "saved_at": "2026-11-15T14:02:11+08:00",
  "vars":      { "--nts-accent": "#ff8ab0" },
  "dark_vars": { }
}
```

- `id` = `<slug>-<YYYYmmddHHMMSS>`，slug 为名称小写、非字母数字压 `-`、取前 32 位、空则 `theme`；
  同秒重名追加 `-2` / `-3`。id 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，所以文件名不可能越出目录。
- 名称经 `_clip_name()`：去首尾空白、截 60、空则「默认」。条目上限 200（`LIBRARY_MAX_ITEMS`）。
- 写盘同样是「临时文件 + `os.replace`」原子写，且在 `_WRITE_LOCK` 内。
- 列表按 `saved_at` 倒序；坏文件跳过并记 warning（`仓库条目已损坏，跳过 <文件名>：<异常>`），
  不会让整列变空。删除是 `unlink(missing_ok=True)`，幂等，且**不影响** `theme.json`。
- 背景图文件名 = `sha256(内容)` 前 16 位 + 文件头嗅探出的扩展名（png/jpg/jpeg/webp/gif），
  同内容重复上传不重写。可访问 URL = `<PLUGIN_BASE_URL>/plugin/neko_theme_studio/ui/backgrounds/<文件>`，
  即 `static/backgrounds/<文件>` 经 `/plugin/<id>/ui/` 暴露；`PLUGIN_BASE_URL` 默认
  `http://127.0.0.1:48916`，可被环境变量 `NTS_PLUGIN_BASE` 覆盖。

---

### 4.2c 背景图引用的一致性约束

`--nts-chat-bg-image` 的值只允许 `none` 或
`url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/<16位哈希>.<ext>")`。
文件名是内容的 SHA256 前缀，所以**同名必然同内容**，这带来两条不变量：

1. 导入时若本机已有同名文件，直接复用，不必依赖分享包携带图片
   （裸 JSON 导入因此不会丢图）。
2. 任何写入 theme.json 的路径（`apply_theme` / `apply_saved_theme` /
   `import_theme` / `import_theme_archive`）都必须保证文件真实存在，
   否则会在应用侧产生 404；指向已删除文件的引用在写入前就被摘掉，
   并在返回的 `rejected` 里说明。

## 4b. 主题分享包（zip）格式

`export_theme_archive` 产出、`import_theme_archive` 消费同一个格式：一个 `ZIP_DEFLATED` 包，三层：

```text
<名称>-<YYYYmmddHHMMSS>.zip
├── theme.json              # 调色板；图片引用改写成可移植形式 url("images/<name>")
├── README.txt              # 给人看的说明（常量 ARCHIVE_README）
└── images/<name>           # 调色板真正引用到的每张图（去重、按名字排序）
```

`README.txt` 原文：

```text
N.E.K.O 主题工坊 · 主题分享包

theme.json 是调色板；images/ 里是与它配套的背景图。
用法：打开 插件 → 主题工坊 → 主题仓库 → 导入压缩包，选择本文件即可。
导入只会把主题存进仓库，不会立刻改动你当前的配色；在仓库里点「应用」才切换。
```

包内 `theme.json` 与仓库条目同构（`schema`/`name`/`saved_at`/`vars`/`dark_vars`），
差别只在图片引用的写法：仓库里是绝对 URL，包里是 `url("images/<name>")`。

导入侧规则：

| 项 | 规则 |
|---|---|
| 识别 | 前 4 字节为 `PK\x03\x04` → zip；否则按裸 JSON 解析（兼容旧 `export_theme` 的文本导出）。`data` 容忍 `data:` 前缀 |
| 图片改写 | `url("images/<name>")` 的 basename 到包内 `images/` 找同名文件 → 落盘 `backgrounds/` → 改成绝对 URL |
| **缺图** | **整条引用丢成空串**（该变量回退原生、没有背景图），并 log `分享包里缺少图片 <name>，该引用已丢弃`。故意不保留坏路径 —— 留一个指向 `images/…` 的引用落到应用里就是一张 404，表现成「背景一片空白还查不出原因」 |
| 路径安全 | zip 条目名以 `/` 开头、含 `..` 段或含 `:` 一律整体拒绝（`压缩包里含有非法路径：<name>`） |
| 找调色板 | 优先名为 `theme.json` 的条目；一个 JSON 都没有 → `压缩包里没有 theme.json（主题分享包应包含一个 JSON 调色板）。` |
| 图片收集 | 按扩展名 `.png/.jpg/.jpeg/.webp/.gif`，键用 basename（不保留子目录） |
| 空调色板 | `vars` 与 `dark_vars` 都空 → `分享包里没有可用的调色板变量（可能不是主题工坊的分享包）。` |
| 副作用 | **只入库，不切换**：不写 `theme.json`、不改当前配色。要切换得再调 `apply_saved_theme` |

硬上限（超出即 `Err`）：

| 项 | 上限 | 常量 |
|---|---|---|
| 整个 zip | 8 MiB | `ARCHIVE_MAX_BYTES` |
| 单张图片 | 4 MiB | `IMAGE_MAX_BYTES` |
| zip 条目数 | 300 | `ARCHIVE_MAX_ENTRIES` |
| 解压后总字节 | 24 MiB | `ARCHIVE_MAX_UNCOMPRESSED` |
| 仓库条目数 | 200 | `LIBRARY_MAX_ITEMS` |

---

### 12c. 校验器的「合法写法」边界（v0.1.9）

三份校验器（后端 `_is_safe_value`、loader `isSafeValue`、面板 `isValidValue`）必须对同一份值给出同一个答案，各自的边界是：

| 值种类 | 接受 | 拒绝 | 备注 |
| --- | --- | --- | --- |
| color | `#rgb`/`#rrggbb`/`#rrggbbaa`、`rgb()`/`rgba()`、`hsl()`/`hsla()`、148 个具名色、`transparent`、`currentcolor` | `inherit`/`initial`/`unset`/`revert`、CSS 系统色（`Canvas`、`ButtonText`…）、任意表达式 | 系统色不在 148 个具名色内，因此被拒是正确行为 |
| shadow | 逗号分隔最多 4 层，每层 offset/blur/spread + 一个颜色 token | 超过 4 层、层级括号不配对、颜色 token 非法 | 颜色 token 走 color 那一行的规则 |
| number | `0`、`1`、`0.x`、`1.0`/`1.00`、`0%`–`100%` | `1.5`、`2`、负数、`1e1` | 百分比会归一化成 0–1 |
| length | `px`/`rem`/`em`/`%`/`pt`/`vh`/`vw`，值 ≤ 4 位整数 | 无单位裸数字（面板会补 `px`）、负长度 | |
| image | `none`，或指向本插件 `/plugin/<id>/ui/backgrounds/<file>` 的 `url()` | 其它 host、相对路径、`data:` | |
| font | 常用字体族名与通用族 | 含 `;`/`{`/`}`/`<`/`>`/`\`/`url(`/`@import` 的值 | |
| blur | `blur(Npx)`，或裸长度（会补成 `blur()`） | 负值、无单位 | |

**`apply_theme` 的全拒语义**：一次调用里如果给了输入、但 `accepted == 0`（一个变量/name/enabled 都没能被采纳），返回 `Err`，消息是 `没有写入任何改动：<逐条原因>`。部分成功仍返回 `Ok`，被拒条目在 `rejected` 数组里。

## 4c. 内置主题（presets）与多层 box-shadow

### 4c.1 `static/presets/` —— 随插件发布的只读主题

- 位置：`plugin/static/presets/<id>.json`，格式 = 仓库条目（`schema/id/name/saved_at/vars/dark_vars`）。
- 读路径补 `"builtin": true`；`saved_at` 对外统一显示「内置」。
- `list_themes` = `_preset_items() + _library_items()`（预设在前）。
- `delete_theme` 命中预设直接 `SdkError`（不进删除流程，文件永不删）。
- `_load_library_item()` 先在 `themes/` 找，找不到回落 `presets/`，所以
  `apply_saved_theme` / `export_theme_archive` 对两种来源是同一套代码。
- **图片引用写相对形式** `url("images/<hash>.<ext>")`，读时经 `_rewrite_archive_refs()`
  换成本机绝对 URL。写绝对 URL 会绑定端口，换机即坏。
- `_gc_backgrounds()` 的引用扫描必须同时认 `backgrounds/<name>` 与 `images/<name>`；
  只认前者会把仅被预设引用的图当孤儿删除（v0.1.7 的回归 bug）。
- 图片本体与用户上传共用 `static/backgrounds/`（内容哈希命名，同名必同内容）。

### 4c.2 `--nts-shadow` 支持 1–4 层

`SHADOW_MAX_LAYERS = 4`。校验顺序：**先按顶层逗号切层**（`_split_shadow_layers()` /
loader 的 `shadowLayers()` / 面板的 `shadowLayers()`，括号不配对返回空 → 拒），
再对每层跑原有的 token 校验（`_shadow_layer_ok()`）。三处必须保持一致：

| 位置 | 函数 |
| --- | --- |
| 后端 `plugin/__init__.py` | `_split_shadow_layers()` + `_shadow_layer_ok()` |
| 加载器 `static/loader/neko-theme-studio.js` | `shadowLayers()` + `shadowLayerOk()` |
| 面板 `static/app.js` | `shadowLayers()` + `shadowLayerOk()` |

多层写法示例（真实的「星辰喵」预设用的就是这个）：
`0 0 20px rgba(0, 210, 255, 0.4), 0 0 15px rgba(179, 136, 255, 0.5)`。

> 旧实现把整串按空白切成 token，逗号会粘在颜色上 → 7 个 token > 6 上限 → 整串被拒，
> 所以多层阴影在 v0.1.6 及以前**永远存不进去**。

## 5. 加载顺序与优先级（决定覆盖胜负）

`templates\chat.html` 现有顺序（第 16–25 行）：`index.css, music_ui.css, subtitle.css, agent-plugin-views.css, dark-mode.css, yui-guide.css, neko-chat-window.css, theme-manager.js, APlayer`
`templates\index.html` 现有顺序（第 45–60 行）：`... neko-chat-window.css(54), avatar-reaction-bubble.css, agent-plugin-views.css(57), dark-mode.css(58), theme-manager.js(60)`

**补丁必须插在 `dark-mode.css` 之后**（chat.html 插在第 25 行后 / index.html 插在第 60 行后）。
选择器特异性：v3 的门控前缀已经远超原生竞争者，无需再靠 `!important` 取胜 ——
亮色规则 `:root:not([data-theme="dark"])[data-nts-l-<var>]:root:root body <SEL>` = (0,4,1)+SEL，
暗色规则 `:root[data-theme="dark"][data-nts-d-<var>]:root:root body <SEL>` = (0,6,1)+SEL；
原生最强竞争者 `[data-theme="dark"] .message.user` 只有 (0,3,0)。
`!important` 仍然保留（原生样式表里本身有 85 处 `!important`），但**只用于颜色/背景/边框/圆角/字体/阴影/模糊，绝不改布局属性**。
> 历史：v1/v2 用 `html body ` 前缀（(0,2,2)）面对 `[data-theme="dark"] SEL`(0,3,0) **是输的**，靠 `!important` 才勉强扳平 —— 那是旧设计的弱点，v3 已经不需要。

### 5.1 运行中窗口的旧样式表（loader 1.4.0 起自愈）

服务器端没有缓存歧义（URL 带内容哈希），但**已经打开的窗口不会重读模板**：它 DOM 里的
`<link href="…-<旧哈希>">` 会一直用到窗口重开。插件升级后，旧窗口就是「URL 指向旧文件」，
用户看到的仍是旧规则 —— v0.1.4 用户投诉「AI 文字色串染用户文字」正是这样复发的（模板已指向新哈希，
但窗口是升级前打开的，CSS 还是 01:00 那份）。

加载器 1.4.0 的 `refreshStaleStylesheet()` 在 `boot()` 里做一次比对：
`fetch(css, {cache:'reload'})` 取服务器当前内容 → `new CSSStyleSheet().replaceSync(cssText)` 解析 →
签名 = 规则条数 + 每条 `cssText` 长度之和；与页面里已生效的 `link.sheet` 签名不同时，把 `link.href` 改为
`原 URL + (&|?) + 'nts-refresh=' + Date.now()` 强制换表，并 `console.warn` 一次；相同则什么都不做。
**不要**改成无条件重载：那会让每次页面加载都闪一下样式，也会把「刷新」变成常态开销。

---

## 6. 补丁标记（install.ps1 与插件 _app_patch.py 共用的幂等契约）

在模板里插入的一行**必须**带标记注释，便于重复执行时先删旧再插：
```html
<!-- NTS:BEGIN --><link rel="stylesheet" href="/static/css/neko-theme-studio.css?v={{ static_asset_version }}-<css内容哈希8位>"><script src="/static/neko-theme-studio.js?v={{ static_asset_version }}-<js内容哈希8位>" defer></script><!-- NTS:END -->
```
- 插在 `dark-mode.css` 那一行**之后**（chat.html 是第 20 行，index.html 是第 58 行）。
- 先删除已存在的 `<!-- NTS:BEGIN -->...<!-- NTS:END -->` 段，再插入 → 幂等。
- **`-<哈希>` 后缀不能省**：48911 对带 `?v=` 的 `/static/*` 回
  `Cache-Control: public, max-age=31536000, immutable`，浏览器一年内永不重取；
  而 `{{ static_asset_version }}` 是**进程启动时固定**的（实测改文件、改 mtime 都不变）。
  把资源内容哈希拼进 URL，内容一变 URL 就变 —— 这是唯一能穿透 immutable 缓存的热更新手段。
  两侧必须用同一规则：`install.ps1` 的 `Get-NtsMarkerBlock` 与
  `plugin\_app_patch.py` 的 `build_marker_block`（SHA256 前 8 位，小写）。

## 6B. 自愈：插件启动时自己完成应用侧集成

插件 `theme-studio\plugin\_app_patch.py` 在每次 `startup` 里幂等执行 `ensure_app_patch()`：

1. 解析应用根（`sys.executable` 向上三层 / 父进程 exe / `NEKO_APP_ROOT` 环境变量，依次探测
   `<root>\resources\bin\templates` 是否存在）。
2. 把插件包内 `static/loader/` 的两件套同步到 `resources\bin\static\`（内容相同则不动）。
3. 扫描 `templates\*.html`：凡是命中唯一锚点 `<link ... /css/dark-mode.css ...>` 的模板，
   都打上带哈希的标记块（实测 37 个模板中 23 个命中；其余 14 个无此锚点 → 记 skipped，不算失败）。
4. 写回前后校验：Jinja 哨兵在、BEGIN/END 各 1、BOM 状态不变。任一不满足即放弃该文件。
5. 原始字节备份到 `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup`（**不能放插件根**：
   `/plugin-cli/build` 会把插件根下所有文件打进 `.neko-plugin`，23 份备份会让包大 3 倍）。

**任何异常都只记日志、绝不影响插件启动**。诊断结果通过 `startup` 返回值与
`studio_context.app_patch` 暴露；需要时调 entry `repair_app` 手动重跑。

> 为什么必须这样做：宿主没有 CSS/JS 注入 API，插件面板又跑在跨源 iframe 里，
> 唯一通道就是「应用窗口自己加载 loader」。而插件的正常用户路径是「从插件市场安装」，
> 用户不会去跑 PowerShell 脚本。所以应用侧补丁必须由插件自己在启动时完成。

## 6C. 运行期自愈：插件没在跑时谁来救

冷启动后插件可能停在 `stopped`（宿主的用户插件总开关默认关，插件生命周期不启动，
`GET /plugins` 甚至返回空的注册表）。此时应用侧的表现是 `theme.json` **404**，
loader 永远拿不到调色板 —— 用户看到的就是「面板改了颜色、窗口一点没变」。

宿主没有提供外部注入入口，但插件服务的三个端点允许**带合法 CSRF 的跨源调用**，
所以两侧各自实现了同一条自愈链（`refresh` → `start`，顺序不可反）：

| 位置 | 触发 | 实现 |
| --- | --- | --- |
| 应用侧 loader | `HTTP 404` / `HTTP 503` / `Failed to fetch`（`shouldRevive()`） | `reviveService()`：`GET /security/csrf-token` → `POST /plugins/refresh` → `POST /plugin/neko_theme_studio/start` → 0.6s/2.5s 后重拉 |
| 插件面板 | `callPlugin` 抛错且像「插件没起来」（`looksLikePluginDown()`：5xx/404/超时/not running） | `revivePlugin()`：同样两步，等 0.9s 后自动重试一次 `callPluginOnce` |

两侧都是节流的（loader 12s 间隔、40 次预算；成功后重置），失败只记日志/`lastReviveError`，
不会刷屏也不会把页面搞死。`POST /plugins/refresh` 本身就能把空注册表补回 13 个插件，
`POST /plugin/<id>/start` 只在注册表里已有该插件时才真正起进程 —— 这是顺序不能反的原因。

此外 `_app_patch._ensure_autostart_async()` 在 startup 里起一个 daemon 线程，
把 `auto_start` 偏好真正写进 `config\plugin_runtime_overrides.json`
（宿主的 `PUT /plugin/<id>/auto-start` 只在「新值与内存值不同」时才落盘，所以实现里会
先写 `false` 再写 `true` 制造一次真实变化）。这样下次冷启动就由宿主自己拉起插件。

---
## 7. 插件清单要点

`plugin.toml`：
```toml
[plugin]
id = "neko_theme_studio"
name = "主题工坊"
entry = "plugin.plugins.neko_theme_studio:NekoThemeStudioPlugin"
[plugin.sdk]
recommended = ">=0.1.0,<0.2.0"
supported   = ">=0.1.0,<0.3.0"
[plugin.ui]
enabled = true
[[plugin.ui.panel]]
id = "main"
title = "主题工坊"
entry = "static/index.html"
mode = "static"
open_in = "iframe"
context = "dashboard"
permissions = ["state:read", "action:call"]
```
- **面板 `id` 用 `"main"`**：宿主对任何带 `static/index.html` 的老式静态 UI 插件都会自动合成一个
  `id="main"`、无标题、`legacy_static_compat=true`、权限只有 `state:read` 的兼容 surface
  （`GET /plugin/<id>/surfaces` 可见）。此时若再声明 `id="studio"`，插件管理页的标签栏就会出现
  两个入口：无标题的 `main` + 有标题的「主题工坊」，两者指向同一个 `/plugin/<id>/ui/`。
  把面板 id 声明成 `main` 后宿主会把两者**合并成一个** surface（`id=main`、`title=主题工坊`、
  `legacy_static_compat=false`、`context=dashboard`、权限用本块的值），标签栏只剩「主题工坊」。
  实测：`ui.enabled=false` 或删掉面板块 → 只剩无标题的 `main`；删掉整个 `[plugin.ui]` 段 → 两个都回来
  （缺省等于 `enabled=true`）。所以「一个带标题的入口」只有 id=`main` 这一种写法。
- `entry` 形如 `plugin.plugins.<id>:<Class>`（与内置插件一致）。**`[plugin] entry` 是必填字段**：缺失时 API 全程静默（`install` 仍 200、`plugins.lock.json` 也写入），只有插件日志会报
  `Plugin config warning [PLUGIN_SCHEMA_VALIDATION] field=plugin.entry msg=字段必填` 与
  `Plugin <id> has invalid entry point 'None', skipping`。排查「插件装了但没出现」先看这里。
- 面板是**普通 HTML + JS**，不是 TSX：没有 `@neko/plugin-ui`、没有 `props.api`。调用插件的约定见 §7b。
- Python 侧装饰器：`@neko_plugin` / `@lifecycle(id="startup"|"shutdown"|"config_change")` / `@plugin_entry(id=..., name=..., description=..., input_schema={...})` / `@ui.action(...)` / `@ui.context(...)`。

必需 entries：
| entry id | 作用 |
|---|---|
| `get_theme` | 返回当前调色板 JSON |
| `apply_theme` | 入参 `{vars, dark_vars, name, enabled}` → **合并**进当前调色板、原子写盘、刷新 `updated_at`（`version` 已移除，见 §4）；`name` 传空串/纯空白 = 恢复默认名「默认」（v0.1.4 起，不再回误导性的「必须是字符串」错误），非字符串才报错 |
| `reset_theme` | 恢复默认（写回 `static/theme.json` 默认内容） |
| `export_theme` / `import_theme` | 导入导出 JSON 文本 |
| `list_themes` / `save_theme` / `apply_saved_theme` / `delete_theme` | 主题仓库：列表 / 存盘 / 整体切换 / 删除（见 §4.1）。`apply_saved_theme` / `delete_theme` / `export_theme_archive` 的 `input_schema` **同时**声明 `theme_id` 与 `id`（都非必填），函数体首行 `theme_id = theme_id or id` —— 面板发 `id`，脚本里习惯 `theme_id`，两个都收 |
| `export_theme_archive` / `import_theme_archive` | 分享包导出 / 导入（zip，也收裸 JSON；见 §4b） |
| `import_background` | 存一张背景图到 `static/backgrounds/`，返回**裸 URL**（调用方自己拼 `url("…")` 才能写进 `--nts-chat-bg-image`） |
| `export_to_file` | 把当前调色板或仓库条目写成文件（`kind: zip\|json`，`target: desktop\|downloads\|plugin`），返回 `{path, filename, bytes, kind, target, images}`。面板 iframe 的 sandbox 没有 `allow-downloads`，浏览器下载会被静默丢弃，所以面板走这条 |

---

## 7b. static 面板如何调用插件 entry（已验证的调用约定）

照抄 `D:\tools\enokoo\resources\bin\plugin\plugins\wechat_integration\static\script.js`：

1. `GET /security/csrf-token`（`credentials:'same-origin'`）取 `data.csrf_token`，写 `X-CSRF-Token` 头。
2. `POST /runs`，body `{"plugin_id","entry_id","args"}` → 返回 `{"run_id",...}`。
   **结果不在 POST 响应里**，必须轮询 `GET /runs/{run_id}`（每 500ms，上限 25s）。
3. `status === 'succeeded'` 后 `GET /runs/{run_id}/export` 取 `{items}`，用
   `items.find(i => i.type==='json' && i.json) || items[0]`，entry 的返回值在 **`item['json']['data']`**
   里，再 while 剥 `raw.data` 外壳。
4. `failed|canceled|timeout` 抛错；403 且响应头 `X-CSRF-Failure: token` → 清空 csrf 缓存重试一次。
5. **剥外壳的判据必须落在「当前对象自己」身上**：
   `while (raw && raw.data && typeof raw.data==='object' && ('success' in raw || 'error' in raw)) raw = raw.data;`
   写成检查 `raw.data` 内部会导致循环永不执行、面板显示 `版本 undefined`。

**控制类端点（start/stop/auto-start/reload）的 Origin 规则是「同源放行、跨源拒绝」**：
`Origin: http://127.0.0.1:48916`（面板页自身的源）与**不带 Origin** 的本机请求都放行，
`Origin: http://127.0.0.1:48911`（应用页）等其它源会被 `mutation_auth` 拒绝为 **403**
（日志 `Accepted originless local plugin mutation: path=...`）。
→ 面板跑在 48916 的 iframe 里，**可以**自行 `GET /security/csrf-token` → `POST /plugins/refresh` →
`POST /plugin/<id>/start` 完成自愈（本轮已实测 200，见 §6C），不需要 `install.ps1` 代劳；
但应用侧 loader（源为 48911）发起的同类请求必须**不带 Origin** 才会被接受。
> 旧版本这里写成「带任意 Origin（48911 或 48916）都被拒」，是错的。

**插件未运行时**：静态路由 `/plugin/{id}/ui/theme.json` **仍然 200**（已保存的颜色不会丢），
但所有 entry 调用返回 `{"error":{"code":"NOT_READY","message":"Plugin '<id>' is registered but not running",...}}`。
→ 必须保证插件 running，否则用户会看到面板能开、但存不进任何颜色。

**`auto_start` 不会继承 manifest**：`plugin.toml` 里 `[plugin_runtime] auto_start = true` 对
install 后是否自动运行**没有影响**；每次安装都会写 `plugin_autostart_pending.json` 并记
`plugin <id> installed; it will not autostart until the user enables its auto-start switch`。
唯一的持久做法是 originless `PUT /plugin/{id}/auto-start {"auto_start":true}`（它会同时把该 id
从 pending 列表移除）。

---

## 8. 打包 / 安装流程（已验证可用的调用形状）

```powershell
# 1) 源放到用户插件根（root_id = user）
#    C:\Users\曦\AppData\Local\N.E.K.O\plugins\neko_theme_studio\
# 2) 构建（不要传 out；传 out 会被拒：out must be inside .neko-plugin-packages）
POST http://127.0.0.1:48916/plugin-cli/build
  {"mode":"single","plugin_ref":{"root_id":"user","directory_name":"neko_theme_studio"}}
  → 产出 C:\Users\曦\AppData\Local\N.E.K.O\.neko-plugin-packages\neko_theme_studio.neko-plugin
# 3) 删除暂存目录（必须在 build 之后、install-plan 之前）
#    否则 install-plan 报 action=blocked / reason=install_source_ownership_unknown，
#    install 返回 409 plugin package cannot be installed safely
# 4) 安装计划（断言 action == "install"）
POST http://127.0.0.1:48916/plugin-cli/install-plan  {"package":"<abs .neko-plugin 路径>"}
# 5) 安装
POST http://127.0.0.1:48916/plugin-cli/install
  {"package":"<上一步的 .neko-plugin 路径>","install_source":"imported","on_conflict":"fail"}
# 6) 重载（让插件立即生效，无需重启应用）
POST http://127.0.0.1:48916/plugins/reload  {}
# 7) 打开自动启动 + 启动（originless！见 §7b）
PUT  http://127.0.0.1:48916/plugin/neko_theme_studio/auto-start  {"auto_start":true}
POST http://127.0.0.1:48916/plugin/neko_theme_studio/start
```
- **`plugin_ref` 是单数**：用复数 `plugin_refs` 会报 422 `plugin_ref or plugin is required when mode=single`。
- **请求体必须用 UTF-8 字节发送**（路径含中文用户名 `曦`）；用 `Invoke-WebRequest -Body ([Text.Encoding]::UTF8.GetBytes($json))` 且 `ContentType "application/json; charset=utf-8"`。否则报 `package file not found: C:\Users\?\...`。
- **`plugin.toml` 不能带 BOM**：`Set-Content -Encoding UTF8` 在 PS 5.1 会写 BOM，导致 build 报 `failed to parse TOML file '...': Invalid statement (at line 1, column 1)`。必须用
  `[System.IO.File]::WriteAllText($p,$toml,(New-Object System.Text.UTF8Encoding($false)))`。
- 包格式（zip）：`manifest.toml` + `metadata.toml` + `payload\plugins\<id>\...` + `payload\profiles\` + `payload\dependencies.toml`。
- **没有 CLI 卸载端点**（`/plugin-cli/uninstall` 404、`/plugins/uninstall` 405）→ `uninstall.ps1` 只能清应用侧（模板去标记 + 删两个 static 文件），无法删插件本体。

### `-SkipPluginInstall`：从插件市场安装的场景

插件已由市场装好时，只跑应用侧补丁：
```powershell
pwsh -File install.ps1 -SkipPluginInstall     # 打模板补丁 + 复制两件套 + F7 启动插件
```
F7 与 G6 的「插件注册/静态路由/运行态」三项都刻意放在插件安装块**之外**，
因为市场装好的插件同样是 `stopped`，不启动则面板读/写都报 `NOT_READY`。
（F7 还必须容忍 `/plugins/reload` 之后的重启窗口，见 §9.11。）

插件安装完成后 `plugin.toml` 的 `[plugin_runtime] auto_start = true` **不会**让它自动运行：
实测 install + reload 之后仍是 `status=stopped auto_start=False`，
日志 `plugin <id> installed; it will not autostart until the user enables its auto-start switch`，
并写入 `plugin_autostart_pending.json`。唯一持久做法是 originless 调
`PUT /plugin/{id}/auto-start {"auto_start":true}`（会写进
`config\plugin_runtime_overrides.json` 并把它从 pending 数组移除），
但那**不会即时启动**已停止的插件，所以还必须 `POST /plugin/{id}/start`。

---

## 9. 安全边界（硬约束）

1. **只改颜色/背景/边框/圆角/字体/阴影**，绝不改 `display`/`position`/`width`/`height`/`flex`/`overflow`/`z-index`/`transform` 等布局属性。
2. 不覆盖 `--compact-*`、`--xy-*`。
3. 「未配置 = 视觉零变化」是硬不变量，且**由构造保证，不靠量测**：
   生成的 CSS **零回退值**，每条声明门控在 `data-nts-l-*` / `data-nts-d-*`（见 §3.0）。
   绝不要回到「把量测到的原生值烘焙成回退」的老路 —— 合成量测页无法复现真实页的
   计算值（§3.1 列了四类差异，每类都有实测反例）。
   同理**不要**为「只配一个模式」而给另一个模式补任何东西：两个模式各管各的。
3b. `tools/build-theme-css.ps1` 的 5 步里有两道**必须通过**的闸门：
   第 5/5 步的 `run-tests.ps1`（替代量测页里的零变化不变量 + 哨兵覆盖率，
   亮暗各须 `differing properties = 0`）与同一步末尾在真实 `/chat` 上的
   「装表/不装表」A/B（`test/expr-realab.js`，必须 `diffCount = 0`）。
   第 2/5 步的 A/B 现在**只作证据**：v3 没有回退值可否决。
   第 3/5 步的生成器若打印出任何 `fallback`，即为回归。
3c. 驱动真实页上的面板或含 `window.confirm()` 的流程时，必须用 CDP
   `Page.handleJavaScriptDialog` 自动应答；否则原生对话框会**阻塞页面**，
   `Runtime.evaluate` 永不返回，表现为一个看起来像死锁的超时
   （`page-eval.js` 默认 `--confirm accept`，`--confirm dismiss` 走取消路径）。
3d. 门控属性的名字在两侧必须逐字一致：`gen-css.js` 的 `gateAttrFor()` 与
   加载器 `app\neko-theme-studio.js` 的 `gateNameFor(varName, mode)`。
   曾经两边差一个 `nts` 层级（`data-nts-nts-x` vs `data-nts-x`），
   导致全部门控规则永不匹配、且**没有任何报错**。
   改动任一侧后，必须用 `tools/page-eval.js` + `test/expr-verify-v3.js` 在真实页复验。
4. install.ps1 必须幂等；uninstall.ps1 必须能完全还原（模板去标记、删两个 static 文件），
   且必须让「卸载」在重启后仍然有效：
   a) 写卸载标记 `%LOCALAPPDATA%\N.E.K.O\theme-studio-disabled`（可用 `NEKO_NTS_DISABLE_FILE` 覆盖），
      `_app_patch.ensure_app_patch` 见到标记就整体跳过自愈（kill-switch）；
   b) 尽力把插件的 `auto_start` 置 false 并 `stop`，避免重启后插件自己再注入；
   c) 安装成功后必须删除该标记（恢复自愈）——**删除动作要发生在 `/plugins/reload` 之前**，
      否则 reload 触发的插件 startup 因标记仍在而整体跳过，剩下的模板永远没有补丁（实测踩到）。
4b. install.ps1 重装必须**保留用户调色板**：安装前若已安装的 `static\theme.json` 与源出厂副本
   哈希不同，先备份为 `theme-studio\backup\user-theme.json`，装完写回；否则一次重装即清空用户颜色
   （旧版真实发生过）。
4c. 模板补丁分两阶段：先对**所有**目标模板做只读预检（BEGIN/END 配平、`</html>` 仍在、
   Jinja 哨兵仍在），任一失败就整体中止 —— 不允许出现「chat.html 已写、index.html 失败」
   导致 `/chat` 引用 404 的静态资源。写回用「临时文件 + File.Replace」原子替换。
5. 禁止动 `resources\app.asar`、禁止改 `projectneko_server.exe`。
6. 模板补丁前先备份到 `D:\tools\enokoo\theme-studio\backup\`。
7. **所有 `.ps1` 必须在 Windows PowerShell 5.1 下可跑**：含非 ASCII 字符的文件**必须带
   UTF-8 BOM**（否则报 `字符串缺少终止符`）；用 `edit` 工具改过之后要重新补 BOM：
   `[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($true)))`。
8. 验收必须用**真实浏览器量测计算样式**，且量测页最前面要加
   `<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>`
   —— 否则同步读样式时 transition 停在第 0 帧（=起始值），会产生大面积假失败。
9. HTML 的 inline `<script>` 里**绝不能出现闭合 script 序列**（即使写在 JS 注释里），
   否则整页脚本静默失效；用 `tools\check-inline.js` 自检。
10. **后端必须拒绝未知变量名**（`plugin\__init__.py` 的 `KNOWN_VARS`，63 个）。
    只做 `RE_VAR_NAME` 形态校验是不够的：拼错的 `--nts-nope-var` 会被照收、写进
    theme.json、回显为「已接受」，但没有任何规则消费它 → **报成功的静默空操作**。
    新增变量时必须三处同步：`test\targets.js`（目标）→ 跑 `tools/build-theme-css.ps1`
    （生成 CSS）→ 把新名字加进 `plugin\__init__.py` 的 `KNOWN_VARS` 与面板 CATALOG。
    核对命令（双向差集都必须为空）：把 `KNOWN_VARS` 的声明集与生成 CSS 里出现的
    全部 `--nts-*` 相交，另把面板 `app.js` 的 `key: '--nts-...'` 集与两者相交。
10b. **三处校验器必须对同一取值给出同一判定**：面板 `plugin/static/app.js` 的 `isSafeValue`、
     后端 `plugin/__init__.py` 的 `_is_safe_value`、loader `app/neko-theme-studio.js` 的 `isSafeValue`。
     三者只要有一处更宽或更窄，用户就会看到「面板说成功、后端落盘了、颜色没变」这类静默空操作。
     差分工具：`_local_verify/three_way.js`（配 `corpus.json` 边界语料；**该目录是开发机专用、不在交付包里**，
     新机器需按本节语料自建差分工具；本轮已把同类最小探针放进 `_probe/` 作为替代）。本轮实测 1903 cases
     （`loader_vs_backend.js` 2132 例），修前 191 例不一致（4 位 hex `#ffff`、`50%` 类百分比），修后应为 0。
     **不保留任何方向性差异**：loader 也曾额外放行 `var(--nts-*)` 派生色与负长度/负模糊，
     两者都已移除（派生色的坑：颜色变量指向长度变量时整条声明静默失效，且只有手改
     `theme.json` 才走得通；负数被浏览器丢声明 = 「面板成功、外观不变」）。
     **`--nts-shadow` 按 CSS 语法做结构校验**：`inset` ≤1、颜色 ≤1、长度 2–4 个、不接受百分比；
     只做 token 白名单会放行 `0 0 10% #000` / `1px` 这类浏览器整条丢弃的值，同样是静默空操作。
     要加新取值形态，必须三处一起加，并跑一遍差分工具。
10c. **百分比只在 number 类有意义**（`--nts-chat-opacity`，0–1 乘子）：`50%` 归一为 `"0.5"`，
     数值 >100% 三方皆拒。归一在 loader 的 `sanitizeVars` 与后端的 `_canonicalize_value` 各做一次，
     保证落盘与渲染口径一致。
10d. **值种类现在是八种**：`color` / `length` / `blur` / `shadow` / `font` / `number` /
     **`image`** / **`time`**。
     `image` 只有 `--nts-chat-bg-image` 一个成员（后端 `IMAGE_VARS`，`_value_kind()` 里**第一个**查它）。
     `number` 有**十个**成员：`--nts-chat-opacity`、`--nts-bubble-veil`、
`--nts-chat-bg-image-brightness`、`--nts-chat-top-fade`，以及光效段的六个乘子
`--nts-panel-glow-strength` / `-glow-pulse` / `-corner-glow` / `-edge-gradient` /
`-sheen` / `-inner-glow`（0–1 乘子，允许 `50%` 形态，
     后端 `_canonicalize_value()` 归一成小数）。
     它必须**绕开**通用黑名单的 `url(` 拦截（那条规则是给颜色值用的），改由 `RE_BG_URL` /
     `RE_BG_VALUE` 整串锚定，只放行字面量 `none` 或指向本插件 `backgrounds/` 的绝对 URL。
     加新的 `image` 类变量时，三处（后端 `IMAGE_VARS`、加载器 `NON_COLOR_VARS`、面板 `CATALOG`
     的 `type: 'image'`）必须同时加，并在 `test/targets.js` 登记消费目标；
     漏一处的后果是静默空操作（面板报成功、应用侧丢弃，或后端收下但样式表无人消费）。
     注意 `background-image` **不进** `GATE_DECL` 逐条表 —— 它必须与 `background-size: cover` /
     `background-position` / `background-repeat` 四条一起写才成立，由 `tools/gen-css.js` 专门段落输出。
10e. **`number` 类放行零填充写法，长度类在面板侧补单位**（v0.1.6）：
     `1` / `1.0` / `1.00` 三者等价合法（`1.5` / `2` / `-0.3` 拒绝）。三份 `RE_NUMBER` ——
     后端 `theme-studio\plugin\__init__.py`、加载器 `static/loader/neko-theme-studio.js`、
     面板 `static/app.js` —— 必须同时改，漏一处就会出现「面板收下、加载器丢弃」的静默空操作。
     另外面板多一层**输入归一化** `normalizeTypedValue(item, raw)`：值是纯数字时，
     `length` 行追加 `px`（敲 `16` 按 `16px` 走）、`blur` 行补成 `blur(Npx)`（敲 `7` 按
     `blur(7px)` 走），并在 `change` 时把输入框显示成归一化后的形态；
     这只发生在面板，后端与加载器的 `RE_LENGTH` 仍要求带单位（API 契约不变，手改
     `theme.json` 或走 JSON 导入仍须写完整形态）。负值照旧全部拒绝。

10f. **`time` 值种类**（v0.1.10，光效那一轮引入）：目前只有
     `--nts-panel-glow-speed` 一个成员（呼吸周期）。
     - 合法形态：`3s` / `800ms` / `0.5s` / `0`；**裸数字按秒**并在
       `_canonicalize_value()` 里补成 `3s`（`animation-duration: 3` 是非法 CSS，
       不补单位整条 `animation` 声明会被浏览器丢弃 —— 那是「设了节奏设不上去」的真正原因）。
     - 上限 60 秒（`TIME_MAX_SECONDS`），`9999` 被拒。
     - 三处同源：后端 `TIME_VARS` + `RE_TIME`/`RE_TIME_BARE`、
       加载器 `NON_COLOR_VARS` 的 `'time'` + `sanitizeVars` 补单位、
       面板 `CATALOG` 的 `type: 'time'`（显示名「节奏」）+ `normalizeTypedValue` 补 `s`。
     - 与 `number` 的关键区别：`time` 的裸数字**补单位**，`number` 的裸数字直接用；
       两者都不能漏掉 `sanitizeVars` 那一步，否则加载器会把值丢掉而 `apply_theme` 照样报成功。

10g. **光效/玻璃的门控是 OR，不是 AND**（v0.1.10）：外发光的触发变量是
     `--nts-panel-glow-color` / `-glow-strength` / `-glow-size` 三者**任一**，
     由 `tools/gen-css.js` 的 `orRule(mode, triggers, target, decls)` 为每个触发变量
     各输出一份规则（CSS 选择器没有 OR）。规则里的 `var(--nts-…, <默认>)` 用的是
     **设计默认**（强度 `1`、尺寸 `24px`），不是测量到的原生值 —— 后者才是 §3.0 明令禁止的
     fallback。空调色板下这些 `data-nts-*` 属性一个都不存在，所有候选选择器都不匹配，
     零改动不变量照旧成立（`run-tests.ps1` 第 (1) 项 0 差异）。
     为什么必须这样：做成 AND 之后，用户只改「光晕颜色」——最自然的第一步——会看到
     面板报成功、界面上 0 像素变化，正是本项目反复出现的「改了没反应」投诉。
     辅助属性同理：`box-shadow` / `background-image` 不能拆成多条分别门控（后写者整体
     覆盖前者），必须用中间自定义属性（`--nts-panel-corner-bg` / `-sheen-bg` /
      `-edge-shadow` / `-inner-shadow`）解耦，最后由一条合成规则读
     `var(--x, <合法零值>), var(--y, <合法零值>)`。

10h. **加一个新变量要动的四处**（少一处就静默失效）：面板上能看到、能填、点「应用」
还返回 `succeeded`，但屏幕上毫无变化 —— 这类症状几乎全部来自下面某处没登记，四处互不
代劳。

| # | 位置 | 作用 | 漏了会怎样 |
| --- | --- | --- | --- |
| 1 | `theme-studio/plugin/__init__.py` 的 `KNOWN_VARS` | 名字白名单 | `rejected: 未知变量名已拒绝` |
| 2 | 同文件的**值种类集合**（`LENGTH_VARS` / `BLUR_VARS` / `SHADOW_VARS` / `FONT_VARS` / `NUMBER_VARS` / `TIME_VARS` / `IMAGE_VARS` / `GLOW_*`） | 决定值怎么校验 | 回落成 `color`，合法值被当颜色拒收 |
| 3 | `theme-studio/plugin/static/loader/neko-theme-studio.js` 的 `NON_COLOR_VARS` | 决定窗口里怎么写门控属性 | 变量被静默丢弃，门控永不设置 |
| 4 | `theme-studio/plugin/static/app.js` 的 `CATALOG` | 面板上的行 | 面板根本没有这一行 |

第 2 项最容易漏，因为它不是「有没有这个名字」而是「这个名字属于哪一种」：
`BLUR_VARS` 原本只有 `--nts-chat-blur` 一个成员，加 `--nts-panel-glass-blur` 时只登记了
第 1 / 3 / 4 处，`blur(14px)` 就被当颜色整条拒收，而 `apply_theme` 仍返回 `succeeded`
（只是 `rejected` 里多一行）。判定方法：`_value_kind()` 从上到下依次 `return`，**新的
分类必须排在默认 `"color"` 之前**。改完 `__init__.py` 必须
`POST /plugin/neko_theme_studio/stop` + `/start`（`POST /plugins/refresh` 不重载 Python
模块），否则跑的还是旧的分类表。

10i. **伪元素必须先有 `content`，否则整条规则不存在；画在容器上的装饰还要让开容器
自己的遮罩带。** 两条都是「computed 全对、像素上没有」的类型。

(a) 没有 `content` 的 `::before` / `::after` 浏览器**不会生成**，该伪元素上的
`border` / `background-image` / `box-shadow` 全部作废。生成器最初给
`anchor::after` 只输出这三样，于是「半透明描边 / 四角高光 / 玻璃反射 / 内阴影」
四组规则一直是死的 —— 而 `getComputedStyle(el, '::after')` 照样如实报出
`border: 6px solid rgb(0, 255, 0)`、四层渐变和内阴影。把描边设成 6px 纯绿做像素取证，
整屏 **0 个绿像素**才暴露。修好后必须把结构声明 `concat` 进**每一组**伪元素规则
（本项目用 `AFTER_STRUCT`），不能只在第一组写一次 —— 同一伪元素的多条规则是分别
生效的，任一条缺 `content` 的那组声明就是死的。

判定口径：**伪元素类效果一律以像素为准，`getComputedStyle` 只能当作「声明有没有
被解析」的旁证。** 这和外发光被 mask 裁掉只渗出 4 像素是同一类陷阱。

(b) 应用的 `.compact-export-history-scroll` 带
`mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)`，
所以「面板肉眼可见的顶边」比容器盒顶边低 28px。画在祖先 `anchor` 上的伪元素不受这条
mask 影响，贴盒子顶边就会浮出一圈没有底板支撑的弧线（用户报「最上面比面板高出一截」）。
正确处理是把两个伪元素的 `top` 一起下推、并与用户可调的变量联动：

```css
top: calc(28px * var(--nts-chat-top-fade, 1)) !important;
```

只动 `top`，`left/right/bottom` 保持 0，底部与左右不会错位。**不要改成给伪元素套同一条
mask**：mask 的绘制区就是边框盒，装不进外发光，外溢部分被整块裁掉（实测整屏光晕归零）。

11. `install.ps1` 的 F7 启动步骤**必须容忍插件服务的重启窗口**：F5 的 `/plugins/reload`
    会重启插件服务，在这段窗口内 `POST /plugin/<id>/start` 会被拒绝为
    `HTTP 409 {"detail":"Server is shutting down; plugin start rejected"}`。
    这不是插件故障 —— F7 必须先轮询 `GET /plugins` 直到能取到插件状态（= 服务 ready），
    再启动，并把 409 + `shutting down` 当作「还没起来」重试而不是失败。
    （实测踩到过：F7 报红色 warning 且 G6 的「运行态」一项 FAIL，重跑就绿 —— 竞态。）
12. **自建验收套件与它自己的量测页共享盲区**。本项目两轮「全绿」都被独立验证者推翻
    （第一轮 16/16、第二轮 36/36，都漏掉了真实页上的缺陷）。派一名**对抗性验证者**，
    明确要求：自己从活服务取证、不采信仓库里任何「断言式」文档、优先写自己的探针、
    并给出最小复现的反例清单。验证者的价值恰恰在于它不共享你的量测方法。

### 12b. `repair_app` 的诊断字段（面板「安装自检」卡片的输入）

`repair_app` 既是一键修复也是自检入口，返回：

```
ok                 bool     not missing_required and not assets_failed
app_root           str|None 定位到的 N.E.K.O 安装根（判据：resources/bin/templates 存在）
search_paths       list     定位失败时逐个试过的候选目录
platform           str      sys.platform
platform_note      str|None 已知不支持平台的说明（macOS .app / Linux AppImage 等）
disabled           bool     检测到卸载标记，自愈被跳过
assets_written     list     本次写入的应用侧资源名
assets_unchanged   list     内容已是最新、未改写的资源名
assets_failed      list     写入失败（多为权限）——这就是看不到效果的直接原因
templates_patched  list     本次注入/更新的模板名
templates_unchanged list    标记已是最新的模板名
templates_skipped  list     没有锚点或不是 UTF-8 而跳过的模板名
missing_required   list     必备模板缺失（index.html / chat.html）
autostart          str      ok | scheduled | pending | failed | unknown
warnings           list     原始告警文本
plugin_root        str     插件根目录
```

约定：
- 任何写入失败**只进 warnings / assets_failed，不抛异常**，`startup` 仍然成功 —— 因此界面必须显示这张卡片，
  否则失败在用户侧完全不可见。
- `search_paths` 只在 `app_root` 为空时有意义，是排查换机问题的第一手资料。
- 定位顺序：`NEKO_APP_ROOT` → 插件进程可执行文件上溯 → 父进程可执行文件上溯 → 系统进程里名字含
  `neko` / `projectneko` 的可执行文件上溯。
