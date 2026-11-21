#!/usr/bin/env python3
"""高级材质设置系统（v0.15.0）的后端契约测试。

钉住的是「材质子树」在 theme.json 里的生命周期，而不是某个像素值：

1. 默认值必须铺满 90 个参数 —— 漏一个，面板就会渲染出空控件、编译时少一个变量，
   现象是「某个滑块拖着没反应」，但日志里什么都不会留。
2. normalize_materials 必须钳制而不是拒绝 —— 用户手写 theme.json / 老版本导入的
   越界值不能让整份主题读不出来。
3. apply_theme 的 materials 是**整份替换**，不是按键合并。这条最容易回归：
   合并语义下「改回默认值」会被当成「没传这个键」而被忽略。
4. enabled=False 时 theme.json 里仍有完整材质块（用户调好了只是没启用），
   但派生变量必须为空 —— 否则加载器会往应用窗口打 data-nts-mt。
5. 分享包 / 仓库 / 复制 JSON 三条导出链都必须带材质，否则对方导入后只剩颜色。

跑法：
    cd plugin && python -m unittest discover -s tests -v
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

# 直接运行本文件时（python tests/test_materials.py）cwd 不一定在 sys.path 里，
# 而插件源码是以绝对名 import materials 的 —— 补上 plugin/ 目录，单文件也能跑。
_PLUGIN_DIR = Path(__file__).resolve().parent.parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

load_backend = importlib.import_module("offline_backend").load_backend

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]
M = NS["_materials"]
SdkError = NS["SdkError"]
default_palette = NS["default_palette"]

OPACITY = M.PARAM_BY_KEY["opacity"].default
SATURATION = M.PARAM_BY_KEY["saturation"].default


def make_plugin(tmp: Path):
    plugin = object.__new__(Plugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for name in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / name).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    return plugin


def enabled_materials(**overrides):
    """一份「启用了 + 已改过几项」的材质，用来验证整体替换与导出链路。"""
    materials = M.default_materials()
    materials["enabled"] = True
    materials["global"]["opacity"] = 0.3
    materials["global"]["saturation"] = 180.0
    for key, value in overrides.items():
        materials["global"][key] = value
    return materials


class DefaultsTests(unittest.TestCase):
    def test_default_materials_fills_every_param(self):
        materials = default_palette()["materials"]
        self.assertFalse(materials["enabled"])
        self.assertEqual(materials["preset"], "custom")
        self.assertEqual(materials["quality"], "balanced")
        for section in M.SECTIONS:
            expected = {p.key: p.default for p in M.PARAMS if p.section == section}
            self.assertEqual(set(materials[section]), set(expected), section)
            self.assertEqual(materials[section], expected, section)

    def test_every_preset_is_complete(self):
        self.assertEqual(len(M.PRESETS), 6)
        for preset_id, params in M.PRESETS.items():
            for section in M.SECTIONS:
                expected = {p.key for p in M.PARAMS if p.section == section}
                self.assertEqual(set(params[section]), expected, preset_id + "/" + section)


class NormalizeTests(unittest.TestCase):
    def test_out_of_range_is_clamped_not_rejected(self):
        clean, warnings = M.normalize_materials({"global": {"opacity": 5}})
        self.assertEqual(clean["global"]["opacity"], M.PARAM_BY_KEY["opacity"].maximum)
        self.assertTrue(warnings)
        self.assertTrue(any("opacity" in item for item in warnings))

    def test_bad_color_falls_back_with_warning(self):
        clean, warnings = M.normalize_materials({"global": {"tint": "not-a-color"}})
        self.assertEqual(clean["global"]["tint"], M.PARAM_BY_KEY["tint"].default)
        self.assertTrue(any("tint" in item for item in warnings))

    def test_unknown_keys_are_dropped(self):
        clean, warnings = M.normalize_materials({"bogus": 1, "global": {"nope": 2}})
        self.assertNotIn("bogus", clean)
        self.assertNotIn("nope", clean["global"])
        self.assertEqual(set(clean), set(M.default_materials()))


class CompileTests(unittest.TestCase):
    def test_disabled_theme_exposes_no_material_vars(self):
        palette = default_palette()
        palette["materials"]["enabled"] = False
        out = self._plugin()._with_material_vars(palette)
        self.assertEqual(out["material_vars"], {"light": {}, "dark": {}})
        self.assertEqual(out["material_attrs"], {})

    def test_enabled_theme_compiles_full_table(self):
        palette = default_palette()
        palette["materials"]["enabled"] = True
        out = self._plugin()._with_material_vars(palette)
        light = out["material_vars"]["light"]
        self.assertGreaterEqual(len(light), 100)
        self.assertIn("--nts-mt-opacity", light)
        self.assertEqual(out["material_attrs"]["data-nts-mt"], "1")
        self.assertEqual(out["material_attrs"]["data-nts-mt-quality"], "balanced")

    def test_quality_saver_really_degrades(self):
        materials = M.default_materials()
        ultra, _ = M.compile_materials(dict(materials, quality="ultra"))
        saver, _ = M.compile_materials(dict(materials, quality="saver"))
        self.assertEqual(saver["--nts-mt-disp"], "rgba(0, 0, 0, 0)")
        blur_ultra = float(ultra["--nts-mt-blur"].rstrip("px"))
        blur_saver = float(saver["--nts-mt-blur"].rstrip("px"))
        self.assertLessEqual(blur_saver, blur_ultra)
        # 省电模式必须把无限循环的漂移动画也关掉：只把 liquid 置 0 会让渐变变静态，
        # 但 animation 仍是 infinite，逐帧重绘照旧。
        self.assertEqual(saver["--nts-mt-anim"], "none")
        self.assertIn("infinite", ultra["--nts-mt-anim"])
        # 只把变量调透明不等于省电：图层还在合成里。省电模式应把纯装饰的多层渐变
        # 直接置 none，只留底色与染色（7 层 → 2 层）。
        for key in ("--nts-mt-inner-img", "--nts-mt-sheen-img", "--nts-mt-noise-img",
                    "--nts-mt-ambient-img", "--nts-mt-spot"):
            self.assertEqual(saver[key], "none", key)
        self.assertIn("gradient", ultra["--nts-mt-inner-img"])
        self.assertNotEqual(saver["--nts-mt-dye"], "none")

    def test_optics_layer_is_compiled(self):
        """液态玻璃靠这批派生变量落地；少一个就退化成"一块模糊的矩形"。"""
        light, _ = M.compile_materials(M.default_materials())
        for name in (
            "--nts-mt-sheen-img",
            "--nts-mt-inner-img",
            "--nts-mt-ambient-img",
            "--nts-mt-lens-glow",
            "--nts-mt-lens-blur",
            "--nts-mt-heel",
            "--nts-mt-disp-blur",
            "--nts-mt-drift-size",
            "--nts-mt-rim-img",
            "--nts-mt-rim-shade",
            "--nts-mt-disp-warm",
            "--nts-mt-disp-cool",
        ):
            self.assertIn(name, light)
        self.assertIn("var(--nts-mt-light-angle, 162deg)", light["--nts-mt-sheen-img"])
        self.assertIn("var(--nts-mt-mx", light["--nts-mt-rim-img"])
        self.assertIn("var(--nts-mt-my", light["--nts-mt-rim-img"])
        self.assertTrue(light["--nts-mt-disp-warm"].startswith("rgba("), light["--nts-mt-disp-warm"])
        self.assertNotEqual(light["--nts-mt-disp-warm"], light["--nts-mt-disp-cool"])
        self.assertTrue(light["--nts-mt-sheen-img"].startswith("linear-gradient("), light["--nts-mt-sheen-img"])
        self.assertTrue(light["--nts-mt-lens"].endswith("px"), light["--nts-mt-lens"])
        self.assertTrue(light["--nts-mt-lens-glow"].startswith("rgba("), light["--nts-mt-lens-glow"])
        self.assertIn("%", light["--nts-mt-drift-size"])

    def test_dark_glass_base_is_darker(self):
        """暗色主题下玻璃底必须是暗的：宿主暗色主题文字是浅色，白玻璃高不透明度就是白底浅字。"""
        light, dark = M.compile_materials(M.default_materials())

        def rgb(value):
            body = value[value.index("(") + 1 : value.index(")")]
            parts = [p.strip() for p in body.split(",")]
            return tuple(int(float(p)) for p in parts[:3]), float(parts[3])

        light_rgb, light_alpha = rgb(light["--nts-mt-bg"])
        dark_rgb, dark_alpha = rgb(dark["--nts-mt-bg"])
        self.assertAlmostEqual(light_alpha, dark_alpha, places=3)
        light_luma = sum(light_rgb) / 3.0
        dark_luma = sum(dark_rgb) / 3.0
        self.assertLess(dark_luma, light_luma * 0.6, (light_rgb, dark_rgb))
        # 压暗不是换纯黑：用户的染色调仍要透得出来（三个通道不能全等）。
        self.assertGreater(max(dark_rgb) - min(dark_rgb), 0)

    def test_blur_level_actually_scales_blur(self):
        """blurLevel 曾经是死参数：改了只进 theme.json，blur 一动不动。"""
        materials = M.default_materials()
        widths = []
        for level in ("low", "medium", "high", "ultra"):
            patched = dict(materials)
            patched["global"] = dict(materials["global"], blurLevel=level)
            light, _ = M.compile_materials(patched)
            widths.append(float(light["--nts-mt-blur"].rstrip("px")))
        self.assertEqual(widths, sorted(widths), widths)
        self.assertGreater(widths[-1], widths[0] * 2, widths)

    def test_disabling_dynamic_reflect_kills_ambient_gradient(self):
        materials = M.default_materials()
        on = dict(materials)
        on["lighting"] = dict(materials["lighting"], dynamicReflect=True)
        light_on, _ = M.compile_materials(on)
        self.assertTrue(light_on["--nts-mt-ambient-img"].startswith("linear-gradient("), light_on["--nts-mt-ambient-img"])
        off = dict(materials)
        off["lighting"] = dict(materials["lighting"], dynamicReflect=False)
        light_off, _ = M.compile_materials(off)
        self.assertEqual(light_off["--nts-mt-ambient-img"], "none")

    def test_animation_easing_is_continuous(self):
        # 平滑度是 0-100 的连续滑块，不能只有三档：70 与 83 拖起来一样等于没做。
        curves = {}
        for value in (10, 30, 50, 70, 90):
            materials = M.default_materials()
            materials["enabled"] = True
            materials["refraction"] = dict(materials["refraction"], liquid=True, liquidSmooth=float(value))
            light, _dark = M.compile_materials(materials)
            curves[value] = light["--nts-mt-anim"]
        self.assertEqual(len(set(curves.values())), 5, curves)
        # 曲线形态：低端像 ease（x1 小）、中段是对称的 ease-in-out（0.42）、高端趋近 linear（x1 → 0）。
        def x1_of(anim):
            inner = anim[anim.index("cubic-bezier(") + len("cubic-bezier("): anim.index(")")]
            return float(inner.split(",")[0])
        xs = [x1_of(curves[value]) for value in (10, 30, 50, 70, 90)]
        self.assertLess(xs[0], 0.30)
        self.assertAlmostEqual(xs[2], 0.42, places=3)
        self.assertLess(xs[-1], 0.12)

    def test_quality_tiers_are_distinct(self):
        # 四档画质不能有两档是同一个东西：切了没反应，用户会以为功能坏了。
        materials = M.default_materials()
        materials["enabled"] = True
        compiled = {}
        for quality in M.QUALITY_MODES:
            patched = dict(materials)
            patched["quality"] = quality
            light, _dark = M.compile_materials(patched)
            compiled[quality] = light
        names = list(M.QUALITY_MODES)
        for left in range(len(names)):
            for right in range(left + 1, len(names)):
                one = compiled[names[left]]
                two = compiled[names[right]]
                diff = [key for key in one if one[key] != two[key]]
                self.assertTrue(diff, names[left] + " 与 " + names[right] + " 编译结果完全相同")
        def blur_of(quality):
            return float(compiled[quality]["--nts-mt-blur"].rstrip("px"))
        self.assertLess(blur_of("saver"), blur_of("balanced"))
        self.assertGreater(blur_of("ultra"), blur_of("balanced"))
        self.assertGreater(blur_of("ultra"), blur_of("high"))
    def test_component_shadow_scales_with_quality(self):
        # 组件自定义阴影是 shorthand（0 8px 24px 0px rgba(...)），改不了 blur 变量，
        # 所以省电/极致档必须整条缩放，否则用户给组件单独设了阴影后切画质只剩全局在降级。
        materials = M.default_materials()
        materials['enabled'] = True
        materials['components'] = {
            'chat': {'mode': 'custom', 'shadowStrength': 0.6},
            'input': {'mode': 'custom', 'shadowStrength': 0.0},
        }
        shadows = {}
        for quality in ('balanced', 'saver', 'ultra'):
            patched = dict(materials)
            patched['quality'] = quality
            light, _dark = M.compile_materials(patched)
            shadows[quality] = light['--nts-mt-c-shadow-chat']
            self.assertEqual(light['--nts-mt-c-shadow-input'], '0 0 0 rgba(0, 0, 0, 0)')
        def blur_of(quality):
            head = shadows[quality].split('rgba(')[0].split()
            self.assertEqual(len(head), 4, shadows[quality])
            return float(head[2].rstrip('px'))
        self.assertLess(blur_of('saver'), blur_of('balanced'))
        self.assertGreater(blur_of('ultra'), blur_of('balanced'))
        self.assertEqual(round(blur_of('balanced'), 1), 24.0)

    def test_shadow_and_inset_never_none(self):
        """box-shadow 是逗号分隔的多层声明，任何一层是 none 都会让整条失效。

        2026-11-21 真机事故：--nts-mt-inset 在 prism 预设下是 none，拼进
        box-shadow 后 12 段阴影全部归零，聊天窗看起来「消失了」。
        """
        for preset in M.PRESET_IDS:
            for quality in M.QUALITY_MODES:
                materials = M.default_materials()
                materials["enabled"] = True
                materials["preset"] = preset
                materials["quality"] = quality
                if preset in M.PRESETS:
                    src = M.PRESETS[preset]
                    for section in M.SECTIONS:
                        if isinstance(src.get(section), dict):
                            materials[section].update(src[section])
                light, _dark = M.compile_materials(materials)
                for key in ("--nts-mt-shadow", "--nts-mt-inset"):
                    self.assertNotEqual(light[key].strip(), "none", preset + "/" + quality + "/" + key)

    def test_derived_fields_are_a_disk_mirror_recomputed_on_read(self):
        """磁盘上要有镜像（静态路由给加载器读），但读回来必须按 materials 重算。

        这条曾经写成"绝不落盘"——那是错的：加载器读的 /ui/theme.json 就是磁盘
        文件，不经过 entry。真机诊断里 mt_vars=0 就是这个假设造成的。
        """
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            palette = default_palette()
            palette["materials"]["enabled"] = True
            plugin._write_unlocked(palette)
            on_disk = json.loads(plugin.theme_path.read_text(encoding="utf-8"))
            self.assertIn("materials", on_disk)
            self.assertTrue(on_disk["material_vars"]["light"], "磁盘镜像必须带变量，否则加载器拿不到")
            self.assertIn("data-nts-mt", on_disk["material_attrs"])
            read_back = plugin._read_unlocked(strict=True)
            self.assertNotIn("material_vars", read_back, "读侧不得把镜像当成事实")
            self.assertEqual(read_back["materials"]["global"]["opacity"], OPACITY)
            # 手改 materials 而不动镜像：读侧重算后必须给新值，镜像不得反过来影响结果。
            on_disk["materials"]["global"]["opacity"] = 0.3
            plugin.theme_path.write_text(json.dumps(on_disk), encoding="utf-8")
            recomputed = plugin._with_material_vars(plugin._read_unlocked(strict=True))
            expected, _ = M.compile_materials(recomputed["materials"])
            self.assertEqual(recomputed["material_vars"]["light"], expected)

    def test_disabled_theme_writes_no_cache(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            plugin._write_unlocked(default_palette())
            on_disk = json.loads(plugin.theme_path.read_text(encoding="utf-8"))
            self.assertNotIn("material_vars", on_disk)
            self.assertNotIn("material_attrs", on_disk)

    @staticmethod
    def _plugin():
        plugin = object.__new__(Plugin)
        plugin.logger = None
        return plugin


class ApplyTests(unittest.TestCase):
    def test_materials_are_replaced_wholesale_not_merged(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            first = enabled_materials()
            result = asyncio.run(plugin.apply_theme(materials=first))
            self.assertIsInstance(result.value, dict, "第一次写入应当成功")
            # 只传一个键：整体替换语义下 saturation 必须回默认值（合并语义会留住 180）。
            second = {"enabled": True, "global": {"opacity": OPACITY}}
            result2 = asyncio.run(plugin.apply_theme(materials=second))
            self.assertIsInstance(result2.value, dict)
            stored = plugin._read_unlocked()["materials"]
            self.assertEqual(stored["global"]["opacity"], OPACITY)
            self.assertEqual(stored["global"]["saturation"], SATURATION)

    def test_absent_materials_keeps_disk_value(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            asyncio.run(plugin.apply_theme(materials=enabled_materials()))
            result = asyncio.run(plugin.apply_theme(vars={"--nts-accent": "#123456"}))
            self.assertIsInstance(result.value, dict)
            stored = plugin._read_unlocked()["materials"]
            self.assertTrue(stored["enabled"])
            self.assertEqual(stored["global"]["opacity"], 0.3)

    def test_non_object_materials_is_rejected(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            result = asyncio.run(plugin.apply_theme(materials="nope"))
            self.assertIsInstance(result.value, SdkError)
            self.assertIn("materials", str(result.value))

    def test_preview_ignores_enabled(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            # 磁盘上没有 theme.json：退回默认（enabled=False），预览仍要给变量。
            result = asyncio.run(plugin.preview_materials(mode="light"))
            self.assertIsInstance(result.value, dict)
            self.assertGreaterEqual(len(result.value["vars"]), 100)
            self.assertIn("dark", result.value)

    def test_import_with_only_materials_is_allowed(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            doc = json.dumps(
                {
                    "schema": 1,
                    "name": "只有材质",
                    "enabled": True,
                    "vars": {},
                    "dark_vars": {},
                    "materials": enabled_materials(),
                }
            )
            result = asyncio.run(plugin.import_theme(payload=doc))
            self.assertIsInstance(result.value, dict)
            self.assertTrue(plugin._read_unlocked()["materials"]["enabled"])

    def test_import_all_rejected_colors_is_still_refused(self):
        """带了颜色却全不合法 = 坏包，必须继续拦，不能拿材质当免死金牌。"""
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            before = plugin._read_unlocked()["vars"]
            doc = json.dumps(
                {
                    "schema": 1,
                    "vars": {"--nts-completely-unknown": "#fff"},
                    "dark_vars": {},
                    "materials": enabled_materials(),
                }
            )
            result = asyncio.run(plugin.import_theme(payload=doc))
            self.assertIsInstance(result.value, SdkError)
            self.assertEqual(plugin._read_unlocked()["vars"], before)

    def test_export_then_import_keeps_materials(self):
        """0.15.38 剥掉派生镜像后，导出的 JSON 仍必须能被导入并保留材质。"""
        with tempfile.TemporaryDirectory() as raw_tmp:
            source = make_plugin(Path(raw_tmp))
            palette = default_palette()
            palette['materials'] = enabled_materials()
            direct = palette['materials']
            source._write_unlocked(palette)
            exported = asyncio.run(source.export_theme())
            payload = exported.value['payload']

        with tempfile.TemporaryDirectory() as raw_tmp:
            target = make_plugin(Path(raw_tmp))
            imported = asyncio.run(target.import_theme(payload=payload))
            self.assertIsInstance(imported.value, dict)
            stored = target._read_unlocked()['materials']
            self.assertTrue(stored['enabled'])
            self.assertEqual(stored['global']['opacity'], direct['global']['opacity'])
            self.assertEqual(stored['global']['saturation'], direct['global']['saturation'])

    def test_export_theme_strips_derived_mirror(self):
        """导出的 JSON 只带事实字段：派生镜像混进分享文件会让体积翻倍、字段互相矛盾。"""
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            palette = default_palette()
            palette['materials'] = enabled_materials()
            plugin._write_unlocked(palette)
            # 前提：磁盘上的 theme.json 确实带派生镜像，否则这条断言是在空转。
            disk = json.loads(plugin.theme_path.read_text(encoding='utf-8'))
            self.assertIn('material_vars', disk)
            self.assertIn('material_attrs', disk)

            applied = asyncio.run(plugin.export_theme())
        self.assertIsInstance(applied.value, dict)
        doc = json.loads(applied.value['payload'])
        self.assertNotIn('material_vars', doc)
        self.assertNotIn('material_attrs', doc)
        self.assertNotIn('material_compile_version', doc)
        self.assertIn('materials', doc)
        self.assertIn('vars', doc)
        self.assertIn('schema', doc)

    def test_material_spec_shape(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            result = asyncio.run(plugin.material_spec())
            spec = result.value
            self.assertEqual(len(spec["params"]), 90)
            self.assertEqual(len(spec["components"]), 10)
            self.assertEqual(len(spec["component_params"]), 5)
            self.assertEqual(len(spec["quality"]), 4)
            self.assertEqual(len(spec["presets"]), 7)


class ComponentTests(unittest.TestCase):
    """组件级材质：c- 前缀变量必须真正被加载器消费（0.15.4 修复 20 个死变量）。"""

    @staticmethod
    def _compile(components, quality="balanced"):
        materials = M.default_materials()
        materials["enabled"] = True
        materials["quality"] = quality
        materials["components"] = components
        light, _dark = M.compile_materials(materials)
        return light

    def test_component_opacity_drives_bg_variable(self):
        light = self._compile({"chat": {"mode": "custom", "opacity": 0.5}})
        self.assertIn("--nts-mt-c-bg-chat", light)
        expected = round(0.5 * float(M.PARAM_BY_KEY["tintStrength"].default), 3)
        self.assertIn(str(expected), light["--nts-mt-c-bg-chat"])

    def test_component_shadow_strength_drives_shadow_variable(self):
        light = self._compile({"chat": {"mode": "custom", "shadowStrength": 1.0}})
        self.assertIn("--nts-mt-c-shadow-chat", light)
        self.assertIn("rgba(0, 0, 0, 0.45)", light["--nts-mt-c-shadow-chat"])
        zero = self._compile({"chat": {"mode": "custom", "shadowStrength": 0.0}})
        # box-shadow 是逗号分隔的多层声明，一层写 none 就会让整条失效，
        # 所以「不加阴影」用全透明层表达。
        self.assertEqual(zero["--nts-mt-c-shadow-chat"], "0 0 0 rgba(0, 0, 0, 0)")

    def test_component_radius_does_not_collide_with_global_param(self):
        light = self._compile({"dialog": {"mode": "custom", "radius": 33}})
        self.assertEqual(light["--nts-mt-c-radius-dialog"], "33px")
        # 全局参数 radiusDialog 必须保留自己的值，不能被组件覆盖吃掉。
        self.assertNotEqual(light["--nts-mt-radius-dialog"], "33px")

    def test_inherit_component_emits_nothing(self):
        light = self._compile({"chat": {"mode": "inherit"}})
        self.assertEqual([k for k in light if k.startswith("--nts-mt-c-")], [])

    def test_saver_quality_halves_component_blur(self):
        balanced = self._compile({"chat": {"mode": "custom", "blur": 40}})
        saver = self._compile({"chat": {"mode": "custom", "blur": 40}}, quality="saver")
        self.assertEqual(balanced["--nts-mt-c-blur-chat"], "40px")
        self.assertEqual(saver["--nts-mt-c-blur-chat"], "20px")


class ShareTests(unittest.TestCase):
    def test_share_archive_roundtrip_keeps_materials(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            filename, payload = plugin._build_archive(
                name="带材质的主题",
                vars_map={"--nts-accent": "#7fb8ff"},
                dark_map={},
                materials=enabled_materials(),
            )
            self.assertTrue(filename.endswith(".zip"))
            parsed, kind = plugin._parse_archive(payload, label="测试")
            self.assertEqual(kind, "zip")
            self.assertIn("materials", parsed)
            self.assertTrue(parsed["materials"]["enabled"])
            self.assertEqual(parsed["materials"]["global"]["opacity"], 0.3)

    def test_disabled_materials_are_not_wrapped(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            off = M.default_materials()
            _filename, payload = plugin._build_archive(
                name="无色材质",
                vars_map={"--nts-accent": "#7fb8ff"},
                dark_map={},
                materials=off,
            )
            parsed, _kind = plugin._parse_archive(payload, label="测试")
            self.assertNotIn("materials", parsed, "没启用的材质不该随包分享")

    def test_library_item_keeps_materials_and_restores_them(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            record = plugin._save_library_item(
                name="带材质",
                vars_map={"--nts-accent": "#7fb8ff"},
                dark_map={},
                materials=enabled_materials(),
            )
            self.assertEqual(record["materials"]["global"]["opacity"], 0.3)
            applied = plugin._apply_theme_record(record["id"])
            self.assertEqual(applied["light"], 1)
            # 摘要里没有 materials（它是压缩过的回执），真值要看磁盘：
            stored = plugin._read_unlocked()["materials"]
            self.assertTrue(stored["enabled"])
            self.assertEqual(stored["global"]["opacity"], 0.3)

    def test_copy_json_includes_materials_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            plugin = make_plugin(Path(raw_tmp))
            base = {
                "schema": 1,
                "name": "分享素材",
                "vars": {"--nts-accent": "#7fb8ff"},
                "dark_vars": {},
            }
            on = dict(base, materials=enabled_materials())
            plugin_path = plugin.static_dir / "presets" / "share-on.json"
            plugin_path.write_text(json.dumps(on, ensure_ascii=False), encoding="utf-8")
            off = dict(base, materials=M.default_materials())
            off_path = plugin.static_dir / "presets" / "share-off.json"
            off_path.write_text(json.dumps(off, ensure_ascii=False), encoding="utf-8")
            result = asyncio.run(plugin.theme_json(theme_id="share-on"))
            payload = json.loads(result.value["payload"])
            self.assertIn("materials", payload)
            result2 = asyncio.run(plugin.theme_json(theme_id="share-off"))
            payload2 = json.loads(result2.value["payload"])
            self.assertNotIn("materials", payload2)


class CustomPresetTests(unittest.TestCase):
    """自定义预设（custom_presets）：存得进、列得出、切得动、删得掉。

    0.15.9 之前这棵子树只有后端存储没有出口 —— 面板没有 UI、material_spec 不返回，
    用户永远写不进一条，等于死字段。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.plugin = make_plugin(Path(self.tmp.name))

    def tearDown(self):
        self.tmp.cleanup()

    def test_save_stores_full_sections(self):
        materials = enabled_materials()
        materials["global"]["opacity"] = 0.42
        result = asyncio.run(self.plugin.save_material_preset(name="我的玻璃", materials=materials))
        self.assertIsInstance(result.value, dict, result.value)
        self.assertEqual(result.value["name"], "我的玻璃")
        self.assertIn("我的玻璃", result.value["names"])
        stored = self.plugin._read_unlocked()["materials"]["custom_presets"]["我的玻璃"]
        for section in M.SECTIONS:
            expected = len([p for p in M.PARAMS if p.section == section])
            self.assertEqual(len(stored[section]), expected, section)
        self.assertEqual(stored["global"]["opacity"], 0.42)

    def test_spec_exposes_custom_presets(self):
        asyncio.run(self.plugin.save_material_preset(name="雾蓝", materials=enabled_materials()))
        spec = asyncio.run(self.plugin.material_spec()).value
        self.assertIn("雾蓝", spec["custom_presets"])
        self.assertEqual(spec["custom_presets"]["雾蓝"]["global"]["saturation"], 180.0)

    def test_saved_preset_can_be_applied_as_whole_set(self):
        asyncio.run(
            self.plugin.save_material_preset(name="高饱和", materials=enabled_materials(saturation=210.0))
        )
        disk = self.plugin._read_unlocked()["materials"]
        stored = disk["custom_presets"]["高饱和"]
        # 面板切自定义预设 = 从 custom_presets 取五节铺进整份树，再整份提交。
        payload = {"enabled": True, "preset": "高饱和", "quality": disk["quality"], "dark": {}}
        for section in M.SECTIONS:
            payload[section] = dict(stored[section])
        result = asyncio.run(self.plugin.apply_theme(materials=payload))
        self.assertIsInstance(result.value, dict, result.value)
        after = self.plugin._read_unlocked()["materials"]
        self.assertEqual(after["global"]["saturation"], 210.0)
        self.assertEqual(after["preset"], "高饱和")

    def test_delete_removes_preset_and_falls_back_to_custom(self):
        asyncio.run(self.plugin.save_material_preset(name="临时", materials=enabled_materials()))
        payload = {"enabled": True, "preset": "临时", "quality": "balanced", "dark": {}}
        for section in M.SECTIONS:
            payload[section] = dict(M.PRESETS["frosted"][section])
        asyncio.run(self.plugin.apply_theme(materials=payload))
        result = asyncio.run(self.plugin.delete_material_preset(name="临时"))
        self.assertEqual(result.value["deleted"], "临时")
        self.assertEqual(result.value["names"], [])
        after = self.plugin._read_unlocked()["materials"]
        self.assertEqual(after["custom_presets"], {})
        self.assertEqual(after["preset"], "custom")

    def test_delete_missing_preset_is_an_error(self):
        result = asyncio.run(self.plugin.delete_material_preset(name="不存在"))
        self.assertIsInstance(result.value, SdkError)
        self.assertIn("不存在", str(result.value))

    def test_preset_name_longer_than_40_is_rejected(self):
        """API 直调时超长名必须显式报错 —— 静默截断会让「41 字」和「截断后的 40 字」撞成同一个键。"""
        result = asyncio.run(self.plugin.save_material_preset(name="x" * 41))
        self.assertIsInstance(result.value, SdkError)
        self.assertIn("40", str(result.value))
        # 40 个字符是合法边界，不能一刀切死。
        boundary = asyncio.run(self.plugin.save_material_preset(name="x" * 40))
        self.assertEqual(boundary.value["name"], "x" * 40)

    def test_applying_saved_theme_keeps_local_custom_presets(self):
        """应用带材质的仓库条目时，预设库按名合并 —— 不能把用户自己存的预设抹掉。"""
        entry_materials = enabled_materials()
        entry_preset = M._blank_params()
        entry_preset["global"]["opacity"] = 0.11
        entry_materials["custom_presets"] = {
            "条目预设": M._blank_params(),
            "同名预设": entry_preset,
        }
        record = self.plugin._save_library_item(
            name="带预设的历史主题",
            vars_map={"--nts-accent": "#7fb8ff"},
            dark_map={},
            materials=entry_materials,
        )
        local_materials = enabled_materials()
        local_preset = M._blank_params()
        local_preset["global"]["opacity"] = 0.77
        local_materials["custom_presets"] = {
            "本地预设": M._blank_params(),
            "同名预设": local_preset,
        }
        asyncio.run(self.plugin.apply_theme(materials=local_materials))
        self.plugin._apply_theme_record(record["id"])
        stored = self.plugin._read_unlocked()["materials"]
        # 本地独有的必须留下，条目独有的进来
        self.assertEqual(
            set(stored["custom_presets"]), {"本地预设", "条目预设", "同名预设"}
        )
        # 同名以条目为准（条目是「被应用的那一套」，覆盖方向不能反）
        self.assertEqual(
            stored["custom_presets"]["同名预设"]["global"]["opacity"], 0.11
        )

    def test_normalize_keeps_custom_preset_label(self):
        """自定义预设名不能被归一化抹成 custom —— 抹了面板就高亮不了当前卡片。"""
        materials = M.default_materials()
        materials["custom_presets"] = {"玻璃 A": M._blank_params()}
        materials["preset"] = "玻璃 A"
        clean, _warnings = M.normalize_materials(materials)
        self.assertEqual(clean["preset"], "玻璃 A")
        # 反过来：指向空气的标签必须退回 custom，不能留在 theme.json 里。
        materials["preset"] = "不存在的预设"
        clean2, _warnings = M.normalize_materials(materials)
        self.assertEqual(clean2["preset"], "custom")
    def test_builtin_name_cannot_be_shadowed_by_custom_preset(self):
        # 0.15.43 之前能存进去，但 apply_materials 先判 PRESETS、面板也先渲染内置卡：
        # 那条自定义预设永远不会被选中，是「看得见、点不动」的死预设。
        materials = M.default_materials()
        materials["custom_presets"] = {
            "clear": M._blank_params(),
            "Clear": M._blank_params(),
            "跳过": M._blank_params(),
        }
        materials["preset"] = "clear"
        clean, warnings = M.normalize_materials(materials)
        self.assertEqual(list(clean["custom_presets"]), ["跳过"])
        self.assertEqual(len([w for w in warnings if "与内置预设同名" in w]), 2)
        self.assertEqual(clean["preset"], "clear")


if __name__ == "__main__":
    unittest.main()
