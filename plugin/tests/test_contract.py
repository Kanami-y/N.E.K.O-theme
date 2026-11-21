"""三端契约一致性测试：Python 校验器 / 面板 CATALOG / 加载器白名单 / 生成的 CSS。

这几处曾经各自维护一份变量表，靠人肉同步 —— 结果是「面板能存、加载器丢值」
「后端存了、加载器整条丢弃」这类静默失败。测试只做一件事：让漂移立刻红。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import HAS_REPO_TREE, PLUGIN_DIR, ROOT, load_backend  # noqa: E402

NS = load_backend()
KNOWN_VARS = NS["KNOWN_VARS"]
_is_safe_value = NS["_is_safe_value"]
_value_kind = NS["_value_kind"]
_filter_ok = NS["_filter_chain_ok"]
_gradient_ok = NS["_gradient_ok"]

APP_JS = (PLUGIN_DIR / "static" / "app.js").read_text(encoding="utf-8")
LOADER_JS = (
    PLUGIN_DIR / "static" / "loader" / "neko-theme-studio.js"
).read_text(encoding="utf-8")
VARS_JSON_PATH = ROOT / "build" / "vars.json"

RE_VERSION = re.compile(r'version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
RE_PLUGIN_VERSION = re.compile(r'PLUGIN_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"')
RE_CATALOG_KEY = re.compile(r"key\s*:\s*'(--nts-[a-z0-9-]+)'")
RE_LOADER_KIND = re.compile(
    r"'(--nts-[a-z0-9-]+)'\s*:\s*'"
    r"(color|length|blur|number|font|shadow|image|switch|time|filter|gradient|auto)'"
)


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class TestBackendValidators(unittest.TestCase):
    def test_known_vars_are_prefixed_and_complete(self):
        self.assertGreaterEqual(len(KNOWN_VARS), 86)
        for name in KNOWN_VARS:
            self.assertRegex(name, r"^--nts-[a-z0-9-]{1,60}$")
        for name in (
            "--nts-glass-filter",
            "--nts-glass-tint",
            "--nts-glass-highlight",
            "--nts-bubble-glass-filter",
            "--nts-bubble-glass-tint",
            "--nts-chat-gradient",
            "--nts-panel-gradient",
            "--nts-user-bubble-gradient",
            "--nts-ai-bubble-gradient",
        ):
            self.assertIn(name, KNOWN_VARS)

    def test_filter_chain_accepts(self):
        for value in (
            "blur(18px)",
            "blur(40px)",
            "saturate(120%)",
            "blur(12px) saturate(140%)",
            "blur(8px) saturate(180%) brightness(110%) contrast(105%)",
        ):
            self.assertTrue(_filter_ok(value), value)

    def test_filter_chain_rejects(self):
        for value in (
            "",
            "blur(41px)",
            "blur(20)",
            "blur(-4px)",
            "blur(20px) blur(10px)",
            "saturate(401%)",
            "blur(20px) saturate(120%) brightness(110%) contrast(105%) grayscale(50%)",
            "url(https://evil.example/x.png)",
            "var(--x)",
            "blur(20PX)",
        ):
            self.assertFalse(_filter_ok(value), value)

    def test_gradient_accepts(self):
        for value in (
            "linear-gradient(135deg, #eef4ff 0%, #dfe9ff 100%)",
            "linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(210,230,255,0.6) 60%, #ffffff 100%)",
            "radial-gradient(#fff 0%, #eef 100%)",
        ):
            self.assertTrue(_gradient_ok(value), value)

    def test_gradient_rejects(self):
        for value in (
            "",
            "linear-gradient(135deg, #fff, #000)",  # 停止点必须带百分比
            "linear-gradient(135deg, #fff 0%, #000)",  # 单端缺百分比
            "linear-gradient(#fff 0%, #000 100%)",  # 缺角度
            "linear-gradient(135deg, #fff 0%, #000 120%)",  # 超过 100%
            "linear-gradient(135deg, #fff 0%, #000 100%, #222 50%, #333 70%, #444 90%)",
            "conic-gradient(#fff 0%, #000 100%)",
            "url(https://evil.example/x.png)",
            "expression(alert(1))",
        ):
            self.assertFalse(_gradient_ok(value), value)

    def test_value_kind(self):
        self.assertEqual(_value_kind("--nts-glass-filter"), "filter")
        self.assertEqual(_value_kind("--nts-chat-gradient"), "gradient")
        self.assertEqual(_value_kind("--nts-panel-glass-blur"), "blur")

    def test_is_safe_value_routes_new_kinds(self):
        self.assertTrue(_is_safe_value("--nts-glass-filter", "blur(16px) saturate(130%)"))
        self.assertFalse(_is_safe_value("--nts-glass-filter", "blur(99px)"))
        self.assertTrue(_is_safe_value("--nts-chat-gradient", "linear-gradient(180deg, #fff 0%, #eef 100%)"))
        self.assertFalse(_is_safe_value("--nts-chat-gradient", "linear-gradient(180deg, #fff 0%)"))
        # 老变量不能被新分支误伤
        self.assertTrue(_is_safe_value("--nts-panel-glass-tint", "transparent"))
        self.assertTrue(_is_safe_value("--nts-panel-glass-tint", "rgba(255, 255, 255, 0.6)"))

    def test_keyword_colors_include_transparent_and_currentcolor(self):
        for value in ("transparent", "currentcolor"):
            self.assertTrue(_is_safe_value("--nts-panel-glass-tint", value), value)


class TestThreeWayContract(unittest.TestCase):
    """后端 KNOWN_VARS ↔ 面板 CATALOG ↔ 加载器 NON_COLOR_VARS ↔ 生成的 CSS。"""

    def test_every_known_var_is_editable_in_panel(self):
        catalog = set(RE_CATALOG_KEY.findall(APP_JS))
        self.assertEqual(len(catalog), len(set(catalog)), "CATALOG 里有重复 key")
        missing = KNOWN_VARS - catalog
        extra = catalog - KNOWN_VARS
        self.assertFalse(missing, f"后端认识但面板编辑不到：{sorted(missing)}")
        self.assertFalse(extra, f"面板里有后端不认识的变量：{sorted(extra)}")

    def test_loader_kinds_only_cover_known_vars(self):
        kinds = dict(RE_LOADER_KIND.findall(LOADER_JS))
        self.assertTrue(kinds, "没能从加载器里解析出 NON_COLOR_VARS")
        unknown = set(kinds) - KNOWN_VARS
        self.assertFalse(unknown, f"加载器白名单里有后端不认识的变量：{sorted(unknown)}")

    def test_v020_glass_vars_reach_all_three_layers(self):
        """v0.2.0 的三个玻璃质感变量必须三端认识，且 kind 一致。"""
        self.assertEqual(_value_kind("--nts-glass-rim"), "color")
        self.assertTrue(_is_safe_value("--nts-glass-rim", "rgba(255, 255, 255, 0.55)"))
        self.assertTrue(_is_safe_value("--nts-glass-rim", "transparent"))
        for name in ("--nts-glass-sheen", "--nts-glass-noise"):
            self.assertEqual(_value_kind(name), "number", name)
            self.assertTrue(_is_safe_value(name, "0.55"), name)
            self.assertTrue(_is_safe_value(name, "0"), name)
            self.assertFalse(_is_safe_value(name, "1.5"), f"{name} 应限制在 0–1")
            self.assertFalse(_is_safe_value(name, "blur(4px)"), name)
            kinds = dict(RE_LOADER_KIND.findall(LOADER_JS))
            self.assertEqual(kinds.get(name), "number", f"加载器没把 {name} 当 number")
        glass_css = LOADER_JS
        self.assertIn("nts-glass-sheen", glass_css, "加载器缺掠光实现")
        self.assertIn("nts-glass-noise", glass_css, "加载器缺雾面颗粒实现")

    def test_v030_liquid_glass_material_reaches_all_three_layers(self):
        """v0.3.0 的 Apple 液态玻璃材质三变量：三端同 kind，且加载器真的有实现。"""
        for name in (
            "--nts-glass-lens",
            "--nts-glass-thickness",
            "--nts-glass-specular",
        ):
            self.assertEqual(_value_kind(name), "number", name)
            for good in ("0", "0.7", "1", "55%"):
                self.assertTrue(_is_safe_value(name, good), f"{name}={good} 应被接受")
            for bad in ("1.5", "-0.2", "blur(4px)", "linear-gradient(red, blue)"):
                self.assertFalse(_is_safe_value(name, bad), f"{name}={bad} 应被拒绝")
            kinds = dict(RE_LOADER_KIND.findall(LOADER_JS))
            self.assertEqual(kinds.get(name), "number", f"加载器没把 {name} 当 number")
            self.assertIn(name, LOADER_JS, f"加载器源码里没有 {name}")

        # 加载器必须有对应的材质实现（不是只登记变量名）
        self.assertIn("--nts-spec-x", LOADER_JS, "加载器缺镜面高光位置变量")
        self.assertIn("initGlassPointer", LOADER_JS, "加载器缺指针跟随初始化")
        self.assertIn("nts-scroll-k", LOADER_JS, "加载器缺滚动流动变量")
        self.assertIn("nts-glass-sheen", LOADER_JS, "加载器缺掠光实现")

        # 面板必须可编辑（CATALOG 覆盖）
        app_js = APP_JS
        for name in ("--nts-glass-lens", "--nts-glass-thickness", "--nts-glass-specular"):
            self.assertIn("'" + name + "'", app_js, f"面板 CATALOG 缺 {name}")

        # 至少 6 套玻璃预设要给出材质参数（否则用户看不到效果）
        presets = PLUGIN_DIR / "static" / "presets"
        glassy = []
        for path in sorted(presets.glob("*.json")):
            data = json.loads(_read(path))
            if data.get("family") != "glassy":
                continue
            glassy.append(path.name)
            for blob_name in ("vars", "dark_vars"):
                blob = data.get(blob_name) or {}
                for name in ("--nts-glass-lens", "--nts-glass-thickness", "--nts-glass-specular"):
                    self.assertIn(name, blob, f"{path.name} 的 {blob_name} 缺 {name}")
        self.assertGreaterEqual(len(glassy), 6, f"玻璃族预设不足 6 套：{glassy}")

    def test_v040_light_engine_reaches_all_three_layers(self):
        """0.4.0 光效引擎：指针光源 / 边缘分光 / 流动焦散，三端必须同 kind 同语义。"""
        names = ("--nts-ambient-glow", "--nts-glass-dispersion", "--nts-glass-caustic")
        for name in names:
            self.assertIn(name, KNOWN_VARS, f"后端 KNOWN_VARS 缺 {name}")
            self.assertEqual(_value_kind(name), "number", f"{name} 后端 kind 不是 number")
            for good in ("0", "0.45", "1", "55%"):
                self.assertTrue(_is_safe_value(name, good), f"{name}={good} 应合法")
            for bad in ("-0.2", "1.5", "blur(3px)", "linear-gradient(90deg, #fff 0%, #000 100%)"):
                self.assertFalse(_is_safe_value(name, bad), f"{name}={bad} 应非法")

        # 加载器侧：白名单同 kind，且实现标记存在
        for name in names:
            self.assertRegex(LOADER_JS, r"'" + re.escape(name) + r"': 'number'", f"加载器白名单缺 {name}")
        for marker in ("--nts-light-x", "nts-glass-caustic", "data-nts-paused", "syncAnimationPause"):
            self.assertIn(marker, LOADER_JS, f"加载器缺 {marker}")

        # 面板侧：CATALOG 必须能编辑
        for name in names:
            self.assertIn("'" + name + "'", APP_JS, f"面板 CATALOG 缺 {name}")

        # 玻璃族预设应给出推荐值（否则用户开箱看不到光效）
        presets = PLUGIN_DIR / "static" / "presets"
        glassy = []
        for path in sorted(presets.glob("*.json")):
            data = json.loads(_read(path))
            if data.get("family") != "glassy":
                continue
            glassy.append(path.name)
            for blob_name in ("vars", "dark_vars"):
                blob = data.get(blob_name) or {}
                for name in names:
                    self.assertIn(name, blob, f"{path.name} 的 {blob_name} 缺 {name}")
        self.assertGreaterEqual(len(glassy), 6, f"玻璃族预设不足 6 套：{glassy}")

    def test_generated_css_vars_are_known(self):
        self.assertTrue(VARS_JSON_PATH.is_file(), "缺 build/vars.json：先跑 tools/gen-css.js")
        data = json.loads(_read(VARS_JSON_PATH))
        unknown = set(data) - KNOWN_VARS
        self.assertFalse(unknown, f"生成的 CSS 里有后端不认识的变量：{sorted(unknown)}")
        for name in (
            "--nts-glass-filter",
            "--nts-bubble-glass-filter",
            "--nts-chat-gradient",
            "--nts-panel-gradient",
            "--nts-user-bubble-gradient",
            "--nts-ai-bubble-gradient",
        ):
            self.assertIn(name, data, f"生成的 CSS 里没有 {name} 的规则")


class TestVersionSingleSource(unittest.TestCase):
    def test_plugin_version_matches_generated_files(self):
        manifest = _read(PLUGIN_DIR / "plugin.toml")
        version = RE_VERSION.search(manifest)
        self.assertIsNotNone(version, "plugin.toml 里没有 version")
        expected = version.group(1)
        build_info = RE_PLUGIN_VERSION.search(_read(PLUGIN_DIR / "build_info.py"))
        self.assertIsNotNone(build_info)
        self.assertEqual(build_info.group(1), expected, "build_info.py 版本漂移")
        index = _read(PLUGIN_DIR / "static" / "index.html")
        tag = re.search(r'version-tag[^>]*>[^v]*v([0-9]+\.[0-9]+\.[0-9]+)<', index)
        self.assertIsNotNone(tag, "index.html 里找不到可见版本号（version-tag）")
        self.assertEqual(tag.group(1), expected, "index.html 可见版本号漂移")
        refs = set(re.findall(r"\?v=([0-9]+\.[0-9]+\.[0-9]+)-", index))
        self.assertTrue(refs, "index.html 里没有 ?v=<version>-<hash8> 资源查询串")
        self.assertEqual(refs, {expected}, "index.html 资源查询串版本漂移")


if __name__ == "__main__":
    unittest.main(verbosity=2)


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
