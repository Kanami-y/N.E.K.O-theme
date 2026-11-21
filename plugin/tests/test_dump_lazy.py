"""v0.4.21：当前调色板 JSON「折叠时惰性重建」的接线与回归测试。

真实行为（折叠跳过 / 展开补渲染 / 复制前重建）由 ``test/dump-selftest.js``
用假 DOM + 假 localStorage 跑；这里锁的是外围容易漏的东西：
版本号、块标记、闸门位置、文案 bug 不再回归、a11y 属性、CI 与自测登记。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = ROOT / "plugin" / "static" / "app.js"
INDEX = ROOT / "plugin" / "static" / "index.html"
SELFTEST = ROOT / "test" / "dump-selftest.js"
CI = ROOT / ".github" / "workflows" / "ci.yml"
README = ROOT / "test" / "README.md"
PLUGIN_TOML = ROOT / "plugin" / "plugin.toml"
BUILD_INFO = ROOT / "plugin" / "build_info.py"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class VersionTests(unittest.TestCase):
    def test_version_sources_agree(self):
        # 不钉死字面版本号（每轮都 bump）；只锁「plugin.toml 是唯一版本源」。
        match = re.search(r'^version = "([^"]+)"', read(PLUGIN_TOML), re.M)
        self.assertIsNotNone(match)
        version = match.group(1)
        self.assertIn('PLUGIN_VERSION = "%s"' % version, read(BUILD_INFO))
        self.assertIn('?v=%s-' % version, read(INDEX))

    def test_loader_version_is_single_sourced(self):
        # 不钉死字面版本号（每轮 bump 会顶掉它）。这里锁「loader 只有一份版本源，
        # 三份副本必须一致」——这才是真正会静默出错的地方。
        loader = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
        match = re.search(r"var SCRIPT_VERSION = '(\d+\.\d+\.\d+)';", read(loader))
        self.assertIsNotNone(match, "loader 里找不到 SCRIPT_VERSION")
        version = match.group(1)
        for mirror in ("app/neko-theme-studio.js", "app-patch/files/neko-theme-studio.js"):
            with self.subTest(mirror=mirror):
                self.assertIn("var SCRIPT_VERSION = '%s';" % version,
                              read(ROOT / mirror))


class BlockTests(unittest.TestCase):
    def test_markers_present_and_ordered(self):
        src = read(APP_JS)
        begin = src.index("/* ===== DUMP_LAZY_BEGIN ===== */")
        end = src.index("/* ===== DUMP_LAZY_END ===== */")
        self.assertLess(begin, end)
        self.assertIn("var DUMP_COLLAPSE_KEY = 'nts.dump.collapsed';", src[begin:end])
        self.assertIn("var dumpState = { collapsed: false, dirty: false, renders: 0, skipped: 0 };", src[begin:end])

    def test_dump_lazy_plan_is_pure(self):
        src = read(APP_JS)
        head = src.index("function dumpLazyPlan(collapsed, dirty) {")
        body = src[head:head + 400]
        self.assertIn("if (!collapsed) return 'render';", body)
        self.assertIn("return 'skip';", body)
        # 纯函数：不碰 DOM / 存储
        for forbidden in ("$(", "localStorage", "document.", "renderDump("):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, body.split("}")[0])

    def test_block_defined_before_render_dump(self):
        src = read(APP_JS)
        self.assertLess(src.index("/* ===== DUMP_LAZY_BEGIN ===== */"), src.index("function renderDump(force) {"))


class GateTests(unittest.TestCase):
    def test_gate_is_before_stringify(self):
        src = read(APP_JS)
        head = src.index("function renderDump(force) {")
        body = src[head:head + 1500]
        self.assertLess(body.index("dumpLazyPlan("), body.index("JSON.stringify("))

    def test_skip_marks_dirty_and_counts(self):
        src = read(APP_JS)
        head = src.index("function renderDump(force) {")
        body = src[head:head + 900]
        self.assertIn("dumpState.dirty = true;", body)
        self.assertIn("dumpState.skipped += 1;", body)
        self.assertRegex(body, r"dumpState\.skipped \+= 1;\s*\r?\n\s*return;")

    def test_render_counts_after_gate(self):
        src = read(APP_JS)
        head = src.index("function renderDump(force) {")
        body = src[head:head + 900]
        self.assertIn("dumpState.dirty = false;", body)
        self.assertIn("dumpState.renders += 1;", body)

    def test_copy_forces_render(self):
        src = read(APP_JS)
        head = src.index("function copyDump() {")
        body = src[head:head + 500]
        self.assertIn("renderDump(true);", body)
        self.assertLess(body.index("renderDump(true);"), body.index("copyText("))

    def test_expanding_rerenders_only_when_dirty(self):
        src = read(APP_JS)
        head = src.index("function toggleDumpCard() {")
        body = src[head:head + 320]
        self.assertIn("if (!dumpState.collapsed && dumpState.dirty) renderDump(true);", body)


class FooterTextTests(unittest.TestCase):
    def test_footer_no_longer_lies(self):
        src = read(APP_JS)
        self.assertIn("上面的 JSON 已经按改动后的样子生成", src)
        self.assertNotIn("上面的 JSON 不含它们", src)
        self.assertIn("点「应用」才会写进服务器", src)

    def test_json_really_includes_pending_edits(self):
        # 脚注说法要对，前提是 payload 用的是 effectiveVars（含未应用改动）。
        src = read(APP_JS)
        head = src.index("function renderDump(force) {")
        body = src[head:head + 1500]
        self.assertIn("vars: effectiveVars('light')", body)
        self.assertIn("dark_vars: effectiveVars('dark')", body)


class AccessibilityTests(unittest.TestCase):
    def test_toggle_button_markup(self):
        html = read(INDEX)
        self.assertIn('id="btn-toggle-dump" aria-expanded="true" aria-controls="dump-body"', html)
        self.assertRegex(html, r'id="btn-toggle-dump"[^>]*aria-label="[^"]+"')
        self.assertIn('<div id="dump-body">', html)

    def test_toggle_reflects_state(self):
        src = read(APP_JS)
        head = src.index("function applyDumpCollapsed() {")
        body = src[head:head + 700]
        self.assertIn("setAttribute('aria-expanded', dumpState.collapsed ? 'false' : 'true')", body)
        self.assertIn("body.hidden = dumpState.collapsed;", body)
        self.assertIn("btn.textContent = dumpState.collapsed ? '▸' : '▾';", body)

    def test_group_toggle_sets_aria_expanded(self):
        src = read(APP_JS)
        head = src.index("function updateGroupToggleLabel() {")
        body = src[head:head + 500]
        self.assertIn("setAttribute('aria-expanded', collapsed ? 'false' : 'true')", body)
        self.assertIn("if (!btn) return;", body)

    def test_live_regions(self):
        html = read(INDEX)
        self.assertIn('id="audit-summary" role="status" aria-live="polite" aria-atomic="true"', html)
        self.assertIn('id="schedule-now" role="status" aria-live="polite"', html)


class WiringTests(unittest.TestCase):
    def test_bootstrap_loads_collapsed_state(self):
        src = read(APP_JS)
        boot = src.index("function bootstrap() {")
        self.assertGreater(src.index("dumpState.collapsed = loadDumpCollapsed();"), boot)
        self.assertLess(src.index("dumpState.collapsed = loadDumpCollapsed();"),
                        src.index("buildEditor();", boot))

    def test_button_wired(self):
        src = read(APP_JS)
        self.assertRegex(src, r"\$\('btn-toggle-dump'\)\) \$\('btn-toggle-dump'\)\.addEventListener\('click', toggleDumpCard\)")

    def test_debug_hooks(self):
        src = read(APP_JS)
        for hook in ("dumpState: dumpState,", "dumpLazyPlan: dumpLazyPlan,",
                     "toggleDumpCard: toggleDumpCard,", "applyDumpCollapsed: applyDumpCollapsed,"):
            with self.subTest(hook=hook):
                self.assertIn(hook, src)


class TestInfrastructureTests(unittest.TestCase):
    def test_selftest_exists_and_runs_real_logic(self):
        src = read(SELFTEST)
        self.assertIn("DUMP_LAZY_BEGIN", src)
        self.assertIn("new Function(", src)
        self.assertIn("PASS ", src)
        # 不能只是 grep 源码：必须真的调用 toggleDumpCard 并断言渲染次数
        self.assertIn("api.toggleDumpCard();", src)
        self.assertIn("env.renders.length", src)

    def test_selftest_registered_in_ci(self):
        self.assertIn("test/dump-selftest.js", read(CI))

    def test_selftest_registered_in_readme(self):
        self.assertIn("dump-selftest.js", read(README))


if __name__ == "__main__":
    unittest.main()
