#!/usr/bin/env python3
"""空主题守卫：仓库里不该再出现「零配色变量」的条目，历史遗留条目也不许清空当前配色。

背景（2026-11-21 状态机探针 audit_state_fuzz.py 发现）：
default_palette() / reset_theme() 的 vars 都是 {}，而 save_theme 只读盘不校验，
于是能在仓库里落一条 vars={} 的条目；之后 apply_saved_theme 会用它整片覆盖
theme.json 的 vars —— 面板显示「已应用」，用户看到的是整套配色凭空消失。
两端各加一道守卫，并用单测钉住：保存端拒绝空配色，应用端拒绝旧版遗留下来的空条目。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_DIR = _HERE.parent
for _path in (str(_PLUGIN_DIR), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from offline_backend import load_backend
from test_library_archive import make_plugin, must_err, unwrap

NS = load_backend()


class EmptyThemeGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.plugin = make_plugin(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _library_files(self):
        return sorted((self.plugin.static_dir / "themes").glob("*.json"))

    def _ok(self, result):
        ok, value = unwrap(result)
        self.assertTrue(ok, f"期望成功，实际失败：{value!r}")
        return value

    def _palette_vars(self) -> dict:
        return json.loads(self.plugin.theme_path.read_text(encoding="utf-8"))["vars"]

    def test_fresh_palette_cannot_be_saved(self) -> None:
        # 首次运行：theme.json 还不存在，palette 的 vars 是空的。
        must_err(self, asyncio.run(self.plugin.save_theme(name="空条目")))
        self.assertEqual(self._library_files(), [])

    def test_reset_then_save_is_rejected(self) -> None:
        self._ok(asyncio.run(self.plugin.apply_theme(name="有颜色", vars={"--nts-accent": "#40C5F1"})))
        self._ok(asyncio.run(self.plugin.reset_theme()))
        must_err(self, asyncio.run(self.plugin.save_theme(name="重置后")))
        self.assertEqual(self._library_files(), [])

    def test_all_invalid_values_cannot_be_saved(self) -> None:
        self.plugin.theme_path.write_text(
            json.dumps({"vars": {"--nts-accent": 42}, "dark_vars": {}}),
            encoding="utf-8",
        )
        must_err(self, asyncio.run(self.plugin.save_theme(name="坏值")))
        self.assertEqual(self._library_files(), [])

    def test_legacy_empty_library_item_is_rejected_on_apply(self) -> None:
        self._ok(asyncio.run(self.plugin.apply_theme(name="好配色", vars={"--nts-accent": "#40C5F1"})))
        saved = self._ok(asyncio.run(self.plugin.save_theme(name="仓库条目")))["theme"]["id"]
        path = self.plugin.static_dir / "themes" / f"{saved}.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["vars"] = {}
        record["dark_vars"] = {}
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        self._ok(asyncio.run(self.plugin.apply_theme(name="另一套", vars={"--nts-accent": "#123456"})))
        must_err(self, asyncio.run(self.plugin.apply_saved_theme(id=saved)))
        # 关键：拒绝之后盘上的配色必须原样保留，不能被半截写入。
        self.assertEqual(self._palette_vars(), {"--nts-accent": "#123456"})
        self.assertEqual(
            json.loads(self.plugin.theme_path.read_text(encoding="utf-8"))["name"],
            "另一套",
        )

    def test_normal_save_and_apply_still_works(self) -> None:
        self._ok(asyncio.run(self.plugin.apply_theme(name="原样", vars={"--nts-accent": "#40C5F1"})))
        saved = self._ok(asyncio.run(self.plugin.save_theme(name="正常条目")))["theme"]["id"]
        self._ok(asyncio.run(self.plugin.reset_theme()))
        outcome = self._ok(asyncio.run(self.plugin.apply_saved_theme(id=saved)))
        self.assertTrue(outcome["applied"])
        self.assertEqual(self._palette_vars(), {"--nts-accent": "#40C5F1"})


if __name__ == "__main__":
    unittest.main()
