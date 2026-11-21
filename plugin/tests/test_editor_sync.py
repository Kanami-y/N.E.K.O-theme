"""编辑区刷新合并（v0.4.17）的接线与回归测试。

背景：`syncRow()` 以前每次调用都要在末尾重算分组计数 / 预览 / JSON dump / 按钮
状态 —— `syncAll()` 遍历 95 行就是 96 遍，逐键输入是每字符一遍。v0.4.17 把全局
刷新拆成 `flushEditorGlobals()`，由 `editorSyncPlan(opts)` 决定 immediate /
deferred / none，逐键输入合并到下一帧。

这些测试锁的是「接线」：一旦有人把 oninput 改回立刻刷新、或把 syncAll 的
silent 去掉（等于把 96 遍重活恢复回来），这里会红。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # plugin/tests/ -> 仓库根
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
EDITOR_SELFTEST = ROOT / "test" / "editor-selftest.js"
CI = ROOT / ".github" / "workflows" / "ci.yml"
TEST_README = ROOT / "test" / "README.md"


class EditorSyncBlockTests(unittest.TestCase):
    def test_block_markers_exist(self) -> None:
        self.assertIn("/* ===== EDITOR_SYNC_BEGIN ===== */", APP_JS)
        self.assertIn("/* ===== EDITOR_SYNC_END ===== */", APP_JS)
        begin = APP_JS.index("/* ===== EDITOR_SYNC_BEGIN ===== */")
        end = APP_JS.index("/* ===== EDITOR_SYNC_END ===== */")
        self.assertLess(begin, end)
        block = APP_JS[begin:end]
        for name in (
            "function editorSyncPlan(opts)",
            "function nextFrame(fn)",
            "function flushEditorGlobals()",
            "function scheduleEditorGlobals()",
        ):
            self.assertIn(name, block, f"{name} 必须在 EDITOR_SYNC 区里")

    def test_state_declared_before_block(self) -> None:
        state_at = APP_JS.index("var editorSyncState = ")
        begin = APP_JS.index("/* ===== EDITOR_SYNC_BEGIN ===== */")
        self.assertLess(state_at, begin)
        self.assertIn("pending", APP_JS[state_at:state_at + 200])
        self.assertIn("flushes", APP_JS[state_at:state_at + 200])

    def test_flush_does_the_four_globals(self) -> None:
        body = APP_JS.split("function flushEditorGlobals()")[1].split("function scheduleEditorGlobals()")[0]
        order = [
            body.index("refreshCounts();"),
            body.index("renderPreview();"),
            body.index("renderDump();"),
            body.index("updateButtons();"),
        ]
        self.assertEqual(order, sorted(order), "四件套顺序应与旧实现一致")
        self.assertIn("if (state.onlyDirty) applyFilters();", body)

    def test_schedule_is_coalesced(self) -> None:
        body = APP_JS.split("function scheduleEditorGlobals()")[1].split("/* ===== EDITOR_SYNC_END")[0]
        self.assertIn("if (editorSyncState.pending) return;", body)
        self.assertIn("editorSyncState.pending = true;", body)
        self.assertIn("nextFrame(flushEditorGlobals);", body)

    def test_no_interval_based_editor_sync(self) -> None:
        block = APP_JS[
            APP_JS.index("/* ===== EDITOR_SYNC_BEGIN ===== */"):
            APP_JS.index("/* ===== EDITOR_SYNC_END ===== */")
        ]
        self.assertNotIn("setInterval", block)
        self.assertNotIn("setTimeout(fn, 0)", block)


class SyncRowWiringTests(unittest.TestCase):
    def test_sync_row_dispatches_by_plan(self) -> None:
        body = APP_JS.split("function syncRow(key, opts)")[1].split("function syncAll()")[0]
        self.assertIn("var plan = editorSyncPlan(opts);", body)
        self.assertIn("if (plan === 'immediate') flushEditorGlobals();", body)
        self.assertIn("else if (plan === 'deferred') scheduleEditorGlobals();", body)
        # 旧的四件套不能再直接出现在 syncRow 里
        self.assertNotIn(
            "refreshCounts();\n  renderPreview();\n  renderDump();\n  updateButtons();",
            body,
        )

    def test_sync_all_is_silent_then_flushes_once(self) -> None:
        self.assertIn(
            "Object.keys(rowsByKey).forEach(function (key) {\n    syncRow(key, { silent: true });\n  });",
            APP_JS,
        )
        body = APP_JS.split("function syncAll()")[1].split("function refreshCounts()")[0]
        self.assertEqual(body.count("flushEditorGlobals();"), 1)
        # 收尾四件套已经并进 flush，不能重复调用
        self.assertNotIn("renderDump();", body)
        self.assertNotIn("renderPreview();", body)

    def test_typing_paths_are_deferred(self) -> None:
        self.assertEqual(
            len(re.findall(r"syncRow\(item\.key, \{ keepHex: true, defer: true \}\);", APP_JS)), 3
        )
        self.assertEqual(
            len(re.findall(r"syncRow\(item\.key, \{ keepText: true, defer: true \}\);", APP_JS)), 3
        )
        self.assertGreaterEqual(
            len(re.findall(r"syncRow\(item\.key, \{ defer: true \}\);", APP_JS)), 3
        )
        # 透明度滑块：两处（无 RGB 记忆 / 正常拖动）
        self.assertIn("if (!rgb) { syncRow(item.key, { defer: true }); return; }", APP_JS)
        # 未合并的旧调用不能残留
        self.assertNotIn("syncRow(item.key, { keepHex: true });", APP_JS)
        self.assertNotIn("syncRow(item.key, { keepText: true });", APP_JS)

    def test_picker_input_is_deferred(self) -> None:
        seg = APP_JS.split("colorInput.addEventListener('input', function () {")[1][:600]
        self.assertIn("syncRow(item.key, { defer: true });", seg)

    def test_commit_paths_stay_immediate(self) -> None:
        """失焦定稿、清空、上传背景图、审计跳转都必须立刻刷全局。"""
        self.assertIn("onchange: function () {", APP_JS)
        onchange_seg = APP_JS.split("onchange: function () {")[1][:1400]
        self.assertIn("syncRow(item.key);", onchange_seg)
        # 至少 8 处「立刻刷新」的调用点还在（清空按钮 x2、onchange、上传图片…）
        self.assertGreaterEqual(len(re.findall(r"syncRow\(item\.key\);", APP_JS)), 8)


class DebugHookTests(unittest.TestCase):
    def test_panel_exposes_sync_state(self) -> None:
        # 取到 state: state 为止，而不是写死 600 字符：钩子会随版本增长，
        # 固定窗口会让「加了几个新钩子」把老断言挤出去（v0.4.26 就这样红过一次）。
        seg = APP_JS.split("window.__ntsPanel = window.__ntsPanel || {")[1].split("state: state,")[0]
        self.assertIn("editorSyncState: editorSyncState", seg)
        self.assertIn("editorSyncPlan: editorSyncPlan", seg)
        self.assertIn("flushEditorGlobals: flushEditorGlobals", seg)
        self.assertIn("scheduleEditorGlobals: scheduleEditorGlobals", seg)


class TestInfrastructureTests(unittest.TestCase):
    def test_selftest_file_exists(self) -> None:
        self.assertTrue(EDITOR_SELFTEST.is_file())
        src = EDITOR_SELFTEST.read_text(encoding="utf-8")
        self.assertIn("EDITOR_SYNC_BEGIN", src)
        self.assertIn("requestAnimationFrame", src)
        # 自测必须真的跑合并，而不是只做 grep
        self.assertIn("h3.api.scheduleEditorGlobals();", src)

    def test_ci_runs_it(self) -> None:
        self.assertIn("test/editor-selftest.js", CI.read_text(encoding="utf-8"))

    def test_readme_lists_it(self) -> None:
        self.assertIn("editor-selftest.js", TEST_README.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
