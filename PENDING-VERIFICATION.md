# 待验证队列（verifier 结束后一次性跑）

> ⚠ **归档文档（不再更新）**：本文件保留 0.1.4 → 0.1.10 期间的逐轮验证日志、量测记录与「故意不修」清单，
> 供追溯当时的判断依据。**当前版本的用户可见变更请看 [`CHANGELOG.md`](CHANGELOG.md)**；
> 安装、校验、打包的现行做法看 [`README.md`](README.md) 与 [`DISTRIBUTION.md`](DISTRIBUTION.md)。
> 文中的版本号、文件尺寸、sha256 与「待办」都是**当时**的事实，不要当成当前状态执行。

在 `verify-v3` 报告之前**不写任何东西**：所有 `install.ps1` / `accept.ps1` /
`build-theme-css.ps1` / `page-eval` 探针都会改 theme.json 或重启插件服务，
污染它的量测。本文件只是把「等它说完要做的事」写下来，不执行。

## 背景：为什么现在必须停手

`verify-v3` 报告 theme.json 的 version 在 6 分钟内走了 `144 -> 1 -> 16`，并正确地
把它标记为「量测期间有人写入」。**那基本是我自己**：20:44–20:50 我跑了两次
`install.ps1`（内部会 `/plugins/reload`，重启插件服务）和三次 `accept.ps1`
（C/E 组调 `reset_theme`、D 组调 `apply_theme` 写 17 个变量）。
`panel-controls` 只改静态文件，已另行通知它不要碰 entry API。

教训（值得写进验收流程）：**一个会自动写共享状态的自检套件，不能在另一个
量测者正在取证时运行。** 真实页量测依赖「谁在写调色板」这一前提，破坏它就
等于破坏证据。

## 队列（按顺序，全部在 verifier 说明结束后才动）

1. **重跑 `test\accept.ps1`** —— 确认 `plugin\README.md` 与 `plugin\static\app.js`
   的最终版本没有破坏 F1（面板 UI 实操）。当前源与安装副本：
   - `plugin\static\app.js` 50138B，两边 sha256 一致（`3F50CF0C836FB7B0`）
     > 历史快照：这是**面板 UI 改版前**的尺寸。当前 `app.js` 1645 行 / 68K、`style.css` 1250 行 / 32K、
     > `index.html` 155 行 / 8K（详见文末「面板 UI 改版」），重跑 `install.ps1` 后两边应再次一致。
   - `plugin\README.md` 源 25031B vs 安装副本 25020B，**不一致**
     （panel-controls 在我上次 install 之后又改了 README）
   → 必须重跑 `install.ps1` 让安装副本与源同步，否则用户从市场装到的 README 是旧的。

2. **重跑 `install.ps1`** —— 验证 F7 的重启窗口重试逻辑（本次新增）。
   已单独验证过一次：`[OK] 已打开自动启动` / `[OK] 插件已在运行（status = 'running'）`
   / `✅ 全部通过（11 项）`。但那是 panel-controls 再改 README 之前的。
   期望：11/11 PASS、exit 0、插件 `running` + `auto_start=True`。

3. **重跑 `tools\build-theme-css.ps1`** —— 确认 `panel-controls` 的 README/app.js
   改动没有碰到 CSS 生成链。期望：exit 0、无 `fallback` 字样、
   零变化亮暗各 0 差异、覆盖亮暗各 110/110、第 5 步真实页 A/B 0 diff。

4. **`test\expr-verify-v3.js` 复跑** —— 确认 10 项 verdict 仍全 True
   （尤其 A 空调色板 0 差异、D `--nts-chat-opacity` 到达 0.33）。

5. **`plugin\__init__.py` 的 KNOWN_VARS 行为验证** —— 新增的未知变量名拒绝
   尚未在活服务上实测（只在文件层面核对过双向差集为 0）。
   要跑：`apply_theme` 传 `--nts-nope-var:'#fff'` 必须进 `rejected` 且**不落盘**；
   传 59 个合法名字之一必须被接受。
   期望：`rejected: ["vars: 未知变量名已拒绝 '--nts-nope-var'（拼写错误？见 README 变量清单）"]`。

6. **核查 v3 下是否还有「面板有控件、CSS 无人消费」** —— v3 全门控后
   这个检查的判据要改成「面板 CATALOG 的 key 集合 ⊇ 后端 KNOWN_VARS ⊆ CSS 出现的
   `--nts-*` 集合」，三者双向差集都应为空。已核对过前两者（59/59/59）。

7. **`THEME_CONTRACT.md` 归档** —— 已更新 §3.0/§3.1/§5/§8/§9.10–§9.12；本轮又补了
   §9.11（F7 重启窗口）与 §9.12（自建套件共享盲区，必须派对抗性验证者）。
   待 verifier 报告后如需再改，一并改完再定稿。

## 已知的、**故意**不修的东西（避免以后被当成缺陷重新"修"一遍）

- `plugin\static\theme.json` 出厂为空 `{"vars":{},"dark_vars":{}}`。这是故意的：
  任何 pin 死的默认值都会在「用户没配过」时改动外观。`reset_theme` 也回到空。
- 面板 CATALOG 的 `native` 字段**从不被读取**，只有 `.darkNative` 与 `.hint`
  会到用户眼前。`native` 只是文档；要影响用户必须写进 `hint`。
- 亮/暗两组**各管各的**（用户已拍板）：只配亮色时暗色保持原生，反之亦然。
  这不是缺陷，是需求。
- `--nts-button-hover-bg` 与 `--nts-highlight`（`::selection`）在静态页上
  无法验证（无指针 / 无选区），只能门控 + 真实页手测。
- 五处「无法在静态页判定」的量测行：`::selection | background-color`
  （UNQUERYABLE）+ 4 项 `:focus-visible`/`:hover`（NO-PSEUDO-STATE）。
  分母里已排除，不是覆盖缺口。
- 市场里没有本插件（134 项里 `theme` ×0）。用户说的「从插件市场安装」目前
  只能靠 `install.ps1` 或 `imported` 包；真上架市场是另一件事。

## 运行期判据（本轮新增，静态排查到此为止）

静态层面已经逐项排除：面板/后端/loader 三处校验器 464 用例 0 不一致；CSS 的 64 个目标选择器
在 `resources/bin/static` 全量 CSS 里全部存在；React bundle 无内联 `!important`（仅 2 处
Suspense 的 `display:none`）；页面无 CSP、无 shadow DOM、无 iframe；部署副本与源码 sha256 相同；
模板补丁渲染正常。**因此故障只可能出在运行期状态**，判据必须来自真实页面。

为此新增两个工具（不改动任何运行时行为，纯诊断）：

1. `theme-studio/test/diagnose-in-app.js` —— 在应用窗口 DevTools Console 整段粘贴即可运行的
   一次性表达式。按链路顺序检查 **12 项**：`loader-mounted` → `loader-version` → `css-link` →
   `css-sheet` → `fetch-theme-json` → `palette-nonempty` → `enabled` → `mode-has-values` →
   `style-injected` → `gates-applied` → `var-resolves` → `bubble-colored`，
   输出 `verdict = CHAIN OK | BREAK AT: <第一处失败>`。
   已在 jsdom + 真实 loader 下对 **9 个场景**验证过判读正确性（全链路通 / 调色板空 / loader 缺失 /
   拉取失败 / 暗色只配亮色 / 亮色只配暗色 / 主题被禁用 / CSS 解析不出规则 / loader 旧版无版本号），
   9/9 符合预期。后两项是自检中新增的：`<link>` 存在≠CSS 加载成功；旧 loader 缺 `scriptVersion` 是真实的部署漂移信号。
2. `theme-studio/test/diagnose-live.ps1` —— 包装 `tools/page-eval.js`，自动找 Chrome/Edge，
   用无头真 Blink 跑同一表达式。**本机无 Windows/PowerShell，未实跑，属 PENDING**；
   用户在真机跑一次即可把它从 PENDING 划掉。

配套文档：`theme-studio/TROUBLESHOOT.md`（按 verdict 的修法对照表 + 三个「以为是 bug 其实不是」）。

### loader 侧本轮同时修掉的两个隐性格（已同步到 `resources/bin/static/neko-theme-studio.js`）

- 旧 `fetchPalette` 只比 `version`：插件被重置后版本号回到 1、而缓存里也是 1 → **永远不再应用**。
  现改为「版本号 + `JSON.stringify` 内容」双判等才跳过。
- 面板「应用」在没有任何改动时仍提示成功（虚假成功）。现改为：亮/暗改动数与 `enabled` 都没变时
  直接告警「没有可应用的改动」；成功提示带上「亮色 N 项 / 暗色 M 项」与「只改了一组」的模式提醒。

### 自检轮（loader v1.1.0）再修掉四处

- **加了 `SCRIPT_VERSION` / `NekoThemeStudio.scriptVersion`**：新 CSS + 旧 loader（老条纹无 `data-nts-l-*` 门控）会让每条规则都门控失败 → 全无颜色，且完全静默。现在 `diagnose()` 与自检脚本都能直接看出 loader 版本。
- **number 类百分比归一**：`50%` → `"0.5"`，数值 >100 三方皆拒。踩坑记录：原正则 `/^[0-9]{1,3}(\.[0-9]+)?%$/` 的唯一捕获组是**小数部分**，直接取 `m[1]` 会让 `50%` 取到 undefined（判非法）、`33.3%` 取到 `.3`（算成 0.003）；已改用专用正则 `RE_PCT_FULL` + `pctToFraction()`。
- **样式表未加载时大声报警**：`document.styleSheets` 里找不到 `neko-theme-studio.css` 时 `console.warn` 一次（否则变量注入成功、无规则消费，表现就是"什么都没变"）。
- **storage 事件按「raw JSON + version」双判等**（原来只比 version，与 `fetchPalette` 口径不一致）。
- **只在单侧模式配了色时大声报警**：`applyPalette` 之后检查「当前模式（`html[data-theme]` / `.dark` / 系统配色）
  这一组是否为空、另一组是否有值」，是则 `console.warn` 一次并说明亮暗各管各的；
  `boot()` 里挂 `MutationObserver` 监听 `data-theme`/`class` 变化后重查（用户先配亮色、再切暗色的场景）。
  这是「面板显示已应用、本体一点没变」的头号成因，以前完全没有运行时反馈。
- **启动横幅**：`boot()` 打一行 `console.info('[theme-studio] loader v1.1.0 已加载，端点 …')`，
  「本体到底有没有加载到脚本」不必再靠猜。

三方校验器差分（`_local_verify/three_way.js` + `corpus.json`，59 变量 × 边界值 = 1894 cases）
**现为 0 不一致**。修前 191 例分两类：4 位 hex `#ffff`（面板/后端补 `[0-9a-f]{4}`）、
`50%`/`100%`/`101%`（面板/后端收、loader 拒）。另外后端/面板加严了负数拦截后，
loader 也镜像了同一条规则（负长度/负模糊一律拒），并移除了只有 loader 认的 `var(--nts-*)` 派生色：
独立语料 `_local_verify/backend/loader_vs_backend.js`（2124 例）同样 0 分歧。

> 注意：面板代码装在 `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\`，**改动要重跑
> `theme-studio/install.ps1` 才生效**；loader/CSS 在 `resources\bin\static\`，同样由 install 复制。

---

## 面板 UI 改版（插件 v0.1.2）—— 本机能测的都测了，剩下靠眼睛

三个文件全量重写：`plugin/static/style.css`（1250 行 / 32K，12 节，含暗色 token 与四个断点）、
`plugin/static/index.html`（155 行 / 8K，保留全部旧 id，面板从此有结构化的头部/工具栏/footer）、
`plugin/static/app.js`（1311 → 1645 行）。要点：

- **每行五列**：标签（含「已改 / 已清空」状态标记）｜色块或类型标签｜输入｜透明度或原生参考值｜清空按钮。
  颜色行以前**没有**清空按钮，要清掉一个已保存的颜色只能手删十六进制框 —— 本次补齐。
- 输入框 `placeholder` 显示该变量的原生参考值（`原生 #44b7fe` / `原生 12px`），
  长值退回「留空 = 原生」，省掉「我该填什么」的猜。
- 工具栏：搜索过滤（标签/变量名/提示文字）、只看改动、全部收起/展开；
  状态栏与通知有了 ok / warn / error / busy 四态（底部状态点 + 左侧色条 + 应用按钮 spinner）。
- 键盘：`/` 聚焦搜索、`Ctrl/⌘+Enter` 应用、`Esc` 清搜索或关弹窗、模式页签左右方向键、
  弹窗 Tab 焦点陷阱并在关闭后归还焦点；分组标题 `role=button` 可回车/空格折叠。
- 面板自身支持 `prefers-color-scheme: dark`（跟随**系统**，不是应用窗口里的亮/暗主题 —— 它在跨源 iframe 里）。
- 读取时顶部 2px 进度条；分组标题吸顶；提示文字默认单行、悬停展开；`prefers-reduced-motion` 下关掉动效。

配色对比度按 WCAG AA 小字标准（≥4.5:1）逐个算过并调整了 token：亮色 faint 5.07 / accent 5.18 /
danger 5.39 / ok 5.11 / warn 5.40、主按钮白字 5.18；暗色 faint 5.91 / accent 6.66、主按钮白字 4.92
（暗色不能直接拿 `--accent` 当按钮底色：白字只有 2.54，已单列 `--accent-fill`）。
随时可用 `_local_verify/ui_contrast.js` 复算。

本机跑过的验证（全部 exit 0）：`test/panel-smoke.js` 18/18、新建 `test/panel-ui.js` 41/41
（搜索命中数与 CATALOG 对齐、无命中提示、清空搜索、只看改动、颜色行清空按钮提交空串、
placeholder、分组折叠、复制 dump）、`_local_verify/ui_consistency.js`（app.js 引用 47 个 id
全部存在、无 CSS 类缺失）、三方与后端回归（1894 / 2124 例 0 分歧、206/206、acceptance_v2 全通过）。

**需要在 Windows 上人工看的（本机是 aarch64 容器，装不了 Chromium，无法真渲染）**：

1. 重跑 `install.ps1` → 打开面板，确认 1080px / 900px 以下 / 760px 以下三档布局不重叠、不横向滚动；
2. 把系统切到暗色（Windows 设置 → 个性化 → 颜色），确认面板整体跟着变暗、色块与文字对比度可读；
3. 键盘走一遍：`/` 搜索 → `Enter` 跳行 → 改值 → `Ctrl+Enter` 应用；`Esc` 关导出弹窗后焦点回到「导出」按钮；
4. 重跑 `test\accept.ps1`，确认 F1（真实面板键入→应用→落盘→重置）仍全绿 —— 它依赖
   `#btn-apply` 文案「应用（1 项改动）」、`.row.is-dirty`、`#notice` 文本，这三处本次没改语义；
5. 若发现按钮文案/行高与预期不符，多半是安装副本没更新：面板装在
   `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\`，改动必须重跑 `install.ps1`。


---

## 缺陷审计轮（插件 v0.1.3 / loader v1.1.1）—— 「改了没反应」的几类真实原因

这一轮不只看静态契约，而是按真实交互（jsdom 逐键输入、点色板、拖滑块、点清空、应用）复现并修掉：

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | 值是 `transparent` 的行，点色板选实色，画面依旧全透明 | 选中新颜色时继承了当前 alpha=0 | 全透明时按实色（alpha=1）处理；滑块本来就被置灰 |
| 2 | 值 `transparent` 在十六进制框里显示成 `#000000` | 解析后按 RGB 回写，丢了 alpha=0 | 全透明显示 `transparent`，滑块 disabled 并给出 title |
| 3 | 干净行点「清空」凭空多出 1 项改动 | 无条件记 `cleared`，提交空串 | 服务器本来没有该键时只撤销本地编辑；有值才记删除 |
| 4 | 改「聊天气泡圆角」，预览纹丝不动 | 预览所有圆角都读 `--nts-radius` | 外壳读 `--nts-shell-radius`、气泡读 `--nts-bubble-radius`，缺失才回退通用值 |
| 5 | 阴影/字体族逐个字符敲，空格被吃掉（`0 2px` → `02px`、`Segoe UI` → `SegoeUI`） | 每次 `input` 都 trim 后回写输入框 | 输入中保留原文、只对 trim 后的值做校验；`change` 时才定稿 |
| 6 | 合法 box-shadow 面板显示已应用，本体却没阴影 | 三处校验都只做 token 白名单，放行 `0 0 10% #000`（百分比非法）、`1px`（长度不足）、5 个长度等浏览器会整条丢弃的值；loader 还把 `rgba(0, 0, 0, .2)` 按空格拆碎 | 三处统一按 `inset? && length{2,4} && color?` 结构校验；loader 新增括号感知的 `shadowTokens()` |
| 7 | 清空「毛玻璃模糊」后预览仍带滤镜 | 预览只在有值时才写 `backdrop-filter` | 改为 `!== undefined` 判断并写空串；裸长度 `18px` 预览时归一成 `blur(18px)` |
| 8 | 应用后因后端拒绝而没生效的值，面板上直接消失 | 成功后无条件清空 `edited/cleared` | 解析 `rejected` 里的变量名，把原值回填并提示「已把原值放回面板便于就地修正」 |
| 9 | 应用一次后，全透明行的透明度滑块又能拖了（拖出纯黑） | `setBusy(false)` 无条件启用所有行控件 | 解锁时逐行重算：`transparent` / 解析失败的行继续置灰 |
| 10 | 搜索后按回车，焦点落在色块（无法键入） | `firstVisibleRow()` 第一个匹配是 `input.swatch` | 只找 `input.hex, input.raw` |
| 11 | 调试 API `NekoThemeStudio.clear()` 后调色板再也回不来 | `currentVersion/lastRaw` 没重置，轮询判定「无变化」 | `clear()` 一并重置判等缓存 |
| 12 | `diagnose()` 报的模式与实际级联不一致 | 只看 `data-theme`，忽略 `.dark` 类与 `prefers-color-scheme` | 改用 `currentMode()` |

验证（全部 exit 0）：`_local_verify/panel_bugs.js` 11 项（透明/清空/预览圆角/模糊/阴影标红/被拒回填）、
`test/panel-smoke.js` 18/18、`test/panel-ui.js` 41/41、`_local_verify/three_way.js` 1903 例 0 分歧、
`_local_verify/backend/loader_vs_backend.js` 2132 例 0 分歧、`audit_backend.py` 205/205、
`acceptance_v2.py` 全通过、`loader_smoke.js` CASE1–6、`diag_test.js` 9/9。

**Windows 上需要做的**：

1. 重跑 `theme-studio/install.ps1`（面板 + loader 都在安装副本里才生效），重启应用窗口；
2. Console 应出现 `[theme-studio] loader v1.2.0 已加载`，且 `NekoThemeStudio.scriptVersion === "1.2.0"`；
3. 若仍「面板显示已应用、本体不变」，先跑 `theme-studio/test/diagnose-in-app.js` 取 `VERDICT`，再看 Console 有无「单侧模式」告警。

已知取舍：`--nts-shadow` 的负值只允许出现在前两个长度（x/y 偏移）；负扩散半径是合法 CSS，但为了拦住同样会整条失效的负模糊半径，
三处统一从严 —— 面板会把负扩散标红而不是静默丢弃。
## 本轮（0.1.4 打包 + 卸载补齐）—— 已完成，无需再排期

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `install.ps1 -Verify` | **13/13 PASS，exit 0** | 含两项「热更新哈希」（期望 `-4c8cf87c` / `-17fec53d`） |
| 真实应用补丁面 | **23 个模板**带标记 | `resources\bin\templates` 全量 ASCII 扫描 `NTS:BEGIN` |
| loader 五副本一致 | 36672B / `17fec53d` | `app\`、`plugin\static\loader\`、安装目录、`resources\bin\static\`、`app-patch\files\` |
| 端到端生效 | `data-nts-active=1`、`--nts-accent=#00c2ff`、`--nts-user-bubble-bg=#123456`、`cssRules=262` | 无头 Chrome（`tools\page-eval.js`）读 `http://localhost:48911/chat` |
| 分发包 | `dist\neko-theme-studio-0.1.4.zip`（约 455 KB / 68 项，含 `neko_theme_studio.neko-plugin`） | `tools\package-dist.ps1 -IncludePackage`，打完自检 15 个关键文件 |
| 分发包可用性 | 解压到假安装根后 `install.ps1 -SkipPluginInstall` → **6 项变更、13/13 PASS、exit 0** | 假根里预置 37 个**未打补丁**的模板作全新机器 |
| 卸载完整性 | 一次跑清 **23 个**模板（不只 chat/index），二次跑全部「没有标记，无需改动」 | 假安装根 + `-WhatIf` 与实跑两轮 |

### 本轮修掉的两个真实缺陷

1. **`uninstall.ps1` 只回滚 chat/index 两个模板**。`install.ps1` 补 2 个、插件 `_app_patch.py` 补 23 个，
   卸载却只认 2 个 → 另外 21 个模板里的标记段会永久残留，去加载已被删除的静态文件（每次开页面两个 404）。
   现改为「扫 `templates\*.html` 里含 `NTS:BEGIN` 的全部纳入」，chat/index 仍在列表头部。
2. **`uninstall.ps1` 把 `{{ static_asset_version }}` 当硬条件**。该变量原本只有少数模板有，
   但注入的标记行**自身带这个变量**，所以删前 23 个模板「都含有它」→ 删除后必然「缺少」→
   误判为「校验未通过 → 需整文件还原」。在假根上实测触发 12 个假警告。
   现改为只校验「标记数归零 + 仍有 `</html>` + 长度未腰斩」，哨兵完整性交给 `install.ps1 -Verify`
   针对真正拥有该变量的模板负责。

### 仍然是 PENDING 的（需要真机人眼）

- `--nts-button-hover-bg` / `--nts-highlight`：静态页无指针、无选区，只能门控 + 手测。
- 冷启动后宿主是否 autostart 拉起插件：本机 `agent_runtime_intent.json` 已是
  `analyzer_enabled: true` + `user_plugin_enabled: true`，重启实测 status=running；
  但「注册表空 → loader 自愈 refresh+start」这条路径没能在真实冷启动里稳定复现窗口期，
  只做了等价验证（base 指向死端口 / 404 前缀时 `reviveCount` 确实递增、`lastReviveError` 记录原因）。
- 真上架 N.E.K.O 插件市场：本机 48916 没有发布端点，需把包交给市场服务端。

---

## 修复轮（2026-11-15，本机实测）—— 0.1.4 已改并重打包

### 根因与修复（用户症状「面板显示已应用、窗口一点没变」）

| # | 根因 | 证据 | 修法 |
| --- | --- | --- | --- |
| 1 | 主题 CSS 只覆盖 `.chat-window` / `.chat-body` 等**紧凑态下 0 高且被 `transparent !important` 压平**的元素，真正可见的胶囊 `::before` 与 HUD 内联 `var(--neko-popup-*)` 从未被覆盖 | headless 实测：全量 59 变量下这些元素计算色仍 transparent；`.compact-chat-surface-frame::before` 不受影响 | `test/targets.js` 新增 H 段（胶囊变量桥接 + 边框/阴影/模糊/按钮）与 I 段（HUD tab）；`NTS_GATED.popupBridge` 目标从 2 个扩到 5 个、映射 5→9 项；`gen-css.js` 支持输出 `--custom-prop: var(--nts-*)` |
| 2 | `body .message-block-markdown { color: var(--nts-ai-bubble-text) }` 无作用域，用户气泡里的 markdown 正文被染成 AI 文本色 | 合成气泡实测：用户气泡内 markdown 同时命中 ai/user 两条规则 | A 段改为按 `.message-bubble-assistant/-tool/-system/.message.gemini` 作用域；只留 ai gate 时用户正文保持原生色（实测 rgb(20,32,51)） |
| 3 | blur 归一化把 `18%` 写成非法 CSS `blur(18%)`，加载器静默丢弃 → 面板报成功、无效果 | `_canonicalize_value('--nts-chat-blur','18%')='blur(18%)'` | 后端 `RE_BLUR_BARE`（px/rem/em/pt）、加载器同款、面板 blur 分支只收绝对长度；`_probe/test_blur.py` 12/12 |
| 4 | 面板 15 项交互缺陷（palette=null 时名称/启用无法提交、silent reload 假成功、transparent 被记成纯黑、非法行不回滚、导出/复制 JSON 非法、轮询 404 重试 25s、fetch 无超时…） | panel-review 只读审查 15 条 | `plugin/static/app.js` 1827→2141 行（ES5），`node --check` 通过；headless 实测：blur 18% 被拒（`aria-invalid=true`）、18px 接受、transparent 行 alpha 滑块可再用、`#dump` 可 `JSON.parse`、面板 59 行 7 组无控制台错误 |
| 5 | 安装器/补丁 13 项（lone BEGIN 静默删内容、卸载不持久、重装覆盖用户调色板、先删后装无回滚、`-Force` 未声明、备份目录两套…） | patch-review 只读审查 13 条 + 假安装根复现 | `_app_patch.py`（残缺标记安全化、写前守卫、kill-switch、`_sync_asset` 失败计入 ok）、`install.ps1`（预检两阶段、用户调色板备份回写、.bak 回滚、严格解码、原子写、验证扩到全部锚点模板）、`uninstall.ps1`（`-Force`、标记、auto_start=false+stop） |
| 6 | 面板静态资源 `./app.js` / `./style.css` 无版本串，而宿主给 `ui/*.js|css` 发 `max-age=3600` → 升级后最长 1 小时跑旧脚本 | 响应头实测 | `index.html` 改为 `?v=0.1.4`（改这两个文件时必须同步提版本号） |

### 本机实测证据

- 生成器：`node tools/gen-css.js …` → `build/neko-theme-studio.css` **61590 B / sha8 dbba1d18**
  （第二轮；第一轮为 60878 B / `5e983639`），`targets: 131 emitted (260 gated rule block(s))`、`fallbacks: 0`；
  五份 CSS 副本与安装副本哈希一致。
- 加载器 **1.4.0**（40993 B / sha8 efda2160）四副本与安装副本哈希一致；模板 marker 已自动改为
  `?v={{ static_asset_version }}-dbba1d18` / `-efda2160`。
- 零变化不变量：屏蔽 loader/旧 CSS 后注入新 CSS，32 个采样属性 **零差异**；只留 ai gate 时用户气泡 markdown 不串色。
- 全量调色板（59 亮 + 59 暗，version 8）在真 `/chat` 上：`diagnose()={cssRules:372, gates:119}`，
  胶囊 `::before` 底色 = 配置的 `--nts-chat-bg`、HUD 背景/文字/任务 tab、发送按钮、工具按钮、
  聊天外壳圆角、字体、`--neko-chat-opacity-factor` 全部生效；暗色模式（`data-theme=dark` + `.dark`）全部生效。
- 面板活服务实测：`rows=59 / groups=7`、`CONSOLE []`、`NETFAIL []`、版本 9（用户原调色板 2 项已还原）。
- `install.ps1` / `uninstall.ps1` 在假安装根：首装 30 项全过、`-Force` 卸载干净、二次幂等、
  kill-switch 生效、重装恢复自愈与用户调色板、端口关闭回滚、锚点损坏预检中止。
- 用户调色板：测试期间被改成 version 9/E2E-FULL，收工前已用 `_probe/theme.json.live-backup`
  通过 `import_theme` 还原为原 2 项（version 9，内容 = 原 version 6）。

### 仍 PENDING（本轮未做，别当成已修）

1. ~~`dist\neko-theme-studio-0.1.4.zip` 未重打包~~ —— **已重打包**（当时 475,491 B / 69 文件；
   *注：最终包见文末「第三轮 · 收尾」（69 条目）*，
   含 0.1.4 两轮修复后的样式表、加载器、面板、安装器、卸载器、测试套件；内嵌 `.neko-plugin` 105,807 B，
   其 `static/theme.json` 是出厂空调色板）。
2. ~~真实安装根上的 `install.ps1` / `uninstall.ps1` 全流程未跑~~ —— **已在真实安装根跑完**：
   `install.ps1` 30/30 校验 PASS（含重装保留用户 `theme.json`）、`uninstall.ps1` 23 个模板标记归零 +
   写 kill-switch 标记、再装一次 30/30 PASS 且插件 `status=running`。期间发现并修掉
   `multiple_installations`（旧插件目录被改名为 `<id>.bak` 留在插件扫描目录里）与「先 reload 后删标记」
   两个真实缺陷。
3. ~~`test/accept.ps1` 在本机跑不了~~ —— 已修：候选路径 + data: URL 预检（`NTS_BROWSER_PATH` 可覆盖），
   真机 **78 passed, 0 failed**（F3 文字色作用域新增 22 项，见下文第二轮）；套件现在会快照/还原用户调色板，不再把它 reset 清空。
4. ~~`test/panel-smoke.js` 依赖开发机 jsdom 绝对路径~~ —— 已修：`NTS_JSDOM_PATH` → 本地 `node_modules` → `jsdom`
   三级回退，缺 jsdom 打印 SKIP + exit 2；真机 **panel-smoke 22/22、panel-ui 41/41**。
5. 真实历史消息气泡（非合成 DOM）的实渲染未验证：headless 打开 `/chat` 时聊天历史未下发，
   用克隆结构 + 级联比对替代。
6. `--nts-button-hover-bg` / `--nts-highlight`（`::selection`）仍需人眼/强制伪类确认。

### 修复轮补充：收尾前的真机证据（2026-11-15 06:0x）

- 真机 `install.ps1 -Verify`：**30 项全 PASS**（23 模板 BEGIN/END=1、Jinja、资源哈希、/static 200、
  `/chat` 与 `/` 含标记、插件 running）。
- 真机 `accept.ps1`（`NTS_BROWSER_PATH=<chrome-headless-shell>`）：**78 passed, 0 failed**，
  跑完自动还原用户调色板（内容回到 2 项，版本号会变）。
- 真机读页面：`diagnose()={scriptVersion:'1.4.0', cssRules:376, gates:[…ai-bubble-text, user-bubble-text]}`，
  无控制台错误、无网络失败。

---

## 第二轮修复（2026-11-15 06:2x）：气泡文字色串染 / 用户文字色无效

用户反馈（原话）：「问题修改ai文字颜色，用户文字颜色也会变，而且用户文字设置不起作用，我需要你修复这些问题，并修复其他类似问题」

### 根因（三条叠加）

| # | 根因 | 证据 | 修法 |
| --- | --- | --- | --- |
| 1 | 样式表里 AI 文字色是**无作用域**全局规则：`body .message-block-text { color: var(--nts-ai-bubble-text) !important }`（markdown 同理） | `_probe/old-nts.css:116/120`；旧 CSS 45843 B | 生成器（`test/targets.js`）把 AI 文字规则收进 `.message-bubble-assistant` 作用域 |
| 2 | 用户文字色只挂在**死选择器** `.message.user .message-block-markdown` 上；真实 DOM 是 `.message-bubble-user`（React `neko-chat-window.es.js:61250`）→ 用户色永远不生效 | 真 /chat DOM 实测 | 补 `.message-bubble-user .message-block-text` / `.message-block-text-plain` / `.message-block-markdown` 三条作用域规则 |
| 3 | tool/system 内层正文用 `--nts-ai-bubble-text`，与自身气泡底色变量（`--nts-tool-bubble-text`）自相矛盾 → 改 AI 色会串到工具/系统消息 | targets.js A 段 | 内层正文改用 `--nts-tool-bubble-text` |
| 4 | 运行中的聊天窗还持有 01:00 加载的**旧页面**（旧 loader 1.2.0 + 旧 CSS），模板 URL 已换但页面没重载 → 修好了用户看到的仍是旧 bug | Chromium 缓存里 `f_000008/f_0000ca` = 旧 CSS 45843 B（01:00 写入） | loader 1.4.0 新增「样式表新鲜度自愈」（见下） |

### 本轮改动

- `test/targets.js` A 段作用域化 + tool/system 改色 + 用户三条规则；重新生成 `build/neko-theme-studio.css`
  **61590 B / sha8 dbba1d18**（131 emitted / 260 gated / fallbacks 0），同步 6 处副本（含安装目录）。
- 加载器 **1.4.0**（40993 B / sha8 efda2160）：`refreshStaleStylesheet()` 在 boot 时用
  `fetch(css, {cache:'reload'})` 取服务器当前 CSS，`new CSSStyleSheet().replaceSync()` 解析出
  「规则数 + 每条 cssText 长度和」签名，与页面已生效的 `link.sheet` 比较；不一致就把 `link.href` 追加
  `&nts-refresh=<Date.now()>` 强制换表并 `console.warn`；一致时不做任何事（零开销、不闪）。
- 部署后插件重启，23 个模板 marker 自动改为 `-dbba1d18` / `-efda2160`。

### 验证证据

- 新增回归测试 `test/expr-textscope.js`：在真实 `/chat`（真实部署的 CSS + loader）注入离屏夹具，
  结构照真实 React 气泡层级（`message-row > message-stack > message-bubble-* > message-block-text|markdown`），
  用插件 entry 依次「空基线 → 只配 AI → 只配 user → 只配 tool → 清空」，亮/暗各 17 项断言 →
  `verdict PASS`、failing []。实测量值（light）：空基线 user `rgb(20,32,51)`、ai `rgb(39,48,66)`、
  tool `rgb(43,58,80)`、system `rgb(96,112,134)`；只配 AI 时仅 ai 变 `rgb(1,2,3)`，user/tool/system 全不动；
  只配 user 时仅 user 变 `rgb(4,5,6)`；只配 tool 时 tool+system 变 `rgb(7,8,9)`；清空后全部回基线。
- `test/accept.ps1` 新增 F3 段（22 项）→ 真机 **78 passed, 0 failed, exit 0**；`install.ps1 -Verify` **30/30 PASS**。
- 旧 CSS 对照复现：只开 AI gate 时 user/tool/system 全部被染成 `rgb(1,2,3)`（与用户投诉一致）；
  新 CSS 三色互不影响（含暗色）。
- 陈旧样式表自愈构造测试（`_probe/stale_test_server.mjs` + `_probe/stale_check.js`）：服务器第一次回旧 CSS、
  之后回新 CSS，页面 `link` 被改写为 `…?v=old-4c8cf87c&nts-refresh=…`，新规则出现、旧的全局 AI 规则消失。
- 真页面最终状态：`NekoThemeStudio.scriptVersion='1.4.0'`、`cssRules=376`、`version=98`（用户调色板）、
  gates = ai/user/tool/dark 各 1–2 个，控制台无报错、无网络失败。
- 打包（第二轮当时的产物，已被第三轮覆盖，见文末收尾）：`dist/neko-theme-studio-0.1.4.zip` **479,985 B / 69 文件 /
  sha256 63257ba14aaf9f9e616da839181b90283a2d03e01f60251bbeb1748e56eb61f5**；内嵌
  `theme-studio/neko_theme_studio.neko-plugin` 106,320 B，包内 `static/theme.json` 是出厂空盘（148 B）、
  README 36898 B、loader 61590/40993。打包前的坑：`/plugin-cli/build` 读的是**已安装副本**，
  所以先把用户 `theme.json` 临时换回出厂版再 build、build 完立刻还原（否则会把用户颜色发出去）。

### 用户须知（重要）

**当前正在运行的聊天窗是 01:00 加载的旧页面，必须关闭聊天窗重开、或重启 N.E.K.O. 一次**，
本轮修复才会在它里面显示。之后 loader 1.4.0 遇到「页面里的样式表 ≠ 服务器上的样式表」会自动换表，
不需要再手动清缓存/重启。

### 仍 PENDING（第二轮未做）

1. 真实历史消息（非合成 DOM）气泡仍未在真历史下量测：headless 打开 `/chat` 时聊天历史不下发。
2. `--nts-button-hover-bg`（`:hover`）与 `--nts-highlight`（`::selection`）仍需强制伪类 / 人眼确认。

---

## 第三轮修复（2026-11-15 07:0x–07:3x）：作用域审计 —— 又找出 2 处同类泄漏

用户在同一诉求里追加「**并修复其他类似问题**」。这一轮把 59 个变量逐个在**真实 /chat 页面**上量了一遍
「它到底能改动哪些**可见**元素」，找与「AI 文字色串染用户文字」同类的跨作用域泄漏。

### 审计方法（可复跑）

- `_probe/vis_audit.js` + `_probe/run_vis.mjs`（CDP 9334）：逐变量写 `documentElement.style` + 开对应
  `data-nts-l-<var>` gate → 等 560ms（`transition: background-color .4s` 会让同帧 `getComputedStyle`
  读到旧值，这个坑之前踩过）→ 对 `body *` 里**可见**元素（rect ≥ 2×2、在视口内、opacity/visibility 正常）
  比对 20 个属性 → 分类成 visible / invisible 并列出元素路径。
- 命令：`node _probe/run_vis.mjs 'http://127.0.0.1:48911/chat' 6000 _probe/vis_chat.json _probe/audit_vars.json`
  （同样可跑 `http://127.0.0.1:48911/` 得到常规输入态的结果）。
- 关键坑：`audit_vars.json` 是**数组**，夹具首版按 `Object.entries` 遍历 → 拿到下标 "0".."58"，
  59 个变量全部 total=0 假阴性。修法是夹具里做 `Array.isArray(VARS) ? VARS.map(...) : Object.entries(VARS)`。

### 根因与修法

| # | 泄漏 | 证据 | 修法 |
| --- | --- | --- | --- |
| 1 | **面板文字色会改掉紧凑胶囊的文字**：`--nts-panel-text` 挂在 `.composer-panel{color}` 上，这是容器级声明，会继承给所有没有自有 color 的后代；紧凑胶囊 `.compact-chat-surface-frame` / `span.compact-chat-capsule-text` 正是它的后代 | 可见面量测：只配 panel-text 时 `--nts-panel-text` 命中 63 处（55 处可见），胶囊文字从原生 `rgb(52,83,108)` 被改掉 | `test/targets.js` 删掉 `.composer-panel{color: --nts-panel-text}`，面板文字只保留 `.composer-visit-bar{color}` 与 popupBridge 的 `--neko-popup-text`（HUD/弹层）。量测后降到 31 处且只剩 HUD 子树 |
| 2 | **基础字号只管 Markdown 消息**：`--nts-font-size` 只有一条 `.message-block-markdown{font-size}` | 应用 CSS 里 `.message-block-markdown{font-size:.94rem}`，而 `.message-block-text{white-space:pre-wrap}` 没有 font-size（继承气泡 16px）；React `yne()` 启发式决定一条消息走哪条渲染路径 → 纯文本消息的字号设置完全无效 | `test/targets.js` A 段把 font-size 同时挂到 `.message-block-text` 与 `.message-block-text-plain`（三条并列、全部 gate，未配置仍零变化） |

### 顺带确认（不是 bug，别再当 bug 修）

- `--nts-send-text` 命中 `.send-button-circle` 的 `border-*-color`：CSS 里 `border-color` 默认取
  `currentColor`，而这些元素 `border-width:0`，看不到，属于正常继承。
- `--nts-input-text` / `--nts-input-placeholder` 在 `/chat` 紧凑胶囊态**量不到**：该形态下没有
  `.composer-input`（真实输入元素是 `#text-input-area`，0×0）。主页 `/` 的常规输入态里二者都生效
  （实测输入文字 `rgb(31,35,41)`→`rgb(1,2,3)`、占位符 `rgba(102,117,141,.5)`→`rgb(4,5,6)`）。
- 死选择器 `.message.user` / `.message.gemini`（应用从不生成）保留为兼容项，空转无害。
- `#sendButton` 在 React 聊天窗里不存在（`sendButton` 在 bundle 里只是 i18n 键名），真实发按钮是
  `button.send-button-circle`；`#textSendButton` 只属于旧 DOM（`chat.html` 的 `#button-group`），
  规则留着对旧 DOM 仍有效。

### 验证证据（本轮全部真机）

- 生成器：`node tools/gen-css.js …` → `build/neko-theme-studio.css` **61886 B / sha8 0090fe93**，
  `targets: 132 emitted (262 gated rule block(s))`、`gradient kills: 4`、`fallbacks: 0`；
  同步 5 处副本（`app/css`、`build`、`plugin/static/loader`、`app-patch/files/css`、
  `resources/bin/static/css`）+ 已装副本，哈希全部一致。
- 修前/修后对照（`_probe/vis_chat.json` → `_probe/vis_chat2.json`，同一页面同一夹具）：
  `--nts-panel-text` **63 → 31** 处命中，路径从「胶囊 shell / frame / refraction / capsule-text」
  收敛到只剩 `#agent-task-hud` 与 `#agent-task-hud-header`。
- 字号：`_probe/fs_probe.js` 在真 /chat 注入真实层级夹具，空基线 `.message-block-text` 16px /
  `.message-block-text-plain` 16px / `.message-block-markdown` 15.04px；只配 `--nts-font-size:21px`
  后三者全部 21px（`pass: true`）。
- 伪类补测（`_probe/pseudo_probe.mjs`，用 CDP `CSS.forcePseudoState` 强制 `:hover`、用真实
  Selection 触发 `::selection`）：`--nts-button-hover-bg` 只在悬停时上色（灰 transparent →
  `rgb(1,2,3)`，撤 gate 后仍 transparent）；`--nts-highlight` 让选区底色变 `rgb(4,5,6)`。
  → 上一轮 PENDING 的两条已消掉。
- `test/expr-textscope.js` 扩到 6 步（空基线 → AI → user → tool → panel-text → font-size → 清空），
  亮/暗各 27 项断言，新增：`panel_keeps_capsule_text`（胶囊文字 `rgb(52,83,108)` 在改 panel-text
  后不动）、`font_applies_to_plain_text` / `font_applies_to_markdown` / `font_leaves_panel_alone`。
  基线量值（light）：capsule `rgb(52,83,108)` / shell `rgb(34,34,34)`；user `rgb(20,32,51)`、
  assistant `rgb(39,48,66)`、tool `rgb(43,58,80)`、system `rgb(96,112,134)`；
  dark：capsule `rgb(229,242,255)` / shell `rgb(224,224,224)`。
- `test/accept.ps1` F3 段新增 4 项 → 真机 **86 passed, 0 failed, exit 0**（`_probe/accept_scope2.txt`），
  跑完自动还原用户调色板（实测 version 117→143，`vars`/`dark_vars` 与跑前逐字相同）。
- `install.ps1 -Verify`：**30/30 PASS**，模板 marker 已变为 `?v={{ static_asset_version }}-0090fe93` /
  `-efda2160`，`/static` 两文件 61886 / 40993 字节。
- 真页面 `diagnose()`：`scriptVersion '1.4.0'`、`cssLoaded true`、`cssRules 378`、`lastError null`。
- 面板 `plugin/static/app.js` 只加 3 条 hint（面板背景 / 面板文字 / 基础字号），
  `node --check` 通过，真面板仍 `rows=59`、`dump` 可 `JSON.parse`、blur 18% 拒 / 18px 收。

### 本轮仍 PENDING

1. 真实历史消息气泡（非合成 DOM）仍未在真历史下量测：headless 打开 `/chat` 时聊天历史不下发。
2. `--nts-topbar-bg` 在 `/chat` 紧凑态量不到（`.window-topbar{display:none}`），只在常规态可见 —— 属形态差异。

### 收尾（重打包 + 文档同步 + 任务板）

- **重新打包**：先在已安装副本 `…\\.neko-plugin-installations\plugins\neko_theme_studio\` 里把用户
  `static/theme.json`（634 B、version 143、亮 8 / 暗 2）临时换回出厂版（148 B）→
  `POST /plugin/neko_theme_studio/stop` → `POST /plugin-cli/build`
  body `{"mode":"single","plugin_ref":{"root_id":"user","directory_name":"neko_theme_studio"}}`
  （**必须带 `Origin: http://127.0.0.1:48916`**，否则 403 `csrf_validation_failed/origin`）
  → 立刻把用户调色板写回 → `POST /plugin/neko_theme_studio/start`。
  构建产物 `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\neko_theme_studio.neko-plugin`
  **106,557 B**，18 条目，包内 `static/theme.json` = 148 B 出厂空盘、
  `static/app.js` 94086 B、`static/loader/neko-theme-studio.css` 61886 B、
  `static/loader/neko-theme-studio.js` 40993 B、README 36898 B。
- **zip**：`powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\package-dist.ps1 -IncludePackage`
  → `dist\neko-theme-studio-0.1.4.zip` **69 条目**；校验值写在同目录 `neko-theme-studio-0.1.4.zip.sha256`（避免文档自引用）；
  包内无 `__pycache__` / `.pyc` / `_probe` / `_work` / `build/native*` / `_vars.txt`。
- **打包后真机复核**：插件 `status=running`、`runtime_auto_start=true`；
  `GET http://127.0.0.1:48911/static/css/neko-theme-studio.css` = 61886 B；
  `GET …/plugin/neko_theme_studio/ui/theme.json` = version 143、亮 8 / 暗 2（用户原配置逐字未变）。
- **文档同步**：`DISTRIBUTION.md` 头部改为「69 文件 + 附带 `.sha256` 校验文件」并标注「三轮修复」；
  为避免文档里写死的哈希与最终包不一致，校验值改放在 `dist\neko-theme-studio-0.1.4.zip.sha256`；
  `TROUBLESHOOT.md` / `THEME_CONTRACT.md` / `plugin/README.md` 里的 loader 版本与行为描述已是 1.4.0，
  无需再改（三处均无具体字节数/哈希断言）。

### 第三轮用户须知

样式表与加载器本轮又变了一次（`0090fe93`；loader 仍是 1.4.0），模板 marker 已自动更新，
**新开窗口直接生效**；已在运行的聊天窗由 loader 1.4.0 的「陈旧样式表自愈」自动换表，
不用清缓存，也不用重启应用。

---

## 第四轮（2026-11-15 下午）：紧凑历史层 / 导出预览层的文字色（用户报「文字颜色修改不生效」）

### 根因

1. 真实窗口默认是紧凑胶囊态，消息**不走** `.message-bubble-*`，而是
   `article.compact-export-history-message.is-<role> > div.compact-export-history-bubble > …`
   （iife 里的 `Aoe()`）与导出预览层 `article.compact-export-preview-message.is-<role>`。
2. 这两层的颜色在 `resources\bin\static\react\neko-chat\neko-chat-window.css` 里是**写死**的
   （`#273042` / `.is-user{color:#142033}` / `.is-visit-peer{linear-gradient…}` / `.is-system{#607086}`），
   主题样式表在那两层**一条规则都没有** → 改文字色完全没反应。
3. 同时 `test/targets.js` E 段把 `--nts-rec-*`（推荐卡片）打在 `.compact-export-history-bubble` 上，
   **没有角色作用域** → 设定一次就把用户与 AI 气泡一起染色，即用户最初报的「串色」。

### 修复

- `test/targets.js`：删掉 E 段那 4 条 rec-* 错位目标；新增「A 聊天气泡 · 紧凑/历史层」26 条与
  「A 聊天气泡 · 导出预览层」32 条，全部按 `.is-user / .is-assistant / .is-visit-peer / .is-system`
  作用域（文字 / 内层 text·text-plain·markdown·h1-h6·blockquote·th·td / 底色 / 圆角 / 描边）；
  visit-peer 是渐变底色，另加 `background-image: none` kill（X 辅助段，选择器必须与底色目标逐字一致）。
- `test/fixture.html`：新增 `historyCompact` / `previewCompact` 两套 fixture（真实类名与层级，
  含 meta / content / table / blockquote），否则新目标在测量页里 MISSING-ELEMENT。
- 生成器不需要改（`@layer nts-theme` + 逐变量门控已就位）。

### 产物

- 样式表 **108114 B / sha256 前缀 `66ec797c`**（上一版 75292 B / `36e627f9`）；
  311 rows、209 个目标（416 个门控规则块）、102 aux-only、6 个渐变 kill、54 个变量。
- 5 处副本与 23 个模板 marker 全部同步（`-66ec797c`）。

### 验证

- `_probe/verify_two_layers.js`（真实 `/chat` 页 + 真实类名结构）：历史层与预览层的
  user/AI 文字色、底色、圆角、内层 plain/p/h1/blockquote 全部跟随；双向串色判定全 false。
- `test/run-tests.ps1` **exit 0**：6 次探测各 311 rows、ntsRules 528、零改动不变量 0 差异、
  覆盖率 175/175（亮/暗）。
- `test/accept.ps1` **86 passed, 0 failed**。
- 真实窗口（从 `Local Storage\leveldb` 读 loader 自报快照）：`scriptVersion 1.4.2`、
  `cssRules 542`（= 磁盘 543 个 `{` 减 @layer 包裹）、`sheetSwapCount 2`、门控含
  `data-nts-l-user-bubble-text`；屏幕像素里用户文字色 `rgb(151,12,12)` 在消息列表矩形内聚成
  一条文本行（容差 45 内 191 px 在面板内 / 13 px 在外）→ 新表与新门控在真实窗口已生效。

### 仍 PENDING

1. 真实历史消息（服务端下发的完整对话）下的实渲染仍未端到端量测 —— 无头打开 `/chat` 时历史不下发，
   用克隆结构 + 真实类名替代（本轮已覆盖到紧凑历史层与预览层两套真实 DOM）。
2. 插件面板 iframe 内的剪贴板写入（「复制并关闭」）无法在无头环境验证；面板里失败会提示
   「复制失败，请手动选择文本」，回退路径已确认存在。
3. 冷启动 autostart 拉起插件仍只在等价条件下验证。

---

## 第五轮（2026-11-15 下午 · 主题仓库 / 背景图 / 去版本号）

本轮不是修 bug，是加能力。下面按「已 IMPLEMENTED（文件层面已落地，静态核对通过）」与
「仍 PENDING（必须在真实环境里由人跑一遍）」分开记 —— 前者的证据全部是**读源码 + 文件级核对**，
没有一条来自活服务的端到端量测。

### 已 IMPLEMENTED

**1. 去掉调色板版本号 —— 「theme.json」/「version」彻底解耦（`theme.json` 不再有 `version` 键）**

- `plugin/__init__.py` 的 `_normalize()` 只产出六个键
  `{schema, name, enabled, updated_at, vars, dark_vars}`，并在注释里写明「老版本的 theme.json 里
  可能有 `version` 计数字段：这里刻意忽略它，下次落盘时自然消失」；`default_palette()` 同形。
- 加载器（`plugin/static/loader/neko-theme-studio.js`，`SCRIPT_VERSION = '1.5.0'`）不再比较版本号，
  改成比对每次轮询到的**原始 JSON 文本**：`var raw = JSON.stringify(p)` →
  `if (!force && raw === lastRaw) return;` → `applyPalette(p); lastRaw = raw;`（L901–910）；
  `storage` 事件旁路同判据（`if (raw === lastRaw) return;`，L1006–1008）。
- `stampOf(p)` 改用 `updated_at`，注释：「只用于日志/诊断展示，判等一律靠原始 JSON 文本」。
- 面板不再显示版本号 pill。
- 副作用（有意为之）：**手改 `theme.json` 现在真的会被接住**，最迟 1500ms（`POLL_INTERVAL_MS`）。

**2. 七个新 entry（插件后端，`plugin/__init__.py`）**

| entry | 参数（schema） | 返回（`Ok(...)` 的实际键） |
|---|---|---|
| `list_themes` | `{}` | `{count, themes:[{id,name,saved_at,light,dark,has_image}]}`，按 `saved_at` 倒序 |
| `save_theme` | `{name?}`（`maxLength` 60） | `{saved:true, theme:{…}}` —— 顶层**没有** `id`/`name` |
| `apply_saved_theme` | `{theme_id?, id?}` | `{applied:true, theme:{…}, light, dark, rejected:[]}` |
| `delete_theme` | `{theme_id?, id?}` | `{deleted:true, theme_id}` |
| `import_theme_archive` | `{data, filename?}`，`required:["data"]` | `{imported:true, theme:{…}, source_format:"zip"|"json", rejected:[]}` |
| `export_theme_archive` | `{theme_id?, id?}` | `{filename, data(base64 zip), bytes, images}` |
| `import_background` | `{data, filename?}`，`required:["data"]` | `{url, filename, bytes, kind}` |

- **参数名双写**：`apply_saved_theme` / `delete_theme` / `export_theme_archive` 的 `input_schema`
  同时声明 `theme_id` 与 `id`（都 `type:string, maxLength:64`、都非必填），函数体首行
  `theme_id = theme_id or id`。源码注释原文：「面板发的是 id（更自然），CLI/脚本里常用 theme_id。
  两个都收，避免调用方猜参数名 —— 曾因只认 theme_id 导致面板「应用/分享/删除」全部报「条目 id 非法」。」
- `list_themes` 返回键是 **`themes`**；面板 `refreshLibrary()` 写成
  `result.themes instanceof Array ? result.themes : result.items`，两侧都兼容（早期版本只读 `items`，
  字段名对不上时仓库列表永远是空的）。
- `import_theme_archive` 容忍 `data:` 前缀；base64 上限 `ARCHIVE_MAX_BYTES * 2`；
  `vars`/`dark_vars` 都空时报「分享包里没有可用的调色板变量（可能不是主题工坊的分享包）。」
- **取的姿势**（上文所有返回形状都是「取出来之后」的样子）：`POST /runs` 的 body 是
  `{plugin_id, entry_id, args}`（是 `entry_id`，不是 `entry`）→ 轮询 `GET /runs/{run_id}` 到
  `succeeded` → `GET /runs/{run_id}/export` 取 `{items:[…]}` → 挑 `type === 'json'` 且带 `json`
  的那条 → 读 **`item['json']['data']`**。直接读 `items[0]` 或 `item.json` 会拿到 undefined。

**3. 存储布局**

- 仓库：`plugin/static/themes/<id>.json`，一条一个文件；id = `<slug>-<YYYYmmddHHMMSS>`，
  同秒重名追加 `-2`/`-3`；`RE_THEME_ID = ^[a-z0-9][a-z0-9-]{0,63}$`。上限 200（`LIBRARY_MAX_ITEMS`）。
- 背景图：`plugin/static/backgrounds/<sha256前16位>.<ext>`，内容寻址、同内容不重写；
  经 `/plugin/neko_theme_studio/ui/backgrounds/<文件>` 访问（`PLUGIN_BASE_URL` 默认
  `http://127.0.0.1:48916`，可被 `NTS_PLUGIN_BASE` 覆盖）。
- 两个目录都**尚不存在**（干净仓库里没有它们）：`_ensure_dirs()` / 首次写入时创建。

**4. 分享包格式（zip）**

- `_build_archive()` 写 `theme.json`（图片值改写成 `url("images/<name>")`）→ `README.txt`
  （`ARCHIVE_README`）→ `images/<name>`（`ZIP_DEFLATED`，按名字排序、去重）。
- `_parse_archive()` 用前 4 字节 `PK\x03\x04` 判 zip，否则走裸 JSON 分支。
- `_rewrite_archive_refs()`：basename 在包里找不到 → 整条引用丢成 `""` 并 log
  「分享包里缺少图片 <name>，该引用已丢弃」（**故意**不留坏路径）。
- 上限：zip 8 MiB / 单图 4 MiB / 300 条目 / 解压后 24 MiB / 仓库 200 条。

**5. `--nts-chat-bg-image`（新的值种类 `image`）**

- 三处白名单同步：后端 `IMAGE_VARS = frozenset({"--nts-chat-bg-image"})`（`_value_kind()` 第一个查它）、
  加载器 `NON_COLOR_VARS` 的 `'--nts-chat-bg-image': 'image'`、面板 `CATALOG` 的 `type: 'image'`。
- 三处正则一致：后端 `RE_BG_URL` / 加载器 `RE_BG_VALUE` / 面板 `RE_BG_VALUE`，
  只放行 `none` 或指向本插件 `backgrounds/` 的绝对 URL。
- 变量计数：`KNOWN_VARS` 与面板 `CATALOG` 的 `key:` 双向差集为**空**，各 **61** 个（不是 59/60）。
- 样式表**已重建**：`plugin/static/loader/neko-theme-studio.css` 110386 B / `ef30389ee6bc`，
  含 `/* ===================== chat background image ===================== */` 段与 16 处
  `chat-bg-image`（八条规则 = 四目标 × 亮/暗），四条联动声明
  `background-image` / `background-size: cover` / `background-position: center center` /
  `background-repeat: no-repeat`。
- `test/targets.js` 登记四个目标（`aux:true`）：`.compact-export-history-scroll`、
  `.compact-export-history-scroll-content`、`.message-list`、`.chat-body`。

### 仍 PENDING

1. **真实 Electron 窗口 + 真实聊天历史**下的背景图实渲染仍未端到端量测。
   `background-size: cover` 在四个目标上的实际裁切、图片与 `--nts-chat-panel-bg` 的同盒叠放
   （「图片优先于颜色」）在真实页没被量过；无头打开 `/chat` 时历史不下发，
   只能用克隆结构替代。**需要人开一次真窗口、传一张真图、配一个背板色，肉眼确认图片盖在颜色上面。**
2. **真实 zip 往返（人类手跑）**：`save_theme` → `export_theme_archive` → 在另一台机 /
   另一个安装里 `import_theme_archive` → `apply_saved_theme`，确认 `images/` 里的图跟着走。
   目前只在文件层面核对过打包/解包逻辑，**没有任何一次真实的跨机往返证据**。
3. **缺图路径只做了代码审查**：`_rewrite_archive_refs()` 的 `return ""` 分支从未被真实执行过
   （要造一个「theme.json 引用了包里没有的图」的包才能触发）。
4. **面板剪贴板行为在 Electron 里未验证**：「复制 dump」与「复制并关闭」在无头环境写不进剪贴板；
   面板失败时会提示「复制失败，请手动选择文本」，回退路径存在但没被真人走过。
5. **主题仓库 UI 的实交互**：删除的「3 秒内点第二次」软确认（`LIB_CONFIRM_MS = 3000`，
   不用 `window.confirm`）只在代码层面成立；保存/应用/分享/导入四个按钮的完整往返
   （含 `base64ToBytes` + `downloadBlob` 的 `<a download>` 落盘）**没有在真实面板里点过**。
6. **i18n 缺文案**：`plugin/i18n/zh-CN.json` / `en.json` 仍只有 6 个旧 entry 的
   `entries.*.name` / `.description` 键，七个新 entry 走的是 `tr(key, default=…)` 的 default 分支。
   功能不受影响（中文兜底就是 default），但英文环境下也会显示中文 —— 待补。
7. **`build/vars.json` 仍是 53 条**，不含 `--nts-chat-panel-radius` 与 `--nts-chat-bg-image`。
   它只喂面板原生参考值、不参与生成的 CSS（契约 §3.2），所以不影响外观；
   但它已经不是「变量全集」，任何拿它当清单的脚本都会漏项。
8. **并发用例的判据失效**：README §10 列的「40 个并发 `apply_theme` 得到 40 个互不相同的版本号」
   随 `version` 一起去掉了，本轮没有重跑。要重跑得把判据改成「40 次写入后 `vars` 并集完整」。
9. ~~`plugin/static/theme.json` 磁盘上仍带 `"version":1`~~ —— **已修**：出厂文件被重新写成
   六个键（`schema`/`name`/`enabled`/`updated_at`/`vars`/`dark_vars`），`name` 也从 `empty`
   改成 `默认`。`_probe/fix_seed_theme.py` 做的这件事，部署脚本会把它同步到安装副本。
10. **出厂 `.gitignore` / 打包清单未核对**：`static/themes/` 与 `static/backgrounds/` 是运行时数据，
    打 `.neko-plugin` 包时是否应该排除、用户升级时是否会被覆盖，都没有验证过。

## 第七轮（2026-11-15 傍晚 · 大规模自检：仓库 / 背景图 / 虚化开关）

### IMPLEMENTED（本轮修掉的 5 个真缺陷）

1. **裸 JSON 导入会丢掉背景图**（`import_theme_archive` 的 JSON 分支）
   `_rewrite_archive_refs(parsed, {}, ...)` 里 `images` 是空 dict，
   `images.get(basename)` 恒为 None → 一律返回空串。结果是「复制导出 JSON
   再粘贴导入」只剩颜色、背景图静默消失。现在若本机已有同名文件
   （文件名就是内容哈希，同名必然同内容）就直接复用它；确实没有才丢弃。
2. **应用死链主题会写进 theme.json**（`apply_saved_theme` / `import_theme`）
   仓库条目里引用的图片被删掉后，条目里的 URL 仍会被写进 theme.json，
   应用侧请求 404，而 `list_themes` 的 `has_image` 又说没有 —— 自相矛盾。
   新增 `_without_missing_images()`，写入前把指向不存在文件的引用摘掉，
   并在 `rejected` 里给出 `--nts-chat-bg-image: 引用的背景图已不存在，已回退原生`。
3. **暗色下虚化开关对两条控件带无效**（`test/targets.js` 的 `NTS_VEIL`）
   `.compact-export-history-controls` 与 `.compact-export-preview-region`
   只有 `light` 规格，而应用侧对这两层有 `[data-theme=dark] …{background:#17233247}`
   覆盖 → 暗色下关虚化对它们毫无作用（实测仍 `rgba(255,255,255,0.18)` + `blur(8px)`）。
   已补 `dark: { color: [23, 35, 50], a: 0.2784 }`。
4. **面板预览完全不反映虚化开关**（`static/app.js` 的 `renderPreview()`）
   预览从来只读 `--nts-chat-blur`，不读 `--nts-bubble-veil`，于是拨开关时
   预览纹丝不动 —— 真机其实生效了，但用户会认定「开关坏了」。
   现在预览按真机语义真算一遍：气泡白纱色乘 veil、`backdrop-filter`
   取 `blur(8px × veil)`；设了「气泡背景」变量时颜色让位（与 CSS 的
   `yieldsTo` 一致），但模糊仍随开关缩放。实测 1 / 0.5 / 0 三档得到
   alpha 0.88 / 0.44 / 0 → blur 8px / 4px / 0px。
5. **`static/backgrounds/` 的孤儿图无人回收**（新增 `_gc_backgrounds()`）
   每次上传都按内容哈希落一个文件，删主题、导入失败都会留下孤儿图。
   启动时扫描 theme.json 与全部仓库条目的**原始文本**（不扫校验后的 vars，
   避免把「变量非法但文件仍是用户资产」的图误删），删掉没被引用的文件。
   实测重启后孤儿 `0e7a0afb75416797.png` 被回收，在用的那张保留。

### 本轮验证

- `theme-studio\test\run-tests.ps1`	exit 0：各 315 rows、ntsRules 572、
  零改动不变量亮/暗各 0 差异、覆盖率 175/175。
- `theme-studio\test\accept.ps1`	86 passed / 0 failed（连跑两次一致）。
  **注意**：不要在 accept 运行期间从外部调 `apply_theme` —— 会把它的用例搅乱
  （我第一次就是在 accept 跑的同时改了调色板，得到 85 passed / 1 failed 的假失败）。
- 部署一致性（`_probe\audit12_deploy.py`）OVERALL PASS：主题 CSS 6 份
  `2580431b`/120290B、loader 5 份 `aee98346`/58001B、插件 python 2 份
  `e2b2a7e1`/75589B、面板 app.js 2 份 `c035bd61`、index.html 2 份、style.css 2 份；
  37 个模板 23 带标记、invalid-UTF-8 = 0、stale = 0；服务端 120290B 与磁盘同哈希；
  `/chat` 引用 `-2580431b` / `-aee98346`；`/surfaces` 仍是 1 个（main「主题工坊」）。
- 真实 `/chat` 页（veil = 0）：气泡 `rgba(…,0)` + `blur(0px)`、控件带 `rgba(…,0)` + `blur(0px)`；
  切到 `data-theme="dark"` 后气泡 `rgba(33,72,118,0)` / `rgba(33,45,62,0)`、控件带同样归零。

### PENDING（仍然只能靠人眼 / 真实窗口确认）

- 真实 Electron 窗口里拨虚化开关的观感（无头环境只能量 computed 与像素）。
- 空会话时背景图无处可画：`.compact-export-history-anchor` / `-scroll` /
  `.message-list` / `.compact-export-history-empty` 在无消息时都不渲染，
  唯一带图的 `.chat-body` 在紧凑态是 430×0 → **只有"有消息"或"展开态"才看得见背景图**。
- 应用被杀的瞬间正在写的 theme.json（tmp + `os.replace` 已保证原子，但没做断电演练）。

## 第六轮（2026-11-15 傍晚 · 聊天背景虚化开关 / 去版本号收尾）

### IMPLEMENTED（已在真实路径上验证）

1. **`--nts-bubble-veil` 0–1 乘子**（用户要求"虚化可自主开关"）：
   - 三处白名单：后端 `NUMBER_VARS`、loader `NON_COLOR_VARS`（`'number'`）、面板 `CATALOG`（`type: 'switch'`）。
   - `test/targets.js` 新增 `NTS_VEIL`，11 个白纱层各带亮/暗原生值、blur 规格与 `yieldsTo`。
   - `tools/gen-css.js` 新增 "bubble veil" 段：白纱与模糊**各发一条规则**，各算各自的
     `:not([gate])` 后缀（第一版把整串门控挂一起，导致"设了毛玻璃模糊、白纱也失效"）。
   - 生成：**119362 B / sha8 4ddb9aeb**，`--nts-bubble-veil` 出现 48 次，`targets 209 emitted / 416 gated blocks / 106 aux-only`。
2. **像素级证明开关有效**（`_probe\veil_switch.py`，棋盘格垫在气泡下、只量气泡内部）：
   - assistant：veil 1 → edge **1.2** / mean 239.5 / `rgba(255,255,255,0.88)` + `blur(8px)`；
     0.5 → **7.2** / 183.2 / `alpha 0.44` + `blur(4px)`；0 → **17184.0** / 127.3 / `alpha 0` + `blur(0px)`。
   - user：1 → 1.2；0.5 → 7.3；0 → 16734.0。两角色都单调递增。
3. **面板端到端**（`_probe\panel_veil_e2e.py`，真实面板页）：rowCount **62**，新行
   `--nts-bubble-veil` / 标签「聊天背景虚化」/ 类型「开关」/ 原生「开」；关掉 → `theme.json`
   出现 `"--nts-bubble-veil": "0"`；打开 → `"1"`；真实 `/chat` 页 `gates` 含
   `data-nts-l-bubble-veil`、`styleText` 含 `--nts-bubble-veil:1`、`cssRules 582`。
4. **loader 1.5.2**：`SCRIPT_VERSION` 升到 `1.5.2`，新增 `composerSnapshot()`
   （frame/capsule/toggle 的 rect、padding/overflow/zIndex、`elementsFromPoint` 覆盖栈、
   `toolBtnCount`/`fanOpen`），用于从真实窗口自报 composer 几何。
5. **部署 + 模板键**：CSS `4ddb9aeb` 5 处 MATCH、JS `220776d0` 5 处 MATCH、面板三件套
   MATCH（app.js `8a60819e`、index.html `e660e556`、style.css `a22ae9fa`）、
   `index.html` 引用 `?v=0.1.6-*`、**23 个模板** bump 到 `-4ddb9aeb` / `-220776d0`，invalid UTF-8 = 0。
6. **后端同步**：`theme-studio\plugin\__init__.py`（`8b71bbd5` / 71061 B）复制到安装副本
   （注意：安装副本的 `__init__.py` 在**插件根目录**，不在 `plugin/` 子目录）并
   stop + start 重启（`POST /plugins/refresh` 不重载模块）。
7. **回归**：`run-tests.ps1` 零改动不变量 light/dark 各 0 差异、覆盖率 175/175；
   `accept.ps1` **86 passed, 0 failed**。跑完已把用户调色板精确还原（5 个变量、
   不含探测用的 `--nts-bubble-veil`）。

### 教训（写进流程）

- **`deploy` 脚本的 stale 检查不能用 `[^"\s>]+` 匹配 Jinja 模板**：`{{ static_asset_version }}`
  里的空格会把引用截断，产生 46 条假阳性。要按 `neko-theme-studio\.(css|js)\?v=(\{\{[^}]*\}\}|[^"\s>]*?)-([0-9a-f]{8})` 整段匹配。
- 安装副本的 Python 入口是 `...\neko_theme_studio\__init__.py`，**不是** `...\plugin\__init__.py`。
- 面板 `--nts-chat-opacity` 已有 `number` 行可复用，但"是否开关"语义用 `type: 'switch'` +
  checkbox 更符合用户预期；`syncRow` 里 `raw === '' ? true : …` 保证"未配置 = 原生 = 开"。

### PENDING（仍无法在无头环境确认）

1. 真实 Electron 窗口里的观感（需要用户重开窗口以载入 loader 1.5.2）。
2. `--nts-bubble-veil` 与 `--nts-chat-blur` 同时设置时的毛玻璃观感（无头只能对比
   `backdrop-filter` 字符串，无法评价视觉）。
3. 导出预览层（`compact-export-preview-*`）的 veil 只在 fixture 里量过，真实导出面板未实渲染。
4. `composerSnapshot()` 的真实窗口数据要等窗口重载后才会有记录。
5. `build/vars.json` 仍是旧的 54 条快照（不参与生成，仅作参考文件）。

## 第八轮（2026-11-15 傍晚 · 背景图亮度）

### 实现

1. **`--nts-chat-bg-image-brightness`（值种类 `number`，0–1，`1` = 原图）**
   需求：「用来调整背景图片亮度，以至于不用和背景图抢视线」。
   - 三份白名单：`__init__.py` 的 `KNOWN_VARS` + `NUMBER_VARS`、loader 的 `NON_COLOR_VARS`（`'number'`）、
     面板 `CATALOG`（`type: 'number'`，标签「背景图亮度」，原生 `1`）。
   - `targets.js` 新增 `NTS_GATED.chatBackgroundImageBrightness`，多一个 `requires` 字段；
     `gen-css.js` 新增专门段落，输出 `linear-gradient(黑蒙版), var(--nts-chat-bg-image)`。
   - loader `1.5.4` → `1.5.5`。
   - 生成：**123908 B / sha8 `7b533a5b`**，8 条亮度规则（亮暗各 4 个面），花括号 596/596。
2. **面板预览同步**：`renderPreview()` 用同一套算法把蒙版叠到 `#pv-body` 上，
   否则拨亮度时预览不动，用户会以为没生效。

### 验证

| 项目 | 结果 |
| --- | --- |
| 像素亮度（`_probe/brightness_pixels3.py`） | 不设/`1` → 37.1；`0.6` → 22.6；`0.3` → 11.5；`0` → 0.5（等比，`1` 与原图完全一致） |
| 真实 `/chat` 计算样式 | `.compact-export-history-scroll` / `-scroll-content` / `.chat-body` 的 `background-image` = `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.4)), url(…/08211fb7….png)` |
| 真实窗口自报（leveldb） | `scriptVersion 1.5.5`、`cssRules 594`、gates 含 `data-nts-l-chat-bg-image-brightness` 与 `data-nts-d-…`、`styleText` 含 `--nts-chat-bg-image-brightness:0.6` |
| 面板 | 行数 62 → **63**；新行文本含「背景图亮度」、类型「数值」、占位「原生 1」；把值改成 `0.3` 后预览蒙版由 `0.4` 变 `0.7`，改回即恢复 |
| `run-tests.ps1` | exit 0：零改动不变量亮/暗各 0 差异、覆盖率 175/175、`ntsRules 580` |
| `accept.ps1` | **86 passed / 0 failed**（跑完自动还原用户调色板） |
| 部署一致性（`_probe/deploy_audit.py`） | OVERALL PASS：CSS 5 处 `7b533a5b`/123908 B、loader 5 处 `5b796c9d`/58154 B、py `28e4a222`、面板 app.js `98b1307e`、23 个模板键全部 bump、invalid UTF-8 = 0、catalog 63 键缺失 0 |

### PENDING

1. 真实 Electron 窗口里的**观感**（压暗多少才不抢视线）只能人眼定；目前用户调色板取 `0.6`。
2. 只支持压暗，不支持增亮（`> 1` 会让 `calc(1 - v)` 变负、蒙版失效）。若将来要增亮，
   需要第二条白色蒙版，且得处理「两个蒙版不会同时生效」的门控组合。
3. `filter: brightness()` 路线被排除（会连带压暗正文），已记进本节；若将来应用改成用
   `<img>` 承载背景图，可以改回 filter 并支持增亮。

## 第九轮（2026-11-15 傍晚 · 顶部渐隐 / 背景图顶上的「雾」）

用户原话：「不是聊天文字的虚化问题，是现在导入图片最上边有一层雾效果」。

### 根因

`resources/bin/static/react/neko-chat/neko-chat-window.css` 给
`.compact-export-history-scroll` 与 `.compact-export-preview-messages` 都写了
`mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)`
（连 `-webkit-` 两条）。背景图画在同一容器上，因此**图片顶部 28px 也被淡出**，
视觉上就是一层白雾。应用侧全表只有这两条 mask 与聊天记录相关（`_probe/fog_mask_rules.py`
线性扫描 1751 条规则确认）。

### 实现

- 新变量 `--nts-chat-top-fade`（`number`，`0`–`1`）：把上面那条 mask 的三个色标写成
  `calc(1 - fade)` / `calc(1 - 0.22 * fade)` / `1`，于是 `1` 与原值逐字节等价、`0`
  全不透明即无雾。
- 落点：`plugin/__init__.py` 的 `KNOWN_VARS` + `NUMBER_VARS`；loader 的
  `NON_COLOR_VARS`（`number`）+ `SCRIPT_VERSION` 1.5.5 → **1.5.6**；
  `test/targets.js` 的 `NTS_GATED.chatTopFade`；`tools/gen-css.js` 新增
  「chat top fade」段（亮/暗 × 2 选择器 = 4 条规则，含 `-webkit-`）；
  面板 `CATALOG` 新增「顶部渐隐」行 + `renderPreview()` 同步给 `#pv-body` 上 mask。
- 产物：CSS 125844 bytes sha8 `bb7cf77a`（600/600 花括号、`@layer` 2 次、
  `mask-image` 声明 8 条 = 4 规则 × 2）；loader 58387 bytes `829215aa`；面板
  app.js 123065 bytes `312f7996`；插件 `__init__.py` 75738 bytes `ddf82c52`；
  23 个模板缓存键 bump 到 `-bb7cf77a` / `-829215aa`。

### 验证

- 像素（`_probe/top_fade_test.py`，干净页 + 纯红底 + 无头截图）：fade `1` → 顶行
  `rgb(227,198,208)`（被冲淡）、`0.5` → `rgb(241,98,103)`、`0` → `rgb(255,0,0)` 全满；
  y+30 以下三档都是满色。
- 真实页（`_probe/top_fade_live.py`，走真实 `apply_theme` + 真实 loader 轮询）：
  loader `1.5.6`、设置 `0` 后 gate `data-nts-l-chat-top-fade` 出现、computed
  `linear-gradient(rgb(0,0,0) 0px, rgb(0,0,0) 12px, rgb(0,0,0) 28px)`；删掉变量后
  gate 消失、computed 回到应用原生的 `rgba(0,0,0,0)/0.78/1` → **"不配置 = 完全原生"**。
- 面板：`rowCount 64`、新行标签「顶部渐隐」/类型「数值」/原生「1」/hint 完整，
  `#pv-body` 的 mask 随笔刷值变化。
- `theme-studio/test/run-tests.ps1` **exit 0**（各 315 rows、`ntsRules` 584、零改动
  不变量亮/暗各 0 差异、覆盖率 175/175）；`theme-studio/test/accept.ps1`
  **86 passed / 0 failed**。

### 仍然 PENDING

1. 真实 Electron 窗口里「雾没了」的观感只能人眼确认（像素测试在无头环境完成）。
2. 关掉渐隐后消息在顶部硬切是预期代价，但**滚动到顶时的观感**未在真机长会话里复核。
3. 空会话时列表容器不渲染，因此该变量在"完全没有消息"的窗口里看不到任何效果
   （与背景图同一条限制）。

## 第十轮（2026-11-15 傍晚 · 面板 64 个控件的有效性与输入接受度）

### IMPLEMENTED

1. **控件有效性全量复核（64/64）** —— 按变量种类取对应哨兵值（颜色 `rgb(199,7,7)`、
   长度 `33px`、模糊 `blur(7px)`、数值 `1.7`、字体 `monospace`、阴影带色带偏移、
   图片换成另一张已存在的图、开关填 `0`），在真实 `/chat` 页逐个测量「命中的元素数 +
   可见涂抹面积」：VISIBLE 17、CONTENT/STATE 45、DEAD **0**。
2. **两个伪状态控件单独取证** —— `--nts-button-hover-bg` 用 CDP `CSS.forcePseudoState`
   强制 `:hover`（未强制 `rgba(0,0,0,0)` → 强制 `rgb(199,7,7)`、`matches(':hover')` true）；
   `--nts-highlight` 用 `Range` 选中 + 截图像素取样（原生 `rgb(51,103,209)` →
   主题 `rgb(199,7,7)`，各 1975 像素一致）。这两个无法用普通求值探测，属固有测量限制。
3. **修：长度行不接受裸数字** —— 9 个长度行（圆角 ×7、字号、背板圆角）过去敲 `16` 会标红。
   新增 `normalizeTypedValue()`：length 行里纯数字自动补 `px`（输入框在提交时显示成 `16px`）；
   后端与加载器保持严格，`-4px` 仍然标红。实测：面板敲 `12` → `theme.json` 存 `"12px"`。
4. **修：模糊行不接受纯数字** —— `--nts-chat-blur` 敲 `7` 会标红（须写 `7px` 或 `blur(7px)`）。
   同一个 `normalizeTypedValue()` 现在也管 `blur` 行：敲 `7` 按 `blur(7px)` 处理。
5. **修：数值行不接受 `1.0`** —— 4 个数值行（不透明度、虚化开关、背景图亮度、顶部渐隐）
   过去只认 `1`。三份 `RE_NUMBER`（`theme-studio\plugin\__init__.py`、加载器、面板）
   同步放行 `1.0` / `1.00`，仍拒绝 `1.5` / `2` / `-0.3`。实测：敲 `1.0` → 落盘 `"1.0"`。
6. **加载器升到 1.5.7**（校验逻辑变了必须升版本，否则无法从 `diagnose()` 区分窗口跑的是哪一版）。
   部署：loader `3a9afc2d`（58545 B）、面板 `app.js` `15457c87`（123893 B）、
   `__init__.py` `0434050c`（75772 B）、23 个模板 JS 键 bump 到 `-3a9afc2d`、插件 stop+start。

### 本轮的教训

- **图片哨兵必须与「用户当前配的那张图」不同**：第一次用了用户正在用的
  `08211fb755cc760c.png` 当哨兵，computed 前后完全一致 → 假报 dead。
- **带 `requires` 的门控变量要成对设哨兵**：`--nts-chat-bg-image-brightness` 的规则
  同时要求 `--nts-chat-bg-image` 门控，只设亮度会让 `var()` 解析失败、整条声明作废 → 假报 dead。
- **滚动条是两个变量共用一条声明**（`scrollbar-color: var(thumb) var(track)`），
  必须成对设置，只设一个永远无效。

### 回归

- `theme-studio\test\run-tests.ps1` exit 0：6 次探测各 315 rows、ntsRules 584、
  零改动不变量亮/暗各 0 差异、覆盖率 175/175。
- `theme-studio\test\accept.ps1` **86 passed / 0 failed**。
- 面板接受度矩阵 64 行逐条复测：9 个长度行 `16` 由 BAD 转 ok、4 个数值行 `1.0` 由 BAD 转 ok，
  非法值（`zzz`、`2`、`-4px`）仍然全部被拦。

### PENDING

1. 真实 Electron 窗口里 `normalizeTypedValue()` 的观感未经人眼确认（无头环境已验证行为）。
2. `--nts-chat-bg-image` 仍只能通过文件选择器设置，没有「粘贴 URL」入口（设计如此：
   只接受本插件 `backgrounds/` 下的文件，防外链）。
3. 面板文案仍为中文单语，未做 i18n。

## 第十一轮（2026-11-15 晚 · 内置主题 / 多层阴影 / 面板输入宽容）

### IMPLEMENTED

1. **内置主题 `static/presets/`**：随插件发布的只读主题。`list_themes` 合并
   `presets + library`（预置项 `builtin: true`、`saved_at` 显示「内置」）；
   `delete_theme` 拒绝删除并给出可操作文案；面板对 `builtin` 项不渲染删除按钮；
   `export_theme_archive` 对预设同样可用。首条实测：**星辰喵 Starry Meow**
   （64 亮 + 64 暗、含背景图 `7d642a590cb2d089.jpg` 408680 B，由桌面 PNG 941x1672
   转 JPEG q90 得到）。
2. **`--nts-shadow` 支持 1–4 层**（`SHADOW_MAX_LAYERS = 4`）：三处校验器（后端 /
   loader / 面板）统一改为「先按顶层逗号切层、再逐层校验」。修前多层阴影必然被拒
   （逗号粘在颜色上 → token 数超限），星辰喵预设的 `rejected` 里就能看到它。
3. **预设背景图不再被 GC 误删**：`RE_BG_REF_TEXT` 从只认 `backgrounds/` 改为
   `(?:backgrounds|images)/`，`_gc_backgrounds()` 也扫 `presets/`。
4. **`_rewrite_archive_refs()` 保留 `id` / `saved_at`**：修前应用预设后摘要里
   `id: ''`、`saved_at: '—'`。
5. **面板输入宽容**（第十轮追加）：长度行裸数字自动补 `px`、模糊行裸数字自动包成
   `blur(Npx)`、数值行接受 `1.0`/`1.00`。

### 实测数据

| 项 | 结果 |
| --- | --- |
| `list_themes` | 1 条，`builtin: true`、`light 64 / dark 64`、`has_image true` |
| `delete_theme('starry-meow')` | 被拒，文案「内置主题不能删除…」 |
| `export_theme_archive` | `星辰喵-Starry-Meow-*.zip` 410098 B，条目 `theme.json` / `README.txt` / `images/7d642a590cb2d089.jpg` |
| `apply_saved_theme` | `light 64 / dark 64`、**`rejected: []`**、摘要 `id/saved_at` 正常 |
| 背景图可访问 | `GET .../backgrounds/7d642a590cb2d089.jpg` → 200 / 408680 B |
| 真实 `/chat` | `scriptVersion 1.5.8`、`cssRules 598`、**gates 129 项**（1 + 64 亮 + 64 暗）、`styleLen 4496` |
| 底板实测 | `background-image: linear-gradient(rgba(0,0,0,.4), …), url(...7d642a…jpg)`、`background-size: cover, cover`、`border-radius: 24px` |
| 多层阴影实测 | `.modal-dialog` `box-shadow: rgba(0,210,255,.4) 0 0 20px 0, rgba(179,136,255,.5) 0 0 15px 0` |
| 面板 | `rowCount 64`、仓库 1 条、meta「内置 · 亮 64 / 暗 64 · 含背景图」、按钮只有「应用/分享」 |
| 回归 | `run-tests.ps1` exit 0（各 315 rows、`ntsRules 584`、零改动不变量亮/暗各 0 差异）；`accept.ps1` **86 passed / 0 failed** |
| 部署一致性 | `deploy_audit.py` **OVERALL PASS**（CSS `bb7cf77a` / loader `9aab6b5a` / py `ee05568c`… 全 MATCH，37 模板 invalid UTF-8 = 0） |

### 教训

- **放宽校验器之后必须重跑 accept**：多层 shadow 的用例在旧断言里可能是「必须拒绝」，这次靠 accept 86/0 才确认没有反向回归。
- **预设图片引用写相对形式**，并在读时重写 —— 绝对 URL 会绑定 `127.0.0.1:48916`，换机即坏；同理，GC 扫描必须同时认 `images/` 与 `backgrounds/`。
- **用户给的 `mode: "dark"` 主题要亮暗两组都写**：只写暗色组的话，应用处于亮色模式时面板改什么都看不出变化（这类「改了没反应」都是同一个根因）。
- 面板里判断空态用的是 `element.hidden = true`（IDL 属性），**不是** `classList.add('hidden')` —— 探针要读 `.hidden` / `getComputedStyle().display`，读 class 会误报。

### PENDING

1. 真实 Electron 窗口里「内置」条目的观感（无头环境无法看截图，只有数值采样）。
2. 预设跨机分发（真实另一台机器上 `zip`/`presets` 往返未跑）。
3. 多层阴影在应用侧的实际渲染在真实窗口未人眼确认（headless computed 已确认取值正确）。
4. 面板仓库条目的拖拽排序 / 重命名仍未实现（当前只能另存为新条目）。

## 第十二轮（2026-11-15 夜间 · 导出没有文件 / export_to_file）

### IMPLEMENTED

| 项 | 结论 |
| --- | --- |
| 根因 | 宿主插件面板 iframe 的 sandbox 串是 `allow-scripts allow-forms allow-popups allow-same-origin allow-modals`，**没有 `allow-downloads`** → `Blob` + `<a download>` 被 Chromium 静默丢弃，页面无任何报错 |
| 取证（a/b 对照） | 同源测试页放两个 iframe：a = 宿主真实 sandbox 串、b = 该串 + `allow-downloads`，执行同款 Blob 下载 → 下载目录只有 `probe-b.zip`（7 B，`PK\x03\x04`），iframe a 无文件 |
| 另一条路径本来就没文件 | 底部「导出」按钮 = `export_theme` + 弹窗显示 JSON 文本，设计上不产生文件 |
| 新增 entry | `export_to_file`（`kind: zip\|json`、`theme_id`/`id`、`target: desktop\|downloads\|plugin`、`name`）→ 由插件进程原子写盘，返回完整路径；重名自动 `-2/-3`，文件名只保留安全字符 |
| 面板接线 | 底部「导出」先把 JSON 写到桌面并把路径写进弹窗提示；仓库「分享」改为 `export_to_file {kind:"zip"}` 写桌面 + 提示条显示路径，base64 下载仅作兜底 |
| entry 级实测 | `json->desktop` 5907 B、`zip->desktop` 410105 B（`PK\x03\x04`）、`json->downloads`、`json->plugin`、`zip->plugin` 全部存在且大小正确；`kind:"pdf"` / `target:"c:\windows"` 均被拒且文案清楚；连导 3 次得 `-2/-3/-4` 不覆盖；按仓库 id 导出得 `导出探针主题-<ts>.zip` |
| 面板级实测 | 真实面板页点「导出」→ `modal-hint` = 「文件已保存到：C:\Users\…\Desktop\星辰喵-Starry-Meow.json（6 KB，含 2 张背景图）」，status「已导出并保存到桌面」；点仓库「分享」→ 提示「分享包已保存到 …\星辰喵-Starry-Meow-20261115195729.zip（含 2 张背景图，400 KB）」，桌面上两个文件都在（5907 B / 410105 B） |
| 部署 | loader/py/面板 app.js 全 MATCH；`__init__.py` 81722 → **87567 B**（`c6d836e7`），面板 app.js 125503 → **127237 B**（`bec73318`），`index.html` 引用 `./app.js?v=0.1.6-bec73318`；插件 stop+start 成功 |

### 教训

- **iframe 里的「下载没反应」先查 sandbox**：`allow-downloads` 缺失是零报错失败，看控制台看不出来。
- 走 `Page.setDownloadBehavior` 时新版 Chromium 可能无响应，**必须给短 timeout**，否则会把整个探测脚本卡满 `SOCK_TIMEOUT`。
- 手工起 headless 要在参数末尾带 `about:blank`，否则没有 page target，`probe.Page(port)` 直接抛 `no devtools page target`。

### PENDING

1. 真实 Electron 窗口里点「导出/分享」的人眼确认（headless 已确认文件落盘与提示文案正确）。
2. macOS / Linux 的桌面路径（`~/Desktop`、`~/Downloads`）未实测。
3. `target:"plugin"` 返回的 `exports/` URL 在真实窗口里未点击验证。

## 第十三轮（2026-11-15 夜间 · 换机不能运行 / 安装自检卡 / 测试 harness 重建）

### 症状与根因
用户报告「把插件装在其他设备上不能正常运行」。核心事实：主题不是纯 CSS 注入，而是
**运行时由插件写进 N.E.K.O 本体**（`resources/bin/static/neko-theme-studio.{js,css}` + 23 个模板）。
这条链上任何一步失败都只写 warning，`startup` 依旧返回成功 → 用户侧表现为"装上了但完全没效果"，
而且没有任何可见提示。

### IMPLEMENTED
| # | 改动 | 说明 |
| --- | --- | --- |
| 1 | `_app_patch.find_app_root(plugin_root, tried=None)` | 新增出参收集试过的候选；全部失败时回填到诊断的 `search_paths` |
| 2 | `_app_root_from_processes()` / `_process_image_paths()` | 新增进程级兜底：Windows 用 PowerShell 枚举进程 `Path`，非 Windows 用 `ps`；只留名字含 `neko`/`projectneko` 的，再上溯找 `resources/bin/templates`。动机：`sys.executable` 与父进程线索只在"插件进程由宿主 backend 直接拉起"时有效 |
| 3 | `ensure_app_patch()` 诊断字段扩展 | 新增 `search_paths` / `platform` / `platform_note` / `plugin_root` / `autostart` |
| 4 | `_platform_note()` | macOS 的 `.app` 受系统保护、Linux 的 AppImage/只读挂载/Flatpak 不支持改写 → 直接说明，而不是静默失败 |
| 5 | 面板「安装自检」卡片 | `#health-state` / `#health-list` / 一键修复 / 「为什么没生效？」帮助弹窗；三态 `is-ok` / `is-warn` / `is-bad` |
| 6 | `_probe\deploy_panel_all.py` | 通用部署脚本（index.html + style.css + app.js + `__init__.py` + `_app_patch.py` + 两个 `?v=` 键 + stop/start）。此前的 `deploy_brightness.py` **只部署 app.js**，导致"源码里有、跑起来的没有" |

### 验证
- 正常态：真实面板页 `health-state` = 「一切正常：主题已经装进 N.E.K.O」、`is-ok`、5 条明细（应用侧补丁已就位 /
  安装目录 / 样式与脚本就绪 / 已注入 23 个页面跳过 14 个 / 开机自启 scheduled）。
- 一键修复 + 帮助弹窗：`_probe\health_card_e2e.js` 全绿（status「修复完成」、对照 notice、帮助弹窗 642 字、可关闭）。
- 失败路径演练 `_probe\health_failpath.py`（临时假 app root，不动真实目录）4 项全 PASS：
  找不到安装根（`search_paths` 11 条 + 明确 warning）／原子写失败（`assets_failed` + `[WinError 5] 拒绝访问`）／
  缺必备模板（`missing_required: ['chat.html']`）／卸载标记（`disabled`）。
- 失败态 UI `_probe\health_failstate_ui.js`：`is-bad` + 六条明细（含"试过：<路径>"与原始 warning）；macOS 态展示 `platform_note`。

### 测试 harness 重建（换机后的真实故障）
portable 版 N.E.K.O 上跑 `theme-studio\test\run-tests.ps1` / `accept.ps1` 全崩，逐条查清：
1. **48911 不再服务任何新建文件**：`/static/<anything>.html`、`/static/css/_xprobe.css` 全部 404，
   只有打包时就存在的文件是 200（它是"已知文件"路由，不是目录服务）。
2. **插件 API 不发 `Access-Control-Allow-Origin`**：`file://` 页面 origin 为 `null`，
   loader 的 `fetchPalette` 抛 `TypeError: Failed to fetch` → 调色板从未应用 → `accept.ps1` 6 个 gate 全灭
   （`_probe\diag_live_fetch.py` 实测 `lastError: "Failed to fetch"`、`styleLen: 0`）。
3. 修法：探针页/live 页改由**插件 48916 同源**提供（`/plugin/neko_theme_studio/ui/_nts_*.html`），
   所有原生 CSS 与主题 CSS/JS 一律 `[System.IO.File]::ReadAllText` 从磁盘内联。
   `probe.ps1` 新增 `$script:NtsProbeServe`（`NTS_PROBE_SERVE`，默认 `plugin`，`file` 保留供离线调试）。
4. `diagnose()` 与 `determineMine()` 同时认 `link[href*=neko-theme-studio.css]` 与
   `style[data-nts-src]`（内联表的 `sheet.href === null`，否则规则数恒 0）。
- 结果：`run-tests.ps1` EXIT=0（6 次探测各 315 rows、`ntsRules 584`、零改动不变量 0 差异、覆盖率 175/175）；
  `accept.ps1` **86 passed, 0 failed**。

### 教训
- **PowerShell 5.1 无 BOM 的 UTF-8 `.ps1` 含中文会被按 GBK 解码**，注释会"漏"成代码，报出一堆假语法错
  （`Unexpected token ')'`、`The '<' operator is reserved` 等）。修法：写单个 UTF-8 BOM；
  **不要重复加**（`EF BB BF EF BB BF` 会让整个文件无法解析）。
- asciify 一个 `.ps1` 时不能盲目删非 ASCII 字符 —— 会把注释压成可执行垃圾行。
- 部署脚本必须覆盖"面板三件套"（index.html / style.css / app.js），只覆盖 app.js 会产生经典假象。
- 磁盘路径：安装副本在 `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\`，
  **`LOCALAPPDATA` 之后还有 `N.E.K.O` 这一层**。

### PENDING
1. 真机换机只在"本机 portable 版 + 市场导入"这一种路径上验证过；"另一台完全干净的机器 + 首次安装"仍缺现场证据。
2. `_app_root_from_processes` 依赖 PowerShell 枚举进程，在受限环境（无 PowerShell / 无权限查进程路径）下会退回纯上溯。
3. macOS / Linux 支持目前是"明确报错"而非"真正可用"。

## 第十四轮（2026-11-15 深夜 · 无限制自检 / 命名颜色 / 多层阴影 / 内置主题图丢失）

### IMPLEMENTED

| # | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 14-1 | `--nts-chat-bg = red` / `rebeccapurple` / `0 0 5px black` 全部被拒 | 颜色白名单只认 `#hex`/`rgb()`/`hsl()`/`transparent` | 三份校验器同步加入 148 个具名色 + `currentcolor`（`RE_KEYWORD_COLOR` / `COLOR_NAMES` + `isNamedColor()`），刻意不收 `inherit`/`initial`/`unset`/`revert` |
| 14-2 | 双层 `box-shadow` 被整串拒收 | token 数上限 6，双层必然超 | 新增 `_split_shadow_layers()` / `shadowLayers()` 按层切分，最多 4 层，逐层校验 |
| 14-3 | `apply_theme` 所有值都被拒仍返回 `succeeded` | 只收集 `rejected`，不判定「一条都没写进去」 | `_apply_and_store` 返回 `accepted`，`apply_theme` 在全拒时 `Err("没有写入任何改动：…")` |
| 14-4 | 应用内置主题后背景图消失、只剩 63 项 | `_rewrite_archive_refs()` 只认本机 `backgrounds/` 已存在的图，预设的可移植 `images/<name>` 引用被当缺图丢弃，随后被 GC 回收 | 新增 `from_presets=True` 分支，回落读 `presets/images/<name>`；图随插件发布 |
| 14-5 | `build_info.PLUGIN_VERSION` 停在 0.1.7 而 `plugin.toml` 已 0.1.9 | 升版本时漏改 | 同步到 0.1.9，并把「两者一致性」加进自检 |

### 本轮验证数据

- `_probeudit_all_entries.py`（14 entry 全矩阵，含 44 条 apply_theme 用例 / 6 类恶意 theme_id / 11 类恶意 zip / 7 类图片攻击 / 6 种导出组合）：**VERDICT PASS**，`FAILS (0) WARNS (0)`。
- `_probeudit_panel_ui.py`（真实面板页）：`rows=64 groups=7`、控件 `colorSwatch 47 / hexInput 47 / alphaRange 47 / textInput 15 / switches 1 / imgSwatch 1 / clearBtns 64`、`editable controls verified 63/64`（图片行需上传，设计上跳过）、`illegal cases 9 marked 9 leaked 0`、搜索 64→13→0→64、预览跟随全部断言通过：**VERDICT PASS**。
- `_probeudit_dark_mode.py`（真实 /chat，哨兵双写亮/暗）：`gates 123`；亮色 user-text `rgb(1,2,3)` / 暗色 `rgb(4,5,6)`；亮色 panel-bg `rgb(13,14,15)` / 暗色 `rgb(16,17,18)`；亮色 radius `11px` / 暗色 `22px`；top-fade mask 起始 alpha 亮 0.75 / 暗 0.25；背景亮度蒙版 alpha 亮 0.7 / 暗 0.2：**VERDICT PASS**。
- `_probeudit_pixels.py`（真实页注入真实类名 + 纯色图，读像素）：亮度 1.0/0.5/0.0 → 面板均色 93.3 / 46.7 / 0.0（单调）；top-fade 0→1 顶端均色 93.3→223.4；圆角 0px 角块填充 1.00、16px 0.754（理论 0.785）；无图/有图 redness −68.8 / +160.0：**VERDICT PASS**。
- `_probeudit_deploy.py`：theme CSS 6 份 `bb7cf77a0c5f`/125844、loader JS 6 份 `c312a05bb4f5`/61591、plugin python 2 份 `0a64e0bd08f9`/91602、app_patch 2 份 `7c9dbb78d7d2`、面板三件套 2+2+2、23 模板标记与 `/chat` 引用键均为当前值、served 与磁盘同哈希：**OVERALL PASS**。
- `_probeudit_repair_i18n.py`：`repair_app` 连跑 3 次全部 `succeeded`，第 2/3 次 `templates_patched=[]`、`assets_written=[]`（幂等）；13 个诊断字段齐全；i18n 中英各 31 键一一对应、无空值、安装副本一致；`build_info` 与 `plugin.toml` 均 0.1.9：**VERDICT PASS**。
- 仓库测试：`run-tests.ps1` **EXIT=0**（零改动不变量亮/暗各 0 差异、覆盖率 175/175、`ntsRules=584`）；`accept.ps1` **86 passed / 0 failed**。

### 教训

1. **「失败但返回成功」比报错更难发现**。`apply_theme` 之所以长期看起来没问题，是因为面板只读 `rejected` 数组，而全拒时数组为空、`status` 仍是 `succeeded`。凡是「收集失败项」的 entry，都必须再判定「成功项 == 0」。
2. **可移植引用与内容哈希目录是两套生命周期**。分享包里用 `images/<hash>` 是为了跨机器，但一旦本机解析不到就静默丢弃，遇到「随插件发布」的预设就会连环失效（先丢引用、再被 GC 回收）。凡是回落路径，都要能区分「第三方包缺图」与「内置资源」。
3. **审计脚本自己的 bug 会伪装成产品缺陷**。本轮 14 个「失败」里有 9 个是脚本写错（`collect()` 漏传 mode、`state.catalog` 不存在、`A.snapshot()` 返回 tuple 而非 dict、采样框被自己的 `outline` 盖住、`rgb()` 与 `rgba(...,1)` 格式差异）。判定前先证明「测量本身是对的」。

### PENDING

- 真实 Electron 窗口里的人眼观感（像素与 computed 都已量，但「好不好看」没法自动判定）。
- 另一台干净机器上首次安装的现场证据（本机已用 portable 版验证过 startup 自愈成功）。
- 面板剪贴板写入在 Electron 内的实际行为（`file://` 与无头环境都测不到）。

## 第十五轮（2026-11-16 凌晨 · 面板边缘光效 / 玻璃拟态）

面板新增一整个分组「面板光效 / 玻璃拟态」，13 个变量：光晕颜色 / 发光强度 / 光晕尺寸 /
呼吸幅度 / 呼吸节奏 / 描边颜色 / 描边粗细 / 四角高光 / 边缘内侧渐变 / 玻璃反射高光 /
内阴影 / 玻璃底色 / 玻璃磨砂。**插件版本号不动**（用户要求主题制作不再升版本），
只把加载器 `SCRIPT_VERSION` 升到 `1.5.10`（改白名单必须升，否则无法区分窗口里跑的是哪一版）。

### 为什么这么挂（三条都是实测结论，不要凭直觉改）

| 结论 | 数据 |
| --- | --- |
| 外发光**不能**挂 `.compact-export-history-scroll` | 它自带 `mask-image`（顶部 28px 渐隐），`box-shadow` 被整块裁掉 —— 全场只变 **4** 个像素。挂 `.compact-export-history-anchor::before` 变 **8901** 像素且不碰 mask |
| anchor 的 `::before` / `::after` 是空的 | 线性扫描应用 CSS 1.75 万行：`anchor::before` 命中 0 次、`::after` 0 次（scroll / preview-region 同样 0） |
| 玻璃磨砂必须走**负层** `::before` + `z-index:-1` | 直接给 scroll 加 `backdrop-filter` 只糊应用白底、糊不到画在它自己身上的背景图：图片清晰度 **−2%**；改负层后 **−62%**，而文字只 **−1%** |
| 祖先不裁剪 | 从 `.compact-chat-stage` 上溯 20 层，`transform` / `filter` / `backdrop-filter` / `contain` / `will-change` 全是 `none`/`auto`，`overflow: visible` → `hazards: []` |

### IMPLEMENTED

| # | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 15-1 | 反射高光完全不出现 | 生成器把**字面量颜色**当变量名塞进 `var()`，得到 `var(#ffffff, #ffffff)`，整条声明非法被丢弃 | 新增 `tintLiteral(literal, amountExpr)` 输出 `color-mix(in srgb, <字面量> calc(…), transparent)`；重新生成后 `var(#` 计数 0 |
| 15-2 | 只改「光晕颜色」时 0 像素变化（面板报成功） | 选择器要求 `glow-color` + `glow-strength` + `glow-size` **三个门控同时**成立 | `orRule(mode, triggers, target, decls)` 为每个触发变量各输出一份规则，其余参数取**设计默认**（强度 1 / 尺寸 24px）；实测「只给颜色」→ `0 0 24px 10.08px`、「只给尺寸 40px」→ `0 0 40px 16.8px` |
| 15-3 | 面板预览对光效开关毫无反应 | `renderPreview()` 判据是 `glowStrength !== null && > 0`，与 CSS 的 OR 语义不一致 | 改为 `glowOn = (颜色非空 \|\| 强度非 null \|\| 尺寸非空)`、`glowAmount = 强度 ?? 1` |
| 15-4 | 部署审计报 11 个光效变量「missing from CSS」 | 审计只认裸 `var(--nts-x)`，而光效用的是带设计默认的 `var(--nts-x, 24px)` | 审计新增 `consumed(key, css)` 同时接受两种形态，并把理由写进 docstring（**这是检查过严，不是产品缺陷**） |
| 15-5 | 13 个光效变量一起 `apply_theme` 返回 `succeeded`，但 `rejected` 里有 `--nts-panel-glass-blur 的值非法已拒绝 'blur(14px)'`，落盘只有 76/77 | `BLUR_VARS` 只有 `--nts-chat-blur` 一个成员：`_value_kind()` 从 `GLOW_AMOUNT_VARS` 一路判到 `NUMBER_VARS` 都不命中，回落 `"color"` → `blur(14px)` 不是颜色 → 整条拒收。而 `KNOWN_VARS` / loader 的 `NON_COLOR_VARS` / 面板 `CATALOG` 三处都登记了它，所以面板照常显示「模糊」、窗口照常接受 | `BLUR_VARS` 加入该变量（95737 → 95761 B），`py_compile` 通过，同步安装副本，`stop`/`start` 后重跑同一条 apply → `rejected: None`、**77/77** |

### 验证

| 项 | 数据 |
| --- | --- |
| 真实 `/chat` computed | 外发光 `color(srgb 0.470588 0.784314 1) 0px 0px 24px 10.08px`；强度 0.3 → `... / 0.3` + `7.2px`；描边 `2px solid rgba(255,255,255,0.72)`；`::after` 背景 4 条径向渐变；内阴影 `rgba(0,0,0,0.35) 0px 0px 18px 2px inset`；玻璃 `rgba(255,255,255,0.14)` + `blur(18px)` + `z-index:-1` |
| 像素（面板框外侧环形带均亮度） | 不设 **0.00** → 强度 0.3 **7.03** → 强度 1 **75.83** → 尺寸 48px **106.02**（单调）；强度 0 仍 0.00 |
| 呼吸动画 | CDP 把 `prefers-reduced-motion` 改成 `no-preference` 后暂停并推进时间轴：`t=0 → opacity 1`、`500 → 0.5`、`1000 → 0`、`1500 → 0.5`；幅度 0 时四点恒 1；`800ms` → `0.8s` |
| 面板端到端 | `rowCount` 64 → **77**、`groups` 7 → **8**、`missing []`；节奏行敲 `3` 回填 `3s`、`9999`/`zzz` 标红、`800ms` 保留；预览光晕/四角/描边/内阴影全部跟随 |
| 零改动不变量 | `run-tests.ps1` EXIT=0，亮/暗各 **0 差异**；`ntsRules` 616 |
| 回归 | `accept.ps1` **86 passed, 0 failed**；`deploy_audit.py` OVERALL PASS（catalog 77 键 missing 0） |
| 部署一致性 | CSS `48b1fb46`(138205 B) ×5、loader `5b5ab6bc`(63750 B) ×5、`__init__.py` `d93e75a7`、面板 app.js `d40aa067`、23 个模板键 bump、37 模板 UTF-8 全好、`/chat` 引用 `-48b1fb46` / `-5b5ab6bc` |

### 教训

1. **「改了没反应」的默认怀疑对象应该是门控，而不是渲染。** 本轮 15-2 就是 AND/OR 语义写错：
   面板照常报「已应用」，CSS 也照常生成，只有把三个变量分别单独设一遍才暴露出来。
   新加变量后，至少跑一遍「只设这一个」的最小用例。
2. **要在带 `mask-image` 的容器上加任何外扩效果，先量像素外溢。** `mask` 会把 `box-shadow`
   裁到只剩几个像素，而 computed 值看起来完全正常 —— 只有像素差分能发现。
3. **`backdrop-filter` 不会糊到元素自身的 `background-image`。** 想「只糊图片不糊文字」，
   必须把滤镜放在 `z-index:-1` 的中间层，让图片在它下面、文字在它上面。
4. **无头环境恒为 `prefers-reduced-motion: reduce`。** 想测动画必须用 CDP
   `Emulation.setEmulatedMedia` 覆盖，否则会误判成「动画没生效」。

### PENDING

- 真实 Electron 窗口里的人眼观感（发光强度与呼吸速度的「好看区间」需要人判断；
  像素与 computed 都已量过，但审美不能自动判定）。
- 「四角高光」在极扁窄窗口（如 300×80）下的观感 —— 四角径向渐变会互相重叠。
- 光效与「星辰喵」「Yui 冰蓝喵」两条内置主题的搭配尚未写进预设（目前是用户手动调）。

## 第十六轮（2026-11-16 上午 · 光效顶端错位 + 描边/高光/内阴影一直是死的）

用户原话：「现在历史聊天内容框，外面的一圈光效最上面比面板高出一截」。

### 为什么错位

`.compact-export-history-scroll` 自带
`mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)`
（让滚到顶部的内容淡出），所以面板可见顶边比盒子低 28px；而外发光挂在不带 mask 的
`anchor::before` 上，顶边停在盒子顶边 → 上方浮出 28px 无底板支撑的弧线。

修法：两个伪元素都加 `top: calc(28px * var(--nts-chat-top-fade, 1)) !important;`，
与用户可调的「顶部渐隐」联动，`left/right/bottom` 不动。

### 顺带查出：`::after` 那四组效果从来没有画出来过

`anchor::after` 的规则只写了 `border` / `background-image` / `box-shadow`，**没有
`content: ""`** → 伪元素不生成 → 描边 / 四角高光 / 玻璃反射 / 内阴影全部无效。
computed 依然报出正确值，只有像素能揭穿：描边设 6px 纯绿时整屏 0 个绿像素。

### IMPLEMENTED

| # | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 16-1 | 光效顶端比面板高出一截 | 容器自带 28px 顶部渐隐遮罩，伪元素不受其影响 | 两个伪元素 `top: calc(28px * var(--nts-chat-top-fade, 1))` |
| 16-2 | 描边 / 四角高光 / 反射 / 内阴影毫无反应 | `anchor::after` 规则缺 `content`，伪元素从未生成 | `AFTER_STRUCT`（content/position/inset/top/pointer-events/border-radius）`concat` 进每一组 `::after` 规则 |

### 验证

| 项 | 数据 |
| --- | --- |
| 描边像素 | 修复前 0 个绿像素 → 修复后 **9936** 个（左/右各 6px、顶边 6px） |
| 黑底中轴扫描（fade=1） | 修复前 `-40px` 已在发光（亮度 0.7）；修复后 `-40px` 纯黑，最亮 159.7 落在 `+26px`，面板从 `+28px` 起可见 |
| 环形带亮度（强度 0 / 0.3 / 1 / 尺寸 48） | 0.00 / 6.79 / 74.50 / 106.23 |
| 真实 `/chat` computed | `beforeTop 28px`、`afterTop 28px`、`afterContent '""'`、`afterPosition absolute`、`afterBgCount 5` |
| 真实窗口自报 | `scriptVersion 1.5.10`、`cssRules 632`、`lastApply {light:73, dark:73}` |
| `run-tests.ps1` | EXIT=0（315 rows、零改动不变量 0 差异、覆盖率 175/175） |
| `accept.ps1` | 86 passed / 0 failed |
| `deploy_audit.py` | OVERALL PASS（CSS `654604f6` / 142869 B ×5、模板 23 个键已 bump、served 与磁盘一致） |
| 用户调色板 | Yui 冰蓝喵，亮 77 / 暗 77，光效 13 项与 `--nts-chat-top-fade 1` 完好 |

### 教训

1. **伪元素类效果只认像素。** `getComputedStyle(el, '::after')` 会为一个「根本不存在」
   的伪元素如实返回全部声明值，这类假阳性只能靠截图证伪。
2. **同一个伪元素的多条规则要各自带结构声明。** 拆成「每组只写自己的属性」很自然，
   但只要每组都缺 `content`，就整组静默失效。
3. **给容器加装饰前先看容器自己的遮罩/裁剪。** `mask-image` 不作用于祖先，于是
   「同一块板」的可见边界与绘制盒边界相差 28px。

### PENDING

- 真实窗口在当前会话内尚未重载到 `654604f6`（`sheetHref` 仍是 `-e8d82621`），需等
  loader 的 15s 复检换表，或关掉聊天窗口重开一次（应用屏蔽了 F5/Ctrl+R）。
- 描边 / 四角 / 反射 / 内阴影首次真正可见，观感需要用户用眼睛确认强度是否合意；
  收法是调小 `--nts-panel-border-width` / `-corner-glow` / `-sheen` / `-inner-glow`。

## 第十七轮（2026-11-16 上午 · Yui 77 项重建 + `transparent` 白名单缺口）

用户把 `C:\Users\Administrator\Downloads\yui.txt`（77 项全参数表）交过来要求按它重配。
按文件逐项写入后，发现文件里大量使用 `transparent`，而这个词在 loader 与面板的白名单里
根本不合法 —— 也就是说「按文档配好」本身会有一部分静默失效。

| # | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 17-1 | 把任意「颜色」项设成 `transparent`，面板不标红、应用返回成功、外观完全不变 | `loader` 与面板的 `COLOR_NAMES` 表里没有 `transparent`（后端 `RE_KEYWORD_COLOR` 从第一版就有）。门控属性由 loader 写入，被拒 → 门控不生成 → 声明永不匹配 | 两张表都以 `'transparent aliceblue …'` 开头，共 150 项；loader `SCRIPT_VERSION` → `1.5.11` |

### 验证数据

- `window.NekoThemeStudio._internals.isSafeValue`：`transparent` 对
  `--nts-chat-bg` / `--nts-chat-panel-bg` / `--nts-image-bg` / `--nts-button-bg` /
  `--nts-scrollbar-track` 五项全部 `false` → 修后全部 `true`；
  `sanitizeVars` 也从丢弃变为原样保留。
- 面板 `isSafeValue`：同样五项 `false` → `true`。
- 面板真实页（`http://127.0.0.1:48916/plugin/neko_theme_studio/ui/`）：77 行，
  五项的 `.hex` 值都是 `transparent`、`is-bad` 全为 `false`、placeholder 是「原生 transparent」。
- 真实 `/chat` computed（注入真实紧凑历史结构，调色板 = yui.txt 全 77 项）：
  `scrollBg rgba(255,255,255,0.2)`（玻璃底色）、
  `scrollBgImg linear-gradient(rgba(0,0,0,0.15)…) + url(背景图)`、
  `scrollRadius 32px`、`scrollBefore filter blur(12px) / z-index -1`、
  `glow boxShadow … / 0.4 / 11.2px 4.704px`、
  `decor border 1px rgba(255,255,255,0.9) / inset 28px 0 0 / bgCount 5`、
  气泡 `rgba(255,255,255,0.8) / rgb(64,84,115) / 24px / outline 白 1px`。
- `run-tests.ps1` EXIT=0（六次探测各 315 rows、`ntsRules` 0/616、零改动不变量亮暗各 0 差异、
  覆盖率亮暗各 175/175）；`accept.ps1` 86 passed / 0 failed。
- `deploy_audit.py` OVERALL PASS（CSS `654604f6`×5、loader `55f048ab`×6、
  面板 app.js `841f7e34`×2、23 模板键 `-654604f6` / `-55f048ab`）。

### 教训

- 「文档写对」不等于「实现收得下」：拿一份外部规格批量写入时，先拿**每一项的值**
  逐个过一遍三处校验器（loader `_internals.isSafeValue` + 面板 `isSafeValue` +
  一次 `apply_theme` 的 `rejected`），再谈观感。
- 后端接受、前端拒绝 = 最坏的一种不一致：`apply_theme` 永远 succeeded，
  面板永远不报错，用户只能看到「什么也没发生」。

### 仍 PENDING

- 真实窗口需重载一次才会载入 loader `1.5.11`（应用屏蔽了 F5 / Ctrl+R，
  只能关窗重开或重启）。重载前 `transparent` 那五项在真实窗口里仍不会生效。
- `starry-meow` 内置主题仍是 64 项（不含光效），本轮只按用户要求重建了 `yui-ice`。
