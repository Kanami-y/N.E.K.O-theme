#!/usr/bin/env python3
"""自定义材质预设的保存路径：有警告也必须存下去。

回归的是 1.0.2 里的真缺陷 —— save_material_preset 内部调用了不存在的
模块级 _log（只有 self._log），于是 normalize_materials 一旦返回警告
（用户手改过某个参数、或导入的材质块有坏值），保存就整体失败：
「保存自定义预设失败：name '_log' is not defined」—— 用户看到的是
一个与材质无关的报错，参数也没存下来。

判据：警告只是提示，不能阻断保存；存进去的参数必须已规范化。
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

load_backend = importlib.import_module("offline_backend").load_backend

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]
M = NS["_materials"]


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


class MaterialPresetWarningTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.plugin = make_plugin(Path(self._tmp.name))
        asyncio.run(self.plugin.get_theme())

    def tearDown(self):
        self._tmp.cleanup()

    def test_warning_does_not_block_save(self):
        # 故意混进一个坏值：normalize 会给出警告，但保存必须成功。
        materials = M.default_materials()
        materials["enabled"] = True
        materials["global"]["opacity"] = "不是数字"
        result = asyncio.run(
            self.plugin.save_material_preset(name="有警告", materials=materials)
        )
        self.assertNotIsInstance(result.value, Exception, str(result.value))
        self.assertIn("有警告", result.value["names"])
        stored = result.value["materials"]["custom_presets"]["有警告"]
        # 坏值被规范化成默认值，而不是原样存下去。
        self.assertEqual(
            stored["global"]["opacity"],
            M.PARAM_BY_KEY["opacity"].default,
        )

    def test_preset_lands_on_disk(self):
        materials = M.default_materials()
        materials["enabled"] = True
        materials["global"]["saturation"] = "坏值"
        asyncio.run(self.plugin.save_material_preset(name="落盘", materials=materials))
        theme = json.loads(self.plugin.theme_path.read_text(encoding="utf-8"))
        self.assertIn("落盘", theme["materials"]["custom_presets"])


if __name__ == "__main__":
    unittest.main()
