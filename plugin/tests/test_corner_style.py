#!/usr/bin/env python3
"""v0.8.0：圆角「连续曲率」可选开关的契约测试。

这一轮把 ``--nts-corner-style``（round / continuous）做成三端可选变量：

  后端  KEYWORD_VARS / KNOWN_VARS / _is_safe_value / _canonicalize_value
  加载器 NON_COLOR_VARS 的 keyword + KEYWORD_VALUES 表 + <html data-nts-squircle>
  生成器 tools/gen-css.js 的 ``@supports (corner-shape: squircle)`` 段
  面板  CATALOG 的 select（普通圆角 / 连续曲率）+ 通用 select 回显

这里锁住四件事：
  1. 三端都登记了同一个变量、同一组值（round / continuous），非法值被拒；
  2. CSS 里确实有 ``corner-shape: squircle``，且**整段包在 @supports 里**
     （宿主 Chromium 126 及更老没有 corner-shape，不能裸写让整段规则失效地拖慢解析，
     更不能指望它生效）；
  3. 选择器是从 targets 里所有 border-radius 的 target 收集来的，不是手抄的；
  4. 加载器只在值为 continuous 时打属性、换回 round 时撤掉。
"""

from __future__ import annotations

import re
import unittest

from offline_backend import ROOT, load_backend

VAR = "--nts-corner-style"

LOADER_JS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
LOADER_CSS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.css"
APP_JS = ROOT / "plugin" / "static" / "app.js"
GEN_CSS = ROOT / "tools" / "gen-css.js"
TARGETS_JS = ROOT / "test" / "targets.js"
GUIDE = ROOT / "AI-THEME-GUIDE.md"


def read(path):
    return path.read_text(encoding="utf-8")


def js_function(src, name):
    """从 ``function name(`` 切到下一个顶层 ``\\n  function `` 之前。"""
    head = src.index("function %s(" % name)
    tail = src.index("\n  function ", head + 1) if "\n  function " in src[head + 1:] else len(src)
    return src[head:tail]


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.NS = load_backend()

    def test_registered_as_keyword_variable(self):
        self.assertIn(VAR, self.NS["KEYWORD_VARS"])
        self.assertEqual(self.NS["KEYWORD_VARS"][VAR], ("round", "continuous"))
        self.assertIn(VAR, self.NS["KNOWN_VARS"])
        self.assertEqual(self.NS["_value_kind"](VAR), "keyword")

    def test_accepts_both_values_case_insensitively(self):
        safe = self.NS["_is_safe_value"]
        for value in ("round", "continuous", "CONTINUOUS", "Round"):
            with self.subTest(value=value):
                self.assertTrue(safe(VAR, value), "%r 应当通过" % value)

    def test_rejects_everything_else(self):
        safe = self.NS["_is_safe_value"]
        for value in ("bevel", "squircle", "superellipse(4)", "notch", "1px", "",
                      "continuous !important", "url(x)", "var(--nts-radius)"):
            with self.subTest(value=value):
                self.assertFalse(safe(VAR, value), "%r 应当被拒" % value)

    def test_canonicalize_lowercases(self):
        self.assertEqual(self.NS["_canonicalize_value"](VAR, "Continuous"), "continuous")

    def test_palette_accepts_continuous_and_rejects_bad(self):
        validate = self.NS["_validate_palette"]
        clean_vars, _, errors = validate({VAR: "continuous"}, {})
        self.assertEqual(errors, [])
        self.assertEqual(clean_vars[VAR], "continuous")
        _, _, bad = validate({VAR: "bevel"}, {})
        self.assertTrue(bad, "bevel 不是合法圆角形状，应当被拒")

    def test_panel_catalog_and_backend_agree(self):
        catalog = read(APP_JS)
        self.assertIn("key: '%s'" % VAR, catalog)
        self.assertIn("{ value: 'round', label: '普通圆角' }", catalog)
        self.assertIn("{ value: 'continuous', label: '连续曲率（iOS 风格）' }", catalog)


class LoaderTests(unittest.TestCase):
    def test_non_color_vars_registers_keyword(self):
        self.assertRegex(read(LOADER_JS), r"'--nts-corner-style':\s*'keyword'")

    def test_keyword_values_table_lists_both(self):
        src = read(LOADER_JS)
        table = src[src.index("var KEYWORD_VALUES = {"):src.index("function isSafeValue(")]
        self.assertIn("'--nts-corner-style': ['round', 'continuous']", table)
        self.assertIn("'--nts-chat-bg-fit': ['cover', 'contain']", table)

    def test_is_safe_value_uses_table(self):
        body = js_function(read(LOADER_JS), "isSafeValue")
        self.assertIn("kind === 'keyword'", body)
        self.assertIn("KEYWORD_VALUES[name]", body)
        self.assertIn("toLowerCase()", body)

    def test_corner_attribute_toggles_on_continuous(self):
        body = js_function(read(LOADER_JS), "syncCornerStyle")
        self.assertIn("data-nts-squircle", read(LOADER_JS))
        self.assertIn("'continuous'", body)
        self.assertIn("setAttribute(SQUIRCLE_ATTR", body)
        self.assertIn("removeAttribute(SQUIRCLE_ATTR)", body)
        # 亮/暗两组都要看（变量可能只写在其中一组里）
        self.assertIn("groups = [light, dark]", body)

    def test_set_gates_calls_corner_sync(self):
        body = js_function(read(LOADER_JS), "setGates")
        self.assertIn("syncCornerStyle(light, dark);", body)
        # 必须在「没有变量就清空门控」的提前返回之前调用，否则切回空主题时属性撤不掉
        self.assertLess(body.index("syncCornerStyle(light, dark);"),
                        body.index("if (!want.length)"))

    def test_version_and_mirrors(self):
        version = re.search(r"var SCRIPT_VERSION = '(\d+\.\d+\.\d+)';", read(LOADER_JS)).group(1)
        self.assertGreaterEqual(tuple(int(x) for x in version.split(".")), (1, 5, 26))
        for mirror in ("app/neko-theme-studio.js", "app-patch/files/neko-theme-studio.js"):
            with self.subTest(mirror=mirror):
                other = read(ROOT / mirror)
                self.assertIn("'--nts-corner-style': 'keyword'", other)
                self.assertIn("var SCRIPT_VERSION = '%s';" % version, other)


class CssTests(unittest.TestCase):
    def setUp(self):
        self.css = read(LOADER_CSS)
        self.targets = read(TARGETS_JS)

    def test_squircle_rules_are_inside_supports(self):
        at = self.css.index("@supports (corner-shape: squircle) {")
        rule = self.css.index("corner-shape: squircle !important")
        closing = self.css.index("\n}\n", at)
        self.assertLess(at, rule, "规则必须在 @supports 之后（否则旧内核解析到不认识的属性）")
        self.assertLess(rule, closing, "规则必须在 @supports 块内")

    def test_rules_are_gated_by_attribute(self):
        block = self.css[self.css.index("@supports (corner-shape: squircle) {"):]
        block = block[:block.index("\n}\n") + 3]
        rules = [ln for ln in block.splitlines() if "corner-shape: squircle !important" in ln]
        self.assertGreaterEqual(len(rules), 20, "圆角 target 有 20+ 个，规则数应同步")
        for line in rules:
            with self.subTest(rule=line.strip()[:60]):
                self.assertIn(":root[data-nts-squircle]:root:root body ", line)
                self.assertIn("!important", line)

    def test_all_border_radius_targets_are_covered(self):
        sels = []
        for m in re.finditer(r"sel:\s*'([^']+)'[^}]*prop:\s*'border-radius'", self.targets):
            if m.group(1) not in sels:
                sels.append(m.group(1))
        # 反过来也成立：正则漏掉换行顺序相反的情况时，用「按 target 文本块」再收一遍
        for block in self.targets.split("{ sec:")[1:]:
            if "prop: 'border-radius'" not in block:
                continue
            m = re.search(r"sel:\s*'([^']+)'", block)
            if m and m.group(1) not in sels:
                sels.append(m.group(1))
        self.assertGreaterEqual(len(sels), 20)
        for sel in sels:
            with self.subTest(sel=sel):
                self.assertIn("body " + sel + " { corner-shape: squircle", self.css)

    def test_important_targets_present(self):
        for sel in (".message-bubble-user", ".message-bubble-assistant", ".chat-body",
                    ".composer-panel", ".composer-overflow-popover", ".modal-dialog",
                    ".proactive-recommendation-card"):
            with self.subTest(sel=sel):
                self.assertIn("body " + sel + " { corner-shape: squircle", self.css)

    def test_generator_collects_from_targets(self):
        gen = read(GEN_CSS)
        self.assertIn("t.prop !== 'border-radius'", gen)
        self.assertIn("corner-shape: squircle !important", gen)
        self.assertIn("@supports (corner-shape: squircle)", gen)

    def test_css_mirrors_identical(self):
        for mirror in ("app/css/neko-theme-studio.css", "app-patch/files/css/neko-theme-studio.css"):
            with self.subTest(mirror=mirror):
                self.assertEqual(read(ROOT / mirror), self.css)


class PanelTests(unittest.TestCase):
    def test_select_row_echo_is_generic(self):
        """回显不能再写死 cover/contain —— 否则圆角风格那行永远显示成「铺满」。"""
        src = read(APP_JS)
        start = src.index("} else if (ref.item.type === 'select') {")
        body = src[start:start + 1200]
        self.assertIn("ref.item.options", body)
        self.assertIn("ref.item.native", body)
        self.assertNotIn("fitValue === 'contain' ? 'contain' : 'cover'", body)

    def test_native_label_helper(self):
        src = read(APP_JS)
        self.assertIn("function selectOptionLabel(item, value)", src)
        body = js_function(src, "selectOptionLabel")
        self.assertIn("split('（')", body)

    def test_guide_documents_new_variable(self):
        self.assertIn(VAR, read(GUIDE), "AI-THEME-GUIDE.md 里应有这个变量（重新生成指南）")


if __name__ == "__main__":
    unittest.main()
