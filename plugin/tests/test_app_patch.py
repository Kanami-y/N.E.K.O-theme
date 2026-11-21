# -*- coding: utf-8 -*-
"""离线测试：``plugin/_app_patch.py`` 里的模板补丁核心。

这个模块会**直接改宿主的 resources/bin/templates/*.html**，是整个插件里最危险的
代码。以前它只有人工在真机上点一遍的验证，没有任何自动化测试；这里把它拆成
「临时目录 + 假模板」的纯离线用例，覆盖插入、幂等、异常模板、跳过条件、备份
失败、写后回滚与 BOM/CRLF 保留。

测试不联网、不起子进程、不碰真实宿主目录：
* ``plugin_root`` 与 ``templates`` 都在 ``tempfile.TemporaryDirectory`` 里；
* 备份目录用 ``NEKO_NTS_BACKUP_DIR`` 指到临时目录，避免写进真实
  ``%LOCALAPPDATA%\\N.E.K.O``。
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import tempfile
import unittest
from unittest import mock

PLUGIN_DIR = pathlib.Path(__file__).resolve().parents[1]


def _load_app_patch():
    """按文件路径加载，避免 import plugin 包时连带拉进插件 SDK。"""
    path = PLUGIN_DIR / "_app_patch.py"
    spec = importlib.util.spec_from_file_location("nts_app_patch_under_test", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


ap = _load_app_patch()

BOM = b"\xef\xbb\xbf"

ANCHOR_LINE = '<link rel="stylesheet" href="/static/css/dark-mode.css?v={{ static_asset_version }}">'


def make_template(extra_before_anchor: str = "", extra_after_anchor: str = "") -> str:
    return (
        "<!doctype html>\n"
        "<html>\n"
        "<head>\n"
        + extra_before_anchor
        + ANCHOR_LINE
        + "\n"
        + extra_after_anchor
        + "</head>\n"
        "<body>hi</body>\n"
        "</html>\n"
    )


class AppPatchTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = pathlib.Path(self._tmp.name)
        self.plugin_root = self.tmp / "plugin"
        (self.plugin_root / "static" / "loader").mkdir(parents=True)
        self.template_dir = self.tmp / "templates"
        self.template_dir.mkdir()
        self.backup_dir = self.tmp / "backup"

        self._env = mock.patch.dict(
            os.environ, {"NEKO_NTS_BACKUP_DIR": str(self.backup_dir)}
        )
        self._env.start()
        ap._BACKUP_ERRORS.clear()

        self.logs: list[tuple[str, str]] = []
        self.result: dict[str, list[str]] = {
            "templates_patched": [],
            "templates_unchanged": [],
            "templates_skipped": [],
            "warnings": [],
        }
        self.block = ap.build_marker_block("aaaaaaaa", "bbbbbbbb")

    def tearDown(self) -> None:
        self._env.stop()
        self._tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def write(self, text: str, name: str = "index.html", bom: bool = False, eol: str = "\n") -> pathlib.Path:
        path = self.template_dir / name
        data = text.replace("\n", eol) if eol != "\n" else text
        payload = data.encode("utf-8")
        if bom:
            payload = BOM + payload
        path.write_bytes(payload)
        return path

    def patch(self, path: pathlib.Path, block: str | None = None) -> None:
        ap._patch_template(path, block or self.block, self.log, self.result, self.plugin_root)

    def text_of(self, path: pathlib.Path) -> str:
        return path.read_text(encoding="utf-8-sig")

    def warnings_text(self) -> str:
        return "\n".join(self.result["warnings"])


class InsertTests(AppPatchTestBase):
    def test_inserts_block_right_after_anchor(self) -> None:
        path = self.write(make_template())
        self.patch(path)

        text = self.text_of(path)
        lines = text.split("\n")
        anchor_index = next(i for i, line in enumerate(lines) if "dark-mode.css" in line)
        self.assertEqual(lines[anchor_index + 1], self.block)
        self.assertEqual(text.count(ap.MARKER_BEGIN), 1)
        self.assertEqual(text.count(ap.MARKER_END), 1)
        self.assertIn(ap.JINJA_SENTINEL, text)
        self.assertIn("index.html", self.result["templates_patched"])
        self.assertEqual(self.result["warnings"], [])

    def test_second_patch_is_idempotent(self) -> None:
        path = self.write(make_template())
        self.patch(path)
        first = path.read_bytes()

        self.result = {key: [] for key in self.result}
        self.patch(path)

        self.assertEqual(path.read_bytes(), first)
        self.assertIn("index.html", self.result["templates_unchanged"])
        self.assertEqual(self.result["templates_patched"], [])

    def test_replaces_block_with_stale_hashes(self) -> None:
        stale = ap.build_marker_block("11111111", "22222222")
        path = self.write(make_template(extra_after_anchor="\n" + stale + "\n"))
        self.patch(path)

        text = self.text_of(path)
        self.assertNotIn("11111111", text)
        self.assertNotIn("22222222", text)
        self.assertIn("aaaaaaaa", text)
        self.assertIn("bbbbbbbb", text)
        self.assertEqual(text.count(ap.MARKER_BEGIN), 1)

    def test_collapses_multiline_block_into_one_line(self) -> None:
        multiline = (
            ap.MARKER_BEGIN
            + '\n<link rel="stylesheet" href="/static/css/neko-theme-studio.css?v={{ static_asset_version }}-11111111">\n'
            + '<script src="/static/neko-theme-studio.js?v={{ static_asset_version }}-11111111" defer></script>\n'
            + ap.MARKER_END
        )
        path = self.write(make_template(extra_after_anchor="\n" + multiline + "\n"))
        self.patch(path)

        text = self.text_of(path)
        self.assertEqual(text.count(ap.MARKER_BEGIN), 1)
        self.assertEqual(text.count(ap.MARKER_END), 1)
        self.assertNotIn("11111111", text)
        self.assertIn(self.block, text)


class BrokenMarkerTests(AppPatchTestBase):
    def test_orphan_begin_only_is_stripped_and_repaired(self) -> None:
        path = self.write(make_template(extra_before_anchor=ap.MARKER_BEGIN + "\n"))
        self.patch(path)

        text = self.text_of(path)
        self.assertEqual(text.count(ap.MARKER_BEGIN), 1)
        self.assertEqual(text.count(ap.MARKER_END), 1)
        self.assertIn("</html>", text)
        self.assertIn("残缺", self.warnings_text())

    def test_orphan_end_only_is_stripped(self) -> None:
        path = self.write(make_template(extra_after_anchor="\n" + ap.MARKER_END + "\n"))
        self.patch(path)

        text = self.text_of(path)
        self.assertEqual(text.count(ap.MARKER_END), 1)
        self.assertEqual(text.count(ap.MARKER_BEGIN), 1)
        self.assertIn(self.block, text)
        self.assertIn("</html>", text)


class SkipTests(AppPatchTestBase):
    def test_anchor_inside_script_is_skipped(self) -> None:
        text = (
            "<!doctype html>\n<html>\n<head>\n<script>\n"
            'var tpl = \'' + ANCHOR_LINE + "';\n"
            "</script>\n</head>\n<body>hi</body>\n</html>\n"
        )
        path = self.write(text)
        raw = path.read_bytes()
        self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(self.result["templates_patched"], [])
        self.assertIn("锚点落在 <script>", self.warnings_text())

    def test_no_anchor_is_silently_skipped(self) -> None:
        path = self.write("<!doctype html>\n<html><body>no theme here</body></html>\n")
        raw = path.read_bytes()
        self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("index.html", self.result["templates_skipped"])
        self.assertEqual(self.logs, [])

    def test_multiple_anchors_are_skipped(self) -> None:
        text = make_template(extra_after_anchor="\n" + ANCHOR_LINE + "\n")
        path = self.write(text)
        raw = path.read_bytes()
        self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(self.result["templates_patched"], [])
        self.assertIn("2 处", self.warnings_text())

    def test_non_utf8_template_is_skipped(self) -> None:
        path = self.template_dir / "index.html"
        path.write_bytes(b"<!doctype html>\n<html>\n<head>\n" + b"\xff\xfe\x00bad" + b"\n</head></html>\n")
        raw = path.read_bytes()
        self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("不是 UTF-8", self.warnings_text())

    def test_missing_required_template_is_warned(self) -> None:
        missing = self.template_dir / "index.html"
        self.patch(missing)

        self.assertIn("必备模板不存在", self.warnings_text())
        self.assertEqual(self.result["templates_patched"], [])


class SafetyTests(AppPatchTestBase):
    def test_backup_failure_keeps_template_untouched(self) -> None:
        path = self.write(make_template())
        raw = path.read_bytes()

        with mock.patch.object(ap, "_backup_once", return_value=False):
            self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("备份失败", self.warnings_text())
        self.assertEqual(self.result["templates_patched"], [])

    def test_post_write_verification_failure_rolls_back(self) -> None:
        path = self.write(make_template())
        raw = path.read_bytes()

        # 让第 7 步「写回后复核」读到空内容，触发回滚路径。
        with mock.patch.object(pathlib.Path, "read_text", return_value=""):
            self.patch(path)

        self.assertEqual(path.read_bytes(), raw)
        self.assertIn("回滚", self.warnings_text())
        self.assertEqual(self.result["templates_patched"], [])

    def test_bom_and_crlf_are_preserved(self) -> None:
        path = self.write(make_template(), bom=True, eol="\r\n")
        self.patch(path)

        payload = path.read_bytes()
        self.assertTrue(payload.startswith(BOM))
        self.assertIn(b"\r\n", payload)
        self.assertIsNone(
            __import__("re").search(rb"(?<!\r)\n", payload),
            "写回后出现了裸 LF，原始模板是 CRLF",
        )
        self.assertEqual(payload.count(BOM), 1)

    def test_atomic_write_leaves_no_temp_file(self) -> None:
        target = self.tmp / "out" / "file.txt"
        ap._atomic_write(target, b"hello")

        self.assertEqual(target.read_bytes(), b"hello")
        leftovers = [p.name for p in target.parent.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])


class HelperTests(AppPatchTestBase):
    def test_build_marker_block_shape(self) -> None:
        block = ap.build_marker_block("deadbeef", "cafebabe")
        self.assertTrue(block.startswith(ap.MARKER_BEGIN))
        self.assertTrue(block.endswith(ap.MARKER_END))
        self.assertEqual(block.count("\n"), 0)
        self.assertIn(
            "/static/css/neko-theme-studio.css?v=" + ap.JINJA_SENTINEL + "-cafebabe",
            block,
        )
        self.assertIn(
            "/static/neko-theme-studio.js?v=" + ap.JINJA_SENTINEL + "-deadbeef",
            block,
        )

    def test_sha8_is_eight_hex_chars(self) -> None:
        value = ap._sha8(b"hello")
        self.assertEqual(len(value), 8)
        int(value, 16)

    def test_discover_templates_puts_required_first(self) -> None:
        for name in ("b.html", "a.html", "index.html"):
            (self.template_dir / name).write_text("<html></html>", encoding="utf-8")
        (self.template_dir / "notes.txt").write_text("x", encoding="utf-8")
        (self.template_dir / "sub").mkdir()
        (self.template_dir / "sub" / "deep.html").write_text("<html></html>", encoding="utf-8")

        names = [path.name for path in ap._discover_templates(self.template_dir)]
        self.assertEqual(names[:2], ["index.html", "chat.html"])
        self.assertIn("a.html", names)
        self.assertIn("b.html", names)
        self.assertNotIn("notes.txt", names)
        self.assertNotIn("deep.html", names)

    def test_detect_and_split_eol(self) -> None:
        self.assertEqual(ap._detect_eol("a\r\nb"), "\r\n")
        self.assertEqual(ap._detect_eol("a\nb"), "\n")
        self.assertEqual(ap._split_keep_eol("a\r\nb"), ["a\r\n", "b"])
        self.assertEqual(ap._line_body("a\r\n"), "a")
        self.assertEqual(ap._line_eol("a\r\n"), "\r\n")
        self.assertEqual(ap._with_eol("a", "\n"), "a\n")
        self.assertEqual(ap._with_eol("a\n", "\r\n"), "a\n")


if __name__ == "__main__":
    unittest.main()
