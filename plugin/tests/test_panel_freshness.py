"""Round 32：面板版本自检（v0.9.0）的接线与契约测试。

行为测试在 `test/freshness-selftest.js`（36 条断言）里真跑；这里守：
区块存在、挂在 bootstrap 之后、只拉 index.html 且 no-store、
绝不触碰调色板/写盘、CI 与 test/README 有登记。
"""

from __future__ import annotations

import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[1]  # 市场校验时插件根不叫 plugin
HAS_REPO_TREE = (REPO / "tools").is_dir()
APP_JS = PLUGIN_DIR / "static" / "app.js"
INDEX_HTML = PLUGIN_DIR / "static" / "index.html"
SELFTEST = REPO / "test" / "freshness-selftest.js"
CI = REPO / ".github" / "workflows" / "ci.yml"
README = REPO / "test" / "README.md"


def extract(text: str, begin: str, end: str) -> str:
    start = text.find(begin)
    if start < 0:
        return ""
    stop = text.find(end, start)
    if stop < 0:
        return ""
    return text[start:stop + len(end)]


class PanelFreshnessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = APP_JS.read_text(encoding="utf-8")
        cls.block = extract(cls.app, "/* ===== PANEL_FRESHNESS_BEGIN",
                            "/* ===== PANEL_FRESHNESS_END ===== */")

    def test_block_exists(self) -> None:
        self.assertTrue(self.block, "app.js 里找不到 PANEL_FRESHNESS 区块")
        self.assertIn("async function checkPanelFreshness()", self.block)
        self.assertIn("function panelVersionOf(text)", self.block)
        self.assertIn("PANEL_FRESHNESS_DELAY_MS", self.block)

    def test_reads_served_entry_document(self) -> None:
        self.assertIn("'index.html?_='", self.block)
        self.assertIn("cache: 'no-store'", self.block)
        self.assertIn("panel-version", self.block)

    def test_does_not_touch_palette(self) -> None:
        for forbidden in ("applyTheme(", "savePalette(", "callPlugin(", "state.edited",
                          "syncRow(", "renderPreview("):
            self.assertNotIn(forbidden, self.block, forbidden)

    def test_reload_is_guarded(self) -> None:
        self.assertIn("nts.panel.refreshed.", self.block)
        self.assertIn("sessionStorage", self.block)
        self.assertIn("window.location.replace('index.html?v=' + Date.now())", self.block)
        # 先弹提示、再延迟重载，避免「页面突然一黑」
        self.assertLess(self.block.find("showNotice("), self.block.find("location.replace("))

    def test_bootstrap_schedules_check(self) -> None:
        self.assertIn("setTimeout(checkPanelFreshness, PANEL_FRESHNESS_DELAY_MS);", self.app)
        anchor = self.app.find("  bootstrap();\n  // 面板起来以后再查一次版本")
        self.assertGreater(anchor, 0, "自检必须挂在 bootstrap() 之后（否则首屏白等）")

    def test_version_element_exists_in_html(self) -> None:
        html = INDEX_HTML.read_text(encoding="utf-8")
        self.assertIn('id="panel-version"', html)
        self.assertRegex(html, r'id="panel-version"[^>]*>[^<]*v\d+\.\d+\.\d+')

    def test_selftest_registered(self) -> None:
        self.assertTrue(SELFTEST.is_file(), "缺少 test/freshness-selftest.js")
        selftest = SELFTEST.read_text(encoding="utf-8")
        self.assertIn("PANEL_FRESHNESS_BEGIN", selftest)
        self.assertIn("PASS ", selftest)
        self.assertIn("test/freshness-selftest.js", CI.read_text(encoding="utf-8"))
        self.assertIn("freshness-selftest.js", README.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录")
