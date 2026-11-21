#!/usr/bin/env python3
"""reset_theme 契约测试：恢复默认必须「真恢复」，不是只改个名字。

为什么要这组测试：`reset_theme` 是面板「恢复默认」按钮的唯一后端，之前零测试引用。
它是唯一一个会把用户所有自定义一次性抹掉的入口，三类真实风险：

1. **假恢复**：只改 name 或只写部分字段，材质的派生镜像还留在磁盘上，
   加载器读到旧 --nts-mt-* 继续画材质。
2. **不落盘**：只返回默认值而没写 theme.json，刷新页面又回到旧主题。
3. **材质残留**：materials.enabled 没归为 false，下次启动照样开材质。

另外验证幂等：连点两次「恢复默认」不应该产生两份不同的默认。

跑法：cd plugin && python -m unittest discover -s tests -p "test_reset_theme.py" -v
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from offline_backend import load_backend
from test_library_archive import make_plugin, unwrap

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]
default_palette = NS["default_palette"]
SCHEMA_VERSION = NS["SCHEMA_VERSION"]


def _strip_time(palette: dict) -> dict:
    """去掉 updated_at 后比较：时间戳本来就该变。"""
    copy = dict(palette)
    copy.pop("updated_at", None)
    return copy


class ResetThemeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plugin = make_plugin(Path(self.tmp.name))

    def _reset(self):
        return asyncio.run(self.plugin.reset_theme())

    def _disk(self) -> dict:
        return json.loads(self.plugin.theme_path.read_text(encoding="utf-8"))

    def test_reset_creates_default_palette_when_missing(self) -> None:
        """首次点「恢复默认」（theme.json 还不存在）也要落盘。"""
        self.assertFalse(self.plugin.theme_path.exists())

        ok, value = unwrap(self._reset())
        self.assertTrue(ok, value)

        snapshot = default_palette()
        self.assertEqual(value["schema"], SCHEMA_VERSION)
        self.assertEqual(value["name"], snapshot["name"])
        self.assertTrue(value["enabled"])
        self.assertEqual(value["vars"], snapshot["vars"])
        self.assertEqual(value["dark_vars"], snapshot["dark_vars"])
        self.assertFalse(value["materials"]["enabled"])
        # 入口返回值始终带 material_vars / material_attrs 的形状（禁用时为空），
        # 调用方不必判空；磁盘镜像则把这对空键整个丢掉以省字节（见 _with_material_cache）。
        self.assertEqual(value["material_vars"], {"light": {}, "dark": {}})
        self.assertEqual(value["material_attrs"], {})
        self.assertIsInstance(value["updated_at"], str)
        self.assertIn("T", value["updated_at"])

        # 磁盘那份是给加载器的投影：禁用时连空键都不写。
        disk = self._disk()
        self.assertEqual(disk["name"], value["name"])
        self.assertEqual(disk["vars"], value["vars"])
        self.assertEqual(disk["dark_vars"], value["dark_vars"])
        self.assertFalse(disk["materials"]["enabled"])
        self.assertNotIn("material_vars", disk)
        self.assertNotIn("material_attrs", disk)

    def test_reset_discards_custom_theme_and_materials(self) -> None:
        """自定义配色 + 开启材质后，恢复默认必须把两者都清干净。"""
        applied = asyncio.run(
            self.plugin.apply_theme(
                vars={"--nts-accent": "#123456"},
                dark_vars={"--nts-accent": "#654321"},
                name="我的主题",
                materials={"enabled": True, "preset": "custom"},
            )
        )
        ok, applied_value = unwrap(applied)
        self.assertTrue(ok, applied_value)
        self.assertEqual(self._disk()["name"], "我的主题")
        self.assertTrue(self._disk()["materials"]["enabled"])

        ok, value = unwrap(self._reset())
        self.assertTrue(ok, value)
        snapshot = default_palette()
        self.assertEqual(value["name"], snapshot["name"])
        self.assertEqual(value["vars"], snapshot["vars"])
        self.assertEqual(value["dark_vars"], snapshot["dark_vars"])
        self.assertFalse(value["materials"]["enabled"])
        self.assertEqual(value["material_vars"], {"light": {}, "dark": {}})

        disk = self._disk()
        self.assertEqual(disk["name"], snapshot["name"])
        self.assertFalse(disk["materials"]["enabled"])
        self.assertNotIn("material_vars", disk)
        self.assertNotEqual(disk["vars"].get("--nts-accent"), "#123456")

    def test_reset_is_idempotent(self) -> None:
        """连点两次只该有时间戳差异。"""
        first = unwrap(self._reset())[1]
        second = unwrap(self._reset())[1]
        self.assertEqual(_strip_time(first), _strip_time(second))
        # 返回值与磁盘是两种形状（磁盘不写派生空键），各自一致即可
        self.assertEqual(self._disk()["name"], second["name"])
        self.assertFalse(self._disk()["materials"]["enabled"])


if __name__ == "__main__":
    unittest.main()
