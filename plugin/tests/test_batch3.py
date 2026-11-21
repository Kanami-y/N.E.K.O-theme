#!/usr/bin/env python3
"""v0.12.0（批次三）：背景图位置 / 平铺 / 行高 + 快捷调校（光效三档、字体三档）的契约测试。

这一轮新增三个变量与一组「一键铺开」的快捷预设：

  后端   KEYWORD_VARS 加 ``--nts-chat-bg-position`` / ``--nts-chat-bg-repeat``；
         新引入 ``ratio`` 种类（``RATIO_VARS`` / ``RE_RATIO`` / 0.8–3.0）给 ``--nts-line-height``
  加载器 NON_COLOR_VARS + KEYWORD_VALUES + ratio 分支；版本 1.5.27
  生成器 background-position / background-repeat / line-height 三段（都带门控）
  面板   CATALOG 三个新变量 + TYPE_LABEL + isSafeValue ratio；「快捷调校」卡六按钮

锁住的事：
  1. 三个变量在三端都登记、同一组值；非法值（middle / 0.5 / 3.5 / 1.555 / 1.5px）被拒；
  2. CSS 里三段规则都存在、都带 data-nts- 门控、都是 !important；
  3. 光效三档的具体数值 = 用户拍板的 0.15 / 0.45 / 0.85，落点四个变量；
  4. 字体三档 = 系统默认（清空）/ 无衬线 / 等宽，且带行高；
  5. 快捷预设只写 state.edited，不调 apply_theme / callPlugin（要用户点「应用」才落盘）。
"""

from __future__ import annotations

import re
import unittest

from offline_backend import HAS_REPO_TREE, PLUGIN_DIR, ROOT, load_backend

POS = "--nts-chat-bg-position"
REP = "--nts-chat-bg-repeat"
LH = "--nts-line-height"

LOADER_JS = PLUGIN_DIR / "static" / "loader" / "neko-theme-studio.js"
LOADER_CSS = PLUGIN_DIR / "static" / "loader" / "neko-theme-studio.css"
APP_JS = PLUGIN_DIR / "static" / "app.js"
INDEX_HTML = PLUGIN_DIR / "static" / "index.html"
STYLE_CSS = PLUGIN_DIR / "static" / "style.css"
GEN_CSS = ROOT / "tools" / "gen-css.js"
TARGETS_JS = ROOT / "test" / "targets.js"
CI = ROOT / ".github" / "workflows" / "ci.yml"
TEST_README = ROOT / "test" / "README.md"

NS = load_backend()


def read(path):
    return path.read_text(encoding="utf-8")


class BackendTests(unittest.TestCase):
    """后端：三端之一。"""

    def test_new_vars_registered(self):
        known = NS["KNOWN_VARS"]
        for name in (POS, REP, LH):
            self.assertIn(name, known, name)
        keywords = NS["KEYWORD_VARS"]
        self.assertEqual(keywords[POS], ("center", "top", "bottom", "left", "right"))
        self.assertEqual(keywords[REP], ("no-repeat", "repeat", "repeat-x", "repeat-y"))

    def test_ratio_kind(self):
        self.assertIn(LH, NS["RATIO_VARS"])
        self.assertEqual(NS["_value_kind"](LH), "ratio")
        self.assertEqual(NS["_value_kind"](POS), "keyword")
        self.assertEqual(NS["_value_kind"](REP), "keyword")
        self.assertEqual(NS["RATIO_MIN"], 0.8)
        self.assertEqual(NS["RATIO_MAX"], 3.0)

    def test_ratio_values(self):
        check = NS["_is_safe_value"]
        for good in ("0.8", "1", "1.5", "1.55", "2", "3", "3.0", "0.95"):
            self.assertTrue(check(LH, good), good)
        for bad in ("0.5", "0.79", "3.5", "1.555", "1.5px", "1.5.5", "abc", "", "10", "-1.5"):
            self.assertFalse(check(LH, bad), bad)

    def test_keyword_values(self):
        check = NS["_is_safe_value"]
        for good in ("center", "top", "bottom", "left", "right", "CENTER"):
            self.assertTrue(check(POS, good), good)
        for bad in ("middle", "center; color: red", "50%", "url(x)"):
            self.assertFalse(check(POS, bad), bad)
        for good in ("no-repeat", "repeat", "repeat-x", "repeat-y"):
            self.assertTrue(check(REP, good), good)
        for bad in ("none", "space", "round"):
            self.assertFalse(check(REP, bad), bad)

    def test_validate_palette_accepts_new_vars(self):
        clean, dark, errors = NS["_validate_palette"](
            {POS: "top", REP: "repeat-x", LH: "1.6"},
            {POS: "bottom", REP: "no-repeat", LH: "1.8"},
        )
        self.assertEqual(errors, [])
        self.assertEqual(clean[POS], "top")
        self.assertEqual(clean[LH], "1.6")
        self.assertEqual(dark[LH], "1.8")


class LoaderTests(unittest.TestCase):
    """加载器：三端之二。"""

    def test_kind_mapping(self):
        js = read(LOADER_JS)
        self.assertIn("'--nts-chat-bg-position': 'keyword'", js)
        self.assertIn("'--nts-chat-bg-repeat': 'keyword'", js)
        self.assertIn("'--nts-line-height': 'ratio'", js)
        self.assertIn("'--nts-chat-bg-position': ['center', 'top', 'bottom', 'left', 'right']", js)
        self.assertIn("'--nts-chat-bg-repeat': ['no-repeat', 'repeat', 'repeat-x', 'repeat-y']", js)

    def test_ratio_branch_and_regex(self):
        js = read(LOADER_JS)
        self.assertIn("var RE_RATIO = /^[0-9](?:\\.[0-9]{1,2})?$/;", js)
        self.assertRegex(js, r"if \(kind === 'ratio'\) \{[\s\S]{0,200}?>= 0\.8 && ratio <= 3")
        # 版本号断言用"不低于"而不是等值：加载器每次升版（本轮 1.6.1）都要改测试
        # 等于把测试变成改版号的橡皮章，真正要守住的是"别回退"。
        found = re.search(r"SCRIPT_VERSION = '(\d+)\.(\d+)\.(\d+)'", js)
        self.assertIsNotNone(found, "SCRIPT_VERSION 缺失")
        self.assertGreaterEqual(
            tuple(int(part) for part in found.groups()), (1, 6, 1),
            "加载器版本回退了",
        )

    def test_mirrors_identical(self):
        import hashlib

        src = read(LOADER_JS).encode()
        digest = hashlib.sha256(src).hexdigest()
        for rel in ("app/neko-theme-studio.js", "app-patch/files/neko-theme-studio.js"):
            self.assertEqual(hashlib.sha256(read(ROOT / rel).encode()).hexdigest(), digest, rel)


class CssTests(unittest.TestCase):
    """生成器与产物：三个变量必须有消费者。"""

    def test_css_rules_present_and_gated(self):
        css = read(LOADER_CSS)
        for prop, var in (
            ("background-position", POS),
            ("background-repeat", REP),
            ("line-height", LH),
        ):
            pattern = re.compile(
                r":root[^{]*\[data-nts-[ld]-[a-z0-9-]+\][^{]*\{[^}]*?" + prop + r": var\(" + re.escape(var) + r"\) !important"
            )
            hits = pattern.findall(css)
            self.assertTrue(hits, f"{prop} / {var} 缺门控规则")
            self.assertGreaterEqual(len(hits), 2, f"{prop} 应亮/暗各至少一组")

    def test_generator_emits_sections(self):
        gen = read(GEN_CSS)
        self.assertIn("chat background position / repeat", gen)
        self.assertIn("chat line height", gen)
        self.assertIn("'background-repeat' : 'background-position'", gen)
        self.assertIn("line-height: var(", gen)

    def test_targets_declare_them(self):
        targets = read(TARGETS_JS)
        for name in ("chatBackgroundPosition", "chatBackgroundRepeat", "chatLineHeight"):
            self.assertIn(name + ":", targets, name)
        # 位置/平铺与图片同一批容器；行高只作用于聊天文本
        self.assertIn("'.compact-export-history-scroll'", targets)


class PanelTests(unittest.TestCase):
    """面板：三端之三 + 快捷调校。"""

    def test_catalog_entries(self):
        js = read(APP_JS)
        self.assertIn("key: '--nts-chat-bg-position', label: '背景图位置', type: 'select', native: 'center'", js)
        self.assertIn("key: '--nts-chat-bg-repeat', label: '背景图平铺', type: 'select', native: 'no-repeat'", js)
        self.assertIn("key: '--nts-line-height', label: '行高', type: 'ratio'", js)
        self.assertIn("ratio: '行高',", js)
        self.assertIn("if (type === 'ratio') {", js)
        self.assertIn("var RE_RATIO = /^[0-9](?:\\.[0-9]{1,2})?$/;", js)

    def test_select_options(self):
        js = read(APP_JS)
        block = js[js.index("key: '--nts-chat-bg-position'"):]
        block = block[: block.index("key: '--nts-corner-style'")]
        for value in ("center", "top", "bottom", "left", "right"):
            self.assertIn("{ value: '" + value + "'", block, value)
        block = js[js.index("key: '--nts-chat-bg-repeat'"):]
        block = block[: block.index("key: '--nts-corner-style'")]
        for value in ("no-repeat", "repeat", "repeat-x", "repeat-y"):
            self.assertIn("{ value: '" + value + "'", block, value)

    def test_quick_presets_block(self):
        js = read(APP_JS)
        for token in (
            "/* ===== BATCH3_BEGIN",
            "/* ===== BATCH3_END ===== */",
            "var GLOW_LEVELS = {",
            "var GLOW_LEVEL_KEYS = [",
            "var FONT_PRESETS = {",
            "function applyGlowLevel(level) {",
            "function applyFontPreset(id) {",
            "function renderQuickPresets() {",
            "function initQuickPresets() {",
        ):
            self.assertIn(token, js, token)
        # 用户拍板的三档数值
        self.assertIn("low: { label: '低', value: '0.15' }", js)
        self.assertIn("medium: { label: '中', value: '0.45' }", js)
        self.assertIn("high: { label: '高', value: '0.85' }", js)
        # 落点四变量
        for key in ("--nts-ambient-glow", "--nts-glass-dispersion", "--nts-glass-caustic", "--nts-panel-glow-pulse"):
            self.assertIn("'" + key + "'", js, key)
        # 字体三档
        for pid in ("system:", "sans:", "mono:"):
            self.assertIn(pid, js, pid)
        self.assertIn("system-ui, sans-serif", js)
        self.assertIn("monospace", js)

    def test_quick_presets_do_not_write_through(self):
        js = read(APP_JS)
        begin = js.index("/* ===== BATCH3_BEGIN")
        end = js.index("/* ===== BATCH3_END ===== */")
        block = js[begin:end]
        for forbidden in ("applyTheme(", "callPlugin(", "saveThemeFile(", "savePalette("):
            self.assertNotIn(forbidden, block, forbidden)
        self.assertIn("undoPush('', true);", block)

    def test_wiring(self):
        js = read(APP_JS)
        self.assertIn("initQuickPresets();", js)
        self.assertIn("renderQuickPresets();", js)
        self.assertIn("applyGlowLevel: applyGlowLevel,", js)
        self.assertIn("applyFontPreset: applyFontPreset,", js)
        html = read(INDEX_HTML)
        for btn in ("btn-glow-low", "btn-glow-medium", "btn-glow-high",
                    "btn-font-system", "btn-font-sans", "btn-font-mono"):
            self.assertIn('id="' + btn + '"', html, btn)
        self.assertIn('class="card quick-card"', html)
        self.assertIn("快捷调校", html)
        css = read(STYLE_CSS)
        for sel in (".quick-row", ".quick-label", ".quick-btns", ".quick-btn.is-active"):
            self.assertIn(sel, css, sel)


class RegistrationTests(unittest.TestCase):
    def test_ci_and_readme(self):
        self.assertIn("test/preset3-selftest.js", read(CI))
        self.assertIn("preset3-selftest", read(TEST_README))

    def test_panel_count_updated(self):
        # CATALOG 97 → 100：面板自测与 AI 指南必须同步
        self.assertIn("CATALOG 变量总数 = 101", read(ROOT / "test" / "panel-selftest.js"))
        self.assertIn(LH, read(ROOT / "AI-THEME-GUIDE.md"))


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
