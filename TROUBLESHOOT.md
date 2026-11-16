# 主题色不生效？3 分钟定位

> 适用症状：在插件面板里改了颜色、点了「应用」、提示成功，但应用窗口里的气泡/按钮/背景一点没变。
> 本文只做一件事：把「面板 → theme.json → loader → CSS 门控 → 元素计算色」这条链路拆成可判定的小段，指出断在哪。

## 第 0 步：确认两个服务在跑（10 秒）

1. 应用本身在跑：浏览器能打开 `http://127.0.0.1:48911/chat`。
2. 插件服务在跑：**用浏览器直接打开**
   `http://127.0.0.1:48916/plugin/neko_theme_studio/ui/theme.json`
   —— 应该看到一段 JSON，其中 `vars`（亮色）与 `dark_vars`（暗色）就是面板里配的东西，
   `version` 每次应用都会 +1。

   如果这一页打不开 / 报错 / 内容是空的 `{"vars":{},"dark_vars":{}}`，**问题在面板写入这一侧**，
   别往后查渲染 —— 先看面板状态栏是不是显示「已读取，版本 v · 亮色 N / 暗色 M」。

## 第 1 步：跑链路自检（30 秒）

### 方案 A（推荐，不需要装 node）

1. 切到 N.E.K.O 应用窗口，按 `Ctrl+Shift+I` 打开 DevTools。
2. 点 `Console` 页签。
3. 打开文件 `theme-studio/test/diagnose-in-app.js`，**全选、复制、整段粘贴**进 Console，回车。
4. 会打印一行 `[nts-diagnose] VERDICT` 和一段 JSON。

> 若 Console 拒绝粘贴，输入 `allow pasting` 回车后再粘（Chrome 的一次性保护）。

### 方案 B（有 node 的机器）

```
powershell -ExecutionPolicy Bypass -File .\theme-studio\test\diagnose-live.ps1
```

它用无头 Chrome/Edge 打开同一张页面跑同一个表达式，自动打印判读结果；
可加 `-Url` / `-Port` / `-BrowserPath` / `-OutFile`。

## 第 1.5 步：先看 Console 里有没有这两行（10 秒，不用跑脚本）

- **启动横幅**：`[theme-studio] loader v1.4.0 已加载，端点 http://127.0.0.1:48916/…`
  没有这行 = 脚本没加载/执行失败（模板补丁丢了，或路径不对）→ 重跑 `install.ps1` 并重启窗口。
- **单侧模式告警**：`[theme-studio] 当前是暗色模式，但调色板里暗色这一组是空的（亮色组有 N 项）…`
  出现这行 = 颜色确实写进去了，只是**当前模式没有对应值**。到面板切到同名页签补一遍即可 ——
  这也是「面板显示已应用、本体一点没变」最常见的成因。
- **陈旧样式表自愈（1.4.0 起）**：`[theme-studio] 检测到页面里的 neko-theme-studio.css 与服务器上的不一致…已强制重新加载样式表。`
  出现这行 = 这个窗口是在插件更新**之前**打开的（页面里的 `<link>` 还是旧的，浏览器按
  `immutable` 缓存一年不重取）。loader 已自动把 `<link>` 换成带 `nts-refresh=<时间戳>` 的新 URL，
  相当于原地刷新样式表；不需要你清缓存。旧窗口里的旧 bug 也只在这一刻才被替换掉。

> loader v1.1.0 起才会打这两行；旧 loader 静默（所以先看 `NekoThemeStudio.scriptVersion`，
> 本版应为 `1.4.0`）。

## 第 1.6 步：先确认「你盯着的元素」在当前布局里真的可见（30 秒）

真实聊天窗默认是**紧凑胶囊态**（`body.subtitle-web-host.react-chat-window-open` +
`.app-shell.chat-surface-mode-compact`）。这个布局下：

- `.chat-window` / `#react-chat-window-root` / `.chat-body` / `.composer-panel` 的高度是 **0**，
  背景被应用自己的 `background: transparent !important` 压平 —— 它们**看不见**，
  改 `--nts-chat-bg` / `--nts-chat-panel-bg` 时不要盯着它们判断有没有生效；
- 真正可见的表面是 `.compact-chat-surface-frame` 的 `::before`（底色，读
  `--compact-chat-surface-bg`）、`::after`（白色高光）、`.compact-input-tool-toggle`
  （与 `.send-button-circle` 是**同一个按钮**）、7 个 `.composer-tool-btn`；
- 悬浮层（猫爪任务 HUD、插件面板）用的是 `#agent-task-hud` 一族，样式由
  `resources/bin/static/common-ui-hud.js` 以**内联 style + `var(--neko-popup-*)`** 写，
  所以本版把这些变量**桥接**过去（见 `THEME_CONTRACT.md` §3.3「紧凑胶囊 / 悬浮 HUD」）。

本版（loader 1.4.0 + CSS 生成器）已经给上面这些真实可见面加了门控规则：配了
`--nts-chat-bg` → 胶囊底色变；配了 `--nts-panel-bg` / `--nts-panel-text` → 猫爪 HUD 变；
配了 `--nts-accent` → 胶囊描边变。若这些仍不变，按第 2 步对号入座。

> 注意 HUD 头部（`#agent-task-hud-header`）与 `.compact-chat-surface-frame` 自己带
> `transition: background-color .4s`：注入后**同一帧**读 `getComputedStyle` 仍是旧值，
> 要等 400ms 以上再判断。用 DevTools 的 `Elements → Computed` 时先让页面停稳。

## 第 0.5 步：插件没在跑？（本版已自动化，无需手工）

冷启动后如果插件停在 `stopped`，表现是面板能打开、但每次「应用」都失败，或应用窗口颜色一直是原生色。
本版（loader 1.4.0 + 面板 0.1.4）**两侧都会自己把插件叫醒**，正常情况下你什么都不用做：

| 由谁自愈 | 触发条件 | 动作 |
| --- | --- | --- |
| 应用侧 loader | 拉 `theme.json` 得到 `HTTP 404` / `HTTP 503` / `Failed to fetch` | `GET /security/csrf-token` → `POST /plugins/refresh` → `POST /plugin/neko_theme_studio/start`，然后 0.6s / 2.5s 后各重拉一次 |
| 插件面板 | `callPlugin` 失败且错误像「插件没起来」（5xx / 超时 / not running） | 同样 refresh → start，等 0.9s 后自动重试一次调用 |

节流 12 秒、最多 40 次；一旦成功拉取就重置预算。想立刻手动触发，在应用窗口 Console 里执行：

```js
NekoThemeStudio.revive();   // 立刻 refresh + start，并重拉调色板
NekoThemeStudio.diagnose(); // 看 reviveCount / lastReviveError 判断自愈有没有跑过
```

自愈仍然无效时，多半是**插件服务整个没起来**（48916 打不开）。按顺序手工确认：

```powershell
# 1) 插件服务活着吗
Invoke-WebRequest http://127.0.0.1:48916/health -UseBasicParsing
# 2) 插件注册表里有没有它（返回 13 个插件为正常）
Invoke-WebRequest http://127.0.0.1:48916/plugins -UseBasicParsing
# 3) 手动刷新 + 启动（这两步就是自愈做的事）
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:48916/plugins/refresh -ContentType application/json -Body '{}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:48916/plugin/neko_theme_studio/start -ContentType application/json -Body '{}'
```

> 顺序不能反：`refresh` 负责把插件重新登记进注册表，`start` 只在注册表里已有它时才真正能起进程。
> 若 `/plugins` 返回 `{"plugins":[],"message":"no plugins registered"}`，说明宿主的用户插件总开关是关的 ——
> 但 `refresh` 本身就能把注册表补回来，所以先按上面三步做即可。
## 第 2 步：按 verdict 对号入座

| verdict（第一个失败项） | 含义 | 怎么修 |
| --- | --- | --- |
| `loader-mounted` | `window.NekoThemeStudio` 不存在：`/static/neko-theme-studio.js` 没加载或执行报错 | 页面源码里搜 `NTS:BEGIN`，没有就是模板补丁丢了 → 重跑 `theme-studio/install.ps1` |
| `loader-version` | loader 是旧版（本版应为 `1.4.0`） | 重启应用窗口即可：插件启动时会自己把 `plugin\static\loader\neko-theme-studio.js` 同步进 `resources\bin\static\`（带内容哈希，URL 变化自动绕开缓存）。只有连插件都没起来时才需要重跑 `install.ps1` |
| `css-sheet` | `<link>` 在，但样式表解析出 0 条规则（多半 404 拿到空/HTML） | 浏览器直接打开 `http://127.0.0.1:48911/static/css/neko-theme-studio.css`：应是 CSS 文本。404 就重跑 `install.ps1`（§D） |
| `css-link` | 页面没有 `<link ...neko-theme-studio.css>` | 同上（补丁同时插 link 与 script） |
| `fetch-theme-json` | 拉 `theme.json` 失败：插件服务没起 / 端口不对 / 跨源被拒 | 先看 `diagnose().lastReviveError`；自愈无效就回第 0.5 步手工 refresh + start |
| `palette-nonempty` | 拉到了但两组都是空 | 面板的「应用」没有真的写进去，或点了重置。改一项→应用→再看 `version` 是否 +1 |
| `enabled` | `enabled=false` | 面板里打开「启用主题」再应用 |
| `mode-has-values` | **最常见**：当前处于亮色（或暗色），但只有另一组配了值 | 切到面板里同名的页签，把这一组也配一遍（亮/暗**各管各的**，见 `theme-studio/THEME_CONTRACT.md:105`） |
| `style-injected` | 有数据但没注入 `<style id="nts-dynamic">` | 版本号相同被跳过：Console 里执行 `NekoThemeStudio.refresh()` 强制重拉 |
| `gates-applied` | 没有 `data-nts-*` 门控属性 | CSS 每条规则都门控在 `data-nts-l-*` / `data-nts-d-*`，无属性=规则空转。多为 loader 拿到空 `vars` |
| `var-resolves` | `--nts-*` 在当前文档解析为空 | 模式不匹配（回到 `mode-has-values`），或样式表没被浏览器接受 |
| `bubble-colored` | 变量对了，**元素计算出来的颜色却没变** | 真的级联问题：DevTools 选中该元素 → `Styles` 面板看被划掉的规则；把截图/规则名发回 |

> **文字色隔离（1.4.0 起）**：`--nts-ai-bubble-text` 只作用于 **assistant** 气泡正文，
> `--nts-user-bubble-text` 只作用于 **user** 气泡正文（纯文本与 markdown 都算），
> tool/system 气泡正文用 `--nts-tool-bubble-text`。若改 AI 色仍然连带改了用户文字，
> 说明这个窗口还持有旧样式表（见第 1.5 步「陈旧样式表自愈」）：关掉聊天窗重开一次即可。

`CHAIN OK` 表示：磁盘上的 `theme.json` 能被 loader 应用，且元素实际计算色与配置一致。
此时如果你肉眼仍看不出变化，多半是——

- 你改的变量管的是**另一个元素**（比如改了 `--nts-user-bubble-bg` 却盯着助手气泡）；
- 应用窗口里有多个样式来源彼此覆盖（把 `bubble-colored` 展开的 `bg` 值发回可判）；
- 改的颜色与原生色几乎一样（对比度太低，看起来「没变」）。

## 三个「以为是 bug、其实不是」

1. **亮/暗两组各管各的**。暗色模式下只配亮色 = 零效果。这是需求，不是缺陷（`theme-studio/THEME_CONTRACT.md:105`）。
2. **面板是装到别处的副本**：`%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\`，
   而 loader/CSS 在 `resources\bin\static\`。改 `theme-studio/plugin/` 之后重跑 `install.ps1` 会同步并重装；
   而 loader 与 CSS 的日常迭代不必跑脚本 —— 插件每次启动都会把它们同步到 `resources\bin\static\`，
   并且把内容哈希写进 URL（`?v=...-<哈希8位>`），所以改完重启窗口就会生效。
3. **出厂 `theme.json` 是空的**（故意的）：装完不动面板，颜色就该是原生色。

4. **模糊值只接受绝对长度**：`--nts-chat-blur` 的单位只允许 `px` / `rem` / `em` / `pt`
   （或 `0`）。填 `18%` / `18vh` 会被面板与后端**拒绝并提示**，不会再出现「提示成功但毫无变化」。
5. **用户气泡里的 markdown 文本不再跟 AI 文本色走**：v0.1.4 之前 `.message-block-markdown` 的颜色规则
   没有作用域，会把用户气泡里的正文一起染成 `--nts-ai-bubble-text`；本版已按气泡类型分别门控。

## 回传什么

- `diagnose-in-app.js` 打印的**整段 JSON**（尤其是 `verdict`、`theme`、`loader`、`checks` 里失败项的 `detail`）。
- 如果断在 `bubble-colored`：再附 DevTools `Elements` 里该元素的 `Computed → background-color`，
  以及 `Styles` 里被划掉的那条规则（截图或复制一行即可）。
