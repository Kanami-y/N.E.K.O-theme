# N.E.K.O 主题工坊（Neko Theme Studio）

给 N.E.K.O 客户端加一套**可调色、可存主题、可导出**的外观系统：面板里改颜色 → 应用侧加载器实时注入 CSS → 聊天框、气泡、输入框、侧栏等一起变。

因为 N.E.K.O 插件 SDK **没有主题 / CSS 注入 API**（卡片跑在沙箱 iframe 里，只继承 `color` / `font-family`），本交付是两部分：

| 部分 | 作用 | 怎么装 |
| --- | --- | --- |
| **应用侧补丁** | 往 23 个带 `dark-mode.css` 锚点的模板注入 `<link>` + `<script>`（URL 带内容哈希），并把 loader js/css 复制到 `resources\bin\static\` | 插件 startup 自动自愈；面板「安装自检 → 一键修复」可随时重做 |
| **插件本体** | 静态面板（调色 UI）+ 一组 entry（读写 / 保存调色板、主题增删改、导入导出、背景图、卸载/恢复应用侧集成） | 插件管理界面导入 `.neko-plugin`（市场装的就是这一层） |

> **市场安装的 `.neko-plugin` 里没有 `install.ps1` / `uninstall.ps1`** —— 那是仓库开发副本的脚本，
> 不随包分发。卸载与恢复都在面板「安装自检」里：**「卸载主题」写停止标记并剥离模板标记，
> 「重新接入」删标记后重装**；两者都幂等，且不动 `theme.json` / `themes/` / `backgrounds/`。
> 契约见 [`THEME_CONTRACT.md` §3C](THEME_CONTRACT.md)。

未配置任何颜色时**必须**对应用外观零影响（所有 CSS 规则都门控在按「模式 × 变量」分键的属性上，`fallbacks: 0`）。细节见 [`THEME_CONTRACT.md`](THEME_CONTRACT.md)。

## 目录结构

```
theme-studio/
├─ install.ps1 / uninstall.ps1   开发副本的安装 / 卸载（幂等；-Verify 只读；-WhatIf 预演；**不随 .neko-plugin 分发**）
├─ plugin/                        插件源（plugin.toml、__init__.py、_app_patch.py、i18n/、static/）
│  └─ static/
│     ├─ loader/                  唯一资产源：neko-theme-studio.{js,css}
│     ├─ app.js / style.css / index.html   面板前端
│     ├─ materials.js / materials.css      高级材质中心（v0.15.0，独立挂载）
│     ├─ theme.json               出厂空调色板（随包）
│     ├─ presets/                 随包内置只读预设
│     ├─ themes/ backgrounds/ exports/     用户数据（安装时保留）
├─ app/                           → resources\bin\static\ 的部署副本（生成物）
├─ app-patch/                     补丁片段与人工还原说明（脚本不读）
├─ tools/                         生成器 / 校验 / 打包脚本
├─ test/                          验收套件与真实页探针
├─ backup/                        模板原始备份与插件回滚点（机器相关，勿拷贝）
├─ dist/                          分发 zip、.sha256、MANIFEST.json
├─ .github/workflows/ci.yml       CI
├─ THEME_CONTRACT.md              全队事实来源（变量清单、加载顺序、安全边界、补丁契约）
├─ USER-GUIDE.md                  **使用者教程**（安装 / 调色板 / 材质中心 / 仓库 / FAQ）
├─ PARAMETER-REFERENCE.md         面板控件与变量对照
├─ DISTRIBUTION.md                分发 / 安装 / 卸载细节
├─ TROUBLESHOOT.md                「改了没反应」排查表
├─ CHANGELOG.md                   版本变更
├─ PENDING-VERIFICATION.md        ⚠ 归档文档（逐轮验证日志）
└─ README.md                      本文件
```

## 安装

```powershell
cd <N.E.K.O 安装根>\theme-studio
powershell -NoProfile -File .\install.ps1
```

- 不传 `-AppRoot` 时从脚本位置反推安装根（`theme-studio\` 的上一级），换盘 / 换机器不用改脚本。
- **重装不丢用户数据**：`static\theme.json`、`static\themes\`、`static\backgrounds\`、`static\exports\` 会先备份到
  `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\`，装完写回；安装 + 验证全部成功后才清理旧备份，失败则完整还原。
  `static\presets\` 是随包内置只读预设，用新包内容（用户自定义同名预设请放在 `themes\` 里）。
- **模板补丁是事务**：写前每个模板快照到 `backup\txn-<时间戳>\`，任一写失败 / 写后校验失败 → 全部模板还原并报错退出。
- **版本单调性守卫**：目标 loader 的 `SCRIPT_VERSION` 或已安装插件版本**高于**源包时跳过覆盖并警告，防止旧包降级；确需降级加 `-ForceDowngrade`。
- 其余参数：`-Verify`（只验证，绝不写文件）、`-SkipPluginInstall`（只打模板补丁 + 复制两件套）、`-AppRoot <路径>`、`-Strict`。
- **请完全退出 N.E.K.O（含托盘图标）后重新打开，主题才会生效**；只按 F5 刷新不够。

### 卸载

```powershell
powershell -NoProfile -File .\uninstall.ps1            # 回滚模板 + 删两个静态文件 + 写「停止自愈」标记
powershell -NoProfile -File .\uninstall.ps1 -WhatIf    # 预演：只打印，绝不改任何状态（也不调插件服务）
```

- 默认**不动插件本体**（它在 `%LOCALAPPDATA%\.N.E.K.O\.neko-plugin-installations\` 下，全机共用）；要删加 `-PurgeStaging`。
- 卸载会写 `%LOCALAPPDATA%\N.E.K.O\theme-studio-disabled`，插件下次启动不再自动注入；重装成功会自动删掉它。
- 卸载后同样需要**完全退出 N.E.K.O（含托盘图标）再重新打开**。

## 数据在哪、重装为什么不丢

| 位置 | 内容 |
| --- | --- |
| `%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\static\theme.json` | 当前调色板（用户颜色） |
| 同上 `static\themes\` / `presets\` / `backgrounds\` / `exports\` | 用户主题 / 内置预设（51 套 ×2） / 背景图 / 导出文件 |
| `theme-studio\backup\` | 模板原始备份、插件回滚点（`plugin-rollback\`）、模板事务快照（`txn-*\`） |
| `%LOCALAPPDATA%\N.E.K.O\theme-studio-backup\userdata-<时间戳>\` | 重装前的用户数据备份（成功后清理旧备份，保留本次） |
| `theme-studio\backup\user-theme.json` | 兼容旧版的调色板备份 |

卸载**不会**删除 `backup\` 里的任何备份，也不会删用户主题数据。

## 内置主题（51 套配色 + 51 套 (材质) 版 = 102 条 · 6 个风格族）

`plugin/static/presets/*.json` 随包发布 51 套只读配色主题；每套都另有一份 `<id>-material.json`，
配色完全相同、带该族完整材质（v0.15.68 起）。面板里两套并列显示，带材质的那套名字末尾是「 (材质)」。
后端 `_preset_family()` 按调色板自动归族（`list_themes` 回包带 `family` / `note` / `tags` / `preview` / `material`），
面板顶部按族切换：

| 族 | 数量 | 主题 |
| --- | --- | --- |
| 液态玻璃 `glassy` | 10 | 极地玻璃 / 液态玻璃·水晶 / 液态玻璃·深空 / 液态玻璃·午夜 / 液态玻璃·奶霜 / 液态玻璃·晨雾 / 液态玻璃·海盐 / 海雾 / 星辰喵 Starry Meow / YUI·冰月一梦 |
| 亮色 `light` | 13 | 奶油拿铁 / 霜晨 / 薰衣草暮 / 青柠汽水 / 抹茶拿铁 / 薄荷霜 / 蜜桃气泡 / 青瓷玻璃 / 玫瑰石英 / 鼠尾草 / 草莓牛奶 / 紫雾 / Yui 冰蓝喵 |
| 渐变 `gradient` | 15 | 琥珀黄昏 / 极光漂流 / 极光流影 / 竹影青岚 / 焦糖拿铁 / 霓虹夜行 / 深海蓝图 / 靛青星河 / 薄荷夜 / 霓虹幻紫 / 海潮 / 蜜桃汽水 / 樱雾渐变 / 落日熔金 / 蜜橘落日 |
| 暗色 `dark` | 7 | 深夜咖啡 / 霓虹紫 / 余烬夜 / 墨玉 / 午夜玻璃 / 黑曜金 / 松林 |
| 纸感 `texture` | 4 | 珊瑚礁 / 沙漠陶土 / 玉庭 / 樱纸手账 |
| 极简 `minimal` | 2 | 石墨 / 石板极简 |

> 带「 (材质)」的 51 条是独立主题：切过去颜色和玻璃一起换；不带后缀的只换颜色，
> 你当前手调的玻璃保持不变。材质锁定（面板「跟随主题」关掉）时，带材质的那套也只换颜色。

> 「渐变」族里 v0.14.0 的十套都用了 `--nts-text-gradient`：正文/标题本身也是渐变的，
> 色标经过逐色标对比度检查（每条渐变对 AI 气泡底与聊天背景都 ≥4.5:1），不会出现「某一行字糊在背景里」。

面板支持：缩略色板（跟随亮/暗实时取色）、族 tab + 数量徽标、关键词搜索、收藏（星标，存 localStorage
`nts.library.favorites`）、标签筛选、「换个心情」随机换肤、分类折叠记忆（`nts.catalog.collapsed`）。

### 用 AI 生成主题（0.4.6）

把 [`AI-THEME-GUIDE.md`](AI-THEME-GUIDE.md)（约 660 行，由代码里的单一事实源生成：95 个变量、
类型语法、风格族判定、对比度阈值、配方与完整示例）**整份**发给任意 AI，让它按 §0 的契约输出一个
JSON 文件；在仓库里可以先用 `python tools/validate_theme.py 主题.json` 自检（0 = 可导入），
再到面板「主题仓库 → 导入」。不需要写代码、不需要改 CSS。

超过 24 小时没更新过指南时，先跑 `node _work/dump_catalog.js && python _work/gen_ai_guide.py`
重新生成（`plugin/tests/test_ai_guide.py` 会守着「95 个变量全部有文档」和「示例真能导入」）。

### 主题仓库：自定义 / 收藏 / 导入（0.4.4）

主题仓库的分类栏现在是：**全部 → 收藏 → 自定义 → 六个风格族**。

| 分类 | 里面有什么 | 怎么用 |
| --- | --- | --- |
| 收藏 | 你点了 ☆ 的主题（内置 + 自定义都行） | 卡片右上角 ☆；收藏的永远排在「全部」最前面，`收藏` 分类 0 条时也常驻可见 |
| 自定义 | 你自己的配色 + 别人分享给你的主题 | 调好配色点「保存」存成一条；点「导入」选别人给的 `.zip` 或 `.json` 收进来 |
| 六个风格族 | 随插件发布的 51 套内置主题（每套另有 (材质) 版） | 只读，不能删；可以收藏、可以「另存为」成自定义再改 |

导入格式：
- `.zip` 分享包（面板「分享」导出的那个）：`theme.json` + `images/`，背景图一起带走；
- 单个 `.json`（`theme.json` 或手写 `{"name","vars","dark_vars","note","tags"}`）：只带颜色，
  文中引用的背景图若本机没有会自动回退原生，不会写入别人机器的路径；
- 导入后会立刻跳到「自定义」，条目带缩略色板、作者写的介绍（`note`）和标签（`tags`），
  坏文件会被拒绝并给出原因（缺 `vars`/`dark_vars`、不是 JSON、不是 UTF-8、过大等）。

想看全部效果：浏览器打开 [`_review/themes-gallery.html`](_review/themes-gallery.html)，
或看图片 `_review/themes-preview.png`。每套都通过 WCAG 对比度审计
（`python -m unittest plugin.tests.test_preset_contrast`，正文 4.5:1 / 次要 3:1）。

### 真液态玻璃（0.2.0 / 0.3.0 材质层 + 0.4.0 光效层）

玻璃族不是「一块半透明色」：`--nts-glass-filter` 负责 `backdrop-filter` 的透视模糊，
`--nts-glass-rim` 画一圈高光边缘，`--nts-glass-sheen` 让高光缓慢流动，`--nts-glass-noise` 叠一层
极细噪点防止大面积渐变出现色带。这三个变量由 loader 的 `GLASS_CSS` 层注入，只影响玻璃族主题：

| 变量 | 类型 | 说明 | 玻璃族取值 |
| --- | --- | --- | --- |
| `--nts-glass-rim` | color | 玻璃边缘高光（内阴影/描边） | `rgba(255,255,255,0.45–0.60)` |
| `--nts-glass-lens` | number 0–1 | 边缘透镜亮环（折射感近似） | 0.55–0.85 |
| `--nts-glass-thickness` | number 0–1 | 玻璃厚度（上亮下暗 + 外投影） | 0.60–0.90 |
| `--nts-glass-specular` | number 0–1 | 镜面高光，跟随鼠标指针 | 0.55–0.85 |
| `--nts-glass-sheen` | number 0–1 | 流动高光强度，0 = 关闭 | 0.36–0.68 |
| `--nts-glass-noise` | number 0–1 | 噪点强度，0 = 关闭 | 0.10–0.22 |
| `--nts-ambient-glow` | number 0–1 | 指针光源：一片柔光跟随鼠标（0.4.0） | 0.45–0.65 |
| `--nts-glass-dispersion` | number 0–1 | 边缘分光：左上暖 / 右下冷两条折射亮线（0.4.0） | 0.30–0.55 |
| `--nts-glass-caustic` | number 0–1 | 流动焦散：玻璃后光斑 13s 胀缩（0.4.0） | 0.30–0.60 |

透视程度由 `--nts-glass-filter`（`blur(24–30px) saturate(170–200%) brightness(103–110%)`）与
`--nts-glass-tint`（`rgba(...,0.12–0.26)`）共同决定：tint 的 alpha 越低越透，越接近「真玻璃」。

**0.4.0 光效层**（玻璃之外也能用）：`--nts-ambient-glow` 让玻璃表面跟着鼠标出现一片柔光，
`--nts-glass-dispersion` 在边缘画一圈分光（暖色左上 / 冷色右下），`--nts-glass-caustic`
让玻璃后面的光斑缓慢胀缩 —— 三者互相独立，未配置即零效果。面板「液态玻璃质感」分组共 9 项，
可逐项拖动实时预览。

### 高级材质中心（0.15.0 起，0.15.1 重做视觉层）

颜色之外，面板顶部多了一整块「高级材质」：**10 个导航界面、90 个参数、7 套预设、4 档画质、10 类组件**。
它编辑的是 `theme.json` 的 `materials` 子树（与 `vars` 同级、整份替换），编译后由加载器注入
121 个 `--nts-mt-*` 变量（90 个参数变量 + 31 个光学/复合变量），所以关掉插件或停用材质时
**整层零规则**，不会碰到原生样式。

想直接看「苹果液态玻璃」，选预设 **Liquid Glass (Apple)**：大圆角、顶部镜面、内高光、环境反射、
透镜压缩边与双向色散都在这套参数里，画质建议「极致」。

| 界面 | 内容 |
| --- | --- |
| 总览 / 基础材质 / 玻璃染色 | 透明度、底色、染色主辅色与浓度、模糊、饱和度、亮度、层级 |
| 光线反射 | 边缘光、内部高光、环境反射、动态光照 |
| 折射色散 / 液态动态 | 折射强度与范围、色散位移、液态振幅与速度 |
| 表面细节 | 噪点、圆角、边框、阴影 |
| 动画交互 | 进入/退出/悬停/点击/展开时长、悬停、点击、展开、鼠标追光 |
| 组件材质 | chat / bubble / input / sidebar / topbar / settings / dialog / button / plugin / menu 十类独立材质 |
| 预设与画质 | Clear / Frosted / **Liquid Glass (Apple)** / Smoke / Soft / Prism / Custom + 省电/均衡/高品质/极致 |

右侧是一块独立的实时预览：改任何值都会在 140ms 后由**后端** `preview_materials` 编译成变量表再贴上去，
预览与真实窗口用同一套变量、同一套门控，不会出现「预览好看、应用后不一样」。
完整契约（字段、计数、门控、分享链路）见 [`THEME_CONTRACT.md`](THEME_CONTRACT.md) 的 §3B。

排查「改了没反应」先看运行期诊断：加载器每分钟把实际状态（注入变量数、门控属性、规则数、
backdrop-filter 能力）回传给 `loader_report`，落盘在插件目录的 `static/diagnostics.json`。
`mt_vars` 为 0 就说明材质没进窗口，不是参数写错了。

## 常见问题

- **改了颜色但窗口没变** → 先完全退出 N.E.K.O（含托盘图标）再开；仍是旧样子按 [`TROUBLESHOOT.md`](TROUBLESHOOT.md) 的 verdict 表排查。
- **提示「版本降级被拦」** → 目标比源新，脚本默认不覆盖。确认要用旧包时加 `-ForceDowngrade`。
- **提示「当前不是管理员」** → 写 `resources\bin` 可能 `Access denied`。请用**管理员 PowerShell** 重跑；脚本不会静默继续。
- **被 CSP 拦截（面板里报 `Refused to ... Content Security Policy`）** → 宿主 `index.html` 的 CSP 未放行面板资源，见 TROUBLESHOOT.md「CSP 拦截」一节。
- **模板标记数不对 / 缺 `</html>`** → 别手改模板；`uninstall.ps1 -Force` 用最新备份整文件还原后再重装。
- **执行策略拦截脚本** → 本仓库脚本**未签名**：请用 `powershell -NoProfile -File install.ps1`；若被执行策略拦住，改用管理员 PowerShell 运行，或自行给脚本签名。**不要**用 `-ExecutionPolicy Bypass` 绕过策略（企业环境常被审计）。

## 开发命令

```powershell
# 版本派生（唯一版本源 = plugin/plugin.toml；同时改 build_info.py / pyproject.toml / index.html 的 ?v= 与文案）
node tools/gen-version.js            # 写入
node tools/gen-version.js --check    # CI：不一致 exit 1

# 资产同步（唯一源 = plugin/static/loader/；同步到 app/ 与 app-patch/）
node tools/sync-assets.js
node tools/sync-assets.js --check

# 部署校验（只读；默认 -AppRoot D:\be）
powershell -NoProfile -File tools\verify-static.ps1 -AppRoot 'D:\be'

# 确定性打包（条目排序、固定时间戳、白名单；生成 dist/neko-theme-studio-<ver>.zip + .sha256 + MANIFEST.json）
powershell -NoProfile -File tools\package-dist.ps1

# 官方插件包（单文件 .neko-plugin，可交给「插件管理 → 从文件安装」）：
# 用宿主自己的 /plugin-cli/build 打包，但会先排除开发产物与用户数据、把 theme.json 重置成出厂默认，
# 产物 dist\neko_theme_studio.neko-plugin + .sha256，并用 install-plan 做只读校验（不安装）。
powershell -NoProfile -File tools\package-plugin.ps1
powershell -NoProfile -File tools\package-plugin.ps1 -SkipVerify   # 宿主要求的路径校验跳过（不推荐）

# 版本归档（每次发布后跑一次）：把 plugin/ 源码 + 发布包另存到仓库外的按版本目录，
# 安装/更新都不会动它；默认 D:\be\_nts-plugin-versions\v<版本>\，可用 --dest 或
# 环境变量 NTS_VERSION_ARCHIVE 换位置。历史版本可用 --backfill <zip> / --backfill-all 补档。
python tools\archive-version.py
python tools\archive-version.py --check

# 重新生成样式表（改 test/targets.js 后必须跑）
powershell -NoProfile -File tools\build-theme-css.ps1

# 前端自测（假 DOM / 纯函数，不需要浏览器和宿主；CI 会跑这八个）
node test\panel-selftest.js        # 主题库：族/标签/搜索、收藏、自定义、CATALOG、卡片 DOM
node test\glass-selftest.js        # 玻璃层注入：门控、四层材质、过渡、光效休眠
node test\pointer-selftest.js      # 指针追踪：平滑、滚动重算、重建、非玻璃主题休眠
node test\audit-selftest.js        # 可读性自检纯函数 + 自动修正
node test\sync-selftest.js         # 外部改动感知：签名、让路决策、轮询接线
node test\editor-selftest.js       # 编辑区逐键刷新合并：策略、同帧去重、onchange 仍立刻
node test\loader-warm-selftest.js  # 加载器背景图预热：白名单、只回调一次、门控在写样式之前
node test\dump-selftest.js         # 调色板 JSON 折叠惰性化：跳过/补渲染/复制前强制重建

# Python 单测（不依赖宿主 SDK）
python -m unittest discover -s plugin/tests
```

自测的覆盖范围与约定见 [`test/README.md`](test/README.md)。

## 不要手改的生成物

- `app\css\neko-theme-studio.css`、`app\neko-theme-studio.js`、`app-patch\files\**` — 由 `tools/sync-assets.js` / `tools/build-theme-css.ps1` 生成，手改会被覆盖。
- `plugin\static\loader\neko-theme-studio.css` — 由 `tools/gen-css.js` 生成（js 是手写源）。
- `plugin\static\index.html` 里的 `?v=<版本>-<哈希8>` 与「插件 vX.Y.Z」— 由 `tools/gen-version.js` 派生。
- `dist\*.zip`、`dist\MANIFEST.json` — 由 `tools/package-dist.ps1` 生成。
- `build\**`、`backup\**` — 运行产物 / 本机状态。

## 安全边界

只改颜色 / 背景 / 边框 / 圆角 / 字体 / 阴影 / 模糊。绝不改 `display` / `position` / `width` / `height` / `flex` / `overflow` / `z-index` / `transform`。变量值在加载器（`isSafeValue`）与插件后端（`_validate_palette`）两处独立校验，`KNOWN_VARS` 白名单之外的变量名直接拒绝。详见 `THEME_CONTRACT.md` §八。

## 许可

随 N.E.K.O 主题工坊项目分发；第三方字体 / 图标各自遵循其许可。
