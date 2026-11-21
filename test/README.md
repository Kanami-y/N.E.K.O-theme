# 前端自测（无需浏览器 / 无需宿主）

这十四个脚本把工程里「只做数据变换」的代码段原样抠出来，在 Node 的假 DOM / 假时钟里跑断言，
所以不需要真的启动 N.E.K.O、也不需要 Playwright/JSDOM。CI（`.github/workflows/ci.yml`）会全部执行，
任何一个退出码非 0 就构建失败。

| 脚本 | 覆盖什么 | 规模 |
|------|----------|------|
| `panel-selftest.js` | 主题库：族 / 标签 / 搜索三重叠加、收藏置顶、收藏/自定义虚拟族、localStorage 读写（含坏数据）、CATALOG 10 组 101 变量、卡片 DOM 结构（收藏 / JSON 按钮在操作行、JSON 在分享之后）、主题库备份 / 恢复接线、主题信息编辑（编辑按钮 / 弹窗 / 保存 / 失败不关窗）、首次使用提示条、周末另一套时段表接线、排程卡不陈旧（仓库刷新重渲染 / 「（已不存在）」/ 删除前预警 / stale 说明）、背景图适应方式下拉（cover / contain）、圆角风格下拉（round / continuous）、拖拽导入白名单 + CSS 片段导出、圆角风格下拉不再写死 cover/contain、主题仓库输入框尺寸（名称框不再被按钮挤扁 / 搜索框 30px / 动作行可换行）、`node --check` | 247 断言 |
| `glass-selftest.js` | 加载器注入的玻璃层：门控变量写入、12 个门控属性、镜面/掠光/焦散四层槽位、`@keyframes`、`data-uri` 无裸 `#`、按压形变、光效休眠、主题切换过渡（首次不闪 / 换主题闪 / 420ms 消失）、幂等与重建 | 105 断言 |
| `pointer-selftest.js` | 指针追踪：平滑收敛、滚动重算、DOM 变动后重建、节流、非玻璃主题下不写变量、切回后恢复 | 38 断言 |
| `audit-selftest.js` | 可读性自检纯函数：sRGB 亮度、alpha 合成、对比度参考值、渐变取中间色、自动修正（双向搜索 / 8 位取整 / 幂等 / 无解返回 null） | 25 断言 |
| `sync-selftest.js` | 外部改动感知纯函数：调色板签名（内容哈希 FNV-1a：两组 `键\0值` + name + enabled）、跟随/让路决策优先级、`no-store` 轮询与接线、绝不覆盖未提交改动 | 40 断言 |
| `editor-selftest.js` | 编辑区刷新合并：`editorSyncPlan` 三种策略、同帧多次 schedule 只刷一次、`onlyDirty` 下的过滤时机、无 rAF 退回 setTimeout、oninput 全部合并而 onchange 仍立刻刷新 | 44 断言 |
| `loader-warm-selftest.js` | 加载器背景图预热：只预热本插件 `backgrounds/`（外链不请求）、亮暗去重、全部就绪 / 失败 / 超时都只回调一次、已预热不重复请求、门控在改 `<style>` 之前、预热中不改 DOM | 32 断言 |
| `dump-selftest.js` | 当前调色板 JSON 折叠惰性化：`dumpLazyPlan` 真值表、折叠时跳过重建（标脏计数）、展开且脏时补渲染一次、折叠期间复制前强制重建、折叠状态持久化（含 localStorage 抛错降级）、`aria-expanded` / 箭头同步、脚注文案不再谎称「JSON 不含未应用改动」 | 51 断言 |
| `changes-selftest.js` | 待应用改动清单：`changeEntryList` 真值表（改值 / 新增 / 清空 / 与已存值相同跳过 / 亮暗分开 / 键排序）、渲染面（卡片显隐、计数、四种行内块、撤销按钮 aria）、撤销副作用（同步哪一行、确认框拒绝时不动、全部撤销清两张表并调 syncAll / markAllRowsValid / clearRgbMemory） | 41 断言 |
| `hover-selftest.js` | 主题卡悬停预演：静态文件地址推导（presets/ vs themes/）、可移植图片地址改写、按当前模式取值、请求成功与缓存命中、失败静默、忙碌/弹窗让路、过期回包丢弃、缓存上限 60、区块不写盘不走 entry | 33 断言 |
| `freshness-selftest.js` | 面板版本自检：版本解析、版本相同/拿不到/非 2xx 都不动、版本不一致时提示新老版本并延迟重载、sessionStorage 防循环、隐私模式无存储也能工作 | 36 断言 |
| `batch1-selftest.js` | 撤销 / 重做：栈上限 50、同一行 900ms 合并、换行新步、撤销回退多键、重做、新改动清空重做栈、busy 不撤销；单行复制 / 粘贴（非法值拦截并 warn、不写编辑表）；悬停对比卡（只列真正不同的关键面、相同项不列、渲染行数、无预演隐藏）；给 AI 的提示词（主题名 / 契约 / json 围栏 / 当前配色 / 4.5:1 要求 / 改动明细） | 47 断言 |
| `wallpaper-selftest.js` | 壁纸取色 + 变体生成：`extractImageColors`（透明跳过 / 16 级桶聚合 / 按「像素数 × 饱和度 × 可用亮度」排序 / 最多 8 色）、`wallpaperPalette`（主色主导亮暗两套、7:1 主文本与 4.5:1 各处文字对比度、不碰背景图与圆角）、`shiftColorValue`（色相 ±14° / 明度 ±10% / 保 alpha、渐变与非法值返回 null）、`buildVariantPalette`（只改表面色、偏移后重新校验文字对比度） | 62 断言 |
| `materials-selftest.js` | 高级材质中心静态契约：参数表 90 项与 `materials.py` 逐项对齐（不缺不多不重）、10 个导航 id、app.js 三条接线（NekoPanel / applyTheme 提交 materials / reload 回灌基线）、ES5 语法、`?v=` 内容指纹 | 20 断言 |
| `materials-dom-selftest.js` | 高级材质中心运行时：在 ~160 行迷你 DOM 里真的执行 `materials.js` —— 外壳挂载、10 导航渲染、8 个参数界面累加 90 行、预设 7 张 + 画质 4 张、组件 10 张、预览变量与 `data-nts-mt` 落地、脏状态与重置 | 28 断言 |
| `preset3-selftest.js` | 快捷调校：光效三档（0.15 / 0.45 / 0.85，落点 ambient-glow / glass-dispersion / glass-caustic / panel-glow-pulse）、字体三档（系统默认清空 / 无衬线 / 等宽 + 行高）、命中判定（四项一致才算一档、±0.06 容差）、只写 state.edited 且压一次撤销栈 | 52 断言 |

## 运行

```bash
node test/panel-selftest.js
node test/glass-selftest.js
node test/pointer-selftest.js
node test/audit-selftest.js
node test/sync-selftest.js
node test/editor-selftest.js
node test/loader-warm-selftest.js
node test/dump-selftest.js
node test/changes-selftest.js
node test/hover-selftest.js
node test/freshness-selftest.js
node test/batch1-selftest.js
node test/wallpaper-selftest.js
node test/preset3-selftest.js
node test/materials-selftest.js
node test/materials-dom-selftest.js
```

每个脚本失败时以退出码 1 结束，并打印 `✗` 明细；成功时打印 `PASS n/n`。

## 约定

- 这些脚本**只读**工程文件；`glass-selftest.js` 会额外导出 `test/glass_css_dump.css`（已 gitignore），
  方便排查注入后的完整 CSS。
- 断言里引用的版本号（`SCRIPT_VERSION`）、CATALOG 变量数、卡片结构等属于「契约」；改这些地方时
  必须同步改测试，否则 CI 会失败——这正是它们存在的意义。
- 依赖宿主 SDK 的部分不在这里测（用真实的 `POST /runs` 端到端脚本，见 `_work/e2e_*.py`，属本机验证工具）。
