"""v0.4.20：加载器「背景图预热」的接线测试。

逻辑本身由 ``test/loader-warm-selftest.js`` 真跑（假 Image + 可控定时器），
这里只锁「源码是否接好了」这类回归防护：改错文件、漏同步副本、忘记登记自测。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOADER = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
MIRRORS = (
    ROOT / "app" / "neko-theme-studio.js",
    ROOT / "app-patch" / "files" / "neko-theme-studio.js",
)
SELFTEST = ROOT / "test" / "loader-warm-selftest.js"
CI = ROOT / ".github" / "workflows" / "ci.yml"
README = ROOT / "test" / "README.md"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class VersionTests(unittest.TestCase):
    def test_script_version_bumped(self):
        # 不钉死字面版本号：每轮 bump 都会把它顶掉，钉死只会让「上一轮的测试」
        # 在下一轮莫名变红（这个坑已经踩过三次）。这里只锁两件事：
        # 1) SCRIPT_VERSION 仍是 semver；2) 它不低於「背景图预热」引入的 1.5.21。
        match = re.search(r"var SCRIPT_VERSION = '(\d+)\.(\d+)\.(\d+)';", read(LOADER))
        self.assertIsNotNone(match, "loader 里找不到 SCRIPT_VERSION")
        version = tuple(int(x) for x in match.groups())
        self.assertGreaterEqual(version, (1, 5, 21))

    def test_plugin_version_matches(self):
        # 不钉死字面版本号：每轮发布都会 bump，钉死只会让「上一个轮次的测试」
        # 在下一轮莫名其妙变红。这里只锁「三处版本源彼此一致」这件事。
        toml = read(ROOT / "plugin" / "plugin.toml")
        match = re.search(r'^version = "([^"]+)"', toml, re.M)
        self.assertIsNotNone(match, "plugin.toml 里没有 version 行")
        version = match.group(1)
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        self.assertIn('PLUGIN_VERSION = "%s"' % version, read(ROOT / "plugin" / "build_info.py"))
        self.assertIn('version = "%s"' % version, read(ROOT / "plugin" / "pyproject.toml"))

    def test_mirrors_are_identical(self):
        src = LOADER.read_bytes()
        for mirror in MIRRORS:
            with self.subTest(mirror=str(mirror.relative_to(ROOT))):
                self.assertEqual(mirror.read_bytes(), src)


class BlockTests(unittest.TestCase):
    def test_markers_present_and_ordered(self):
        src = read(LOADER)
        begin = src.index("/* ===== IMAGE_WARM_BEGIN ===== */")
        end = src.index("/* ===== IMAGE_WARM_END ===== */")
        self.assertLess(begin, end)
        block = src[begin:end]
        for name in ("function imageUrlsOf(", "function warmImages(", "function markImageWarmed("):
            with self.subTest(name=name):
                self.assertIn(name, block)

    def test_timeout_is_bounded(self):
        src = read(LOADER)
        self.assertIn("var IMAGE_WARM_TIMEOUT_MS = 1500;", src)

    def test_only_plugin_backgrounds_are_warmed(self):
        src = read(LOADER)
        begin = src.index("/* ===== IMAGE_WARM_BEGIN ===== */")
        block = src[begin:src.index("/* ===== IMAGE_WARM_END ===== */")]
        self.assertIn("RE_BG_VALUE.test(v)", block)
        # 不允许把整串 value 直接丢给 Image（那会绕过白名单去请求外链）
        self.assertNotIn("img.src = v", block)
        self.assertIn("img.src = url", block)

    def test_callback_fires_once(self):
        src = read(LOADER)
        begin = src.index("/* ===== IMAGE_WARM_BEGIN ===== */")
        block = src[begin:src.index("/* ===== IMAGE_WARM_END ===== */")]
        self.assertIn("if (fired) return;", block)
        self.assertIn("fired = true;", block)


class GateTests(unittest.TestCase):
    def test_gate_runs_before_style_write(self):
        src = read(LOADER)
        gate = src.index("var warmKey = stampOf(p)")
        style = src.index("var el = styleEl();")
        self.assertLess(gate, style)

    def test_gate_defers_only_when_images_missing(self):
        src = read(LOADER)
        self.assertIn("if (!warmedImages[warmUrls[wi]]) { needWarm = true; break; }", src)
        self.assertIn("if (queued) applyPalette(queued);", src)

    def test_disabled_palette_skips_gate(self):
        src = read(LOADER)
        gate = src[src.index("var warmKey = stampOf(p)") - 200:]
        head = gate[: gate.index("var warmKey")]
        self.assertIn("p.enabled !== false", head)

    def test_does_not_touch_cache_key(self):
        src = read(LOADER)
        self.assertEqual(src.count("var CACHE_KEY = 'neko.themeStudio.palette';"), 1)
        begin = src.index("/* ===== IMAGE_WARM_BEGIN ===== */")
        block = src[begin:src.index("/* ===== IMAGE_WARM_END ===== */")]
        self.assertNotIn("localStorage", block)


class RegistrationTests(unittest.TestCase):
    def test_selftest_exists(self):
        self.assertTrue(SELFTEST.is_file())
        text = read(SELFTEST)
        self.assertIn("PASS ", text)
        self.assertIn("imageUrlsOf", text)
        self.assertIn("warmImages", text)

    def test_ci_runs_it(self):
        ci = read(CI)
        self.assertIn("test/loader-warm-selftest.js", ci)

    def test_readme_lists_it(self):
        self.assertIn("loader-warm-selftest.js", read(README))


if __name__ == "__main__":
    unittest.main()
