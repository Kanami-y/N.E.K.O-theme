"""加载器 CSS 门控完整性 + 弹层目标 + 自愈布尔值的回归测试（Round 28）。

对应 `_review/audit28-loader.md` 的三条：

* **P0-1** 逗号选择器列表只有第一个选择器带门控 —— 其余变成无条件 `!important`
  全局规则。最典型的是气泡里的 `h1, h2, …, h6`：未设变量时 `var()` 无效（IACVT
  → unset → inherit），把宿主 `h2..h6` 的原生颜色整个压平。这份 CSS 由 `<link>`
  常驻，空主题也生效，所以它破坏了 v3「未配置 = 不生效」的唯一不变量。
* **P0-2** 弹层颜色/阴影挂在透明的绝对定位包裹层（`.composer-icon-popover`、
  `.composer-overflow-menu`）上，而不是真正的弹层（`.composer-overflow-popover`）
  —— 头像工具扇 / 「⋯」后面出现直角深色板 + 方形软阴影。
* **P1-1** 自愈链 `postJson` 返回 `r.ok`，但 `.then(function () {...})` 把值丢了 →
  refresh / start 非 2xx 也判「复活成功」并复位退避，服务挂着时每 1.2s 打一轮。

这些断言都是「源码/产物级」的：跑一个 CSS 解析循环，确认**每一条**带
`!important` 的规则里**每一个**选择器都带门控属性。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS_PATH = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.css"
GEN_CSS = ROOT / "tools" / "gen-css.js"
TARGETS = ROOT / "test" / "targets.js"
LOADER = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
MIRRORS = [
    ROOT / "app" / "css" / "neko-theme-studio.css",
    ROOT / "app-patch" / "files" / "css" / "neko-theme-studio.css",
]


def strip_comments(text: str) -> str:
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def iter_blocks(css: str):
    """Yield (selector, body) for every rule block, including ones inside @media.

    不追求完整 CSS 语法：只要能把 `sel { … }` 拆开、把 `@media … {` 这类前奏跳过即可。
    """
    css = strip_comments(css)
    stack: list[str] = []
    buf = ""
    for ch in css:
        if ch == "{":
            head = buf.strip()
            stack.append(head)
            buf = ""
        elif ch == "}":
            head = stack.pop() if stack else ""
            body = buf
            buf = ""
            if head and not head.startswith("@"):
                yield head, body
            elif head and head.startswith("@") and not stack:
                pass
        else:
            buf += ch


def split_top_level(sel: str) -> list[str]:
    out, buf, depth, quote = [], "", 0, ""
    for ch in sel:
        if quote:
            buf += ch
            if ch == quote:
                quote = ""
            continue
        if ch in "\"'":
            quote = ch
            buf += ch
            continue
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(buf.strip())
            buf = ""
            continue
        buf += ch
    if buf.strip():
        out.append(buf.strip())
    return out


class GatingCompletenessTests(unittest.TestCase):
    """P0-1：任何 `!important` 声明的每一个选择器都必须带 `data-nts-` 门控。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.css = CSS_PATH.read_text(encoding="utf-8")
        cls.blocks = list(iter_blocks(cls.css))

    def test_css_is_parsed(self) -> None:
        self.assertGreater(len(self.blocks), 200, "解析出的规则太少，解析器可能坏了")

    def test_no_ungated_important_selector(self) -> None:
        offenders: list[str] = []
        for selector, body in self.blocks:
            if "!important" not in body:
                continue
            for part in split_top_level(selector):
                if part and "data-nts-" not in part:
                    offenders.append(part)
        self.assertEqual(offenders, [], "这些选择器没有门控却写了 !important：\n" + "\n".join(offenders[:20]))

    def test_multi_selector_lists_are_wrapped_in_is(self) -> None:
        """多选择器的门控规则必须用 `:is(...)`：否则只有第一个吃到门控。"""
        is_blocks = [sel for sel, body in self.blocks if ":is(" in sel and "!important" in body]
        self.assertGreaterEqual(len(is_blocks), 9, "至少 9 条 h1..h6 规则应该用 :is() 包住")
        for sel in is_blocks:
            self.assertIn("data-nts-", sel)
            self.assertLess(sel.index("data-nts-"), sel.index(":is("), "门控必须在 :is() 前面")

    def test_markdown_headings_have_six_selectors_each(self) -> None:
        """h1..h6 的 6 个选择器都必须留在 :is() 里（曾经 h2..h6 裸奔）。"""
        found = 0
        for sel, body in self.blocks:
            if "message-block-markdown" not in sel or ":is(" not in sel:
                continue
            inner = sel[sel.index(":is(") + 4: sel.rindex(")")]
            tags = re.findall(r"\bh([1-6])\b", inner)
            self.assertEqual(sorted(set(tags)), ["1", "2", "3", "4", "5", "6"], f"缺少标题层级：{sel[:120]}")
            found += 1
        self.assertGreaterEqual(found, 9, "气泡/历史/预览里的 markdown 标题规则都该覆盖到")

    def test_mirrors_are_byte_identical(self) -> None:
        source = CSS_PATH.read_bytes()
        for mirror in MIRRORS:
            self.assertEqual(mirror.read_bytes(), source, f"{mirror} 与唯一源不一致（跑 node tools/sync-assets.js）")


class GeneratorTests(unittest.TestCase):
    def test_generator_splits_selector_lists(self) -> None:
        text = GEN_CSS.read_text(encoding="utf-8")
        self.assertIn("function splitSelectorList(sel)", text)
        self.assertIn("return prefix + ':is(' + parts.join(', ') + ')'", text)
        self.assertIn("p.indexOf('::') >= 0", text, "带伪元素时不能塞进 :is()")

    def test_generator_still_gates(self) -> None:
        text = GEN_CSS.read_text(encoding="utf-8")
        self.assertIn("data-nts-l-", text)
        self.assertIn("data-nts-d-", text)


class PopoverTargetTests(unittest.TestCase):
    """P0-2：弹层颜色/阴影只能挂在真弹层 `.composer-overflow-popover` 上。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = TARGETS.read_text(encoding="utf-8")

    def _entries(self, pattern: str) -> list[str]:
        return [line for line in self.text.splitlines() if re.search(pattern, line) and "aux: true" not in line]

    def test_no_colour_on_wrapper_layers(self) -> None:
        for prop in ("background-color", "color", "box-shadow"):
            bad = self._entries(rf"sel: '\.composer-(icon-popover|overflow-menu)'.*prop: '{prop}'")
            self.assertEqual(bad, [], f"{prop} 不该挂在包裹层上：\n" + "\n".join(bad))

    def test_real_popover_gets_colour_and_shadow(self) -> None:
        bg = self._entries(r"sel: '\.composer-overflow-popover'.*prop: 'background-color'")
        text = self._entries(r"sel: '\.composer-overflow-popover'.*prop: 'color'")
        shadow = self._entries(r"sel: '\.composer-overflow-popover'.*prop: 'box-shadow'")
        self.assertTrue(bg and text and shadow, "真弹层应该同时有背景、文字色、阴影")

    def test_css_does_not_paint_the_wrapper(self) -> None:
        css = CSS_PATH.read_text(encoding="utf-8")
        pattern = re.compile(r"\.composer-icon-popover\s*\{[^}]*background-color", re.S)
        self.assertIsNone(pattern.search(css), "生成的 CSS 仍然给包裹层上了背景色")


class ReviveChainTests(unittest.TestCase):
    """P1-1：自愈链必须检查每一步的布尔结果。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = LOADER.read_text(encoding="utf-8")

    def test_refresh_result_is_checked(self) -> None:
        self.assertIn("if (!refreshed) throw new Error('plugins/refresh failed');", self.text)
        self.assertIn(".then(function (refreshed) {", self.text)

    def test_start_result_is_checked(self) -> None:
        self.assertIn("if (!started) throw new Error('plugin start failed');", self.text)
        self.assertIn(".then(function (started) {", self.text)

    def test_success_resets_backoff_only_after_both_steps(self) -> None:
        start = self.text.index("if (!started) throw new Error('plugin start failed');")
        # 文件别处也有这个名字（声明 / 其它分支），从 start 之后找第一次复位。
        reset = self.text.find("reviveDelay = REVIVE_BASE_DELAY_MS;", start)
        self.assertNotEqual(reset, -1, "两个步骤都成功之后必须复位退避")
        self.assertLess(start, reset, "退避复位必须排在两步都成功之后")

    def test_mirrors_are_byte_identical(self) -> None:
        source = LOADER.read_bytes()
        for mirror in (ROOT / "app" / "neko-theme-studio.js", ROOT / "app-patch" / "files" / "neko-theme-studio.js"):
            self.assertEqual(mirror.read_bytes(), source, f"{mirror} 与唯一源不一致（跑 node tools/sync-assets.js）")


class ReducedMotionTests(unittest.TestCase):
    """P1-4：`prefers-reduced-motion` 的关动画选择器必须与动画规则**一一对应**。

    动画规则是 OR 触发的（`--nts-panel-glow-pulse` 或 `--nts-panel-glow-speed`
    任一存在就挂 `animation`），而旧的关动画块写成了 AND 双门控
    （`[data-…-pulse][data-…-speed]`）→ 只设其中一个变量的用户即使在系统里打开
    「减少动态效果」也照样看见面板呼吸。修法：每个变量各推一条关动画选择器。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.css = CSS_PATH.read_text(encoding="utf-8")
        cls.blocks = list(iter_blocks(cls.css))
        cls.reduce = [(s, b) for s, b in cls.blocks if "animation: none" in b]
        cls.anim = [
            (s, b) for s, b in cls.blocks
            if "animation:" in b and "animation: none" not in b and "!important" in b
        ]

    def test_media_query_present(self) -> None:
        self.assertIn("@media (prefers-reduced-motion: reduce)", strip_comments(self.css))

    def test_single_reduce_rule(self) -> None:
        self.assertEqual(len(self.reduce), 1, "关动画规则应该只有一条（多选择器合写）")

    def test_animation_rules_are_or_gated(self) -> None:
        """动画规则本身必须是单门控：双门控等于「两个变量都设了才动」。"""
        self.assertGreaterEqual(len(self.anim), 2, "至少有亮/暗两套面板呼吸动画")
        for sel, _body in self.anim:
            for part in split_top_level(sel):
                self.assertEqual(
                    part.count("data-nts-"), 1,
                    f"动画规则应该只被一个变量门控：{part[:120]}",
                )

    def test_reduce_covers_every_animation_selector(self) -> None:
        reduce_sels = split_top_level(self.reduce[0][0])
        anim_gates = {part[part.index("data-nts-"): part.index("data-nts-") + 40] for sel, _ in self.anim for part in split_top_level(sel)}
        self.assertEqual(
            len(reduce_sels), len(self.anim),
            f"关动画选择器数 {len(reduce_sels)} != 动画规则数 {len(self.anim)}",
        )
        for part in reduce_sels:
            self.assertEqual(part.count("data-nts-"), 1, f"关动画选择器不该是双门控：{part[:120]}")
            gate = part[part.index("data-nts-"): part.index("data-nts-") + 40]
            self.assertIn(gate, anim_gates, f"关动画覆盖了不存在的门控：{gate}")

    def test_generator_emits_one_selector_per_variable(self) -> None:
        text = GEN_CSS.read_text(encoding="utf-8")
        self.assertIn("reducedMotion.push(sel(mode, [V.glowPulse]) + ' ' + DECO);", text)
        self.assertIn("reducedMotion.push(sel(mode, [V.glowSpeed]) + ' ' + DECO);", text)
        # 旧写法的 AND 版本必须已经消失
        self.assertNotIn("reducedMotion.push(sel(mode, [V.glowPulse, V.glowSpeed])", text)


class LoaderStateTests(unittest.TestCase):
    """P2：`clearGates` 兜底扫描与 `onGlassScroll` 的状态清理。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = LOADER.read_text(encoding="utf-8")

    def test_clear_gates_only_touches_variable_prefixes(self) -> None:
        """兜底扫描不能清 `data-nts-active/paused/fade` 这类状态属性。"""
        self.assertIn("var gatePrefixes = [GATE_ATTR + 'l-', GATE_ATTR + 'd-'];", self.text)
        start = self.text.index("var gatePrefixes = [GATE_ATTR + 'l-', GATE_ATTR + 'd-'];")
        window = self.text[start: start + 400]
        self.assertNotIn("if (n.indexOf(GATE_ATTR) === 0)", window, "还在用裸前缀扫全部 data-nts-*")

    def test_on_glass_scroll_stops_for_non_glass_themes(self) -> None:
        start = self.text.index("function onGlassScroll() {")
        window = self.text[start: start + 700]
        self.assertIn("if (!glassFxActive()) {", window)
        self.assertLess(window.index("if (!glassFxActive()) {"), window.index("setProperty('--nts-scroll-k', '1')"),
                        "非玻璃主题必须在写 --nts-scroll-k 之前就退出去")
        self.assertIn("'--nts-scroll-k', '0'", window, "切走时要把 scroll-k 归零")

    def test_script_version_is_semver(self) -> None:
        m = re.search(r"var SCRIPT_VERSION = '(\d+)\.(\d+)\.(\d+)';", self.text)
        self.assertIsNotNone(m, "找不到 SCRIPT_VERSION")
        # 语义化断言：只要不低于「本轮特性引入的版本」即可，不钉死具体号
        # （前几轮钉死 1.5.22/1.5.23 的写法，每次升版都要改一批测试）。
        self.assertGreaterEqual(tuple(int(x) for x in m.groups()), (1, 5, 24), "版本号不应回退")


if __name__ == "__main__":
    unittest.main()
