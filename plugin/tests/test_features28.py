"""Round 28 功能批回归测试：拖拽导入（F7）+ 导出 CSS 片段（F8）。

两个功能都是纯前端，这里做「源码契约」级断言：函数存在、必经路径没被绕过
（busy 守卫、扩展名白名单、复用既有导入管线）、产出格式正确（`:root` /
`:root[data-theme="dark"]` 两段）、UI 与调试钩子接线齐全。
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "plugin" / "static" / "app.js"
HTML = ROOT / "plugin" / "static" / "index.html"
CSS = ROOT / "plugin" / "static" / "style.css"


class DropImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.js = APP.read_text(encoding="utf-8")

    def test_functions_exist_and_booted(self) -> None:
        self.assertIn("function initDropImport()", self.js)
        self.assertIn("function dropHasFiles(dt)", self.js)
        self.assertIn("function dropReset()", self.js)
        # bootstrap 里必须真的调用（否则函数写了也白搭）
        boot = self.js[self.js.index("function bootstrap() {"):]
        self.assertIn("initDropImport();", boot)

    def test_extension_whitelist(self) -> None:
        self.assertIn("lower.slice(-4) !== '.zip'", self.js)
        self.assertIn("lower.slice(-5) !== '.json'", self.js)
        self.assertIn("只支持拖入 .zip 分享包或 .json 主题文件。", self.js)

    def test_busy_guard_before_import(self) -> None:
        start = self.js.index("document.body.addEventListener('drop'")
        window = self.js[start: start + 1600]
        self.assertIn("if (state.busy) {", window)
        self.assertLess(window.index("if (state.busy) {"), window.index("handleArchiveFile(file, null)"),
                        "忙的时候必须直接退出，不能把导入排进队列")

    def test_reuses_archive_pipeline(self) -> None:
        """不许自己再写一遍 FileReader/base64 —— 复用 handleArchiveFile。"""
        start = self.js.index("document.body.addEventListener('drop'")
        window = self.js[start: start + 1600]
        self.assertIn("handleArchiveFile(file, null)", window)
        self.assertNotIn("new FileReader()", window)

    def test_window_level_default_is_blocked(self) -> None:
        """拖到面板外时浏览器会直接打开文件，必须 preventDefault。"""
        self.assertRegex(
            self.js,
            r"\['dragover', 'drop'\]\.forEach\(function \(type\) \{\s*window\.addEventListener\(type, function \(e\) \{\s*if \(dropHasFiles\(e\.dataTransfer\)\) e\.preventDefault\(\);",
        )

    def test_idempotent_binding(self) -> None:
        self.assertIn("document.body.getAttribute('data-drop-import') === '1'", self.js)


class CssSnippetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.js = APP.read_text(encoding="utf-8")
        cls.html = HTML.read_text(encoding="utf-8")
        cls.css = CSS.read_text(encoding="utf-8")

    def test_uses_effective_vars_for_both_modes(self) -> None:
        start = self.js.index("function cssSnippetText() {")
        body = self.js[start: start + 1800]
        self.assertIn("effectiveVars('light')", body)
        self.assertIn("effectiveVars('dark')", body)

    def test_emits_two_root_blocks(self) -> None:
        self.assertIn("pushBlock(':root', light,", self.js)
        self.assertIn("""pushBlock(':root[data-theme="dark"]', dark,""", self.js)

    def test_keys_are_sorted_for_stable_output(self) -> None:
        """同一套配色导两次必须字节一致（否则 diff 噪声）。"""
        self.assertIn("var keys = Object.keys(map || {}).sort();", self.js)

    def test_empty_palette_yields_nothing(self) -> None:
        start = self.js.index("function cssSnippetText() {")
        body = self.js[start: start + 1800]
        self.assertIn("if (!lines.length) return '';", body)
        self.assertIn("当前调色板是空的，没有可导出的变量", self.js)

    def test_ui_and_wiring(self) -> None:
        self.assertIn('id="btn-css-snippet"', self.html)
        self.assertIn("$('btn-css-snippet').addEventListener('click', copyCssSnippet)", self.js)
        self.assertIn("function copyCssSnippet()", self.js)
        self.assertIn("openModal(", self.js)
        self.assertIn("#btn-css-snippet", self.css)

    def test_debug_hooks(self) -> None:
        start = self.js.index("window.__ntsPanel = window.__ntsPanel || {")
        tail = self.js[start:]
        for hook in ("cssSnippetText: cssSnippetText", "copyCssSnippet: copyCssSnippet", "initDropImport: initDropImport"):
            self.assertIn(hook, tail)


if __name__ == "__main__":
    unittest.main()
