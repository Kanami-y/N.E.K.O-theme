"""待应用改动清单（v0.5.1 / F1）的接线回归。

纯函数与渲染面在 ``test/changes-selftest.js`` 里真跑（假 DOM / 假状态），这里只锁
「三处源码必须长得像这样」，防止以后重构时把卡片、接线或调试钩子弄丢：

* ``index.html`` 有卡片骨架（默认 ``hidden``，三个 id + 全部撤销按钮）；
* ``app.js`` 有 CHANGES 段、``renderChanges()`` 挂在 ``updateButtons()`` 末尾
  （而**不在** ``flushEditorGlobals()`` 里 —— 那段会被 editor-selftest 抠到假环境跑）；
* ``style.css`` 有清单样式；CI 与 ``test/README.md`` 都登记了这个自测脚本。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
HTML = (ROOT / "plugin" / "static" / "index.html").read_text(encoding="utf-8")
CSS = (ROOT / "plugin" / "static" / "style.css").read_text(encoding="utf-8")
CI = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
README = (ROOT / "test" / "README.md").read_text(encoding="utf-8")


class MarkupTests(unittest.TestCase):
    def test_card_skeleton(self) -> None:
        self.assertIn('id="changes-card"', HTML)
        self.assertIn('id="changes-list"', HTML)
        self.assertIn('id="changes-count"', HTML)
        self.assertIn('id="btn-revert-all"', HTML)
        self.assertIn('aria-label="待应用的改动"', HTML)
        # 没有改动时不该占版面：默认 hidden 由 renderChanges 控制
        self.assertRegex(HTML, r'id="changes-card"[^>]*hidden')

    def test_card_sits_above_palette_card(self) -> None:
        # 用「当前调色板」卡的按钮定位（"当前调色板" 这个词在仓库卡的 title 里也出现过）
        self.assertLess(
            HTML.index('id="changes-card"'),
            HTML.index('id="btn-css-snippet"'),
            "改动清单应该放在「当前调色板」卡之前，先看到改了什么再看 JSON",
        )


class AppWiringTests(unittest.TestCase):
    def test_block_markers(self) -> None:
        begin = APP.index("/* ===== CHANGES_BEGIN")
        end = APP.index("/* ===== CHANGES_END =====")
        self.assertLess(begin, end)
        block = APP[begin:end]
        for symbol in (
            "function changeEntryList(",
            "function pendingChangeList(",
            "function revertChange(",
            "function revertAllChanges(",
            "function renderChanges(",
        ):
            self.assertIn(symbol, block)

    def test_entry_list_is_pure(self) -> None:
        # 纯函数只读快照参数，不碰 state / DOM —— 否则就没法在假环境里测
        begin = APP.index("function changeEntryList(")
        nxt = APP.index("\nfunction ", begin + 10)
        body = APP[begin:nxt]
        self.assertIn("snapshot || {}", body)
        self.assertNotIn("document.", body)
        self.assertNotIn("state.", body)

    def test_render_after_buttons(self) -> None:
        at = APP.index("function updateButtons(")
        body = APP[at:at + 1600]
        self.assertRegex(body, r"renderChanges\(\);")
        self.assertLess(body.index("node.disabled = state.busy"), body.index("renderChanges();"))

    def test_not_in_flush_editor_globals(self) -> None:
        at = APP.index("function flushEditorGlobals(")
        body = APP[at:at + 700]
        self.assertNotIn("renderChanges", body)

    def test_wire_and_hooks(self) -> None:
        self.assertIn("$('btn-revert-all').addEventListener('click', revertAllChanges)", APP)
        for hook in (
            "pendingChangeList: pendingChangeList",
            "changeEntryList: changeEntryList",
            "renderChanges: renderChanges",
            "revertChange: revertChange",
            "revertAllChanges: revertAllChanges",
        ):
            self.assertIn(hook, APP)

    def test_revert_does_not_apply(self) -> None:
        """撤销只改本地状态，绝不偷偷提交到服务器。"""
        at = APP.index("function revertChange(")
        body = APP[at:at + 900]
        for forbidden in ("applyTheme(", "savePalette(", "callPlugin("):
            self.assertNotIn(forbidden, body)

    def test_all_revert_confirms(self) -> None:
        at = APP.index("function revertAllChanges(")
        body = APP[at:at + 1200]
        self.assertIn("window.confirm(", body)
        self.assertIn("markAllRowsValid()", body)
        self.assertIn("syncAll()", body)


class StyleAndRegistryTests(unittest.TestCase):
    def test_css(self) -> None:
        for selector in (".changes-card", ".changes-list", ".change-row", ".change-mode",
                         ".change-label", ".change-delta", ".change-undo"):
            self.assertIn(selector, CSS)

    def test_selftest_registered(self) -> None:
        self.assertIn("'test/changes-selftest.js'", CI)
        self.assertIn("changes-selftest.js", README)
        self.assertTrue((ROOT / "test" / "changes-selftest.js").is_file())


if __name__ == "__main__":
    unittest.main()
