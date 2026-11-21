"""批次一（v0.10.0）接线回归：撤销/重做、单行复制粘贴、悬停对比卡、AI 提示词。

行为面在 ``test/batch1-selftest.js`` 里真跑（抠源码 + 假 DOM / 假状态，47 条断言），
这里只锁「源码必须长得像这样」，防止以后重构时把按钮、快捷键、区块或调试钩子弄丢：

* ``app.js`` 有 UNDO 段与 BATCH1 段，且 ``markEdited`` / ``markCleared`` 会记快照；
* 应用成功后清空撤销栈（未应用阶段的撤销才有意义）；
* ``index.html`` 有撤销 / 重做 / AI 按钮与对比卡骨架，``style.css`` 有对应样式；
* CI 与 ``test/README.md`` 都登记了 ``test/batch1-selftest.js``；
* 源码里**没有三反引号**（面板自测的 ES5 断言会抓，改用 ``String.fromCharCode``）。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = Path(__file__).resolve().parents[1]
HAS_REPO_TREE = (ROOT / "tools").is_dir()

def repo_text(*parts: str) -> str:
    """读仓库级文件；市场校验环境没有仓库树时返回空串（对应测试由 setUpModule 跳过）。"""
    path = ROOT.joinpath(*parts)
    return path.read_text(encoding="utf-8") if path.is_file() else ""

APP = (PLUGIN_DIR / "static" / "app.js").read_text(encoding="utf-8")
HTML = (PLUGIN_DIR / "static" / "index.html").read_text(encoding="utf-8")
CSS = (PLUGIN_DIR / "static" / "style.css").read_text(encoding="utf-8")
CI = repo_text(".github", "workflows", "ci.yml")
README = repo_text("test", "README.md")


class BlockTests(unittest.TestCase):
    def test_undo_block_present(self) -> None:
        self.assertIn("/* ===== UNDO_BEGIN", APP)
        self.assertIn("/* ===== UNDO_END ===== */", APP)
        self.assertIn("var undoState = {", APP)
        for name in ("undoPush", "undoStep", "redoStep", "updateUndoButtons", "initUndoShortcuts"):
            self.assertIn("function " + name + "(", APP)

    def test_batch1_block_present(self) -> None:
        self.assertIn("/* ===== BATCH1_BEGIN", APP)
        self.assertIn("/* ===== BATCH1_END ===== */", APP)
        for name in ("copyRowValue", "pasteRowValue", "comparePairs", "renderCompare",
                     "buildAiPrompt", "copyAiPrompt"):
            self.assertIn("function " + name + "(", APP)

    def test_undo_limits(self) -> None:
        self.assertIn("limit: 50", APP)
        self.assertIn("undoState.past.shift()", APP)

    def test_coalesce_same_row(self) -> None:
        # 同一行 900ms 内只压一次栈，否则每敲一个字就是一步撤销
        self.assertRegex(APP, r"undoState\.lastKey === key[^\n]*900")

    def test_edits_take_snapshot(self) -> None:
        self.assertRegex(APP, r"function markEdited\(key, value\) \{\r?\n  undoPush\(key\);")
        self.assertRegex(APP, r"function markCleared\(key\) \{\r?\n  undoPush\(key\);")

    def test_apply_clears_history(self) -> None:
        self.assertRegex(APP, r"undoState\.past = \[\];[\s\S]{0,200}undoState\.future = \[\];")

    def test_shortcuts_skip_typing_targets(self) -> None:
        self.assertIn("initUndoShortcuts", APP)
        self.assertIn("Ctrl", APP)
        self.assertRegex(APP, r"tag === 'input' \|\| tag === 'textarea'")

    def test_paste_reuses_validator(self) -> None:
        self.assertIn("isSafeValue(item.key", APP)
        self.assertIn("normalizeTypedValue(item, text", APP)

    def test_compare_keys_are_real_catalog_keys(self) -> None:
        # 只在 COMPARE_KEYS 自己那段里找，别被后面的 VARIANT_TEXT_PAIRS 之类误伤
        start = APP.index("var COMPARE_KEYS = [")
        end = APP.index("];", start)
        segment = APP[start:end]
        keys = re.findall(r"\['(--nts-[a-z0-9-]+)', '", segment)
        self.assertGreaterEqual(len(keys), 6)
        # 对比卡只挑关键面，不该把 97 个变量全列出来
        self.assertLess(len(keys), 20)
        for key in keys:
            self.assertIn("key: '" + key + "'", APP)

    def test_reload_discard_clears_undo_stack(self) -> None:
        # 「重新读取」丢弃改动后，撤销栈必须一起清空，否则 Ctrl+Z 会把丢弃的改动还原
        start = APP.index("async function reloadPalette(")
        end = APP.index("async function", start + 30)
        segment = APP[start:end]
        self.assertIn("if (discardEdits) {", segment)
        self.assertIn("undoState.past.length = 0;", segment)
        self.assertIn("undoState.future.length = 0;", segment)
        self.assertIn("updateUndoButtons();", segment)

    def test_prompt_uses_fence_helper(self) -> None:
        self.assertIn("var FENCE = String.fromCharCode(96, 96, 96);", APP)
        self.assertIn("FENCE + 'json'", APP)


class MarkupTests(unittest.TestCase):
    def test_buttons(self) -> None:
        self.assertIn('id="btn-undo"', HTML)
        self.assertIn('id="btn-redo"', HTML)
        self.assertIn('id="btn-ai-prompt"', HTML)

    def test_compare_bones(self) -> None:
        self.assertIn('id="pv-compare"', HTML)
        self.assertIn('id="pv-compare-rows"', HTML)
        self.assertIn('id="pv-compare" hidden', HTML)

    def test_row_extra_keeps_five_columns(self) -> None:
        # 复制 / 粘贴 / 清空塞进同一个 .row-extra，不能多开一列（否则所有输入框宽度重算）
        self.assertIn("class: 'row-extra'", APP)
        self.assertEqual(APP.count("rowExtra"), 3)

    def test_styles(self) -> None:
        for selector in (".row-extra", ".row-icon", ".pv-compare", ".pv-compare-row",
                         ".pv-chip-sw", ".pv-compare-arrow"):
            self.assertIn(selector, CSS)


class RegistrationTests(unittest.TestCase):
    def test_ci_runs_selftest(self) -> None:
        self.assertIn("'test/batch1-selftest.js'", CI)

    def test_readme_mentions_selftest(self) -> None:
        self.assertIn("batch1-selftest.js", README)

    def test_no_template_literals(self) -> None:
        # 面板自测会先 stripComments 再断言无反引号；连字符串字面量里也不行
        self.assertNotIn(chr(96) * 3, APP)


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
