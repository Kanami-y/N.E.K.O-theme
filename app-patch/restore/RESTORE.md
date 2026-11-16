# 手工还原说明（restore）

把主题工坊对应用做的改动**全部撤销**。全程**不需要**碰 `resources\app.asar` 或 `projectneko_server.exe`。

首选方案：直接跑 `..\..\uninstall.ps1`（幂等，可重复执行）。
本文件是**没有 PowerShell 时**的手工操作步骤。

---

## 一、要撤销的东西一共 4 处

| # | 位置 | 动作 |
|---|---|---|
| 1 | `<安装根>\resources\bin\templates\chat.html` | 删掉 `NTS:BEGIN`…`NTS:END` 那一整行 |
| 2 | `<安装根>\resources\bin\templates\index.html` | 删掉 `NTS:BEGIN`…`NTS:END` 那一整行 |
| 3 | `<安装根>\resources\bin\static\css\neko-theme-studio.css` | 删除文件 |
| 4 | `<安装根>\resources\bin\static\neko-theme-studio.js` | 删除文件 |

`<安装根>` 一般就是 `D:\tools\enokoo`。

---

## 二、步骤

### 1. 删模板里的补丁行

用编辑器打开 `chat.html`，搜索 `NTS:BEGIN`。找到的应该是这样的**一整行**：

```
<!-- NTS:BEGIN --><link rel="stylesheet" href="/static/css/neko-theme-studio.css?v={{ static_asset_version }}"><script src="/static/neko-theme-studio.js?v={{ static_asset_version }}" defer></script><!-- NTS:END -->
```

**连整行一起删掉**（包括行尾换行），使上下的行重新贴合。
`index.html` 同样处理。

### 2. 删两个静态文件

```
resources\bin\static\css\neko-theme-studio.css
resources\bin\static\neko-theme-studio.js
```

> ⚠️ 只删这两个文件。`resources\bin\static\` 下还有 `dark-mode.css`、`index.css`、
> `theme-manager.js` 等**应用自带**文件，**绝不能删**。

### 3. （可选）清掉构建滞留

```
%LOCALAPPDATA%\N.E.K.O\.neko-plugin-installations\plugins\neko_theme_studio\
```

这是安装脚本构建插件时的临时暂存目录，正常安装流程结束时它已经被删掉了。若还在，可以删。

### 4. 保存 / 生效

**不需要重启 N.E.K.O**。48911 端口从磁盘实时读取，刷新页面即可。

---

## 三、验证是否还原干净

刷新 `http://127.0.0.1:48911/chat`，查看页面源码：

- 搜索 `NTS:BEGIN` → 应该**搜不到**（0 次）
- 搜索 `dark-mode.css` → 仍然应该有（这是应用自带的，说明你**没删多**）

若手边有备份，直接比对哈希最可靠：

```powershell
Get-FileHash <安装根>\resources\bin\templates\chat.html -Algorithm SHA256
```

安装前的原始值（本机实测基线）：

| 文件 | 字节数 | sha256 |
|---|---|---|
| `chat.html` | 97287 | `6257EE1E32FE639AD574BD9DD20DEB231A1DBE3BEBE53E32174693E4EAAC14A7` |
| `index.html` | 54656 | `5672D4056086A04EF6DC17BD19C58B7561C4DB5DA9FA4056C9C5350C10C486B6` |

> 注意：这两个哈希对应的是**本机当前安装版本**的模板。如果你的 N.E.K.O 版本不同，
> 哈希自然不同 —— 此时请以 `..\..\backup\` 里的备份文件为准（文件名里带着原始内容哈希）。

---

## 四、从备份整文件还原（模板被改坏时）

`..\..\backup\` 里存放着安装前的**逐字节原始副本**：

```
chat.html.pristine-<内容哈希>.20261107-163914.bak
index.html.pristine-<内容哈希>.20261107-163914.bak
```

每个 `.bak` 旁边还有 `.meta.json`，记录了原始字节数、是否带 BOM、行尾类型、sha256。

**直接覆盖回去即可**（文件名里的哈希就是原始内容的 sha256 前 8 位，可按需挑正确的那份）：

```powershell
Copy-Item ..\..\backup\chat.html.pristine-*.bak  <安装根>\resources\bin\templates\chat.html -Force
Copy-Item ..\..\backup\index.html.pristine-*.bak <安装根>\resources\bin\templates\index.html -Force
```

> ⚠️ 这些备份**永久保留**，`uninstall.ps1` 从不删除任何一份。
> 请你也**不要**手工清理它们 —— 它们是最后的保险。

`uninstall.ps1` 会在「移除标记后校验不通过」（缺 Jinja 变量 / 缺 `</html>` / 标记数为 0 但内容可疑 / 文件长度骤减一半以上）时**自动**执行这个整文件还原。

---

## 五、插件本体

应用侧还原后，主题就**不再影响界面**了（样式表和脚本都没了），所以插件本体留着也无害。

若要彻底移除，请到 N.E.K.O 的**「插件管理」界面**里禁用或删除「主题工坊」。
命令行接口**没有**卸载端点（实测 `POST /plugin-cli/uninstall` 返回 404），所以脚本无法替你删。
