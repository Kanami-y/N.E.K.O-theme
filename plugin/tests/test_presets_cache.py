"""Round 32：内置主题列表缓存（`_preset_items`）的回归测试。

每个 `list_themes` 都重读重解析二十几套内置主题（含把随包背景图再算一遍），
实测 35~55 ms，全在面板打开/刷新的关键路径上。这里锁住三件事：

1. 目录内容没变时**不重复解析**（第二次调用不触发 `_rewrite_archive_refs`）；
2. 目录变了（新增文件 / 文件被改写）立刻失效，不返回陈旧结果；
3. 返回的是副本，调用方改不动缓存。
"""

from __future__ import annotations

import json
import pathlib
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from offline_backend import load_backend  # noqa: E402

NS = load_backend()
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def make_plugin(tmp: pathlib.Path):
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.plugin_id = "neko_theme_studio"
    plugin.logger = None
    plugin._assets_dirty = True
    (plugin.static_dir / "presets").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "presets" / "images").mkdir(parents=True, exist_ok=True)
    return plugin


def add_preset(tmp: pathlib.Path, theme_id: str, name: str, image: bool = True) -> None:
    presets = tmp / "static" / "presets"
    vars_map = {
        "--nts-chat-bg": "#101820",
        "--nts-dim": "#8899aa",
    }
    dark_map = {
        "--nts-chat-bg": "#06090d",
        "--nts-dim": "#778899",
    }
    if image:
        filename = "aabbccddeeff0011.png"
        (presets / "images" / filename).write_bytes(PNG)
        vars_map["--nts-chat-bg-image"] = f'url("images/{filename}")'
    record = {
        "schema": 1,
        "id": theme_id,
        "name": name,
        "builtin": True,
        "vars": vars_map,
        "dark_vars": dark_map,
        "tags": ["测试"],
        "note": "缓存测试用",
    }
    (presets / f"{theme_id}.json").write_text(
        json.dumps(record, ensure_ascii=False), encoding="utf-8"
    )


class PresetCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.plugin = make_plugin(self.root)
        add_preset(self.root, "cache-one", "缓存一号")
        add_preset(self.root, "cache-two", "缓存二号", image=False)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_returns_all_presets_in_id_order(self) -> None:
        items = self.plugin._preset_items()
        self.assertEqual([item["id"] for item in items], ["cache-one", "cache-two"])
        self.assertTrue(all(item["builtin"] for item in items))
        self.assertTrue(items[0]["has_image"])
        self.assertFalse(items[1]["has_image"])

    def test_second_call_reuses_parse(self) -> None:
        calls = {"n": 0}
        original = self.plugin._rewrite_archive_refs

        def counting(raw, images, *, label, from_presets=False):
            calls["n"] += 1
            return original(raw, images, label=label, from_presets=from_presets)

        self.plugin._rewrite_archive_refs = counting  # type: ignore[method-assign]
        first = self.plugin._preset_items()
        after_first = calls["n"]
        self.assertGreaterEqual(after_first, 1, "第一次必须真的读盘解析")
        second = self.plugin._preset_items()
        self.assertEqual(calls["n"], after_first, "命中缓存时不该再解析")
        self.assertEqual(first, second)
        cache = getattr(self.plugin, "_preset_items_cache", None)
        self.assertIsNotNone(cache)

    def test_adding_a_preset_invalidates_cache(self) -> None:
        before = self.plugin._preset_items()
        self.assertEqual(len(before), 2)
        add_preset(self.root, "cache-three", "缓存三号", image=False)
        after = self.plugin._preset_items()
        self.assertEqual([item["id"] for item in after], ["cache-one", "cache-three", "cache-two"])

    def test_rewriting_a_preset_invalidates_cache(self) -> None:
        before = self.plugin._preset_items()
        self.assertEqual(before[1]["name"], "缓存二号")
        path = self.root / "static" / "presets" / "cache-two.json"
        raw = json.loads(path.read_text(encoding="utf-8"))
        raw["name"] = "缓存二号改名了"
        path.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        after = self.plugin._preset_items()
        self.assertEqual(after[1]["name"], "缓存二号改名了")

    def test_touching_image_invalidates_cache(self) -> None:
        self.plugin._preset_items()
        image = self.root / "static" / "presets" / "images" / "aabbccddeeff0011.png"
        image.write_bytes(PNG + b"\x00")
        # 只改 mtime 也能触发（安装器换图不一定会改文件大小）
        ns = 2_000_000_000 * 10**9
        import os

        os.utime(image, ns=(ns, ns))
        fresh = self.plugin._preset_items()
        self.assertEqual(len(fresh), 2)

    def test_returned_items_are_copies(self) -> None:
        first = self.plugin._preset_items()
        first[0]["name"] = "调用方乱改"
        first[0]["tags"].append("乱加的标签")
        second = self.plugin._preset_items()
        self.assertNotEqual(second[0]["name"], "调用方乱改")
        self.assertNotIn("乱加的标签", second[0]["tags"])

    def test_missing_directory_returns_empty_without_cache(self) -> None:
        shutil.rmtree(self.root / "static" / "presets")
        self.assertEqual(self.plugin._preset_items(), [])


if __name__ == "__main__":
    unittest.main()
