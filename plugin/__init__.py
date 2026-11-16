"""neko_theme_studio —— N.E.K.O 主题工坊插件。

职责（见 theme-studio/THEME_CONTRACT.md）：

1. 保管一份「调色板」JSON（``static/theme.json``），它是应用侧加载器
   （``resources/bin/static/neko-theme-studio.js``）唯一读取的数据源。
2. 提供 entry 供静态面板（``static/index.html`` + ``static/app.js``）读取 /
   修改 / 重置 / 导出 / 导入这份调色板，并支持「主题仓库」（保存 / 切换 /
   删除 / 打分享包）与聊天背景图上传。
3. **服务端校验是安全边界**：面板是跨源 iframe，所有输入都不可信。任何
   不合规的变量名或值都必须被拒绝，且绝不落盘。

文件位置：``static/theme.json`` 必须与面板同目录 —— 因为 48916 只把
``/plugin/<id>/ui/*`` 映射到插件的 ``static/``，加载器正是从那里取数据。
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import threading
import urllib.parse
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

from plugin.sdk.plugin import (
    Err,
    NekoPluginBase,
    Ok,
    SdkError,
    lifecycle,
    neko_plugin,
    plugin_entry,
    tr,
    ui,
)

# 应用侧自愈补丁：让「装上插件就能用」成立，不需要任何人手工跑 install.ps1。
# 插件被宿主以 plugin.plugins.neko_theme_studio 的形式导入，也可能被当成独立模块
# 载入（测试/构建工具），两条路径都要能取到。
try:  # pragma: no cover - 取决于宿主导入方式
    from . import _app_patch
except ImportError:  # pragma: no cover
    try:
        import _app_patch  # type: ignore[no-redef]
    except ImportError:  # pragma: no cover - 极端情况下退化为「无补丁」
        _app_patch = None  # type: ignore[assignment]

# --------------------------------------------------------------------------- 常量

SCHEMA_VERSION = 1
DEFAULT_THEME_NAME = "默认"

#: 写文件的全局锁。宿主可能并发调用 entry（面板点击 + 轮询 + 生命周期），
#: 必须串行化「读 → 合并 → 原子替换」整段，否则会丢更新。
_WRITE_LOCK = threading.Lock()

#: 变量名前缀与形态（契约 §3）。
RE_VAR_NAME = re.compile(r"^--nts-[a-z0-9-]{1,60}$")

#: 已知变量白名单 —— **形式合法不等于有意义**。
#:
#: 缺了这道门会出现「报成功的静默空操作」：``apply_theme`` 传入一个拼错的变量名
#: （例如 ``--nts-nope-var``）时，后端照收、写进 theme.json、回显为已接受，
#: 但 ``neko-theme-studio.css`` 里没有任何规则消费它，用户看不到任何变化。
#: 独立验证者实测确认过这一点。
#:
#: 清单来源 = ``tools/gen-css.js`` 实际产出的样式表里出现过的全部 ``--nts-*``
#: （可用 ``build/vars.json`` 交叉核对：CSS 消费 59 个 = 本集合）。
#: 新增变量的顺序：先在 ``test/targets.js`` 加目标 → 跑 ``tools/build-theme-css.ps1``
#: → 把生成 CSS 里新出现的名字加到这里与面板 CATALOG。
KNOWN_VARS = frozenset(
    {
        "--nts-accent",
        "--nts-accent-bg",
        "--nts-ai-bubble-bg",
        "--nts-ai-bubble-border",
        "--nts-ai-bubble-text",
        "--nts-bubble-radius",
        "--nts-bubble-veil",
        "--nts-chat-bg-image-brightness",
        "--nts-chat-top-fade",
        "--nts-button-bg",
        "--nts-button-hover-bg",
        "--nts-button-text",
        "--nts-card-radius",
        "--nts-chat-bg",
        "--nts-chat-bg-image",
        "--nts-chat-blur",
        "--nts-chat-opacity",
        "--nts-chat-panel-bg",
        "--nts-chat-panel-radius",
        "--nts-chip-bg",
        "--nts-chip-text",
        "--nts-code-bg",
        "--nts-code-text",
        "--nts-font-family",
        "--nts-font-size",
        "--nts-highlight",
        "--nts-image-bg",
        "--nts-input-bg",
        "--nts-input-border",
        "--nts-input-placeholder",
        "--nts-input-text",
        "--nts-link",
        "--nts-modal-bg",
        "--nts-modal-radius",
        "--nts-modal-text",
        "--nts-overlay-bg",
        "--nts-panel-bg",
        "--nts-panel-border-color",
        "--nts-panel-border-width",
        "--nts-panel-corner-glow",
        "--nts-panel-edge-gradient",
        "--nts-panel-glass-blur",
        "--nts-panel-glass-tint",
        "--nts-panel-glow-color",
        "--nts-panel-glow-pulse",
        "--nts-panel-glow-size",
        "--nts-panel-glow-speed",
        "--nts-panel-glow-strength",
        "--nts-panel-inner-glow",
        "--nts-panel-sheen",
        "--nts-panel-border",
        "--nts-panel-text",
        "--nts-panel-text-sub",
        "--nts-popover-bg",
        "--nts-popover-border",
        "--nts-popover-radius",
        "--nts-popover-text",
        "--nts-radius",
        "--nts-rec-bg",
        "--nts-rec-border",
        "--nts-rec-radius",
        "--nts-rec-text",
        "--nts-scrollbar-thumb",
        "--nts-scrollbar-track",
        "--nts-send-bg",
        "--nts-send-text",
        "--nts-shadow",
        "--nts-shell-radius",
        "--nts-status-bg",
        "--nts-status-text",
        "--nts-tool-bubble-bg",
        "--nts-tool-bubble-text",
        "--nts-topbar-bg",
        "--nts-topbar-text",
        "--nts-user-bubble-bg",
        "--nts-user-bubble-border",
        "--nts-user-bubble-text",
    }
)

#: 允许的颜色值形态。刻意保守：整串锚定，杜绝把任意 CSS 注入变量。
RE_HEX = re.compile(
    r"^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$", re.IGNORECASE
)
RE_RGB = re.compile(
    r"^rgba?\(\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}"
    r"\s*(?:,\s*(?:0|1|0?\.[0-9]+)\s*)?\)$",
    re.IGNORECASE,
)
RE_HSL = re.compile(
    r"^hsla?\(\s*-?[0-9]{1,3}(?:\.[0-9]+)?\s*,"
    r"\s*[0-9]{1,3}(?:\.[0-9]+)?%\s*,"
    r"\s*[0-9]{1,3}(?:\.[0-9]+)?%\s*"
    r"(?:,\s*(?:0|1|0?\.[0-9]+)\s*)?\)$",
    re.IGNORECASE,
)
#: CSS 命名颜色（规范里的 148 个）加上 currentcolor。
#: 刻意**不**收 inherit / initial / unset / revert —— 它们把颜色继承成父级，
#: 会让「只改气泡文字色」串到别处去。
RE_KEYWORD_COLOR = re.compile(
    r"^(?:transparent|aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|currentcolor|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen)$",
    re.IGNORECASE,
)

#: 非颜色项：长度 / 百分比。
RE_LENGTH = re.compile(r"^-?[0-9]{1,4}(?:\.[0-9]+)?(?:px|rem|em|%|pt|vh|vw)$", re.IGNORECASE)
RE_PERCENT = re.compile(r"^[0-9]{1,3}(?:\.[0-9]+)?%$")
RE_ZERO = re.compile(r"^0$")

#: 透明度类（0–1 或百分比）。
RE_NUMBER = re.compile(r"^(?:0|1|0?\.[0-9]+|1\.0+)$")  # 放行 1.0 / 1.00 写法

#: 时间值（v0.1.11，呼吸节奏）。接受 ``3s`` / ``1.5s`` / ``800ms``，也接受裸数字
#: （按秒解释，``3`` = ``3s``）。上限 60s：再长用户在面板上试不出来，而且
#: 一个无限循环的 60s 动画已经足够"没有动作感"，没有实际意义。
RE_TIME = re.compile(r"^(?:(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?(?:s|ms))$", re.IGNORECASE)
RE_TIME_BARE = re.compile(r"^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,3})?$")
TIME_MAX_SECONDS = 60.0

#: 字体名白名单：字母数字、中日文、空格、逗号、引号、连字符、下划线、点。
RE_FONT = re.compile(r"^[A-Za-z0-9\u4e00-\u9fff ,'\"\-_.]{1,200}$")

#: 明确拒绝的危险片段。注意这里**不**禁用圆括号 —— rgb()/hsl() 合法值本身
#: 需要括号，安全性由上面每个 kind 的「整串锚定」正则保证。
RE_FORBIDDEN = re.compile(r"[;{}<>\\]|@import|url\s*\(", re.IGNORECASE)

#: 长度/百分比语义的变量。
#:
#: 分区圆角（``--nts-bubble-radius`` 等 6 个）与 ``--nts-radius`` 是**并列**的独立
#: 旋钮，不是别名：``neko-theme-studio.css`` 为每个区域单独生成声明，且每个变量
#: 都带自己的原生回退值（气泡 16px/8px、外壳 14px、卡片 0px、弹窗 0px、浮层 12px、
#: 推荐卡 18px）。因此留空即完全保持原生外观 —— 把它们纳入白名单不会破坏
#: 契约 §9.3 的「未配置零变化」。
LENGTH_VARS = frozenset(
    {
        "--nts-radius",
        "--nts-font-size",
        "--nts-bubble-radius",
        "--nts-shell-radius",
        "--nts-card-radius",
        "--nts-modal-radius",
        "--nts-popover-radius",
        "--nts-rec-radius",
        "--nts-chat-panel-radius",
    }
)
#: ``--nts-chat-blur`` 在契约 §3 里写作「px」，但 ``neko-theme-studio.css`` 实际
#: 把它的原生值写成 ``blur(18px)`` 并直接喂给 ``backdrop-filter``：
#:   ``backdrop-filter: var(--nts-chat-blur, blur(18px))``
#: 若只写 ``18px``，backdrop-filter 会因语法非法被整条丢弃 → 毛玻璃消失，
#: 且**没有任何报错**。这里两种写法都接受，并由面板统一输出 ``blur(...)``。
BLUR_VARS = frozenset({
    "--nts-chat-blur",
    "--nts-panel-glass-blur",
})
RE_BLUR = re.compile(r"^blur\(\s*-?[0-9]{1,4}(?:\.[0-9]+)?(?:px|rem|em|pt)\s*\)$", re.IGNORECASE)
#: 裸长度里对 blur 合法的写法。``blur()`` 只接受绝对长度，``%``/``vh``/``vw``
#: 会被 ``backdrop-filter`` 整条丢弃；而 ``RE_LENGTH`` 为了 shadow 偏移量必须放行它们，
#: 所以这里单列一个更严的正则，避免 ``blur(18%)`` 这种「校验通过、CSS 无效」的产物。
RE_BLUR_BARE = re.compile(r"^-?[0-9]{1,4}(?:\.[0-9]+)?(?:px|rem|em|pt)$", re.IGNORECASE)
#: 面板边缘光效 / 玻璃拟态（v0.1.11）。
#:
#: 这是一组**纯装饰**变量，全部可选；留空则整块 CSS 不加载，外观与原生完全一致
#: （契约「未配置零变化」仍然成立）。挂载点由 targets.js 的 NTS_GLOW 定义：
#:
#:   * 外发光 / 边缘光晕  → .compact-export-history-anchor::before
#:     （不能挂在 .compact-export-history-scroll 上：它自带 mask-image，
#:      实测外发光只能透出 4 个像素，用整图差分验证过）
#:   * 描边 / 四角高光 / 反射高光 / 内阴影 → .compact-export-history-anchor::after
#:   * 磨砂层（模糊背景图本身）→ .compact-export-history-scroll::before，z-index:-1
#:     挂到 ::after 会盖住消息文字，挂到 backdrop-filter 又糊不到画在自身上的
#:     背景图；负 z 层恰好夹在「容器背景」与「消息内容」之间
#:     （实测：图片清晰度 -62%、文字清晰度 -1%）
GLOW_COLOR_VARS = frozenset(
    {
        "--nts-panel-glow-color",
        "--nts-panel-border-color",
        "--nts-panel-glass-tint",
    }
)

#: 0–1 乘子。与 ``--nts-bubble-veil`` 同理，做成连续量而不是布尔开关：
#: 用户可以要「一点点光」，且值非法时表现为回到原生（而不是变成全亮/全黑）。
GLOW_AMOUNT_VARS = frozenset(
    {
        "--nts-panel-glow-strength",
        "--nts-panel-glow-pulse",
        "--nts-panel-corner-glow",
        "--nts-panel-edge-gradient",
        "--nts-panel-sheen",
        "--nts-panel-inner-glow",
    }
)

#: 长度类：光晕扩散半径、描边宽度。
GLOW_LENGTH_VARS = frozenset(
    {
        "--nts-panel-glow-size",
        "--nts-panel-border-width",
    }
)

#: 时间类：呼吸周期。单位接受 s / ms；不带单位一律按秒（``3`` = ``3s``）。
TIME_VARS = frozenset({"--nts-panel-glow-speed"})

#: 阴影变量：契约 §3 列为非颜色项，但真正需要的是一个 box-shadow 串，
#: 因此按 token 逐项校验（长度 / 安全颜色 / inset），而不是当成单一长度。
SHADOW_VARS = frozenset({"--nts-shadow"})
#: 字体变量。
FONT_VARS = frozenset({"--nts-font-family"})
#: 透明度变量（契约 §3 列为非颜色项，但既非长度也非字体）。
#: ``--nts-bubble-veil`` 是「聊天背景上那层虚化」的总开关：0 = 完全清透（关掉白纱
#: 与背景模糊），1 = 应用原生观感（半透明白纱 + backdrop blur）。它是一个 0–1 的
#: 乘子，由 CSS 的 ``calc()`` 同时乘进 alpha 与 blur 半径 —— 见 gen-css.js 的
#: bubble veil 段。之所以做成乘子而不是布尔开关：乘子取值连续，用户可以要
#: 「一半虚化」，且值非法时整条声明失效的表现是"回到原生"而不是"变成全透明"。
NUMBER_VARS = frozenset({
    "--nts-chat-opacity",
    "--nts-bubble-veil",
    "--nts-chat-bg-image-brightness",
    "--nts-chat-top-fade",
})

#: ``import_theme`` 接受的 JSON 文本上限（与 input_schema 的 ``maxLength`` 同源）。
#: input_schema 只是给宿主的声明，宿主不保证强制执行，因此代码里必须自己兜底。
IMPORT_MAX_CHARS = 262144

#: 面板 / 加载器读取本插件的基址。面板本身就从这里被服务，背景图 URL 必须写成
#: 绝对地址 —— 消费方是应用窗口（源 48911），相对路径会解析到应用自己的静态目录。
PLUGIN_BASE_URL = os.environ.get("NTS_PLUGIN_BASE", "http://127.0.0.1:48916").rstrip("/")

#: 主题仓库（``static/themes/<id>.json``）与背景图（``static/backgrounds/<hash>.<ext>``）
#: 都放在 ``static/`` 下，因为 48916 只把 ``/plugin/<id>/ui/*`` 映射到这里 —— 背景图
#: 必须能被应用窗口直接 GET 到。
LIBRARY_DIR_NAME = "themes"
BACKGROUND_DIR_NAME = "backgrounds"

#: 内置主题（随插件一起发布，用户不能删除）：``static/presets/<id>.json``。
#: 格式与仓库条目一致，另外带 ``"builtin": true``。里面的背景图写成**可移植**的
#: ``url("images/<hash>.<ext>")``，读出来时再改写成这台机器上的绝对 URL ——
#: 否则一份预设换台机器就指向了别人的端口。图片本体放在
#: ``static/backgrounds/<hash>.<ext>``（与用户上传的是同一个目录、同一套命名）。
PRESET_DIR_NAME = "presets"

#: 分享包（zip）与图片的体积上限。压缩包是**别人给的**文件，必须按不可信输入处理。
ARCHIVE_MAX_BYTES = 8 * 1024 * 1024
IMAGE_MAX_BYTES = 4 * 1024 * 1024
ARCHIVE_MAX_ENTRIES = 300
ARCHIVE_MAX_UNCOMPRESSED = 24 * 1024 * 1024
LIBRARY_MAX_ITEMS = 200
#: box-shadow 允许用逗号叠多层（霓虹/发光主题常见写法：两层不同颜色的光晕）。
#: 早先三处校验器都只认单层，把含逗号的值整串拒掉 —— 用户从别处拿到的主题
#: 一应用就少一条 `--nts-shadow`，还没人告诉他为什么。这里统一放开到 4 层。
SHADOW_MAX_LAYERS = 4

#: 分享包里的说明文件（纯文本，方便别人拿到 zip 后知道怎么用）。
ARCHIVE_README = (
    "N.E.K.O 主题工坊 · 主题分享包\n"
    "\n"
    "theme.json 是调色板；images/ 里是与它配套的背景图。\n"
    "用法：打开 插件 → 主题工坊 → 主题仓库 → 导入压缩包，选择本文件即可。\n"
    "导入只会把主题存进仓库，不会立刻改动你当前的配色；在仓库里点「应用」才切换。\n"
)

#: 主题仓库条目 id：服务端生成，绝不采用上传文件名（否则就是路径穿越入口）。
RE_THEME_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
#: 背景图文件名：服务端按内容哈希生成。
RE_BG_NAME = re.compile(r"^[a-z0-9]{8,32}\.(?:png|jpg|jpeg|webp|gif)$")
# 从 theme.json / 仓库条目的原始文本里捞背景图引用（孤儿回收用）。
#: 两处引用都要认：theme.json / 仓库条目写的是 ``backgrounds/<name>``，
#: 而内置主题里是可移植写法 ``images/<name>``。早先只匹配前者，结果插件一启动
#: 就把「只被内置主题引用」的图片当孤儿删掉 —— 预设点开就没有背景图了。
RE_BG_REF_TEXT = re.compile(
    r"(?:backgrounds|images)/([a-z0-9]{8,32}\.(?:png|jpg|jpeg|webp|gif))"
)
#: 背景图变量（值只有两种合法形态：``none`` 或指向本插件 backgrounds/ 的 url()）。
IMAGE_VARS = frozenset({"--nts-chat-bg-image"})
#: 值里抓文件名（兼容 ``url("images/x.png")`` 与绝对地址两种写法）。
RE_BG_VALUE_CAPTURE = re.compile(r"/backgrounds/([A-Za-z0-9._-]{1,80})")
RE_URL_ANY = re.compile(r'url\(\s*"?([^")\s]+)"?\s*\)')
#: 绝对地址或裸路径都接受，但必须是本插件的 backgrounds/ 目录。
RE_BG_URL = re.compile(
    r'^url\(\s*"?(?:https?://(?:127\.0\.0\.1|localhost):[0-9]{2,5})?'
    r"/plugin/neko_theme_studio/ui/backgrounds/[A-Za-z0-9._-]{1,80}"
    r'"?\s*\)$'
)
#: 图片判定（魔数优先，扩展名只用于分享包内文件筛选）。
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def _image_extension(data: bytes) -> str:
    """按魔数判定图片格式；不认识返回空串（绝不按文件扩展名信任内容）。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return ""


def _clip_name(value: Any, fallback: str) -> str:
    """主题名规整：去首尾空白、截 60 字、空则用 fallback。"""
    if isinstance(value, str) and value.strip():
        return value.strip()[:60]
    return fallback


def _fmt_saved_at(value: Any) -> str:
    """``2026-11-15T14:02:11+08:00`` → ``2026-11-15 14:02:11``（面板展示用）。"""
    if isinstance(value, str) and value.strip():
        return value.strip().replace("T", " ")[:19]
    return "—"


def _safe_archive_name(name: str) -> str:
    """把主题名变成安全的下载文件名（去掉路径分隔符与 Windows 非法字符）。"""
    cleaned = re.sub(r'[\\/:*?"<>|\s]+', "-", name or "").strip("-")
    return cleaned[:40] or "theme"


# --------------------------------------------------------------------------- 默认调色板

def _default_vars() -> dict[str, str]:
    """亮色（``:root``）默认值 —— **空**，这是刻意的。

    契约 §9.3 要求「未配置时视觉零变化」。而 ``neko-theme-studio.css`` 里
    同一条变量在不同规则上带着**不同**的原生回退值，例如：

    - ``--nts-radius``: ``border-radius: var(--nts-radius, 0|8px|10px|12px)``
      （topbar 是 0，卡片/面板是 12px，按钮/发送键是 10px）
    - ``--nts-input-bg``: ``#text-input-area`` 回退 ``rgba(40,40,40,0.65)``，
      而 ``.composer-input`` 回退 ``transparent``

    一旦在 ``:root`` 里钉住任一值，所有这些规则都会被同一个值覆盖 ——
    也就是「没配主题却看得到变化」，直接违反 §9.3。应用侧加载器同样把空
    调色板理解为「恢复原样」（``neko-theme-studio.js``：空 vars ⇒ removeStyle）。

    因此出厂调色板是空的；完整变量目录 + 原生参考值放在面板 ``static/app.js``
    的 CATALOG 里（面板默认显示原生值，仅在用户真正改动某一行时才写入该行）。
    """
    return {}


def _default_dark_vars() -> dict[str, str]:
    """暗色（``:root[data-theme="dark"]``）默认值 —— 同样为空，理由见上。"""
    return {}


def _now_iso() -> str:
    """本地时区 ISO-8601，例如 ``2026-11-07T16:00:00+08:00``。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def default_palette() -> dict[str, Any]:
    """内置默认调色板（``reset_theme`` 与首次落盘都用它）。"""
    return {
        "schema": SCHEMA_VERSION,
        "name": DEFAULT_THEME_NAME,
        "enabled": True,
        "updated_at": _now_iso(),
        "vars": _default_vars(),
        "dark_vars": _default_dark_vars(),
    }


# --------------------------------------------------------------------------- 校验

def _value_kind(name: str) -> str:
    # 光效 / 玻璃拟态一组：必须在默认 "color" 之前判掉，
    # 否则 0-1 乘子和长度值会被当颜色、整条被拒。
    if name in GLOW_AMOUNT_VARS:
        return "number"
    if name in GLOW_LENGTH_VARS:
        return "length"
    if name in TIME_VARS:
        return "time"
    if name in IMAGE_VARS:
        return "image"
    if name in LENGTH_VARS:
        return "length"
    if name in BLUR_VARS:
        return "blur"
    if name in SHADOW_VARS:
        return "shadow"
    if name in FONT_VARS:
        return "font"
    if name in NUMBER_VARS:
        return "number"
    return "color"


def _shadow_tokens(value: str) -> list[str]:
    """按「括号外空白」切分阴影串；括号不配对则返回空列表。"""
    tokens: list[str] = []
    depth = 0
    buf = ""
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return []
        if ch.isspace() and depth == 0:
            if buf:
                tokens.append(buf)
                buf = ""
            continue
        buf += ch
    if buf:
        tokens.append(buf)
    if depth != 0:
        return []
    return tokens


def _split_shadow_layers(value: str) -> list:
    """按「顶层逗号」把多层 box-shadow 切成单层；括号不配对返回空列表。

    ``0 0 20px rgba(0,0,0,.4), 0 0 15px rgba(179,136,255,.5)``
    → 两层。不能直接 ``value.split(",")``：颜色是 ``rgba(0, 0, 0, .4)``，
    里面全是逗号。
    """
    layers: list = []
    depth = 0
    buf = ""
    for ch in value:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                return []
        if ch == "," and depth == 0:
            if buf.strip():
                layers.append(buf.strip())
            buf = ""
            continue
        buf += ch
    if depth != 0:
        return []
    if buf.strip():
        layers.append(buf.strip())
    return layers


def _shadow_layer_ok(tokens: list) -> bool:
    """单层 box-shadow 的 token 校验（原本内联在 ``_is_safe_value`` 里）。"""
    if not tokens or len(tokens) > 6:
        return False
    lengths = 0
    colors = 0
    insets = 0
    for token in tokens:
        if token.lower() == "inset":
            insets += 1
            if insets > 1:
                return False
            continue
        if (
            RE_KEYWORD_COLOR.match(token)
            or RE_HEX.match(token)
            or RE_RGB.match(token)
            or RE_HSL.match(token)
        ):
            colors += 1
            if colors > 1:
                return False
            continue
        if RE_PERCENT.match(token) or "%" in token:
            return False
        if RE_LENGTH.match(token) or RE_ZERO.match(token):
            lengths += 1
            if lengths > 4:
                return False
            # 负值只允许前两个长度（x/y 偏移）；模糊/扩散半径不能为负
            if token.startswith("-") and lengths > 2:
                return False
            continue
        return False
    return lengths >= 2


def _is_safe_value(name: str, value: Any) -> bool:
    """值是否可安全写进给定变量（整串匹配，不允许任何附加内容）。"""
    if not isinstance(value, str):
        return False
    v = value.strip()
    if not v or len(v) > 300:
        return False

    kind = _value_kind(name)
    if kind == "image":
        # 背景图的值本身就是 url(...)，必须跳过 RE_FORBIDDEN 的 url( 拦截，
        # 改由 RE_BG_URL 整串锚定（只允许本插件 backgrounds/ 目录里的文件）。
        return v.lower() == "none" or bool(RE_BG_URL.match(v))
    if RE_FORBIDDEN.search(v):
        return False
    if kind == "color":
        return bool(
            RE_KEYWORD_COLOR.match(v)
            or RE_HEX.match(v)
            or RE_RGB.match(v)
            or RE_HSL.match(v)
        )
    if kind == "length":
        # 负长度在 CSS 里一律非法（``border-radius`` / ``font-size`` 收到负值会把整条
        # 声明丢掉 → 面板报成功、外观不变）。RE_LENGTH 为了 shadow 的偏移量必须允许
        # 负号，而 shadow 走的是自己的 token 分支，所以在这里单独拦住即可。
        if "-" in v:
            return False
        return bool(RE_LENGTH.match(v) or RE_PERCENT.match(v) or RE_ZERO.match(v))
    if kind == "blur":
        # 同时接受 `blur(18px)`（CSS 能用的形态）与裸长度 `18px`（契约 §3 的写法），
        # 裸长度稍后会被规范化为 blur(...)。
        # 负半径会让 ``backdrop-filter`` 整条失效（静默无变化），而模糊值永远用不到负号。
        if "-" in v:
            return False
        # 只收绝对长度：blur(18%) / blur(18vw) 不是合法 CSS，放行就会落盘一个
        # loader 必丢的值（面板报成功、外观不变）。
        return bool(RE_BLUR.match(v) or RE_BLUR_BARE.match(v) or RE_ZERO.match(v))
    if kind == "time":
        # 呼吸周期。裸数字按秒解释；带单位时换算成秒再卡上限。
        # 只收 s / ms 两种单位：呼吸节奏用不到别的，放宽只会放出无效 CSS。
        if RE_TIME.match(v):
            unit = v[-2:].lower()
            try:
                seconds = float(v[:-2]) / 1000.0 if unit == "ms" else float(v[:-1])
            except ValueError:  # pragma: no cover — RE_TIME 已保证是数字
                return False
            return 0.0 <= seconds <= TIME_MAX_SECONDS
        if RE_TIME_BARE.match(v):
            return float(v) <= TIME_MAX_SECONDS
        return False
    if kind == "number":
        # 契约语义是 0–1 的小数；百分比是面板的友好写法，但只有 0%–100% 有意义
        # （999% 归一后 >1，loader 会丢弃 → 又变成「能存不能用」）。
        if RE_NUMBER.match(v):
            return True
        if not RE_PERCENT.match(v):
            return False
        try:
            return float(v[:-1]) <= 100.0
        except ValueError:  # pragma: no cover — RE_PERCENT 已保证是数字
            return False
    if kind == "font":
        return bool(RE_FONT.match(v))
    if kind == "shadow":
        # box-shadow 的 CSS 语法是 inset? && <length>{2,4} && <color>?。
        # 只做 token 白名单会放行 0 0 10% #000（百分比不是 box-shadow 的合法长度）、
        # 1px（长度不足）、1px 2px 3px 4px 5px（长度过多）——浏览器会把整条声明丢掉，
        # 面板却显示已应用（与「改了没反应」同症状）。
        # 面板 isSafeShadow / loader isSafeValue 必须逐条同判定（THEME_CONTRACT 9.10b）。
        layers = _split_shadow_layers(v)
        if not layers or len(layers) > SHADOW_MAX_LAYERS:
            return False
        return all(
            _shadow_layer_ok(_shadow_tokens(layer)) for layer in layers
        )
    return False


def _canonicalize_value(name: str, value: str) -> str:
    """把通过校验的值规范化成 CSS 真正需要的形态。

    两处：

    - ``--nts-chat-blur``：消费方是
      ``backdrop-filter: var(--nts-chat-blur, blur(18px))``，因此裸长度
      ``18px`` 必须补成 ``blur(18px)``，否则整条声明被浏览器丢弃。
    - ``--nts-chat-opacity``：契约语义是 0–1 的小数，而面板允许用户写
      ``50%``。这里统一归一成小数（四舍五入到 4 位、去尾零），使 theme.json
      里永远是 loader 能直接消费的形态 —— 否则 loader 会把百分比静默丢弃，
      用户看到「面板说成功、透明度没变」。
    - ``--nts-panel-glow-speed``（v0.1.11）：面板允许只敲 ``3``，这里补成
      ``3s``。CSS 的 ``animation-duration: 3`` 是非法值（时长必须带单位），
      不补的话整条 animation 声明会被丢弃 → 用户看到「节奏填了但不动」。
    """
    if name in BLUR_VARS and RE_BLUR_BARE.match(value):
        return f"blur({value})"
    if name in TIME_VARS and RE_TIME_BARE.match(value):
        return f"{value}s"
    if name in NUMBER_VARS and value.endswith("%"):
        try:
            fraction = round(float(value[:-1]) / 100.0, 4)
        except ValueError:  # pragma: no cover — 校验阶段已保证是数字
            return value
        text = f"{fraction:.4f}".rstrip("0").rstrip(".")
        return text or "0"
    return value


def _validate_palette(
    vars_in: Any, dark_in: Any
) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """校验并过滤两组变量。

    :returns: ``(clean_vars, clean_dark, errors)`` —— clean 字典是**唯一**
        允许落盘的内容；errors 是给用户看的拒绝原因列表。
    """
    clean_vars: dict[str, str] = {}
    clean_dark: dict[str, str] = {}
    errors: list[str] = []

    for label, src, out in (("vars", vars_in, clean_vars), ("dark_vars", dark_in, clean_dark)):
        if src is None:
            continue
        if not isinstance(src, dict):
            errors.append(f"{label}: 必须是对象")
            continue
        for raw_name, raw_value in src.items():
            name = str(raw_name)
            if not RE_VAR_NAME.match(name):
                errors.append(f"{label}: 变量名非法已拒绝 {name!r}")
                continue
            if name not in KNOWN_VARS:
                # 形式合法但没有规则消费 → 必须报错。否则「报成功的静默空操作」
                # 会让用户以为改成功了（独立验证者实测过 --nts-nope-var）。
                errors.append(
                    f"{label}: 未知变量名已拒绝 {name!r}（拼写错误？见 README 变量清单）"
                )
                continue
            if raw_value is None:
                # 显式置空 = 删除该键（回退到 N.E.K.O 原生值）。
                continue
            if not isinstance(raw_value, str):
                errors.append(f"{label}: {name} 的值必须是字符串")
                continue
            value = raw_value.strip()
            if not value:
                # 空串 = 删除该键（面板的「清空」语义）。
                continue
            if not _is_safe_value(name, value):
                errors.append(f"{label}: {name} 的值非法已拒绝 {value!r}")
                continue
            out[name] = _canonicalize_value(name, value)

    return clean_vars, clean_dark, errors


_TRUE_WORDS = frozenset({"true", "1", "yes", "on"})
_FALSE_WORDS = frozenset({"false", "0", "no", "off"})


def _coerce_bool(value: Any) -> bool | None:
    """把「布尔语义」的值规整成 bool；无法判定时返回 ``None``。

    存在的理由：theme.json 可能被手工编辑成 ``"enabled": "false"``，而
    ``bool("false")`` 是 True —— 那会把用户关掉的主题静默重新启用。
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, float):
        return None if value != value else bool(value)  # NaN → 无法判定
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in _TRUE_WORDS:
            return True
        if lowered in _FALSE_WORDS:
            return False
    return None


class _ThemeUnreadable(RuntimeError):
    """theme.json 存在但读不出来（权限 / 被占用 / JSON 损坏）。

    写路径遇到它必须中止：若像读路径那样退回 ``default_palette()``，一次瞬时
    读取失败（Windows 上杀毒软件或索引器锁文件即可触发）就会把用户已保存的
    全部变量抹掉、只剩本次新值，而且返回 Ok。
    """


# --------------------------------------------------------------------------- 插件

@neko_plugin
class NekoThemeStudioPlugin(NekoPluginBase):
    """主题工坊：调色板的唯一权威保管者。"""

    def __init__(self, ctx: Any) -> None:
        super().__init__(ctx)
        try:
            self.logger = self.enable_file_logging(log_level="INFO")
        except Exception:  # noqa: BLE001 — 文件日志不可用不应阻止插件启动
            self.logger = getattr(ctx, "logger", None)

        self.plugin_root = Path(__file__).resolve().parent
        self.static_dir = self.plugin_root / "static"
        self.theme_path = self.static_dir / "theme.json"
        #: 最近一次应用侧自愈补丁的诊断结果（startup 或 repair 入口写入）。
        self._app_patch_result: dict[str, Any] = {}

    # ------------------------------------------------------------- 内部工具

    def _log(self, level: str, message: str) -> None:
        logger = getattr(self, "logger", None)
        fn = getattr(logger, level, None)
        if callable(fn):
            try:
                fn(message)
            except Exception:  # noqa: BLE001
                pass

    def _normalize(self, raw: Any) -> dict[str, Any]:
        """把任意来源的数据规整成合法调色板；坏数据一律回退默认值。"""
        base = default_palette()
        if not isinstance(raw, dict):
            return base

        # 老版本的 theme.json 里可能有 "version" 计数字段：这里刻意忽略它，
        # 下次落盘时自然消失（schema 未变，读旧文件不会报错）。
        name = raw.get("name")
        name = str(name) if isinstance(name, str) and name.strip() else base["name"]

        updated_at = raw.get("updated_at")
        updated_at = (
            str(updated_at)
            if isinstance(updated_at, str) and updated_at.strip()
            else base["updated_at"]
        )

        # 磁盘上的内容也要过滤：文件可能被手工编辑或被其它程序写坏。
        clean_vars, clean_dark, errors = _validate_palette(
            raw.get("vars"), raw.get("dark_vars")
        )
        for message in errors:
            self._log("warning", f"theme.json 中被忽略的条目 —— {message}")

        # 不能直接 bool(...)：字符串 "false" 是真值，会把用户关掉的主题静默重开。
        raw_enabled = raw.get("enabled", True)
        enabled = _coerce_bool(raw_enabled)
        if enabled is None:
            self._log("warning", f"theme.json 的 enabled 无法解析（{raw_enabled!r}），按启用处理")
            enabled = True

        return {
            "schema": SCHEMA_VERSION,
            "name": name,
            "enabled": enabled,
            "updated_at": updated_at,
            "vars": clean_vars,
            "dark_vars": clean_dark,
        }

    def _read_unlocked(self, *, strict: bool = False) -> dict[str, Any]:
        """读盘。文件缺失/损坏/权限错误 → 默认值，绝不抛异常。

        :param strict: 给**写路径**用。文件存在却读不出来时抛 ``_ThemeUnreadable``
            而不是退回默认值 —— 默认值只适合「首次运行」，把它当成合并基线
            会静默清空用户已保存的变量（见 ``_ThemeUnreadable`` 的说明）。
            文件确实不存在时两条路径都返回默认值（首次运行的正常情形）。
        """
        try:
            text = self.theme_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return default_palette()
        except OSError as exc:
            if strict:
                raise _ThemeUnreadable(f"读取 theme.json 失败：{exc}") from exc
            self._log("warning", f"读取 theme.json 失败，使用默认值：{exc}")
            return default_palette()
        try:
            return self._normalize(json.loads(text))
        except (ValueError, TypeError) as exc:
            if strict:
                raise _ThemeUnreadable(f"theme.json 解析失败：{exc}") from exc
            self._log("warning", f"theme.json 解析失败，使用默认值：{exc}")
            return default_palette()

    def _write_unlocked(self, palette: dict[str, Any]) -> None:
        """原子写：同目录临时文件 → ``os.replace``。

        同目录是硬要求，否则 ``os.replace`` 可能跨卷失败（非原子）。
        """
        self.static_dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(palette, ensure_ascii=False, indent=2, sort_keys=False)
        tmp_path = self.static_dir / f".theme.json.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, self.theme_path)
        finally:
            # 替换成功后 tmp 已不存在；失败路径必须自己清理。
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except OSError:
                pass

    def _ensure_file(self) -> None:
        """启动时保证 ``static/theme.json`` 存在（内容不合法则备份后重写为默认）。"""
        with _WRITE_LOCK:
            if not self.theme_path.exists():
                self._write_unlocked(default_palette())
                self._log("info", f"已创建默认调色板：{self.theme_path}")
                return
            try:
                text = self.theme_path.read_text(encoding="utf-8")
                json.loads(text)
            except OSError as exc:
                # 「读不出来」（被占用 / 权限）≠「内容坏了」：绝不能拿默认值覆盖，
                # 否则一次瞬时占用就把用户的主题毁掉。保持原样，下次启动再试。
                self._log("warning", f"theme.json 暂时不可读（{exc}），保持原样")
                return
            except ValueError as exc:
                # 内容确实坏了：先把原文件留档再写默认值，不静默销毁用户数据。
                backup = self.theme_path.with_name(self.theme_path.name + ".corrupt")
                try:
                    os.replace(self.theme_path, backup)
                    self._log(
                        "warning",
                        f"theme.json 解析失败（{exc}），原文件已备份为 {backup.name}",
                    )
                except OSError as move_exc:  # pragma: no cover — 备份失败也不阻止恢复
                    self._log(
                        "warning",
                        f"theme.json 解析失败（{exc}），备份失败（{move_exc}）",
                    )
                self._write_unlocked(default_palette())

    def _apply_and_store(
        self,
        *,
        vars_in: Any = None,
        dark_in: Any = None,
        name: Any = None,
        enabled: Any = None,
    ) -> tuple[dict[str, Any], list[str], int]:
        """合并 → 校验 → 原子写。返回 (新调色板, 拒绝原因, 被接受的输入字段数)。

        第三个返回值让调用方能区分「全被拒」与「部分成功」：前者应该报失败，
        否则调用方只看 status 会误以为写进去了（实际磁盘一个字节都没变）。
        """
        with _WRITE_LOCK:
            # strict：拿不到真实基线就中止，绝不用默认值覆盖用户已保存的调色板。
            palette = self._read_unlocked(strict=True)

            merged_vars = dict(palette["vars"])
            merged_dark = dict(palette["dark_vars"])

            clean_vars, clean_dark, errors = _validate_palette(vars_in, dark_in)

            # 删除语义：显式传空串 / None = 回退到 N.E.K.O 原生值。
            # 注意：**被拒绝**的值不会走到这里（它既不在 clean 里，也不是空值），
            # 因此旧值会被原样保留 —— 一次误输入不会毁掉已有的好值。
            for source, merged in ((vars_in, merged_vars), (dark_in, merged_dark)):
                if not isinstance(source, dict):
                    continue
                for raw_name, raw_value in source.items():
                    key = str(raw_name)
                    if not RE_VAR_NAME.match(key):
                        continue
                    if raw_value is None or (
                        isinstance(raw_value, str) and not raw_value.strip()
                    ):
                        merged.pop(key, None)
            merged_vars.update(clean_vars)
            merged_dark.update(clean_dark)

            palette["vars"] = merged_vars
            palette["dark_vars"] = merged_dark

            # 有几个输入字段真的被接受了。静默丢弃（不在 KNOWN_VARS、值非法）
            # 的条目不计数 —— 它们既没生效也不该被视为成功。
            accepted = len(clean_vars) + len(clean_dark)

            if isinstance(name, str):
                # 传空串/纯空白 = 恢复默认名（面板清空输入框时走这条），不是错误。
                palette["name"] = name.strip()[:60] or DEFAULT_THEME_NAME
                accepted += 1
            elif name is not None:
                errors.append(f"name: 必须是字符串，收到 {type(name).__name__}")

            if enabled is not None:
                coerced = _coerce_bool(enabled)
                if coerced is None:
                    errors.append(f"enabled: 无法解析为布尔值 {enabled!r}")
                else:
                    palette["enabled"] = coerced
                    accepted += 1

            palette["updated_at"] = _now_iso()
            palette["schema"] = SCHEMA_VERSION

            self._write_unlocked(palette)
            return palette, errors, accepted

    # ------------------------------------------------------------- 生命周期

    @lifecycle(id="startup")
    async def startup(self, **_):
        self._ensure_file()
        self._ensure_dirs()
        palette = self._read_unlocked()
        # 回收没人引用的背景图。失败绝不影响启动。
        try:
            self._gc_backgrounds()
        except Exception as exc:  # noqa: BLE001
            self._log("warning", f"背景图回收失败（忽略）：{exc}")
        self._log(
            "info",
            "neko_theme_studio 已启动，调色板 "
            f"({len(palette['vars'])} 亮色 / {len(palette['dark_vars'])} 暗色变量)",
        )
        # 应用侧自愈：把 loader 两件套 + 模板标记装上/刷新。
        # 这一步是「装上插件就能用」的全部秘密 —— 宿主没有注入 API，只能靠它
        # 把 resources/bin/static 与 templates 的两行标签准备好。
        # 失败绝不影响启动（ensure_app_patch 内部吞掉一切异常）。
        patch = self._run_app_patch()
        return Ok(
            {
                "status": "ready",
                "theme_path": str(self.theme_path),
                "app_patch": patch,
            }
        )

    def _run_app_patch(self) -> dict[str, Any]:
        """跑一次应用侧自愈补丁，返回诊断摘要（绝不抛异常）。"""
        if _app_patch is None:  # pragma: no cover - 极端情况
            self._log("warning", "应用侧补丁模块缺失（_app_patch.py），主题可能无法生效")
            return {"ok": False, "warnings": ["_app_patch 模块不可用"]}
        try:
            result = _app_patch.ensure_app_patch(self.plugin_root, self._log)
        except Exception as exc:  # noqa: BLE001 —— 兜底，模块内部已吞异常
            self._log("warning", f"应用侧补丁异常（已忽略）：{exc}")
            return {"ok": False, "warnings": [str(exc)]}
        for warning in result.get("warnings", []):
            self._log("warning", warning)
        self._app_patch_result = result
        return result

    @lifecycle(id="shutdown")
    def shutdown(self, **_):
        self._log("info", "neko_theme_studio 已停止")
        return Ok({"status": "shutdown"})

    # ------------------------------------------------------------- UI context

    @ui.context(id="dashboard", title=tr("plugin.name", default="主题工坊"))
    async def studio_context(self) -> dict[str, Any]:
        palette = self._read_unlocked()
        return {
            "name": palette["name"],
            "enabled": palette["enabled"],
            "updated_at": palette["updated_at"],
            "var_count": len(palette["vars"]),
            "dark_count": len(palette["dark_vars"]),
            "theme_url": f"/plugin/{self.plugin_id}/ui/theme.json",
            "app_patch": getattr(self, "_app_patch_result", {}) or {},
            "actions": [
                {"id": "get_theme", "entry_id": "get_theme"},
                {"id": "apply_theme", "entry_id": "apply_theme"},
                {"id": "reset_theme", "entry_id": "reset_theme"},
                {"id": "export_theme", "entry_id": "export_theme"},
                {"id": "import_theme", "entry_id": "import_theme"},
                {"id": "list_themes", "entry_id": "list_themes"},
                {"id": "save_theme", "entry_id": "save_theme"},
                {"id": "apply_saved_theme", "entry_id": "apply_saved_theme"},
                {"id": "delete_theme", "entry_id": "delete_theme"},
                {"id": "import_theme_archive", "entry_id": "import_theme_archive"},
                {"id": "export_theme_archive", "entry_id": "export_theme_archive"},
                {"id": "import_background", "entry_id": "import_background"},
            ],
        }

    # ------------------------------------------------------------- entries

    @plugin_entry(
        id="repair_app",
        name=tr("entries.repair_app.name", default="修复应用侧集成"),
        description=tr(
            "entries.repair_app.description",
            default="重新把主题 loader 与模板标记装进 N.E.K.O 安装目录（应用更新/删除文件后可手动重跑）。",
        ),
        input_schema={"type": "object", "properties": {}},
    )
    async def repair_app(self, **_):
        result = self._run_app_patch()
        return Ok(result)

    @plugin_entry(
        id="get_theme",
        name=tr("entries.get_theme.name", default="读取当前主题"),
        description=tr(
            "entries.get_theme.description",
            default="返回当前调色板：亮色变量、暗色变量、名称与启用状态。",
        ),
        input_schema={"type": "object", "properties": {}},
    )
    async def get_theme(self, **_):
        try:
            return Ok(self._read_unlocked())
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"读取主题失败：{exc}"))

    @plugin_entry(
        id="apply_theme",
        name=tr("entries.apply_theme.name", default="应用主题"),
        description=tr(
            "entries.apply_theme.description",
            default="把给定的 CSS 变量合并进当前调色板并原子写入 theme.json。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "vars": {"type": "object", "description": "亮色变量表 --nts-* → 值"},
                "dark_vars": {"type": "object", "description": "暗色变量表 --nts-* → 值"},
                "name": {"type": "string", "maxLength": 60},
                "enabled": {"type": "boolean", "default": True},
            },
        },
    )
    async def apply_theme(
        self,
        vars: Any = None,  # noqa: A002 — 名称与契约 input_schema 一致
        dark_vars: Any = None,
        name: Any = None,
        enabled: Any = None,
        **_,
    ):
        try:
            palette, errors, accepted = self._apply_and_store(
                vars_in=vars, dark_in=dark_vars, name=name, enabled=enabled
            )
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"写入主题失败：{exc}"))

        gave_input = any(x is not None for x in (vars, dark_vars, name, enabled))

        if errors:
            # 合法部分已落盘；把被拒绝的条目如实回传给面板展示。
            self._log("warning", f"apply_theme 拒绝 {len(errors)} 条：{errors[:3]}")
            if gave_input and accepted == 0:
                # 一项都没被接受 = 这次调用什么也没做，必须报失败，
                # 否则调用方只看 status 会以为写成功了。
                return Err(SdkError("没有写入任何改动：" + "；".join(errors)))
            return Ok({**palette, "rejected": errors})
        return Ok(palette)

    @plugin_entry(
        id="reset_theme",
        name=tr("entries.reset_theme.name", default="恢复默认主题"),
        description=tr(
            "entries.reset_theme.description",
            default="把内置默认调色板写回 theme.json（清空所有自定义颜色）。",
        ),
        input_schema={"type": "object", "properties": {}},
    )
    async def reset_theme(self, **_):
        try:
            with _WRITE_LOCK:
                palette = default_palette()
                palette["updated_at"] = _now_iso()
                self._write_unlocked(palette)
            return Ok(palette)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"恢复默认主题失败：{exc}"))

    @plugin_entry(
        id="export_theme",
        name=tr("entries.export_theme.name", default="导出主题"),
        description=tr(
            "entries.export_theme.description",
            default="把当前调色板序列化为 JSON 文本，供用户复制保存或分享。",
        ),
        input_schema={"type": "object", "properties": {}},
    )
    async def export_theme(self, **_):
        try:
            palette = self._read_unlocked()
            payload = json.dumps(palette, ensure_ascii=False, indent=2, sort_keys=False)
            return Ok(
                {
                    "payload": payload,
                    "name": palette["name"],
                    "updated_at": palette["updated_at"],
                }
            )
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"导出主题失败：{exc}"))

    @plugin_entry(
        id="import_theme",
        name=tr("entries.import_theme.name", default="导入主题"),
        description=tr(
            "entries.import_theme.description",
            default="解析并校验一段调色板 JSON 文本，合法后整体应用（非法条目一律丢弃）。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "payload": {
                    "type": "string",
                    "minLength": 2,
                    "maxLength": IMPORT_MAX_CHARS,
                    "description": "调色板 JSON 文本",
                }
            },
            "required": ["payload"],
        },
    )
    async def import_theme(self, payload: str = "", **_):
        if not isinstance(payload, str):
            return Err(SdkError(f"导入内容必须是字符串，收到 {type(payload).__name__}。"))
        text = payload.strip()
        if not text:
            return Err(SdkError("导入内容为空。"))
        if len(text) > IMPORT_MAX_CHARS:
            # input_schema 的 maxLength 只是声明，宿主不一定执行 → 自己兜底。
            return Err(
                SdkError(f"导入内容过长（{len(text)} 字符，上限 {IMPORT_MAX_CHARS}）。")
            )

        try:
            parsed = json.loads(text)
        except (ValueError, TypeError) as exc:
            return Err(SdkError(f"导入内容不是合法 JSON：{exc}"))
        if not isinstance(parsed, dict):
            return Err(SdkError("导入内容必须是一个 JSON 对象。"))

        payload_vars = parsed.get("vars")
        payload_dark = parsed.get("dark_vars")
        if not isinstance(payload_vars, dict) and not isinstance(payload_dark, dict):
            return Err(SdkError("导入内容缺少 vars / dark_vars 字段。"))

        # 导入是「整体替换」而非合并：先清空再写入合法子集。
        try:
            with _WRITE_LOCK:
                palette = self._read_unlocked()
                clean_vars, clean_dark, errors = _validate_palette(payload_vars, payload_dark)

                # 同 apply_saved_theme：丢掉指向已删除图片的引用。
                clean_vars, gone_light = self._without_missing_images(clean_vars)
                clean_dark, gone_dark = self._without_missing_images(clean_dark)
                for gone in (gone_light, gone_dark):
                    for key in gone:
                        errors = list(errors) + [
                            f"{key}: 引用的背景图已不存在，已回退原生"
                        ]

                palette["vars"] = clean_vars
                palette["dark_vars"] = clean_dark

                name = parsed.get("name")
                if isinstance(name, str) and name.strip():
                    palette["name"] = name.strip()[:60]
                if isinstance(parsed.get("enabled"), bool):
                    palette["enabled"] = bool(parsed["enabled"])

                palette["updated_at"] = _now_iso()
                palette["schema"] = SCHEMA_VERSION

                self._write_unlocked(palette)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"导入主题失败：{exc}"))

        if errors:
            self._log("warning", f"import_theme 拒绝 {len(errors)} 条：{errors[:3]}")
            return Ok({**palette, "rejected": errors})
        return Ok(palette)

    # ------------------------------------------------------- 主题仓库 / 背景图

    def _library_dir(self) -> Path:
        return self.static_dir / LIBRARY_DIR_NAME

    def _backgrounds_dir(self) -> Path:
        return self.static_dir / BACKGROUND_DIR_NAME

    def _presets_dir(self) -> Path:
        """内置主题目录（随插件发布，只读）。"""
        return self.static_dir / PRESET_DIR_NAME

    def _preset_path(self, theme_id: str) -> Path:
        return self._presets_dir() / f"{theme_id}.json"

    def _ensure_dirs(self) -> None:
        """确保 themes/ 与 backgrounds/ 存在（插件启动时调用一次）。"""
        for path in (
            self.static_dir,
            self._library_dir(),
            self._backgrounds_dir(),
            self._presets_dir(),
        ):
            try:
                path.mkdir(parents=True, exist_ok=True)
            except OSError as exc:  # pragma: no cover — 磁盘异常不该让 entry 崩掉
                self._log("warning", f"创建目录失败 {path}：{exc}")

    def _background_url(self, filename: str) -> str:
        return (
            f"{PLUGIN_BASE_URL}/plugin/{self.plugin_id}/ui/"
            f"{BACKGROUND_DIR_NAME}/{filename}"
        )

    @staticmethod
    def _image_filename_in_value(value: Any) -> str:
        """从 ``url("…/backgrounds/<name>")`` 里取出文件名；不是图片值返回空串。"""
        if not isinstance(value, str):
            return ""
        match = RE_BG_VALUE_CAPTURE.search(value)
        return match.group(1) if match else ""

    def _image_refs(self, mapping: Any) -> list:
        """``[(变量名, 背景图文件名)]`` —— 只保留磁盘上真的存在的文件。"""
        refs = []
        if not isinstance(mapping, dict):
            return refs
        for key, value in mapping.items():
            name = self._image_filename_in_value(value)
            if not name or not RE_BG_NAME.match(name):
                continue
            if not (self._backgrounds_dir() / name).is_file():
                continue
            refs.append((str(key), name))
        return refs

    def _without_missing_images(self, mapping: Any) -> tuple:
        """丢掉引用了「磁盘上已不存在」的背景图的变量。

        返回 ``(clean, dropped_keys)``。把一张已经被删掉的图片 URL 留在
        theme.json 里，只会让应用侧请求 404，而且 ``has_image`` 会自相矛盾地
        说没有 —— 所以写入前就把它摘掉（= 回退原生）。
        """
        if not isinstance(mapping, dict):
            return {}, []
        clean = {}
        dropped = []
        for key, value in mapping.items():
            name = self._image_filename_in_value(value)
            if name and RE_BG_NAME.match(name) and not (
                self._backgrounds_dir() / name
            ).is_file():
                dropped.append(str(key))
                continue
            clean[key] = value
        return clean, dropped

    def _gc_backgrounds(self) -> list:
        """删掉没被 theme.json / 任何仓库条目引用的背景图，返回删掉的文件名。

        每次上传都按内容哈希落一个文件，用户删主题、导入失败都会留下孤儿图。
        这里用**原始文本**扫引用（而不是校验后的 vars），避免把「变量非法但
        文件仍是用户资产」的图片误删。
        """
        bg_dir = self._backgrounds_dir()
        if not bg_dir.is_dir():
            return []
        texts = []
        try:
            texts.append(self.theme_path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass
        for directory in (self._library_dir(), self._presets_dir()):
            if not directory.is_dir():
                continue
            for item in directory.glob("*.json"):
                try:
                    texts.append(item.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    continue
        referenced = set()
        for text in texts:
            referenced.update(RE_BG_REF_TEXT.findall(text))
        removed = []
        for path in bg_dir.iterdir():
            if not path.is_file() or path.name in referenced:
                continue
            if not RE_BG_NAME.match(path.name):
                continue
            try:
                path.unlink()
                removed.append(path.name)
            except OSError:
                continue
        if removed:
            self._log("info", f"回收了 {len(removed)} 张没被引用的背景图")
        return removed

    def _save_background_bytes(self, data: bytes, *, label: str = "") -> str:
        """校验魔数后落盘一张背景图，返回文件名（``<hash16>.<ext>``）。"""
        if not data:
            raise SdkError("图片内容为空。")
        if len(data) > IMAGE_MAX_BYTES:
            raise SdkError(
                f"图片过大（{len(data)} 字节，上限 {IMAGE_MAX_BYTES} 字节）。"
            )
        ext = _image_extension(data)
        if not ext:
            raise SdkError("不支持的图片格式（只接受 png / jpg / webp / gif）。")
        filename = f"{hashlib.sha256(data).hexdigest()[:16]}.{ext}"
        self._ensure_dirs()
        target = self._backgrounds_dir() / filename
        try:
            if not target.is_file() or target.stat().st_size != len(data):
                tmp = target.with_name(target.name + ".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, target)
        except OSError as exc:
            raise SdkError(f"保存图片失败：{exc}") from exc
        self._log("info", f"背景图已保存：{filename}（{len(data)} 字节）{label}")
        return filename

    # ------------------------------------------------------------- 仓库读写

    def _library_items(self) -> list:
        """仓库条目列表（按保存时间倒序）；坏文件跳过并记日志。"""
        directory = self._library_dir()
        items = []
        if not directory.is_dir():
            return items
        for path in directory.glob("*.json"):
            if not RE_THEME_ID.match(path.stem):
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError) as exc:
                self._log("warning", f"仓库条目已损坏，跳过 {path.name}：{exc}")
                continue
            if not isinstance(raw, dict):
                continue
            clean_vars, clean_dark, errors = _validate_palette(
                raw.get("vars"), raw.get("dark_vars")
            )
            if errors:
                self._log("warning", f"仓库条目 {path.name} 有 {len(errors)} 条被忽略")
            items.append(
                {
                    "id": path.stem,
                    "name": _clip_name(raw.get("name"), path.stem),
                    "saved_at": _fmt_saved_at(raw.get("saved_at")),
                    "light": len(clean_vars),
                    "dark": len(clean_dark),
                    "has_image": bool(
                        self._image_refs(clean_vars)
                        or self._image_refs(clean_dark)
                    ),
                    "builtin": False,
                    "_sort": str(raw.get("saved_at") or ""),
                }
            )
        items.sort(key=lambda item: item["_sort"], reverse=True)
        for item in items:
            item.pop("_sort", None)
        return items

    def _preset_items(self) -> list:
        """内置主题列表（随插件发布、只读），格式与仓库条目一致。

        预设里的背景图写的是可移植的 ``url("images/<hash>")``，而 ``_validate_palette``
        只接受指向本机 ``backgrounds/`` 的绝对地址 —— 所以先用
        ``_rewrite_archive_refs`` 改写成本机地址再校验，否则那条变量会被判非法、
        条目上「含背景图」也会谎报 False。
        """
        directory = self._presets_dir()
        items = []
        if not directory.is_dir():
            return items
        for path in sorted(directory.glob("*.json")):
            if not RE_THEME_ID.match(path.stem):
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError) as exc:
                self._log("warning", f"内置主题已损坏，跳过 {path.name}：{exc}")
                continue
            if not isinstance(raw, dict):
                continue
            local = self._rewrite_archive_refs(
                raw, {}, label=f"内置主题 {path.stem}", from_presets=True
            )
            clean_vars, clean_dark, errors = _validate_palette(
                local.get("vars"), local.get("dark_vars")
            )
            if errors:
                self._log("warning", f"内置主题 {path.name} 有 {len(errors)} 条被忽略")
            items.append(
                {
                    "id": path.stem,
                    "name": _clip_name(raw.get("name"), path.stem),
                    "saved_at": "内置",
                    "light": len(clean_vars),
                    "dark": len(clean_dark),
                    "has_image": bool(
                        self._image_refs(clean_vars)
                        or self._image_refs(clean_dark)
                    ),
                    "builtin": True,
                }
            )
        return items

    def _load_library_item(self, theme_id: Any) -> dict:
        if not isinstance(theme_id, str) or not RE_THEME_ID.match(theme_id.strip()):
            raise SdkError("主题仓库条目 id 非法。")
        clean_id = theme_id.strip()
        path = self._library_dir() / f"{clean_id}.json"
        if not path.is_file():
            # 仓库里没有就再看内置主题 —— 内置主题与应用/导出走同一条路径。
            preset = self._preset_path(clean_id)
            if preset.is_file():
                path = preset
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise SdkError(f"主题仓库里没有这个主题：{theme_id}") from exc
        except OSError as exc:
            raise SdkError(f"读取主题仓库条目失败：{exc}") from exc
        except (ValueError, TypeError) as exc:
            raise SdkError(f"主题仓库条目已损坏：{exc}") from exc
        if not isinstance(raw, dict):
            raise SdkError("主题仓库条目格式不正确。")
        return raw

    def _save_library_item(self, *, name: Any, vars_map: dict, dark_map: dict) -> dict:
        """写一个新仓库条目；id 由服务端按「名称 slug + 时间戳」生成。"""
        self._ensure_dirs()
        directory = self._library_dir()
        if len(list(directory.glob("*.json"))) >= LIBRARY_MAX_ITEMS:
            raise SdkError(
                f"主题仓库已满（上限 {LIBRARY_MAX_ITEMS} 个），请先删除一些再保存。"
            )
        label = _clip_name(name, DEFAULT_THEME_NAME)
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "theme"
        base = f"{slug[:32]}-{datetime.now().strftime('%Y%m%d%H%M%S')}"
        theme_id = base
        counter = 2
        while (directory / f"{theme_id}.json").exists():
            theme_id = f"{base}-{counter}"
            counter += 1
        record = {
            "schema": SCHEMA_VERSION,
            "id": theme_id,
            "name": label,
            "saved_at": _now_iso(),
            "vars": dict(vars_map),
            "dark_vars": dict(dark_map),
        }
        path = directory / f"{theme_id}.json"
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(tmp, path)
        return record

    @staticmethod
    def _theme_summary(
        record: dict, *, light: int, dark: int, has_image: bool
    ) -> dict:
        return {
            "id": str(record.get("id") or ""),
            "name": _clip_name(record.get("name"), DEFAULT_THEME_NAME),
            "saved_at": _fmt_saved_at(record.get("saved_at")),
            "light": light,
            "dark": dark,
            "has_image": has_image,
        }

    # --------------------------------------------------- 分享包（zip）导入导出

    def _build_archive(
        self, *, name: str, vars_map: dict, dark_map: dict
    ) -> tuple:
        """打分享包：``theme.json``（图片引用改写成 ``images/<name>``）+ ``images/``。"""
        refs = self._image_refs(vars_map) + self._image_refs(dark_map)

        def portable(value: Any) -> Any:
            filename = self._image_filename_in_value(value)
            return f'url("images/{filename}")' if filename else value

        record = {
            "schema": SCHEMA_VERSION,
            "name": name,
            "saved_at": _now_iso(),
            "vars": {key: portable(value) for key, value in vars_map.items()},
            "dark_vars": {key: portable(value) for key, value in dark_map.items()},
        }
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "theme.json", json.dumps(record, ensure_ascii=False, indent=2)
            )
            archive.writestr("README.txt", ARCHIVE_README)
            for filename in sorted({item[1] for item in refs}):
                path = self._backgrounds_dir() / filename
                try:
                    archive.write(path, f"images/{filename}")
                except OSError as exc:  # pragma: no cover
                    self._log("warning", f"打包图片失败（已跳过）{filename}：{exc}")
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"{_safe_archive_name(name)}-{stamp}.zip", buffer.getvalue()

    def _rewrite_archive_refs(
        self, raw: dict, images: dict, *, label: str, from_presets: bool = False
    ) -> dict:
        """把分享包里的图片落盘到本机，并把引用改写成绝对 URL。

        ``from_presets=True`` 时，包内没带这张图会再去 ``presets/`` 里找 ——
        内置主题的图是**随插件一起发布**的，不是"缺失"，绝不能按第三方分享包
        的规则丢掉（踩过：应用一次内置主题后背景图就凭空消失，``backgrounds/``
        被判成孤儿回收，重装/重启也回不来）。
        """

        def rewrite(value: Any) -> Any:
            if not isinstance(value, str):
                return value
            match = RE_URL_ANY.search(value)
            if not match:
                return value
            basename = match.group(1).replace("\\", "/").rsplit("/", 1)[-1]
            if not basename:
                return ""
            payload = images.get(basename)
            if payload is None and from_presets:
                # 内置主题的图随插件一起发布，放在 presets/images/ 下 ——
                # 写法与分享包内部结构一致（都是 images/<hash>）。
                for shipped in (
                    self._presets_dir() / "images" / basename,
                    self._presets_dir() / basename,
                ):
                    if not shipped.is_file():
                        continue
                    try:
                        payload = shipped.read_bytes()
                    except OSError:
                        payload = None
                    else:
                        break
            if payload is None:
                # 裸 JSON 导入（或 zip 里没带这张图）时，如果本机已经有同名文件
                # —— 文件名就是内容哈希，同名必然同内容 —— 直接复用它。
                # 不这么做的话，「复制导出的 JSON 再粘贴导入」会把用户自己的背景图
                # 静默丢掉，只剩下颜色（真 bug，实测复现）。
                if RE_BG_NAME.match(basename) and (
                    self._backgrounds_dir() / basename
                ).is_file():
                    return f'url("{self._background_url(basename)}")'
                # 确实没有这张图 → 整条丢弃（= 回退原生），绝不把别人的路径写进 theme.json。
                self._log("warning", f"分享包里缺少图片 {basename}，该引用已丢弃")
                return ""
            filename = self._save_background_bytes(payload, label=label)
            return f'url("{self._background_url(filename)}")'

        vars_in = raw.get("vars")
        dark_in = raw.get("dark_vars")
        return {
            "schema": SCHEMA_VERSION,
            "name": _clip_name(raw.get("name"), DEFAULT_THEME_NAME),
            "vars": (
                {str(k): rewrite(v) for k, v in vars_in.items()}
                if isinstance(vars_in, dict)
                else {}
            ),
            "dark_vars": (
                {str(k): rewrite(v) for k, v in dark_in.items()}
                if isinstance(dark_in, dict)
                else {}
            ),
        }

    def _parse_archive(self, data: bytes, *, label: str) -> tuple:
        """解析分享包（zip 或裸 JSON），返回 ``(调色板, 来源格式)``。"""
        if len(data) > ARCHIVE_MAX_BYTES:
            raise SdkError(
                f"分享包过大（{len(data)} 字节，上限 {ARCHIVE_MAX_BYTES} 字节）。"
            )
        if data[:4] != b"PK\x03\x04":
            try:
                parsed = json.loads(data.decode("utf-8"))
            except UnicodeDecodeError as exc:
                raise SdkError("分享包既不是 zip，也不是 UTF-8 编码的 JSON。") from exc
            except (ValueError, TypeError) as exc:
                raise SdkError(f"分享包不是合法 JSON：{exc}") from exc
            if not isinstance(parsed, dict):
                raise SdkError("分享包内容必须是一个 JSON 对象。")
            return self._rewrite_archive_refs(parsed, {}, label=label), "json"

        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise SdkError("分享包不是有效的 zip 压缩包。") from exc
        with archive:
            infos = archive.infolist()
            if len(infos) > ARCHIVE_MAX_ENTRIES:
                raise SdkError(
                    f"压缩包条目过多（{len(infos)} 个，上限 {ARCHIVE_MAX_ENTRIES}）。"
                )
            total = sum(info.file_size for info in infos)
            if total > ARCHIVE_MAX_UNCOMPRESSED:
                raise SdkError(
                    "压缩包解压后过大"
                    f"（{total} 字节，上限 {ARCHIVE_MAX_UNCOMPRESSED}）。"
                )
            entries = {}
            for info in infos:
                name = info.filename.replace("\\", "/")
                if name.startswith("/") or ".." in name.split("/") or ":" in name:
                    raise SdkError(f"压缩包里含有非法路径：{name}")
                entries[name] = info.filename

            json_names = [n for n in entries if n.lower().endswith(".json")]
            json_names.sort(
                key=lambda item: (
                    0 if item.rsplit("/", 1)[-1].lower() == "theme.json" else 1,
                    item,
                )
            )
            if not json_names:
                raise SdkError(
                    "压缩包里没有 theme.json（主题分享包应包含一个 JSON 调色板）。"
                )
            try:
                parsed = json.loads(
                    archive.read(entries[json_names[0]]).decode("utf-8", "replace")
                )
            except (ValueError, TypeError) as exc:
                raise SdkError(f"压缩包里的 JSON 无法解析：{exc}") from exc
            if not isinstance(parsed, dict):
                raise SdkError("压缩包里的 JSON 必须是一个对象。")

            images = {}
            for name in entries:
                if not name.lower().endswith(IMAGE_SUFFIXES):
                    continue
                images[name.rsplit("/", 1)[-1]] = archive.read(entries[name])
            return self._rewrite_archive_refs(parsed, images, label=label), "zip"

    # ---------------------------------------------------------------- entries

    @plugin_entry(
        id="list_themes",
        name=tr("entries.list_themes.name", default="列出主题仓库"),
        description=tr(
            "entries.list_themes.description",
            default="返回主题仓库里的全部条目：名称、保存时间、亮/暗变量条数、是否含背景图。",
        ),
        input_schema={"type": "object", "properties": {}},
    )
    async def list_themes(self, **_):
        try:
            items = self._preset_items() + self._library_items()
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"列出主题仓库失败：{exc}"))
        return Ok({"count": len(items), "themes": items})

    @plugin_entry(
        id="save_theme",
        name=tr("entries.save_theme.name", default="保存到主题仓库"),
        description=tr(
            "entries.save_theme.description",
            default="把当前已保存的调色板存成一个仓库条目，便于以后一键切换或打包分享。",
        ),
        input_schema={
            "type": "object",
            "properties": {"name": {"type": "string", "maxLength": 60}},
        },
    )
    async def save_theme(self, name: Any = None, **_):
        try:
            with _WRITE_LOCK:
                palette = self._read_unlocked(strict=True)
                record = self._save_library_item(
                    name=(
                        name
                        if isinstance(name, str) and name.strip()
                        else palette["name"]
                    ),
                    vars_map=palette["vars"],
                    dark_map=palette["dark_vars"],
                )
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"保存到主题仓库失败：{exc}"))
        summary = self._theme_summary(
            record,
            light=len(record["vars"]),
            dark=len(record["dark_vars"]),
            has_image=bool(
                self._image_refs(record["vars"])
                or self._image_refs(record["dark_vars"])
            ),
        )
        self._log("info", f"已保存到主题仓库：{summary['name']}（{summary['id']}）")
        return Ok({"saved": True, "theme": summary})

    @plugin_entry(
        id="apply_saved_theme",
        name=tr("entries.apply_saved_theme.name", default="切换到仓库主题"),
        description=tr(
            "entries.apply_saved_theme.description",
            default="把仓库里某个主题整体替换为当前调色板（含背景图），并写入 theme.json。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "theme_id": {"type": "string", "maxLength": 64},
                # 面板发的是 id（更自然），CLI/脚本里常用 theme_id。两个都收，
                # 避免调用方猜参数名 —— 曾因只认 theme_id 导致面板「应用/分享/删除」
                # 全部报「条目 id 非法」。
                "id": {"type": "string", "maxLength": 64},
            },
        },
    )
    async def apply_saved_theme(self, theme_id: Any = "", id: Any = "", **_):
        theme_id = theme_id or id
        try:
            record = self._load_library_item(theme_id)
            # 内置主题的背景图是可移植写法（images/<hash>），先改成本机绝对 URL。
            local = self._rewrite_archive_refs(
                record,
                {},
                label=f"主题 {record.get('name') or theme_id}",
                from_presets=True,
            )
            record = dict(record)
            record["vars"] = local["vars"]
            record["dark_vars"] = local["dark_vars"]
            record["name"] = local["name"]
            with _WRITE_LOCK:
                palette = self._read_unlocked(strict=True)
                clean_vars, clean_dark, errors = _validate_palette(
                    record.get("vars"), record.get("dark_vars")
                )
                # 仓库条目可能引用一张后来被删掉的背景图；写进 theme.json 只会 404。
                clean_vars, gone_light = self._without_missing_images(clean_vars)
                clean_dark, gone_dark = self._without_missing_images(clean_dark)
                for gone in (gone_light, gone_dark):
                    for key in gone:
                        errors = list(errors) + [
                            f"{key}: 引用的背景图已不存在，已回退原生"
                        ]
                palette["vars"] = clean_vars
                palette["dark_vars"] = clean_dark
                palette["name"] = _clip_name(record.get("name"), palette["name"])
                palette["enabled"] = True
                palette["updated_at"] = _now_iso()
                palette["schema"] = SCHEMA_VERSION
                self._write_unlocked(palette)
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"切换主题失败：{exc}"))
        if errors:
            self._log("warning", f"apply_saved_theme 拒绝 {len(errors)} 条：{errors[:3]}")
        summary = self._theme_summary(
            record,
            light=len(clean_vars),
            dark=len(clean_dark),
            has_image=bool(
                self._image_refs(clean_vars) or self._image_refs(clean_dark)
            ),
        )
        return Ok(
            {
                "applied": True,
                "theme": summary,
                "light": len(clean_vars),
                "dark": len(clean_dark),
                "rejected": errors,
            }
        )

    @plugin_entry(
        id="delete_theme",
        name=tr("entries.delete_theme.name", default="删除仓库主题"),
        description=tr(
            "entries.delete_theme.description",
            default="从主题仓库删除一个条目（不影响当前正在使用的调色板）。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "theme_id": {"type": "string", "maxLength": 64},
                # 面板发的是 id（更自然），CLI/脚本里常用 theme_id。两个都收，
                # 避免调用方猜参数名 —— 曾因只认 theme_id 导致面板「应用/分享/删除」
                # 全部报「条目 id 非法」。
                "id": {"type": "string", "maxLength": 64},
            },
        },
    )
    async def delete_theme(self, theme_id: Any = "", id: Any = "", **_):
        theme_id = theme_id or id
        try:
            record = self._load_library_item(theme_id)
            if self._preset_path(str(record.get("id") or theme_id)).is_file():
                raise SdkError(
                    "内置主题不能删除（它随插件一起发布）。"
                    "想留下改动过的版本：先点「应用」，再「保存到仓库」另存一份。"
                )
            path = self._library_dir() / f"{record.get('id') or theme_id}.json"
            path.unlink(missing_ok=True)
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"删除仓库主题失败：{exc}"))
        return Ok({"deleted": True, "theme_id": str(theme_id)})

    @plugin_entry(
        id="import_theme_archive",
        name=tr("entries.import_theme_archive.name", default="导入主题分享包"),
        description=tr(
            "entries.import_theme_archive.description",
            default="导入主题分享包（zip：theme.json + images/，也接受裸 JSON），存进仓库。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "maxLength": 200},
                "data": {"type": "string", "description": "分享包内容的 base64"},
            },
            "required": ["data"],
        },
    )
    async def import_theme_archive(self, filename: str = "", data: str = "", **_):
        if not isinstance(data, str) or not data.strip():
            return Err(SdkError("分享包内容为空。"))
        raw = data.strip()
        if len(raw) > ARCHIVE_MAX_BYTES * 2:
            return Err(SdkError("分享包内容过大（base64 超过上限）。"))
        if raw.startswith("data:"):
            # 容忍 data URL 前缀（面板正常会剥掉，手工调用可能带）。
            _, _, raw = raw.partition(",")
        try:
            payload = base64.b64decode(raw, validate=True)
        except Exception:  # noqa: BLE001 — binascii.Error 是 ValueError 的子类
            return Err(SdkError("分享包内容不是合法的 base64。"))
        label = f"来自 {filename or '分享包'}"
        try:
            theme, source_format = self._parse_archive(payload, label=label)
            clean_vars, clean_dark, errors = _validate_palette(
                theme.get("vars"), theme.get("dark_vars")
            )
            if not clean_vars and not clean_dark:
                raise SdkError(
                    "分享包里没有可用的调色板变量（可能不是主题工坊的分享包）。"
                )
            record = self._save_library_item(
                name=theme.get("name"), vars_map=clean_vars, dark_map=clean_dark
            )
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"导入主题分享包失败：{exc}"))
        if errors:
            self._log(
                "warning", f"import_theme_archive 拒绝 {len(errors)} 条：{errors[:3]}"
            )
        summary = self._theme_summary(
            record,
            light=len(clean_vars),
            dark=len(clean_dark),
            has_image=bool(
                self._image_refs(clean_vars) or self._image_refs(clean_dark)
            ),
        )
        return Ok(
            {
                "imported": True,
                "theme": summary,
                "source_format": source_format,
                "rejected": errors,
            }
        )

    @plugin_entry(
        id="export_theme_archive",
        name=tr("entries.export_theme_archive.name", default="导出主题分享包"),
        description=tr(
            "entries.export_theme_archive.description",
            default="把仓库条目打成 zip 分享包（theme.json + images/），返回 base64 供面板下载。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "theme_id": {"type": "string", "maxLength": 64},
                # 面板发的是 id（更自然），CLI/脚本里常用 theme_id。两个都收，
                # 避免调用方猜参数名 —— 曾因只认 theme_id 导致面板「应用/分享/删除」
                # 全部报「条目 id 非法」。
                "id": {"type": "string", "maxLength": 64},
            },
        },
    )
    async def export_theme_archive(self, theme_id: Any = "", id: Any = "", **_):
        theme_id = theme_id or id
        try:
            record = self._load_library_item(theme_id)
            local = self._rewrite_archive_refs(
                record,
                {},
                label=f"主题 {record.get('name') or theme_id}",
                from_presets=True,
            )
            record = dict(record)
            record["vars"] = local["vars"]
            record["dark_vars"] = local["dark_vars"]
            record["name"] = local["name"]
            clean_vars, clean_dark, _errors = _validate_palette(
                record.get("vars"), record.get("dark_vars")
            )
            name = _clip_name(record.get("name"), DEFAULT_THEME_NAME)
            filename, payload = self._build_archive(
                name=name, vars_map=clean_vars, dark_map=clean_dark
            )
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"导出主题分享包失败：{exc}"))
        images = len(self._image_refs(clean_vars)) + len(self._image_refs(clean_dark))
        return Ok(
            {
                "filename": filename,
                "data": base64.b64encode(payload).decode("ascii"),
                "bytes": len(payload),
                "images": images,
            }
        )

    def _export_dir(self, target: str) -> Path:
        """导出目标目录。面板跑在 sandbox iframe 里，<a download> 会被静默丢弃
        （宿主 sandbox 串里没有 allow-downloads），所以文件由插件进程直接写盘。"""
        home = Path(os.path.expanduser("~"))
        if target == "downloads":
            return home / "Downloads"
        if target == "plugin":
            out = self.static_dir / "exports"
            out.mkdir(parents=True, exist_ok=True)
            return out
        # desktop：OneDrive 重定向时 ~/Desktop 可能不存在，回落 ~/OneDrive/Desktop
        for cand in (home / "Desktop", home / "OneDrive" / "Desktop", home):
            if cand.is_dir():
                return cand
        return home

    def _unique_path(self, directory: Path, filename: str) -> Path:
        """重名不覆盖，追加 -2 / -3 …；文件名只保留安全字符。"""
        stem, suffix = os.path.splitext(_safe_archive_name(filename))
        stem = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "-", stem).strip("-") or "theme"
        candidate = directory / (stem + suffix)
        n = 2
        while candidate.exists():
            candidate = directory / (f"{stem}-{n}{suffix}")
            n += 1
            if n > 500:
                raise SdkError("导出失败：同名文件太多，请先清理目录。")
        return candidate

    def _current_or_saved(self, theme_id: str):
        """theme_id 为空用当前调色板，否则用仓库/内置条目。返回 (name, vars, dark)。"""
        if theme_id:
            record = self._load_library_item(theme_id)
            local = self._rewrite_archive_refs(
                record,
                {},
                label=f"主题 {record.get('name') or theme_id}",
                from_presets=True,
            )
            clean_vars, clean_dark, _errors = _validate_palette(
                local.get("vars"), local.get("dark_vars")
            )
            return _clip_name(local.get("name"), DEFAULT_THEME_NAME), clean_vars, clean_dark
        palette = self._normalize(self._read_unlocked())
        clean_vars, clean_dark, _errors = _validate_palette(
            palette.get("vars"), palette.get("dark_vars")
        )
        return _clip_name(palette.get("name"), DEFAULT_THEME_NAME), clean_vars, clean_dark

    @plugin_entry(
        id="export_to_file",
        name=tr("entries.export_to_file.name", default="导出到文件"),
        description=tr(
            "entries.export_to_file.description",
            default="把当前主题或仓库条目写成文件（桌面 / 下载 / 插件 exports/），返回完整路径。面板在 iframe 里无法触发浏览器下载时用这条。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": ["zip", "json"]},
                "theme_id": {"type": "string", "maxLength": 64},
                "id": {"type": "string", "maxLength": 64},
                "target": {"type": "string", "enum": ["desktop", "downloads", "plugin"]},
                "name": {"type": "string", "maxLength": 60},
            },
        },
    )
    async def export_to_file(
        self,
        kind: str = "zip",
        theme_id: Any = "",
        id: Any = "",
        target: str = "desktop",
        name: str = "",
        **_,
    ):
        theme_id = theme_id or id or ""
        kind = (kind or "zip").strip().lower()
        target = (target or "desktop").strip().lower()
        if kind not in ("zip", "json"):
            return Err(SdkError(f"不支持的导出格式：{kind}（只能是 zip 或 json）。"))
        if target not in ("desktop", "downloads", "plugin"):
            return Err(SdkError(f"不支持的导出位置：{target}（只能是 desktop / downloads / plugin）。"))
        try:
            theme_name, vars_map, dark_map = self._current_or_saved(str(theme_id).strip())
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"读取主题失败：{exc}"))
        if name and name.strip():
            theme_name = _clip_name(name.strip(), theme_name)

        try:
            if kind == "zip":
                filename, payload = self._build_archive(
                    name=theme_name, vars_map=vars_map, dark_map=dark_map
                )
            else:
                doc = {
                    "schema": SCHEMA_VERSION,
                    "name": theme_name,
                    "enabled": True,
                    "updated_at": _now_iso(),
                    "vars": vars_map,
                    "dark_vars": dark_map,
                }
                payload = json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8")
                filename = f"{_safe_archive_name(theme_name)}.json"
            directory = self._export_dir(target)
            path = self._unique_path(directory, filename)
            tmp = path.with_suffix(path.suffix + ".tmp")
            tmp.write_bytes(payload)
            os.replace(tmp, path)
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"写入文件失败：{exc}"))

        result = {
            "path": str(path),
            "filename": path.name,
            "bytes": len(payload),
            "kind": kind,
            "target": target,
            "images": len(self._image_refs(vars_map)) + len(self._image_refs(dark_map)),
        }
        if target == "plugin":
            result["url"] = (
                f"{PLUGIN_BASE_URL}/plugin/{self.plugin_id}/ui/exports/"
                f"{urllib.parse.quote(path.name)}"
            )
        self._log("info", f"导出到文件 {path}（{len(payload)} 字节）")
        return Ok(result)

    @plugin_entry(
        id="import_background",
        name=tr("entries.import_background.name", default="上传聊天背景图"),
        description=tr(
            "entries.import_background.description",
            default="保存背景图到插件 static/backgrounds/，返回可写进 --nts-chat-bg-image 的绝对 URL。",
        ),
        input_schema={
            "type": "object",
            "properties": {
                "filename": {"type": "string", "maxLength": 200},
                "data": {"type": "string", "description": "图片内容的 base64"},
            },
            "required": ["data"],
        },
    )
    async def import_background(self, filename: str = "", data: str = "", **_):
        if not isinstance(data, str) or not data.strip():
            return Err(SdkError("图片内容为空。"))
        raw = data.strip()
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        if len(raw) > IMAGE_MAX_BYTES * 2:
            return Err(SdkError("图片过大（base64 超过上限）。"))
        try:
            payload = base64.b64decode(raw, validate=True)
        except Exception:  # noqa: BLE001
            return Err(SdkError("图片内容不是合法的 base64。"))
        try:
            saved = self._save_background_bytes(
                payload, label=f"来自 {filename or '面板'}"
            )
        except SdkError as exc:
            return Err(exc)
        except Exception as exc:  # noqa: BLE001
            return Err(SdkError(f"保存背景图失败：{exc}"))
        return Ok(
            {
                "url": self._background_url(saved),
                "filename": saved,
                "bytes": len(payload),
                "kind": _image_extension(payload) or "unknown",
            }
        )
