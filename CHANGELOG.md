## 1.0.5 — 定时切换失败告警去抖

### 修了什么

- **定时换主题反复失败时，每 30 秒重刷一条一模一样的 warning**（真缺陷）：排程线程
  每轮重试是设计（条目修好后要能自动恢复），但「主题条目本身坏了（如旧版本存的空配色）」
  这条失败路径只记日志、不推进任何标记 —— 一天 2880 条相同告警，真出问题时反而把有用日志淹掉。
  现与「主题被删」分支同口径：按 `{day}|{zone}|{theme_id}|error:{message[:120]}` 指纹（last_missing）
  去抖，同一失败只记第一次；刻意不推进 last_zone/last_theme，条目改好后下一轮 tick 自动恢复。
- 新增回归测试 `test_schedule_heal.ApplyErrorDebounceTests`：保存排程即 tick 一次（1 条 warning），
  连续 force tick 3 次仍只 1 条；条目改好后 force tick 恢复 applied，非 force tick 走 unchanged。

### 数字

- 后端测试 730 OK（skipped=1）；状态机随机游走（含材质与排程操作）种子 20261121 × 200 步全 PASS；
- 自检 80 项（本轮门禁未增减）。


## 1.0.4 — 空主题条目守卫 + 状态机随机游走门禁

### 修了什么

- **空主题能存进仓库，应用后整套配色消失**（真缺陷，端到端可复现）：
  `default_palette()` 与 `reset_theme()` 返回的 `vars` 都是 `{}`，而 `save_theme`
  只读盘不校验 —— 于是「恢复默认 → 保存到主题库」会落一条零变量条目；之后点
  「应用」，`_apply_theme_record` 用这份空 `clean_vars` 整片覆盖 theme.json，
  面板显示「已应用」，用户看到的是整套配色凭空消失。两端各加一道守卫：
  `save_theme` 在 vars 与 dark_vars 都没有可用变量时返回 Err（面板直接提示
  「先调几个颜色再保存」，不再静默存空条目）；`_apply_theme_record` 拒绝应用
  零变量条目（多为旧版本遗留），并在写盘前中止 —— 当前配色与主题名原样保留。
  只想保存材质参数的用户走「材质预设」（`save_material_preset`），功能不缺口。
- 顺带修正两条旧用例（`test_save_theme_completes`、`test_save_theme_cleans_note_and_tags`）：
  它们测的是写锁与文本清洗，却依赖「空调色板也能保存」，现在先落一个真实变量。

### 新增测试（5 条）

- `plugin/tests/test_empty_theme_guard.py`：首次运行存空条目被拒、重置后保存被拒、
  全非法值（`--nts-accent: 42`）被拒、旧版遗留空条目应用被拒且盘上配色/名字不变、
  正常保存与应用回归。

### 自检侧（79 → 80 项）

- `state-fuzz`：`_work/audit_state_fuzz.py --steps 200 --seed 20261121`。随机 200 步
  打 13 类真实入口（apply / apply_bad / save / apply_saved / apply_builtin / delete /
  meta / import / export / reset / bg / schedule / modify_disk），每步校验 4 条不变量：
  theme.json 变量名在册且值过安全检查、name / enabled / materials 结构合法、
  背景图引用落地、仓库条目 id 与文件名一致且至少有一个可用变量、定时任务引用可解析。
  手改磁盘那一步额外断言「下一次写入必须自愈非法值」。上面的空条目缺陷就是它抓到的。

### 数字

| 项 | 值 |
| --- | --- |
| 后端测试 | 724 → **729 tests OK**（skipped=1） |
| 自检 | 79 → **80 项**（78 PASS + 2 条数据采样 WARN） |
| 状态机 | 4 个种子 × 200 步，0 违规、0 未捕获异常 |
| 内置主题 | 102 套未受影响（编号 / ID / 变量均未改） |

## 1.0.3 — 自定义预设保存失败 + 文本卫生 + 两条新门禁

### 修了什么

- **保存自定义材质预设只要有警告就整体失败**（真缺陷，100% 可复现）。`save_material_preset`
  里有一处裸调用 `_log(...)`，而模块里只有 `self._log` —— 于是 `normalize_materials`
  一返回警告（用户手改过某个参数、导入的材质块有坏值），保存就抛 `NameError`，
  面板显示「保存自定义预设失败：name `_log` is not defined」。警告是提示不是错误，
  不该阻断保存。改为 `self._log(...)` 后，坏值被规范化成默认值、预设照常存下。
- **主题名 / 简介 / 标签接收控制字符**。JSON 允许 `\u0000`，所以 NUL、BEL、
  RTL 覆写符（`\u202e`）、零宽空格能一路写进 theme.json、主题库与分享包 ——
  面板断行、日志串行、接收方看到乱码；RTL 覆写符更糟，显示顺序反转，用户看到的
  名字和实际字符串不一致。新增 `_strip_controls`（按 Unicode 类别丢 C* 字符），
  在 `_clip_name` / `_theme_note` / `_theme_tags` / `apply_theme` 的 name / 
  `import_theme` 的 name 五处入口统一清洗；全是控制字符的名字回退默认名。

### 新增测试（7 条）

- `plugin/tests/test_material_preset_warning.py`（2 条）：带警告必须保存成功、参数
  必须已规范化、预设必须真的落盘。
- `plugin/tests/test_text_hygiene.py`（5 条）：apply_theme / import_theme 的名字、
  仓库条目的简介与标签、全控制字符名字回退。

### 自检侧（77 → 79 项）

- `entry-extreme-input`：22 个入口 × 13 类极端输入（20 万字符字符串、1200 层嵌套、
  5 万项数组、1e308、NaN/Infinity、NUL 控制字符、RTL+emoji、Windows 保留名、
  路径穿越、400 字名字）= 546 次调用，判据是「不许抛异常、单次不许超过 20 秒」。
- `json-strict`：对 12 次写盘尝试后 static 目录下所有 JSON 做严格复读 ——
  `parse_constant` 抛错（NaN / Infinity 会让加载器 JS `JSON.parse` 直接失败），
  并检查每个文件能否按 UTF-8 编码（孤立代理项会在这里炸）。

### 数字

| 项 | 值 |
| --- | --- |
| 后端测试 | 717 → **724 tests OK**（skipped=1） |
| 自检 | 77 → **79 项** |
| 极端输入 | 546 次调用，0 异常、0 卡死 |
| 严格 JSON | 12 次写盘 × 3 个 JSON 文件，0 处非法常量 |

### 已知未动

- 内置主题对比度基线 40 项（`_work/contrast_baseline.json`），属设计取舍，只在新增回归时拦。
- 两条数据采样 WARN（`diag-component-sample` / `diag-settings-page`）：需要真人开设置页、
  套一次材质组件才会转 PASS，不能伪造。

## 1.0.2 — 入口参数类型守卫 + 两条防腐门控

无人值守自检第 2 轮：把「入口收到非法类型」和「磁盘状态被改坏」这两类真实事故做成永久门禁。

### 修了什么（运行时）
- export_to_file 的 kind / target / name 以前直接调用 .strip()：面板只送字符串所以没事，但入口是公开契约，脚本或未来面板送个数字/对象就是 AttributeError → 500。现在先做类型守卫，返回 Err(「导出参数 kind 必须是字符串，收到 int。」)，和 loader_report 的容错口径一致。

### 新增测试（10 条）
- plugin/tests/test_reset_theme.py（3）：恢复默认必须真落盘、必须清掉自定义配色与材质镜像、连点两次只差时间戳。顺带钉住一个刻意的形状差异——入口返回值始终带空的 material_vars/material_attrs，磁盘镜像则整个丢弃。
- plugin/tests/test_detach_entry.py（3）：detach_theme / restore_theme_patch 入口写 disabled.json 镜像的时机；卸载失败时必须保持旧镜像，不能假装已经卸载干净。
- plugin/tests/test_entry_input_types.py（4）：非字符串参数一律 Err，正常字符串不被误伤。

### 自检侧（不进运行时）
- _work/selfcheck.js 76 → 77 项：新增 entry-input-fuzz（22 个入口 × 274 次 garbage-in，只许 Err、不许抛异常）与 state-corruption（7 种损坏的 theme.json × 8 个入口，半截 JSON / 标量 / 数组 / 错误类型 / 未知 schema / null 材质）。

### 数字
| 项 | 值 |
| --- | --- |
| 后端测试 | 717 tests OK（skipped=1，本轮新增 10 条） |
| 自检 | 77 项：75 PASS + 2 条既有数据采样 WARN |
| 入口 fuzz | 274 次非法输入，0 次未抓获异常 |

### 已知未动
- 两条 WARN 都是数据采样前置条件未满足（用户没打开过设置页 / 没套过材质组件），不是功能缺陷；等真实操作后自然转 PASS。

## 1.0.1 — 诊断上报容错 + 自检三条新门控

User said (m08539/m08540)：「好开始无限制自检与修复功能修复」→ 这一轮把「自检本身」也当成产品来修：4 个脚本过期造成的假红灯修掉，3 条新门禁并进 selfcheck，另外堵住诊断上报的类型崩溃与无上限写入。

### 修了什么（运行时）
- `loader_report` 的 7 个数字字段改用 `_safe_int`：字符串数字接受，负数 / 对象 / 数组退回 0。以前版本错配的加载器送来 `"abc"` 或 `{"a":1}`，入口会直接抛异常、宿主看到 500 —— 最需要诊断的时刻反而丢记录。
- `attrs` / `errors` / `centerChain` / `shellChain` 全部封顶（40 条×200 字 / 20 条×400 字 / 10 条×260 字 / 10 条×240 字）。诊断文件每轮整体覆写，字段不封顶时一个渲染 bug 就能把插件目录写成几十 MB。
- 新增 `plugin/tests/test_loader_report.py`（5 条）：正常落盘、怪类型不抛、截断上限、history 只留 20 条、非对象上报不落盘。

### 自检侧（不进运行时）
- `_work/selfcheck.js` 71 → 74 项，新增：`theme-css-matrix`（102 预设 × 4 画质 = 204 次编译、51,408 个变量值）、`panel-id-bindings`（面板 106 个 id / 100 个引用，零 DEAD 零 MISSING，`btn-glow-*` 这类拼接绑定算已引用）、`contrast-ratchet`（对比度基线棘轮：40 项历史已知，只拦新增回归）。
- 4 个过期脚本修复：`audit_component_selectors.py`（写死旧相对路径 → ROOT 解析 + 动态定位片段）、`audit_presets_valid.py`（`object.__new__` 缺 `static_dir` / `plugin_id`）、`audit_panel_assets.py`（目录式 URL 返回 404 属正常）、`audit_mt_transform_risk.py`（风险清单改退出码 0，硬门禁在 `audit_mt_backdrop_hazards.py`）。
- `audit_themes.py` 标注已被 `audit_presets3.py` 取代（11 类 × 实色/合成双语义 + 基线棘轮）。

### 数字
| 项 | 值 |
| --- | --- |
| 后端测试 | 707 tests OK（skipped=1，新增 5 条） |
| 自检 | 74 项：72 PASS + 2 条既有数据采样 WARN |
| 诊断上报 | 怪类型不抛、四条上限、history 恒 ≤20 |

### 已知未动
- 40 项内置主题对比度低于阈值（如 tangerine-sunset 正文 2.80、sunset-molten 用户名 2.56）属设计取舍，本轮按基线棘轮只防新增，不改用户已经看惯的 102 套配色。

## 1.0.0 — 主题工坊正式稳定版

User said (m08501)：「自检一次，没问题升级大版本」→ 自检 69/71 全 PASS（两条既有采样 WARN），版本从 0.15.72 收口到 **1.0.0**。

### 1.0 的基线（不是感觉，是数字）

| 项 | 基线 |
| --- | --- |
| 后端测试 | `python -m unittest discover -s tests` → **702 tests OK**（skipped=1） |
| 面板自检 | `_work/selfcheck.js` → **71 项全 PASS**，仅两条数据采样 WARN（用户没开过设置页时必然出现） |
| 内置主题 | 102 套 = 51 配色版 + 51 材质版，配色版显式声明 `materials.enabled=false` |
| 材质系统 | 90 个参数 / 10 类组件 / 126 个编译变量 / 4 档画质（saver 有实质降级） |
| 数据契约 | 分享包安全 11 条测试、仓库合并语义、导出剥离派生镜像、预设命名显式拒绝而非静默截断 |
| 宿主契约 | 卸载 §3C（删 23 模板标记 + 两件套 + disabled 闸门）、安装自愈 `ensure_app_patch()` 幂等 |

### 1.0.0 含入的两处修复（0.15.72 一同验证）

| 缺陷 | 修法 |
| --- | --- |
| 面板 HTML 被 `max-age=3600` 缓存，升级后最长 1 小时跑旧 DOM | `<meta name="nts-panel-version">` + 首帧 `no-store` 自比对，版本不一致带 `?nts=` 重定向一次（防循环） |
| 宠物悬浮形态下宿主短暂收走键盘焦点，表现「所有输入框点不进去、无光标」 | `initFocusRecovery()` 捕获 `mousedown` 时主动要焦点并按 0/60/220ms 重试；仍失败则在状态栏给出可执行提示。面板本身无抢焦点代码（已逐项取证） |

### 1.0 之后的口径

- 版本号仍走 `plugin.toml` → `tools/gen-version.js` → `build_info.py` / `pyproject.toml` / 面板 `?v=` 哈希 单源生成，不再手写多处。
- 自检必须保持 71 项全 PASS；新增能力要同时补 selftest 与文档同源契约（§3D），否则不许发版。
## 0.15.72 — 面板升级后不再跑一小时旧页面；键盘焦点拿不到时给提示

User said (m08249)：「不能在文本框里面输入」。现场补问确认为：不是某一个框，是**面板里所有输入框都点不进去、没有光标**；同时面板内按钮可点、文字可拖选、按钮悬停会变色，主界面聊天输入框打字正常。

### 定位（面板代码洗清）

| 检查 | 结论 |
| --- | --- |
| 输入框结构 / 0.15.70 包内 HTML 对比 | 只差版本号与 `?v=` 哈希，`#lib-note` 等结构完好 |
| 抢焦点代码 | 全仓无 `mousedown` / `pointerdown` 监听，无 `.blur(`，键盘处理都带 typing 守卫 |
| 命中测试 | 悬停变色、拖选、面板内按钮全部正常 → 鼠标事件完整进入文档 |
| 键盘 | 按 Tab 焦点框不移动、打字不落到任何地方 → **键盘事件根本没进面板文档** |
| 宿主 | 主界面聊天框可正常输入 → 窗口本身可聚焦 |

结论：面板没有拦焦点，是宿主把键盘焦点留在了别的文档/窗口上（宠物悬浮形态下出现过一次，随后自行恢复）。这类问题插件侧拿不到根治权限。

### 同时修掉的真缺陷：面板 HTML 被缓存 1 小时

| 缺口 | 表现 |
| --- | --- |
| 静态路由给 `ui/*` 发 `Cache-Control: max-age=3600` | `?v=` 只解决 js/css，`index.html` 自身没有版本号，升级后最长 1 小时仍跑旧 DOM |
| 旧 DOM + 新 js/css | 缺新控件、版本标签还是旧的，极易被误判成「新功能没生效」 |

### 修法

| 层 | 改动 |
| --- | --- |
| `plugin/static/index.html` | 新增 `<meta name="nts-panel-version">` 与首帧自愈脚本：`fetch('./index.html?cb=<ts>', {cache:'no-store'})` 比对版本标记，不一致就 `location.replace('./index.html?nts=<ver>')` 重定向一次（URL 变了即绕过缓存，带 `?nts=` 时不再重试，避免循环） |
| `plugin/static/app.js` | 新增 `initFocusRecovery()`：捕获阶段监听 `mousedown`，点中输入框而 `document.hasFocus()` 为假时，向 `window.top` / 自身要一次焦点并按 0/60/220ms 重试；400ms 后仍未拿到则在状态栏提示「先点一下主窗口再回来」 |
| 版本头 | `plugin.toml` / `build_info.py` / 面板版本标签 / `?v=` 哈希四处同步到 0.15.72 |

### 验收

| 项 | 证据 |
| --- | --- |
| 语法 | `node --check app.js` 通过 |
| 缓存自愈 | 新 HTML 内 `?v=` 与 `meta` 版本一致；重定向只在版本不一致且未带 `?nts=` 时发生 |
| 焦点自愈 | 正常环境 `document.hasFocus()` 为真时该路径完全短路，不改动默认输入行为 |
## 0.15.71 — 自己做的主题也能写简介，分享时一起带走

User said (m08087)：「对于自己做的主题包应该做一个简介功能可以介绍一下，就像内置主题那样的描述，便于分享」。

### 缺陷

| 缺口 | 表现 |
| --- | --- |
| 保存接口只有 `name` | `save_theme` 的 `input_schema` 只有名字，简介得先保存、再点卡片「编辑」补 —— 三步才摸到入口 |
| 面板保存框没有简介 | `#lib-name` 旁边只有「保存」按钮，新用户不知道简介存在 |
| 摘要不含 note/tags | `_theme_summary` 只返回 id/name/saved_at/light/dark/has_image，保存成功的返回值里没有刚写的简介 |
| 空简介无提示 | 自定义条目没写简介时卡片只剩「时间 + 变量数」，看不出还能补说明 |

### 修法

| 层 | 改动 |
| --- | --- |
| 后端 | `save_theme` 接受 `note` / `tags`（`note` ≤120、`tags` ≤4×12），透传给 `_save_library_item`；`_theme_summary` 增补 `note` / `tags` |
| 面板 | 保存区新增 `#lib-note`（maxlength 120）；`saveLibraryTheme` 读值、`args.note`、成功后清空并提示「简介已写入，分享时一起带走」 |
| 卡片 | 自定义条目无简介时渲染 `lib-note is-empty`「没有简介 · 点『编辑』写一句，分享时会一起带走」 |
| 样式 | `.lib-save-note textarea` 与 `.lib-note.is-empty` |

存量能力未改：`update_theme_meta` 仍可改可清，分享包 zip 与 `theme_json` 本来就带 `note` / `tags`，导入也原样落库。

### 验证（D:/m 真机，未重启应用）

| 检查 | 结果 |
| --- | --- |
| 面板资源 | `index.html` 含 `id="lib-note"`；`app.js` 含 `if (note) args.note = note;`；`style.css` 含 `.lib-save-note textarea`；`?v=0.15.71-` |
| `save_theme` | 返回 `theme.note` = 简介、`theme.tags = ['冷色']` |
| `list_themes` | 新条目带同样简介 |
| 分享包 | zip 内 `theme.json` 的 `note` / `tags` 一致（`_work/verify_071.py` 12/12 PASS） |
| 清理 | `delete_theme` 删除验证条目，仓库回到验证前状态 |
| 后端 | `Ran 702 tests / OK (skipped=1)`（新增 `test_theme_note.py` 8 例） |
| 前端 | `materials-selftest` PASS 208（+9） |

### 已知限制

观感与交互仍需人眼确认：本机无 Chrome/Edge、应用未开 CDP，无法截图；简介输入框在窄屏下是第二行整宽（CSS 媒体查询沿用 `.lib-save-row` 的换行规则）。

## 0.15.70 — 配色版主题显式关闭高级材质

User said (m07961)：「同一主题从材质换成非材质的时候仍然保留材质，这是不对的」。

### 根因

0.15.68 把内置主题拆成「配色版 + (材质) 版」时，配色版**不写** `materials`，本意是「只换颜色」。
但 `_apply_theme_record` 里「没有 materials」的语义是*保持用户当前材质*（那是为 0.15.67 之前的老条目
留的兼容分支），于是从 `<id>-material` 切回 `<id>` 时玻璃留在窗口上 —— 两套主题的差别被「缺省」吃掉了。

### 修法

| 层 | 改动 |
| --- | --- |
| 内置主题 | 51 套配色版补上 `"materials": {"enabled": false}`（脚本 `_work/add_materials_off.py`，原文件备份在 `_work/_presets_070_backup/`） |
| 后端 | `_apply_theme_record` 新增 `material_patch` 判定：`materials` 键集 ⊆ `{enabled, lock, version}` 时走 `_materials.apply_materials` 合并，只改开关、保留五节参数与自定义预设；否则仍整份替换 |
| 后端 | 返回值新增 `material_enabled`（`apply_saved_theme` 一并透传），面板据此区分「材质已换」与「材质已关」 |
| 面板 | 配色版卡片显示中性色「无材质」徽标（`.lib-material-chip.is-off`），不再是某个具体预设名；切换提示改为「已关闭高级材质（这套主题不带材质）」 |

为什么是补丁而不是清空：关掉材质后再打开，用户不该突然回到出厂玻璃。材质锁定（`lock`）仍然优先 ——
锁定时配色版的 `enabled: false` 也不生效。0.15.67 之前的老条目 / 老分享包不带 `materials`，语义不变（保持不动）。

### 验证

| 项 | 结果 |
| --- | --- |
| `test_preset_materials.py` | 13 tests OK（新增 3 例：关材质保留参数 / 材质版重新打开 / 锁定不被关掉；配色版断言改为「显式 enabled=false 且只带开关」） |
| 后端全量 | Ran 694 tests, OK (skipped=1) |
| `materials-selftest.js` | PASS 199（新增 5 条：配色版显式关闭 / 材质版默认启用 / 补丁语义 / `material_enabled` / 无材质徽标与提示） |
| 其余前端自测 | 16 套全绿 |
| 真机往返（D:/m，未重启应用） | `amber-dusk-material` → `material_enabled: true`、mvars 126、attrs `{preset: prism, quality: high}`；随后 `amber-dusk` → `material_enabled: false`、磁盘 `enabled=false`、mvars 0、attrs `None` |
| 窗口侧自证 | 切换后 78 秒的诊断 `received_at 08:43:00`：`attrs {}`、`mt_vars 0` —— 材质层真的从窗口撤掉了 |
| 用户原状态 | 验证前备份 `_work/_theme_before_070.json`，验证后已原样恢复（enabled=True / prism / high / 126 变量） |

### 已知限制

`(材质)` 版与配色版是两套独立主题，列表靠后缀与徽标区分；102 条主题没有「只看配色 / 只看材质版」筛选（待定）。
