"""ROUND 28 后端四个真缺陷的回归测试（v0.5.0）。

每条都对应 `_review/audit28-backend.md` 里一个能造成「用户什么都没做错」也丢数据的
问题，所以断言直接盯磁盘上的文件，而不是只看返回值：

1. **P0-2 排程写回不能清空用户配置**：``_update_schedule_stamp`` 只为写 ``last_*``
   而读盘；如果读盘顺手把「主题已删除」的时段丢掉再整份写回，用户配置就被永久清除，
   而且面板的 ``stale`` 提示也一起消失（连「重新导入就能恢复」都做不到）。
2. **P0-1 导出不能超过导入上限**：导出用 Ok、恢复用 SdkError 是最坏的组合 ——
   用户往往在重装/换机那一刻才发现自己唯一的备份恢复不了。
3. **P1-3 删除/改名按请求 id 定位文件**：文件内 ``id`` 字段被改坏时，旧实现会删错
   或改错另一套主题。
4. **P1-4 导入全被拒必须失败**：旧实现返回 Ok，还把用户原来的调色板清空、名字改掉。
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from offline_backend import PLUGIN_DIR, load_backend
from test_library_archive import add_theme, make_plugin, must_err, unwrap

NS = load_backend()
SdkError = NS["SdkError"]
ARCHIVE_MAX_BYTES = NS["ARCHIVE_MAX_BYTES"]

BACKEND = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8-sig")

BASE_VARS = {
    "--nts-accent": "#7fb8ff",
    "--nts-panel-bg": "rgba(12, 16, 28, 0.72)",
    "--nts-text": "#e8eefc",
}


def write_schedule(plugin, payload: dict) -> Path:
    path = plugin.static_dir / "schedule.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def read_schedule(plugin) -> dict:
    return json.loads((plugin.static_dir / "schedule.json").read_text(encoding="utf-8"))


def write_theme(plugin, payload: dict) -> None:
    plugin.theme_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def call(plugin, entry: str, **kwargs):
    return asyncio.run(getattr(plugin, entry)(**kwargs))


class ScheduleStampTests(unittest.TestCase):
    """P0-2：写回运行时标记时，绝不能把失效时段当成「用户配置」清掉。"""

    def test_stamp_write_keeps_stale_zone(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            write_schedule(
                plugin,
                {
                    "schema": 2,
                    "enabled": True,
                    "zones": {"day": "warm-2", "evening": "ghost-theme"},
                    "weekend_zones": {"night": "ghost-weekend"},
                },
            )

            plugin._update_schedule_stamp(
                last_zone="day", last_day_kind="weekday", last_theme="warm-2"
            )

            saved = read_schedule(plugin)
            # 失效时段原样留在文件里 —— tick 走 missing 分支去抖，用户重选/重导入即可恢复。
            self.assertEqual(saved["zones"]["evening"], "ghost-theme")
            self.assertEqual(saved["weekend_zones"]["night"], "ghost-weekend")
            self.assertEqual(saved["zones"]["day"], "warm-2")
            self.assertEqual(saved["last_zone"], "day")
            self.assertEqual(saved["last_theme"], "warm-2")

    def test_normal_read_still_reports_stale(self):
        """默认读路径仍然要丢掉失效时段 —— 否则面板的 stale 提示就没了。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            write_schedule(
                plugin,
                {"schema": 2, "enabled": True, "zones": {"evening": "ghost-theme"}},
            )

            schedule = plugin._read_schedule()
            self.assertEqual(schedule["zones"]["evening"], "")
            stale = getattr(plugin, "_schedule_stale", [])
            self.assertEqual(
                [(item["zone"], item["theme_id"]) for item in stale],
                [("evening", "ghost-theme")],
            )

    def test_save_entry_still_rejects_ghost_theme(self):
        """保存路径（strict）必须继续拒绝不存在的主题，别把宽容读扩散到写入。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            must_err(
                self,
                call(plugin, "save_schedule", enabled=True, zones={"day": "ghost-theme"}),
                "不存在",
            )


class ExportSizeTests(unittest.TestCase):
    """P0-1：导出前自己先卡上限一次。"""

    def test_guard_rejects_oversized_payload(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            original = NS["ARCHIVE_MAX_BYTES"]
            NS["ARCHIVE_MAX_BYTES"] = 64
            try:
                with self.assertRaises(SdkError) as ctx:
                    plugin._guard_export_size(b"x" * 65, what="这个分享包")
            finally:
                NS["ARCHIVE_MAX_BYTES"] = original
            self.assertIn("恢复上限", str(ctx.exception))
            self.assertIn("去掉", str(ctx.exception))

    def test_guard_accepts_matching_size(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            plugin._guard_export_size(b"x" * 10, what="这个分享包")  # 不应抛

    def test_share_archive_checks_size(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            original = NS["ARCHIVE_MAX_BYTES"]
            NS["ARCHIVE_MAX_BYTES"] = 32
            try:
                with self.assertRaises(SdkError) as ctx:
                    plugin._build_archive(
                        name="大包", vars_map=BASE_VARS, dark_map={}, note="", tags=[]
                    )
            finally:
                NS["ARCHIVE_MAX_BYTES"] = original
            self.assertIn("这个分享包", str(ctx.exception))

    def test_library_archive_checks_size(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            original = NS["ARCHIVE_MAX_BYTES"]
            NS["ARCHIVE_MAX_BYTES"] = 32
            try:
                with self.assertRaises(SdkError) as ctx:
                    plugin._build_library_archive()
            finally:
                NS["ARCHIVE_MAX_BYTES"] = original
            self.assertIn("恢复上限", str(ctx.exception))

    def test_export_entry_reports_readable_error(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            write_theme(plugin, {"schema": 1, "name": "x", "vars": BASE_VARS, "dark_vars": {}})
            original = NS["ARCHIVE_MAX_BYTES"]
            NS["ARCHIVE_MAX_BYTES"] = 32
            try:
                ok, value = unwrap(
                    call(plugin, "export_to_file", kind="zip", target="plugin")
                )
            finally:
                NS["ARCHIVE_MAX_BYTES"] = original
            self.assertFalse(ok, value)
            self.assertIn("恢复上限", str(value))


class LibraryIdTargetingTests(unittest.TestCase):
    """P1-3：定位文件只看请求 id（= 文件名），不看记录里的 id 字段。"""

    def _two_themes_with_shared_record_id(self, tmp: Path):
        plugin = make_plugin(tmp)
        add_theme(tmp, "alpha", name="甲")
        add_theme(tmp, "beta", name="乙")
        for theme_id in ("alpha", "beta"):
            path = tmp / "static" / "themes" / f"{theme_id}.json"
            record = json.loads(path.read_text(encoding="utf-8"))
            record["id"] = "alpha"  # 两个文件都自称 alpha
            path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        return plugin

    def test_delete_targets_requested_file(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = self._two_themes_with_shared_record_id(tmp)

            ok, value = unwrap(call(plugin, "delete_theme", theme_id="beta"))
            self.assertTrue(ok, value)
            self.assertEqual(value["theme_id"], "beta")
            names = sorted(p.name for p in (tmp / "static" / "themes").glob("*.json"))
            self.assertEqual(names, ["alpha.json"])

    def test_update_targets_requested_file(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = self._two_themes_with_shared_record_id(tmp)

            ok, value = unwrap(
                call(plugin, "update_theme_meta", theme_id="beta", name="乙改")
            )
            self.assertTrue(ok, value)
            self.assertEqual(value["theme_id"], "beta")
            alpha = json.loads(
                (tmp / "static" / "themes" / "alpha.json").read_text(encoding="utf-8")
            )
            beta = json.loads(
                (tmp / "static" / "themes" / "beta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(alpha["name"], "甲")
            self.assertEqual(beta["name"], "乙改")

    def test_missing_file_reports_not_found(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "alpha", name="甲")
            # 直接调底层路径分支：manifest 存在但文件被外部删掉
            (tmp / "static" / "themes" / "alpha.json").unlink()
            must_err(self, call(plugin, "delete_theme", theme_id="alpha"), "没有这个主题")


class ImportRejectTests(unittest.TestCase):
    """P1-4：全被拒的导入不能返回 Ok，更不能动用户调色板。"""

    def _plugin_with_palette(self, tmp: Path):
        plugin = make_plugin(tmp)
        write_theme(
            plugin,
            {
                "schema": 1,
                "name": "我的配色",
                "enabled": True,
                "updated_at": "2026-11-19T00:00:00+08:00",
                "vars": dict(BASE_VARS),
                "dark_vars": {"--nts-accent": "#9fc8ff"},
            },
        )
        return plugin

    def test_all_rejected_returns_error_and_keeps_palette(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = self._plugin_with_palette(tmp)
            before = plugin.theme_path.read_bytes()

            payload = json.dumps(
                {"name": "Garbage", "vars": {"--nope-nope": "???"}, "dark_vars": {}},
                ensure_ascii=False,
            )
            ok, value = unwrap(call(plugin, "import_theme", payload=payload))
            self.assertFalse(ok, value)
            self.assertIn("已取消导入", str(value))
            self.assertEqual(plugin.theme_path.read_bytes(), before)

    def test_partial_import_reports_cleared_counts(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = self._plugin_with_palette(tmp)

            # 基线用后端自己的读取语义算：不在 KNOWN_VARS 里的变量读进来就被丢掉，
            # 用测试里写死的字面量数量对比会假失败。
            before = plugin._read_unlocked(strict=True)
            payload = json.dumps(
                {"vars": {"--nts-accent": "#ff0000"}}, ensure_ascii=False
            )
            ok, value = unwrap(call(plugin, "import_theme", payload=payload))
            self.assertTrue(ok, value)
            self.assertEqual(value["vars"], {"--nts-accent": "#ff0000"})
            self.assertIn("cleared", value)
            self.assertEqual(value["cleared"]["light"], len(before["vars"]) - 1)
            self.assertEqual(value["cleared"]["dark"], len(before["dark_vars"]))

    def test_strict_read_aborts_when_baseline_unreadable(self):
        """基线读不出来时不能拿默认值当基线把用户配置覆盖掉。"""
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = self._plugin_with_palette(tmp)
            plugin.theme_path.write_text("{ not json", encoding="utf-8")

            payload = json.dumps({"vars": {"--nts-accent": "#ff0000"}})
            ok, value = unwrap(call(plugin, "import_theme", payload=payload))
            self.assertFalse(ok, value)
            self.assertEqual(plugin.theme_path.read_text(encoding="utf-8"), "{ not json")


class SchedulePayloadTests(unittest.TestCase):
    """P2：get_schedule 要给出 windows（面板时段边界文案）与 now.theme_id。"""

    def test_get_schedule_contains_windows(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            write_schedule(
                plugin,
                {
                    "schema": 2,
                    "enabled": True,
                    "zones": {"morning": "warm-2"},
                    "weekend_zones": {},
                },
            )

            ok, value = unwrap(call(plugin, "get_schedule"))
            self.assertTrue(ok, value)
            windows = value["windows"]
            self.assertEqual(
                [item["zone"] for item in windows], ["morning", "day", "evening", "night"]
            )
            for item in windows:
                self.assertIsInstance(item["start"], int)
                self.assertIsInstance(item["end"], int)
            self.assertIn("day_kind", value["now"])
            self.assertIsInstance(value["now"]["theme_id"], str)

    def test_unknown_weekend_zone_reported_with_prefix(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            must_err(
                self,
                call(
                    plugin,
                    "save_schedule",
                    enabled=True,
                    zones={},
                    weekend_zones={"noon": "warm-2"},
                ),
                "周末",
            )


if __name__ == "__main__":
    unittest.main()
