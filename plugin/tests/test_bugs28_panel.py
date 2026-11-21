"""Round 28 面板修复的接线断言（审计 P1-1 ~ P1-6 + 3 条 P2）。

这些断言都是「源码级」的：面板行为大多要真 DOM 才能跑，但**接线漏了**是最常见的
回归方式（改完函数忘了接按钮、清脏写在刷新之前、把监听器直接当回调传）。所以这里
只锁结构，行为由 `test/panel-selftest.js` 与 `test/sync-selftest.js` 覆盖。
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = (ROOT / "plugin" / "static" / "app.js")
CSS = (ROOT / "plugin" / "static" / "style.css")


class PanelP1Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.js = APP.read_text(encoding="utf-8")

    # ---------------------------------------------------------------- P1-1
    def test_apply_theme_resyncs_after_clearing_edits(self) -> None:
        body = self.js
        clear = body.index("state.edited = { light: {}, dark: {} };")
        # 清脏之后的第一次 reloadPalette 调用附近必须补一次 syncAll()
        window = body[clear: clear + 900]
        self.assertIn("syncAll();", window, "应用成功后清脏必须再同步一次，否则行上还挂着「已改」")

    # ---------------------------------------------------------------- P1-4
    def test_reload_asks_before_discarding(self) -> None:
        self.assertIn("var pending = pendingChangeCount();", self.js)
        self.assertIn("window.confirm('面板里有 '", self.js)
        self.assertIn("reloadPalette({ discardEdits: true }).then(", self.js)
        self.assertIn("丢弃了 ' + pending + ' 项未应用的改动", self.js)

    # ---------------------------------------------------------------- P1-2
    def test_delete_failure_restores_button(self) -> None:
        self.assertIn("button.classList.remove('is-confirm');", self.js)
        self.assertIn("button.textContent = '删除';", self.js)
        # 还原必须发生在 catch 分支里（而不是 finally 里无差别还原）
        catch_at = self.js.index("} catch (error) {\n    // 按钮在第")
        restore_at = self.js.index("button.disabled = false;", catch_at)
        self.assertLess(catch_at, restore_at)

    # ---------------------------------------------------------------- P1-3
    def test_schedule_dirty_machinery(self) -> None:
        for name in ("markScheduleDirty", "clearScheduleDirty", "updateScheduleDirtyHint"):
            self.assertIn("function " + name + "(", self.js, f"缺少 {name}()")
        self.assertIn("dirty: false,", self.js)
        self.assertIn("if (selects[i].dataset.dirty === '1') continue;", self.js)
        self.assertIn("this.dataset.dirty = '1';", self.js)
        self.assertIn("clearScheduleDirty();", self.js)
        self.assertIn("button.classList.toggle('is-dirty'", self.js)

    def test_schedule_toggles_cannot_overwrite_dirty_state(self) -> None:
        self.assertIn("if (weekendBox && weekendBox.dataset.dirty !== '1') {", self.js)
        self.assertIn("if (enabled && enabled.dataset.dirty !== '1') {", self.js)

    def test_enabled_toggle_is_wired_at_all(self) -> None:
        self.assertIn("if ($('schedule-enabled')) {", self.js)
        self.assertIn("$('schedule-enabled').addEventListener('change'", self.js)

    def test_dirty_style_exists(self) -> None:
        css = CSS.read_text(encoding="utf-8")
        self.assertIn(".btn.is-dirty", css)

    # ---------------------------------------------------------------- P1-5
    def test_health_check_is_read_only(self) -> None:
        self.assertIn("return callPlugin('repair_app', { dry_run: true })", self.js)
        self.assertNotIn("return callPlugin('repair_app', {})", self.js)

    def test_health_card_reports_diagnosis_fields(self) -> None:
        for field in ("assets_missing", "templates_missing", "templates_stale", "dry_run"):
            self.assertIn("diag." + field, self.js, f"健康卡没有展示 {field}")

    # ---------------------------------------------------------------- P1-6
    def test_content_hash_signature(self) -> None:
        self.assertIn("function hashText(text) {", self.js)
        self.assertIn("key + '\\u0000' + String(map[key])", self.js)
        self.assertIn("function paletteSignature(p) {", self.js)
        self.assertNotIn("String(p.updated_at || '') + '|' + light", self.js)

    def test_sync_failures_surface(self) -> None:
        self.assertIn("function noteExternalSyncFailure() {", self.js)
        self.assertIn("externalSyncState.warned = true;", self.js)
        self.assertIn("externalSyncState.warned = false;", self.js)
        self.assertIn("externalSyncState.failures < 3", self.js)
        self.assertNotIn("externalSyncState.failures += 1; return false;", self.js)

    # ---------------------------------------------------------------- P2
    def test_theme_name_input_does_not_pass_event_as_force(self) -> None:
        self.assertNotIn("$('theme-name').addEventListener('input', renderDump);", self.js)
        self.assertIn("$('theme-name').addEventListener('input', function () {", self.js)

    def test_busy_disables_every_interactive_control(self) -> None:
        for name in ("'pickBtn'", "'clearImageBtn'", "'switchInput'", "'selectInput'"):
            self.assertIn(name, self.js, f"busy 时没有禁用 {name}")

    def test_copy_failure_keeps_modal_open(self) -> None:
        self.assertIn("文本已选中 —— 按 Ctrl+C 手动复制", self.js)
        block = self.js[self.js.index("文本已选中 —— 按 Ctrl+C 手动复制") - 400:]
        self.assertNotIn("closeModal();", block[:120], "复制失败这一支不能关弹窗")


if __name__ == "__main__":
    unittest.main()
