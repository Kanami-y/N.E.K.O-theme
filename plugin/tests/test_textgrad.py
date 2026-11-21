#!/usr/bin/env python3
"""v0.13.0：文字渐变 ``--nts-text-gradient`` 的契约测试。

做法是 CSS 里唯一可靠的「文字渐变」套路：
``background-image: <gradient>; background-clip: text; -webkit-text-fill-color: transparent``。

锁住四件事：
  1. 变量登记在 GRADIENT_VARS / KNOWN_VARS，三端 kind 都是 gradient，
     合法 linear/radial 通过、缺百分比停止点/非法函数被拒；
  2. CSS 里确有 ``background-clip: text`` + ``-webkit-text-fill-color: transparent``，
     且整段带 data-nts- 门控（未设置时零规则）；
  3. 代码块/行内代码有复位规则（``-webkit-text-fill-color: currentColor``）——
     否则 ``text-fill-color`` 继承成透明，代码块变「看不见的字」；
  4. 渐变只打在消息文本块上，**不**打在 .message-bubble-* 上（气泡自带底色，
     会被 background-clip:text 裁成文字形状）。
"""

from __future__ import annotations

import unittest

from offline_backend import ROOT, load_backend

VAR = "--nts-text-gradient"

LOADER_JS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
LOADER_CSS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.css"
APP_JS = ROOT / "plugin" / "static" / "app.js"
TARGETS_JS = ROOT / "test" / "targets.js"
GEN_CSS = ROOT / "tools" / "gen-css.js"
GUIDE = ROOT / "AI-THEME-GUIDE.md"

NS = load_backend()


def read(path):
    return path.read_text(encoding="utf-8")


class BackendTests(unittest.TestCase):
    def test_registered(self):
        self.assertIn(VAR, NS["KNOWN_VARS"])
        self.assertIn(VAR, NS["GRADIENT_VARS"])
        self.assertEqual(NS["_value_kind"](VAR), "gradient")

    def test_gradient_values(self):
        check = NS["_is_safe_value"]
        for good in (
            "linear-gradient(135deg, #6ee7ff 0%, #a78bfa 100%)",
            "linear-gradient(180deg, #fff 0%, #000 50%, #4c8dff 100%)",
            "radial-gradient(#6ee7ff 0%, #a78bfa 100%)",
        ):
            self.assertTrue(check(VAR, good), good)
        for bad in (
            "linear-gradient(#fff, #000)",          # 停止点缺百分比
            "conic-gradient(#fff 0%, #000 100%)",   # 只允许 linear / radial
            "#6ee7ff",                              # 不是渐变
            "linear-gradient(135deg, #fff 0%, #000 101%)",  # 停止点 > 100%
            "url(http://x/y.png)",
        ):
            self.assertFalse(check(VAR, bad), bad)


class CssTests(unittest.TestCase):
    def test_rule_shape(self):
        css = read(LOADER_CSS)
        self.assertIn("--nts-text-gradient", css)
        self.assertIn("-webkit-background-clip: text !important", css)
        self.assertIn("-webkit-text-fill-color: transparent !important", css)
        # 门控：属性名里带 --nts-text-gradient 的 data 属性 + :root
        self.assertRegex(
            css,
            r'\[data-nts-[ld]-text-gradient\][^{]*\{[^}]*?background-clip: text !important',
        )

    def test_code_block_reset(self):
        css = read(LOADER_CSS)
        # 复位必须同时关掉裁切并把字恢复成实色
        self.assertRegex(css, r'-webkit-text-fill-color: currentColor !important')
        self.assertRegex(css, r'background-clip: border-box !important')

    def test_selectors_are_text_blocks(self):
        css = read(LOADER_CSS)
        idx = css.find("--nts-text-gradient")
        window = css[max(0, idx - 4000): idx + 20000]
        self.assertIn(".message-block-text", window)
        self.assertIn(".message-block-markdown", window)
        # 渐变规则的选择器里不能出现气泡容器（会裁掉气泡底色）
        for line in window.splitlines():
            if "background-clip: text !important" in line and "--nts-text-gradient" in line:
                self.assertNotIn(".message-bubble-", line, line[:200])


class PanelTests(unittest.TestCase):
    def test_catalog_entry(self):
        js = read(APP_JS)
        self.assertIn("key: '--nts-text-gradient', label: '文字渐变', type: 'gradient'", js)
        # 提示里必须写清两个副作用：气泡文字色失效、浅色渐变有可读性风险
        block = js[js.index("key: '--nts-text-gradient'"):]
        block = block[: block.index("},", 0)]
        self.assertIn("气泡文字色", block)
        self.assertIn("代码块", block)

    def test_targets_do_not_touch_bubbles(self):
        targets = read(TARGETS_JS)
        block = targets[targets.index("textGradient: {"):]
        block = block[: block.index("},", 0)]
        self.assertNotIn(".message-bubble-", block)
        self.assertIn(".message-block-text", block)

    def test_generator_section(self):
        gen = read(GEN_CSS)
        self.assertIn("text gradient（文字渐变，v0.13.0）", gen)
        self.assertIn("-webkit-text-fill-color: transparent", gen)
        self.assertIn("currentColor", gen)

    def test_guide_documents_it(self):
        self.assertIn(VAR, read(GUIDE))

    def test_panel_catalog_count(self):
        self.assertIn("CATALOG 变量总数 = 101", read(ROOT / "test" / "panel-selftest.js"))
        self.assertIn("101", read(ROOT / "test" / "README.md"))


if __name__ == "__main__":
    unittest.main()
