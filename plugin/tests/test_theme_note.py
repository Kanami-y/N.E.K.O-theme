#!/usr/bin/env python3
"""用户主题的简介（note）—— 保存时就能写、随分享包往返（v0.15.71）。

钉住四件事：

1. `save_theme` 接受 note/tags，并原样落到仓库条目上（面板卡片直接显示）。
2. 超长简介按 120 字截断（与内置主题同一口径），不报错、不拒存。
3. 导出分享包里 theme.json 带 note/tags —— 对方导入后不是匿名配色。
4. 导入回来的条目仍带 note/tags，且面板有保存时的简介输入框与空简介提示。

跑法：
    cd plugin && python -m unittest discover -s tests -v
"""

from __future__ import annotations

import base64
import importlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

_ob = importlib.import_module("offline_backend")
PLUGIN_DIR = _ob.PLUGIN_DIR
ROOT, load_backend = _ob.ROOT, _ob.load_backend

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]

APP_JS = (PLUGIN_DIR / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (PLUGIN_DIR / "static" / "index.html").read_text(encoding="utf-8")


def make_plugin(tmp):
    plugin = object.__new__(Plugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for name in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / name).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    palette = {
        "schema": 1,
        "name": "当前主题",
        "enabled": True,
        "updated_at": "2026-01-01T00:00:00+08:00",
        "vars": {"--nts-chat-bg": "#101820"},
        "dark_vars": {},
        "materials": NS["_materials"].default_materials(),
    }
    plugin.theme_path.write_text(json.dumps(palette, ensure_ascii=False), encoding="utf-8")
    return plugin


def library_records(plugin):
    out = []
    for path in sorted((plugin.static_dir / "themes").glob("*.json")):
        out.append(json.loads(path.read_text(encoding="utf-8")))
    return out


def zip_theme_json(payload_b64):
    raw = base64.b64decode(payload_b64)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        return json.loads(archive.read("theme.json").decode("utf-8"))


class SaveThemeNoteTests(unittest.TestCase):
    def test_save_theme_keeps_note_and_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            import asyncio

            result = asyncio.run(
                plugin.save_theme(
                    name="夜航",
                    note="深海蓝配一点青，适合夜里敲代码",
                    tags=["冷色", "深色"],
                )
            )
            value = result.value
            self.assertIsInstance(value, dict)
            self.assertEqual(value["theme"]["note"], "深海蓝配一点青，适合夜里敲代码")
            records = library_records(plugin)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["note"], "深海蓝配一点青，适合夜里敲代码")
            self.assertEqual(records[0]["tags"], ["冷色", "深色"])

    def test_save_theme_truncates_long_note_to_120(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            import asyncio

            asyncio.run(plugin.save_theme(name="长简介", note="x" * 500))
            records = library_records(plugin)
            self.assertEqual(len(records[0]["note"]), 120)

    def test_save_theme_without_note_has_no_note_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            import asyncio

            asyncio.run(plugin.save_theme(name="无简介"))
            records = library_records(plugin)
            self.assertNotIn("note", records[0])


class ArchiveNoteRoundTripTests(unittest.TestCase):
    def test_export_packs_note_into_theme_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            import asyncio

            saved = asyncio.run(plugin.save_theme(name="琥珀", note="暖橙配陶土棕"))
            theme_id = saved.value["theme"]["id"]
            exported = asyncio.run(plugin.export_theme_archive(theme_id=theme_id))
            packed = zip_theme_json(exported.value["data"])
            self.assertEqual(packed["note"], "暖橙配陶土棕")
            self.assertEqual(packed["name"], "琥珀")

    def test_import_restores_note_and_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = make_plugin(Path(tmp) / "a")
            import asyncio

            saved = asyncio.run(
                source.save_theme(name="冷雾", note="冷雾灰，配白玻璃", tags=["冷色"])
            )
            exported = asyncio.run(
                source.export_theme_archive(theme_id=saved.value["theme"]["id"])
            )
            target = make_plugin(Path(tmp) / "b")
            imported = asyncio.run(
                target.import_theme_archive(filename="x.zip", data=exported.value["data"])
            )
            self.assertIsInstance(imported.value, dict)
            records = library_records(target)
            self.assertEqual(records[0]["note"], "冷雾灰，配白玻璃")
            self.assertEqual(records[0]["tags"], ["冷色"])


class PanelWiringTests(unittest.TestCase):
    def test_save_row_has_note_input(self):
        self.assertIn('id="lib-note"', INDEX_HTML)
        self.assertIn('maxlength="120"', INDEX_HTML)

    def test_panel_sends_note_on_save(self):
        self.assertIn("var noteInput = $('lib-note');", APP_JS)
        self.assertIn("if (note) args.note = note;", APP_JS)

    def test_custom_item_without_note_shows_hint(self):
        self.assertIn("lib-note is-empty", APP_JS)
        self.assertIn("没有简介", APP_JS)


if __name__ == "__main__":
    unittest.main()
