"""内置主题（presets/*.json）必须全部通过后端校验器。

内置主题是「开箱即用」的门面：留一个非法值，用户第一次点它就会看到部分变量
被静默丢掉。跑法：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import ROOT, load_backend  # noqa: E402

NS = load_backend()
KNOWN_VARS = NS["KNOWN_VARS"]
_validate_palette = NS["_validate_palette"]

PRESET_DIR = ROOT / "plugin" / "static" / "presets"
REQUIRED_FIELDS = ("schema", "id", "name", "builtin", "saved_at", "note", "vars", "dark_vars")
PRESET_URL = "http://127.0.0.1:48916/plugin/neko_theme_studio/ui/backgrounds/"


def _portable(value):
    """预设里的 url("images/X") 在运行时由 _rewrite_archive_refs 改写成绝对 URL。"""
    if isinstance(value, str):
        return value.replace('url("images/', f'url("{PRESET_URL}')
    return value


class TestPresets(unittest.TestCase):
    def test_presets_dir_has_files(self):
        self.assertTrue(PRESET_DIR.is_dir(), "缺 plugin/static/presets 目录")
        self.assertGreaterEqual(len(list(PRESET_DIR.glob("*.json"))), 16)

    def test_every_preset_validates_cleanly(self):
        for path in sorted(PRESET_DIR.glob("*.json")):
            with self.subTest(preset=path.stem):
                data = json.loads(path.read_text(encoding="utf-8"))
                for field in REQUIRED_FIELDS:
                    self.assertIn(field, data, f"{path.name} 缺字段 {field}")
                self.assertIs(data["builtin"], True)
                self.assertEqual(data["id"], path.stem, "文件名与 id 不一致")
                unknown = set(data["vars"]) | set(data["dark_vars"])
                unknown -= KNOWN_VARS
                self.assertFalse(unknown, f"{path.name} 含未知变量：{sorted(unknown)}")
                light_map = {k: _portable(v) for k, v in data["vars"].items()}
                dark_map = {k: _portable(v) for k, v in data["dark_vars"].items()}
                clean_light, clean_dark, errors = _validate_palette(light_map, dark_map)
                self.assertEqual(errors, [], f"{path.name} 有被拒的值：{errors}")
                self.assertTrue(clean_light or clean_dark, f"{path.name} 校验后为空")

    def test_every_preset_has_note_and_tags(self):
        """面板卡片要显示一句话介绍 + 标签筛选，缺了就会退化成光秃秃的名字。"""
        for path in sorted(PRESET_DIR.glob("*.json")):
            with self.subTest(preset=path.stem):
                data = json.loads(path.read_text(encoding="utf-8"))
                note = data.get("note")
                self.assertIsInstance(note, str)
                self.assertGreaterEqual(len(note.strip()), 8, f"{path.name} 的 note 太短")
                self.assertLessEqual(len(note), 120, f"{path.name} 的 note 太长（后端会截断）")
                tags = data.get("tags")
                if tags is not None:
                    self.assertIsInstance(tags, list)
                    self.assertTrue(all(isinstance(t, str) and t.strip() for t in tags))

    def test_new_feature_presets_expose_glass_and_gradient(self):
        wanted = {
            "porcelain-mist": ("--nts-glass-filter", "--nts-chat-gradient"),
            "midnight-glass": ("--nts-glass-filter",),
            "aurora-drift": ("--nts-chat-gradient",),
            "cyber-neon": ("--nts-user-bubble-gradient", "--nts-ai-bubble-gradient"),
        }
        for preset_id, keys in wanted.items():
            path = PRESET_DIR / f"{preset_id}.json"
            with self.subTest(preset=preset_id):
                self.assertTrue(path.is_file(), f"缺内置主题 {preset_id}.json")
                data = json.loads(path.read_text(encoding="utf-8"))
                merged = dict(data["vars"])
                merged.update(data["dark_vars"])
                for key in keys:
                    self.assertIn(key, merged, f"{preset_id} 没有展示 {key}")


    def test_every_preset_has_a_family(self):
        """v0.2.0：主题库按「风格族」分组浏览，每套预设必须且只能属于一个族。"""
        allowed = set(NS["PRESET_FAMILIES"])
        self.assertEqual(
            allowed,
            {"glassy", "gradient", "dark", "light", "texture", "minimal"},
        )
        for path in sorted(PRESET_DIR.glob("*.json")):
            with self.subTest(preset=path.stem):
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertIn(data.get("family"), allowed, f"{path.name} 的 family 非法")

    def test_liquid_glass_presets_are_really_translucent(self):
        """「真正的液态玻璃」：低 alpha 底色 + 强 backdrop 滤镜 + rim/sheen/noise 齐全。

        这条测试是给设计定的底线，不是审美判断：没有低 alpha 就没有「透」，
        没有 backdrop-filter 就没有「玻璃」，没有 rim/sheen/noise 就只是半透明色块。
        """
        import re as _re

        alpha_re = _re.compile(
            r"rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*([0-9.]+)\s*\)"
        )
        glassy = []
        for path in sorted(PRESET_DIR.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("family") != "glassy":
                continue
            glassy.append(path.stem)
            for mode, key in (("亮", "vars"), ("暗", "dark_vars")):
                theme = data.get(key) or {}
                with self.subTest(preset=path.stem, mode=mode):
                    for var in ("--nts-glass-tint", "--nts-panel-glass-tint"):
                        value = str(theme.get(var) or "")
                        match = alpha_re.search(value)
                        self.assertIsNotNone(match, f"{var} 必须用 rgba 才能透：{value!r}")
                        self.assertLessEqual(
                            float(match.group(1)), 0.35, f"{var} alpha 太高，不透：{value!r}"
                        )
                    chain = str(theme.get("--nts-glass-filter") or "")
                    self.assertIn("blur(", chain, f"缺 backdrop blur：{chain!r}")
                    self.assertIn("saturate(", chain, f"缺 saturate：{chain!r}")
                    self.assertIn("--nts-glass-rim", theme, "缺玻璃边缘反射光")
                    self.assertIn("--nts-glass-sheen", theme, "缺掠光强度")
                    self.assertIn("--nts-glass-noise", theme, "缺雾面颗粒")
                    for var in ("--nts-glass-sheen", "--nts-glass-noise"):
                        value = float(str(theme.get(var)))
                        self.assertGreater(value, 0.0, f"{var} 不应为 0")
                        self.assertLessEqual(value, 1.0, f"{var} 应在 0–1")
        self.assertGreaterEqual(len(glassy), 6, f"液态玻璃族至少 6 套：{glassy}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
