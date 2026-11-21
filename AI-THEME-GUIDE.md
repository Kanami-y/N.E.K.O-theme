# N.E.K.O 主题生成指南（给 AI 的规格书）

> 本文由脚本从代码里的单一事实源生成（101 个变量、35 套内置主题、
> 校验器正则与限制直接读取自 `plugin/__init__.py`）。改了变量表就重新生成，别手改本文。
>
> 生成命令：
> ```bash
> node _work/dump_catalog.js && python _work/gen_ai_guide.py
> ```
>
> 用法：把本文整份交给 AI，让它按 §0 的契约输出一个 JSON 文件；用 §7 的命令校验；
> 通过后直接导入面板（主题仓库 → 导入）。**不需要**写代码、不需要改 CSS。

## 0. 你要输出的东西

一个 UTF-8 的 `.json` 文件（不要注释、不要尾逗号）。字段骨架如下（**这是字段说明，含占位符，不是可直接导入的文件**；可直接导入的最小示例见 §1）：

```jsonc
{
  "schema": 1,
  "name": "主题名（≤24 字）",
  "note": "一句话介绍（≤120 字，会显示在主题卡片上）",
  "tags": ["标签1", "标签2"],
  "family": "glassy | gradient | dark | light | texture | minimal（可选）",
  "vars":     { "--nts-变量名": "值", "...": "..." },
  "dark_vars": { "--nts-变量名": "值", "...": "..." },
  "materials": {"enabled": true, "preset": "frosted", "quality": "balanced" }  // 可选，见 §12
}
```

硬性约束：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `schema` | 固定 `1` | 可省略 |
| `name` | ≤24 字 | 卡片标题 |
| `note` | ≤120 字 | 卡片副标题 |
| `tags` | ≤4 个，每个 ≤12 字 | 面板顶部可按标签筛选 |
| `family` | 6 个枚举值之一 | 省略则自动推断（§4） |
| `vars` / `dark_vars` | 键必须来自 §2 总表；值按 §3 语法 | 亮/暗务必成对，否则切暗色会“半套” |
| `materials` | 可选；写 `preset` + `quality` 就够，详见 §12 | 不占用调色板变量；不要手搓 90 个参数 |
| 单个值 | ≤300 字符 | 超长直接拒 |
| 未知变量 | 会被**静默忽略** | 所以变量名必须逐字来自总表 |

语义要点：

1. **不写 = 保留宿主原生外观**（不是“变透明/变黑”）。所以可以只写想改的变量，但成对写亮暗更稳。
2. **写空字符串 `""` = 删除该变量**，恢复原生（仅 `apply_theme` 的增量语义；导入文件里不要写空串，直接省略）。
3. 值一律是**字符串**（包括 `number` 类：写 `"0.55"` 而不是 `0.55`）。
4. 颜色建议统一用 `#rrggbb` / `rgba()`：校验器接受 CSS 颜色名，但对比度自检只解析 hex/rgb。

## 1. 最快上手（复制改数）

最小可用主题：只改 12 个关键变量，其余保留宿主原生外观。

```json
{
  "schema": 1,
  "name": "我的第一套",
  "note": "暖白底 + 天蓝强调色，适合白天",
  "tags": ["亮色", "简约"],
  "vars": {
    "--nts-chat-bg": "#f6f8fb",
    "--nts-topbar-bg": "#ffffff",
    "--nts-topbar-text": "#1c2430",
    "--nts-panel-text": "#1a2330",
    "--nts-panel-text-sub": "#5a6a7e",
    "--nts-input-bg": "#ffffff",
    "--nts-input-text": "#18202c",
    "--nts-ai-bubble-bg": "#ffffff",
    "--nts-ai-bubble-text": "#1c2430",
    "--nts-user-bubble-bg": "#2569d4",
    "--nts-user-bubble-text": "#ffffff",
    "--nts-accent": "#2f7ff0"
  },
  "dark_vars": {
    "--nts-chat-bg": "#0f1621",
    "--nts-topbar-bg": "#131c28",
    "--nts-topbar-text": "#e8f0fb",
    "--nts-panel-text": "#e9f1fb",
    "--nts-panel-text-sub": "#9fb0c6",
    "--nts-input-bg": "#17212f",
    "--nts-input-text": "#eaf2fc",
    "--nts-ai-bubble-bg": "#182333",
    "--nts-ai-bubble-text": "#e9f1fb",
    "--nts-user-bubble-bg": "#2c6fd0",
    "--nts-user-bubble-text": "#ffffff",
    "--nts-accent": "#63a6ff"
  }
}
```

## 2. 变量总表

共 **101** 个变量。

### 2.1 聊天气泡（13 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-ai-bubble-bg` | AI 气泡背景 | 色 | `rgba(68, 183, 254, 0.12)` → `rgba(42, 123, 196, 0.18)` | 4 条 |  |
| `--nts-ai-bubble-border` | AI 气泡描边 | 色 | `rgb(39, 48, 66)` → `rgb(232, 234, 237)` | 4 条 |  |
| `--nts-ai-bubble-text` | AI 气泡文字 | 色 | `rgb(51, 51, 51)` → `rgb(224, 224, 224)` | 28 条 |  |
| `--nts-code-bg` | 代码块背景 | 色 | `rgba(91, 111, 145, 0.12)` → `rgba(100, 120, 160, 0.18)` | 2 条 | 行内代码与代码块的底色（.message-markdown-inline-code / .… |
| `--nts-code-text` | 代码块文字 | 色 | `rgb(34, 50, 77)` → `rgb(192, 204, 224)` | 2 条 | 行内代码与代码块的文字色；原生行内代码 #22324d、代码块 #1f2c42（暗色两者都… |
| `--nts-image-bg` | 图片块背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 1 条 | 消息里图片包裹层 .message-block-image 的底色，垫在图片下方；留空即保… |
| `--nts-status-bg` | 状态块背景 | 色 | `rgba(70, 129, 227, 0.12)` → `rgba(68, 130, 230, 0.15)` | 4 条 | 消息状态块的底色（.message-block-status 的 info / succe… |
| `--nts-status-text` | 状态块文字 | 色 | `rgb(40, 88, 157)` → `rgb(111, 168, 255)` | 4 条 | 消息状态块的文字色（四种 tone 共用这一个变量）；原生四种 tone 各不相同（亮 s… |
| `--nts-tool-bubble-bg` | 工具/系统气泡背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 6 条 | 工具气泡与系统气泡共用的底色（.message-bubble-tool / .messag… |
| `--nts-tool-bubble-text` | 工具/系统气泡文字 | 色 | `rgb(43, 58, 80)` → `rgb(184, 188, 196)` | 18 条 | 工具气泡与系统气泡的文字色；原生工具 #2b3a50、系统 #607086（暗色 #b8b… |
| `--nts-user-bubble-bg` | 用户气泡背景 | 色 | `rgb(68, 183, 254)` → `rgb(42, 123, 196)` | 4 条 |  |
| `--nts-user-bubble-border` | 用户气泡描边 | 色 | `rgb(20, 32, 51)` → `rgb(216, 230, 255)` | 4 条 |  |
| `--nts-user-bubble-text` | 用户气泡文字 | 色 | `rgb(255, 255, 255)` → `rgb(255, 255, 255)` | 25 条 |  |

### 2.2 聊天窗口（15 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-bubble-veil` | 聊天背景虚化 | 数值 | `开` → `—` | — | 气泡上那层「白纱 + 背景模糊」的总开关。关掉后气泡底完全透明、背景模糊归零，聊天背景图与… |
| `--nts-chat-bg` | 聊天窗口背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 4 条 | 紧凑胶囊形态下那条胶囊的底色由它决定（背板不再抢它）。展开后还影响 #react-chat… |
| `--nts-chat-bg-fit` | 背景图适应方式 | keyword | `cover` → `—` | — | 背景图怎么填进聊天区：铺满 = cover，图片铺满整块、比例不对时上下或左右会被裁掉（原… |
| `--nts-chat-bg-image` | 聊天背景图片 | 图片 | `none` → `—` | — | 给消息列表那块底板铺一张图片：设置后图片优先于「聊天背板背景」的纯色（纯色仍在图片下方兜底… |
| `--nts-chat-bg-image-brightness` | 背景图亮度 | 数值 | `1` → `—` | — | 把「聊天背景图片」整体压暗，避免图片跟正文抢视线。取值 0-1：1 = 原图亮度，0.6 … |
| `--nts-chat-bg-position` | 背景图位置 | keyword | `center` → `—` | — | 背景图放在聊天区的哪个位置：只在图片比例和容器不一致（或选了「整图可见」）时看得出来。居中… |
| `--nts-chat-bg-repeat` | 背景图平铺 | keyword | `no-repeat` → `—` | — | 壁纸是否重复铺满：照片类壁纸保持「不平铺」（原生行为）；细纹理、格纹、图案类图片选平铺可以… |
| `--nts-chat-blur` | 毛玻璃模糊 | 模糊 | `blur(48px) saturate(1.8)` → `blur(48px) saturate(1.8)` | 5 条 | CSS 消费方是 backdrop-filter，因此必须写成 blur(18px) 形式… |
| `--nts-chat-opacity` | 聊天面不透明度 | 数值 | `1` → `—` | — | 取值 0-1。走桥接写成 --neko-chat-opacity-factor —— N.… |
| `--nts-chat-panel-bg` | 聊天背板背景 | 色 | `rgba(255, 255, 255, 0.91)` → `rgba(28, 28, 46, 0.91)` | 3 条 | 消息列表背后那块底板的颜色：紧凑态涂 .compact-export-history-sc… |
| `--nts-chat-panel-radius` | 聊天背板圆角 | 尺寸 | `0px` → `0px` | 4 条 | 消息列表那块底板的圆角，与「聊天背板背景」配套。用的是独立变量——「通用圆角」会连带改圆按… |
| `--nts-chat-top-fade` | 顶部渐隐 | 数值 | `1` → `—` | — | 聊天记录最上边那条渐隐，也就是背景图顶部那层「雾」的来源。取值 0-1：1 = 应用原生（… |
| `--nts-corner-style` | 圆角风格 | keyword | `round` → `—` | — | 圆角的几何形状：普通圆角 = 圆弧（原生行为）；连续曲率 = 超椭圆，转角没有「突然变直」… |
| `--nts-topbar-bg` | 顶栏背景 | 色 | `rgba(255, 255, 255, 0.75)` → `rgba(0, 0, 0, 0)` | 1 条 |  |
| `--nts-topbar-text` | 顶栏文字 | 色 | `rgb(34, 34, 34)` → `rgb(224, 224, 224)` | 2 条 |  |

### 2.3 输入区（9 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-button-bg` | 工具按钮背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 4 条 |  |
| `--nts-button-hover-bg` | 工具按钮悬停 | 色 | `NO-PSEUDO-STATE` → `NO-PSEUDO-STATE` | 1 条 | 只在鼠标悬停工具按钮时生效（.composer-tool-btn:hover），不影响按钮… |
| `--nts-button-text` | 工具按钮文字 | 色 | `rgb(18, 48, 79)` → `rgb(216, 234, 255)` | 4 条 |  |
| `--nts-input-bg` | 输入区背景 | 色 | `rgba(255, 255, 255, 0.5)` → `rgba(40, 40, 40, 0.65)` | 3 条 |  |
| `--nts-input-border` | 输入区描边 | 色 | `rgba(0, 0, 0, 0.06)` → `rgba(255, 255, 255, 0.06)` | 2 条 |  |
| `--nts-input-placeholder` | 占位文字 | 色 | `rgba(102, 117, 141, 0.5)` → `rgb(154, 160, 172)` | 1 条 |  |
| `--nts-input-text` | 输入文字 | 色 | `rgb(31, 35, 41)` → `rgb(232, 234, 237)` | 1 条 |  |
| `--nts-send-bg` | 发送按钮背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 3 条 |  |
| `--nts-send-text` | 发送按钮文字 | 色 | `rgb(255, 255, 255)` → `rgb(255, 255, 255)` | 2 条 |  |

### 2.4 面板 / 弹窗 / 菜单（11 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-accent-bg` | 插件页强调底纹 | 色 | `MISSING-ELEMENT` → `MISSING-ELEMENT` | 1 条 | 走桥接：写 #agent-plugin-content / #agent-plugin-v… |
| `--nts-modal-bg` | 弹窗背景 | 色 | `rgba(0, 0, 0, 0)` → `rgb(45, 45, 45)` | 1 条 |  |
| `--nts-modal-text` | 弹窗文字 | 色 | `rgb(34, 34, 34)` → `rgb(224, 224, 224)` | 2 条 |  |
| `--nts-overlay-bg` | 弹窗遮罩背景 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0.65)` | 1 条 | 弹窗背后的整屏遮罩 .modal-overlay 底色；原生亮色模式基本不铺遮罩（常见组件… |
| `--nts-panel-bg` | 面板背景 | 色 | `rgba(255, 255, 255, 0.91)` → `rgba(28, 28, 46, 0.91)` | 1 条 | 作用于输入区面板（.composer-panel）与悬浮任务面板（#agent-task-… |
| `--nts-panel-border` | 面板描边 | 色 | `rgba(0, 0, 0, 0.08)` → `—` | — |  |
| `--nts-panel-text` | 面板文字 | 色 | `rgb(51, 51, 68)` → `rgb(230, 235, 242)` | 1 条 | 作用于悬浮任务面板、访问条等面板面的文字；输入框里的文字请用「输入文字」。紧凑胶囊的文字颜… |
| `--nts-panel-text-sub` | 面板次级文字 | 色 | `#666666` → `—` | — | 走桥接：写 #agent-plugin-content / #agent-plugin-v… |
| `--nts-popover-bg` | 弹出菜单背景 | 色 | `rgba(255, 255, 255, 0.85)` → `rgba(38, 38, 58, 0.78)` | 2 条 |  |
| `--nts-popover-border` | 弹出菜单描边 | 色 | `rgba(127, 144, 170, 0.18)` → `rgba(255, 255, 255, 0.08)` | 1 条 |  |
| `--nts-popover-text` | 弹出菜单文字 | 色 | `—` → `—` | 1 条 |  |

### 2.5 推荐 / 系统 chip（5 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-chip-bg` | chip 背景 | 色 | `rgba(68, 183, 254, 0.16)` → `rgba(68, 183, 254, 0.16)` | 3 条 |  |
| `--nts-chip-text` | chip 文字 | 色 | `rgb(29, 111, 165)` → `rgb(159, 216, 255)` | 4 条 |  |
| `--nts-rec-bg` | 推荐条背景 | 色 | `rgb(255, 255, 255)` → `rgb(40, 52, 63)` | 2 条 |  |
| `--nts-rec-border` | 推荐条描边 | 色 | `rgba(108, 151, 174, 0.18)` → `rgb(65, 84, 95)` | 1 条 | 只在 .proactive-recommendation-card 上生效；留空即保持原生… |
| `--nts-rec-text` | 推荐条文字 | 色 | `rgb(52, 75, 93)` → `rgb(226, 233, 238)` | 1 条 |  |

### 2.6 全局（6 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-accent` | 主色调 | 色 | `NO-PSEUDO-STATE` → `NO-PSEUDO-STATE` | 3 条 |  |
| `--nts-highlight` | 选中高亮 | 色 | `UNQUERYABLE` → `UNQUERYABLE` | 1 条 |  |
| `--nts-link` | 链接色 | 色 | `rgb(47, 104, 223)` → `rgb(111, 168, 255)` | 2 条 |  |
| `--nts-scrollbar-thumb` | 滚动条滑块 | 色 | `rgba(0, 0, 0, 0.25)` → `—` | — |  |
| `--nts-scrollbar-track` | 滚动条轨道 | 色 | `transparent` → `—` | — |  |
| `--nts-text-gradient` | 文字渐变 | 渐变 | `none` → `—` | — | 把聊天正文的文字填充换成一条渐变（如 linear-gradient(135deg, #6… |

### 2.7 非颜色项（11 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-bubble-radius` | 聊天气泡圆角 | 尺寸 | `16px 8px 16px 16px` → `16px 8px 16px 16px` | 11 条 | 只影响气泡本体；留空即保持原生（用户气泡 16px/8px 不对称圆角） |
| `--nts-card-radius` | 插件卡片圆角 | 尺寸 | `0px` → `0px` | 1 条 | 只影响 .agent-plugin-view 卡片；留空即保持原生 |
| `--nts-font-family` | 字体族 | 字体 | `inherit` → `—` | — |  |
| `--nts-font-size` | 基础字号 | 尺寸 | `15.04px` → `15.04px` | 3 条 | 消息正文的字号，纯文本与 Markdown 两种消息都会跟着变（如 1rem / 17px… |
| `--nts-line-height` | 行高 | 行高 | `—` → `—` | — | 聊天气泡里文字的行距，写成无单位倍数（1.55 = 1.55 倍字号）。1.3 偏紧凑、1… |
| `--nts-modal-radius` | 弹窗圆角 | 尺寸 | `0px` → `0px` | 1 条 | 只影响 .modal-dialog 对话框；留空即保持原生 |
| `--nts-popover-radius` | 浮层圆角 | 尺寸 | `12px` → `12px` | 1 条 | 只影响 .composer-overflow-popover 等弹出层；留空即保持原生 |
| `--nts-radius` | 通用圆角（按钮/输入面板） | 尺寸 | `999px` → `999px` | 5 条 | 原生值各组件不同（顶栏 0 / 卡片 12px / 按钮 10px），留空即完全保持原生 |
| `--nts-rec-radius` | 推荐卡圆角 | 尺寸 | `18px` → `18px` | 1 条 | 只影响推荐类气泡卡片；留空即保持原生 |
| `--nts-shadow` | 阴影 | 阴影 | `none` → `none` | 8 条 | 如 0 2px 4px rgba(0,0,0,0.1)；作用在 7 个卡片面上（用户/AI… |
| `--nts-shell-radius` | 聊天窗外壳圆角 | 尺寸 | `22px` → `22px` | 1 条 | 只影响聊天窗口外壳 #react-chat-window-shell；留空即保持原生 |

### 2.8 面板光效 / 玻璃拟态（13 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-panel-border-color` | 描边颜色 | 色 | `rgba(255,255,255,.55)` → `—` | — | 面板边缘那圈半透明描边。想做出玻璃高光感，用白色系带透明度（rgba(255,255,25… |
| `--nts-panel-border-width` | 描边粗细 | 尺寸 | `1.5px` → `—` | — | 边缘描边的宽度。1px 是细高光，2-3px 以上会有明显「玻璃边框」感；留空即不画描边 |
| `--nts-panel-corner-glow` | 四角高光 | 数值 | `1` → `—` | — | 0-1 乘子，控制四个角上那四团径向高光的浓度。玻璃拟态里最容易出「立体感」的一项；0 =… |
| `--nts-panel-edge-gradient` | 边缘内侧渐变 | 数值 | `1` → `—` | — | 0-1 乘子，控制从边缘往内柔和衰减的那层亮光（inset 阴影），配合外发光能做出「面板… |
| `--nts-panel-glass-blur` | 玻璃磨砂 | 模糊 | `blur(18px)` → `—` | — | 把「聊天背景图片」本身糊掉（只糊图片，正文不受影响 —— 走的是夹在图片与文字之间的负层）… |
| `--nts-panel-glass-tint` | 玻璃底色 | 色 | `transparent` → `—` | — | 半透明玻璃底色，铺在「聊天背板背景」之上、背景图之下。想做出磨砂玻璃，填 rgba(255… |
| `--nts-panel-glow-color` | 光晕颜色 | 色 | `#ffffff` → `—` | — | 外发光、四角高光、边缘内侧渐变三者共用的颜色。任意 CSS 颜色都行（#7ff / dod… |
| `--nts-panel-glow-pulse` | 呼吸幅度 | 数值 | `—` → `—` | — | 发光强度的呼吸幅度，0-1：0 = 恒定不呼吸，0.5 = 亮度在 100%~50% 之间… |
| `--nts-panel-glow-size` | 光晕尺寸 | 尺寸 | `24px` → `—` | — | 外发光的基础半径（扩散 1 倍、模糊 0.42 倍）。内侧边缘渐变的宽度也按它算。24px… |
| `--nts-panel-glow-speed` | 呼吸节奏 | 节奏 | `3.2s` → `—` | — | 一次呼吸的时长，写 3.2s / 800ms 都行；只填数字按秒算（3 会补成 3s）。上… |
| `--nts-panel-glow-strength` | 发光强度 | 数值 | `1` → `—` | — | 0-1 乘子，同时缩放外发光的扩散范围、模糊半径与颜色浓度。0 = 完全无光，1 = 用满… |
| `--nts-panel-inner-glow` | 内阴影 | 数值 | `1` → `—` | — | 0-1 乘子，控制面板内侧一圈淡淡的下沉阴影，让面板看起来「厚」。0 = 关闭 |
| `--nts-panel-sheen` | 玻璃反射高光 | 数值 | `1` → `—` | — | 0-1 乘子，控制从左上斜下来那条高光带（模拟玻璃反光）。0.3-0.5 比较自然，1 会… |

### 2.9 液态玻璃 / 渐变（9 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-ai-bubble-gradient` | AI 气泡渐变 | 渐变 | `none` → `none` | 3 条 | 只给 AI 气泡铺渐变背景。留空 = 不生效（默认不配置），AI 气泡仍用 AI 气泡背景… |
| `--nts-bubble-glass-filter` | 气泡玻璃模糊 | 模糊链 | `—` → `—` | 2 条 | 用户/AI 气泡自身背景的模糊程度，通常比界面玻璃更轻一点，例如 blur(12px) s… |
| `--nts-bubble-glass-tint` | 气泡玻璃底色 | 色 | `rgba(0, 0, 0, 0)` → `rgba(0, 0, 0, 0)` | 2 条 | 气泡的半透明底色；想让气泡有玻璃质感就填 rgba(255,255,255,0.18) 这… |
| `--nts-chat-gradient` | 聊天区渐变 | 渐变 | `none` → `none` | 2 条 | 整个聊天区（消息列表、聊天主体）的背景渐变，必须写成 linear-gradient(..… |
| `--nts-glass-filter` | 界面玻璃模糊 | 模糊链 | `blur(48px) saturate(1.8)` → `blur(48px) saturate(1.8)` | 5 条 | 顶栏、输入框外壳、浮层这些「玻璃面」背后的模糊程度，直接写 backdrop-filter… |
| `--nts-glass-highlight` | 玻璃高光描边 | 色 | `—` → `—` | 4 条 | 玻璃面那圈高光描边，填白色带透明度就有玻璃边缘反光的味道。留空 = 不生效，不画这圈高光 |
| `--nts-glass-tint` | 界面玻璃底色 | 色 | `rgba(255, 255, 255, 0.75)` → `rgba(0, 0, 0, 0)` | 5 条 | 玻璃面上的半透明底色，和上面的模糊是配套的：想做出磨砂玻璃就填 rgba(255,255,… |
| `--nts-panel-gradient` | 面板渐变 | 渐变 | `—` → `—` | 1 条 | 聊天背板/导出历史面板那层背景渐变，格式和上面一样，会盖在背板纯色之上。留空 = 不生效，… |
| `--nts-user-bubble-gradient` | 用户气泡渐变 | 渐变 | `none` → `none` | 3 条 | 只给用户气泡单独铺渐变背景，用「角度 + 起止色」快组一键生成最省事。留空 = 不生效（默… |

### 2.10 液态玻璃质感（9 项）

| 变量 | 面板名称 | 类型 | 原生亮 → 原生暗 | 影响选择器 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `--nts-ambient-glow` | 指针光源 | 数值 | `—` → `—` | — | 指针光源 0–1：0.4–0.7 时玻璃表面会跟着鼠标出现一片柔光（光源在动，玻璃的反光也… |
| `--nts-glass-caustic` | 流动焦散 | 数值 | `—` → `—` | — | 流动焦散 0–1：0.3–0.6 时玻璃后面有一团柔光缓慢胀缩，像水面的光透过玻璃在晃；与… |
| `--nts-glass-dispersion` | 边缘分光色散 | 数值 | `—` → `—` | — | 边缘分光 0–1：0.3–0.55 时玻璃边缘出现暖色（左上）与冷色（右下）两条细亮线，模… |
| `--nts-glass-lens` | 边缘透镜亮环 | 数值 | `—` → `—` | — | 边缘透镜亮环 0–1：0 = 不画，0.5–0.8 在玻璃边缘叠一圈向内弯的亮环 + 内侧… |
| `--nts-glass-noise` | 雾面颗粒 | 数值 | `—` → `—` | — | 雾面颗粒 0–1：0 = 光滑，0.1–0.25 有轻微磨砂质地（配合玻璃底色 alpha… |
| `--nts-glass-rim` | 玻璃边缘反光 | 色 | `rgba(255,255,255,0.55)` → `—` | — | 玻璃边缘反射光：沿面板/气泡/输入框边缘画一圈像镜面切边的亮线。配合低的玻璃底色 alph… |
| `--nts-glass-sheen` | 表面掠光强度 | 数值 | `—` → `—` | — | 表面掠光强度 0–1：0 = 完全不动，0.3–0.7 会有一条高光带缓缓扫过玻璃面（需要… |
| `--nts-glass-specular` | 镜面高光 | 数值 | `—` → `—` | — | 镜面高光 0–1：0.6–0.8 时玻璃表面有一团柔和反光，会跟着鼠标指针移动（苹果液态玻… |
| `--nts-glass-thickness` | 玻璃厚度 | 数值 | `—` → `—` | — | 玻璃厚度 0–1：上缘 1px 高光 + 下缘 1px 暗边 + 四边半亮 + 外投影，越… |


## 3. 类型与合法取值（严格整串匹配）

| 类型 | 面板显示 | 合法写法 | 补充 |
| --- | --- | --- | --- |
| `color` | 色 | `#rgb` `#rgba` `#rrggbb` `#rrggbbaa` / `rgb(0,122,255)` / `rgba(0,0,0,0.4)` / `hsl(210,100%,52%)` / 148 个 CSS 颜色名 / `transparent` / `currentcolor` | 整串必须完全匹配，前后不能有别的字符 |
| `number` | 数值 | 0–1 的小数（`0` `0.55` `1`）或百分比 `0%`–`100%`；写 `1.5`、`120%` 会被拒 | 整串必须完全匹配，前后不能有别的字符 |
| `length` | 尺寸 | 正长度：`12px` `1.5rem` `0.9em` `10%` `8pt` `2vh` `3vw` 或 `0`；负值会被拒 | 整串必须完全匹配，前后不能有别的字符 |
| `blur` | 模糊 | `blur(18px)` 或裸长度 `18px`；只收 px，0–40px | 整串必须完全匹配，前后不能有别的字符 |
| `filter` | 模糊链 | 1–4 个函数串：`blur(0–40px)` / `saturate(0–400%)` / `brightness(%)` / `contrast(%)` / `grayscale(%)`，例：`blur(24px) saturate(180%) brightness(106%)` | 整串必须完全匹配，前后不能有别的字符 |
| `gradient` | 渐变 | `linear-gradient(135deg, #fff 0%, #eef 100%)` 或 `radial-gradient(#fff 0%, #eef 100%)`；2–4 个停止点，**每个都必须带 %**；整串 ≤300 字符 | 整串必须完全匹配，前后不能有别的字符 |
| `shadow` | 阴影 | 1–4 层，每层 `x y blur [spread] color`（可加 `inset`），例：`0 8px 24px rgba(0,0,0,0.28)`；带 `var()` 的自己拼会失败 | 整串必须完全匹配，前后不能有别的字符 |
| `font` | 字体 | 字体族列表，≤200 字符，只允许字母/数字/中文/空格/逗号/引号/连字符/下划线/点：`system-ui, "Segoe UI", sans-serif` | 整串必须完全匹配，前后不能有别的字符 |
| `image` | 图片 | `none` 或 `url("http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/<文件名>")`（只认插件自己的背景图目录） | 整串必须完全匹配，前后不能有别的字符 |
| `time` | 节奏 | `0.8s` / `800ms` / 裸数字按秒；范围 0–60s | 整串必须完全匹配，前后不能有别的字符 |
| `switch` | 开关 | `true` / `false`（少数开关型变量） | 整串必须完全匹配，前后不能有别的字符 |

配套常量（与代码一致）：

- 单个值上限 **300 字符**；数值类可写百分比但只有 `0%`–`100%` 有意义；
- `filter`：1–4 个函数、不可重复、`blur` 只能 px 且 ≤40px、百分比函数 ≤400%、**大小写敏感**（`blur(20PX)` 无效）；
- `gradient`：只收 `linear-gradient` / `radial-gradient`；linear 第一个参数必须是 `135deg` 这种角度；
  2–4 个停止点，每个停止点**必须**带百分比且 ≤100%；整串 ≤300 字符；
- `shadow`：最多 4 层，每层形如 `0 4px 12px rgba(0,0,0,0.3)`，可带 `inset`；不支持 `var()`；
- `image`：只认插件自己的背景图 URL（`/plugin/neko_theme_studio/ui/backgrounds/<文件名>`）或 `none`；
- 禁止出现 `url(`（image 类型除外）、`;`、`expression`、`javascript:` 等注入字符。

## 4. 风格族（分类 tab 靠它）

| 族 | 判定（自动推断，除非预设里声明） | 想命中就怎么写 |
| --- | --- | --- |
| `glassy` 液态玻璃 | 有 `--nts-glass-tint` / `--nts-panel-glass-tint`，值为 `rgba(...)` 且 alpha 在 0.02–0.30，且 `--nts-glass-filter` / `--nts-panel-glass-blur` 含 ≥20px 的 blur | 半透明 tint（0.12–0.26）+ `blur(24–30px) saturate(...)` + rim/sheen/noise |
| `gradient` 渐变 | 声明 `family`，或明显以渐变为主 | `--nts-chat-gradient`、`--nts-panel-gradient`、气泡渐变 |
| `dark` 暗色 | 亮色底 `--nts-chat-bg` 的相对亮度 < 0.42 | 深底 + 浅字 |
| `light` 亮色 | 其余 | 浅底 + 深字 |
| `texture` 纸感 | 声明 `family` | 噪点/纸纹、衬线字体、低饱和 |
| `minimal` 极简 | 声明 `family` | 小圆角、关光晕动画、单色系 |

> 不声明 `family` 也能进分类（按上面自动推断）；声明了就以声明为准，取值只能是
> `glassy` `gradient` `dark` `light` `texture` `minimal`。

## 5. 可读性硬阈值（不满足会被 `plugin/tests/test_preset_contrast.py` 判红）

| 组合 | 阈值（WCAG） | 说明 |
| --- | --- | --- |
| 正文 / 聊天背景 | ≥ 4.5:1 | `--nts-panel-text` × `--nts-chat-bg` |
| 正文 / 顶栏 | ≥ 4.5:1 | `--nts-topbar-text` × `--nts-topbar-bg` |
| 正文 / 输入框 | ≥ 4.5:1 | `--nts-input-text` × `--nts-input-bg` |
| 正文 / AI 气泡 | ≥ 4.5:1 | `--nts-ai-bubble-text` × `--nts-ai-bubble-bg` |
| 用户气泡文字 | ≥ 4.5:1 | `--nts-user-bubble-text` × 气泡底色/渐变中点 |
| 发送键文字 | ≥ 4.5:1 | `--nts-send-text` × `--nts-send-bg` |
| 次要文字 / 聊天背景 | ≥ 3.0:1 | `--nts-panel-text-sub` |
| placeholder | ≥ 3.0:1 | `--nts-input-placeholder` |
| chip 文字 | ≥ 3.0:1 | `--nts-chip-text` × `--nts-chip-bg` |
| 链接 / 聊天背景 | ≥ 3.0:1 | `--nts-link` |

半透明色按「叠在下面那层之上」计算；渐变取中间色标。

## 6. 配方（可直接改）

### 6.2 亮色主题配方

必须成对考虑的 6 组：`chat-bg`×`panel-text`、`topbar-bg`×`topbar-text`、
`input-bg`×`input-text`、`ai-bubble-bg`×`ai-bubble-text`、`user-bubble-bg`×`user-bubble-text`、
`send-bg`×`send-text`。亮色主题最容易翻车的是 **placeholder / 次要文字**（要 ≥3.0:1）和 **发送键文字**（≥4.5:1）。
注意 `--nts-panel-glass-blur` 的类型是 `blur`（只收 `blur(26px)` 这种单函数），多函数链请写进 `--nts-glass-filter`。

### 6.3 暗色主题配方

暗色底不要纯 `#000`（会显得像 OLED 测试页）：用 `#0e1520`–`#1a2230` 区间，文字用 `#e6eefb`
而不是纯白（纯白在深底上会“发光”）；强调色比亮色主题抬高 10–20% 亮度。

### 6.4 真液态玻璃配方（命中 `glassy`）

片段：把 `vars` 合并进完整主题（自己补 `name` / `note` / 文字色；完整可导入示例见 §9）。

```jsonc
{
  "vars": {
    "--nts-panel-glass-tint": "rgba(255,255,255,0.18)",
    "--nts-panel-glass-blur": "blur(26px)",
    "--nts-glass-tint": "rgba(255,255,255,0.16)",
    "--nts-glass-filter": "blur(26px) saturate(180%) brightness(106%)",
    "--nts-glass-rim": "rgba(255,255,255,0.55)",
    "--nts-glass-lens": "0.75",
    "--nts-glass-thickness": "0.80",
    "--nts-glass-specular": "0.70",
    "--nts-glass-sheen": "0.45",
    "--nts-glass-noise": "0.14",
    "--nts-ambient-glow": "0.55",
    "--nts-glass-dispersion": "0.40",
    "--nts-glass-caustic": "0.45"
  }
}
```

玻璃族的硬性条件（不满足就不会被归到 `glassy`）：tint 用 `rgba()` 且 alpha ≤0.30、
filter 里 blur ≥20px 且带 saturate。文字仍必须压在 tint 之上满足对比度 —— 玻璃越透明，
越要靠 `--nts-panel-text` / `--nts-bubble-*` 保证可读。

### 6.5 渐变主题配方

片段：把 `vars` 合并进完整主题（渐变只决定背景层，文字色仍需自己给）。

```jsonc
{
  "vars": {
    "--nts-chat-gradient": "linear-gradient(160deg, #0f2027 0%, #203a43 55%, #2c5364 100%)",
    "--nts-panel-gradient": "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 100%)",
    "--nts-user-bubble-gradient": "linear-gradient(135deg, #5b8def 0%, #8a6cf0 100%)",
    "--nts-ai-bubble-gradient": "linear-gradient(160deg, #1c2b3a 0%, #22384d 100%)"
  }
}
```

注意：渐变的停止点**必须带百分比**，`linear-gradient(135deg, #fff, #000)` 会被整条拒绝；
整串 ≤300 字符；最多 4 个停止点。

## 7. 校验：先本地跑，再导入

**在主题工坊仓库里**（需要本机 Python，用插件自己的离线后端，不依赖宿主）：

```bash
python _work/validate_theme.py 你的主题.json
```

脚本会输出：解析是否成功、被拒的变量与原因、亮/暗变量数、推断出的风格族、
以及亮暗两套的对比度检查表；退出码 0 = 可导入，1 = 有硬错误，2 = 只有对比度警告。**全绿再导入**。

**只有这份 md、没有仓库**：直接把 JSON 交给插件「主题仓库 → 导入」。导入端会用**同一套校验器**
逐条拒绝非法值，并在结果里列出来（例如「vars: --nts-glass-filter 的值非法已拒绝」）；
对照 §8 改完再导一次即可。

## 8. 常见错误对照表

| 报错 / 现象 | 原因 | 修法 |
| --- | --- | --- |
| `值非法已拒绝` / `apply_theme failed` | 某个变量的值没过校验 | 用 §3 的写法逐条核对；先用 §7 脚本定位 |
| `主题文件缺少 vars / dark_vars 字段` | JSON 里两个字段都没有 | 至少写 `vars`（暗色可省，但强烈建议成对写） |
| `主题文件不是合法 JSON` | 尾逗号 / 单引号 / 注释 | 标准 JSON：双引号、无尾逗号 |
| 导入成功但外观没变化 | 值被后端接受、但 loader 不认（如 `blur(18%)`） | 用 `blur(18px)`；渐变停止点补 `%` |
| 文字看不清 | 只改了背景没改文字，或对比度不足 | 按 §5 的阈值成对调 |
| 玻璃不像玻璃 | tint 不透明（alpha >0.30）或没有 `backdrop-filter` | 用 `rgba(...,0.12–0.26)` + `blur(24–30px)` |
| `brightness(1.06)` 被拒 | filter 里只收百分比 | 写 `brightness(106%)` |
| `--nts-node` 之类的变量没报错但没效果 | 未知变量会被忽略 | 变量名必须来自 §2 总表 |

## 9. 完整示例（真实内置主题「液态玻璃·水晶」，91 个变量，可直接改成自己的）

```json
{
  "schema": 1,
  "name": "液态玻璃·水晶",
  "note": "棱镜切面的水晶玻璃，边缘会析出一点紫青；透光率最高、掠光最强的一套。",
  "tags": [
    "液态玻璃",
    "亮色",
    "水晶"
  ],
  "vars": {
    "--nts-accent": "#6d5bd0",
    "--nts-accent-bg": "rgba(109, 91, 208, 0.14)",
    "--nts-highlight": "rgba(109, 91, 208, 0.3)",
    "--nts-link": "#6d5bd0",
    "--nts-image-bg": "rgba(255, 255, 255, 0.42)",
    "--nts-radius": "14px",
    "--nts-shadow": "0 20px 48px rgba(58, 63, 107, 0.18)",
    "--nts-font-size": "14px",
    "--nts-chat-bg": "rgba(247, 249, 254, 0.36)",
    "--nts-chat-panel-bg": "rgba(255, 255, 255, 0.26)",
    "--nts-chat-panel-radius": "26px",
    "--nts-chat-top-fade": "1",
    "--nts-chat-blur": "blur(22px)",
    "--nts-bubble-veil": "0.2",
    "--nts-topbar-bg": "rgba(255, 255, 255, 0.5)",
    "--nts-topbar-text": "#101a2a",
    "--nts-input-bg": "rgba(255, 255, 255, 0.48)",
    "--nts-input-text": "#101a2a",
    "--nts-input-border": "rgba(109, 91, 208, 0.34)",
    "--nts-input-placeholder": "#69707a",
    "--nts-button-bg": "rgba(255, 255, 255, 0.4)",
    "--nts-button-text": "#101a2a",
    "--nts-button-hover-bg": "rgba(255, 255, 255, 0.62)",
    "--nts-send-bg": "#6a59cb",
    "--nts-send-text": "#ffffff",
    "--nts-user-bubble-bg": "rgba(109, 91, 208, 0.48)",
    "--nts-user-bubble-text": "#120d2e",
    "--nts-user-bubble-border": "rgba(220, 235, 255, 0.60)",
    "--nts-user-bubble-gradient": "linear-gradient(135deg, rgba(109, 91, 208, 0.48) 0%, rgba(115, 98, 210, 0.48) 100%)",
    "--nts-ai-bubble-bg": "rgba(255, 255, 255, 0.4)",
    "--nts-ai-bubble-text": "#101a2a",
    "--nts-ai-bubble-border": "rgba(220, 235, 255, 0.60)",
    "--nts-ai-bubble-gradient": "linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0.4) 100%)",
    "--nts-bubble-radius": "18px",
    "--nts-shell-radius": "22px",
    "--nts-panel-bg": "#f2f5fb",
    "--nts-panel-text": "#101a2a",
    "--nts-panel-text-sub": "#55637a",
    "--nts-panel-border": "rgba(220, 235, 255, 0.60)",
    "--nts-panel-border-color": "rgba(220, 235, 255, 0.60)",
    "--nts-panel-border-width": "1px",
    "--nts-panel-glass-blur": "blur(24px)",
    "--nts-panel-glass-tint": "rgba(242, 248, 255, 0.11)",
    "--nts-modal-bg": "rgba(255, 255, 255, 0.97)",
    "--nts-modal-text": "#101a2a",
    "--nts-modal-radius": "18px",
    "--nts-overlay-bg": "rgba(10, 14, 22, 0.42)",
    "--nts-popover-bg": "rgba(255, 255, 255, 0.97)",
    "--nts-popover-border": "rgba(220, 235, 255, 0.60)",
    "--nts-popover-text": "#101a2a",
    "--nts-popover-radius": "12px",
    "--nts-card-radius": "14px",
    "--nts-rec-bg": "rgba(255, 255, 255, 0.48)",
    "--nts-rec-border": "rgba(220, 235, 255, 0.60)",
    "--nts-rec-text": "#101a2a",
    "--nts-rec-radius": "16px",
    "--nts-chip-bg": "rgba(109, 91, 208, 0.12)",
    "--nts-chip-text": "#101a2a",
    "--nts-status-bg": "rgba(109, 91, 208, 0.16)",
    "--nts-status-text": "#101a2a",
    "--nts-tool-bubble-bg": "rgba(255, 255, 255, 0.42)",
    "--nts-tool-bubble-text": "#55637a",
    "--nts-code-bg": "rgba(255, 255, 255, 0.46)",
    "--nts-code-text": "#433e85",
    "--nts-scrollbar-track": "rgba(255, 255, 255, 0.24)",
    "--nts-scrollbar-thumb": "rgba(109, 91, 208, 0.42)",
    "--nts-glass-filter": "blur(24px) saturate(200%) brightness(108%)",
    "--nts-glass-tint": "rgba(242, 248, 255, 0.12)",
    "--nts-glass-highlight": "rgba(255, 255, 255, 0.8)",
    "--nts-bubble-glass-filter": "blur(15px) saturate(188%)",
    "--nts-bubble-glass-tint": "rgba(255, 255, 255, 0.2)",
    "--nts-panel-inner-glow": "0.95",
    "--nts-panel-sheen": "0.58",
    "--nts-panel-corner-glow": "0.85",
    "--nts-panel-edge-gradient": "1",
    "--nts-panel-glow-color": "rgba(169, 232, 255, 0.55)",
    "--nts-panel-glow-strength": "0.55",
    "--nts-panel-glow-size": "26px",
    "--nts-panel-glow-pulse": "1",
    "--nts-panel-glow-speed": "3.2s",
    "--nts-chat-gradient": "linear-gradient(160deg, #fbfcff 0%, #eef2fa 55%, #e6ecf7 100%)",
    "--nts-panel-gradient": "linear-gradient(165deg, rgba(255, 255, 255, 0.82) 0%, rgba(225, 227, 246, 0.72) 100%)",
    "--nts-glass-rim": "rgba(215, 230, 255, 0.60)",
    "--nts-glass-sheen": "0.66",
    "--nts-glass-noise": "0.1",
    "--nts-glass-lens": "0.85",
    "--nts-glass-thickness": "0.80",
    "--nts-glass-specular": "0.85",
    "--nts-ambient-glow": "0.68",
    "--nts-glass-dispersion": "0.55",
    "--nts-glass-caustic": "0.55"
  },
  "dark_vars": {
    "--nts-accent": "#b9a8ff",
    "--nts-accent-bg": "rgba(185, 168, 255, 0.14)",
    "--nts-highlight": "rgba(185, 168, 255, 0.3)",
    "--nts-link": "#b9a8ff",
    "--nts-image-bg": "rgba(11, 13, 24, 0.42)",
    "--nts-radius": "14px",
    "--nts-shadow": "0 20px 48px rgba(0, 0, 0, 0.42)",
    "--nts-font-size": "14px",
    "--nts-chat-bg": "rgba(10, 12, 22, 0.36)",
    "--nts-chat-panel-bg": "rgba(11, 13, 24, 0.26)",
    "--nts-chat-panel-radius": "26px",
    "--nts-chat-top-fade": "1",
    "--nts-chat-blur": "blur(22px)",
    "--nts-bubble-veil": "0.22",
    "--nts-topbar-bg": "rgba(11, 13, 24, 0.44)",
    "--nts-topbar-text": "#eef0ff",
    "--nts-input-bg": "rgba(11, 13, 24, 0.42)",
    "--nts-input-text": "#eef0ff",
    "--nts-input-border": "rgba(185, 168, 255, 0.34)",
    "--nts-input-placeholder": "#9799a5",
    "--nts-button-bg": "rgba(11, 13, 24, 0.38)",
    "--nts-button-text": "#eef0ff",
    "--nts-button-hover-bg": "rgba(11, 13, 24, 0.6)",
    "--nts-send-bg": "#bbaaff",
    "--nts-send-text": "#101418",
    "--nts-user-bubble-bg": "rgba(138, 114, 232, 0.5)",
    "--nts-user-bubble-text": "#ffffff",
    "--nts-user-bubble-border": "rgba(190, 215, 255, 0.46)",
    "--nts-user-bubble-gradient": "linear-gradient(135deg, rgba(138, 114, 232, 0.5) 0%, rgba(132, 109, 223, 0.5) 100%)",
    "--nts-ai-bubble-bg": "rgba(18, 20, 31, 0.44)",
    "--nts-ai-bubble-text": "#eef0ff",
    "--nts-ai-bubble-border": "rgba(190, 215, 255, 0.46)",
    "--nts-ai-bubble-gradient": "linear-gradient(135deg, rgba(18, 20, 31, 0.44) 0%, rgba(16, 18, 28, 0.44) 100%)",
    "--nts-bubble-radius": "18px",
    "--nts-shell-radius": "22px",
    "--nts-panel-bg": "#06070d",
    "--nts-panel-text": "#eef0ff",
    "--nts-panel-text-sub": "#a3a8c8",
    "--nts-panel-border": "rgba(190, 215, 255, 0.46)",
    "--nts-panel-border-color": "rgba(190, 215, 255, 0.46)",
    "--nts-panel-border-width": "1px",
    "--nts-panel-glass-blur": "blur(25px)",
    "--nts-panel-glass-tint": "rgba(32, 42, 85, 0.13)",
    "--nts-modal-bg": "rgba(11, 13, 24, 0.97)",
    "--nts-modal-text": "#eef0ff",
    "--nts-modal-radius": "18px",
    "--nts-overlay-bg": "rgba(0, 0, 0, 0.58)",
    "--nts-popover-bg": "rgba(11, 13, 24, 0.97)",
    "--nts-popover-border": "rgba(190, 215, 255, 0.46)",
    "--nts-popover-text": "#eef0ff",
    "--nts-popover-radius": "12px",
    "--nts-card-radius": "14px",
    "--nts-rec-bg": "rgba(11, 13, 24, 0.48)",
    "--nts-rec-border": "rgba(190, 215, 255, 0.46)",
    "--nts-rec-text": "#eef0ff",
    "--nts-rec-radius": "16px",
    "--nts-chip-bg": "rgba(185, 168, 255, 0.12)",
    "--nts-chip-text": "#eef0ff",
    "--nts-status-bg": "rgba(185, 168, 255, 0.16)",
    "--nts-status-text": "#eef0ff",
    "--nts-tool-bubble-bg": "rgba(11, 13, 24, 0.42)",
    "--nts-tool-bubble-text": "#a3a8c8",
    "--nts-code-bg": "rgba(11, 13, 24, 0.46)",
    "--nts-code-text": "#d1c8ff",
    "--nts-scrollbar-track": "rgba(11, 13, 24, 0.24)",
    "--nts-scrollbar-thumb": "rgba(185, 168, 255, 0.42)",
    "--nts-glass-filter": "blur(25px) saturate(198%) brightness(107%)",
    "--nts-glass-tint": "rgba(32, 42, 85, 0.15)",
    "--nts-glass-highlight": "rgba(214, 228, 255, 0.55)",
    "--nts-bubble-glass-filter": "blur(16px) saturate(190%)",
    "--nts-bubble-glass-tint": "rgba(195, 184, 255, 0.2)",
    "--nts-panel-inner-glow": "1",
    "--nts-panel-sheen": "0.6",
    "--nts-panel-corner-glow": "0.95",
    "--nts-panel-edge-gradient": "1",
    "--nts-panel-glow-color": "rgba(159, 232, 255, 0.55)",
    "--nts-panel-glow-strength": "0.55",
    "--nts-panel-glow-size": "26px",
    "--nts-panel-glow-pulse": "1",
    "--nts-panel-glow-speed": "3.2s",
    "--nts-chat-gradient": "linear-gradient(160deg, #080a14 0%, #0b0d1a 55%, #070810 100%)",
    "--nts-panel-gradient": "linear-gradient(165deg, rgba(11, 13, 24, 0.82) 0%, rgba(28, 28, 49, 0.72) 100%)",
    "--nts-glass-rim": "rgba(190, 215, 255, 0.55)",
    "--nts-glass-sheen": "0.68",
    "--nts-glass-noise": "0.1",
    "--nts-glass-lens": "0.85",
    "--nts-glass-thickness": "0.80",
    "--nts-glass-specular": "0.85",
    "--nts-ambient-glow": "0.73",
    "--nts-glass-dispersion": "0.60",
    "--nts-glass-caustic": "0.60"
  }
}
```

## 10. 自检清单（提交前逐条过）

- [ ] JSON 能 `json.load`（双引号、无尾逗号、无注释）
- [ ] `vars` 与 `dark_vars` 的键逐字来自 §2，没有拼错一个字母
- [ ] 每个值都过 §3 语法（尤其 filter 的 `%`、gradient 的停止点 `%`）
- [ ] 亮/暗两套都写了，且暗色不是亮色的机械反色（降饱和、提对比）
- [ ] 亮暗两套 §5 全部达标（`validate_theme.py` 没有 FAIL）
- [ ] `note` 一句话说清风格，`tags` ≤4 个
- [ ] 想进「液态玻璃」分类就让 tint 半透明 + blur ≥20px（§4/§6.4）
- [ ] 想要玻璃质感就加 `materials`（`preset` + `quality` 两键起步，§12）
- [ ] `materials` 里没有 `--nts-mt-*` 键（那些是编译产物，写进去无效）

## 11. 变量影响面附录（改了会影响哪些选择器）

| 变量 | 影响面（前 4 条选择器，括号里是总数） |
| --- | --- |
| `--nts-accent` | `:focus-visible | outline-color`；`.compact-chat-surface-frame | border-color`；`#agent-content-tasks-tab | color` （共 3 条） |
| `--nts-accent-bg` | `#agent-content-tasks-tab | background-color` （共 1 条） |
| `--nts-ai-bubble-bg` | `.message.gemini | background-color`；`.message-bubble-assistant | background-color`；`.compact-export-history-message.is-assistant .compact-export-hi…`；`.compact-export-preview-message.is-assistant .compact-export-pr…` （共 4 条） |
| `--nts-ai-bubble-border` | `.message-bubble-assistant | outline-color`；`.message.gemini | outline-color`；`.compact-export-history-message.is-assistant .compact-export-hi…`；`.compact-export-preview-message.is-assistant .compact-export-pr…` （共 4 条） |
| `--nts-ai-bubble-gradient` | `.message.gemini | background-image`；`.message-bubble-assistant | background-image`；`.compact-export-history-message.is-assistant .compact-export-hi…` （共 3 条） |
| `--nts-ai-bubble-text` | `.message.gemini | color`；`.message-bubble-assistant | color`；`.message-bubble-assistant .message-block-text | color`；`.message-bubble-assistant .message-block-markdown | color` （共 28 条） |
| `--nts-bubble-glass-filter` | `.message-bubble-user | backdrop-filter`；`.message-bubble-assistant | backdrop-filter` （共 2 条） |
| `--nts-bubble-glass-tint` | `.message-bubble-user | background-color`；`.message-bubble-assistant | background-color` （共 2 条） |
| `--nts-bubble-radius` | `.message-bubble-user | border-radius`；`.message-bubble-assistant | border-radius`；`.message-bubble-tool | border-radius`；`.compact-export-history-message.is-user .compact-export-history…` （共 11 条） |
| `--nts-button-bg` | `.composer-tool-btn | background-color`；`.composer-icon-button | background-color`；`.composer-attachment-remove | background-color`；`.compact-chat-minimize-ball | background-color` （共 4 条） |
| `--nts-button-hover-bg` | `.composer-tool-btn:hover | background-color` （共 1 条） |
| `--nts-button-text` | `.composer-icon-button | color`；`.composer-overflow-btn | color`；`.composer-galgame-btn | color`；`.composer-tool-btn | color` （共 4 条） |
| `--nts-card-radius` | `.agent-plugin-view | border-radius` （共 1 条） |
| `--nts-chat-bg` | `.chat-window | background-color`；`#react-chat-window-root | background-color`；`.compact-chat-surface-frame | --compact-chat-surface-bg`；`.compact-chat-surface-frame | --compact-chat-capsule-surface-bg` （共 4 条） |
| `--nts-chat-blur` | `.window-topbar | backdrop-filter`；`.composer-icon-button | backdrop-filter`；`.composer-overflow-popover | backdrop-filter`；`.compact-export-history-bubble | backdrop-filter` （共 5 条） |
| `--nts-chat-gradient` | `.chat-body | background-image`；`.message-list | background-image` （共 2 条） |
| `--nts-chat-panel-bg` | `.chat-body | background-color`；`.message-list | background-color`；`.compact-chat-surface-frame | background-color` （共 3 条） |
| `--nts-chat-panel-radius` | `.compact-export-history-scroll | border-radius`；`.compact-export-history-scroll-content | border-radius`；`.message-list | border-radius`；`.chat-body | border-radius` （共 4 条） |
| `--nts-chip-bg` | `.composer-visit-bar-badge | background-color`；`.composer-galgame-option | background-color`；`.system-chip | background-color` （共 3 条） |
| `--nts-chip-text` | `.composer-visit-bar-badge | color`；`.composer-visit-bar-action | color`；`.composer-galgame-option | color`；`.system-chip | color` （共 4 条） |
| `--nts-code-bg` | `.message-markdown-inline-code | background-color`；`.message-markdown-pre | background-color` （共 2 条） |
| `--nts-code-text` | `.message-markdown-inline-code | color`；`.message-markdown-pre | color` （共 2 条） |
| `--nts-font-size` | `.message-block-markdown | font-size`；`.message-block-text | font-size`；`.message-block-text-plain | font-size` （共 3 条） |
| `--nts-glass-filter` | `.window-topbar | backdrop-filter`；`.composer-input-shell | backdrop-filter`；`.compact-chat-surface-frame | backdrop-filter`；`.composer-icon-button | backdrop-filter` （共 5 条） |
| `--nts-glass-highlight` | `.window-topbar | outline-color`；`.composer-input-shell | outline-color`；`.compact-chat-surface-frame | outline-color`；`.composer-icon-button | outline-color` （共 4 条） |
| `--nts-glass-tint` | `.window-topbar | background-color`；`.composer-input-shell | background-color`；`.compact-chat-surface-frame | background-color`；`.composer-icon-button | background-color` （共 5 条） |
| `--nts-highlight` | `::selection | background-color` （共 1 条） |
| `--nts-image-bg` | `.message-block-image | background-color` （共 1 条） |
| `--nts-input-bg` | `#text-input-area | background-color`；`.compact-chat-surface-frame | background-color`；`.composer-input-shell | background-color` （共 3 条） |
| `--nts-input-border` | `#text-input-area | border-top-color`；`.composer-input-shell | border-top-color` （共 2 条） |
| `--nts-input-placeholder` | `.composer-input::placeholder | color` （共 1 条） |
| `--nts-input-text` | `.composer-input | color` （共 1 条） |
| `--nts-link` | `.message-block-markdown a | color`；`a | color` （共 2 条） |
| `--nts-modal-bg` | `.modal-dialog | background-color` （共 1 条） |
| `--nts-modal-radius` | `.modal-dialog | border-radius` （共 1 条） |
| `--nts-modal-text` | `.modal-dialog | color`；`.modal-title | color` （共 2 条） |
| `--nts-overlay-bg` | `.modal-overlay | background-color` （共 1 条） |
| `--nts-panel-bg` | `.composer-panel | background-color` （共 1 条） |
| `--nts-panel-gradient` | `.compact-chat-surface-frame | background-image` （共 1 条） |
| `--nts-panel-text` | `.composer-visit-bar | color` （共 1 条） |
| `--nts-popover-bg` | `.composer-overflow-popover | background-color`；`.composer-overflow-popover | background-color` （共 2 条） |
| `--nts-popover-border` | `.composer-overflow-popover | border-top-color` （共 1 条） |
| `--nts-popover-radius` | `.composer-overflow-popover | border-radius` （共 1 条） |
| `--nts-popover-text` | `.composer-overflow-popover | color` （共 1 条） |
| `--nts-radius` | `.composer-icon-button | border-radius`；`.composer-panel | border-radius`；`.composer-galgame-option | border-radius`；`.message-block | border-radius` （共 5 条） |
| `--nts-rec-bg` | `.proactive-recommendation-card | background-color`；`.music-recommendation-icon | background-color` （共 2 条） |
| `--nts-rec-border` | `.proactive-recommendation-card | border-color` （共 1 条） |
| `--nts-rec-radius` | `.proactive-recommendation-card | border-radius` （共 1 条） |
| `--nts-rec-text` | `.proactive-recommendation-bubble | color` （共 1 条） |
| `--nts-send-bg` | `.send-button-circle | background-color`；`#sendButton | background-color`；`#textSendButton | background-color` （共 3 条） |
| `--nts-send-text` | `#sendButton | color`；`.compact-input-tool-toggle | color` （共 2 条） |
| `--nts-shadow` | `.composer-panel | box-shadow`；`.composer-overflow-popover | box-shadow`；`.composer-overflow-popover | box-shadow`；`.modal-dialog | box-shadow` （共 8 条） |
| `--nts-shell-radius` | `#react-chat-window-shell | border-radius` （共 1 条） |
| `--nts-status-bg` | `.message-block-status.tone-info | background-color`；`.message-block-status.tone-success | background-color`；`.message-block-status.tone-warning | background-color`；`.message-block-status.tone-error | background-color` （共 4 条） |
| `--nts-status-text` | `.message-block-status.tone-info | color`；`.message-block-status.tone-success | color`；`.message-block-status.tone-warning | color`；`.message-block-status.tone-error | color` （共 4 条） |
| `--nts-tool-bubble-bg` | `.message-bubble-tool | background-color`；`.message-bubble-system | background-color`；`.compact-export-history-message.is-visit-peer .compact-export-h…`；`.compact-export-history-message.is-system .compact-export-histo…` （共 6 条） |
| `--nts-tool-bubble-text` | `.message-bubble-tool | color`；`.message-bubble-system | color`；`.message-bubble-tool .message-block-text | color`；`.message-bubble-tool .message-block-markdown | color` （共 18 条） |
| `--nts-topbar-bg` | `.window-topbar | background-color` （共 1 条） |
| `--nts-topbar-text` | `.window-topbar | color`；`.window-title | color` （共 2 条） |
| `--nts-user-bubble-bg` | `.message.user | background-color`；`.message-bubble-user | background-color`；`.compact-export-history-message.is-user .compact-export-history…`；`.compact-export-preview-message.is-user .compact-export-preview…` （共 4 条） |
| `--nts-user-bubble-border` | `.message-bubble-user | outline-color`；`.message.user | outline-color`；`.compact-export-history-message.is-user .compact-export-history…`；`.compact-export-preview-message.is-user .compact-export-preview…` （共 4 条） |
| `--nts-user-bubble-gradient` | `.message.user | background-image`；`.message-bubble-user | background-image`；`.compact-export-history-message.is-user .compact-export-history…` （共 3 条） |
| `--nts-user-bubble-text` | `.message.user | color`；`.message-bubble-user | color`；`.message-bubble-user .message-block-text | color`；`.message-bubble-user .message-block-text-plain | color` （共 25 条） |

## 12. 高级材质（materials，0.15 起）

### 12.0 一句话

调色板（§2）管颜色，`materials` 管玻璃的物理质感：透明度、模糊、染色、边缘光、
折射色散、液态漂移、噪点、圆角、阴影、交互反馈。两者是并列子树，互不占用字段。

### 12.1 最小写法（推荐）

```json
{
  "name": "霜玻璃",
  "vars": {"--nts-chat-bg": "#0f1621", "--nts-accent": "#63a6ff"},
  "materials": {"enabled": true, "preset": "frosted", "quality": "balanced"}
}
```

每套预设自带完整五节参数（90 项），所以只写 `preset` + `quality` 就能得到一整套效果，
不会出现「切换后某些项还停在上一套的值上」。想微调再补个别键（键名见仓库
`PARAMETER-REFERENCE.md` §8.1，或面板 `material_spec` 返回的参数表）。

### 12.2 七套预设

| id | 观感 | 适合 |
| --- | --- | --- |
| `clear` | 几乎不染色、低模糊 | 干净通透，配浅色壁纸 |
| `frosted` | 中等模糊 + 淡白染料 | 最常见的毛玻璃，通用 |
| `liquid` | 强边缘光 + 双向色散 + 环带随指针 + 慢速漂移 | 苹果液态玻璃（画质建议 `ultra`） |
| `smoke` | 高底色不透明度 + 大模糊 + 低压暗 | 夜间、深色壁纸 |
| `soft` | 低对比、低饱和、大圆角 | 柔和、护眼 |
| `prism` | 最强色散与饱和度 | 虹彩、炫技 |
| `custom` | 参数默认值 | 从零手调，或想清空预设痕迹 |

### 12.3 四档画质

| id | 代价 | 效果 |
| --- | --- | --- |
| `saver` | 最省 | 模糊减半、阴影减薄、动态层全关；高频小元素不声明背景模糊 |
| `balanced` | 基准 | 不动 |
| `high` | 略高 | 环境反射/内部高光/边缘光更亮，阴影更薄 |
| `ultra` | 最高 | 在 high 基础上再加强 alpha 与模糊 |

### 12.4 组件级覆盖（可选）

```json
{
  "name": "自定义气泡",
  "vars": {"--nts-chat-bg": "#0f1621"},
  "materials": {
    "enabled": true, "preset": "frosted",
    "components": {"bubble": {"mode": "custom", "opacity": 0.32, "blur": 8}}
  }
}
```

组件 id：`chat` / `bubble` / `input` / `sidebar` / `topbar` / `settings` / `dialog` /
`button` / `plugin` / `menu`；五项可覆盖 `opacity` / `blur` / `radius` / `borderWidth` /
`shadowStrength`。没写的组件一律回退全局材质，组件之间不会互相覆盖。

### 12.5 不要这么写

- 把材质参数写进 `vars`：`--nts-mt-*` 是后端编译产物，不是输入，写进去会被静默忽略
- 忘写 "enabled": true：整套材质不生效（默认 enabled 为 false）
- `preset` 拼错（例如 `liquid-glass`）：不会报错，但会退化成 `custom`（参数默认值）
- 手搓全部 90 个参数：容易漏项、也容易和预设打架；先选预设，再补想改的那几个


