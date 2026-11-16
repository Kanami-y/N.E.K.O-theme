# 主题工坊（neko_theme_studio）

N.E.K.O 的可视化主题编辑器插件。面板里逐项调整聊天界面的颜色变量，保存成一份
调色板（palette），由应用侧加载器轮询后实时注入到应用窗口。

- 插件 id：`neko_theme_studio`
- 面板：静态页面（`static/index.html`），从 `http://127.0.0.1:48916/plugin/neko_theme_studio/ui/` 提供
- 数据文件：`static/theme.json` —— 应用侧加载器唯一读取的来源
- **参数总表（77 个可改项 + 取值尺度）：[`../PARAMETER-REFERENCE.md`](../PARAMETER-REFERENCE.md)**

---

## 1. 组件关系

```
┌─────────────────────────┐        POST /runs            ┌──────────────────────────┐
│  插件面板（静态页面）    │ ───────────────────────────► │  __init__.py（本插件）   │
│  48916 /plugin/<id>/ui/ │ ◄─────────────────────────── │  校验 → 合并 → 原子写盘  │
└─────────────────────────┘       导出 run 结果          └────────────┬─────────────┘
                                                                     │ os.replace
                                                                     ▼
                                                          static/theme.json
                                                                     │
                                              GET …/ui/theme.json    │ 轮询 1500ms
                                                                     ▼
                                                      ┌──────────────────────────┐
                                                      │ 应用侧加载器             │
                                                      │ neko-theme-studio.js     │
                                                      │ 注入 <style id=nts-…>    │
                                                      └──────────────────────────┘
```

面板 iframe 运行在 **48916** 源，应用窗口在 **48911** 源：两者跨源，
`localStorage` 不共享、`BroadcastChannel` 不互通，所以唯一的同步通道就是
`theme.json` 这个 HTTP 文件。

---

### 1.1 装上即用：自愈与热更新

本插件需要改动应用侧文件（模板 + 静态资源），但**这些改动全部由插件自己在 startup 完成**：

| 环节 | 谁做 | 失败后果 |
| --- | --- | --- |
| 同步样式表/加载器到 `resources\bin\static\` | `_app_patch._sync_asset()` | 只记日志 |
| 给 23 个模板打 `NTS:BEGIN/END` 标记段 | `_app_patch._patch_template()` | 该模板跳过，计入 `warnings` |
| 把 `auto_start` 偏好落盘 | `_ensure_autostart_async()`（daemon 线程） | 只记 warning |
| 插件没跑时把服务叫醒 | loader 的 `reviveService()` / 面板的 `revivePlugin()` | 下一轮轮询再试 |

**热更新**：模板标记段的 URL 形如
`/static/neko-theme-studio.js?v={{ static_asset_version }}-<内容哈希8位>`，
末尾 8 位是文件内容的 sha256 前 8 位。改了 `static\loader\` 里的文件并重启插件，
URL 会变，而 48911 对 `/static/*?v=…` 回 `immutable` 缓存 —— URL 变即缓存失效。
所以「改文件 → 重启插件 → 应用窗口自动用新版」这条链是自洽的，不需要清缓存。

> 为什么不直接改 `{{ static_asset_version }}`：它是进程启动时固定的，改文件不会让它变，
> 这一点已实测确认（把 CSS 的 mtime 改到当下，GET `/` 返回值一模一样）。

**可用性兜底**：`repair_app` entry 可随时手工重跑整套应用侧集成，返回值与 startup 相同；
面板状态栏与 `studio_context.app_patch` 也会带上最近一次的结果。

### 1.2 你看到的窗口长什么样（决定「改了颜色没变」的判断方式）

真实聊天窗默认是**紧凑胶囊态**：`.chat-window` / `.chat-body` / `#react-chat-window-root`
的高度为 0，背景被应用自己的 `transparent !important` 压平，**它们本来就看不见**。
可见面只有：

- 胶囊本身 `.compact-chat-surface-frame`（底色走应用变量 `--compact-chat-surface-bg`，
  本插件按变量门控改写它，而不是硬压 `background`）；
- 发送/工具按钮 `.compact-input-tool-toggle`（与 `.send-button-circle` 同一个元素）；
- 悬浮层 `#agent-task-hud`（猫爪任务）/ 插件面板：样式是内联 `var(--neko-popup-*)`，
  本插件把这些原生变量**桥接**到 `--nts-panel-*` / `--nts-accent*` / `--nts-shadow`。

因此：配 `--nts-chat-bg` 看胶囊底色、配 `--nts-panel-bg` 看猫爪 HUD；
盯着透明的 `.chat-body` 判断「没生效」会误判。细节与坑（400ms transition）见
`TROUBLESHOOT.md` 第 1.6 步。
## 2. 十四个 entry

前六个是「读写调色板 + 应用侧自愈」，v0.1.4 起又加了七个，围绕
**主题仓库（theme library）**与**聊天背景图**；v0.1.7 又加了 `export_to_file`
（面板 iframe 没有 `allow-downloads`，下载会被丢弃，改由插件进程写盘）。
十四个 entry 的调用方式完全一样
（`POST /runs` + 轮询 + `/runs/<id>/export`，见 §7「调用约定」），没有新的传输层。

| id | 参数 | 说明 |
| --- | --- | --- |
| `get_theme` | 无 | 返回当前调色板（`schema`/`name`/`enabled`/`updated_at`/`vars`/`dark_vars` —— **不再有 `version`**，见 §6.4） |
| `apply_theme` | `vars: object`、`dark_vars: object`、`name: string`、`enabled: boolean`（均非必填） | 校验后**合并**进当前调色板，原子写盘，刷新 `updated_at`。`name` 传空串/纯空白 = 恢复默认名「默认」；传非字符串才报错 |
| `reset_theme` | 无 | 写回内置默认调色板（同样刷新 `updated_at`：加载器判等靠整份 JSON 的文本，见 §6.4） |
| `export_theme` | 无 | 返回 `payload` —— 调色板的 JSON **文本** |
| `import_theme` | `payload: string`（必填） | 解析 + 校验后**整体替换**调色板 |
| `repair_app` | 无 | 重跑应用侧集成（同步样式表/加载器 + 补模板标记），返回与 startup 相同的诊断字典 |
| `list_themes` | 无 | 列出主题仓库全部条目，新的在前 |
| `save_theme` | `name: string`（非必填，≤60） | 把**当前已落盘**的调色板存成一个仓库条目；不传 `name` 就沿用调色板里的 `name` |
| `apply_saved_theme` | `theme_id` 或 `id`（二选一） | 把仓库条目**整体替换**成当前调色板并立刻落盘 |
| `delete_theme` | `theme_id` 或 `id`（二选一） | 从仓库删掉一个条目（**不影响**当前正在用的调色板） |
| `import_theme_archive` | `data: string`（必填）、`filename: string` | 导入分享包（zip，也接受裸 JSON），存进仓库 |
| `export_theme_archive` | `theme_id` 或 `id`（二选一） | 把仓库条目打成 zip 分享包，返回 base64 |
| `import_background` | `data: string`（必填）、`filename: string` | 存一张背景图到 `static/backgrounds/`，返回可写进 `--nts-chat-bg-image` 的绝对 URL |
| `export_to_file` | `kind: "zip"` 或 `"json"`、`theme_id` 或 `id`（可选）、`target: "desktop" \| "downloads" \| "plugin"`、`name: string` | 把当前主题（或指定仓库条目）**直接写到本机磁盘**，返回完整路径。面板 iframe 的 sandbox 没有 `allow-downloads`，浏览器下载会被静默丢弃，所以面板走这条 |

`apply_theme` / `import_theme` / `apply_saved_theme` / `import_theme_archive` 的返回值在有条目被拒绝时
额外带一个 `rejected: string[]` 字段，面板会把它展示给用户。

> **参数名两个都收**：`apply_saved_theme` / `delete_theme` / `export_theme_archive` 的
> `input_schema` 里同时声明了 `theme_id` 与 `id`（都 `type: string, maxLength: 64`，都非必填），
> 函数体第一行是 `theme_id = theme_id or id`。面板发的是 `id`（更自然），CLI/脚本里习惯写
> `theme_id` —— 两个都收是为了不让调用方猜参数名（曾因只认 `theme_id` 导致面板的
> 「应用 / 分享 / 删除」三个按钮全部报「条目 id 非法」）。其余新 entry 只有一个语义参数，
> 名字就是表里写的那个。

### 2.1 七个新 entry 的参数与返回形状

下面每个形状都是**后端的实际返回**（不是设计稿）。取返回值的办法见 §7「调用约定」：
`POST /runs` 的 body 是 `{plugin_id, entry_id, args}`（字段名是 **`entry_id`**，不是 `entry`），
拿 `run_id` 轮询到 `succeeded`，再 `GET /runs/<id>/export` 取 `{items:[…]}`，挑
`items.find(i => i.type === 'json' && i.json)` 那一条，读 **`item['json']['data']`**。
下面写的 `{…}` 就是这个 `data`。

**`list_themes`** —— 参数 `{}`：

```json
{
  "count": 2,
  "themes": [
    {
      "id": "sakura-pink-20261115140211",
      "name": "樱花粉",
      "saved_at": "2026-11-15 14:02:11",
      "light": 12,
      "dark": 9,
      "has_image": true
    }
  ]
}
```

- 返回键是 **`themes`**（不是 `items`）。面板也同时兼容 `items`，但那是历史包袱：
  早期版本字段名对不上，仓库列表永远是空的。
- `saved_at` 已由后端格式化成 `YYYY-MM-DD HH:MM:SS`（原始 ISO-8601 的 `T` 换成空格，取前 19 位；
  取不到就是 `—`）。
- `light` / `dark` 是**变量条数**，不是配色，也不是「改了几次」。
- `has_image` = 该条目 `vars` 或 `dark_vars` 里至少有一条 `--nts-chat-bg-image` 指向真实图片。
- 排序按 `saved_at` 倒序；坏掉的 `<id>.json` 会被跳过并记一条 warning，不影响其余条目。

**`save_theme`** —— 参数 `{"name": "樱花粉"}`（或 `{}`）：

```json
{ "saved": true, "theme": { "id": "…", "name": "…", "saved_at": "…", "light": 12, "dark": 9, "has_image": false } }
```

- 顶层**没有** `id` / `name` / `count` 键 —— 新条目的 id 在 `theme.id` 里。
- 快照的是**磁盘上当前的调色板**，不是面板里未提交的改动。
- 超过 200 条会 `Err`：`主题仓库已满（上限 200 个），请先删除一些再保存。`

**`apply_saved_theme`** —— 参数 `{"theme_id": "…"}` 或 `{"id": "…"}`：

```json
{ "applied": true, "theme": { … }, "light": 12, "dark": 9, "rejected": [] }
```

- **整体替换**：`vars` 与 `dark_vars` 都换成条目的内容（不是合并），`name` 一起换，
  `enabled` 强制为 `true`，`updated_at` 刷新。所以面板调用成功后会清掉本地的
  `edited` / `cleared` 再重读一遍 —— 从这一刻起后端的调色板就是条目内容。
- 条目里的坏值不会写进 `theme.json`，而是进 `rejected`。

**`delete_theme`** —— 参数 `{"theme_id": "…"}` 或 `{"id": "…"}`：

```json
{ "deleted": true, "theme_id": "sakura-pink-20261115140211" }
```

- 回显的键是 `theme_id`（不是 `id`），值就是你传进来的那个字符串。

**`export_theme_archive`** —— 参数 `{"theme_id": "…"}` 或 `{"id": "…"}`：

```json
{ "filename": "樱花粉-20261115140211.zip", "data": "<base64>", "bytes": 18432, "images": 1 }
```

- `data` 是**整个 zip 文件的 base64**，不是文本、不是 JSON。面板先 `base64ToBytes`
  再 `downloadBlob(bytes, filename, 'application/zip')`。
- `bytes` 是 zip 的**原始字节数**（不是 base64 长度）。
- `images` 是引用到的图片张数 = `vars` 里的图片引用数 + `dark_vars` 里的图片引用数。

**`import_theme_archive`** —— 参数 `{"filename": "樱花粉.zip", "data": "<base64>"}`：

```json
{ "imported": true, "theme": { … }, "source_format": "zip", "rejected": [] }
```

- `source_format` 是 `"zip"` 或 `"json"`：后端看前 4 字节是否为 `PK\x03\x04`，
  不是就走裸 JSON 分支。
- `data` 兼容带 `data:` 前缀的写法（`data:application/zip;base64,…`）。
- **只入库，不切换**：导入不会改当前的配色，也不会碰 `theme.json`；要在面板里点「应用」
  才会切换（`ARCHIVE_README` 里也写了这句）。
- `vars` 与 `dark_vars` 都空时报
  `分享包里没有可用的调色板变量（可能不是主题工坊的分享包）。`

**`import_background`** —— 参数 `{"filename": "sunset.png", "data": "<base64>"}`：

```json
{
  "url": "http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/9f3c1a77b0e4d215.png",
  "filename": "9f3c1a77b0e4d215.png",
  "bytes": 82311,
  "kind": "png"
}
```

- 返回的是**裸 URL**。前端（或调用方）要自己拼成 `url("<url>")` 才能写进
  `--nts-chat-bg-image` —— 后端不代劳，因为该变量的合法值只有 `none` 或这个 `url(...)` 形态。
- `filename` = 内容 sha256 的前 16 位 + 嗅探到的扩展名。同内容重复上传不会重复写盘。
- `kind` 由文件头嗅探（`png` / `jpg` / `jpeg` / `webp` / `gif`），认不出来就是 `unknown`
  并随后被拒（只认这五种）。
- `filename` 参数只用于日志（`来自 sunset.png`），不参与命名 —— 所以不会出现路径穿越。
- 上限 4 MiB（`IMAGE_MAX_BYTES`），base64 字符串上限 8 MiB。

**`export_to_file`** —— 参数 `{"kind": "zip", "target": "desktop"}`（可选 `"theme_id"` / `"id"` / `"name"`）：

```json
{
  "path": "C:\\Users\\you\\Desktop\\星辰喵-Starry-Meow-20261115195258.zip",
  "filename": "星辰喵-Starry-Meow-20261115195258.zip",
  "bytes": 410105,
  "kind": "zip",
  "target": "desktop",
  "images": 2
}
```

- **为什么需要它**：面板跑在宿主的 sandbox iframe 里，sandbox 串是
  `allow-scripts allow-forms allow-popups allow-same-origin allow-modals` ——
  **没有 `allow-downloads`**，所以 `Blob` + `<a download>` 触发的下载会被 Chromium
  静默丢弃（页面上没有任何报错，用户只看到「没文件」）。改由插件进程写盘就绕开了这一层。
- `kind`：`zip` = 分享包（含 `images/` 与 `theme.json`，同 `export_theme_archive` 的格式）；
  `json` = 单个调色板 JSON（`{schema, name, enabled, updated_at, vars, dark_vars}`，缩进 2）。
- `target`：`desktop`（`~/Desktop`，不存在则回落 `~/OneDrive/Desktop`、`~`）、
  `downloads`（`~/Downloads`）、`plugin`（`static/exports/`，并额外返回可访问的 `url`）。
- **不覆盖同名文件**：重名自动追加 `-2` / `-3` …；文件名只保留 `[0-9A-Za-z中文._-]`。
- 不传 `theme_id` 时导的是**磁盘上当前调色板**（不含面板里未应用的改动）。
- 无图片引用缺失问题：与 `apply_saved_theme` 走同一套 `_validate_palette` 校验。


---

## 2.6 安装自检：主题没生效时先看这张卡片

插件装到换一台机器上时，最常见的失败不是主题变量写错，而是**插件没能把主题装进 N.E.K.O 本体**：应用侧的
`resources/bin/static/neko-theme-studio.{js,css}` 与模板注入是运行时写进去的，目标目录写不进去（Program Files、
macOS 的 `.app`、只读挂载、杀软锁文件），或者根本找不到安装根，主题就永远不会出现。

面板右下角有一张「安装自检」卡片，它调用 `repair_app`（同时也是**一键修复**），把结果直接摆在界面上：

| 卡片状态 | 含义 |
| --- | --- |
| 一切正常：主题已经装进 N.E.K.O (`is-ok`) | 资源就位、模板已注入、开机自启已登记 |
| 基本可用，但有几处需要注意 (`is-warn`) | 有 warning，通常不影响本次生效 |
| 没装好：主题不会生效 (`is-bad`) | `assets_failed` / `missing_required` / 找不到安装根 |

卡片上还有「为什么没生效？」按钮，弹出按现象分类的排查清单（装了没变 / Program Files / macOS / 打包版本 /
为什么要点应用 / 亮暗两套）。

`repair_app` 返回的诊断字段（也是卡片渲染的输入）：

| 字段 | 说明 |
| --- | --- |
| `ok` | `not missing_required and not assets_failed` |
| `app_root` | 定位到的 N.E.K.O 安装根；为空表示没找到 |
| `search_paths` | `app_root` 为空时，逐个试过的候选目录（排查第一手资料） |
| `platform` / `platform_note` | `sys.platform` 与已知不支持平台的说明（macOS / Linux） |
| `disabled` | 检测到卸载标记，自愈被跳过 |
| `assets_written` / `assets_unchanged` / `assets_failed` | 应用侧两件套的写入结果 |
| `templates_patched` / `templates_unchanged` / `templates_skipped` / `missing_required` | 模板注入结果 |
| `autostart` | 开机自启偏好是否已落盘 |
| `warnings` | 所有原始告警文本 |

定位安装根的顺序：`NEKO_APP_ROOT` 环境变量 → 插件进程自身可执行文件上溯 → 父进程可执行文件上溯 →
遍历系统进程里名字含 `neko` / `projectneko` 的可执行文件上溯。全部命中判据都是
`resources/bin/templates` 存在。

### 2.7 v0.1.9 的校验放宽（第十四轮自检发现）

第十四轮自检里挖出两处「明明是合法的 CSS，插件却不收」的缺陷，都已修：

| 症状 | 原因 | 现在 |
| --- | --- | --- |
| `--nts-chat-bg = red` 被拒 | 颜色白名单只认 `#hex` / `rgb()` / `hsl()` / `transparent` | 认 148 个 CSS 具名色 + `transparent` + `currentcolor`；`box-shadow` 里的颜色 token 同样放宽 |
| `--nts-chat-bg = inherit` 被拒 | 同上 | **故意继续拒收** —— `inherit`/`initial`/`unset`/`revert` 会把颜色继承成父级，正是「改了 AI 色结果用户文字也变」那类串色投诉的来源 |
| 阴影写多层被拒 | `box-shadow` token 数上限 6，双层阴影必然超 | 改成按层切分，最多 **4 层**，每层各自校验 |
| `apply_theme` 里所有值都被拒仍然返回成功 | 只收集 `rejected`，从不判定「一条都没写进去」 | 一条都没写进去时返回失败：「没有写入任何改动：…」 |

> 面板里键盘输入还有额外宽容：长度行敲 `16` 自动变成 `16px`，模糊行敲 `7` 自动变成 `blur(7px)`，数值行接受 `1.0` / `1.00`。手改 `theme.json` 与 JSON 导入不走这层宽容，必须是完整写法。

## 3. 安全校验（本插件的核心）

面板是跨源 iframe，它的输入**一律视为不可信**。所有值在写入磁盘之前都要经过
`_validate_palette()`，返回 `(clean_vars, clean_dark, errors)`；只有 `clean_*`
里的内容会落盘。

### 3.1 变量名

必须匹配 `^--nts-[a-z0-9-]{1,60}$`。这条规则与
`neko-theme-studio.js` 里的 `isSafeVarName()` **完全一致**，因此
`--compact-*`、`--xy-*` 之类的变量会被双方一致拒绝。

> 为什么是「形状校验」而不是「目录白名单」：随包发布的
> `neko-theme-studio.css` 用到了一些契约 §3 里没有列出的变量
> （如 `--nts-code-bg`、`--nts-bubble-radius`、`--nts-status-text`）。
> 若按目录做白名单，这些合法变量会被误杀。安全性由**值**的校验保证。

### 3.2 变量值

值先经过一道黑名单：含 `;` `{` `}` `<` `>` `\`、`@import` 或 `url(` 一律拒绝。
圆括号**故意不禁止** —— `rgb()` / `hsl()` 这类合法值本身就需要括号，真正的安全
来自下面每种类型各自的「整串锚定」正则。

| 类型 | 变量 | 接受的形态 |
| --- | --- | --- |
| `color` | 其余全部变量 | `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb(…)` / `rgba(…)` / `hsl(…)` / `hsla(…)` / `transparent` |
| `length` | `--nts-radius`、`--nts-font-size`、`--nts-bubble-radius`、`--nts-shell-radius`、`--nts-card-radius`、`--nts-modal-radius`、`--nts-popover-radius`、`--nts-rec-radius` | `px` / `rem` / `em` / `%` / `pt` / `vh` / `vw` / `0`，**不接受负数** |
| `blur` | `--nts-chat-blur` | `blur(<长度>)` 或裸长度（会被规范化为 `blur(…)`，见 §3.3）；长度单位**只接受 `px` / `rem` / `em` / `pt` 或 `0`**，`%` / `vh` / `vw` 一律拒绝，**不接受负值** |
| `number` | `--nts-chat-opacity`、`--nts-bubble-veil`、`--nts-chat-bg-image-brightness`、`--nts-chat-top-fade` | `0`–`1` 的小数（含 `1.0` / `1.00` 这类零填充写法）、或 `0%`–`100%` 的百分比（落盘前归一成小数，见 §3.4）；`1.5`、`2`、负数一律拒绝 |
| `font` | `--nts-font-family` | 字母数字、中日文、空格、逗号、引号、`-_.`，最长 200 |
| `shadow` | `--nts-shadow` | 先按**顶层逗号**切成 1–4 层（`SHADOW_MAX_LAYERS = 4`，v0.1.7 起支持多层），每层再按「括号外空白」切分并按 box-shadow 语法校验：`inset` ≤1、颜色 ≤1、长度 2–4 个（合计 token ≤6）、**不接受百分比**；负值只允许出现在每层的前两个长度（x/y 偏移）。多层示例：`0 0 20px rgba(0,210,255,.4), 0 0 15px rgba(179,136,255,.5)` |
| `image` | `--nts-chat-bg-image` | **只有两种形态**：字面量 `none`，或 `url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/<文件名>")`。整串锚定；host 只认 `127.0.0.1` / `localhost`，端口 2–5 位、可省；文件名只允许 `[A-Za-z0-9._-]`，最长 80 |

> **`image` 类必须绕开上面那道 `url(` 黑名单**：黑名单里「含 `url(` 一律拒绝」是给颜色值用的，
> 而 `--nts-chat-bg-image` 的合法值本身就长成 `url(...)`。所以后端 `_is_safe_value()` 把
> image 分支放在黑名单**之前**判定，改由 `RE_BG_URL` 整串锚定（只允许指向本插件
> `backgrounds/` 的绝对 URL，或字面量 `none`）。加载器 `isSafeValue()` 的 `RE_BG_VALUE`
> 与面板的 `RE_BG_VALUE` 是同一个正则的镜像 —— 三处一致，任意一处放宽都会造出
> 「面板说成功、应用侧静默丢弃」的静默空操作。

被拒绝的值**永远不会写进** `theme.json`；对应变量在调色板中保留原值（若原本
不存在则继续保持不存在）。这一点有测试覆盖：注入串
`#ff8ab0; } html { display:none }`、`url(http://evil/x.png)`、
`8px; position:fixed` 提交后，磁盘文件里搜不到 `display:none` /
`position:fixed` / `url(`。

### 3.5 面板的宽容写法（不是放宽后端校验）

面板人在写值时会用最自然的写法，而「最自然的写法」和「CSS 能直接吃掉的写法」并不总重合。
v0.1.6 起面板在两处做**输入归一化**，把这类写法就地补全成合法值；后端与加载器的校验
**保持严格**，API 契约不变（手改 `theme.json` 或走 JSON 导入仍需写完整形态）：

| 场景 | 过去的体验 | 现在 |
| --- | --- | --- |
| 长度行（圆角 / 字号）里敲 `16` | 立刻标红，必须自己补成 `16px` | 按 `16px` 处理；输入框在提交时显示成 `16px` |
| 数值行里敲 `1.0` / `1.00` | 标红（`1` 才行），但 `1.0` 才是「100%」最自然的写法 | 接受；仍拒绝 `1.5` / `2` / `-0.3` |
| 长度行里敲 `-4px` | 标红 | 仍然标红（负圆角会让整条声明被浏览器丢弃，不能放行） |
| 模糊行里敲 `7` | 标红（要写 `7px` 或 `blur(7px)`） | 按 `blur(7px)` 处理 |

实现位置：`static/app.js` 的 `normalizeTypedValue(item, raw)` —— 遇到「纯数字、没带任何单位」的
输入时：`length` 行补 `px`、`blur` 行补成 `blur(Npx)`，其余原样交给 `isSafeValue()` 判定。
三份 `RE_NUMBER`（后端 `__init__.py`、加载器、面板）同步放行 `1.0+` 形式。

### 3.3 `--nts-chat-blur` 的陷阱

契约 §3 把它写成「px」，但 `neko-theme-studio.css` 的实际消费方式是：

```css
html body #react-chat-window-shell::before,
html body #react-chat-window-shell::after {
  backdrop-filter: var(--nts-chat-blur, blur(18px)) !important;
}
```

也就是说**原生的合法值就是 `blur(18px)`**。若只写 `18px`，
整条 `backdrop-filter` 声明会因语法非法被浏览器丢弃 —— 毛玻璃消失，而且
**不会有任何报错**。因此后端接受两种写法，并把裸长度统一规范化为
`blur(…)`（`_canonicalize_value()`），面板也提示用户填写 `blur(…)` 形式。

> **v0.1.4 修掉的真实 bug**：旧版把「长度」正则（含 `%` / `vh` / `vw`）直接用于 blur 归一化，
> `18%` 会被写成 `blur(18%)` —— 这是**非法 CSS**，加载器只接受
> `blur(px|rem|em|pt)`，于是静默丢弃整条值：面板报成功、毛玻璃毫无变化。
> 现在后端 / 加载器 / 面板三处都只放行绝对长度（`RE_BLUR_BARE`），
> 面板也会把 `18%` 直接标红，不再落盘。

### 3.4 值的规范化（`_canonicalize_value()`）

校验通过的值**不一定**原样落盘：有两种写法会被改写，目的是让 `theme.json`
里永远只有「应用侧加载器能直接消费」的形态 —— 否则就会变成「面板说成功、
外观没变」的静默空操作。

| 变量 | 用户写法 | 落盘值 | 为什么 |
| --- | --- | --- | --- |
| `--nts-chat-blur` | `18px` | `blur(18px)` | 消费方是 `backdrop-filter`，裸长度整条非法（见 §3.3） |
| `--nts-chat-opacity` | `50%` | `0.5` | 契约语义是 0–1 的乘子；百分比归一成小数（四舍五入到 4 位、去尾零：`33.3%` → `0.333`，`100%` → `1`） |

百分比只接受 `0%`–`100%`：`101%`、`999%` 直接拒绝（归一后 >1，加载器无处可放）。
归一在 `vars` 与 `dark_vars` 两路上完全一致 —— 两者走的是同一个校验/归一函数。

负值一律拒绝（`-10px`、`blur(-3px)`）：CSS 里负圆角 / 负字号 / 负模糊半径会让
**整条声明**被浏览器丢弃。但 `--nts-shadow` 的偏移量确实需要负号，所以只在
`shadow` 的前两个长度 token 上放行（`-4px 0 8px #000` 合法；负扩散半径虽合法，
但为避免与负模糊混淆，三处统一从严 —— 面板会标红而不是静默丢弃）。

> **三处校验没有方向性差异**：应用侧加载器（`app/neko-theme-studio.js` 的 `isSafeValue`）已镜像同一套
> 负数拦截与百分比上限，并**移除了**只存在于 loader 的 `var(--nts-*)` 派生色放行 —— 它曾造出
> 一条「只有手改 `theme.json` 才走得通」的路，且把颜色变量指向长度变量时整条声明会静默失效。
> 差分工具：`_local_verify/three_way.js` / `_local_verify/backend/loader_vs_backend.js`，
> 现为 **1903 / 2132 例 0 分歧**；`--nts-shadow` 自 v0.1.3 起三处都按 box-shadow 语法做结构校验
> （长度 2–4 个、颜色 ≤1、`inset` ≤1、不接受百分比）。

---

## 4. 完整变量目录与原生参考值

下表是面板里呈现的全部 **77** 个变量（面板 `CATALOG` 与本节逐条对应）。
**「亮色原生」/「暗色原生」只作参考显示**，面板不会自动把它们写进调色板 ——
原因见 §5。

| 分组 | 变量 | 亮色原生参考 | 暗色原生参考 |
| --- | --- | --- | --- |
| 聊天气泡 | `--nts-user-bubble-bg` | `#44b7fe` | `#2a7bc4` |
| 聊天气泡 | `--nts-user-bubble-text` | `#ffffff` | `#ffffff` |
| 聊天气泡 | `--nts-user-bubble-border` | `transparent` | — |
| 聊天气泡 | `--nts-ai-bubble-bg` | `#ffffff` | `rgba(42,123,196,0.18)` |
| 聊天气泡 | `--nts-ai-bubble-text` | `#24445a` | `#e0e0e0` |
| 聊天气泡 | `--nts-ai-bubble-border` | `transparent` | — |
| 聊天气泡 | `--nts-code-bg` | `rgba(91,111,145,0.12)` ※ | `rgba(100,120,160,0.18)` ※ |
| 聊天气泡 | `--nts-code-text` | `#22324d` ※ | `#c0cce0` ※ |
| 聊天气泡 | `--nts-image-bg` | `transparent` | `transparent` |
| 聊天气泡 | `--nts-tool-bubble-bg` | `linear-gradient(180deg,#f8fafc,#edf2f8)` ‡ | `linear-gradient(180deg,#232330,#1e1e2a)` ‡ |
| 聊天气泡 | `--nts-tool-bubble-text` | `#2b3a50` ‡ | `#b8bcc4` ‡ |
| 聊天气泡 | `--nts-status-bg` | `rgba(70,129,227,0.12)` ‡ | `rgba(68,130,230,0.15)` ‡ |
| 聊天气泡 | `--nts-status-text` | `#28589d` ‡ | `#6fa8ff` ‡ |
| 聊天窗口 | `--nts-chat-bg` | `transparent` | — |
| 聊天窗口 | `--nts-chat-panel-bg` | `transparent` | — |
| 聊天窗口 | `--nts-chat-panel-radius` | `0px` | — |
| 聊天窗口 | `--nts-topbar-bg` | `transparent` | — |
| 聊天窗口 | `--nts-topbar-text` | `inherit` | — |
| 聊天窗口 | `--nts-chat-blur` | `blur(18px)` | — |
| 聊天窗口 | `--nts-chat-opacity` | `1` | — |
| 聊天窗口 | `--nts-bubble-veil` | `1` | — |
| 聊天窗口 | `--nts-chat-bg-image-brightness` | `1` | — |
| 聊天窗口 | `--nts-chat-bg-image` | `none` | — |
| 输入区 | `--nts-input-bg` | `rgba(40,40,40,0.65)` ※ | `rgba(40,40,40,0.65)` |
| 输入区 | `--nts-input-text` | `inherit` | `#e0e0e0` |
| 输入区 | `--nts-input-border` | `rgba(255,255,255,0.06)` | `rgba(255,255,255,0.06)` |
| 输入区 | `--nts-input-placeholder` | `#9aa7b2` | `#999999` |
| 输入区 | `--nts-button-bg` | `transparent` | `#2d2d2d` |
| 输入区 | `--nts-button-text` | `inherit` | — |
| 输入区 | `--nts-button-hover-bg` | `#44b7fe1a` | `#44b7fe26` |
| 输入区 | `--nts-send-bg` | `#44b7fe` | `#2a7bc4` |
| 输入区 | `--nts-send-text` | `#ffffff` | `#ffffff` |
| 面板/弹窗 | `--nts-panel-bg` | `transparent` | — |
| 面板/弹窗 | `--nts-panel-text` | `#333333` | `#e0e0e0` |
| 面板/弹窗 | `--nts-panel-border` | `rgba(0,0,0,0.08)` | `rgba(255,255,255,0.1)` |
| 面板/弹窗 | `--nts-panel-text-sub` | `#666666` | `#b0b0b0` |
| 面板/弹窗 | `--nts-accent-bg` | `rgba(42,123,196,0.05)` | `rgba(58,159,216,0.1)` |
| 面板/弹窗 | `--nts-popover-bg` | `transparent` | — |
| 面板/弹窗 | `--nts-popover-text` | `inherit` | — |
| 面板/弹窗 | `--nts-popover-border` | `transparent` | — |
| 面板/弹窗 | `--nts-modal-bg` | `#ffffff` | `#2d2d2d` |
| 面板/弹窗 | `--nts-modal-text` | `#24445a` | `#e0e0e0` |
| 面板/弹窗 | `--nts-overlay-bg` | `transparent` | `rgba(0,0,0,0.65)` |
| 推荐/chip | `--nts-rec-bg` | `transparent` | — |
| 推荐/chip | `--nts-rec-text` | `inherit` | — |
| 推荐/chip | `--nts-rec-border` | `transparent` | — |
| 推荐/chip | `--nts-chip-bg` | `transparent` | — |
| 推荐/chip | `--nts-chip-text` | `inherit` | — |
| 全局 | `--nts-accent` | `#2a7bc4` | — |
| 全局 | `--nts-link` | `#2a7bc4` | — |
| 全局 | `--nts-highlight` | `rgba(68,183,254,0.35)` | `rgba(74,163,223,0.4)` |
| 全局 | `--nts-scrollbar-thumb` | `rgba(0,0,0,0.25)` | `rgba(255,255,255,0.2)` |
| 全局 | `--nts-scrollbar-track` | `transparent` | — |
| 非颜色 | `--nts-radius` | `8px` ※ | `8px` ※ |
| 非颜色 | `--nts-bubble-radius` | `16px` ※ | `16px` ※ |
| 非颜色 | `--nts-shell-radius` | `14px` | `14px` |
| 非颜色 | `--nts-card-radius` | `0px` | `0px` |
| 非颜色 | `--nts-modal-radius` | `0px` | `0px` |
| 非颜色 | `--nts-popover-radius` | `12px` | `12px` |
| 非颜色 | `--nts-rec-radius` | `18px` | `18px` |
| 非颜色 | `--nts-font-family` | `inherit` | `inherit` |
| 非颜色 | `--nts-font-size` | `0.94rem` | `0.94rem` |
| 非颜色 | `--nts-shadow` | — | — |
| 光效 / 玻璃 | `--nts-panel-glow-color` | `—` | `—` | 外发光色。只设它一项就有光，强度/尺寸取默认 1 / 24px |
| 光效 / 玻璃 | `--nts-panel-glow-strength` | `1` | `—` | 同时缩放光晕半径与不透明度；0 = 关掉 |
| 光效 / 玻璃 | `--nts-panel-glow-size` | `24px` | `—` | 光晕向外扩散的基础尺寸 |
| 光效 / 玻璃 | `--nts-panel-glow-pulse` | `0` | `—` | 呼吸幅度：0 = 常亮不呼吸，1 = 满亮 ↔ 全暗 |
| 光效 / 玻璃 | `--nts-panel-glow-speed` | `3.2s` | `—` | 一次呼吸的周期（`s` / `ms`，上限 60s） |
| 光效 / 玻璃 | `--nts-panel-border-color` | `—` | `—` | 半透明描边色；留空 = 无描边 |
| 光效 / 玻璃 | `--nts-panel-border-width` | `1.5px` | `—` | 描边粗细（内描边，不占布局） |
| 光效 / 玻璃 | `--nts-panel-corner-glow` | `1` | `—` | 四角径向高光，模拟玻璃边缘反光 |
| 光效 / 玻璃 | `--nts-panel-edge-gradient` | `1` | `—` | 从边缘向内的亮度衰减（inset 光） |
| 光效 / 玻璃 | `--nts-panel-sheen` | `1` | `—` | 左上斜下的反光带，0.3–0.5 最自然 |
| 光效 / 玻璃 | `--nts-panel-inner-glow` | `1` | `—` | 内侧下沉阴影，让面板显得「厚」 |
| 光效 / 玻璃 | `--nts-panel-glass-tint` | `—` | `—` | 半透明玻璃底色，铺在背板之上、背景图之下 |
| 光效 / 玻璃 | `--nts-panel-glass-blur` | `blur(18px)` | `—` | 只糊背景图本身（负层），正文不受影响 |

「—」表示该变量在对应模式下没有明确的原生字面量（多为 `inherit` 或该模式
不使用该变量）。

关于表中带 ※ / ‡ 标记的项的注记：

- **※ 一个变量对应多个原生值。** 生成的样式表把同一个变量打在多个目标上，
  而各目标的原生值并不相同，所以「原生参考」列只能给一个代表性值：
  - `--nts-code-bg` / `--nts-code-text`：`.message-markdown-inline-code`
    与 `.message-markdown-pre` 共用。行内代码原生有底色，代码块（`pre`）
    原生**没有**底色；文字色亮色下也不同（`#22324d` / `#1f2c42`）。
  - `--nts-image-bg`：`.message-block-image` 原生是 `transparent`，
    只有图片自身透明或加载失败时才看得见底色。
- **‡ 填写后会把多个原生值「拉平」成同一个值。** 这是覆盖而非替换，
  因此面板的 `hint` 里逐条写明了被拉平的另外几个原生值：
  - `--nts-tool-bubble-bg` 同时作用于 `.message-bubble-tool`（原生是
    渐变）与 `.message-bubble-system`（原生是半透明灰）。
  - `--nts-status-bg` / `--nts-status-text` 同时作用于
    `.message-block-status` 的 `tone-info` / `tone-success` /
    `tone-warning` / `tone-error` 四种 tone，而四者原生各不相同。
- `--nts-panel-text-sub` 与 `--nts-accent-bg` 是**桥接**项：生成的 CSS 不给
  目标元素直接赋值，而是写 `#agent-plugin-content` / `#agent-plugin-views`
  上的 `--neko-popup-text-sub` / `--neko-popup-accent-bg`，交给
  `agent-plugin-views.css` 消费（插件面板的标签页文字与选中/悬停底色）。

### 4.0b 面板光效 / 玻璃拟态画在哪一层（v0.1.10 起）

这 13 个变量全部挂在**同一个容器**上，不碰任何既有规则：

| 挂载点 | 承担什么 | 为什么是它 |
| --- | --- | --- |
| `.compact-export-history-anchor::before` | 外发光 + 呼吸动画 | anchor 自身没有伪元素；挂 `.compact-export-history-scroll` 会被它的 `mask-image` 整块裁掉（实测只渗出 4 个像素）。`top` 必须按下面的「顶部对齐」下推 |
| `.compact-export-history-anchor::after` | 描边 / 四角高光 / 反射高光 / 边缘渐变 / 内阴影 | 同上；`::after` 在应用 CSS 里也是空的（0 处占用）。**每组规则都必须自带 `content`**，见下 |
| `.compact-export-history-scroll` | 玻璃底色（`background-color`） | 与「聊天背板背景」同层但顺序在后，故压得住 |
| `.compact-export-history-scroll::before` | 玻璃磨砂（`z-index:-1` 的 `backdrop-filter`） | 必须夹在背景图与文字**之间**：直接给 scroll 加 backdrop 只会糊应用白底，糊不到画在它自己身上的图（实测图片清晰度 −2%，改用负层后 −62%，文字仅 −1%） |

三个设计要点：

1. **只设一项就生效。** 光晕的颜色 / 强度 / 尺寸三者**任一**被配置即出光，其余取主题自己的
   默认值（强度 `1`、尺寸 `24px`）。这些默认值写在 `var(--nts-…, <默认>)` 里，是**设计默认**，
   不是测量到的原生值 —— 后者才是契约禁止的 fallback。空调色板下 `data-nts-*` 门控属性一个都
   不存在，所有候选选择器都不匹配，零改动不变量照旧成立。
2. **颜色与强度是乘在一起的。** 发光色经 `color-mix(in srgb, <色> calc(强度*100%), transparent)`
   与半径 `calc(尺寸*强度)` 同时缩放，所以强度 `0.3` 得到的是「更小更淡」而不是「同样大小半透明」。
3. **呼吸动画自带 reduced-motion 守卫。** `@keyframes nts-panel-glow-breathe` 只有一份，
   `animation-duration` 取 `--nts-panel-glow-speed`；系统开启「减少动态效果」时，
   `@media (prefers-reduced-motion: reduce)` 会把它覆盖成 `animation: none !important`
   —— 与应用自身对 `.compact-chat-refraction` 等元素的做法一致。

动画不在无头环境里空跑：用 CDP 把 `prefers-reduced-motion` 改成 `no-preference` 后，
暂停动画并推进时间轴实测 `t=0 → opacity 1`、`t=500 → 0.5`、`t=1000 → 0`、`t=1500 → 0.5`；
呼吸幅度设 `0` 时四点恒为 `1`。

#### 4.0b.1 两个坑：没有 `content` 的伪元素根本不存在；光效要比面板低 28px

这两条都是「computed 全对、像素上没有」的类型，只有截图能证伪。

**① `::after` 的每一组规则都必须自带结构声明。** 生成器最初给
`anchor::after` 只输出 `border` / `background-image` / `box-shadow`，没写
`content: ""`。没有 `content` 的伪元素浏览器**不会生成**，整条规则等于不存在；
而 `getComputedStyle(anchor, '::after')` 依然会如实报出
`border: 6px solid rgb(0,255,0)`、四层渐变、内阴影 —— 看起来全都对。
把描边设成 6px 纯绿做像素取证，整屏 **0 个绿像素**才暴露出来。修好后同一探针
得 9936 个绿像素（左右各 6px、顶边 6px，位置正确）。

所以 `AFTER_STRUCT` 现在被 `concat` 进**每一组** `::after` 声明：

```
content: "" / position: absolute / inset: 0 / top: <见②> /
pointer-events: none / border-radius: var(--nts-chat-panel-radius)
```

`::before` 从一开始就带 `content`，所以外发光一直是活的 —— 这也解释了为什么
「光晕看得见、描边和玻璃高光却像没反应」。

**② 两个伪元素的 `top` 要比盒子低 28px。** 应用给
`.compact-export-history-scroll` 写死了

```
mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px)
```

用来让滚到顶部的内容淡出。于是**面板肉眼可见的顶边比盒子顶边低 28px**，顶上那
28px 是渐隐带。伪元素不受这条 mask 影响，画在盒子顶边就会浮出一圈没有底板支撑的
弧线（用户原话「最上面比面板高出一截」）。

修法与「顶部渐隐」联动，用户把它调小时对齐关系自动跟着走：

```css
top: calc(28px * var(--nts-chat-top-fade, 1)) !important;
```

`left/right/bottom` 仍是 0，只有顶边移动，底部与左右分毫不动。黑底中轴扫描实测：
修复前 `-40px` 处已在发光（0.7），修复后 `-40px` 纯黑，最亮处（159.7）正好落在
`+26px`，而面板从 `+28px` 开始可见。

**别改成给伪元素套同一条 mask。** mask 的绘制区就是边框盒，装不进外发光，外溢部分
会被整块裁掉 —— 实测整屏光晕归零。

### 4.1 三个文字色变量各管各的气泡（v0.1.4 起）

真实聊天 DOM 的气泡是 `article.message-row.message-row-<role> > div.message-stack >
 div.message-bubble.message-bubble-<role>`（React 动态生成，没有 `.message.user` 这种类名）。
 文字色必须写在**气泡作用域内**，否则会互相串染：

| 变量 | 只作用于 | 说明 |
| --- | --- | --- |
| `--nts-ai-bubble-text` | `.message-bubble-assistant`（兼容 `.message.gemini`）内正文 | 改它**不会**影响用户/tool/system 气泡 |
| `--nts-user-bubble-text` | `.message-bubble-user` 内正文 | 纯文本（`.message-block-text` / `-text-plain`）与 markdown 两种块都覆盖 |
| `--nts-tool-bubble-text` | `.message-bubble-tool` 与 `.message-bubble-system` 内正文 | 与这两个气泡的底色是同一变量组，不要拿 AI 色顶替 |

### 4.2 聊天记录到底画在哪一层（这决定了「改色没反应」）

真实窗口默认是**紧凑胶囊态**，此时消息**不走** `.message-bubble-*`，而是历史层：

```html
<section class="compact-export-history-anchor">
  <div class="compact-export-history-scroll">          <!-- 消息列表底板 -->
    <div class="compact-export-history-scroll-content">
      <article class="compact-export-history-message is-user|is-assistant|is-visit-peer|is-system">
        <div class="compact-export-history-bubble">     <!-- 气泡本体 -->
          <div class="compact-export-history-meta">作者 / 时间</div>
          <div class="compact-export-history-content">
            <div class="message-block-text[.message-block-text-plain]">…</div>
            <div class="message-block-markdown">…</div>
```

「导出图片」前那一屏结构相同，只是类名换成
`compact-export-preview-message` / `compact-export-preview-bubble`
（`is-visit-peer` 角色的原生底色是 `linear-gradient`，所以生成器会补一条
`background-image: none` 才让纯色生效）。

因此气泡类变量现在覆盖**四套**界面，每一套都按角色作用域写，互不串染：

| 界面 | 类名 | 何时出现 |
| --- | --- | --- |
| React 消息列表 | `.message-bubble-<role>` | 展开 / 非紧凑形态 |
| 紧凑聊天记录层 | `.compact-export-history-message.is-<role>` | **默认形态（用户平时看到的就是它）** |
| 导出预览层 | `.compact-export-preview-message.is-<role>` | 点「导出图片」后的预览 |
| 旧窗口 | `.message.user` / `.message.gemini` | `viewer.html` 窗口 |

> 历史 bug：`--nts-user-bubble-text` / `--nts-ai-bubble-text` 原先只写在
> `.message-bubble-*`（和旧 `.message.*`）上，**紧凑历史层一条规则都没有**，而
> 应用给那一层的颜色是写死的（`#273042` / `#d0e7ffe0` / 渐变 / `#607086`）——
> 于是「改了文字颜色完全没反应」。同一时期 `--nts-rec-*`（推荐卡片）还被打在
> `.compact-export-history-bubble` 上且没有角色作用域，于是「设一次推荐卡片文字，
> 用户和 AI 气泡一起变色」。两处都已修复，覆盖用例在
> `theme-studio\test\targets.js` 的「A 聊天气泡 · 紧凑/历史层」与「· 导出预览层」两段，
> fixture 在 `theme-studio\test\fixture.html` 的 `historyCompact` / `previewCompact`。

> 早期 bug（v0.1.4 之前）：旧样式表把 AI 文字色写成无作用域的全局规则，又把用户文字
> 规则挂在死选择器 `.message.user .message-block-markdown` 上 —— 表现就是「改 AI 色，
> 用户文字也变色；改用户色，一点反应没有」。判断修复是否生效：看 Console 的 loader
> 版本（当前应为 `1.5.10`），并确认窗口是升级后新开的（旧窗口由 loader 的
> 15 秒样式表复检 + 自升级逻辑自动换掉）。

### 4.3 `--nts-chat-bg-image` 画在哪儿，为什么它压得住底色

聊天背景图和聊天背板底色（`--nts-chat-panel-bg`）打在**同一层四面**上：

| 目标 | 说明 |
| --- | --- |
| `.compact-export-history-scroll` | 紧凑历史层的滚动底板（用户平时看到的就是它） |
| `.compact-export-history-scroll-content` | 上面那层的内层内容盒 |
| `.message-list` | React 消息列表（展开 / 非紧凑形态） |
| `.chat-body` | 聊天主体 |

生成的 CSS 是**四条联动**声明，缺一条都会破相：

```css
background-image: var(--nts-chat-bg-image) !important;
background-size: cover !important;
background-position: center center !important;
background-repeat: no-repeat !important;
```

> 为什么四条必须同进同退：`background-image` **不在**生成器的逐条声明表（`GATE_DECL`）里，
> 因为单独一条 `background-image` 并不成立 —— `background-size` 缺省是 `auto`、
> `background-repeat` 缺省是 `repeat`，结果是图片按原始像素**平铺**成马赛克。
> 所以这四条由 `tools/gen-css.js` 的一个专门段落一次性输出；
> `test/targets.js` 里只登记 `background-image` 一条（另三条由生成器补齐），
> 四处目标各一条门控。

**「图片优先于颜色替换」是构造性的，跟 `z-index` 无关**：同一个盒子上的
`background-image` 永远画在 `background-color` **之上**（CSS 背景层自下而上是
`background-color` → `background-image` → `background-position` 所在的定位层）。
所以只要 `--nts-chat-bg-image` 有一个有效值，`--nts-chat-panel-bg` 设成什么颜色都会被图片盖住。
这正是需求里那句「图片背景优先于颜色替换」的实现方式：不抬层级、不压 `!important`、
也不需要额外的开关 —— 两者共存，图片天然在上面。

> 遗留：`build/vars.json`（面板原生参考值的来源）仍然是 53 条，不含本轮的
> `--nts-chat-panel-radius` 与 `--nts-chat-bg-image`。它**不参与**生成的 CSS（契约 §3.2），
> 所以不影响外观；但它不是「变量全集」，别拿它当清单用。

---

### 4.4 `--nts-bubble-veil`：聊天背景上那层虚化的总开关

铺了 `--nts-chat-bg-image` 之后，很多人会觉得背景"发灰、看不清" —— 那不是图片的问题，
是**气泡自己**挡在上面。应用给每条消息气泡叠了两层东西：

| 层 | 原生值 | 效果 |
| --- | --- | --- |
| 白纱底 | `.compact-export-history-bubble` 的 `background: #ffffffe0`（alpha 0.878） | 把背景图压成一片浅色 |
| 背景模糊 | 同一元素 `backdrop-filter: blur(8px) saturate(1.08)` | 把背景图糊成色块 |

实测（`_probe\veil_bubble.py`，棋盘格垫在气泡下面、只量气泡内部）：

| 变体 | 气泡内部边缘能量 | 气泡均色 |
| --- | --- | --- |
| 原样 | **0.1**（几乎纯白，棋盘格完全看不见） | 239.8 |
| 只关 `backdrop-filter` | **595.5**（棋盘格仍被白纱盖住） | 239.5 |
| 白纱与模糊都关 | **40291.9**（棋盘格完整可见） | 127.5 |

所以**只关其中一个不够**，两层必须一起缩放 —— 这就是 `--nts-bubble-veil` 做成
0–1 **乘子**而不是布尔的原因：

```css
/* 白纱 */
background-color: rgba(255, 255, 255, calc(0.8784 * var(--nts-bubble-veil))) !important;
/* 模糊 */
backdrop-filter: blur(calc(8px * var(--nts-bubble-veil))) saturate(1.08) !important;
```

- `1`（或不设该变量）= 原生观感。
- `0` = 气泡底完全透明、模糊归零，背景图与底色完整透出来。
- 中间值按比例过渡（`0.5` → alpha 0.44 + `blur(4px)`）。

案子里的 11 个白纱层都吃这个乘子（历史层的 base/`is-user`/`is-system`/`is-visit-peer`、
空态、controls、导出预览层全套），详见 `theme-studio\test\targets.js` 的 `NTS_VEIL`。

**让位规则**：如果用户另外设了 `--nts-chat-blur`（毛玻璃模糊），模糊那一条就交给它、
本段只留白纱；同理设了 `--nts-user-bubble-bg` 之后该角色气泡的白纱也交给它。
两段各算各自的 `:not([gate])` 后缀，**不会出现"调了模糊，白纱莫名其妙也失效"**。

面板里是一个**开关**控件（`type: 'switch'`），关掉写 `0`、打开写 `1`；
留空（清空按钮）等于回到原生。

### 4.4b `--nts-chat-bg-image-brightness`：把背景图压暗，别跟正文抢视线

铺了背景图之后最常见的问题是「图太抢眼，文字看不清」。这个变量就是给背景图加一层
**黑色蒙版**，alpha = `calc(1 - 亮度)`：

```css
background-image:
  linear-gradient(rgba(0,0,0,calc(1 - var(--nts-chat-bg-image-brightness))),
                  rgba(0,0,0,calc(1 - var(--nts-chat-bg-image-brightness)))),
  var(--nts-chat-bg-image) !important;
```

| 取值 | 蒙版 alpha | 实测平均亮度（同一张图、同一区域） |
| --- | --- | --- |
| 不设置 / `1` | 0 | 37.1 |
| `0.6` | 0.4 | 22.6 |
| `0.3` | 0.7 | 11.5 |
| `0` | 1 | 0.5 |

（`_probe/brightness_pixels3.py`，无头 Chromium 截图后取面板内 340×260 区域的平均亮度。）

三个设计点：

1. **为什么不用 `filter: brightness()`**：图片是容器**自身的 background**，给容器加
   `filter` 会把子元素（气泡、文字）一起调暗 —— 等于把正文也压黑，正好与目的相反。
   渐变蒙版只作用于 `background-image` 这一层。
2. **门控必须同时要求两个变量**：`data-nts-l-chat-bg-image` **和**
   `data-nts-l-chat-bg-image-brightness` 都在时才出规则（`targets.js` 里叫 `requires`）。
   只设亮度不设图片时，`var(--nts-chat-bg-image)` 未定义会让整条 `background-image`
   作废，连底色都会一起丢掉。
3. **必须排在纯图片规则之后**：同特异性、同 `!important`，靠声明顺序取胜。

### 4.5 背景图与虚化的两个边界

- **背景图只在"有消息"或"展开态"才看得见**：紧凑态下能承载 `--nts-chat-bg-image`
  的四个容器里，`.compact-export-history-scroll` / `-scroll-content` / `.message-list`
  都只在有消息时渲染，`.chat-body` 在紧凑态高度为 0。空会话时背景图无处落笔 ——
  这是应用侧的 DOM 结构决定的，不是主题没生效。
- **虚化开关只影响"气泡那一层白纱"**：`.compact-export-history-bubble`、
  空态、控件带、导出预览层的白纱底与 `backdrop-filter` 由 `--nts-bubble-veil`
  统一缩放；`.compact-chat-surface-frame`（输入胶囊）与 `.window-topbar`
  的模糊归 `--nts-chat-blur` 管，两者互不让位。

### 4.4c `--nts-chat-top-fade`：背景图最上边那层「雾」

应用给历史列表容器（`.compact-export-history-scroll`，导出预览那边是同款
`.compact-export-preview-messages`）写了：

```css
mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,.78) 12px, #000 28px);
```

本意是让滚到顶部的内容淡出。但**背景图画在同一个容器上**，于是图片顶上 28px 也
被一起淡出 —— 看起来就是「导入的图片最上面蒙了一层白雾」。这个变量用 alpha 乘法
把渐隐收回来：

```css
mask-image: linear-gradient(to bottom,
  rgba(0,0,0,calc(1 - var(--nts-chat-top-fade))) 0,
  rgba(0,0,0,calc(1 - 0.22 * var(--nts-chat-top-fade))) 12px,
  rgba(0,0,0,1) 28px) !important;
```

- `1`（原生）= 0 / .78@12px / 1@28px —— 与应用的 mask 逐字节一致，所以「不配置」与
  「配置成 1」看起来完全一样。
- `0` = 整条 mask 全不透明 = 雾消失、图片顶边清晰。
- 中间值线性过渡；`-webkit-mask-image` 一起写（应用自己就是两条并排）。
- 实测（`_probe/top_fade_test.py`，纯红底 + 无头截图采样）：

  | fade | y+2 | y+12 | y+30 |
  | --- | --- | --- | --- |
  | `1`（原生） | rgb(227,198,208) ← 被冲淡 | rgb(248,50,53) | rgb(255,0,0) |
  | `0.5` | rgb(241,98,103) | rgb(252,25,27) | rgb(255,0,0) |
  | `0` | rgb(255,0,0) | rgb(255,0,0) | rgb(255,0,0) |

- 代价：关掉之后滚到顶部的消息会**硬切**，不再淡出。它跟「聊天背景虚化」
  （`--nts-bubble-veil`）是两件事：那个管气泡上的白纱与模糊，这个管列表容器顶部
  那条渐隐。

## 5. 为什么出厂调色板是空的

**这是本插件最重要的设计决定。**

### 5.1 生成的样式表里没有回退值

`neko-theme-studio.css`（v3 起）**刻意不含任何回退值**：没有一处
`var(--nts-X, <某个值>)` 形态。取而代之，**每一条规则都按 (模式, 变量)
两个键门控**：

```css
:root:not([data-theme="dark"])[data-nts-l-radius]:root:root body .window-topbar {
  border-radius: var(--nts-radius) !important;
}
:root[data-theme="dark"][data-nts-d-radius]:root:root body .window-topbar {
  border-radius: var(--nts-radius) !important;
}
```

- `data-nts-l-<var>` = 该变量**在亮色组**被用户配置过；
- `data-nts-d-<var>` = 该变量**在暗色组**被用户配置过；
- `data-nts-active` 同时打上，表示「至少有一个变量被配置过」。

加载器（`app/neko-theme-studio.js` 的 `setGates()` / `gateNameFor()`，
`gateNameFor(varName, mode)` 去掉整个 `--nts-` 前缀后拼 `l-` / `d-`）
负责把这些属性同步到 `<html>` 上；属性集合不变时不碰 DOM，避免多余的
整页样式重算。

三条结论因此是**构造性成立**的，不依赖任何量测：

1. **空调色板零视觉影响**：没有变量 → 加载器不打任何门控属性 →
   所有选择器不匹配 → 样式表等于没装。
2. **只配亮色的调色板碰不到暗色**：亮色规则前缀带
   `:not([data-theme="dark"])`，暗色下整条不匹配。
3. **只配暗色的调色板碰不到亮色**：暗色规则前缀要求
   `[data-theme="dark"]`。

### 5.2 为什么放弃「量出来的回退值」

早期方案是把量测页（fixture）里量到的原生值写成回退值，即
`var(--nts-radius, <量到的值>)`。该方案被**废弃**，原因是根本性的：
**在合成量测页里量到的值，不是真实页面的计算值。** 真实页至少有三处
量测页复现不了的差异——

- 真实 `/chat` 的 `<body>` 带 `.electron-chat-window` 类，使
  `body:not(.electron-chat-window) …` 这类规则在真实页根本不生效；
- 真实视口宽度（量测页会落进 `@media (max-width:768px)` 分支）；
- 应用**运行时注入的 `<style>` 层**（带 `!important`，压过所有样式表）。

于是一个「量出来的回退值」会在**用户根本没配置**的情况下静默改写外观，
直接违反契约 §9.3 的「未配置时视觉零变化」。门控方案消除了这个失效模式：
未配置 == 未加载，二者是同一件事。

样式表的加载顺序同样由安装器保证：`neko-theme-studio.css` 排在
`dark-mode.css` **之后**，因此在同等特异性下由本插件胜出。

### 5.3 由此得到的出厂状态

- `static/theme.json` 出厂即 `{"vars": {}, "dark_vars": {}}`；
- 面板每一行默认显示原生参考值作为**提示**，但只有用户真正改动过的行
  才会进入提交内容（`collect()` 只收集 `edited` / `cleared` 两个集合）；
- `reset_theme` 同样回到空调色板；加载器在 `vars` 与 `dark_vars` 都为空时
  会主动 `removeStyle()`，注释写的就是「空调色板 = 恢复原样」。

> 这与初始需求里「把完整变量目录连同默认值放进 `vars`/`dark_vars`」的字面
> 要求相冲突。我选择遵循契约 §9.3 与加载器的实际语义，把完整目录放进面板的
> `CATALOG`（以及本 README 的 §4 表格）作为可见的参考，而不是预填进调色板。
> 如果需要「一键填充原生值」，在面板里逐行填入即可。

---

## 6. 实现要点

### 6.1 原子写盘 + 互斥锁

```python
_WRITE_LOCK = threading.Lock()
```

写盘走「同目录临时文件 → `fsync` → `os.replace`」：

```python
tmp_path = self.static_dir / f".theme.json.{os.getpid()}.{threading.get_ident()}.tmp"
...
os.replace(tmp_path, self.theme_path)
```

临时文件与目标**同目录**是硬要求，否则 `os.replace` 可能跨卷而失去原子性。
整个「读 → 合并 → 写」序列都在 `_WRITE_LOCK` 内完成，避免并发丢更新。
测试用 40 个并发 `apply_theme` 验证过没有一次丢更新。

> **注**：这条断言原先是靠「40 个互不相同的 `version` 号」来证明的，而 `version` 已经被
> 移除（见 §6.4）—— 所以那个判据现在不存在了。本轮**没有**重跑这个并发用例；
> 要重跑的话判据得改成「40 次写入之后 `vars` 的并集完整、没有一次覆盖掉别人的键」。

### 6.2 容错

**读路径**（`get_theme` / `export_theme` / `studio_context` / 启动）永不抛异常：

- 文件不存在 → 启动时创建为默认调色板；`_read_unlocked()` 也返回默认值。
- 文件读不出来（被占用 / 权限不足）→ 记一条 warning，返回默认值，**不覆盖文件**。
- 文件内容不是合法 JSON → 读路径返回默认值；启动时 `_ensure_file()` 会先把原文件
  改名备份成 `theme.json.corrupt`，再写入默认调色板 —— 不静默销毁用户数据。
- 文件里存在非法值（例如手工改成了 `javascript:alert(1)`）→ 读盘时同样
  过滤掉，坏值永远不会流进应用侧加载器。

**写路径**（`apply_theme`）必须拿到真实基线，因此 `_read_unlocked(strict=True)`：
文件存在却读不出来 / 解析不了时返回 `Err(...)`，并保持文件原样。这一点是必须的 ——
若像读路径那样退回默认值，一次瞬时读取失败（Windows 上杀毒软件或索引器锁文件
就能触发）就会把用户已保存的全部变量抹掉、只剩本次新值，而且返回 `Ok`。

`reset_theme` / `import_theme` 是「整体替换」，不需要旧基线，因此仍按读路径的
容错规则处理 —— 文件坏掉时它们依然能把插件救回来。

所有 entry 都包在 `try/except` 里，失败返回 `Err(SdkError(...))`。

### 6.3 删除语义

- 变量的值为空串 `""` 或 `null` → 从调色板中**删除该键**，回退到原生值。
  面板的「清空」按钮就是这个语义。
- 被**拒绝**的值不会走到删除分支（它既不在 clean 结果里，也不是空值），
  因此一次误输入不会毁掉已经保存的好值。

### 6.4 变化检测：`theme.json` 不再有 `version`

以前 `theme.json` 里有一个 `version` 整数，只在真正落盘时 +1，加载器靠它判「要不要重绘」
（`p.version === currentVersion` 时直接跳过）。**这一版把这个字段彻底去掉了**，原因是它
只能表达「落盘过几次」，表达不了「内容变了没有」：手改文件不改版本号就等于没改、
把版本号改回去等于反悔、两次不同内容恰好同号又会漏刷。

现在的磁盘格式只有六个键：

```json
{"schema":1,"name":"默认","enabled":true,"updated_at":"2026-11-15T14:00:00+08:00","vars":{},"dark_vars":{}}
```

判等改成**比对整份 JSON 的原始文本**：

```js
var raw = '';
try { raw = JSON.stringify(p); } catch (e) { raw = ''; }
if (!force && raw === lastRaw) { return; }
applyPalette(p);
lastRaw = raw;
```

- 轮询仍是每 1500ms 一次（且只在窗口可见时），所以**手改 `theme.json` 最迟 1.5 秒被接住**；
- `storage` 事件那条旁路（另一个窗口写了 localStorage 缓存）同样按 `raw === lastRaw` 判；
- `updated_at` **不参与判等**，只给日志 / 诊断展示用（加载器的 `stampOf(p)`，注释写的就是
  「只用于日志/诊断展示，判等一律靠原始 JSON 文本」）。

> 关于「theme.json」/「version」的兼容：老文件里残留的 `"version"` 键被**刻意忽略** ——
> `_normalize()` 返回的字典里没有它，所以下一次任何落盘（`apply_theme` / `reset_theme` /
> `apply_saved_theme` / `import_theme`）都会让它自然消失。不需要迁移脚本，也不会报错。
> 出厂那份 `static/theme.json` 已经在本轮一并清成了六个键（`name` 也从 `"empty"` 改回
> `"默认"`，与后端 `DEFAULT_THEME_NAME` 对齐），所以新装的用户不会再看到残留字段。

由此得到两个可见差别：

1. **手改文件真的会生效**：以前手改不改 `version` 等于白改；现在内容文本一变，
   最迟 1.5 秒后应用窗口就跟着变。
2. **`version` 不再是「改了几次」的计数器**：任何依赖它的外部脚本都要改；
   面板也不再显示那个小数版本号 pill。

### 6.5 主题仓库落盘在哪儿

主题仓库是**一条一个 JSON 文件**，都放在插件自己的 `static/` 下：

```text
plugin/static/
├── theme.json                 # 当前生效的调色板（加载器唯一读的那个）
├── themes/                    # 主题仓库（_ensure_dirs() 首次启动时创建）
│   ├── sakura-pink-20261115140211.json
│   └── midnight-20261115093002.json
└── backgrounds/               # 背景图（首次上传时创建）
    ├── 9f3c1a77b0e4d215.png
    └── 3b81ac0d51fe77a4.webp
```

单个条目的记录结构（`_save_library_item()` 写出，`indent=2`、`ensure_ascii=False`）：

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

- **id 规则**：`<name 的 slug>-<YYYYmmddHHMMSS>`。slug = 名称小写、非字母数字压成 `-`、
  去首尾 `-`、取前 32 位、空则 `theme`；同一秒重名依次追加 `-2`、`-3`。
  id 必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，所以文件名天然安全（不可能出现 `..` 或分隔符）。
- **名称**：`_clip_name()` 去首尾空白、截到 60 字符、空则「默认」。
- **条数上限** 200（`LIBRARY_MAX_ITEMS`）。
- **写盘**同样是「临时文件 + `os.replace`」的原子写，且在 `_WRITE_LOCK` 内完成。
- **读**：glob `*.json` → 过滤 id 形状 → 逐个 `_validate_palette()` → 按 `saved_at` 倒序。
  坏文件跳过并记 warning（`仓库条目已损坏，跳过 <文件名>：<异常>`），不会因为一个坏文件让整列空掉。
- 删除是 `unlink(missing_ok=True)`，**幂等**；删掉的条目不会影响 `theme.json`。

背景图**不在仓库条目里**，只按内容寻址存在 `backgrounds/` 下：文件名 =
`sha256(内容)` 的前 16 位 + 嗅探到的扩展名，同内容重复上传不重写、不占第二份空间；
`--nts-chat-bg-image` 的值是指向它的绝对 URL：

```text
http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/9f3c1a77b0e4d215.png
```

（`static/` 经 `/plugin/<id>/ui/` 暴露，所以这个 URL 就是 `static/backgrounds/<文件>`。）

### 6.6 主题分享包（zip）的格式

`export_theme_archive` 产出、`import_theme_archive` 消费的是同一个格式：一个
`ZIP_DEFLATED` 压缩包，就三层东西。

```text
<名称>-<YYYYmmddHHMMSS>.zip
├── theme.json              # 调色板；图片引用被改写成可移植形式 url("images/<name>")
├── README.txt              # 给人看的一句话说明（见下）
└── images/
    └── 9f3c1a77b0e4d215.png    # 调色板里真正引用到的每张图（去重、按名字排序）
```

`README.txt` 的原文（`ARCHIVE_README` 常量）：

```text
N.E.K.O 主题工坊 · 主题分享包

theme.json 是调色板；images/ 里是与它配套的背景图。
用法：打开 插件 → 主题工坊 → 主题仓库 → 导入压缩包，选择本文件即可。
导入只会把主题存进仓库，不会立刻改动你当前的配色；在仓库里点「应用」才切换。
```

包内的 `theme.json` 和仓库条目结构相同（`schema`/`name`/`saved_at`/`vars`/`dark_vars`），
唯一差别是图片引用的写法：

| 位置 | `--nts-chat-bg-image` 的值 |
| --- | --- |
| 仓库条目 / `theme.json` | `url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/9f3c…….png")` |
| 分享包里的 `theme.json` | `url("images/9f3c…….png")` |

**导入时反过来做**：`_rewrite_archive_refs()` 把 `url("images/<name>")` 里的 basename 拿去
包里的 `images/` 找同名文件，找到就落盘到 `backgrounds/`（同样按内容寻址、去重）并改写成
绝对 URL；**找不到就把整条引用丢成空串**，让该变量回退到原生（没有背景图），
并记一条 `分享包里缺少图片 <name>，该引用已丢弃`。
——故意**不**保留坏路径：留一个指向 `images/…` 的引用，落到应用里就是一张 404 的图，
表现成「背景一片空白还查不出原因」。

限额（超出报 `Err`，都是硬上限）：

| 项 | 上限 | 触发时的错误文案 |
| --- | --- | --- |
| 整个 zip | 8 MiB | `分享包过大（<n> 字节，上限 8388608 字节）。` |
| 单张图片 | 4 MiB | 导入时按条目解压字节判断 |
| zip 条目数 | 300 | `压缩包条目过多（<n> 个，上限 300）。` |
| 解压后总字节 | 24 MiB | `压缩包解压后过大（<n> 字节，上限 25165824 字节）。` |
| 仓库条目数 | 200 | `主题仓库已满（上限 200 个），请先删除一些再保存。` |

另外几条导入行为：

- **裸 JSON 也能导入**：前 4 字节不是 `PK\x03\x04` 就走 JSON 分支，直接当成调色板解析
  （`.theme` / `.json` 后缀都可能出现）。这是为了兼容 v0.1.4 之前用 `export_theme` 导出的文本。
- **拒绝非法路径**：zip 里任何条目名以 `/` 开头、含 `..` 段或含 `:` 一律整体拒绝
  （`压缩包里含有非法路径：<name>`），防止有人塞一个 `../../x` 回来写盘。
- 挑 `theme.json` 时优先文件名正好是 `theme.json` 的条目；一个 JSON 都没有就报
  `压缩包里没有 theme.json（主题分享包应包含一个 JSON 调色板）。`
- 图片按扩展名收集（`.png` / `.jpg` / `.jpeg` / `.webp` / `.gif`），键用 basename，
  所以 `images/a/b.png` 与 `images/b.png` 在包里会被当成同一张（导出时不会产生这种结构）。

---

### 6.7 内置主题（随插件发布的预设）

除了用户自己存的仓库条目，插件还可以**内置几条主题**一起发布 —— 落盘位置和仓库分开，
免得用户清空仓库或换机器时把预设一起丢掉：

```text
plugin/static/
├── presets/                       # 内置主题（随插件发布，只读）
│   ├── starry-meow.json           # 星辰喵 Starry Meow（暗色系）
│   ├── yui-ice.json               # Yui 冰蓝喵（亮色系 · 果冻玻璃质感）
│   └── images/                    # 预设自带的图（可移植引用 images/<name>）
│       ├── 7d642a590cb2d089.jpg
│       └── 1fbd71acef54d52b.jpg
└── backgrounds/                   # 背景图（预设与用户上传共用同一套内容寻址命名）
    ├── 7d642a590cb2d089.jpg
    └── 1fbd71acef54d52b.jpg
```

预设的 JSON 就是**仓库条目格式 + 一个 `builtin` 标记**（写文件时不需要写 `builtin`，
它由读路径补上）：

```json
{
  "schema": 1,
  "id": "starry-meow",
  "name": "星辰喵 Starry Meow",
  "saved_at": "2026-11-15T18:49:41+08:00",
  "vars":      { "--nts-chat-bg": "#070314", "...": "64 项" },
  "dark_vars": { "--nts-chat-bg": "#070314", "...": "64 项" }
}
```

四条规则（都已在 v0.1.7 实测）：

1. **图片引用必须可移植**：预设里写 `url("images/7d642a590cb2d089.jpg")`，
   读取时由 `_rewrite_archive_refs()` 换成本机绝对 URL
   （`http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/7d642a590cb2d089.jpg`）。
   写死绝对 URL 的预设换台机器就会指向别人的端口。
2. **列表里合并展示、预设排前面**：`list_themes` 返回
   `_preset_items() + _library_items()`，预置项带 `"builtin": true`、`saved_at` 固定为「内置」。
3. **不能删除**：`delete_theme` 命中预设会返回
   「内置主题不能删除（它随插件一起发布）。想留下改动过的版本：先点「应用」，再「保存到仓库」另存一份。」
   面板对 `builtin` 项**不渲染删除按钮**（只有「应用」「分享」）。
4. **能分享**：`export_theme_archive` 对预设同样有效，导出的 zip 里图片引用会改写成
   `url("images/<name>")`，可以直接发给别人。

> **随包的两条内置主题（v0.1.10）**
>
> | id | 名称 | 风格 | 背景图 |
> | --- | --- | --- | --- |
> | `starry-meow` | 星辰喵 Starry Meow | 暗色 · 紫蓝霓虹 | `7d642a590cb2d089.jpg`（408 KB） |
> | `yui-ice` | Yui 冰蓝喵 | 亮色 · 冰蓝果冻半透明 + 纯白高光描边 | `1fbd71acef54d52b.jpg`（397 KB） |
>
> 两张图同时存在于 `presets/images/`（随包、可移植引用）与 `backgrounds/`（本机运行态）。
> 应用某条内置主题时，若 `backgrounds/` 里缺这张图，会从 `presets/images/` 补回 —— 这就是
> `_rewrite_archive_refs(..., from_presets=True)` 的用途。
>
> **Yui 冰蓝喵的三条设计要点**（照拄别人的调色板时最容易翻车的三处）：
> 1. `--nts-chat-bg` 设 `transparent`，让背景图从窗口层透出来（不是设成白色）。
> 2. `--nts-bubble-veil` 设 `0` 关掉气泡白纱 —— 否则半透明气泡会糊成一片白，果冻感全无。
> 3. 气泡描边用 95%~100% 纯白（`--nts-user-bubble-border` / `--nts-ai-bubble-border`），
>    这是「玻璃折射高光」的来源；只调背景色不设白边，看起来就是一坨淡蓝。
>
> 注意该主题同时设了 `--nts-chat-blur: blur(20px)`。按 `yieldsTo` 规则，显式的
> `--nts-chat-blur` 接管气泡的 `backdrop-filter`，`--nts-bubble-veil` 此时只让位不报错 ——
> 实测气泡 backdrop 是 `blur(20px)` 而不是 `blur(0px)`，属预期。

> **垃圾回收**：`_gc_backgrounds()` 扫 `theme.json` + `themes/*.json` + **`presets/*.json`** 的
> 原始文本找 `backgrounds/<name>` 与 `images/<name>` 两种写法 —— 只认前者的话，
> 插件一启动就会把「只被内置主题引用」的那张图当孤儿删掉（v0.1.7 修的就是这个 bug）。

## 7. 面板使用说明

| 控件 | 作用 |
| --- | --- |
| 亮色 / 暗色 | 切换编辑 `vars` 还是 `dark_vars`；两个模式各自独立记录改动 |
| 色块 `<input type="color">` | 选色；结果与透明度滑块合成 `rgba(r,g,b,a)` |
| 十六进制输入框 | 直接粘贴 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`；非法输入边框变红且不生效 |
| 透明度滑块 | 只能通过它调整 alpha —— 因为最终值统一以 `rgba(...)` 形式写入 |
| 清空 | 该行回退到 N.E.K.O 原生值（提交空串 = 删除该键） |
| 主题名 / 启用主题 | 对应 `name` / `enabled`（`enabled: false` 时加载器会移除注入样式） |
| 还原本组 | 只丢弃**当前模式**的未提交改动，不影响另一模式 |
| 应用 | 提交 `edited` + `cleared` 的并集，然后重新 `get_theme` 校准界面 |
| 重置 | `reset_theme` |
| 导出 | `export_theme`，弹窗内可一键复制 |
| 导入 | 粘贴 JSON → `import_theme`（整体替换） |
| 搜索框 | 按标签 / 变量名 / 提示文字过滤 63 行；`Esc` 清空，`Enter` 跳到第一个命中行 |
| 只看改动 | 只留下本次改过或清空过的行，用于提交前复核 |
| 全部收起 / 全部展开 | 一键折叠所有分组；单个分组标题也可点击或回车折叠 |
| 安装自检 · 状态 | `repair_app`：定位安装根、写应用侧两件套、注入模板、登记开机自启；三种状态 `is-ok` / `is-warn` / `is-bad` |
| 安装自检 · 一键修复 | 重跑 `repair_app`；成功后提示关窗重开或重启 N.E.K.O |
| 安装自检 · 为什么没生效？ | 按现象分类的排查清单（Program Files / macOS / 打包版 / 为何要点应用 / 亮暗两套） |
| 复制 dump | 把右侧调色板 JSON 复制到剪贴板（含未应用改动），便于贴 issue |
| 主题仓库 · 刷新 | `list_themes`，重新拉一遍仓库列表 |
| 主题仓库 · 保存 | `save_theme`；上方名称框留空就用当前主题名（`maxlength` 60） |
| 主题仓库 · 应用 | `apply_saved_theme`，**整体替换**当前调色板（含背景图），不是合并 |
| 主题仓库 · 分享 | `export_to_file {kind:"zip", target:"desktop"}`，把 `<名称>-<时间戳>.zip` **写到桌面**（后端写盘，不走浏览器下载） |
| 主题仓库 · 导入 | `import_theme_archive`，可选 `.zip` / `.theme` / `.json`；**只入库、不改当前配色** |
| 主题仓库 · 删除 | `delete_theme`；**要在 3 秒内再点一次**才算（按钮文案变「确认删除」） |
| 聊天背景虚化（`--nts-bubble-veil` 那一行） | 开关：关掉 = 写入 `0`（气泡白纱与背景模糊同时归零），打开 = `1`；清空 = 原生 |
| 背景图亮度（`--nts-chat-bg-image-brightness` 那一行） | 数值 0–1：`1` = 原图，`0.6` = 压暗四成，`0` = 全黑；清空 = 原图。只压暗、不增亮，正文不受影响 |
| 聊天背景图片（`--nts-chat-bg-image` 那一行） | 不是文本框：「选择图片」走 `import_background`，成功后由前端拼 `url("…")` 写回该行；「清除」等于该行回原生 `none` |

键盘：`/` 聚焦搜索、`Ctrl/⌘ + Enter` 应用、`Esc` 关弹窗、模式页签支持左右方向键。
行内「已改 / 已清空」标记与左侧色条只在脏行出现，因此「哪些还没提交」一眼可见。
清空按钮对**所有**类型都提供（早期版本颜色行没有清空按钮，只能手动清空十六进制框）。

> 仓库的「删除」故意**不用 `window.confirm`**：面板跑在 iframe 里，无头环境（CDP 驱动）
> 下原生对话框会**阻塞渲染进程**，`Runtime.evaluate` 永不返回，表现成一个看起来像死锁的超时
> （契约 §9.3c 记了同一个坑）。所以改成「3 秒内点第二次」的软确认。
> **「分享」为什么不是浏览器下载**：面板跑在宿主 sandbox iframe 里（sandbox 串无
> `allow-downloads`），`Blob` + `<a download>` 会被 Chromium 静默丢弃 —— 页面无报错，
> 用户只看到「没文件」。现在改为调 `export_to_file` 由插件进程写盘，成功后把完整路径
> 显示在提示条里；旧的 base64 下载仅作后端写盘失败时的兜底。

面板自身按 `prefers-color-scheme` 支持暗色（它跑在 48916 的独立 iframe 里，
跟随的是**系统**主题，而不是应用窗口里选择的亮/暗主题）。读取数据时顶部有一条
2px 进度条，分组标题在滚动时吸顶，提示文字默认单行、悬停展开。

右侧预览是**纯本地模拟**：用内联样式拼出假的用户气泡、AI 气泡、链接、
chip 和输入区，让用户在提交前就看到反馈。面板是跨源 iframe，无法给应用窗口
套样式，所以真实效果仍以应用窗口为准。

### 调用约定

面板通过宿主的 run 机制调用 entry，与 `wechat_integration` 的做法一致：

1. `GET /security/csrf-token` 取 CSRF token（失败则无 token 继续，宿主默认接受）；
2. `POST /runs` `{plugin_id, entry_id, args}` → 拿 `run_id`；
3. 每 500ms `GET /runs/{run_id}`，直到 `succeeded`（`failed`/`canceled`/`timeout` 抛错）；
4. `GET /runs/{run_id}/export` 取 `{items:[…]}`，挑 `type === 'json'` 且带 `json` 的那一条，
   读 **`item['json']['data']`**，再拆掉 `{success, data}` / `{error}` 包装。

URL 全部使用相对路径，因为面板本身就是从 48916 被服务的。

---

## 8. 文件清单

```
plugin/
├── plugin.toml          # 清单：id/entry/i18n/store/ui 面板（mode = "static"）
├── build_info.py        # PLUGIN_VERSION
├── __init__.py          # 后端：14 个 entry（6 旧 + 8 新）+ 校验 + 原子写 + startup 自愈
├── _app_patch.py        # 应用侧集成：模板补丁 + 两件套同步 + auto_start 自愈（纯 stdlib）
├── i18n/
│   ├── zh-CN.json
│   └── en.json
├── static/
│   ├── index.html       # 面板骨架
│   ├── style.css        # 面板私有样式（不使用 --nts-*）
│   ├── app.js           # CATALOG + 校验镜像 + 颜色工具 + 调用层（含自愈重试）+ 编辑器
│   ├── theme.json       # 调色板数据文件（应用侧加载器轮询它；六大键，无 version）
│   ├── themes/          # 主题仓库：一条一个 <id>.json（首次保存时才创建）
│   ├── backgrounds/     # 聊天背景图：<sha256前16位>.<ext>（首次上传时才创建）
│   └── loader/
│       ├── neko-theme-studio.js    # 随包的应用侧加载器（启动时同步进 resources\bin\static）
│       └── neko-theme-studio.css   # 随包的应用侧样式表（同上）
└── README.md
```

> `themes\` 与 `backgrounds\` 在干净安装里**不存在** —— `_ensure_dirs()` 在 startup 时创建，
> 也可能要等你第一次「保存」/「上传图片」才出现。这两个目录都是纯数据，删掉不影响插件启动。

插件启动时会用 `_app_patch.ensure_app_patch()` 把 `static\loader\` 里的两个文件同步进应用，
并给所有带 `dark-mode.css` 锚点的模板打上标记段（URL 带内容哈希）。因此**装上即生效**，
不需要用户再跑仓库里的 `install.ps1`。失败只写日志，绝不影响插件启动。

---

## 9. 已知限制

- `--nts-chat-opacity` 走的是**桥接**而非直接赋值：生成的 CSS 里是
  `:root[data-nts-l-chat-opacity] { --neko-chat-opacity-factor: var(--nts-chat-opacity) !important; }`，
  即复用 N.E.K.O 原生的透明度乘子机制。该乘子乘的是各聊天表面底色的 alpha
  （原生写法形如 `rgba(255,255,255,calc(.91 * var(--neko-chat-opacity-factor, 1)))`），
  因此它缩放的是**聊天面板/窗口整体的不透明度**，而不是任何单个颜色。取值 0–1。
  `--nts-shadow` 则直接写在 7 个卡片面上
  （`.message-bubble-user` / `.message-bubble-assistant` / `.composer-panel` /
  `.composer-icon-popover` / `.composer-overflow-popover` / `.modal-dialog` /
  `.proactive-recommendation-card`）。
  ⚠️ 该控件曾是**死控件**：应用侧加载器原先没有 `number` 值类型，
  面板与后端都接受、加载器却按颜色校验后静默丢弃。现已修复
  （加载器新增 kind `number`，正则 `/^(?:0|1|0?\.[0-9]+)$/`）。
- `--nts-topbar-text`、`--nts-input-text`、`--nts-button-text` 等若干变量的
  原生值是 `inherit`，面板里无法用色块表示，这类行请使用文本输入框。
- 应用侧加载器每 1500ms 轮询一次且只在窗口可见时进行，因此改完之后最多
  约 1.5 秒（或窗口重新获得焦点时）生效。
- 面板预览是模拟，不反映 `.message.gemini` 的 `border-bottom-left-radius: 4px`
  这类组件级细节。
- **每一条规则**都是门控的（`data-nts-l-<var>` / `data-nts-d-<var>`，见 §5.1）：
  只有当用户真的在对应模式里设了那个变量，加载器才会给 `<html>` 打上对应属性、
  规则才生效。这是「未配置 = 零变化」不变量的实现方式，不是缺陷。
- **静态量测页无法验证的两类目标**（它们的生效条件在静态页里根本不会出现，
  §10 的 A/B 台也覆盖不到，只能靠真实页手测）：
  - **悬停态**：`--nts-button-hover-bg` 只在鼠标悬停工具按钮时生效
    （`.composer-tool-btn:hover`），静态页没有指针，规则永不匹配；
  - **`::selection`**：`--nts-highlight` 只在用户划选文本时生效
    （`body ::selection { background-color: var(--nts-highlight) !important }`），
    静态页没有选区。
  - 二者同样是门控的，且清除后精确还原。
- 变量名现在受**白名单**限制：`plugin/__init__.py` 的 `KNOWN_VARS`（77 个名字）
  会拒绝未知变量名。此前一个拼错的名字（如 `--nts-nope-var`）会被后端照收、
  写进 `theme.json`、并回显为「已接受」，但样式表里没有任何东西消费它 ——
  一个看起来成功的静默空操作。因此：**往面板里加变量，必须同时加进 `KNOWN_VARS`**。
- 白名单实际有**三份**，漏掉任何一份都会静默丢弃：
  1. 后端入口 `plugin/__init__.py` 的 `KNOWN_VARS`（名字白名单）+ `LENGTH_VARS`
     （值类型判定，不在里面会被当颜色校验而拒收 `22px`）；
  2. 应用侧加载器 `plugin/static/loader/neko-theme-studio.js` 的 `NON_COLOR_VARS`
     （决定 `length` 还是 `color`，同样会静默 `log('reject value', …)`）；
  3. 面板 `plugin/static/app.js` 的 `CATALOG`（控件本身）。
  加变量时还必须在 `test/targets.js` 里写上消费方，否则样式表里没有规则去用它。
  **这三份之外还有两处值类型判定必须同步**：后端的 `IMAGE_VARS` / `LENGTH_VARS` / `BLUR_VARS` /
  `SHADOW_VARS` / `FONT_VARS` / `NUMBER_VARS` 六个集合决定 `_value_kind()` 的返回，
  而 `test/targets.js` 决定 CSS 有没有规则去消费它 —— 漏前者是「面板报成功、后端拒收」，
  漏后者是「后端收下了、样式表无人消费」，两种都是静默空操作。
  本轮的 `--nts-chat-bg-image` 就是新增了第七种值种类 `image`：
  后端 `IMAGE_VARS`（`_value_kind()` 第一个查它）+ 加载器 `NON_COLOR_VARS` 里的
  `'--nts-chat-bg-image': 'image'` + 面板 `CATALOG` 里 `type: 'image'` 三处同时加，
  再加 `test/targets.js` 的四个消费目标（见 §4.3）。
  **改完 `__init__.py` 必须重启插件进程**（`POST /plugins/refresh` 不够，实测
  `updated: []`；要 `POST /plugin/<id>/stop` 再 `start`），否则运行中的进程仍用
  内存里的旧 `KNOWN_VARS`，新变量会被静默丢弃而 `apply_theme` 照样返回 succeeded。
- v3 **门控的不是「少数目标」，而是全部目标**：生成的样式表里每一条规则都带
  `data-nts-l-<var>` / `data-nts-d-<var>` 门（见 §5.1），没有任何例外，
  因此也不存在「必须门控的特殊一小撮」这种分类。
- 之所以连一个回退值都不留，是因为「量到的原生值」在真实应用页上被证伪过。
  量测页（fixture）看不到四件事：
  - 真实 `/chat` 的 `<body>` 带 `.electron-chat-window` 类，使
    `body:not(.electron-chat-window) …` 这类规则在真实页**根本不生效**；
  - 真实祖先链带来的同特异性后置规则胜出（如 `.chat-body` 在
    `.chat-window.chat-surface-mode-compact` 下会被后一条
    `background: transparent` 覆盖，fixture 记到的是被压掉的那一条）；
  - 应用的真实视口宽度（fixture 会落进 `@media (max-width:768px)` 分支）；
  - 应用**运行时注入的 `<style>` 层**（带 `!important`，压过所有样式表）。
  这四条正是整个「量出来的回退值」方案被废弃的理由（§5.2）：回退值一旦写死，
  就会在用户**根本没配置**的情况下静默改写外观。v3 干脆一个都不写。
- `tools/gen-css.js` **不再读** `test/ab-baseline.json` 与 `build/ab.json`
  （其文件头把它们列为 informational，仅此而已）：生成器产出 0 个回退值，
  也就没有任何东西需要一个「否决集」去否决。
  `tools/build-theme-css.ps1` 的 [2/5] 步仍然跑一次真实页 A/B，
  但**纯属留证**（输出里写的是 `EVIDENCE ONLY -- v3 has no fallbacks to veto`）；
  真正的闸门是 [5/5] 步：部署后再量一次，若空调色板下真实页有任何变化就构建失败。

---

## 10. 校验清单（已实测）

| 项目 | 结果 |
| --- | --- |
| 后端 205 项断言（合并 / 拒绝 / 删除 / 容错 / 导出导入 / 原子性 / 并发 / 归一化 / 负值 / 严格读 / 导入上限） | 全部通过（`_local_verify/backend/audit_backend.py`）。**注**：其中「版本号」那一组随 `version` 一起去掉了，去版本号之后未重跑 |
| 40 个并发 `apply_theme` | 原判据是「40 个互不相同的 `version` 号」。`version` 已移除（§6.4），**该用例本轮未重跑**，新判据待定为「40 次写入后 `vars` 并集完整」 |
| 恶意值落盘检查 | `display:none`、`position:fixed`、`url(`、`--compact-*`、`--xy-*` 均未出现在 `theme.json` |
| 面板变量目录 vs 契约 §3 | **77** 个变量（契约另有 1 个 `--nts-x` 仅作注释示例），无缺失、无多余、无重复；`KNOWN_VARS` 与面板 `CATALOG` 的双向差集为**空** |
| 面板 `app.js` 引用的 DOM id vs `index.html` | 47 个引用全部存在（`_local_verify/ui_consistency.js`）。**注**：主题仓库那批 `#btn-lib-*` / `#lib-*` 是该次核对之后加的，未重跑 |
| 面板 UI 行为（搜索 / 只看改动 / 清空按钮 / 分组折叠 / 复制 dump / 弹窗焦点） | 41 项断言全部通过（`theme-studio/test/panel-ui.js`） |
| 面板提交链路（读取 → 编辑 → 应用 → 重读） | 18 项断言全部通过（`theme-studio/test/panel-smoke.js`） |
| 「面板有控件、CSS 无人消费」检查 | 0 项（曾为 2 项：`--nts-button-hover-bg`、`--nts-rec-border`，已修） |
| 前后端校验器差分（43 变量 × 86 个值 = 3698 例） | 判定完全一致，0 处分歧，0 例「前端放行、后端拒绝」 |
| 三方差分复核（面板 / 加载器 / 后端 × 2132 例，含负数、百分比与 shadow 结构边界） | 三方 **0 处分歧**，见 §3.4 |
| 面板交互缺陷探针（透明色、清空语义、预览圆角/模糊、阴影标红、被拒回填） | 11 项全部通过（`_local_verify/panel_bugs.js`） |
| `node --check static/app.js` | 通过 |

`test/accept.ps1` 的 56 项端到端闸门（全部通过，退出码 0）：

| 组 | 覆盖 |
| --- | --- |
| A | 插件已注册、`status=running`、有 static 面板、`theme.json` 可经静态路由取得 |
| C | **零变化不变量**：空调色板下，装载/不装载本样式表的计算样式逐行相同（亮、暗各 35 个量测点，差异均为 0）|
| D | 全调色板（7 类颜色）在亮/暗下都改变 ≥50% 量测点；用户气泡 = 请求色；暗色覆盖胜出；`blur(30px)` 真的生效；圆角生效 |
| E | `reset_theme` 后亮/暗都**精确**回到原生（差异 0）|
| F1 | **面板 UI 实操**：在真实面板里键入颜色 → 行变脏 → 「应用（1 项改动）」→ 报成功 → 值落到 `theme.json` → 「重置」→ 报成功 → 调色板清空、脏状态清零、色块回中性 |
| F2 | **门控变量在真实页上按模式双向可用**：对亮、暗**各测一遍**，三个门控变量（壳层圆角 / 输入区背景 / 输入区描边）在设置后移到请求值、清除后精确还原；并且**另一模式保持惰性**——另一模式的计算值仍是原生值，且另一模式那一组 `data-nts-*` 门属性从未被设置过 |
