#!/usr/bin/env python3
"""detach_theme / restore_theme_patch 入口契约测试：disabled.json 镜像必须与真实状态一致。

为什么要这组测试：这两个入口是「卸载应用侧主题」的唯一入口，模块级函数在
test_detach.py / test_app_patch.py 里已覆盖，但**入口本身**（镜像写入时机、
失败时是否留下错误的镜像）没有任何测试。加载器在 :48911 读不到 LOCALAPPDATA
的停止标记，只能读 static/disabled.json —— 这一位写错，用户卸载后主题会被
偷偷复活，或者反过来永远装不回来。

跑法：cd plugin && python -m unittest discover -s tests -p "test_detach_entry.py" -v
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from offline_backend import load_backend
from test_library_archive import make_plugin, unwrap

NS = load_backend()
AP = NS["_app_patch"]
Plugin = NS["NekoThemeStudioPlugin"]


class DisabledMirrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plugin = make_plugin(Path(self.tmp.name))
        self.mirror = self.plugin.static_dir / "disabled.json"

    def _call(self, name: str):
        return asyncio.run(getattr(self.plugin, name)())

    def _mirror(self) -> dict:
        return json.loads(self.mirror.read_text(encoding="utf-8"))

    def test_detach_writes_disabled_true(self) -> None:
        flag = Path(self.tmp.name) / "theme-studio-disabled.flag"
        with mock.patch.object(AP, "detach_app_patch", return_value={"ok": True, "warnings": []}), \
                mock.patch.object(AP, "is_disabled", return_value=True), \
                mock.patch.object(AP, "disabled_flag_path", return_value=flag):
            ok, value = unwrap(self._call("detach_theme"))
        self.assertTrue(ok, value)
        self.assertTrue(self.mirror.exists(), "镜像必须落盘")
        data = self._mirror()
        self.assertIs(data["disabled"], True)
        self.assertEqual(data["flag"], str(flag))
        self.assertIn("T", data["updated_at"])

    def test_restore_writes_disabled_false(self) -> None:
        flag = Path(self.tmp.name) / "theme-studio-disabled.flag"
        with mock.patch.object(AP, "restore_app_patch", return_value={"ok": True}), \
                mock.patch.object(AP, "is_disabled", return_value=False), \
                mock.patch.object(AP, "disabled_flag_path", return_value=flag):
            ok, value = unwrap(self._call("restore_theme_patch"))
        self.assertTrue(ok, value)
        data = self._mirror()
        self.assertIs(data["disabled"], False)
        self.assertEqual(data["flag"], str(flag))

    def test_failed_detach_leaves_mirror_untouched(self) -> None:
        """卸载失败时不能把镜像改成 true —— 否则加载器会以为已经卸载干净。"""
        flag = Path(self.tmp.name) / "theme-studio-disabled.flag"
        with mock.patch.object(AP, "restore_app_patch", return_value={"ok": True}), \
                mock.patch.object(AP, "is_disabled", return_value=False), \
                mock.patch.object(AP, "disabled_flag_path", return_value=flag):
            unwrap(self._call("restore_theme_patch"))
        before = self._mirror()

        with mock.patch.object(AP, "detach_app_patch", side_effect=RuntimeError("磁盘只读")), \
                mock.patch.object(AP, "is_disabled", return_value=True), \
                mock.patch.object(AP, "disabled_flag_path", return_value=flag):
            ok, value = unwrap(self._call("detach_theme"))
        self.assertFalse(ok)
        self.assertIn("磁盘只读", str(value))
        after = self._mirror()
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
