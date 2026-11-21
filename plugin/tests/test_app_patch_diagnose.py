"""``diagnose_app_patch`` 的离线回归（v0.5.0 真机 e2e 抓出来的一个假红）。

真机第一次跑 ``repair_app {dry_run: true}`` 时，面板报了 14 个红项「页面没有注入」，
但那些页面（游戏页、局部片段）根本没有 ``dark-mode.css`` 锚点 —— ``_patch_template``
从来不会往它们里面写标记，属于「跳过」。只读诊断用了另一套判据（没标记就算缺失），
于是「点修复也修不掉」的假报警出现了。

这里锁住三件事：
1. 没有锚点的页面被归到 ``templates_skipped``，不参与 ``ok`` 判定；
2. 有锚点但没标记的页面归到 ``templates_missing``（这才是真需要修的）；
3. 标记与当前两件套哈希一致时 ``ok=True`` / ``needs_repair=False``。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import _app_patch as ap  # noqa: E402

ANCHORED = """<!doctype html>
<html><head>
<link rel="stylesheet" href="/static/css/dark-mode.css">
</head><body></body></html>
"""


def write_loader(plugin_root: Path) -> tuple[bytes, bytes]:
    loader = plugin_root / "static" / "loader"
    loader.mkdir(parents=True, exist_ok=True)
    js = b"// loader js v-test\n(function () { 'use strict'; })();\n"
    css = b"/* loader css v-test */\n:root { --x: 1; }\n"
    (loader / "neko-theme-studio.js").write_bytes(js)
    (loader / "neko-theme-studio.css").write_bytes(css)
    return js, css


class DiagnoseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.plugin_root = root / "plugin"
        self.app_root = root / "app"
        templates = self.app_root / "resources" / "bin" / "templates"
        templates.mkdir(parents=True)
        self.js, self.css = write_loader(self.plugin_root)
        self.anchored = templates / "chat.html"
        self.anchored.write_text(ANCHORED, encoding="utf-8")
        # 没有 dark-mode.css 锚点的页面：例如游戏页 / 局部片段
        self.plain = templates / "theater.html"
        self.plain.write_text("<!doctype html>\n<html><body><p>no anchor</p></body></html>\n", encoding="utf-8")
        self._orig_find = ap.find_app_root
        ap.find_app_root = lambda plugin_root, tried=None: (tried.extend([str(self.app_root)]) if isinstance(tried, list) else None) or self.app_root
        self._orig_flag = ap.disabled_flag_path
        ap.disabled_flag_path = lambda: None

    def tearDown(self) -> None:
        ap.find_app_root = self._orig_find
        ap.disabled_flag_path = self._orig_flag
        self.tmp.cleanup()

    def deploy_assets(self) -> None:
        """把两件套「装」到假宿主里，模拟应用侧已经就位。"""
        static = self.app_root / "resources" / "bin" / "static"
        (static / "css").mkdir(parents=True, exist_ok=True)
        (static / "neko-theme-studio.js").write_bytes(self.js)
        (static / "css" / "neko-theme-studio.css").write_bytes(self.css)

    def run_diagnose(self) -> dict:
        return ap.diagnose_app_patch(self.plugin_root)

    def test_anchor_less_page_is_skipped_not_missing(self) -> None:
        result = self.run_diagnose()
        self.assertIn("theater.html", result["templates_skipped"])
        self.assertNotIn("theater.html", result["templates_missing"])
        self.assertIn("chat.html", result["templates_missing"])
        self.assertFalse(result["ok"])
        self.assertTrue(result["needs_repair"])

    def test_all_patched_means_ok(self) -> None:
        self.deploy_assets()
        block = ap.build_marker_block(ap._sha8(self.js), ap._sha8(self.css))
        text = self.anchored.read_text(encoding="utf-8").replace(
            '<link rel="stylesheet" href="/static/css/dark-mode.css">',
            '<link rel="stylesheet" href="/static/css/dark-mode.css">' + block,
        )
        self.anchored.write_text(text, encoding="utf-8")
        result = self.run_diagnose()
        self.assertIn("chat.html", result["templates_unchanged"])
        self.assertEqual(result["templates_missing"], [])
        self.assertEqual(result["templates_stale"], [])
        self.assertTrue(result["ok"])
        self.assertFalse(result["needs_repair"])

    def test_stale_block_is_reported(self) -> None:
        old = ap.build_marker_block("deadbeef", "cafebabe")
        text = self.anchored.read_text(encoding="utf-8").replace(
            '<link rel="stylesheet" href="/static/css/dark-mode.css">',
            '<link rel="stylesheet" href="/static/css/dark-mode.css">' + old,
        )
        self.anchored.write_text(text, encoding="utf-8")
        result = self.run_diagnose()
        self.assertIn("chat.html", result["templates_stale"])
        self.assertFalse(result["ok"])

    def test_dry_run_writes_nothing(self) -> None:
        before = {
            "chat": self.anchored.read_bytes(),
            "theater": self.plain.read_bytes(),
            "js": (self.plugin_root / "static" / "loader" / "neko-theme-studio.js").read_bytes(),
        }
        self.run_diagnose()
        self.assertEqual(self.anchored.read_bytes(), before["chat"])
        self.assertEqual(self.plain.read_bytes(), before["theater"])
        self.assertEqual(
            (self.plugin_root / "static" / "loader" / "neko-theme-studio.js").read_bytes(),
            before["js"],
        )
        deployed = self.app_root / "resources" / "bin" / "static" / "neko-theme-studio.js"
        self.assertFalse(deployed.exists(), "只读诊断不该写宿主 static 目录")


if __name__ == "__main__":
    unittest.main()
