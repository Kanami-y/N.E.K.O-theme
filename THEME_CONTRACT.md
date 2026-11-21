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

### 12d. 命名颜色的白名单必须在三处逐字一致（v0.1.10 补 `transparent`）

值种类与命名色是两份独立的表：**后端 `RE_KEYWORD_COLOR` / loader `COLOR_NAMES` / 面板
`COLOR_NAMES`**。`transparent` 在后端从第一版就在，loader 与面板却一直没有 —— 于是
「把背景设成透明」这条最普通的操作在这两层被静默丢弃（`apply_theme` 照样 succeeded，
门控不生成，CSS 永远不匹配），排查看起来像「CSS 写错了」。

判定方法：把值直接喂给 `window.NekoThemeStudio._internals.isSafeValue(key, value)`
（loader 的判定入口），以及面板的 `isSafeValue(key, value)`，两边都必须为 `true`。
后端可以用一次 `apply_theme` 的 `rejected` 字段验证。

现在的三份白名单都以 `transparent aliceblue …` 开头（148 个 CSS 命名色 + `transparent`
+ `currentcolor` = 150 项），`inherit` / `initial` / `unset` / `revert` 仍然**刻意拒收**。

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

## 3B. 高级材质契约（`materials` 子树，v0.15.0 起）

颜色变量（§3）描述的是「什么颜色」，材质子树描述的是「什么玻璃」。两层互不替代：
一个变量都不配、只开材质，也能得到一套完整的液态玻璃外观；反过来，只有颜色没有材质
就是 v0.14.x 的行为。**材质不写进 `vars` / `dark_vars`**，两者是并行子树。

### 3B.0 位置与写入语义

`theme.json` 顶层多一个 `materials` 对象（与 `vars` / `dark_vars` / `name` / `enabled` 同级）：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | int | `1` | 结构版本，目前只有 1 |
| `enabled` | bool | `false` | 关闭时整层惰性：不编译变量、不打属性、不动应用样式 |
| `preset` | str | `custom` | 六套内置预设 id，或 `custom`（表示手调过） |
| `quality` | str | `balanced` | `saver` / `balanced` / `high` / `ultra` |
| `global` | map | 13 个参数 | 基础材质：透明度 / 染色 / 模糊 / 饱和度 / 亮度 / 层级 |
| `lighting` | map | 28 个参数 | 边缘光 / 内部高光 / 环境反射 / 动态光照 |
| `refraction` | map | 17 个参数 | 折射与色散 |
| `surface` | map | 18 个参数 | 噪点 / 圆角 / 边框 / 阴影 |
| `animation` | map | 14 个参数 | 开关 / 时长 / 交互反馈（悬停、点击、展开、追光） |
| `dark` | map | `{}` | 暗色覆盖：`{ section: { key: value } }`，**只存显式键** |
| `components` | map | `{}` | 十类组件的独立材质：`{ compId: {...} }` |
| `custom_presets` | map | `{}` | 用户自定义预设（预留，面板暂未写入） |

**写入语义是整份替换，不是按键合并。** `apply_theme({materials: X})` 会用 `normalize_materials(X)`
的结果覆盖整份 `materials`。理由是两种语义会撞车：用户把某参数「改回默认值」时，合并语义
看到的是「这个键没传」而保留旧值，用户会以为滑块坏了。整份替换下，缺失键一律回默认，行为可预测。

不传 `materials`（`None`）时**不动磁盘上的材质** —— 只改颜色/主题名的提交不会顺手把材质清空。
传了非对象的 `materials`（字符串、数组等）会被拒绝并计入 `errors`，与 `vars` 的拒绝口径一致。

### 3B.1 90 个参数

参数表唯一来源是 `plugin/materials.py` 的 `_RAW_PARAMS`，`Param(key, section, kind, default, minimum,
maximum, choices, label)`。

| 分节 | 参数数 | 内容 |
| --- | --- | --- |
| `global` | 13 | 透明度 / 底色 / 染色强度 / 模糊半径 / 模糊层级 / 饱和度 / 亮度 / 染色主辅色 / 色彩浓度 / 冷暖 / 颜色透明度 / 渐变强度 |
| `lighting` | 28 | 边缘光 9（强度/宽度/透明度/颜色/上下左右/渐隐）、内部高光 6、环境反射 6、动态光照 7 |
| `refraction` | 17 | 折射 6、色散 5 |
| `surface` | 18 | 噪点 5、圆角 5、边框 2、阴影 6 |
| `animation` | 14 | 开关 3、时长 5、交互反馈 6 |

值种类（`kind`）分布：`number` 34、`px` 19、`percent` 14、`bool` 9、`ms` 6、`color` 5、
`enum` 2（`blurLevel` / `easing`）、`deg` 1。

归一化规则（`normalize_materials`，**钳制而不是拒绝** —— 手改 theme.json 的越界值不能让整份主题读不出来）：

- 数值越界 → 收到 `[min, max]` 并记一条 warning；非数值 → 回默认值 + warning；
- 颜色只接受 `#rgb` / `#rrggbb` / `rgb()` / `rgba()`，其余回默认值 + warning；
- `enum` 不在 `choices` 里 → 回默认值；`bool` 接受 `true/false/1/0/on/off`；
- 未知的 section / 参数键直接丢弃；缺失的键一律补默认值。

**每一套预设都必须铺满五节全部 90 个参数**（`test_materials.py` 锁住）。只覆盖几个键的预设会
让「切换预设」变成「部分生效」，用户看到的是无规律的残留旧值。

### 3B.2 编译产物：126 个变量

`compile_materials(materials)` 返回 `(light_vars, dark_vars)`，各 126 个变量：

- **90 个参数变量**：`--nts-mt-` + 参数 key 的 kebab-case，例如 `opacity` → `--nts-mt-opacity`、
  （`dyeWarmth` 等少数参数不单列变量，直接改进复合变量，见下）；
- **19 个复合变量**（由多个参数合成，必须整体产出）：`--nts-mt-bg`、`--nts-mt-dye`、
  `--nts-mt-ambient`、`--nts-mt-inner`、`--nts-mt-inner2`、`--nts-mt-edge`、
  `--nts-mt-edge-t`、`--nts-mt-edge-b`、`--nts-mt-edge-l`、`--nts-mt-edge-r`、
  `--nts-mt-border`、`--nts-mt-shadow`、`--nts-mt-inset`、`--nts-mt-refract-tint`、
  `--nts-mt-disp`、`--nts-mt-liquid-alpha`、`--nts-mt-anim`、`--nts-mt-noise-img`、
  `--nts-mt-spot`。
- **17 个光学派生变量**（0.15.1 起，把「边缘光 / 内部高光 / 环境反射 / 折射」从一组数字
  变成 CSS 真能吃的光学层）：`--nts-mt-sheen`、`--nts-mt-sheen-img`、`--nts-mt-heel`、
  `--nts-mt-inner-img`、`--nts-mt-ambient-img`、`--nts-mt-ambient-size`、
  `--nts-mt-drift-size`、`--nts-mt-lens`、`--nts-mt-lens-blur`、`--nts-mt-lens-glow`、
  `--nts-mt-refract-size`、`--nts-mt-disp-blur`，以及 0.15.13 起的 `--nts-mt-rim-img`、
  `--nts-mt-rim-shade`、`--nts-mt-disp-warm`、`--nts-mt-disp-cool`、`--nts-mt-under-glow`。
- **`--nts-mt-light-angle`** 不是编译产物，而是加载器按指针位置现算写入的运行时变量
  （`atan2`，默认 162deg）——它让 `--nts-mt-sheen-img` 的渐变角度跟着指针转。

**每个参数都必须有消费者**（0.15.29 起的硬约束）：改一个参数，至少有一个被加载器
`var()` 引用、或经 `getComputedStyle().getPropertyValue()` 读取的变量要跟着变。
只写进 `theme.json`、CSS 从不引用的参数等于假开关 —— 用户拖了没反应，比没有滑块更糟。
查法：`theme-studio/_work/audit_param_sensitivity.py` 逐参数改值、比对「被消费变量集合」；
`_work/diag_dead_params.py` 打印全量 diff 与源码行，用来区分真死与误报
（`spotRadius` 经 `calc()` 字面量生效、`mouseFollow` 经 `getPropertyValue` 读取都属误报）。

第二类假开关是**分辨率被砍掉**：参数能存能读、也有消费者，但编译时被折成 2-5 档，
中间值拖了没区别（`liquidSmooth` 曾只有 `linear` / `ease-in-out` / `ease` 三档）。
凡是 0-100 的连续滑块，编译产物必须是连续量（数值直接乘、或用连续插值出 `cubic-bezier`），
不能映射成枚举。

因此少数参数不单独出变量，而是直接改进复合变量：`dyeWarmth` 混 `--nts-mt-dye` 的两个色标、
`liquidStrength` 乘进 `--nts-mt-dye` 的 alpha、`innerDouble` 决定 `--nts-mt-inner2` 是渐变还是 `none`、
`dispAlpha` 计入 `--nts-mt-disp-warm` / `--nts-mt-disp-cool` 的透明度。

编译**不看 `enabled`**（这是纯函数）；是否把变量交给应用由 `_with_material_vars` 决定。

组件级覆盖在 `components[comp].mode` 为 `preset` / `custom` 时额外产出 5 个变量，统一带
`c-` 前缀：`--nts-mt-c-bg-{comp}`、`--nts-mt-c-blur-{comp}`、`--nts-mt-c-radius-{comp}`、
`--nts-mt-c-border-width-{comp}`、`--nts-mt-c-shadow-{comp}`。只开放这 5 个通用参数，避免
组件级覆盖把全局材质改乱。

`c-` 前缀不是洁癖，是修 bug留下的约束（0.15.4）：

1. **撞名**：全局参数 `radiusButton` / `radiusInput` / `radiusDialog` 的变量名恰好是
   `--nts-mt-radius-button` 这类形态，与组件 `button` / `input` / `dialog` 的组件变量同名。
   加载器里一旦写成 `var(--nts-mt-radius-dialog, var(--nts-mt-radius-dialog))`，回退值指向
   自己，整条 `border-radius` 声明无效 —— 组件圆角与全局圆角双输。
2. **复合语义**：组件透明度不是一个裸数字，而是 `rgba(tint, opacity × tintStrength)`
   （`--nts-mt-c-bg-{comp}`）；组件阴影强度是一个完整 shorthand（`--nts-mt-c-shadow-{comp}`，
   `strength ≤ 0.001` 时为 `none`）。旧命名 `--nts-mt-shadow-strength-{comp}` 产出的值
   CSS 从未消费，20 个变量全是死键。

#### 多层声明里禁止出现裸 `none`（0.15.58 起）

`background-image` 与 `box-shadow` 都是逗号分隔的多层声明，**任何一层非法，整条声明归零** ——
浏览器既不保留合法的那几层，也不报错。两处真实事故：

| 症状 | 非法值 | 原因 |
| --- | --- | --- |
| 九层背景全丢（computed `none`） | `radial-gradient(circle 68.8% at …)` | `circle` 的尺寸只接受长度，百分比只对 `ellipse` 合法 |
| 十四段阴影全丢（computed `none`） | `--nts-mt-inset = none` 拼进 `box-shadow` | `none` 不是合法的阴影层 |

规则：

1. 进入 `background-image` 的层可以是 `none`（合法），进入 `box-shadow` 的层**不能**是 `none`；
   「不加阴影」用 `0 0 0 rgba(0, 0, 0, 0)` / `inset 0 0 0 rgba(0, 0, 0, 0)` 表达。
2. `circle` 只能跟长度（`circle 240px`）；要百分比尺寸就用 `ellipse X% Y%`。
3. 新增任何多层变量都要过 `_work/audit_bg_layers.py`（selfcheck 门控 `bg-layer-legal`）。
4. 排障顺序：先看 computed `background-image` / `box-shadow` 是否为 `none`；
   变量采样都正常而计算值是 `none`，就一定是某层语法非法，不是变量没值。

### 3B.3 画质档位真的降级

| 档位 | 处理 |
| --- | --- |
| `saver` | 模糊半径减半（`--nts-mt-blur` / `--nts-mt-refract-blur` / `--nts-mt-ambient-blur`，组件级 `--nts-mt-c-blur-*` 同样减半）、阴影模糊 ×0.7、色散置透明、动态光照 / 环境反射 / 液态 / 噪点 / 追光全部关掉；**并且把装饰性多层渐变直接置 `none`**（`--nts-mt-inner-img` / `--nts-mt-sheen-img` / `--nts-mt-noise-img` / `--nts-mt-ambient-img` / `--nts-mt-spot`），玻璃表面从 7 层合成降到 2 层（底色 + 染色） |
| `balanced` | 原样（默认） |
| `high` | 边缘光 / 内部高光 / 环境反射的 alpha ×1.15、阴影模糊 ×0.85 |
| `ultra` | 边缘光 / 内部高光 / 环境反射的 alpha ×1.3、主模糊 / 折射模糊 / 色散模糊 ×1.15（组件级 `--nts-mt-c-blur-*` 同样 ×1.15）、阴影模糊 ×1.15 |

「置透明」和「置 none」不是一回事：前者仍然参与图层合成（只是画了看不见），后者真的不画。
省电模式的目标是后者 —— 0.15.11 之前只做到了把变量调弱，滚动省电效果有限。

**四档必须两两不同**：0.15.28 之前 `ultra` 与 `balanced` 编译结果完全一致（`ultra` 分支是空注释），
四档画质里有两档是同一个东西，用户切了没反应。现在 `ultra` 在光强与模糊上强于 `high`、
`high` 强于 `balanced`、`saver` 弱于 `balanced`，由 `test_quality_tiers_are_distinct` 逐对断言。
**saver 还多一条加载器侧降级（0.15.32）**：高频小元素 —— 气泡（user/assistant/tool/system）、
`compact-export-history-bubble`、`composer-input-shell`、`composer-panel`、`message-list`、
`window-topbar`、两个 popover —— 在 `[data-nts-mt-quality="saver"]` 下**根本不声明**
`backdrop-filter`（不是 `blur(0px)`）。理由：气泡背后就是同样半透明的窗口底，模糊前后几乎看不出差别，
但一屏二十个气泡就是二十层背景模糊。大面（聊天窗、模态、插件视图、设置窗口）保留模糊。
这条是 `MATERIAL_CSS` 里的属性选择器规则（特异性 `0,6,1`），不改编译产物。
**组件自定义阴影跟着档位走（0.15.33）**：`--nts-mt-c-shadow-<comp>` 是 shorthand（`0 8px 24px 0px rgba(...)`），
没有独立 blur 变量，所以画质档由 `_scale_shadow_blur()` 把第 3 个长度值直接缩放：
`saver` ×0.7、`ultra` ×1.15，与全局 `--nts-mt-shadow-blur` 保持同一比例。`none` 与非本项目产出的形态原样保留。

### 3B.4 门控与惰性（与 §3.0 同一形态）

材质变量写进**同一张** `<style>`，门控形态与颜色完全一致、**零回退值**：

```css
:root:not([data-theme="dark"])[data-nts-l-<var>]:root:root body <SEL> { prop: var(--nts-mt-<var>) !important }
:root[data-theme="dark"][data-nts-d-<var>]:root:root body <SEL> { prop: var(--nts-mt-<var>) !important }
```

`<html>` 上按需打三个属性：`data-nts-mt="1"`、`data-nts-mt-quality="<档位>"`、
`data-nts-mt-preset="<预设>"`。三者由 `material_attrs` 提供、由加载器 `syncMaterialAttrs` 落地：

- 材质未启用 / 没有变量 → 三个属性全部撤掉，`data-nts-mt` 缺席时材质层 CSS **一条规则都不命中**；
- 关闭插件、切到另一套主题、`removeStyle()` 也会走同一条撤属性路径。

#### 3B.4b 系统减弱动效（`prefers-reduced-motion`）

材质层的漂移 / 进入 / 展开动画各有一条声明，`@media (prefers-reduced-motion: reduce)` 段必须**逐个覆盖同一组选择器**：

| 动画 | 声明段选择器 | reduced-motion 段 |
| --- | --- | --- |
| 漂移 `nts-mt-drift` | `.compact-chat-surface-frame`、`.chat-window` | 同 |
| 进入 `nts-mt-enter` | `.message-bubble-user`、`.message-bubble-assistant` | 同 |
| 展开 `nts-mt-expand` | `.composer-overflow-popover`、`.composer-overflow-menu`、`.composer-icon-popover`、`.modal-dialog` | 同 |

0.15.45 之前漏了 `.chat-window` 与 `.composer-overflow-menu`，表现为「系统已要求减弱动效，主窗还在慢飘」。`materials-selftest.js` 有三条断言锁死这三组集合。
### 3B.5 新增 entry

| entry | 输入 | 输出 |
| --- | --- | --- |
| `material_spec` | 无 | `version` / `params[]`（key,section,kind,default,min,max,choices,label,var）/ `sections` / `components` / `component_params` / `quality` / `presets`（7 项：6 内置 + custom，每项含完整 params）/ `preset_labels` / `easings` / `blur_levels` / `current` |
| `preview_materials` | `materials`（可选）/ `mode`（light/dark） | `mode` / `vars`（按 mode）/ `light` / `dark` / `attrs` / `warnings` / `materials` |

`preview_materials` **不看 `enabled`**：预览的意义就是「还没启用也要能看到效果」。
面板的实时预览只能调它，**不准在前端重写一遍 `compile_materials`** —— 两套编译逻辑
必然漂移，现象是「预览好看、应用后不一样」，且排查时两边都自称正确。

`get_theme` / `apply_theme` / `reset_theme` / `import_theme` 的返回值额外带两个编译
字段：`material_vars: {light, dark}` 与 `material_attrs`。`enabled=false` 时两者都是空，
面板不需要自己判断。

**磁盘上另存一份镜像**（v0.15.1）：`_write_unlocked` 会经 `_with_material_cache` 把同一份
编译结果写进 `theme.json`。原因是加载器读的是 `/plugin/<id>/ui/theme.json` —— 那是宿主
直读磁盘文件的静态路由，**不经过任何 entry**。只把编译结果挂在 entry 返回值上，应用窗口
永远拿不到材质（真机诊断 `mt_vars=0` 就是这么来的，材质看着"配好了"，窗口里一点变化都
没有）。读侧不信任这份镜像：`_normalize` 只认 `materials`，读进来重算一遍，磁盘那份被丢弃。
所以「`materials` 是唯一事实来源」不变 —— 镜像只是静态路由的投影，不会变成第二份真相。

### 3B.6 三条分享链路都带材质

| 链路 | 携带条件 |
| --- | --- |
| 分享包 zip（`_build_archive`） | `enabled=true` 时写入 `theme.json` 的 `materials` |
| 主题仓库条目（`_save_library_item`） | 始终保存 `materials`（用户随时可能再启用） |
| 复制 JSON 文本（`theme_json`） | `enabled=true` 时带上；未启用不带（避免贴一大坨默认值） |
| 导入时的空内容判据 | 只有 `vars` 与 `dark_vars` 都为空**且**包内 `materials.enabled` 为真才放行（只调材质的主题必须能导回来）；带了颜色却全被拒仍拒绝，否则一次误导入就清空调色板（0.15.39） |
| 复制整份主题（`export_theme`） | 只导事实字段：先 `_normalize` 再序列化，派生镜像（`material_vars` / `material_attrs` / `material_compile_version`）一律不导出（0.15.38） |

未启用的材质不随包分享，但仓库条目保留 —— 两者的区别是「分享给别人」vs「自己以后再用」。
导入时：老包没有 `materials` → **保持用户当前材质不动**，不要顺手清成默认。

**保真已验证（2026-11-21 真机，`_work/probe_export_fidelity.py`）**：构造 `components.chat` 自定义 +
`dark.global.opacity=0.91` + 一个自定义预设后导出，包内 `theme.json` 的 `materials` 三项都在
（`FIDELITY components/dark/custom = True True True`）。只验证「打包不丢字段」，不导入 —— 导入会
污染用户仓库。

**仓库条目切换是合并语义（2026-11-21 真机，`_work/probe_library_merge.py`）**：用户库里有自己的预设 B，
条目自带预设 A，`apply_saved_theme` 之后两个都在（`保留用户预设 = True | 带入条目预设 = True`），
`components` 用条目的值。0.15.10 之前这里会把条目 materials 整份塞进 `theme.json`，等于清空用户预设库。

**内置预设的背景图必须走重写再校验（2026-11-21，`_work/audit_builtin_presets.py`）**：
`plugin/static/presets/*.json` 里背景图写的是可移植的 `url("images/<hash>.jpg")`，
而 `_validate_palette` 只接受指向本机 `backgrounds/` 的绝对地址（`RE_BG_URL`）。
真实路径是 `_preset_items()` 先调 `_rewrite_archive_refs(raw, {}, label=..., from_presets=True)`
把引用改写成本机地址（图来自 `presets/images/`，落盘到 `backgrounds/`）再校验 ——
**直接拿原始 JSON 调 `_validate_palette` 会把 3 套带图预设（starry-meow / yui-ice-moon / yui-ice）
误判成非法**。已用真机 `list_themes` 固化口径：内置 35 套、`has_image` 恰 3 套、
每套 light/dark 变量数都 > 0（92 / 88 / 77），`_work/audit_builtin_presets.py` 是这道门控。

**自定义预设的命名契约（0.15.49 起）**：`save_material_preset` 的 `name` 先 `strip()`，空名报错；
超过 40 个字符**显式拒绝**（`预设名最多 40 个字符（当前 N）。`），不允许再静默 `[:40]` ——
截断会让「41 个字」和「截断后的 40 个字」撞成同一个 `custom_presets` 键，后存的覆盖先存的。
面板 `#mt-preset-name` 带 `maxlength=40`，正常路径碰不到后端这条报错；与内置预设同名（大小写不敏感）
同样拒绝（0.15.44），否则 `apply_materials` 先判 `PRESETS`，那条自定义预设永远选不中（死预设）。
运行期门控：`_work/probe_preset_api_edge.py --readonly`（空名 / 超长 / 删不存在，三条都不写盘）。

#### 用户主题的简介（0.15.71 起）

内置主题一直有 `note` / `tags`（卡片上显示一行说明、可按标签筛选），但用户自己做的主题
只能「先保存 → 再点卡片上的『编辑』→ 再填备注」——绕三层才知道入口在哪，分享出去的包
也常常是一条没有出处的匿名配色。0.15.71 起简介是一等公民：

| 环节 | 契约 |
| --- | --- |
| 保存 | `save_theme` 的 `input_schema` 接受 `note`（≤120 字）与 `tags`（≤4 个、每个 ≤12 字），面板保存区第二行 `#lib-note` 直接提交 |
| 存储 | 仍走 `_theme_note` / `_theme_tags` 同一套口径：`note` 截 120、`tags` 取前 4 个各截 12；**超长截断不报错**（与内置主题一致，不制造保存失败） |
| 返回 | `_theme_summary` 带 `note` / `tags`（否则「存完卡片上没有刚写的简介」，列表刷新前那一帧是空的） |
| 分享包 zip | `_build_archive` 写进 `theme.json`；导入时 `_save_library_item(note=..., tags=...)` 原样落库 |
| 复制 JSON | `theme_json` 带 `note` / `tags`（贴文本分享也要有出处） |
| 编辑 | 卡片「编辑」→ `update_theme_meta` 可改可清（清空 = 传空串），id 不变 |
| 空简介 | 自定义条目没写简介时卡片显示「没有简介 · 点『编辑』写一句，分享时会一起带走」，内置主题不显示（它们的 note 由包作者写） |

门控：`theme-studio/plugin/tests/test_theme_note.py`（8 例：保存落盘 / 超长截断 / 不写 note 时不产生键 /
导出包携带 / 导入恢复 / 面板三个接线点），外加 `test/materials-selftest.js` 的 9 条静态断言。

### 3B.7 面板接线（三条，断一条就表现为「改了不生效」）

1. `app.js` 暴露 `window.NekoPanel = { call, toast }`（材质中心调 entry 的唯一通道）；
2. `applyTheme` 里 `if (window.NekoMaterials.isDirty()) args.materials = snapshot()` ——
   **只有真改过才提交**，否则抽屉里没碰材质就点应用，会把磁盘材质覆盖成面板里的旧副本；
3. `reloadPalette` 成功后调 `syncMaterials(palette)` —— 导入 / 重置 / 应用之后，材质中心的
   「已保存」基线必须跟着磁盘刷新，否则它永远显示「N 项待应用」。

10 个导航界面的参数覆盖由 `test/materials-selftest.js` 静态锁定：`GROUPS` 里的 key 集合
必须与 `materials.py` 的 90 个参数**完全相等**（少一个 = 某滑块没渲染，多一个 = 拖了没反应）。

预览壁纸必须可切深/浅（0.15.16 起）：`#mt-pv` 的 `data-bg` 为 `dark` 或 `light`，
由标题栏按钮 `#mt-pv-bg` 切换，初始跟随编辑模式、用户手动切过后不再自动变。
理由：同一块玻璃在深色壁纸上是白高光、在浅色界面上是高光被压平，只给一种背景，
用户就无法验收「亮色主题下还看不看得清」。浅色壁纸下正文 / 条纹 / 标签必须换深色，
否则预览里会出现浅背景配白字这种应用里不会出现的读不清。

预览的叠层必须与应用窗口同序且不缺层（0.15.17 起）：卡面依次铺
`--nts-mt-rim-img` → `--nts-mt-sheen-img` → `--nts-mt-spot` → `--nts-mt-refract-tint`，
另有兄弟层承担 `--nts-mt-inner-img` / `--nts-mt-ambient-img` / `--nts-mt-noise-img`，
`--nts-mt-dye` 由 `::before` 铺。少铺哪一层，那一组参数在预览里就是「拖了没反应」，
而应用窗口里其实是生效的 —— 这比预览不好看更糟，它会让用户以为功能坏了。

`box-shadow` 侧同样要对齐：四边描边（`--nts-mt-edge-t/-b/-l/-r`）、液态折射
（`--nts-mt-liquid-amp`）、悬停白环（`--nts-mt-hover`）与按压内阴影
（`--nts-mt-press`）都必须能在预览里看到，否则 edgeTop / liquidAmp / hover / press
这四组参数就只能在应用窗口里盲试。查漏用 `_work/audit_preview_coverage.py`：
它把加载器材质层的变量集合与预览 CSS 的变量集合做差集，新加变量后必须复跑。

预览必须覆盖 6 类组件并支持原始/当前对比（0.15.69 起）：

| 预览块 | 吃的变量 | 对应组件 |
| --- | --- | --- |
| `.mt-pv-chat`（玻璃卡片） | `--nts-mt-c-bg-chat` / `-radius-chat` / `-blur-chat` / `-border-width-chat` / `-shadow-chat` | chat |
| `.mt-pv-msg`（气泡） | `--nts-mt-c-bg-bubble` / `-radius-bubble` / `-border-width-bubble` / `-shadow-bubble` | bubble |
| `.mt-pv-btn`（普通按钮） | `--nts-mt-c-bg-button` / `-radius-button` / `-blur-button` / `-border-width-button` / `-shadow-button` | button |
| `.mt-pv-input`（输入框） | `--nts-mt-c-bg-input` / `-radius-input` / `-border-width-input` / `-shadow-input` | input |
| `.mt-pv-pop`（弹窗） | `--nts-mt-c-bg-dialog` / `-radius-dialog` / `-border-width-dialog` / `-shadow-dialog` | dialog |
| `.mt-pv-side`（侧边栏） | `--nts-mt-c-bg-sidebar` / `-radius-sidebar` / `-border-width-sidebar` / `-shadow-sidebar` | sidebar |

每条都写成 `var(--nts-mt-c-*-<comp>, var(--nts-mt-*))` 的回退链：组件没自定义时落到全局值，
自定义后立刻在预览里变化 —— 这是「组件材质」页不变成盲调的唯一办法。
`--nts-mt-c-*` 只在组件 `mode` 为 `preset` / `custom` 时由编译产出，所以默认状态下预览与全局一致。

原始/当前对比：标题栏 `#mt-pv-compare` 切换 `#mt-pv` 的 `data-compare`，
`.mt-pv-ref` 用 `clip-path: inset(0 0 0 50%)` 只占右半屏，内部是**同一套** `buildStack()` 结构，
变量来自 `preview_materials({ materials: deepDefaults(), mode })`，按亮/暗分别缓存在 `REF_CACHE[mode]`
（两套编译结果不同，混用会把暗色原始值贴到亮色预览上）。对比层 `pointer-events: none`，
追光仍作用在主层；层序为 z-index 2（低于 edge/inner/noise，保证两边看到的叠层一致）。

**可读性提示（验收第 9 条）**：材质层不允许改 `color` / `font-size` / `line-height`，
但玻璃基底过实会自然压低文字对比度。面板读 `--nts-mt-bg` 的 alpha（= `opacity × tintStrength`），
≥ 0.62 时在预览下方显示提醒，**只提示不阻止保存** —— 拦下来等于替用户否定他自己的观感选择。

### 3B.7b 预览请求的并发约束

`preview_materials` 是**每次编辑都要调一次**的 entry（面板 debounce 140ms）。
因此前端必须遵守两条，否则拖动滑块会把宿主塞满过期 run：

1. **in-flight 闸门**：上一个请求没回来时不发新请求，只置待补标记。
2. **尾随补发**：请求回来（成功或失败）后若有待补标记，再调度一次，
   保证停止拖动后预览收敛到最后一次参数 —— 只丢弃不补发会让预览停在中间帧。

`PREVIEW_SEQ` 只能保证「旧结果不覆盖新结果」，它不减少请求量；两件事都要做。

面板「组件材质」页的实时预览**只画一张全局主卡片**，组件级参数不在预览里体现，
页脚必须有这句说明（`实时预览只画一张主卡片`），否则会被当成滑块失效。

**暗色覆盖必须可清除（0.15.22）**：暗色只存「与亮色不同」的值，写回相同值即删键。
这条语义会制造一个隐性陷阱 —— 用户想把某项退回继承亮色，只能把值调到与亮色**完全相等**（数值型还要卡在 1e-6 容差内）。
因此参数行必须提供显式的清除入口（`button.mt-row-clear`，暗色模式下且该项有覆盖时才出现），
且在 `input` 事件里就地增删按钮、**不重绘整页**（重绘会打断拖动）。

**参数行必须自带名字（0.15.22）**：`test/materials-dom-selftest.js` 对 7 个参数页逐页断言
每个 `.mt-row` 恰好一个 `.mt-row-label`。这不是样式洁癖 —— 曾用行区间替换误删
`row.appendChild(label);`，结果是「一排没有名字的滑块」，而所有语法检查与自测全绿。
**批量重置（0.15.27 起）**：组件页顶部状态条 + 「全部继承全局」按钮（`#mt-comp-reset-all`，无自定义时禁用）；
头部「清除暗色覆盖（N）」（`#mt-dark-clear`，仅暗色模式且 N > 0 时出现）。两者都走 `markDirty()`，
而 `markDirty()` 必须同步 `renderHeadState()` —— 只更新徽标会让按钮停在上一帧，用户以为没生效。
**参数搜索（0.15.26 起）**：头部 `input#mt-search` 跨全部 90 个参数匹配 key / 中文 label /
section，命中项以参数行直接列出（`renderSearch`）。切界面会清空搜索词 —— 留着旧词会让人
以为点了 tab 没反应。测试桩必须用后端真实 `label`，用 key 兜底会让参数名与搜索一起失真。
**组件缩略块（0.15.25 起）**：「组件材质」页顶部有 10 个缩略块，直接引用
`--nts-mt-c-<prop>-<comp>` 并带全局回退，与主预览共用同一批注入变量（`paintTargets`）。
缩略块只示意颜色 / 圆角 / 模糊 / 边框 / 阴影，不含布局属性；它解决的是
「拖组件参数时预览完全不动」，不代替真机观感。
### 3B.8 组件落点必须命中宿主真实 DOM（0.15.3 起）

组件材质的选择器**不许凭语义猜**。所有落点先在真实宿主里做命中统计，再用
（脚本：`_work/audit_component_selectors.py`，扫描 `<AppRoot>\resources\bin\static` 与
`<AppRoot>\resources\bin\templates` 的 css/html/js）。

| 组件 id | 落点选择器 | 宿主依据 |
| --- | --- | --- |
| chat | `.compact-chat-surface-frame` / `.chat-window` / `#react-chat-window-shell` | 命中 11 / — / — |
| bubble | `.message-bubble-user|assistant|tool|system`、`.compact-export-history-bubble` | 命中 11 |
| input | `.composer-input-shell` / `.composer-input` / `.composer-panel` | 命中 16 |
| sidebar | `.message-list` | 聊天页消息区 |
| topbar | `.window-topbar` | 命中 8 |
| settings | `body.api-key-settings-page #main-content` | `templates/api_key_settings.html` 的 `body` class + 容器 id |
| dialog | `.modal-overlay` / `.modal-dialog` / `.modal-content` | 命中 13 / 7 |
| button | `.composer-icon-button` / `.composer-tool-btn` / `.send-button-circle` / `#sendButton` | 命中 |
| plugin | `.agent-plugin-view` | 命中 3 |
| menu | `.composer-overflow-popover` / `.composer-overflow-menu` / `.composer-icon-popover` | 命中 |

**已废弃、不要再写回来的类名**：`.settings-panel`、`.settings-view`、`.chat-sidebar`、
`.neko-sidebar` —— 宿主里命中数都是 0（唯一那 1 次命中来自加载器自己），
`test/materials-selftest.js` 已把「不得出现」钉成断言。


**暗色玻璃底必须压暗（0.15.36 起）**：`--nts-mt-bg` 的底色取 `tint`，暗色分支在编译时把 tint 混向
`(16, 20, 28)`（比例 0.62），alpha 与亮色保持一致。理由：宿主暗色主题的文字是浅色，白 tint
在高不透明度下就是白底浅字。不换纯黑，是为了让用户染色仍透得出来。改这条要同步升 `COMPILE_VERSION`。

**滚动大面不声明 `backdrop-filter`（0.15.35 起）**：`.message-list` 是整块滚动区域，背后是同一块窗玻璃，
模糊无视觉收益却要每帧重算整块视口 —— 单独用 `:root[data-nts-mt]:root:root:root body .message-list`
把 `backdrop-filter` 置 `none`（背景/圆角/阴影保留）。新增「大面积 + 滚动」的落点时照此处理。

**设置窗口必须并入基础面选择器列表（0.15.32 起）**：不要把设置页写成单独的背景规则。
0.15.3 当初就是单独写的 3 层（inner/sheen/dye），之后给聊天窗加了 inner2/rim/spot/noise/ambient/refract，
设置窗口整整少了 6 层 —— 开设置就明显不是同一块玻璃。现在 `body.api-key-settings-page #main-content` 与
`.container` 直接在基础面那条规则的列表里，加层只改一处。内层（配置卡片 / 输入框 / 下拉触发）也必须走组件别名 `bg-c` / `bw-c` / `radius-c` / `shadow-c`（0.15.34）——
只换外壳会让「组件材质 → 设置」看起来只生效了一半。唯一保留全局的是输入框圆角 `radius-input`（细分维度，不是组件参数）。
唯一需要单独写的是圆角：
`#main-content { border-radius: 0 !important }`（全屏窗口加圆角会裁内容），`.container` 继续用 `radius-c`。

设置窗口的内层（`.container-content` / `.model-config-container` / `.field-row input` 等）
只在 `:root:not([data-theme="dark"])` 下覆盖：暗色主题是宿主 `dark-mode.css` 的属地
（该文件对 `#main-content`、`.container-content`、`.model-config-container` 另有规则），
材质层不与其争夺判断权。

**组件级真机自证（2026-11-21，`_work/probe_component_custom.py`）**：只做静态审计不够 ——
「变量产出了」不等于「元素继承了」。脚本把 `components.chat` 设成 custom（opacity 0.3 / blur 40 /
radius 24），3 秒后读磁盘镜像，70 秒后读 `diagnostics.json` 的 `samples`：

| 观测点 | 全局 | 组件 chat |
| --- | --- | --- |
| `--nts-mt-bg` / `--nts-mt-c-bg-chat` | `rgba(255, 255, 255, 0.156)` | `rgba(255, 255, 255, 0.09)` |
| `--nts-mt-c-blur-chat`（ultra 画质 ×1.15） | `54.05px` | `46px` |
| `--nts-mt-c-radius-chat` | — | `24px` |
| `diagnostics.samples['--nts-mt-bg-c']` | — | `rgba(255, 255, 255, 0.09)` ✓ |
| `diagnostics.comp_matched` | — | `#react-chat-window-shell` |

恢复后 `--nts-mt-c-bg-chat` 从镜像消失、全局回到 `0.156` —— 整条「面板参数 → 后端编译 → 镜像 →
加载器应用 → 元素继承 → 采样回传」才算了跑通。

#### 焦点可见性（0.15.46 起）

材质层给输入控件设 `border` 时**必须**同时补焦点态，否则宿主的 `:focus` 边框与光晕会被 `!important` 一起压掉：

- 宿主 `api_key_settings.css` 的焦点提示是 `border-color: #40C5F1` + `box-shadow: 0 0 0 3px rgba(64, 197, 241, 0.15)`；
- 材质层规则用 `var(--nts-accent, #40C5F1)` 取主题强调色，光晕 alpha 提到 0.18（玻璃底需要更实一点才看得见）；
- 只在亮色分支（`:not([data-theme="dark"])`）补，暗色由宿主 `dark-mode.css` 负责；
- 焦点段里**不得**出现 `outline: none`（materials-selftest 有一条负向断言盯着）。

教训：CSS 规则按行插入时必须确认落点在**规则之外**。插进声明块内部不会报错，解析器只会静默丢弃 —— 唯一的信号是运行期规则计数没涨（见 §3B.9 的 `rules` 字段）。

#### 合成层雷区：带 transform / filter 的容器上不做 backdrop-filter（0.15.64–0.15.65 起）

Chromium 在同时具备 `transform`、`filter`、`will-change`、`overflow: hidden` 的元素上做 `backdrop-filter`，有整块不绘制的已知问题：`getBoundingClientRect()` 正常、`display / visibility / opacity` 都正常，屏幕上却什么都没有 —— 排查时极易误判成「元素被删了」。

宿主里已知的高危容器（`audit_mt_backdrop_hazards.py` 的 `HAZARDS`）：

| 容器 | 雷区来源 |
| --- | --- |
| `#react-chat-window-shell` | `transform: translate(-50%,-50%)` + `overflow: hidden` |
| `#react-chat-window-root` | compact 模式下宿主给它上 `filter` |
| `.composer-icon-popover` | `transform` |
| `.compact-export-history-bubble` | `filter` + `transform` |

规则：

1. 这四个容器**不声明** `backdrop-filter`，而不是「声明了再用更高特异性覆盖成 none」。后者等于把雷埋下等下一个改样式的人踩。
2. 玻璃观感由底色、9 层 `background-image`、多段 `box-shadow` 表达；模糊只留给自身干净的小元素（气泡 / 输入框 / 顶栏 / 模态 / 设置卡片）。
3. 新增给材质加模糊的选择器，先跑 `python _work/audit_mt_backdrop_hazards.py`；selfcheck 的 `mt-backdrop-hazards` 门控会拦。
4. 排障顺序：先看 `hidden` 属性与祖先链 `display`（`shell_chain` 采样已含 `hid=`），再看 computed 值 —— 元素没绘制时 computed 照样是正常值。
### 3B.9 运行期自证：`loader_report` 的 `page` 字段

加载器每 60 秒（以及可见性变化时）向上报 `loader_report`，落盘到插件 `static/diagnostics.json`。
0.15.3 起记录带 `page`（`location.pathname`）——**打开设置窗口后，历史里应出现
`page=/api_key_settings` 的记录**；若只有 `/`，说明设置页的加载器没跑起来。

**上报前置条件（0.15.51 起）**：`reportRuntime` 在采集之前要求 `lastApply && lastApply.at` ——
没真正应用过任何主题（正常注入 / 空调色板 / 显式禁用三条路径都会写）就不上报，也不消耗 60 秒节流窗口。
原因是 `install.ps1` 会清掉 `diagnostics.json`，紧接着的首帧上报若早于样式注入，会写一份
`css_len=0 / focus_rules=0` 的假快照，让自检假红（实测踩过一次）。所以**读到 0 值先看上报时间**：
install 后 60–90 秒内的 0 值属于时序，不等于规则失效。

0.15.14 起记录还带 `samples`：加载器用 `getComputedStyle(document.documentElement)` 读取
8 个关键材质变量（`--nts-mt-under-glow`、`--nts-mt-rim-img`、`--nts-mt-rim-shade`、
`--nts-mt-disp-warm`、`--nts-mt-lens-glow`、`--nts-mt-sheen-img`、`--nts-mt-bg`、
`--nts-mt-anim`），后端截断后落盘（键限 `--nts-` 前缀、值 160 字符、最多 20 条），
`history` 每条另存 `under_glow` 与 `rim_img` 便于时间线对照。

**为什么要值级自证**：`mt_vars` 只能证明「注入了多少个变量」，无法区分镜像过期、门控属性
缺失、变量被覆盖这几种失效——它们的变量计数都正常。看 `samples` 才能确认窗口里的真实取值：
`--nts-mt-rim-img` 的 `at` 坐标应该跟着鼠标走（实测 `at 79.52% 83.23%`），
`--nts-mt-sheen-img` 的角度应随指针变化（实测 `48.4deg`），`--nts-mt-under-glow` 应为
非零 `rgba()`。`_work/selfcheck.js` 的 `diag-material-samples` 项钉住这条。

0.15.47 起记录还带 `css_len`（注入样式表的文本长度）与 `focus_rules`（遍历 `cssRules`，数 `selectorText` 里含 `input:focus` 的规则条数）。

为什么单看 `rules` 不够：`rules` 是顶层 `cssRules.length`，规则被插进声明块内部时解析器会静默丢弃（只少一条，肉眼看不出来），而上报时页面还没重载又只有一个旧数字 —— 两者都表现为「rules 没涨」。真机实测 `css_len 63026 / rules 57 / focus_rules 1`，`focus_rules` 直接回答「规则在不在样式表里」。
### 编译产物版本：`COMPILE_VERSION`

`materials.py` 的 `COMPILE_VERSION` 是 `theme.json` 镜像的第三维版本号（另两维是
`css_sha8` 与 `loader_version`）。**新增 / 重命名派生变量时必须 +1**：否则编译器升级而
加载器 CSS 没变时，`_ensure_file` 判不出镜像过期，窗口会一直吃旧变量表（0.15.12 真实踩过——
126 个变量里的环带与分色色散在磁盘上根本没有）。

### 3B.10 分享包边界必须有测试看着（0.15.52 起）

`_parse_archive` / `_rewrite_archive_refs` 的 8 条安全策略是**不可静默退化**的：
它们本该在 `plugin/tests/test_archive_security.py` 里逐条有用例，改解包代码时测试必须变红。

| 策略 | 期望 |
| --- | --- |
| 条目名含 `../` / 绝对路径 / `:` | 抛 `SdkError`（消息含「非法路径」） |
| 重名条目 | 抛 `SdkError`（消息含「重复文件名」） |
| 包里没有 JSON | 抛 `SdkError`（消息含「theme.json」） |
| 图片格式 | 只认魔数（png/jpg/gif/webp），扩展名不作数 |
| 单图体积 | > 4 MiB 抛 `SdkError`（消息含「图片过大」） |
| 包内缺图 | 导入成功，引用从 vars 里丢弃，`backgrounds/` 不新增 |
| 合法图落盘 | 文件名 = 内容 sha256 前 16 位，引用改写为绝对 URL |
| `javascript:` / `file://` | 引用被 `_validate_palette` 丢弃，主题仍导入成功 |

两条不要踩：①只带图片引用、没有颜色变量的主题会被合法拒绝（「没有可用的调色板变量」），
测图片策略时要同时带一个颜色变量；②构造重名条目时 zipfile 会 warn「Duplicate name」，
用 `warnings.catch_warnings()` 静音。
#### 采样必须证明「看得见」（0.15.63 起）

`loader_report` 只报变量值和 computed 样式还不够：0.15.53–0.15.62 的样本全部采在 `#react-chat-window-shell` 上，而它是 0x0 的隐藏壳（真机祖先 `#react-chat-window-overlay` 为 `display:none`），于是「9 层背景、14 段阴影、材质生效」都是不可见元素上的数字。

因此上报必须带三类可视性证据：

1. `comp_rects`：5 个候选探针各自的 `宽x高@左,上`，用来确认「命中」不等于「可见」。
2. `center_chain` + `viewport`：`document.elementFromPoint(宽/2, 高/2)` 向上 10 层，含 tag/id/class/尺寸/`background-color`/`backdrop-filter`。用户说「没变化」时先看这条链 —— 命中的是 `canvas` 还是聊天容器，一眼可辨。
3. `shell_chain`：外壳到 `html` 的 8 层，含 `display`/`visibility`/`opacity`/`position`。`fixed` 元素尺寸为 0 时，答案一定在祖先的 `display` 上。

判据：`rect` 不是 `0x0` 且祖先链上没有 `display:none`，才允许把该元素的 computed 值当作「用户看到的」证据。

### 3B.11 材质随主题（v0.15.67 起）

#### 0.15.68 起：内置主题拆成两套独立主题

0.15.67 让每套主题带一套材质，结果是「切主题必然改玻璃」—— 用户想只换颜色时无处可去。
0.15.68 把内置主题一分为二：

| 文件 | 内容 | 应用效果 |
| --- | --- | --- |
| `<id>.json` | 只有 `vars` / `dark_vars` + `materials: {"enabled": false}`（v0.15.70 起） | 换颜色，并**关闭**高级材质 |
| `<id>-material.json` | 同一份配色 + 该族完整 `materials` | 颜色与玻璃一起换 |

加后缀的那套是**另一套主题**，不是同一套的开关。约束（`test_preset_materials.py` 钉住）：

1. 颜色版与材质版一一配对：每个 `<id>` 必有 `<id>-material`，反之亦然（缺一边说明生成脚本漏跑）。
2. 两版 `vars` / `dark_vars` 必须逐键相同 —— 改配色要同时改两份，否则一对主题会变成两套不同的配色。
3. 材质版 `name` = 配色版 `name` + ` (材质)`（ASCII 括号，前导一个空格），`family` / `tags` 与原主题一致。
4. 颜色版必须带 `materials: {"enabled": false}`（`lock` / `version` 也可），**不许**带五节参数或 `preset`。

#### 0.15.70 修复：配色版必须显式关材质

0.15.68 让配色版「不带 `materials`」，本意是「只换颜色」，但「缺省」的语义是*保持当前材质*，
于是从 `<id>-material` 切回 `<id>` 时玻璃留在窗口上 —— 用户实测到的就是这个：同一主题换成非材质版，
材质还在。两套主题的差别被「缺省」吃掉了。

现在的语义分三层，`_apply_theme_record` 里用 `material_patch` 判定：

| 主题里的 `materials` | 含义 | 对当前材质的影响 |
| --- | --- | --- |
| 不存在（0.15.67 之前的老条目 / 老分享包） | 作者没写 | 保持不动（兼容旧数据，不改用户设置） |
| 只含 `enabled` / `lock` / `version`（配色版就是 `{"enabled": false}`） | 开关补丁 | `apply_materials` 合并：只改开关，**五节参数与自定义预设全部保留** |
| 含五节参数或 `preset` / `quality` / `components` | 整套材质 | 整份替换（自定义预设按名合并） |

保留参数而不是清空是有意的：关掉材质后再打开，用户不该突然回到出厂玻璃。`lock` 优先级最高 ——
材质锁定后，配色版的 `enabled: false` 也不会生效（用户明确说过「跟随主题关掉，我自己调」）。

返回值带 `material_enabled`，面板据此把提示分成「材质已换成主题自带的那套」与「已关闭高级材质」；
主题卡片对配色版显示中性色的「无材质」徽标，而不是一个具体预设名。

一套主题从「颜色」升级成「颜色 + 玻璃」：`presets/*.json` 与仓库条目都可能带 `materials`，
应用主题时连玻璃一起换。这样 51 套材质版主题各有各的质感，而不是共用同一套液态玻璃。

| 主题字段 | 作用 | 缺省行为 |
| --- | --- | --- |
| `vars` / `dark_vars` | 颜色变量（101 项） | 缺了就是空调色板 |
| `materials` | 材质整份（preset / quality / 五节 90 参数 / lock） | 缺了**保持用户当前材质不动** |
| `materials.lock` | `true` = 应用主题时不覆盖材质 | 缺了按 `false`（跟随主题） |

#### 风格族 → 材质矩阵

内置主题按 `family` 决定玻璃。族是面板筛选用的既定分类，材质跟着族走，不由作者手挑：

| family | preset | quality | 理由 |
| --- | --- | --- | --- |
| `glassy` | `liquid` | `ultra` | 玻璃族本来就该是最贵的折射与环带 |
| `gradient` | `prism` | `high` | 渐变底配分色色散 |
| `dark` | `smoke` | `high` | 暗底要烟熏，不要白雾 |
| `light` | `soft` | `balanced` | 浅底柔光，不压文字 |
| `texture` | `frosted` | `balanced` | 纹理配磨砂 |
| `minimal` | `clear` | `balanced` | 极简就该几乎看不见 |

染色主色取该主题的 `--nts-accent`、副色取 `--nts-accent-2`（其次是 `--nts-link`、
`--nts-bubble-user-bg`）—— 材质必须带着主题的配色 DNA，否则 51 套会长得一样。

#### 三条红线（由测试钉住）

1. **预设里的 `materials` 必须五节完整**（`global/lighting/refraction/surface/animation` 共 90 键）。
   缺一节不会报错，会静默退回该节默认值 —— 症状是「这套主题的玻璃和默认主题一模一样」。
   `test_preset_materials.py` 逐套断言，`_work/audit_preset_materials.py` 可复跑。
2. **预设里不许带 `custom_presets` / `components` / `dark`**：前两个是用户自己的库与逐组件覆盖，
   第三个是用户的暗色微调。把它们塞进预设等于把作者机器上的状态塞给所有人。
   生成器只写 `version/enabled/preset/quality` + 五节。
3. **染色必须跟着 `--nts-accent`**：同一族里 accent 不同的两套主题，`dyePrimary` 必须不同。
   否则「51 套材质版 6 种玻璃」退化成「6 种玻璃」。

#### 锁定：`materials.lock`

用户在材质中心手调了一套玻璃，不希望切主题时被冲掉 —— 面板头部「跟随主题」开关就是这一位：

| 开关 | `lock` | 应用主题时 |
| --- | --- | --- |
| 勾上（默认） | `false` | 颜色换 + 材质换成主题自带的那套 |
| 关掉 | `true` | 只换颜色，材质保持当前 |

锁定只影响「应用主题」这一条路径，不阻止用户自己点预设、拖滑块、导入分享包。

`_apply_theme_record` 返回三个字段，面板据此说人话：

| 字段 | 含义 | 面板文案 |
| --- | --- | --- |
| `material_applied` | 条目的材质真的写进去了 | 「材质已换成主题自带的那套」 |
| `material_present` | 条目里有材质，但没应用（锁住了） | — |
| `material_locked` | 是「锁住」导致的没应用 | 「材质已锁定（保留你手调的设置）」 |

`apply_saved_theme` 把三个字段透传给面板；仓库卡片另有 `item.material` 徽标
（`{enabled, preset, label, quality, quality_label}`，由 `_material_badge()` 生成，
摘要失败返回 `None` 而不是让整个列表崩）。

#### 老数据

- 老分享包 / 老仓库条目没有 `materials` → 只换颜色，用户当前材质保持不动。
- 老 `theme.json` 没有 `lock` → 读成 `false`。
- `custom_presets` 的合并语义（§3B.12）不变：应用带材质的主题不会清空用户自己存的预设。

## 3C. 卸载与恢复契约（v0.15.5 起）

外部评分报告扣分最重的两条都在这:**复活绕过宿主总开关** 与 **卸载不可逆**。
0.15.4 及以前，卸载只存在于仓库根目录的 `uninstall.ps1` —— 而插件市场只安装 `plugin/` 子树，
用户手里根本没有那个脚本；`theme-studio-disabled` 标记写注释说「由 uninstall.ps1 写」，
但实际上没有任何运行期路径会写它。0.15.5 把这件事整体搬进插件内部。

### 3C.0 两个 entry

| entry | 作用 | 幂等 |
| --- | --- | --- |
| `detach_theme` | 写停止标记 → 逐模板剥离 NTS 段 → 备份并删除两件套 | 是 |
| `restore_theme_patch` | 删停止标记 → 走一遍 `ensure_app_patch` | 是 |

`detach_theme` 返回 `{ok, disabled, flag, app_root, templates_cleared, templates_untouched,
templates_failed, assets_removed, assets_backed_up, warnings, search_paths}`。
**主题数据一律不动**（`theme.json` / `themes/` / `backgrounds/` 全保留），所以随时能恢复；
剥离前的带标记副本与两件套备份落在 `<备份根>/static-uninstalled/`。

### 3C.1 `static/disabled.json` 镜像

加载器跑在应用窗口（`:48911`），既调不了 entry、也读不到 `%LOCALAPPDATA%` 下的停止标记；
而 `/plugin/<id>/ui/<file>` 是插件服务的静态路由 —— 正好能把这一位状态递过去。

| 字段 | 含义 |
| --- | --- |
| `disabled` | 停止标记是否存在 |
| `updated_at` | 镜像写入时间（ISO 8601） |
| `flag` | 标记文件绝对路径（诊断用） |

写入时机：插件 `startup`、每次自愈结束、两个 entry 执行完。写失败只记 warning（不能拖垮启动）。

### 3C.2 加载器的两条复活闸门

`reviveService()`（404/503/网络失败时自动 `refresh → start`）在 0.15.5 前是**无条件**的，
最多 40 次、退避 1.2s→30s —— 用户明确停用后页面仍会把插件拉起来。现在任一条件成立即放弃，
并只写一条日志（`revive skipped`）：

1. **`disabled.json` 的 `disabled === true`** —— 用户从面板点了「卸载主题」；
2. **宿主注册表 `/plugins` 里该插件 `runtime_enabled === false`** —— 用户在插件管理里停用了它。

判据必须指向**用户意图**，不能用「本窗口是否成功过主题」这类无关痕迹：0.15.5 曾用 `localStorage`
键 `neko.themeStudio.everRan` 兜底（跑过一次就永不复活），代价是插件崩溃或服务重启后页面彻底
失去自愈能力，只能手动刷新 —— 0.15.6 删除该判据，改用宿主自己的开关。

两条探测（`probeDisabled()` / `probeRuntimeGate()`）**失败都按「未停用」放行**：插件服务整体没
起来时两个端点都连不上，而那正是最需要自愈的时候。面板侧的 `revivePlugin()` 同样先读
`./disabled.json`（`patchDetached()`），被卸载时给出明确提示而不是继续重试。

探测结果缓存 **30s**（`PROBE_TTL_MS`），不是永久：应用窗口可能常开数天，用户中途停用必须能被
下一次自愈尝试发现。TTL 取 30s 是为了覆盖一次退避周期（1.2s 起 ×2，上限 30s）。

### 3C.3 市场包不含脚本

`.neko-plugin` 只打包 `plugin/`，**不含 `install.ps1` / `uninstall.ps1`**。所以文档与界面文案
不再把「重跑 install.ps1」当成卸载/恢复的正常路径：面板「安装自检」里就是「卸载主题」与
「重新接入」两个按钮。仓库根的脚本只服务开发副本（`-AppRoot` 指向真实安装目录）。

### 3B.12 自定义预设（`custom_presets`）的生命周期（0.15.9 起）

`materials.custom_presets` 是「用户的预设库」，与 `preset`（当前用的是哪一套）是两件事。
下面四条不变量由 `test_materials.py` 的 `CustomPresetTests` 锁住：

| 不变量 | 含义 | 违反后的用户可见症状 |
| --- | --- | --- |
| 写入走独立 entry | `save_material_preset` / `delete_material_preset` | 只能靠整份提交捎带，漏带一次就丢库 |
| `apply_theme` 只按名合并 | 五节整份替换，`custom_presets` 与磁盘已有库合并 | 面板漏带 `custom_presets` 时用户存的预设被清空 |
| 删除也走独立 entry | 在写锁内直接 `pop` 后落盘 | 走 `apply_theme` 会被合并语义叫回来（删不掉） |
| 自定义名不被归一化抹平 | 非内置名保留原文；指向不存在的预设才退回 `custom` | 面板无法高亮当前卡片，重载后变成 Custom |
| 应用仓库条目时也按名合并 | `_apply_theme_record` 同样保留本地独有的预设（同名以条目为准） | 点一次「应用历史主题」就清空用户存的预设 |

entry 输入输出：

| entry | 输入 | 输出 |
| --- | --- | --- |
| `save_material_preset` | `name`（1–40 字符，必填）、`materials`（可选，缺省取磁盘现值） | `{name, names, materials}` |
| `delete_material_preset` | `name`（必填） | `{deleted, names, materials}`；不存在时 `Err("没有名为「X」的自定义预设。")` |
| `material_spec` | — | 增加 `custom_presets`（名字 → 五节参数），与内置 `presets` 分开列出 |

两处写入路径（`apply_theme` 与 `_apply_theme_record`）都必须做这个合并：前者是面板保存，
后者是「应用仓库/历史条目」。条目里带的是**存那一刻**的库，整份替换等于用旧库覆盖新库 ——
用户会发现自己刚存的预设凭空空了（0.15.10 修的就是这条）。

`preset` 字段可以等于内置 id（`clear`…`prism`）或某个 `custom_presets` 的键名；等于 `custom`
表示「用五节当前值、不挂任何预设标签」。切换预设是**整套替换**（含清空 `dark` 覆盖），面板
`applyPreset` 必须同时重置暗色覆盖 —— 否则亮色套了新预设、暗色还留着旧覆盖。
## 3D. 文档契约（v0.15.43 起）

文档不是「写给人看的说明」，它必须能被机器核对。五处内容各有唯一同源对象：

| 文档内容 | 同源对象 | 审计脚本 | selfcheck 门控 |
| --- | --- | --- | --- |
| PARAMETER-REFERENCE §2 / §7 | `plugin/static/app.js` 的 `CATALOG` | `_work/audit_docs_palette.py` | `docs-palette` |
| PARAMETER-REFERENCE §8 | `plugin/materials.py` 的 `PARAMS` | `_work/audit_docs_params.py` | `docs-params` |
| 枚举值（§2 / §3 的「选择」行） | `plugin/__init__.py` 的 `KEYWORD_VARS` | `_work/audit_keyword_consistency.py` | `keyword-consistency` |
| AI-THEME-GUIDE §12 | 同上（材质 90 参数 + 7 预设 + 4 画质） | 静态断言 | `docs-material` |
| 三份文档头部的「适用版本」 | `plugin/plugin.toml` + `SCRIPT_VERSION` | `_work/sync_doc_versions.py --check` | `docs-version` |

三条红线：

1. **枚举值只能抄 `KEYWORD_VARS`。** `--nts-corner-style` 是 `round` / `continuous`，不是 `squircle`：后端 `_validate_palette` 按整串匹配拒绝一切未知值，写错就是「文档教你写一个存不进去的值」。
2. **新增变量必须同时改文档。** v0.12 加的 6 个变量（`--nts-chat-bg-fit` / `-position` / `-repeat`、`--nts-corner-style`、`--nts-text-gradient`、`--nts-line-height`）漏了整整六个版本，直到 0.15.43 才被 `docs-palette` 抓出来。
3. **文档里的 JSON 示例必须能过 `test_ai_guide`。** 指南里每个 json 代码块都会被 `_validate_palette` 验证，且要求 `clean_vars or clean_dark` 为真 —— 只写 `materials` 的示例过不了。
4. **自定义预设不能与内置预设同名（大小写不敏感）。** `normalize_materials` 会丢弃 `title.lower() in PRESET_IDS` 的条目并给 warning，面板在保存时就拦住 —— 内置预设优先，同名自定义预设永远选不中，是死预设。

数字口径（0.15.43 实测）：分组 13 / 15 / 9 / 11 / 5 / 6 / 11 / 13 / 9 / 9 = 101；类型 color 54 / number 17 / length 11 / gradient 5 / select 4 / blur 2 / filter 2 / image 1 / font 1 / shadow 1 / switch 1 / ratio 1 / time 1 = 101；§2 逐条 83 + §7 液态玻璃 18 = 101。

### 3D.1 选择器门控（0.15.50 起，`_work/audit_mt_host_hits.py` + `_work/audit_mt_blast_radius.py`）

材质层的每条规则都必须真的落在宿主 DOM 上，且不能误伤工具页。两条门控 + 一个**必然踩到的陷阱**：

1. **语料必须排除加载器自己。** `resources/bin/static/neko-theme-studio.js` 与
   `css/neko-theme-studio.css` 就是加载器本体 —— 把它们算进语料，「零命中」会被自引用全部掩盖。
   本轮第一版脚本没排除，跑出「零命中 0 / one-hit 0」的假绿；排除后才看清真实分布：
   31 个材质类名在宿主全部命中，唯一 one-hit 是 `.agent-plugin-view`。
2. **每个材质类名在宿主语料里至少命中 1 次。** 零命中 = 那条规则永远打不到元素（0.15.2 的
   `.settings-panel` / `.settings-view` 就是这么空转的）。
3. **工具页共享类名靠页面限定挡住。** 20 个挂了 loader 但不属于聊天/设置页的模板里，
   `live2d_emotion_manager.html` 含 `.container` / `.container-content` / `.field-row` 三个类名；
   它们之所以不被玻璃化，是因为设置页那 5 条规则全部带 `body.api-key-settings-page` 前缀。
   门控的判据不是「工具页不含这个类」，而是「**含这个类的每条材质规则都带页面限定**」——
   少了这个前缀，live2d 的情绪管理器会莫名其妙变成毛玻璃。

`mt-host-hits` 与 `mt-blast-radius` 已接入 selfcheck（69 项）。

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

### 7b.1 错误显示口径（v0.15.48 起）

entry 内 `raise SdkError(...)` 与 `return Err(...)` 混用是既有风格；被 `raise` 逃逸出 entry 的错误，宿主会包装成
`code=INTERNAL` 并叠加两段 `execution failed` 前缀。**面板必须在显示前剥掉包装**：

```js
throw new Error(pluginErrorMessage(rec.error) || rec.message || rec.status);
```

判据：`materials-selftest` 有两条断言盯着这行（必须用 `pluginErrorMessage`、不得直传 `rec.error.message`），
`_work/selfcheck.js` 的 `panel-error-scope` 门控拉真机面板 `app.js` 复核。

反面案例：0.15.46 之前，用户输入不存在的仓库条目 id，看到的是
`Plugin 'neko_theme_studio' entry 'entry apply_saved_theme' execution failed: ... execution failed: 主题仓库条目 id 非法。`，
前两段完全是宿主实现细节。

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
