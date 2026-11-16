# 应用侧补丁（app-patch）—— 主题工坊为什么必须打这一针

本目录是给**不想运行脚本**、想**手工应用/手工还原**的人看的。

---

## 一、为什么需要补丁

N.E.K.O 的插件 SDK **没有**主题 / CSS 注入接口（契约 §0 实测结论）：

- 插件卡片在**沙箱 iframe** 里渲染，只能继承 `color` 与 `font-family` 两个属性；
- 应用本身**没有颜色令牌层**，颜色全是硬编码字面量；
- 因此一个插件**无法**改变聊天界面的样子。

所以本主题采用「**极小的模板补丁 + 插件提供配置**」结构：

1. **模板补丁**（就是本文件）：往两个 HTML 模板里插入**一行**，引入主题的 CSS 与 JS。
2. **插件**：提供「主题工坊」配置面板，把用户选的配色写到 `theme.json`。
3. **JS**：从插件静态路由读取 `theme.json`，把颜色写进 CSS 变量。

这一行补丁是设计前提，不是可选项。

---

## 二、补丁内容（逐字节精确）

要插入的就**一行**，内容如下（见 [head-inject.html](head-inject.html)，214 字节，无 BOM，无结尾换行）：

```
<!-- NTS:BEGIN --><link rel="stylesheet" href="/static/css/neko-theme-studio.css?v={{ static_asset_version }}"><script src="/static/neko-theme-studio.js?v={{ static_asset_version }}" defer></script><!-- NTS:END -->
```

三个要点：

- `<!-- NTS:BEGIN -->` 与 `<!-- NTS:END -->` 是**幂等标记**。安装脚本靠它「先删旧的、再插新的」，重复执行不会叠加。
  **不要改动这两个注释，也不要删掉其中一个。**
- `{{ static_asset_version }}` 是 **Jinja 模板变量**，N.E.K.O 会在渲染时替换成资源版本号。
  手工编辑时**必须原样保留**，否则缓存刷新会失效（但页面仍能用）。
- 两个标签之间**没有换行**，整行就是一个「块」。CSS 在前、JS 在后，JS 带 `defer`。

---

## 三、插到哪里

**必须插在 `dark-mode.css` 那一行的紧后面**（契约 §5：主题规则要晚于 dark mode 加载，才能压过它）。

`dark-mode.css` 的 `<link>` 在两个模板里各出现 **1 次**（模板里还有几处 CSS 注释提到 dark-mode.css，**不要搞错**），原始行内容完全相同：

```html
    <link rel="stylesheet" href="/static/css/dark-mode.css?v={{ static_asset_version }}">
```

| 模板 | 文件 | dark-mode.css 所在行 | 补丁插入后所在行 |
|---|---|---|---|
| 独立聊天窗口 | `resources\bin\templates\chat.html` | 第 20 行 | **第 21 行** |
| 主窗口 | `resources\bin\templates\index.html` | 第 58 行 | **第 59 行** |

两个文件**都要打**，否则主窗口和独立聊天窗口会表现不一致。

---

## 四、手工安装步骤

> 操作前先备份这两个模板！只要复制成 `.bak` 就行。安装脚本的备份放在 `..\backup\` 里（文件名含原始内容哈希，**永不删除**）。

1. 复制两个主题文件到应用的静态目录（没有 `css` 子目录就自己建）：

   ```
   files\css\neko-theme-studio.css   →  <安装根>\resources\bin\static\css\neko-theme-studio.css
   files\neko-theme-studio.js        →  <安装根>\resources\bin\static\neko-theme-studio.js
   ```

   `<安装根>` 一般就是 `D:\tools\enokoo`。

2. 用**支持 UTF-8 且不会擅自加 BOM** 的编辑器打开 `chat.html`。
   注意原始编码：`chat.html` **有** UTF-8 BOM，`index.html` **没有**；两个文件行尾都是 **LF**。
   （用记事本改可能把行尾换成 CRLF、或给 index.html 加上 BOM，请务必复查。）

3. 找到 `dark-mode.css` 那一行，在它**下面新起一行**，粘贴 `head-inject.html` 的整行内容。
   保持原有缩进（4 个空格）即可，缩进不影响功能。

4. 对 `index.html` 重复第 2–3 步。

5. 保存。**不需要重启 N.E.K.O**：48911 端口是**从磁盘实时读取**模板和静态资源的，下一个请求就生效（实测：往 `chat.html` 注入标记后，`GET http://127.0.0.1:48911/chat` 立刻就能看到）。

6. 验证：浏览器打开 `http://127.0.0.1:48911/chat`，查看源码搜索 `NTS:BEGIN`，应该**恰好出现 1 次**。

---

## 五、手工还原

见 [restore/RESTORE.md](restore/RESTORE.md)。

最简做法：删掉这两个模板里 `<!-- NTS:BEGIN -->` 到 `<!-- NTS:END -->` 的**那一整行**，再删掉静态目录里的两个文件即可。

---

## 六、安全边界（契约 §9）

这一行补丁**只引入两个自行管理的文件**，不改动任何既有标签：

- ✅ 允许：颜色、背景、边框、圆角、字体、阴影
- ❌ 禁止：`display` / `position` / `width` / `height` / `flex` / `overflow` / `z-index` / `transform`
  等任何布局属性
- ❌ 禁止：覆盖 `--compact-*`（布局几何）与 `--xy-*`（XYFlow）变量

**绝不要**为了打补丁去改 `resources\app.asar` 或 `projectneko_server.exe`。
本补丁**完全不需要**碰它们。

---

## 七、升级提醒

N.E.K.O 升级会**覆盖**这两个模板，补丁随之消失，同时 `resources\bin\static\` 下的两个主题文件也可能被清掉。
重新运行一次 `install.ps1` 即可（脚本幂等，不会因为重复运行而叠加标记）。
