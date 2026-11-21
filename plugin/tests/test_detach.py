#!/usr/bin/env python3
"""卸载 / 恢复应用侧补丁（0.15.5）的契约测试。

外部评分报告里最重的一条批评是「卸载不可逆」：0.15.4 及以前的卸载只存在于仓库根目录的
uninstall.ps1，而插件市场只安装 plugin/ 子树，用户手里根本没有那个脚本。这组测试钉住三件事：

1. strip_marker_lines 必须幂等且不误伤内容 —— 它是「打补丁」和「卸补丁」共用的唯一状态机，
   两种调用方向各写一遍就一定会漂移。
2. detach_app_patch 必须真的清空模板标记、删掉两件套，并且先备份。
3. restore_app_patch 必须删掉停止标记再走 ensure，否则「卸载过一次」会变成永久停用。

跑法：
    cd plugin && python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from offline_backend import load_backend

NS = load_backend()
AP = NS["_app_patch"]
Plugin = NS["NekoThemeStudioPlugin"]

BEGIN = AP.MARKER_BEGIN
END = AP.MARKER_END
NL = chr(10)
MARKER_LINE = (BEGIN
               + '<link rel="stylesheet" href="/static/css/neko-theme-studio.css?v=1-aaaaaaaa">'
               + '<script src="/static/neko-theme-studio.js?v=1-aaaaaaaa" defer></script>'
               + END)


def make_app_root(tmp: Path) -> Path:
    """最小可用的应用安装根：resources/bin/{templates,static}。"""
    root = tmp / "app"
    templates = root / "resources" / "bin" / "templates"
    static = root / "resources" / "bin" / "static"
    (static / "css").mkdir(parents=True)
    templates.mkdir(parents=True)
    (static / "neko-theme-studio.js").write_text("/* loader */", encoding="utf-8")
    (static / "css" / "neko-theme-studio.css").write_text("/* css */", encoding="utf-8")
    return root


def write_template(templates: Path, name: str, body: str) -> Path:
    target = templates / name
    target.write_text(body, encoding="utf-8")
    return target


class StripMarkerLinesTests(unittest.TestCase):
    """状态机要同时服务「再打补丁」和「卸补丁」，三种历史形态都得吃。"""

    def test_single_line_block(self):
        text = "<head>" + NL + MARKER_LINE + NL + "</head>"
        stripped, removed, unterminated = AP.strip_marker_lines(text)
        self.assertEqual(removed, 1)
        self.assertFalse(unterminated)
        self.assertNotIn(BEGIN, stripped)
        self.assertNotIn(END, stripped)
        self.assertIn("<head>", stripped)
        self.assertIn("</head>", stripped)

    def test_multi_line_block(self):
        text = ("<head>" + NL + BEGIN + NL + '<link href="/x.css">' + NL + END
                + NL + "</head>")
        stripped, removed, unterminated = AP.strip_marker_lines(text)
        self.assertEqual(removed, 3)
        self.assertFalse(unterminated)
        self.assertNotIn(BEGIN, stripped)
        self.assertNotIn("/x.css", stripped)
        self.assertIn("</head>", stripped)

    def test_unterminated_block_keeps_content(self):
        text = "<head>" + NL + BEGIN + NL + "<p>body</p>" + NL + "</head>"
        stripped, removed, unterminated = AP.strip_marker_lines(text)
        self.assertTrue(unterminated)
        self.assertNotIn(BEGIN, stripped)
        self.assertIn("<p>body</p>", stripped)
        self.assertIn("</head>", stripped)

    def test_orphan_end(self):
        text = "<head>" + NL + "<meta>" + END + NL + "</head>"
        stripped, removed, unterminated = AP.strip_marker_lines(text)
        self.assertEqual(removed, 1)
        self.assertFalse(unterminated)
        self.assertNotIn(END, stripped)
        self.assertIn("<meta>", stripped)

    def test_idempotent(self):
        text = "<head>" + NL + MARKER_LINE + NL + "</head>"
        once, _, _ = AP.strip_marker_lines(text)
        twice, removed, _ = AP.strip_marker_lines(once)
        self.assertEqual(removed, 0)
        self.assertEqual(once, twice)


class DetachTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.app_root = make_app_root(self.tmp)
        self.templates = self.app_root / "resources" / "bin" / "templates"
        self.static = self.app_root / "resources" / "bin" / "static"
        self.plugin_root = self.tmp / "plugin"
        self.plugin_root.mkdir()
        self.flag = self.tmp / "disabled.flag"
        self.backup = self.tmp / "backup"
        patcher = mock.patch.dict(os.environ, {
            "NEKO_NTS_DISABLE_FILE": str(self.flag),
            "NEKO_NTS_BACKUP_DIR": str(self.backup),
        })
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._tmp.cleanup)

    def _patch_root(self):
        return mock.patch.object(AP, "find_app_root",
                                 side_effect=lambda root, tried=None: self.app_root)

    def test_clears_markers_and_removes_assets(self):
        write_template(self.templates, "chat.html",
                       "<head>" + NL + MARKER_LINE + NL + "</head>")
        write_template(self.templates, "plain.html", "<head></head>")
        with self._patch_root():
            result = AP.detach_app_patch(self.plugin_root)
        self.assertTrue(result["ok"])
        self.assertTrue(self.flag.is_file())
        self.assertIn("chat.html", result["templates_cleared"])
        self.assertIn("plain.html", result["templates_untouched"])
        cleaned = (self.templates / "chat.html").read_text(encoding="utf-8")
        self.assertNotIn(BEGIN, cleaned)
        self.assertFalse((self.static / "neko-theme-studio.js").exists())
        self.assertFalse((self.static / "css" / "neko-theme-studio.css").exists())
        self.assertEqual(len(result["assets_removed"]), 2)
        self.assertTrue((self.backup / "static-uninstalled" / "neko-theme-studio.js").is_file())
        self.assertTrue(
            (self.backup / "static-uninstalled" / "templates" / "chat.html").is_file())

    def test_detach_is_idempotent(self):
        write_template(self.templates, "chat.html",
                       "<head>" + NL + MARKER_LINE + NL + "</head>")
        with self._patch_root():
            first = AP.detach_app_patch(self.plugin_root)
            second = AP.detach_app_patch(self.plugin_root)
        self.assertEqual(len(first["templates_cleared"]), 1)
        self.assertEqual(len(second["templates_cleared"]), 0)
        self.assertEqual(len(second["assets_removed"]), 0)
        self.assertTrue(second["ok"])

    def test_restore_removes_flag_and_reinstalls(self):
        self.flag.write_text("disabled", encoding="utf-8")
        with mock.patch.object(AP, "ensure_app_patch", return_value={"ok": True}):
            result = AP.restore_app_patch(self.plugin_root)
        self.assertFalse(self.flag.exists())
        self.assertTrue(result["flag_removed"])
        self.assertTrue(result["ok"])

    def test_is_disabled_follows_flag(self):
        self.assertFalse(AP.is_disabled())
        self.flag.write_text("disabled", encoding="utf-8")
        self.assertTrue(AP.is_disabled())


class DisabledMirrorTests(unittest.TestCase):
    """disabled.json 是加载器唯一能读到的「用户已卸载」信号。"""

    def test_mirror_reports_disabled(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            plugin = object.__new__(Plugin)
            plugin.plugin_root = tmp
            plugin.static_dir = tmp / "static"
            plugin.static_dir.mkdir()
            plugin.logger = None
            with mock.patch.object(AP, "is_disabled", return_value=True):
                with mock.patch.object(AP, "disabled_flag_path",
                                       return_value=tmp / "flag"):
                    plugin._write_disabled_mirror()
            payload = json.loads(
                (plugin.static_dir / "disabled.json").read_text(encoding="utf-8"))
            self.assertTrue(payload["disabled"])
            self.assertEqual(payload["flag"], str(tmp / "flag"))
            self.assertIn("updated_at", payload)


if __name__ == "__main__":
    unittest.main()
