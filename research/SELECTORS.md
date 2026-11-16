# SELECTORS.md — N.E.K.O UI 着色规则清单

用途：把「哪条 CSS 规则画了 UI 的哪一块」逐条定位，供 `theme-studio` 主题样式表写出**能真正压住原生规则**的覆盖选择器。

## 来源与引用约定

| 文件 | 说明 | 引用方式 |
| --- | --- | --- |
| `resources/bin/static/css/index.css` | 亮色基础 + 布局 | 行号 `index.css:2442` |
| `resources/bin/static/css/dark-mode.css` | 暗色值，多数带 `[data-theme="dark"]` 前缀 | 行号 `dark-mode.css:163` |
| `resources/bin/static/react/neko-chat/neko-chat-window.css` | React 聊天窗主样式表 | **该文件是单行压缩文件（1,717,526 字符），无行号**，一律引字符偏移 `idx=NNNNN` |
| 其余 32 个 `resources/bin/static/css/*.css` | 各功能页 | 行号 |

- `idx=` 的取法：从偏移处向前回退到上一个 `}`／`{` 得到整条规则。可用 `grep -o` 或按偏移切片复核。
- 特异性写法 `(id, class/属性/伪类, 类型/伪元素)`，与浏览器一致。
- `[data-theme=dark]` 与 `[data-theme="dark"]` 两种写法在暗色规则里混用，等价，都算 **+1 class 级**。
- 另一个同内容副本：`resources/bin/static/react/neko-chat/assets/style-CDAYTMip.css`。

**加载顺序**：`index.css` 第 1–5 行 `@import` 了 `base.css`、`chat_sync.css`、`full-chat-minimize.css`；`dark-mode.css` 与 React 样式表在其后；主题样式表必须排在 `dark-mode.css` **之后**。

---

## A. 聊天气泡

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (1) `.message.user` 背景+文字 | `.message.user` | `index.css:2442` | `background:#44b7fe; color:#fff; border-bottom-right-radius:4px` | — | (0,2,0) |
| (1') 同上（暗色） | `[data-theme="dark"] .message.user` | `dark-mode.css:163` | — | `background:#2a7bc4; color:#ffffff` | (0,3,0) |
| (1'') React 用户气泡 | `.message-bubble-user` | `neko-chat-window.css idx=1501540` | `background:linear-gradient(135deg,#b9d6ff,#d4e7ff); color:#142033; border-radius:16px 8px 16px 16px` | — | (0,2,0) |
| (1''') React 用户气泡（暗色） | `[data-theme=dark] .message-bubble-user` | `neko-chat-window.css idx=1687216` 起 | — | `background:linear-gradient(135deg,#1a3a6e,#264a8a); color:#d8e6ff` | (0,3,0) |
| (2) `.message.ai` / `.message.assistant` | **(无现有规则)**（全仓库无任何声明） | — | 无 | 无 | — |
| (2') 旧版 AI 气泡真身 | `.message.gemini` | `index.css:2451` | `background:rgba(68,183,254,0.12); color:#333; border-bottom-left-radius:4px; white-space:pre-wrap` | — | (0,2,0) |
| (2''） | `[data-theme="dark"] .message.gemini` | `dark-mode.css:168` | — | `background:rgba(42,123,196,0.18); color:#e0e0e0` | (0,3,0) |
| (2''') React AI 气泡真身 | `.message-bubble-assistant` | `neko-chat-window.css idx=1501484` | `background:#fff; color:#273042` | `[data-theme=dark]` → `background:#2d2d3c; color:#e8eaed`（idx=1687216 起） | 亮 (0,2,0) / 暗 (0,3,0) |
| (2'''') React tool/system 气泡 | `.message-bubble-tool` / `.message-bubble-system` | idx=1501659 / idx=1501745 | tool `linear-gradient(180deg,#f8fafc,#edf2f8)`+`#2b3a50`；system `#8394af24`+`#607086` | tool `linear-gradient(180deg,#232330,#1e1e2a)`+`#b8bcc4`；system `#505a6e33`+`#9aa0ac` | 亮 (0,2,0) / 暗 (0,3,0) |
| (2''''') 串门访客气泡（宿主编外） | `#react-chat-window-root .message-bubble-tool` | `index.css:4768`（暗色 `index.css:4779`） | `background:linear-gradient(135deg,#f3edff,#e6dcff); color:#352557` | `linear-gradient(135deg,#392d50,#2d2342)`+`#f0e9ff` | 亮 (1,1,0) / 暗 (1,2,0) |
| (3) `.message-block*` 是否声明颜色 | **全部只声明尺寸/排版，无一条声明颜色** → **(无现有规则)** | 见下表 | 无 | 无 | — |
| (4) 气泡内链接 | `.message-block-markdown a` | `neko-chat-window.css idx=1504797` | `color:#2f68df; text-decoration:underline; text-underline-offset:2px; word-break:break-all` | `[data-theme=dark]` → `#6fa8ff`（idx=1688165） | 亮 (0,1,1) / 暗 (0,2,1) |
| (4') 气泡内链接卡 | `.message-block-link` | idx=1508143 | `background:#f8fafcd9; border:1px solid rgba(123,139,166,.15); border-radius:12px; color:inherit` | `[data-theme=dark]` → `background:#232330d9; border-color:#ffffff14`（idx=1688883） | 亮 (0,1,0) / 暗 (0,2,0) |
| (5) 气泡内行内 code | `.message-markdown-inline-code, .message-block-markdown :not(pre)>code` | idx=1504973 | `background:#5b6f911f; color:#22324d; border-radius:6px; font-size:.84em` | `[data-theme=dark]` → `background:#6478a02e; color:#c0cce0`（idx=1688304） | 行内 code 支 (0,2,1)；暗 (0,3,1) |
| (5') 气泡内 pre | `.message-markdown-pre` | idx=1505482 | `color:#1f2c42; padding:.8rem .9rem; **无 background**` | `[data-theme=dark]` → `color:#c0cce0`（idx=1688581，同样无背景） | 亮 (0,1,0) / 暗 (0,2,0) |
| (5'') pre 内层 code | `.message-markdown-pre code` | idx=1505660 | `display:block; min-width:max-content; background:transparent` | 无 | (0,2,0) |
| (6) `.message-block-image` | `.message-block-image` | idx=1506287 | `background:transparent; border-radius:12px; max-width:280px` | **无暗色规则**（图片容器透明，不随主题变） | (0,1,0) |
| (6') 加载失败贴纸兜底 | `img[data-neko-image-load-failed-sticker=true]` | idx=1506489 | `background:#fff` | 无 | (0,1,1) |
| (7) `.message-block-status` | `.message-block-status` | idx=1508805 | `padding:8px 10px; border-radius:10px; font-size:.78rem`（**无色**） | 无 | (0,1,0) |
| (7') 状态色（真正上色的地方） | `.message-block-status.tone-info/-success/-warning/-error` | idx=1508880 / 1508947 / 1509017 / 1509087 | info `#28589d`/`#4681e31f`；success `#236845`/`#30a1641f`；warning `#9a6008`/`#eba83429`；error `#a63a3a`/`#df5b5b24` | `[data-theme=dark]` → info `#6fa8ff`/`#4482e626`；success `#5ec790`/`#30a16426`；warning `#e8b44a`/`#eba83426`；error `#e07070`/`#df5b5b26`（idx=1689124 起） | 亮 (0,2,0) / 暗 (0,3,0) |

### (3) `.message-block*` 的完整清单（全部只做尺寸/排版）

| 选择器 | file:line | 声明（无颜色） | 特异性 |
| --- | --- | --- | --- |
| `.message-block` | idx=1501794 | `min-width:0; max-width:100%` | (0,1,0) |
| `.message-block-text` | idx=1502439 | `white-space:pre-wrap` | (0,1,0) |
| `.message-block-text, .message-block-markdown, .composer-input, .compact-chat-capsule-text` | idx=1502480 | `font-family:var(--neko-chat-content-font); font-weight:500; font-synthesis:weight` | (0,1,0) |
| `.message-block-markdown` | idx=1503738 | `min-width:0; font-size:.94rem; line-height:1.58` | (0,1,0) |
| `.message-block-buttons, .message-inline-actions` | idx=1509155 | `display:flex; flex-wrap:wrap; gap:8px` | (0,1,0) |
| `.message-block-html-card` | idx=1708709 | `width:100%; min-width:0` | (0,1,0) |
| `.message-block-text-plain` / `.message-block-image-interactive` / `.message-block-link` | 见 idx=1502439 / 1506603、1507668 / 1508143 | 尺寸与网格 | (0,1,0) |

类名全集（React 侧共 10 个）：`.message-block`、`-buttons`、`-html-card`、`-image`、`-image-interactive`、`-link`、`-markdown`、`-status`、`-text`、`-text-plain`。
**结论（3）**：气泡配色由气泡本体（`.message-bubble-*` 或旧版 `.message.user/.message.gemini`）负责，`.message-block*` 只继承 `color`，主题改文字色必须打气泡本体或 `.message-block-text/.message-block-markdown`。

补充（气泡周边文字色，非目标但相邻）：
`.message-author{color:#596579}` idx≈1501240，暗 `#b8bcc4`（idx=1687570）；`.message-meta{color:#7e899a; font-size:.72rem}` idx=1501140，暗 `#9aa0ac`（idx=1687595）；`.message-reactions` 暗 `border-color:#7db9e752; background:#243143e6`（idx=1501060）。

---

## B. 聊天窗口

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (8) `#react-chat-window-root` 背景 | `#react-chat-window-root` | `index.css:2204-2209` | `background:transparent` | `[data-theme="dark"]` → `transparent`（`index.css:2346`） | 亮 (1,0,0) / 暗 (1,1,0) |
| (8) `#react-chat-window-shell` 背景 | `#react-chat-window-shell` | `index.css:1654-1667` | `background:transparent; border-radius:22px; box-shadow:0 30px 100px rgba(12,20,34,0.3)` | `[data-theme="dark"]` → `transparent; 0 30px 100px rgba(0,0,0,0.5)`（`index.css:2294`） | 亮 (1,0,0) / 暗 (1,1,0) |
| (8') 紧凑形态外壳 | `… #react-chat-window-shell[data-chat-surface-mode="compact"]:not(…)` | `index.css:1669-1680` | `border-radius:28px; box-shadow:0 24px 72px rgba(12,20,34,0.18)` | `index.css:2299` → `0 24px 72px rgba(0,0,0,0.42)`；拖拽 `2303` → `0 36px 110px rgba(0,0,0,0.6)` | 亮 (1,2,0) / 暗 (1,3,0) |
| (8'') **真正被看到的面板底色** | `.chat-body` | idx=1497896 | `background:rgba(255,255,255,calc(.91 * var(--neko-chat-opacity-factor,1)))` | `[data-theme=dark]` → `rgba(28,28,46,calc(.91 * …))`（idx=1686939） | 亮 (0,1,0) / 暗 (0,2,0) |
| (8''') 紧凑面板渐变 | `[data-theme=dark] .compact-chat-surface-frame` | idx=1694637 | — | `--compact-chat-surface-bg: linear-gradient(180deg, rgba(31,48,66,.8×f), rgba(15,29,46,.76×f) 58%, rgba(8,17,30,.72×f))` | (0,2,0) |
| (9) `#react-chat-window-backdrop` | `#react-chat-window-backdrop` | `index.css:1650-1652` | **只声明 `display:none`，无任何背景/颜色** → **(无现有规则)** | 无 | (1,0,0) |
| (10) `.window-topbar` | `.window-topbar` | idx=1495692 | `background:rgba(255,255,255,calc(.75 * var(--neko-chat-opacity-factor,1))); border-bottom:1px solid rgba(255,255,255,.5); box-shadow:inset 0 -.5px #ffffff40,0 1px 4px #6478a00f` | `[data-theme=dark]` → `linear-gradient(180deg,rgba(50,50,72,.6×f),rgba(38,38,58,.5×f)); border-bottom-color:#ffffff1f`（idx=1685902） | 亮 (0,1,0) / 暗 (0,2,0) |
| (10') 顶栏扫光伪元素 | `.window-topbar::before` | idx=1686217 | — | `background:linear-gradient(105deg,#fff0, rgba(255,255,255,.06×f) 35%, #fff0 50%, rgba(140,180,255,.04×f) 70%, #fff0)` | (0,2,0) |
| (10'') 紧凑模式顶栏 | `.chat-window.chat-surface-mode-compact .window-topbar` | idx=1534233 | `display:none`（紧凑下顶栏不渲染） | 同 | (0,3,0) |
| (11) 外壳 backdrop-filter 模糊 | **(无现有规则)** — 外壳/root 上不存在 `backdrop-filter`；反而被反复强杀 | `index.css:1959-1960`、`2337-2338`、`16-17`、`3871-3872`、`4267-4268`（全为 `backdrop-filter:none !important`） | 无 | 无 | 强杀规则 (1,3,0)+`!important` |
| (11') 模糊实际落在哪 | `.window-topbar` blur(48px) saturate(180%)；`.composer-overflow-popover` blur(12px)；`.composer-icon-button` blur(6px)；`.compact-export-history-bubble` blur(8px) saturate(1.08) | idx=1495692 / 1518067 / 1520015 / 1555202 | 同上 | 同上 | 各 (0,1,0) |

窗口内的其它色素：`.chat-window{background:transparent}` idx=1491097（暗 idx=1685866）；`.message-list{scrollbar-width:none}` idx=1498187 且其 `::-webkit-scrollbar{width:0;height:0}` / `-track` / `-thumb` 全 `transparent`（idx=1498333/1498383/1498445）→ **消息列表自身不显示滚动条，主题无需处理**；`.app-shell` idx=1476697 只设 `font-family`。

---

## C. 输入区

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (12) `#text-input-area` | `#text-input-area` | `index.css:2476-2494` | `background:rgba(255,255,255,0.5); border-top:1px solid rgba(0,0,0,0.06); padding:12px; z-index:25` | `[data-theme="dark"] #text-input-area`（`dark-mode.css:174`）→ `background:rgba(40,40,40,0.65); border-top:1px solid rgba(255,255,255,0.06)` | 亮 (1,0,0) / 暗 (0,2,0) |
| (12') 移动端覆盖 | `html[data-theme="dark"]:not(.lanlan-pet-mode) #text-input-area` | `dark-mode.css:704` | — | `background:rgba(40,40,40,0.55); border-top:1px solid rgba(255,255,255,0.06)` | (1,2,1) |
| (13) `.composer-input` | `.composer-input` | idx=1514149 | `background:transparent; color:#1f2329; border:0; padding:12px 0 10px` | `[data-theme=dark]` → `color:#e8eaed`（idx=1694490） | 亮 (0,1,0) / 暗 (0,2,0) |
| (13') `.composer-input-shell` | `.composer-input-shell` | idx=1513575 | `background:rgba(255,255,255,calc(.91 * var(--neko-chat-opacity-factor,1))); border:1.5px solid rgba(127,144,170,.25); border-radius:16px; box-shadow:inset 0 1px #ffffffc7,0 4px 14px #596c8c0d` | `[data-theme=dark]` → `background:rgba(42,42,60,.85×f); border-color:#ffffff14`（idx=1694081） | 亮 (0,1,0) / 暗 (0,2,0) |
| (13'') 聚焦态 | `.composer-input-shell:focus-within` | idx=1513941 | `border-color:#40c5f18c; box-shadow:…0 0 0 3px #40c5f124…` | `[data-theme=dark]` → `border-color:#40c5f166; background:rgba(48,48,74,.85×f)`（idx=1694253） | 亮 (0,2,0) / 暗 (0,3,0) |
| (13''') 紧凑输入态 | `[data-compact-chat-state=input] .composer-input` | idx=1579018 | `height:42px; color:#2f526b; caret-color:#167fbd; text-shadow:0 1px 1px rgba(255,255,255,.88)` | `[data-theme=dark]` → `color:#e9f4ff; caret-color:#74d7ff`（idx=1697046） | 亮 (0,2,0) / 暗 (0,3,0) |
| (14) 占位符颜色 | `.composer-input::placeholder` | idx=1514566 | `color:#66758d80; font-size:.85em` | `[data-theme=dark]` → `#9aa0ac`（idx=1694538） | 亮 (0,2,0) / 暗 (0,3,0) |
| (14') 紧凑态占位符 | 同上（紧凑域） | idx=1579387 | `#46607aa8; text-shadow:0 1px 1px rgba(255,255,255,.88)` | `#cadef4a8; text-shadow:0 1px 2px rgba(0,0,0,.34)`（idx=1697211） | (0,3,0) |
| (15) `.composer-tool-btn` | `.composer-tool-btn` | idx=1514987 | `background:transparent; border-radius:6px; width/height:32px`；`:hover` → `#44b7fe1a`（idx=1515229） | **无 `[data-theme=dark] .composer-tool-btn{}` 基态规则**；仅 `:hover` → `#44b7fe26`（idx=1690959） | 亮 (0,1,0)，hover (0,2,0) |
| (15') `.composer-emoji-btn` | ⚠ 基态类**完全不存在**（`neko-chat-window.css` 内无 `.composer-emoji-btn{`）→ 基态 **(无现有规则)**；只有激活态 | 激活态 idx=1515275 | `.composer-emoji-btn.is-active{background:#44b7fe2e}` | 暗 `.is-active{background:#44b7fe42}`（idx=1691023）；扇形容器强制 `background:transparent`（idx=1593301） | (0,2,0) / 暗 (0,3,0) |
| (15'') `.composer-translate-btn` | `.composer-translate-btn` | idx=1522240 | `position:relative`（无色）；`img{opacity:.45}` idx=1522282；`:hover img{.7}` idx=1522351；`.is-active img{opacity:1}` idx=1522396；`.is-active…:after{background:#2497d9}` idx=1522444 | 无独立暗色规则（沿用图标自身透明度） | 基态 (0,1,0)；`::after` (0,2,0)+ |
| (15''') `.composer-overflow-btn` | `.composer-overflow-btn` | idx=1517906 | `color:#4a6478`；`svg{width:20px;height:20px}` idx=1517943；`.is-active{background:#44b7fe2e}` idx=1518013 | `[data-theme=dark]` → `color:#ffffffb3`（idx=1691567）；`.is-active{background:#44b7fe42}`（idx=1691624） | 亮 (0,1,0) / 暗 (0,2,0) |
| (15'''') `.composer-icon-button` | `.composer-icon-button` | idx=1520015 | `background:radial-gradient(circle at 30% 28%,#ffffffbd,#ffffff94 24%,#ecf6ff80 72%,#d2e8f96b); color:#12304f; border-radius:999px; box-shadow:0 10px 20px #4d7aae33,0 2px 6px #71a0d42e,inset 0 1px #fffffff2; backdrop-filter:blur(6px)` | `[data-theme=dark]` 基态 idx=1691943；hover idx=1692386；active idx=1692526 → `radial-gradient(…#fffffff5,#ebf8ffdb 34%,#c6e2f6c2 72%,#9cc9e8a8); color:#1b4f73` | 亮 (0,1,0) / 暗 (0,2,0) |
| (16) **发送按钮真身** | `.send-button-circle`（**不存在** `.composer-send-btn` / `.composer-send-button` / `.send-button` / `.composer-submit`） | idx=1525421 | `background:transparent; border:0; border-radius:50%; width/height:40px`；`:hover{transform:scale(1.08)}` idx=1525665；`:disabled{opacity:.4}` idx=1525713；`img{width:36px;height:36px}` idx=1525787 | 暗仅 `:hover{opacity:.85}`（idx=1694581）；暗紧凑态强制 `background:transparent; box-shadow:none`（idx=1697294） | 亮 (0,1,0)，hover (0,2,0) |
| (16') ⚠ 按钮可见颜色所在 | 图标 PNG（`img` 内），**CSS 无颜色声明** → 想改颜色必须换图或加 `filter` | idx=1525787 | — | — | — |
| (16'') 旧版发送按钮 | `#sendButton` / `#textSendButton` | `index.css:3906` / `3750` | `background:#44b7fe; color:#fff`；`:active` `#2ea0e0`（3917）；`:disabled` `#b0c4de`（3921 / 3760） | `#textInputBox` 相关暗色见 `dark-mode.css:179-193` | (1,0,0) |
| (17) `.composer-panel` | `.composer-panel` | idx=1511055 | `background:rgba(255,255,255,calc(.91 * var(--neko-chat-opacity-factor,1))); padding:6px; z-index:15` | `[data-theme=dark]` → `rgba(28,28,46,.91×f)`（idx=1690069）；紧凑态 `padding:0; background:transparent`（idx=1534525） | 亮 (0,1,0) / 暗 (0,2,0) |
| (18) `.composer-visit-bar` | `.composer-visit-bar` | idx=1529477 | `background:transparent; box-shadow:none; color:#334; font-size:12px` | `[data-theme=dark]` → `color:#e6ebf2`（idx=1532191） | 亮 (0,1,0) / 暗 (0,2,0) |
| (18') 徽标 | `.composer-visit-bar-badge` | idx=1529773 | `background:#44b7fe29; color:#1d6fa5; border-radius:999px; font-weight:600`；等待中 `#ffb84d33`+`#9a5b00`（idx=1529959） | `[data-theme=dark]` → `color:#9fd8ff`（idx=1532243） | 亮 (0,1,0) / 暗 (0,2,0) |
| (18'') 动作按钮（变量驱动） | `.composer-visit-bar-action` / `.full-visit-bar-action` | idx=1529706（变量块 idx=1530922） | `--visit-action-fill: linear-gradient(145deg, rgba(255,255,255,.98), rgba(235,247,255,.94)); --visit-action-hover-fill: …; --visit-action-shadow: …` | idx=1532996 → `--visit-action-fill: linear-gradient(145deg, rgba(31,47,65,.96), rgba(15,27,41,.96)); …border-color:#a6d6f64d; color:#8ed9ff` | 亮 (0,1,0) / 暗 (0,2,0) |
| (18''') 全屏出行条 | `.full-visit-bar` | idx=1532928 | `background:#44b7fe1f; color:#e6ebf2`（此值即暗色侧声明） | 同 | (0,1,0) |
| (19) `.composer-attachments` | `.composer-attachments` | idx=1511895 | `scrollbar-width:thin; scrollbar-color:rgba(96,127,166,.28) transparent`；`::-webkit-scrollbar{height:5px}` idx=1512150；`-track{transparent}` idx=1512202；`-thumb{border-radius:999px; background:#607fa647}` idx=1512272 | `[data-theme=dark]` → `scrollbar-color:rgba(95,199,255,.38) transparent`（idx=1690524）；`-thumb{background:#5fc7ff61}`（idx=1690613） | 亮 (0,1,0) / 暗 (0,2,0) |

---

## D. 面板 / 菜单 / 弹窗

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (20) `.composer-icon-popover` | `.composer-icon-popover` | idx=1518762 | `position:absolute; …; padding:4px 2px` — **无 background / 无 border**（⚠ 该属性无现有规则） | `[data-theme=dark]` → `background:transparent; opacity:1!important; filter:none!important`（idx=1691837，明令透明） | 亮 (0,1,0) / 暗 (0,2,0)+`!important` |
| (20') `.composer-overflow-menu` | `.composer-overflow-menu` | idx=1517024 | 只有 `position/animation` — **无色**（⚠ 无现有规则）；`.is-leaving` idx=1517178 | 无 | (0,1,0) |
| (20'') `.composer-overflow-popover` | `.composer-overflow-popover` | idx=1518067 | `background:#ffffffd9; border:1px solid rgba(127,144,170,.18); border-radius:12px; box-shadow:0 8px 24px #0000001f,0 2px 6px #0000000f; backdrop-filter:blur(12px)` | `[data-theme=dark]` → `background:#26263ac7; border-color:#ffffff14; box-shadow:0 8px 24px #00000080,0 2px 6px #0000004d`（idx=1691696） | 亮 (0,1,0) / 暗 (0,2,0) |
| (21) `.modal-dialog` / `.modal-overlay`（裸类） | **(无现有规则)** — `index.css` 与 `neko-chat-window.css` 均无裸类声明，亮色值只能逐个文件找 | 暗色通用块 `dark-mode.css:417-461` | 亮色分散：`index.css:20`（`.modal-dialog.modal-dialog-theater`，`background:#ffffff; color:#24445a; border:1px solid rgba(23,167,255,0.22); border-radius:22px`）、`api_key_settings.css:768`（`.modal-overlay`）、`model_manager.css:2645`（`.modal-content`）、`model_manager.css:2665`（`.modal-header h3`）、`character_card_manager.css:3038`（`.modal-content`） | `[data-theme="dark"] .modal-overlay{background:rgba(0,0,0,0.65)}`；`.modal-dialog,.modal-content{background:#2d2d2d; color:#e0e0e0; border-color:rgba(255,255,255,0.1)}`；`.modal-title{#ffffff}`（439）；`.modal-body{#e0e0e0}`（445）；`.modal-input{background:#1a1a1a; color:#e0e0e0; border-color:#777}`（450） | 暗 (0,2,0)；剧场面板 `index.css:20` 亮 (0,2,0) |
| (21') 剧场遮罩被特意清空 | `.modal-overlay.modal-overlay-theater` | `index.css:14` | `background:transparent !important; backdrop-filter:none !important` | — | (0,2,0)+`!important` |
| (21'') 串门遮罩 | `.modal-overlay.visit-persona-overlay` | `index.css:4831` | `background:transparent; pointer-events:none !important` | — | (0,2,0) |
| (22) `.composer-galgame-option` | `.composer-galgame-option` | idx=1523530 | `background:#f4f8fec7; color:#1f2329; border:1px solid rgba(127,144,170,.22); border-radius:10px`；`:hover:not(:disabled){background:#dcecfceb; border-color:#40c5f18c}`（idx=1523863） | `[data-theme=dark]` → `background:#36405a99; border-color:#ffffff1a; color:#e8eaed`（idx=1693326）；hover `#48608ec7`/`#40c5f173`（idx=1693427）；`.composer-galgame-option-label{color:#44b7fe}`（idx=1693535） | 亮 (0,1,0) / 暗 (0,2,0) |
| (22') `.composer-galgame-slot` | `.composer-galgame-slot` | idx=1523243 | `max-height:0; overflow:hidden; opacity:0; transition:…` — **无颜色**；`.is-open` idx=1523374 仍无色 | **无暗色规则**（⚠ 颜色无现有规则） | (0,1,0) |
| (22'') 选项容器 | `.composer-galgame-options` | idx=1523432 | `display:flex; …; gap:4px`（无色）；紧凑覆盖 `index.css:2011/2012/2016` | 无 | (0,1,0) |
| (22''') 相邻弹窗（角色工具管理） | `.avatar-tool-manager-dialog` | idx=1615512 | `background:linear-gradient(180deg,#fafefff5,#ebf7fdeb); color:#1b3347; border:1px solid rgba(115,195,229,.46); border-radius:8px` | `[data-theme=dark]` → `linear-gradient(180deg,#1f3042f5,#101d2cf0); color:#e7f3ff; border-color:#76bef238`（idx=1699690） | 亮 (0,1,0) / 暗 (0,2,0) |

---

## E. 推荐 / chip

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (23) `.proactive-recommendation-bubble` | `.proactive-recommendation-bubble` | idx=1714043 | 只有 `gap:11px` — **自身零颜色声明** → 背景/文字色 **(无现有规则)** | 无 | (0,1,0) |
| (23') 颜色真正的来源（祖先变量） | `.proactive-recommendation` | idx=1710839 | `--recommendation-text:#344b5d; --recommendation-muted:#637987; --recommendation-accent:#3c7894; --recommendation-tint:#edf6f9; --recommendation-line:rgba(108,151,174,.18); color:var(--recommendation-text)` | `[data-theme=dark]` → `--recommendation-text:#e2e9ee; --recommendation-muted:#9aaab6; --recommendation-accent:#94c5da; --recommendation-tint:#304653; --recommendation-line:#41545f`（idx=1714610） | 亮 (0,1,0) / 暗 (0,2,0) |
| (23'') 卡片 | `.proactive-recommendation-card` | idx=1711145 | `background:#fff; border:1px solid var(--recommendation-line); border-radius:18px; width:288px` | `[data-theme=dark]` → `background:#28343f`（idx=1714812） | 亮 (0,1,0) / 暗 (0,2,0) |
| (23''') 唯一子元素时清空气泡皮 | `.message-bubble-assistant:has(>.proactive-recommendation-card:only-child)` | idx=1711343 | `padding:0; border:0; background:transparent; box-shadow:none` | 无 | (0,3,0) (`:has()` 计最高参数) |
| (23'''') 图标 / 文案 / 按钮 | `.proactive-recommendation-icon`（基态 `width:34px; background:var(--recommendation-tint); color:var(--recommendation-accent)`；气泡内覆盖为 `26px` idx=1714266）、`-heading strong{font-size:13px}` idx=1714509、`.proactive-recommendation-accept{color:#39718d; background:var(--recommendation-tint); border-color:#67a3bd2e}`、`-skip{color:#637687; background:transparent}`、hover `{background:#e0eff5}` | idx=1714266 / 1714509 / 1714880 | 见左 | 暗 accept `{color:#acd3e2}`（idx=1714880） | (0,1,0)～(0,2,0) |
| (24) `.music-recommendation-bubble` | `.music-recommendation-bubble` | idx=1709471 | `display:grid; gap:8px; max-width:100%` — **自身零颜色** → 背景/文字色 **(无现有规则)** | 无 | (0,1,0) |
| (24') 图标（唯一自带颜色处） | `.music-recommendation-icon` | idx=1709548 | `background:#edf6f9; border-radius:8px; width/height:26px` | `[data-theme=dark]` → `background:#304653; color:#94c5da`（idx=1709816） | 亮 (0,1,0) / 暗 (0,2,0) |
| (24'') 倒计时 | `.music-recommendation-countdown` / `-track` / `-fill` | idx=1706100 / 1706220 / 1706324 | `color:var(--text-secondary,#69768b)`；`-track{background:#5a9ad22e}`；`-fill{background:#65b9ed}` | 无暗色规则（沿用变量） | (0,1,0) |
| (25) `.system-chip` | `.system-chip` | idx=1510151 | `background:#f2f6fcf5; color:#2f435e; border:1px solid rgba(74,99,135,.24); border-radius:999px; box-shadow:0 8px 20px #1f375924` | `[data-theme=dark]` → `background:#1e2a3bf5; color:#edf4ff; border-color:#89a9cf47; box-shadow:0 8px 22px #00000057`（idx=1689787） | 亮 (0,1,0) / 暗 (0,2,0) |
| (25') chip 内部 | `.system-chip-source`（`border:1px solid currentColor; opacity:.7`）idx=1509971；`.system-chip-time{color:#536983}` idx=1510432；`.system-chip-content` idx=1510464；`.system-chip .message-block-text{white-space:normal}` idx=1510682 | 见左 | 见左 | `.system-chip-time{color:#bfd0e5}`（idx=1689908）；`.system-chip .message-action-button.variant-secondary{color:#e1ecfb; background:#7e9dc742}`（idx=1702041） | (0,1,0)～(0,2,0) |
| (26) `.compact-export-history-bubble` | `.compact-export-history-bubble` | idx=1555202 | `background:#ffffffe0; color:#273042; border:1.5px solid transparent; border-radius:8px 16px 16px; box-shadow:0 7px 18px #16305414; backdrop-filter:blur(8px) saturate(1.08)` | `[data-theme=dark]` → `background:#212d3ee0; color:#e8f0fb; box-shadow:0 8px 20px #00000047`（idx=1701219） | 亮 (0,1,0) / 暗 (0,2,0) |
| (26') `.compact-export-preview-bubble` | `.compact-export-preview-bubble` | idx=1577766 | `background:#ffffffad; color:#273042; border-radius:8px 14px 14px; box-shadow:0 6px 15px #1630540f` | `[data-theme=dark]` → `background:#212d3eb8; color:#e8f0fb; box-shadow:0 8px 18px #0003`（idx=1705213） | 亮 (0,1,0) / 暗 (0,2,0) |
| (26'') 预览用用户侧 | `.compact-export-preview-message.is-user .compact-export-preview-bubble` | idx=1578058 | `border-radius:14px 8px 14px 14px; background:#d0e7ffb3` | 无独立暗色规则 | (0,3,0) |
| (26''') 相关元信息 | `.compact-export-history-message.is-visit-peer .compact-export-history-meta{color:#563b89c2}` idx=1556904；`.is-system .compact-export-history-meta{color:#536983}` idx=1557259 | 见左 | 见左 | 无 | (0,2,0) / (0,3,0) |

---

## F. 全局

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (27) 裸 `a {}` 链接色 | **(无现有规则)** — `index.css`、`base.css`、`neko-chat-window.css` 均无裸 `a{}` | — | 无（浏览器默认蓝） | `[data-theme="dark"] a{color:#5cb8f0}`（`dark-mode.css:674`）；`a:hover{color:#7ccaff}`（`dark-mode.css:678`） | 亮 — / 暗 (0,2,0) |
| (28) `::selection` | 亮色 **(无现有规则)**（全仓库仅 3 条 ::selection） | — | 无 | `[data-theme="dark"] ::selection{background:rgba(74,163,223,0.4); color:#fff}`（`dark-mode.css:683`）；React 侧 `[data-theme=dark] ::selection{background:#44b7fe66}`（idx=1685815） | 亮 — / 暗 (0,1,1) |
| (29) `::-webkit-scrollbar` 是否存在 | **存在，但没有全局亮色基础规则**；亮色全是带作用域的 | 亮色作用域：`#chat-content-wrapper` `index.css:1430{width:6px}` / `1434 -track{rgba(249,249,249,0.95)}` / `1438 -thumb{rgba(0,0,0,0.15); border-radius:3px}` / `1443 -thumb:hover{rgba(0,0,0,0.25)}` / `1448 -corner`；另有 `#screenshots-list` `3025/3029/3033/3038`、`.chat-export-selection-list` `4503/4507`、`body > .compact-chat-choice-anchor[…]` `2007`；Firefox 侧 `index.css:1421 scrollbar-width:thin`、`1422 scrollbar-color:rgba(0,0,0,0.15) rgba(249,249,249,0.95)`、`1425` hover | 暗色**两层**：①`dark-mode.css:1757-1773`（`width:6px;height:6px`、`-track{transparent}`、`-thumb{rgba(74,163,223,0.35)}`、hover `0.55`）；②**终结战** `dark-mode.css:2910-2932` 全 `!important`（`8px`、`-track{rgba(0,0,0,0.25)}`、`-thumb{rgba(255,255,255,0.2); border-radius:4px}`、hover `0.35`、`-corner{transparent}`）；另 `dark-mode.css:2937 [class]{scrollbar-color:rgba(255,255,255,0.22) rgba(0,0,0,0.25)}`、`2966-2970 [data-theme="dark"],…,*{scrollbar-color:…!important}` | 亮作用域最高 (1,1,1)～(1,2,1)；暗②为 (0,1,2)+`!important` 与 (0,1,0)+`!important` |
| (30) `--focus-glow` / `--focus-breath` 值 | **CSS 内从未声明（无现有规则）**；由 JS 运行时写入 | `resources/bin/static/react/neko-chat/neko-chat-window.es.js:62325-62337`（`T.style.removeProperty("--focus-glow")`、`f(T,"--focus-glow",L.toFixed(3))`、`--focus-breath`） | 无静态值 | 无静态值 | — |
| (30') 变量的消费处（想改色要动这些） | `.app-shell[data-focus-active=true] .chat-window{animation:chat-surface-focus-breathe 4.2s ease-in-out infinite}` idx=1491253（减弱动效版 `box-shadow:inset 0 0 12px #96beff33` idx=1491518）；`.app-shell.chat-surface-mode-compact[data-focus-glow=true] .compact-chat-surface-frame{box-shadow:0 0 0 1px rgba(150,190,255,calc(.3+.5*var(--focus-glow,0))),…}` idx=1494233；`[data-focus-breathing=true]` idx=1494621；另 idx=1491964 / 1492430 / 1492988 / 1493453 四条 `inset` 光晕 | 见左 | 颜色硬编码 `rgba(150,190,255,…)` / `rgba(165,205,255,…)` / `rgba(120,170,255,…)`，只有强度走变量 | 无暗色变体 | 各 (0,3,0)～(0,4,0) |
| (31) 气泡/面板使用的 border-radius | 气泡：`.message{12px}` `index.css:2434`；`.message-bubble{8px 16px 16px}` idx=1501271；`.message-bubble-user{16px 8px 16px 16px}` idx=1501540；`.compact-export-history-bubble{8px 16px 16px}` idx=1555202；`.compact-export-preview-bubble{8px 14px 14px}` idx=1577766（用户侧 `14px 8px 14px 14px` idx=1578058）；`.message-block-link{12px}` idx=1508143；`.message-block-image{12px}` idx=1506287；`.message-block-status{10px}` idx=1508805；`.system-chip{999px}` idx=1510151 | 见左 | 同上 | 无暗色差异（圆角不随主题） | 各 (0,1,0)～(0,2,0) |
| (31') 面板/输入框圆角 | `.composer-input-shell{16px}` idx=1513575；`.composer-overflow-popover{12px}` idx=1518067；`.composer-galgame-option{10px}` idx=1523530；`.proactive-recommendation-card{18px}` idx=1711145；`#react-chat-window-shell{22px}` `index.css:1662`（紧凑 `28px` `index.css:1677`）；`.modal-dialog.modal-dialog-theater{22px}` `index.css:26` | 见左 | 同上 | 无暗色差异 | 见左 |

---

## G. 非颜色

| 目标 | 选择器 | file:line | 亮色值 | 暗色值 | 特异性 |
| --- | --- | --- | --- | --- | --- |
| (32) 气泡正文字号 | `.message-block-markdown` | `neko-chat-window.css idx=1503738` | `min-width:0; font-size:.94rem; line-height:1.58`（该选择器上**唯一**的字号声明；未发现响应式覆盖） | 无暗色差异 | (0,1,0) |
| (32') 同族排版 | `.message-block-text, .message-block-markdown, .composer-input, .compact-chat-capsule-text{font-family:var(--neko-chat-content-font); font-weight:500; font-synthesis:weight}` | idx=1502480 | 见左 | — | (0,1,0) |
| (33) `--neko-ui-font` / `--neko-chat-content-font` | `:root` | idx=1475788 | `--neko-ui-font: "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;` `--neko-chat-content-font: "Neko Chat Hand","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;` 另有 `color:#1f2329; font-family:var(--neko-ui-font); line-height:1.5; text-rendering:optimizeLegibility; -webkit-font-smoothing:antialiased` | 无暗色重定义 | `:root` (0,1,0) |
| (33') 预设切换 | `:root[data-neko-chat-font-preset=system]` | idx=1476169 | `--neko-chat-content-font: var(--neko-ui-font)` | — | (0,2,0) |
| (33'') 字体来源 | `@font-face{font-family:Neko Chat Hand; src:url(/static/react/neko-chat/assets/Yozai-Medium.ttf)}` | idx≈1475650 | — | — | — |
| (33''') 变量消费者 | `.app-shell{font-family:var(--neko-ui-font)}` idx=1476697；`.composer-choice-layer, .composer-visit-layer, .avatar-tool-manager-dialog{font-family:var(--neko-ui-font)}` idx=1476777 | 见左 | — | — | (0,1,0) |
| (33'''') 关键结论 | 两个变量**只**在 React 样式表里定义；`resources/bin/static/css/*` 中没有任何文件声明它们 | — | — | — | — |

其它全局基础（`base.css`，全文 48 行）：`*:focus{outline:none}`（第 4 行）；`a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,[role="button"]:focus-visible,[tabindex]:not([tabindex="-1"]):focus-visible{outline:2px solid #40C5F1; outline-offset:2px; box-shadow:0 0 0 4px rgba(64,197,241,0.2)}`（9-19）；`.btn:focus-visible,.close-btn:focus-visible,.model-header:focus-visible{outline:2px solid #40C5F1; outline-offset:2px}`（22-27）。

---

## 未覆盖项与风险

1. **`[data-theme=dark]` 前缀自带 +1 class 级特异性，主题样式表用 `html body X` 在暗色下会输。**
   `html body .system-chip` = (0,1,2)，而 `dark-mode.css` / React 的 `[data-theme="dark"] .system-chip` = (0,2,0)。两边都用 `!important` 时**按特异性决胜，暗色规则赢**。同理：`html body .window-topbar`(0,1,2) 输给 `[data-theme=dark] .window-topbar`(0,2,0)；`html body #text-input-area`(1,0,2) 输给 `[data-theme="dark"] #text-input-area`(1,1,1)；`html body .message.user`(0,2,2) 输给 `[data-theme="dark"] .message.user`(0,3,0)。
   → 覆盖暗色必须写成 `[data-theme="dark"] html body <selector>`（或再叠一个类）才能压住原生。

2. **两套命名并存，主题只打一版会漏掉另一半。**
   旧版（`index.css`/`dark-mode.css`）：`.message.user`、`.message.gemini`、`#text-input-area`、`#sendButton`/`#textSendButton`。
   React（`neko-chat-window.css`）：`.message-bubble-user`、`.message-bubble-assistant`、`.composer-input-shell`、`.send-button-circle`。
   两套**互不匹配**。主题只写 `.message.user` 就改不到 React 气泡——React DOM 里没有 `.message.user`，只有 `.message-bubble-user`（用户）和 `.message-row-user .message-stack` 这类行容器。

3. **`theme-studio/app/css/neko-theme-studio.css` 已有 4 处「打空」的选择器**（该文件 306 行，正好是本清单要服务的那份主题表）：
   - `neko-theme-studio.css:172-175` 写 `.composer-send-btn` / `.composer-send-button` / `.send-button` / `.composer-submit` —— 这 4 个类名在全部原生 CSS 里**都不存在**（实测 `.send-button{` 匹配 0 处），真实类名是 `.send-button-circle`，且其 `background` 是 `transparent`，可见颜色在 PNG 图标里 → 想给发送按钮上色只能换图或加 `filter`。
   - `neko-theme-studio.css:36-39` 写 `.message.ai` / `.message.assistant` —— 原生从未定义；React 对应物是 `.message-bubble-assistant`。
   - `neko-theme-studio.css:28` 写 `.message-block.user` —— 原生无此组合；React 用户态是 `.message-bubble-user`。
   - `neko-theme-studio.css:110-114` 给 `#react-chat-window-shell::before/::after` 加 `backdrop-filter` —— 该伪元素在非 `body.subtitle-web-host` 场景下**不存在**（`index.css` 只在 `body.subtitle-web-host …` 下写 `::before/::after{content:none!important}`），所以这条规则目前是空转；真正的毛玻璃在 `.window-topbar`（blur(48px)）与各 popover 上。
   - `neko-theme-studio.css:117-123` 的 `html body ::-webkit-scrollbar-thumb`(0,0,3) 在暗色下输给 `dark-mode.css:2920` 的 `[data-theme="dark"] ::-webkit-scrollbar-thumb`(0,1,2)+`!important`。

4. **暗色滚动条有 `!important` 终结层，且 Chromium 121+ 会让 webkit 伪元素失效。**
   `dark-mode.css:2910-2932` 是一层全 `!important`；`dark-mode.css:2966-2970` 又用 `[data-theme="dark"], [data-theme="dark"] body, [data-theme="dark"] *{scrollbar-color:rgba(255,255,255,0.22) rgba(0,0,0,0.25) !important}`。文件内注释（`dark-mode.css:2957-2964`）明确指出：Chromium 121+ 一旦设置了 `scrollbar-color`，`::-webkit-scrollbar-*` 自定义伪元素会被**完全忽略**。要改暗色滚动条，优先改 `scrollbar-color`，并保证选择器能压住 `[data-theme="dark"] *`+`!important`。

5. **`--focus-glow` / `--focus-breath` 不是 CSS 变量而是运行时注入值**（`neko-chat-window.es.js:62325-62337`）；它们只控制**强度**，颜色硬编码在 `rgba(150,190,255,…)` 一类字面量里（idx=1491964 / 1492430 / 1492988 / 1493453 / 1494233 / 1494621）。想换焦点光晕颜色只能覆盖这些 `box-shadow` 整条声明，改 `--focus-glow` 无效。

6. **气泡内文本色的继承链**：`.message-block*` 全部无颜色声明，文字色只由气泡本体 `.message-bubble-assistant/-user`（或旧版 `.message.user`/`.message.gemini`）给出。只改 `.message-block-markdown` 的 `color` 会与本体色打架（本体色更靠上、且暗色带 `[data-theme=dark]` 前缀），建议同时覆盖气泡本体。

7. **`.composer-icon-popover` 被暗色规则显式设为 `background:transparent; opacity:1!important; filter:none!important`**（idx=1691837），且带 `!important` 的 `opacity/filter` —— 主题只想加背景色时要留意这条会重置 `filter`。

8. **图片块不随主题变**：`.message-block-image` 只有 `background:transparent` 且**无暗色规则**（`message-block-image` 在 React 表中共 9 处匹配，均为尺寸/交互，无配色）。要改只能改图片本身或外层气泡。

9. **紧凑（compact）形态有一整套独立配色**（`.compact-chat-surface-frame` 的 `--compact-chat-surface-bg` 渐变 idx=1694637，紧凑占位符 idx=1579387/1697211，紧凑发送按钮 idx=1697294，紧凑态顶栏 `display:none` idx=1534233）。只覆盖桌面态会在紧凑形态下露馅。

10. **未取到行号的文件**：`resources/bin/static/react/neko-chat/neko-chat-window.css` 是单行压缩文件（1,717,526 字符），**无法给出行号**，全部以 `idx=` 字符偏移引用；其余引用均为真实 `file:line`。
