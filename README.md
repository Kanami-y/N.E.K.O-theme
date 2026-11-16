# N.E.K.O 主题工坊（neko-theme-studio）

N.E.K.O 聊天的可视化主题编辑器：在插件面板里逐项调整 77 个 `--nts-*` CSS 变量
（聊天气泡 / 聊天窗口 / 输入区 / 面板 / 光效与玻璃拟态），保存成一份调色板，
由应用侧加载器轮询后实时注入到应用窗口。

- 插件 id `neko_theme_studio` · 版本 **0.1.10** · 加载器 `SCRIPT_VERSION` **1.5.10**
- 参数总表：[PARAMETER-REFERENCE.md](PARAMETER-REFERENCE.md)（77 项）
- 实现契约（唯一事实来源）：[THEME_CONTRACT.md](THEME_CONTRACT.md)
- 修复与验证记录：[PENDING-VERIFICATION.md](PENDING-VERIFICATION.md)
- 排障：[TROUBLESHOOT.md](TROUBLESHOOT.md)
- 分发打包：[DISTRIBUTION.md](DISTRIBUTION.md)

## 目录

| 路径 | 内容 |
| --- | --- |
| `plugin/` | 插件本体：`plugin.toml` 清单、`__init__.py`（14 个 entry）、`_app_patch.py`（应用侧自愈）、`static/`（面板 UI、加载器、内置主题） |
| `app/` | 安装到应用 `resources/bin/static/` 的两个文件：样式表 + 加载器 |
| `app-patch/` | 手工补丁说明与那一行注入片段（`head-inject.html`） |
| `tools/` | `gen-css.js` 等：样式表由 `test/targets.js` 生成，**不要手改产物** |
| `test/` | 验收与实测脚本（`accept.ps1` / `run-tests.ps1` 等，Windows PowerShell 5.1） |
| `build/` | 实测数据与生成的中间产物 |
| `research/` | `SELECTORS.md`：应用原生着色规则逐条定位 |
| `dist/` | 打包产物 |

## 安装

```powershell
# 解压后进入 theme-studio 目录
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 不传 `-AppRoot` 时会从脚本位置反推安装根（本目录的上一级），幂等可重跑。
卸载用 `.\uninstall.ps1`。

## 为什么需要改应用文件

插件 SDK 没有 CSS/主题注入 API，插件卡片在沙箱 iframe 里只继承 `color` 与 `font-family`，
应用本身也没有颜色令牌层 —— 所以必须往模板里插一行 `<link>` + `<script>`。
这一行是设计前提，不是可选项，细节见 [THEME_CONTRACT.md](THEME_CONTRACT.md) §0。
