"""面板「可读性自检」（0.4.9）的契约测试。

不启动浏览器：只断言三端接线是否齐全、阈值口径是否与后端/脚本一致、
以及审计用到的每个变量都真的在 KNOWN_VARS 里（防止面板算了半天空值）。
"""

from __future__ import annotations

import re
import unittest

from offline_backend import ROOT, load_backend

PANEL = ROOT / "plugin" / "static"
APP_JS = (PANEL / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (PANEL / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (PANEL / "style.css").read_text(encoding="utf-8")


def _read_pairs_block() -> str:
    start = APP_JS.index("var READ_PAIRS = [")
    end = APP_JS.index("];", start) + 2
    return APP_JS[start:end]


class AuditContractTests(unittest.TestCase):
    """11 组对比度检查的存在性与口径。"""

    def test_eleven_pairs(self) -> None:
        block = _read_pairs_block()
        names = re.findall(r"name:\s*'([^']+)'", block)
        self.assertEqual(len(names), 11, names)
        self.assertIn("正文 / 聊天背景", names)
        self.assertIn("用户气泡文字", names)
        self.assertIn("发送键文字", names)
        self.assertIn("链接 / 聊天背景", names)

    def test_thresholds_match_wcag(self) -> None:
        block = _read_pairs_block()
        needs = [float(x) for x in re.findall(r"need:\s*([0-9.]+)", block)]
        self.assertEqual(needs.count(4.5), 7, needs)
        self.assertEqual(needs.count(3.0), 4, needs)

    def test_pair_keys_are_known_vars(self) -> None:
        known = set(load_backend()["KNOWN_VARS"])
        block = _read_pairs_block()
        keys = re.findall(r"(?:fg|bg):\s*'(--nts-[a-z0-9-]+)'", block)
        self.assertEqual(len(keys), 11, keys)  # 11 组前景变量；bg 是别名（chat/surface/...）
        for key in keys:
            self.assertIn(key, known, f"{key} 不在 KNOWN_VARS 里")

    def test_background_aliases_are_resolved(self) -> None:
        # bg 字段是别名（chat/surface/input/glass/ai/user/chip/send），必须在 auditRowsForMode 里都有分支
        for alias in ("chat", "surface", "input", "glass", "ai", "user", "chip", "send"):
            self.assertIn(f"{alias}: ", APP_JS, f"缺少背景别名 {alias}")


class AuditWiringTests(unittest.TestCase):
    """纯函数、渲染、跳转与三端接线。"""

    def test_pure_functions_exist(self) -> None:
        for fn in ("colorOver", "colorLuma", "contrastRatio", "gradientMidColor",
                   "valueForMode", "auditRowsForMode", "renderAudit", "jumpToAuditRow"):
            self.assertIn("function " + fn + "(", APP_JS, fn)

    def test_rendered_into_panel(self) -> None:
        self.assertIn('id="btn-audit"', INDEX_HTML)
        self.assertIn('id="audit-list"', INDEX_HTML)
        self.assertIn('id="audit-summary"', INDEX_HTML)
        self.assertIn("$('btn-audit').addEventListener", APP_JS)
        self.assertIn("renderAudit(true)", APP_JS)  # bootstrap 预扫
        self.assertIn(".audit-item", STYLE_CSS)

    def test_jump_clears_filter_and_flashes_row(self) -> None:
        start = APP_JS.index("function jumpToAuditRow(")
        body = APP_JS[start:start + 1200]
        self.assertIn("setFilter('')", body)
        self.assertIn("setOnlyDirty(false)", body)
        self.assertIn("is-flash", body)
        self.assertIn("scrollIntoView", body)


class AutoFixTests(unittest.TestCase):
    """0.4.10 一键修正：纯函数、按钮接线、只填值不提交。"""

    def test_fix_helpers_exist(self) -> None:
        for fn in ("mixToward", "contrastFixColor", "colorToHex", "applyAuditFix", "fixAllAudit"):
            self.assertIn("function " + fn + "(", APP_JS, fn)

    def test_fix_is_idempotent_for_passing_values(self) -> None:
        start = APP_JS.index("function contrastFixColor(")
        body = APP_JS[start:APP_JS.index("function colorToHex(", start)]
        self.assertIn("if (contrastRatio(base, bg) >= need) return null;", body)

    def test_fix_rounds_to_hex_before_judging(self) -> None:
        # 写进输入框的是 #rrggbb：若按浮点判达标，落盘四舍五入后可能又掉回阈值下。
        start = APP_JS.index("function contrastFixColor(")
        body = APP_JS[start:APP_JS.index("function colorToHex(", start)]
        self.assertIn("Math.round(raw.r)", body)
        self.assertIn("Math.round(raw.g)", body)
        self.assertIn("Math.round(raw.b)", body)

    def test_buttons_wired(self) -> None:
        self.assertIn('id="btn-audit-fix"', INDEX_HTML)
        self.assertIn("$('btn-audit-fix')", APP_JS)
        self.assertIn("fixAllAudit()", APP_JS)
        self.assertIn("class: 'btn btn-mini audit-fix'", APP_JS)
        self.assertIn(".audit-fix", STYLE_CSS)

    def test_fix_only_marks_dirty_and_never_applies(self) -> None:
        start = APP_JS.index("function applyAuditFix(")
        body = APP_JS[start:APP_JS.index("function fixAllAudit(", start)]
        self.assertIn("markEdited(row.key, hex)", body)
        self.assertIn("syncRow(row.key)", body)
        # 只填值，绝不能自动提交（没有 applyTheme / savePalette 之类调用）
        self.assertNotIn("applyTheme(", body)
        self.assertNotIn("savePalette(", body)

    def test_fix_rows_carry_resolved_colors(self) -> None:
        start = APP_JS.index("function auditRowsForMode(")
        body = APP_JS[start:APP_JS.index("function jumpToAuditRow(", start)]
        self.assertIn("fg: fg", body)
        self.assertIn("bg: bg", body)


if __name__ == "__main__":
    unittest.main()
