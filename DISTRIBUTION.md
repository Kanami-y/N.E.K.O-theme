# 主题工坊 · 分发说明

- **打包产物**：`dist\neko-theme-studio-<版本>.zip`（版本号来自 `plugin\plugin.toml`）。
- **校验值**：同目录的 `neko-theme-studio-<版本>.sha256`；逐文件清单 `dist\MANIFEST.json`（sha256 + 大小）。
- 具体数值以 `dist\*.sha256` / `dist\MANIFEST.json` 为准——本文不硬编码哈希（包重打一次哈希就会变）。

当前源（由 `tools\verify-static.ps1` 只读校验，改了代码请以脚本输出为准）：
加载器以 `plugin\static\loader\neko-theme-studio.js` 的 `SCRIPT_VERSION` 为准（当前 1.5.12）、
样式表约 150 KB 级；`install.ps1` 会拒绝把旧 loader 覆盖到更新的部署上。

重新打包（确定性 zip：条目按路径排序、固定时间戳、`/` 分隔、白名单 + 必需文件检查）：

```powershell
powershell -NoProfile -File .\tools\package-dist.ps1
```

脚本从 `plugin\plugin.toml` 读版本号决定文件名，只收 `plugin/plugin.toml`、`plugin/__init__.py`、
`plugin/_app_patch.py`、`plugin/build_info.py`、`plugin/static/**`、`plugin/i18n/**`、`install.ps1`、
`uninstall.ps1`、根目录文档 md（README / CHANGELOG / DISTRIBUTION / TROUBLESHOOT / THEME_CONTRACT /
PARAMETER-REFERENCE）与 `.neko-plugin/**`（若存在），排除 `__pycache__`、`*.pyc`、`_work`、`test`、
`tools`、`research`、`app`、`app-patch`、`dist`、`backup`。缺必需文件会非零退出并列出缺哪些。

```powershell
# 1) 解压到 N.E.K.O 安装根（示例）
Expand-Archive .\dist\neko-theme-studio-<版本>.zip -DestinationPath 'D:\tools\enokoo' -Force
# 2) 安装
powershell -NoProfile -File 'D:\tools\enokoo\theme-studio\install.ps1'
```

`install.ps1` 在**不传 `-AppRoot`** 时会从脚本自身位置反推安装根
（`theme-studio\` 的上一级），所以换机器、换盘符都不用改脚本；传错路径会立刻报错
而不是乱改文件。

## 一、这个插件需要动应用侧文件，因此不是「单文件插件」

N.E.K.O 的插件 SDK **没有任何主题 / CSS 注入 API**（对 556MB 的 `projectneko_server.exe`
全量扫描 `global_css` / `theme_css` / `user_css` / `inject_css` / `css_variables` /
`apply_theme` / `inject_styles` 等关键词，命中数均为 0；`app.asar` 内 `insertCSS` 命中数 0）。
插件渲染的 HTML 卡片跑在沙箱 iframe 里，只从宿主继承 `color` 与 `font-family` 两项，
因此**插件自己的 CSS 永远改不到聊天框、气泡和面板本身**。

所以本交付是**两部分**：

| 部分 | 作用 | 谁提供 |
| --- | --- | --- |
| **应用侧补丁** | 往 23 个带 `dark-mode.css` 锚点的模板注入 `<link>` + `<script>`（带内容哈希），同步样式表与加载器到 `resources\bin\static\` | **插件 startup 自动完成**（`_app_patch.py`，23 个模板全做）；`install.ps1` 是手工入口，只手写 `chat.html` / `index.html` 两个，其余等插件 startup 补齐 |
| **插件本体** | 静态面板（调色 UI）＋ 6 个 entry（读写调色板 + 修复应用侧集成） | 打成 `.neko-plugin` 包，经 48916 安装 |

运行期数据流：面板写 `theme.json` → 应用侧加载器每 1.5s（以及窗口 focus / 可见性变化时）
HTTP 拉取 → 注入 `<style id="nts-dynamic">` 与门控属性 → 原生样式表被覆盖。

## 二、安装

```powershell
cd <N.E.K.O 安装根>\theme-studio
powershell -NoProfile -File .\install.ps1
```

默认**不传** `-AppRoot`：从脚本位置反推安装根（`theme-studio\` 的上一级），换机器 / 换盘符都不用改脚本；装到别处用 `-AppRoot '<路径>'` 覆盖。

安装脚本是**幂等**的，且**重装会保留全部用户数据**：`static\theme.json`（调色板）、`static\themes\`（自存主题）、
`static\backgrounds\`（背景图）、`static\exports\`（导出）会先备份再写回；`static\presets\` 是随包内置只读预设，用新包内容。
安装 + 验证全部成功后才清理旧备份，失败则完整还原。它按顺序做：

1. 备份 `templates\chat.html` / `templates\index.html` 原始内容到 `backup\`（按内容哈希命名，永不过期）
2. 复制两件套到 `resources\bin\static\`（loader 版本守卫：目标 `SCRIPT_VERSION` 比源新时跳过并警告，除非 `-ForceDowngrade`），
   再对模板做**两阶段**补丁：先全量只读预检（锚点恰好 1 处、`</html>` 与 Jinja 哨兵都在），任一失败直接中止且一个模板字节都不写；
   写前把每个模板快照到 `backup\txn-<时间戳>\`，写入用「临时文件 + 原子替换」，写后复核失败 → 全部模板从快照还原并报错退出
3. 备份用户数据到 `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\`；插件旧目录改名到
   `theme-studio\backup\plugin-rollback\`（**不在插件扫描目录内**，否则 `install-plan` 会判定 `multiple_installations` 并拒绝安装）→ 复制源码
4. `POST /plugin-cli/build` → `install-plan` → `install`（插件包版本比源新时跳过重建，除非 `-ForceDowngrade`）
5. 安装成功后**先**删「停止自愈」标记 `theme-studio-disabled`，**再** `/plugins/reload` ＋ `PUT /plugin/{id}/auto-start {"auto_start":true}` ＋ stop/start（顺序反了的话，插件 startup 会因为标记存在而整体跳过模板自愈）
6. 校验：23 个模板 BEGIN/END 各 1、Jinja 哨兵仍在、静态资源哈希一致、`/static/*` HTTP 200、`/chat` 与 `/` 含标记、插件已注册且 `status=running`；并打印「已恢复用户调色板 N 个变量」
7. 全部成功才删旧回滚点、模板事务快照和旧用户数据备份；任一步失败自动还原并把两份回滚点（失败现场 + 旧目录）都留下

若检测到旧版 `install.ps1` 遗留在插件目录旁的 `<id>.bak`（它会让 `install-plan` 报 `multiple_installations`），会先把它移到 `theme-studio\backup\plugin-rollback\legacy-<id>-<时间戳>\` 保留数据，再继续安装。

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Verify` | 只校验，绝不写任何文件 |
| `-SkipPluginInstall` | 只打模板补丁 + 复制两件套，不调用 48916（插件已从市场装好时用这个） |
| `-AppRoot <路径>` | 覆盖 N.E.K.O 安装根 |
| `-Strict` | 插件源缺失 / 48916 未运行时按失败处理（默认只警告） |
| `-ForceDowngrade` | 允许用旧包覆盖**更新的**已安装版本（loader `SCRIPT_VERSION` / 插件包 `version` 目标更高时默认跳过并警告） |

安装完成后**请完全退出 N.E.K.O（含托盘图标）后重新打开，主题才会生效**；只按 F5 刷新不够。

### 以管理员身份运行

脚本会检测当前是否管理员：非管理员时明确警告「写入 `resources\bin` 可能被系统拒绝（Access denied）」，不会静默继续。
安装 / 卸载建议在**管理员 PowerShell** 里执行：

```powershell
# 开始菜单 → 右键「Windows PowerShell」→「以管理员身份运行」
cd <N.E.K.O 安装根>\theme-studio
powershell -NoProfile -File .\install.ps1
```

脚本**未签名**：如果被执行策略拦截，请用上面的管理员 PowerShell 运行，或自行给脚本签名；
不要用 `-ExecutionPolicy Bypass` 绕过策略（企业环境常被策略 / 审计拦截）。

### 安装后的用户数据在哪、重装为什么不丢

| 位置 | 内容 | 重装 / 卸载 |
| --- | --- | --- |
| `%LOCALAPPDATA%\N.E.K.O\plugins\neko_theme_studio\static\theme.json` | 当前调色板 | 重装：先备份后写回；卸载：默认保留 |
| 同上 `static\themes\` `backgrounds\` `exports\` | 用户主题 / 背景图 / 导出 | 重装：先备份后写回 |
| 同上 `static\presets\` | 随包内置只读预设 | 重装：用新包内容（用户自定义请存到 `themes\`） |
| `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\` | 每次重装前自动备份 | 安装 + 验证成功后清理旧备份，保留最近一次 |
| `theme-studio\backup\`（含 `plugin-rollback\`、`txn-*\`） | 模板原始备份 / 插件回滚点 / 模板事务快照 | 成功才清理旧回滚点；失败全部保留 |

## 三、另一条安装路径：导入 `.neko-plugin` 包

### 3.0 先拿到「干净的官方包」

`install.ps1` 在升级过程中也会打一份 `.neko-plugin`（`%LOCALAPPDATA%\N.E.K.O\.neko-plugin-packages\neko_theme_studio.neko-plugin`），
但那一份是**为了升级保住用户数据**而打的：它把你当前的调色板、上传的背景图一起塞进了包。
自己用没问题，**分发给别人就不对了** —— 对方装完会看到你的主题。

要一份可分发的官方包：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\package-plugin.ps1
```

产物是 `dist\neko_theme_studio.neko-plugin`（约 1.4 MB）+ 同名 `.sha256`。脚本做的事：

| 步骤 | 说明 |
| --- | --- |
| 1 | 从 `plugin\` 复制源码到临时暂存目录，排除 `__pycache__` / `.git` / `tests` / `.vscode` / `.github` / `*.pyc` |
| 2 | 排除运行期用户数据：`static\backgrounds\`、`static\themes\`、`static\exports\`、`static\schedule.json` |
| 3 | `static\theme.json` 重置为出厂默认（空调色板，装完是各主题原本的样子） |
| 4 | 调宿主 `/plugin-cli/build` 打包（manifest / metadata / payload 哈希都由宿主自己算，格式必然合法） |
| 5 | 校验包内容（版本一致、无用户数据、无开发产物、必需文件齐全、35 套内置主题 + 3 张预设图） |
| 6 | 复制到 `dist\` 并写 `.sha256`；再调 `/plugin-cli/install-plan` 做只读校验（**不安装**） |

注意两点：

- 宿主的 `root_id=user` 只认 `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\<目录名>\` 这一个来源，
  而这个目录同时也是**已安装插件**所在目录。所以脚本用一个临时目录名 `_nts_pkg_staging` 暂存，
  打完立刻删掉 —— 否则 `install-plan` 会报 `multiple_installations`。
- 包里 `theme.json` 带构建时间戳，所以**同一个版本每次构建的 sha256 可能不同**；`.sha256` 是给当次产物用的。


`neko_theme_studio.neko-plugin` 是标准的 N.E.K.O 插件包（zip：`manifest.toml` +
`metadata.toml` + `payload\plugins\<id>\...` + `payload\profiles\default.toml` +
`payload\dependencies.toml`），可以走插件管理界面的「导入」入口安装，
对应端点 `POST /plugin-cli/upload-and-install`（multipart）。
也可以只用命令行：

```powershell
# 1) 导入（install-plan 先看一眼计划，确认 action=install）
$pkg = '<绝对路径>\neko_theme_studio.neko-plugin'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:48916/plugin-cli/install-plan `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ package = $pkg } | ConvertTo-Json)))

# 2) 安装
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:48916/plugin-cli/install `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes((@{ package = $pkg; install_source = 'imported'; on_conflict = 'fail' } | ConvertTo-Json)))
```

**这条路径装完之后，应用侧补丁由插件自己补。** 插件每次 startup 都会：

1. 从 `sys.executable` 的父进程链反推 N.E.K.O 安装根；
2. 把自带的 `static\loader\neko-theme-studio.{js,css}` 同步进 `resources\bin\static\`；
3. 扫 `resources\bin\templates\*.html`，对每个含 `dark-mode.css` 锚点的模板插入
   `<!-- NTS:BEGIN -->…<!-- NTS:END -->` 标记段，URL 里带 `?v={{ static_asset_version }}-<内容哈希8位>`；
4. 写回前后各校验一次（BEGIN/END 各 1、Jinja 变量仍在），原文件备份到
   `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup\`；
5. 全流程幂等：第二次启动只报「已最新 N 个模板」，不改任何字节。

所以 `install.ps1` **不再是必需步骤**，它现在的角色是「手工触发 + 全量闸门校验（校验项以脚本输出为准）」。
任何一步出错都只写插件日志，不会让插件启动失败；面板里可调用 `repair_app` entry 重跑。

> 为什么必须带内容哈希：48911 对 `/static/*?v=…` 回 `Cache-Control: public, max-age=31536000, immutable`，
> 而模板里的 `{{ static_asset_version }}` 是**进程启动时固定**的。不带哈希的话，
> 改了 loader 内容浏览器也永不重取 —— 这就是「热更新」必须靠 URL 变化的原因。

**关于「插件市场」**：本机 48916 上**没有任何发布/上传到市场的端点**——
`/market/catalog/*` 全是只读 GET，`/market/install` 是从市场装到本地。
要真正上架到 N.E.K.O 插件市场，需要把包交给市场服务端，这一步不在本机完成。
市场目录里目前没有任何主题/皮肤/配色类插件，本插件是第一个。

## 三之二、卸载

```powershell
powershell -NoProfile -File .\uninstall.ps1
```

按标记段删除补丁、删掉自己放进去的两个静态文件，并从 `backup\` 里最新的备份
**字节级还原**两个模板（校验 sha256，还原也是原子写）。`-KeepAssets` 只保留 `resources\bin\static\`
下那两个文件（`backup\` 里的备份任何时候都不会被删除）。

**-WhatIf 是完全只读的预演**：只打印将要做什么，不写标记、不删文件、不还原模板，
也不向插件服务发送 `auto_start` / `stop` 请求：

```powershell
powershell -NoProfile -File .\uninstall.ps1 -WhatIf
```

卸载**不会**删除用户数据（`theme.json`、`themes\`、`backgrounds\`、`exports\`）和 `backup\` 里的任何备份。

**默认不动插件本体**。插件本体在 `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\`，
**不在安装根下面**，而且全机共用 —— 换一个目录试跑也会命中真正在用的那份。所以默认只打印它还在，不动它。
要连插件本体一起从磁盘删掉，显式加 `-PurgeStaging`：

```powershell
powershell -NoProfile -File .\uninstall.ps1 -PurgeStaging
```

**卸载会写「停止自愈」标记**：`%LOCALAPPDATA%\N.E.K.O\theme-studio-disabled`（内容含时间戳）。
插件每次 startup 的 `_app_patch.py` 自愈会先检查它 —— 文件存在就整体跳过，不再往
`resources\bin\static\` 与 `resources\bin\templates\` 里重新注入主题。
重新运行 `install.ps1` 且安装成功后，脚本会自动删除该标记（恢复自愈）。

卸载还会**尽力**（失败只警告、不阻断）通过 48916 把插件的 `auto_start` 置为 `false`、
再请求 `stop` 停掉当前运行时。应用没在运行时这一步会跳过，标记文件照样生效。

**已知限制**：48916 没有 CLI 卸载端点（`/plugin-cli/uninstall` 是 404、`/plugins/uninstall` 是 405），
所以插件在 N.E.K.O. 插件管理界面里的**登记项**不会被清掉，需要在界面里移除
（或运行 `uninstall.ps1 -PurgeStaging` 删掉磁盘上的插件本体）。

卸载后同样需要**完全退出 N.E.K.O（含托盘图标）再重新打开**，界面才会恢复默认主题。

> ⚠️ 旧版本文档在这里写过「删掉两个静态文件后主题就不会再影响界面」——那是错的：
> 插件 startup 会自动重注入，卸载后重启应用主题就回来了。现在靠上面的「停止自愈」标记解决。

## 四、目录内容

| 路径 | 说明 |
| --- | --- |
| `install.ps1` / `uninstall.ps1` | 安装 / 卸载（UTF-8 BOM + LF，含中文说明；PowerShell 5.1 可直接跑） |
| `plugin\` | 插件源：`plugin.toml`、`__init__.py`、`_app_patch.py`、`build_info.py`、`pyproject.toml`、`i18n\`、`static\`（含 `loader\` 两件套、面板 front-end、`presets\`）、`README.md` |
| `app\css\neko-theme-studio.css` | 应用侧样式表（**生成物**，见 §六） |
| `app\neko-theme-studio.js` | 应用侧加载器（`app-patch\files\` 下有同源副本；以 `plugin\static\loader\` 为唯一源同步） |
| `plugin\static\loader\` | 加载器与样式表的**唯一资产源**，插件 startup 用它自愈 `resources\bin\static\` |
| `app-patch\` | 补丁片段与还原说明（**仅供人工参考，脚本不读它**） |
| `backup\` | 模板原始备份、插件回滚点（`plugin-rollback\`）、模板事务快照（`txn-*\`）。**机器相关，不要跨机拷贝** |
| `tools\` | 生成器（`gen-css.js` / `gen-version.js` / `sync-assets.js`）、构建驱动（`build-theme-css.ps1`）、只读校验（`verify-static.ps1`）、确定性打包（`package-dist.ps1`） |
| `test\` | 验收套件与真实页探针 |
| `build\` | 生成产物与量测数据（中间产物） |
| `.github\workflows\ci.yml` | CI：py_compile / pytest、`node --check`、版本与资产一致性检查 |
| `README.md` / `CHANGELOG.md` | 项目说明 / 版本变更 |
| `THEME_CONTRACT.md` | 全队唯一事实来源：变量清单、加载顺序、安全边界、补丁契约与自愈（§6/§6B/§6C） |
| `PARAMETER-REFERENCE.md` | 面板控件与变量对照表 |
| `TROUBLESHOOT.md` | 「改了颜色但窗口没变」的 verdict 排查表 + 新错误码 / 症状 |
| `PENDING-VERIFICATION.md` | ⚠ **归档文档**：逐轮验证日志与「故意不修」清单（新变更看 `CHANGELOG.md`） |
| `dist\neko-theme-studio-<版本>.zip` | 分发包（`tools\package-dist.ps1` 生成；同名 `.sha256` + `MANIFEST.json`） |

## 五、验证

```powershell
powershell -NoProfile -File .\test\accept.ps1
```

五组闸门：A 插件可达 / C 空调色板零变化 / D 全调色板生效 / E 往返还原 /
F 真实页面板 UI 与门控（具体项数以脚本输出为准）。需要 48911 与 48916 在运行。

浏览器：套件按 `NTS_BROWSER_PATH` → `CHROME_PATH` → Chrome++ 便携布局
（`C:\Program Files\Chrome\App\chrome.exe`）→ 标准 Chrome / Edge 的顺序找，并对每个候选
跑一次 `data:` URL 预检（**找到路径 ≠ 能无头运行**）。本机 Chrome++ 便携版无法无头运行
（进程直接退出、不产出 DOM），所以本机要显式指定一个能跑的浏览器：

```powershell
$env:NTS_BROWSER_PATH = '<chrome-headless-shell.exe 或 chrome.exe 的完整路径>'
powershell -NoProfile -File .\test\accept.ps1
```

套件开始时会快照 `theme.json`，结束时（含异常退出）用 `import_theme` **还原用户调色板**；
它内部会 `reset_theme`，不还原就会把用户颜色清空（2026-11-15 真机实测发现并修掉）。

面板单测 `test\panel-smoke.js` / `test\panel-ui.js` 需要 jsdom（交付包不带 node_modules）：
`npm install --no-save --prefix theme-studio jsdom`，再用 `NTS_JSDOM_PATH` 指向该
`node_modules\jsdom` 运行；找不到 jsdom 时脚本打印 SKIP 并以 exit 2 退出（环境缺失，不是失败）。

## 六、改颜色变量之后要重新生成样式表

`app\css\neko-theme-studio.css` 是**生成物**。变量与目标选择器的事实来源是
`test\targets.js`；改过它之后必须重新生成并部署：

```powershell
powershell -NoProfile -File .\tools\build-theme-css.ps1
```

该脚本五步：量测 → 真实页 A/B（留证）→ 生成 → 部署到三处 → 校验。
**不要在生成物里手改**，下次生成会被覆盖。

## 七、颜色怎么生效（零变化保证）

未配置任何颜色时，本插件的存在**必须**对应用外观零影响。做法是构造性的：
样式表里**每一条规则**都门控在一个按（模式，变量）分键的属性上——

- 亮色规则：`:root:not([data-theme="dark"])[data-nts-l-<var>]:root:root body <选择器>`
- 暗色规则：`:root[data-theme="dark"][data-nts-d-<var>]:root:root body <选择器>`

**没有任何回退值**（`fallbacks: 0`）。属性由加载器在应用非空调色板时按变量逐个打上。
因此：空调色板 → 无属性 → 选择器不匹配 → 零效果；只配亮色 → 暗色规则额外要求
`[data-theme="dark"]` 与 `data-nts-d-*` → 暗色完全不受影响，反之亦然
（亮色与暗色两组**各管各的**，互不影响）。

早期版本曾把「实测原生值」烘焙成 CSS 回退值，原理上就不可靠：合成量测页复现不了真实页的
`<body>` 类（`.electron-chat-window`）、紧凑态祖先（`.chat-surface-mode-compact`）、
运行时注入的带 `!important` 的 `<style>` 层，以及媒体查询分支。典型后果是
「白字白底」——亮色下聊天正文继承到 `rgb(255,255,255)`，与同样为白的气泡底对比度 1.00。
v3 用门控彻底消除了这一类缺陷。

## 八、安全边界

只改颜色 / 背景 / 边框 / 圆角 / 字体 / 阴影 / 模糊。**绝不**改
`display` / `position` / `width` / `height` / `flex` / `overflow` / `z-index` / `transform`；
不覆盖 `--compact-*` 与 `--xy-*`；加入新变量必须同时更新 `plugin\__init__.py` 的
`KNOWN_VARS`、`plugin\static\app.js` 的 CATALOG 与 `THEME_CONTRACT.md`。

变量值在**两处**独立校验：应用侧加载器（`isSafeValue`）与插件后端（`_validate_palette`）。
含 `;` `{` `}` `<` `>` `\` 或 `@import` / `url(` / `expression(` 的值一律拒绝，
被拒的值绝不落盘。后端另有 `KNOWN_VARS` 白名单，未知变量名会被显式拒绝而非静默接受。
