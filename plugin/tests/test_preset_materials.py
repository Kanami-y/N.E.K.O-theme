#!/usr/bin/env python3
"""内置主题自带材质 + 材质锁定（v0.15.67，「材质随主题」）。

钉住三件用户可感知的事：

1. 每套内置主题都必须带**完整**材质（五节 90 个参数一个不缺）——
   缺一节就会退回默认值，表现为「这套主题的玻璃和别人一样」。
2. 主题自带的材质必须能编译出整套变量（126 个），否则切过去窗口外观
   和面板预览对不上。
3. 用户把材质设成「锁定」（materials.lock=True）后，切主题不得覆盖他手调的
   这套参数 —— 这是「材质随主题」的反面出口，缺了就等于强制覆盖。

跑法：
    cd plugin && python -m unittest discover -s tests -v
"""

from __future__ import annotations

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
M = NS["_materials"]
PRESET_DIR = _PLUGIN_DIR / "static" / "presets"


def preset_records():
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(PRESET_DIR.glob("*.json"))]


def preset_map():
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in sorted(PRESET_DIR.glob("*.json"))}


def make_plugin(tmp):
    plugin = object.__new__(Plugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for name in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / name).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    return plugin


def write_theme(plugin, theme_id, materials, name, color):
    record = {
        "schema": 1,
        "id": theme_id,
        "name": name,
        "saved_at": "2026-01-01T00:00:00+08:00",
        "vars": {"--nts-chat-bg": color},
        "dark_vars": {},
        "materials": materials,
    }
    path = plugin.static_dir / "themes" / (theme_id + ".json")
    path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")


class BuiltinThemeMaterialTests(unittest.TestCase):
    """内置主题拆成「配色版」与「(材质) 版」两套（v0.15.68 起）。"""

    def test_every_color_preset_has_a_material_twin(self):
        table = preset_map()
        color_ids = sorted(k for k in table if not k.endswith("-material"))
        self.assertGreaterEqual(len(color_ids), 51, "内置主题数量不该少于 51 套")
        for tid in color_ids:
            self.assertIn(tid + "-material", table, tid + ": 缺少 (材质) 版")
            base = table[tid]
            variant = table[tid + "-material"]
            # v0.15.70：配色版必须显式声明「关掉高级材质」，不能靠「不带 materials」
            # 让用户停在上一套的玻璃上（切回配色版却仍是玻璃，就是这条缺失造成的）。
            patch = base.get("materials")
            self.assertIsInstance(patch, dict, tid + ": 颜色版必须带 materials 开关")
            self.assertFalse(patch.get("enabled"), tid + ": 颜色版必须是 enabled=false")
            self.assertLessEqual(
                set(patch), {"enabled", "lock", "version"}, tid + ": 颜色版只准带开关"
            )
            self.assertEqual(base.get("vars"), variant.get("vars"), tid + ": 两版配色必须一致")
            self.assertEqual(
                base.get("dark_vars"), variant.get("dark_vars"), tid + ": 两版暗色必须一致"
            )
            self.assertEqual(
                variant.get("name"), str(base.get("name")) + " (材质)", tid + ": 名称缺后缀"
            )
            self.assertEqual(variant.get("family"), base.get("family"), tid + ": 族名不一致")

    def test_every_material_variant_carries_a_full_material_block(self):
        table = preset_map()
        for tid in sorted(k for k in table if k.endswith("-material")):
            label = tid
            materials = table[tid].get("materials")
            self.assertIsInstance(materials, dict, label + ": 没有 materials 字段")
            clean, warnings = M.normalize_materials(materials)
            self.assertEqual(warnings, [], label + ": 材质被修正 " + str(warnings[:2]))
            for section in M.SECTIONS:
                want = {param.key for param in M.PARAMS if param.section == section}
                self.assertEqual(set(clean[section]), want, label + ": " + section + " 键集不全")
            self.assertTrue(clean["enabled"], label + ": 主题自带材质必须默认启用")
            self.assertIn(clean["preset"], M.PRESET_IDS, label + ": 预设名不在白名单")
            self.assertNotEqual(clean["preset"], "custom", label + ": 不该以 custom 出厂")
            self.assertIn(clean["quality"], M.QUALITY_MODES, label + ": 画质档位非法")

    def test_builtin_materials_compile_to_the_full_variable_set(self):
        for tid in sorted(k for k in preset_map() if k.endswith("-material")):
            clean, _ = M.normalize_materials(preset_map()[tid].get("materials"))
            light, dark = M.compile_materials(clean)
            self.assertEqual(len(light), len(dark), tid + ": 亮暗变量数不等")
            self.assertGreaterEqual(len(light), 120, tid + ": 变量数偏少，编译层有缺")

    def test_builtin_materials_are_not_all_the_same(self):
        fingerprints = set()
        table = preset_map()
        for tid in sorted(k for k in table if k.endswith("-material")):
            clean, _ = M.normalize_materials(table[tid].get("materials"))
            fingerprints.add((clean["preset"], clean["quality"]))
        self.assertGreaterEqual(len(fingerprints), 4, "全部主题共用同一套材质：" + str(fingerprints))

    def test_dye_colors_follow_the_theme_accent(self):
        checked = 0
        table = preset_map()
        for tid in sorted(k for k in table if k.endswith("-material")):
            accent = str((table[tid].get("vars") or {}).get("--nts-accent") or "").strip().lower()
            if len(accent) != 7 or not accent.startswith("#"):
                continue
            clean, _ = M.normalize_materials(table[tid].get("materials"))
            self.assertEqual(clean["global"]["dyePrimary"], accent, tid + ": 染色主色没跟主题强调色")
            checked += 1
        self.assertGreater(checked, 10, "带强调色的主题太少，染色断言形同虚设")


class MaterialLockTests(unittest.TestCase):
    """materials.lock：切主题时保留用户手调材质。"""

    def test_lock_defaults_to_false(self):
        self.assertFalse(M.default_materials()["lock"])

    def test_normalize_keeps_explicit_lock(self):
        clean, warnings = M.normalize_materials({"lock": True})
        self.assertEqual(warnings, [])
        self.assertTrue(clean["lock"])
        clean, _ = M.normalize_materials({"lock": "yes"})
        self.assertTrue(clean["lock"])

    def test_apply_materials_accepts_lock_patch(self):
        base, warnings = M.apply_materials(M.default_materials(), {"lock": True})
        self.assertEqual(warnings, [])
        self.assertTrue(base["lock"])
        base, _ = M.apply_materials(base, {"lock": False})
        self.assertFalse(base["lock"])

    def test_applying_a_theme_skips_materials_when_the_user_locked_them(self):
        with tempfile.TemporaryDirectory() as raw:
            plugin = make_plugin(Path(raw))
            locked = M.default_materials()
            locked["lock"] = True
            locked["enabled"] = True
            locked["preset"] = "liquid"
            palette = NS["default_palette"]()
            palette["materials"] = locked
            plugin._write_unlocked(palette)

            imported = M.default_materials()
            imported["enabled"] = True
            imported["preset"] = "prism"
            imported["quality"] = "ultra"
            write_theme(plugin, "theme-20260101000000", imported, "测试主题", "#101820")

            outcome = plugin._apply_theme_record("theme-20260101000000")
            self.assertFalse(outcome["material_applied"])
            self.assertTrue(outcome["material_present"])
            self.assertTrue(outcome["material_locked"])
            stored = plugin._read_unlocked()
            self.assertEqual(stored["materials"]["preset"], "liquid", "锁定后预设不该被换成主题自带的 prism")
            self.assertTrue(stored["materials"]["lock"])
            # 颜色照常替换 —— 锁定的是材质，不是整份主题。
            self.assertEqual(stored["vars"]["--nts-chat-bg"], "#101820")

    def test_applying_a_theme_replaces_materials_when_not_locked(self):
        with tempfile.TemporaryDirectory() as raw:
            plugin = make_plugin(Path(raw))
            palette = NS["default_palette"]()
            current = M.default_materials()
            current["enabled"] = True
            current["preset"] = "liquid"
            palette["materials"] = current
            plugin._write_unlocked(palette)

            imported = M.default_materials()
            imported["enabled"] = True
            imported["preset"] = "prism"
            imported["quality"] = "ultra"
            write_theme(plugin, "theme-20260101000001", imported, "测试主题二", "#0f1621")

            outcome = plugin._apply_theme_record("theme-20260101000001")
            self.assertTrue(outcome["material_applied"])
            stored = plugin._read_unlocked()
            self.assertEqual(stored["materials"]["preset"], "prism")
            self.assertEqual(stored["materials"]["quality"], "ultra")


class MaterialOffTests(unittest.TestCase):
    """配色版主题要「关掉材质但留住手调参数」（v0.15.70）。"""

    def _plugin_with_tuned_materials(self, tmp, lock=False):
        plugin = make_plugin(Path(tmp))
        palette = NS["default_palette"]()
        tuned = M.default_materials()
        tuned["enabled"] = True
        tuned["preset"] = "liquid"
        tuned["quality"] = "ultra"
        tuned["lock"] = lock
        tuned["global"]["opacity"] = 0.91
        palette["materials"] = tuned
        plugin._write_unlocked(palette)
        return plugin

    def test_color_variant_turns_materials_off_but_keeps_the_tuned_params(self):
        with tempfile.TemporaryDirectory() as raw:
            plugin = self._plugin_with_tuned_materials(raw)
            write_theme(
                plugin,
                "theme-20260101000002",
                {"enabled": False},
                "配色版",
                "#101820",
            )
            outcome = plugin._apply_theme_record("theme-20260101000002")
            self.assertTrue(outcome["material_applied"])
            self.assertFalse(outcome["material_enabled"])
            stored = plugin._read_unlocked()
            self.assertFalse(stored["materials"]["enabled"])
            # 关键：关掉不等于清空。手调的 preset / quality / 参数必须还在，
            # 否则用户重新打开材质会突然回到出厂默认。
            self.assertEqual(stored["materials"]["preset"], "liquid")
            self.assertEqual(stored["materials"]["quality"], "ultra")
            self.assertAlmostEqual(stored["materials"]["global"]["opacity"], 0.91, places=6)

    def test_material_variant_turns_materials_back_on(self):
        with tempfile.TemporaryDirectory() as raw:
            plugin = make_plugin(Path(raw))
            palette = NS["default_palette"]()
            palette["materials"] = M.normalize_materials({"enabled": False})[0]
            plugin._write_unlocked(palette)

            full = M.default_materials()
            full["enabled"] = True
            full["preset"] = "prism"
            write_theme(plugin, "theme-20260101000003", full, "材质版", "#0f1621")
            outcome = plugin._apply_theme_record("theme-20260101000003")
            self.assertTrue(outcome["material_applied"])
            self.assertTrue(outcome["material_enabled"])
            self.assertEqual(plugin._read_unlocked()["materials"]["preset"], "prism")

    def test_locked_materials_survive_a_color_variant(self):
        with tempfile.TemporaryDirectory() as raw:
            plugin = self._plugin_with_tuned_materials(raw, lock=True)
            write_theme(
                plugin,
                "theme-20260101000004",
                {"enabled": False},
                "配色版二",
                "#0f1621",
            )
            outcome = plugin._apply_theme_record("theme-20260101000004")
            self.assertFalse(outcome["material_applied"])
            self.assertTrue(outcome["material_locked"])
            stored = plugin._read_unlocked()
            self.assertTrue(stored["materials"]["enabled"], "锁定后不得被主题关掉")
            self.assertEqual(stored["materials"]["preset"], "liquid")


if __name__ == "__main__":
    unittest.main()
