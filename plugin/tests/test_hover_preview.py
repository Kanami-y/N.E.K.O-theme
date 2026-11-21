"""Round 32：主题卡悬停预演（v0.9.0）的接线与契约测试。

真正的行为在 `test/hover-selftest.js` 里真跑（33 条断言）；这里守的是
「别在后续改动里把它悄悄拆掉」以及几个必须成立的硬约束：
不写盘、不走 entry、只读静态文件、读写都不动 state.edited。
"""

from __future__ import annotations

import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[1]  # 市场校验时插件根不叫 plugin
HAS_REPO_TREE = (REPO / "tools").is_dir()
APP_JS = PLUGIN_DIR / "static" / "app.js"
SELFTEST = REPO / "test" / "hover-selftest.js"
CI = REPO / ".github" / "workflows" / "ci.yml"
README = REPO / "test" / "README.md"


def block(text: str, begin: str, end: str) -> str:
    start = text.find(begin)
    if start < 0:
        return ""
    stop = text.find(end, start)
    if stop < 0:
        return ""
    return text[start:stop + len(end)]


class HoverPreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = APP_JS.read_text(encoding="utf-8")
        cls.block = block(cls.app, "/* ===== HOVER_PREVIEW_BEGIN", "/* ===== HOVER_PREVIEW_END ===== */")

    def test_block_exists(self) -> None:
        self.assertTrue(self.block, "app.js 里找不到 HOVER_PREVIEW 区块")
        self.assertIn("var hoverPreview = {", self.block)
        for name in (
            "function hoverPreviewMap()",
            "function hoverPreviewValue(key)",
            "function rewritePreviewRefs(map, builtin)",
            "function hoverPreviewFetchUrl(item)",
            "async function showHoverPreview(item)",
            "function clearHoverPreview()",
        ):
            self.assertIn(name, self.block, name)

    def test_reads_static_files_not_entries(self) -> None:
        self.assertIn("'presets/' : 'themes/'", self.block)
        self.assertIn(".json", self.block)
        self.assertNotIn("callPlugin(", self.block)
        # 注释里会提到「走 /runs 太慢」，所以只查真正的调用面（常量与请求函数）。
        self.assertNotIn("RUNS_URL", self.block)
        self.assertNotIn("postWithCsrfRetry(", self.block)
        self.assertNotIn("fetchWithTimeout('theme.json", self.block)

    def test_preview_never_writes_anything(self) -> None:
        for forbidden in (
            "applyTheme(",
            "savePalette(",
            "markEdited(",
            "state.edited =",
            "state.cleared =",
            "localStorage",
            "sessionStorage",
            "syncRow(",
        ):
            self.assertNotIn(forbidden, self.block, forbidden)

    def test_pvValue_prefers_preview(self) -> None:
        window = self.app[self.app.find("function pvValue(key, fallback) {"):]
        window = window[:window.find("\n}")]
        self.assertIn("hoverPreviewValue(key)", window)
        self.assertLess(window.find("hoverPreviewValue(key)"), window.find("displayValue(key)"),
                        "预演值必须在读取当前调色板之前")

    def test_preview_title_shows_hovered_theme(self) -> None:
        self.assertIn("' · 预演「'", self.app)
        self.assertIn("hoverPreview.name", self.app)

    def test_cards_bind_hover_and_focus(self) -> None:
        for handler in (
            "row.addEventListener('pointerenter', function () { showHoverPreview(item); });",
            "row.addEventListener('pointerleave', function () { clearHoverPreview(); });",
            "row.addEventListener('focusin', function () { showHoverPreview(item); });",
            "row.addEventListener('focusout', function () { clearHoverPreview(); });",
        ):
            self.assertIn(handler, self.app)

    def test_cache_is_bounded(self) -> None:
        self.assertRegex(self.block, r"Object\.keys\(hoverPreview\.cache\)\.length < \d+")

    def test_stale_response_guard(self) -> None:
        self.assertIn("hoverPreview.seq += 1", self.block)
        self.assertIn("if (seq !== hoverPreview.seq) return;", self.block)

    def test_busy_and_modal_skip(self) -> None:
        self.assertIn("if (state.busy) return;", self.block)
        self.assertIn("if (modal && !modal.hidden) return;", self.block)

    def test_debug_hooks(self) -> None:
        for hook in ("hoverPreview: hoverPreview,", "showHoverPreview: showHoverPreview,",
                     "clearHoverPreview: clearHoverPreview,", "rewritePreviewRefs: rewritePreviewRefs,"):
            self.assertIn(hook, self.app, hook)

    def test_selftest_registered(self) -> None:
        self.assertTrue(SELFTEST.is_file(), "缺少 test/hover-selftest.js")
        selftest = SELFTEST.read_text(encoding="utf-8")
        self.assertIn("HOVER_PREVIEW_BEGIN", selftest)
        self.assertIn("PASS ", selftest)
        ci = CI.read_text(encoding="utf-8")
        self.assertIn("test/hover-selftest.js", ci)
        readme = README.read_text(encoding="utf-8")
        self.assertIn("hover-selftest.js", readme)
        self.assertIsNone(re.search(r"test/hover-selftest\.js\s*\n", ""))


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录")
