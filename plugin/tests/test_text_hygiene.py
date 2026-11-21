#!/usr/bin/env python3
"""主题名 / 简介 / 标签的文本卫生：控制字符与格式化字符不得进状态。

背景：JSON 允许 ``\u0000``，所以控制字符能一路写进 theme.json、主题库、
分享包；面板显示断行、日志串行、接收方看到乱码。RTL 覆写符（\u202e）
更糟：它会让显示顺序反转，用户看到的名字和实际字符串不一致。

这类缺陷不会报错，只会慢慢累积脏数据，所以用单测钉住入口清洗。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from offline_backend import load_backend

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]


def make_plugin(tmp: Path):
    plugin = object.__new__(Plugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for name in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / name).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.plugin_id = "neko_theme_studio"
    plugin.logger = None
    return plugin


class TextHygieneTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.plugin = make_plugin(Path(self._tmp.name))
        asyncio.run(self.plugin.get_theme())

    def tearDown(self):
        self._tmp.cleanup()

    def read_theme(self) -> dict:
        return json.loads(self.plugin.theme_path.read_text(encoding="utf-8"))

    def test_apply_theme_strips_control_chars(self):
        result = asyncio.run(self.plugin.apply_theme(name="a\x00b\x07c"))
        self.assertNotIsInstance(result.value, Exception)
        self.assertEqual(self.read_theme()["name"], "abc")

    def test_apply_theme_strips_rtl_override(self):
        result = asyncio.run(self.plugin.apply_theme(name="\u202e主题\u202c"))
        self.assertNotIsInstance(result.value, Exception)
        self.assertEqual(self.read_theme()["name"], "主题")

    def test_all_control_name_falls_back(self):
        asyncio.run(self.plugin.apply_theme(name="\x00\x01\x02"))
        self.assertEqual(self.read_theme()["name"], "默认")

    def test_import_theme_strips_control_chars(self):
        payload = json.dumps({
            "schema": 1,
            "name": "a\u0000b",
            "vars": {"--nts-accent": "#fff"},
        })
        result = asyncio.run(self.plugin.import_theme(payload=payload))
        self.assertNotIsInstance(result.value, Exception)
        self.assertEqual(self.read_theme()["name"], "ab")

    def test_save_theme_cleans_note_and_tags(self):
        # 保存端现在拒绝空调色板，先给一个真实变量（本用例只验简介/标签清洗）。
        asyncio.run(self.plugin.apply_theme(vars={"--nts-accent": "#123456"}))
        result = asyncio.run(
            self.plugin.save_theme(
                name="卫生",
                note="第一行\x00第二行",
                tags=["\u202e反转", "ok\x07"],
            )
        )
        self.assertNotIsInstance(result.value, Exception)
        theme = result.value["theme"]
        self.assertEqual(theme["note"], "第一行第二行")
        self.assertEqual(theme["tags"], ["反转", "ok"])


if __name__ == "__main__":
    unittest.main()
