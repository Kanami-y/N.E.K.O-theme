"""「工作日 / 周末两套时段表」（v0.4.19）的离线测试。

四块容易回退的东西：

1. **星期几 → 工作日/周末只有一份数据**（``SCHEDULE_WEEKEND_WEEKDAYS``）；
   写死 5/6 的地方多一处，就会和面板文案、加载器判定漂移。
2. **周末表为空 = 沿用工作日**：老版本 schedule.json 没有 ``weekend_zones``，
   读进来必须退化成空表而不是报错。
3. **跨天型边界必须重新切**：周日 23:30（night，周末表）→ 周一 00:30（night，
   工作日表）时段名一样但表不同，只比 ``last_zone`` 会漏切。
4. **保存时不传 weekend_zones = 保留原值**：旧面板保存时不会带这个字段，
   直接清空会让用户配好的周末表凭空消失。

跑法：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
_day_kind_for = NS["_day_kind_for"]
SCHEDULE_ZONES = NS["SCHEDULE_ZONES"]
SCHEDULE_DAY_KINDS = NS["SCHEDULE_DAY_KINDS"]
SCHEDULE_WEEKEND_WEEKDAYS = NS["SCHEDULE_WEEKEND_WEEKDAYS"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8")
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "plugin" / "static" / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "plugin" / "static" / "style.css").read_text(encoding="utf-8")


def make_plugin(tmp: Path):
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    plugin.static_dir.mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "presets").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "themes").mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    plugin._schedule_stop = False
    plugin._schedule_started = False
    plugin._schedule_last_result = {}
    return plugin


def write_preset(tmp: Path, theme_id: str, name: str) -> None:
    payload = {
        "schema": 1,
        "name": name,
        "vars": {"--nts-accent": "#7fb8ff"},
        "dark_vars": {"--nts-accent": "#9fd0ff"},
        "builtin": True,
    }
    (tmp / "static" / "presets" / f"{theme_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def unwrap(result):
    value = result.value
    if isinstance(value, SdkError):
        raise AssertionError(f"期望 Ok，实际 Err：{value}")
    return value


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        write_preset(self.tmp, "starry-meow", "星辰喵")
        write_preset(self.tmp, "yui-ice", "唯冰")

    def tearDown(self):
        self._tmp.cleanup()

    def save_raw(self, payload: dict) -> None:
        self.plugin._save_schedule_unlocked(payload)


class DayKindTests(unittest.TestCase):
    def test_weekdays_are_weekday(self):
        for weekday in range(0, 5):
            self.assertEqual(_day_kind_for(weekday), "weekday", weekday)

    def test_saturday_and_sunday_are_weekend(self):
        self.assertEqual(_day_kind_for(5), "weekend")
        self.assertEqual(_day_kind_for(6), "weekend")

    def test_bad_input_falls_back_to_weekday(self):
        for value in (None, "abc", [], {}, 3.5):
            self.assertEqual(_day_kind_for(value), "weekday", value)

    def test_normalizes_modulo(self):
        self.assertEqual(_day_kind_for(7), "weekday")   # 又回到周一
        self.assertEqual(_day_kind_for(12), "weekend")  # 12 % 7 = 5
        self.assertEqual(_day_kind_for(-1), "weekend")  # -1 % 7 = 6

    def test_constants_are_consistent(self):
        self.assertEqual(SCHEDULE_DAY_KINDS, ("weekday", "weekend"))
        self.assertEqual(SCHEDULE_WEEKEND_WEEKDAYS, (5, 6))
        self.assertIn('SCHEDULE_DAY_KIND_LABELS = {"weekday": "工作日", "weekend": "周末"}', BACKEND)


class DefaultsTests(Base):
    def test_defaults_have_both_tables(self):
        schedule = self.plugin._schedule_defaults()
        self.assertEqual(schedule["schema"], 2)
        self.assertEqual(schedule["zones"], {zone: "" for zone in SCHEDULE_ZONES})
        self.assertEqual(schedule["weekend_zones"], {zone: "" for zone in SCHEDULE_ZONES})
        self.assertFalse(schedule["enabled"])

    def test_empty_weekend_table_falls_back_to_weekday(self):
        schedule = self.plugin._schedule_defaults()
        schedule["zones"]["day"] = "starry-meow"
        zone_map = self.plugin._schedule_zone_map(schedule, "weekend")
        self.assertEqual(zone_map, schedule["zones"])

    def test_weekend_table_used_when_it_has_any_value(self):
        schedule = self.plugin._schedule_defaults()
        schedule["zones"]["day"] = "starry-meow"
        schedule["weekend_zones"]["evening"] = "yui-ice"
        self.assertEqual(self.plugin._schedule_zone_map(schedule, "weekend")["evening"], "yui-ice")
        self.assertEqual(self.plugin._schedule_zone_map(schedule, "weekday")["day"], "starry-meow")

    def test_broken_tables_do_not_crash(self):
        schedule = {"zones": None, "weekend_zones": "nope"}
        self.assertEqual(self.plugin._schedule_zone_map(schedule, "weekend"), {})
        self.assertEqual(self.plugin._schedule_zone_map(schedule, "weekday"), {})


class NormalizeTests(Base):
    def test_accepts_weekend_table(self):
        raw = {"enabled": True, "zones": {}, "weekend_zones": {"night": "yui-ice"}}
        schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(errors, [])
        self.assertEqual(schedule["weekend_zones"]["night"], "yui-ice")
        self.assertEqual(schedule["zones"]["night"], "")

    def test_missing_weekend_table_is_fine(self):
        schedule, errors = self.plugin._normalize_schedule({"enabled": True}, strict=True)
        self.assertEqual(errors, [])
        self.assertEqual(schedule["weekend_zones"], {zone: "" for zone in SCHEDULE_ZONES})

    def test_unknown_weekend_zone_reported(self):
        raw = {"weekend_zones": {"noon": "starry-meow"}}
        _, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertTrue(any("周末" in message and "noon" in message for message in errors), errors)

    def test_weekend_rejects_missing_theme(self):
        raw = {"weekend_zones": {"day": "ghost-theme"}}
        _, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertTrue(any("周末" in message and "不存在" in message for message in errors), errors)

    def test_weekend_rejects_bad_id(self):
        raw = {"weekend_zones": {"day": "../etc/passwd"}}
        _, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertTrue(any("不合法" in message for message in errors), errors)

    def test_tables_are_independent(self):
        raw = {"zones": {"day": "starry-meow"}, "weekend_zones": {"day": "ghost-theme"}}
        schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(schedule["zones"]["day"], "starry-meow")
        self.assertEqual(schedule["weekend_zones"]["day"], "")
        self.assertEqual(len(errors), 1, errors)

    def test_last_day_kind_roundtrip(self):
        schedule, errors = self.plugin._normalize_schedule(
            {"last_day_kind": "weekend", "last_zone": "night", "last_theme": "yui-ice"},
            strict=True,
        )
        self.assertEqual(errors, [])
        self.assertEqual(schedule["last_day_kind"], "weekend")
        self.assertEqual(schedule["last_zone"], "night")
        self.assertEqual(schedule["last_theme"], "yui-ice")

    def test_bad_last_day_kind_dropped_silently(self):
        schedule, errors = self.plugin._normalize_schedule({"last_day_kind": "holiday"}, strict=False)
        self.assertEqual(errors, [])
        self.assertNotIn("last_day_kind", schedule)

    def test_weekend_non_object_rejected(self):
        _, errors = self.plugin._normalize_schedule({"weekend_zones": []}, strict=True)
        self.assertTrue(any("weekend_zones 必须是一个对象" in message for message in errors), errors)


class TickTests(Base):
    def setUp(self):
        super().setUp()
        self.applied = []
        self.plugin._apply_theme_record = self._fake_apply
        self._orig_day_kind = NS["_day_kind_for"]

    def tearDown(self):
        NS["_day_kind_for"] = self._orig_day_kind
        super().tearDown()

    def _fake_apply(self, theme_id):
        self.applied.append(theme_id)
        return {"theme": {"id": theme_id, "name": theme_id}}

    def _force_day_kind(self, kind: str) -> None:
        NS["_day_kind_for"] = lambda _weekday: kind

    def test_weekend_table_applies_on_weekend(self):
        self._force_day_kind("weekend")
        self.save_raw(
            {
                "enabled": True,
                "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
                "weekend_zones": {zone: "yui-ice" for zone in SCHEDULE_ZONES},
            }
        )
        outcome = self.plugin._schedule_tick()
        self.assertEqual(outcome["action"], "applied")
        self.assertEqual(outcome["day_kind"], "weekend")
        self.assertEqual(self.applied, ["yui-ice"])

    def test_weekday_table_applies_on_weekday(self):
        self._force_day_kind("weekday")
        self.save_raw(
            {
                "enabled": True,
                "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
                "weekend_zones": {zone: "yui-ice" for zone in SCHEDULE_ZONES},
            }
        )
        outcome = self.plugin._schedule_tick()
        self.assertEqual(outcome["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow"])

    def test_crossing_into_weekend_switches_again(self):
        payload = {
            "enabled": True,
            "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
            "weekend_zones": {zone: "yui-ice" for zone in SCHEDULE_ZONES},
        }
        self.save_raw(payload)
        self._force_day_kind("weekday")
        self.assertEqual(self.plugin._schedule_tick()["action"], "applied")
        # 同一时段名（zone 相同）但天型变了：必须再切一次，不能被 last_zone 抑制。
        self._force_day_kind("weekend")
        outcome = self.plugin._schedule_tick()
        self.assertEqual(outcome["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow", "yui-ice"])

    def test_no_repeat_within_same_day_kind(self):
        self._force_day_kind("weekend")
        self.save_raw(
            {
                "enabled": True,
                "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
                "weekend_zones": {zone: "yui-ice" for zone in SCHEDULE_ZONES},
            }
        )
        self.plugin._schedule_tick()
        self.assertEqual(self.plugin._schedule_tick()["action"], "unchanged")
        self.assertEqual(self.applied, ["yui-ice"])

    def test_saved_marker_includes_day_kind(self):
        self._force_day_kind("weekend")
        self.save_raw(
            {
                "enabled": True,
                "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
                "weekend_zones": {zone: "yui-ice" for zone in SCHEDULE_ZONES},
            }
        )
        self.plugin._schedule_tick()
        saved = json.loads((self.tmp / "static" / "schedule.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["last_day_kind"], "weekend")
        self.assertEqual(saved["last_theme"], "yui-ice")

    def test_weekend_unset_falls_through_to_weekday(self):
        """周末表只在有值时接管；没配的时段整张表都不接管（不是逐时段合并）。"""
        self._force_day_kind("weekend")
        self.save_raw(
            {
                "enabled": True,
                "zones": {zone: "starry-meow" for zone in SCHEDULE_ZONES},
                "weekend_zones": {zone: "" for zone in SCHEDULE_ZONES},
            }
        )
        outcome = self.plugin._schedule_tick()
        self.assertEqual(outcome["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow"])


class SaveEntryTests(Base):
    def test_save_without_weekend_keeps_previous(self):
        self.save_raw(
            {
                "enabled": False,
                "zones": {zone: "" for zone in SCHEDULE_ZONES},
                "weekend_zones": {"night": "yui-ice"},
            }
        )
        import asyncio

        result = asyncio.run(
            self.plugin.save_schedule(enabled=False, zones={zone: "starry-meow" for zone in SCHEDULE_ZONES})
        )
        saved = unwrap(result)["schedule"]
        self.assertEqual(saved["weekend_zones"]["night"], "yui-ice", "旧面板不带该字段时不该清空周末表")
        self.assertEqual(saved["zones"]["day"], "starry-meow")

    def test_save_explicit_empty_clears_weekend(self):
        self.save_raw(
            {
                "enabled": False,
                "zones": {zone: "" for zone in SCHEDULE_ZONES},
                "weekend_zones": {"night": "yui-ice"},
            }
        )
        import asyncio

        result = asyncio.run(
            self.plugin.save_schedule(
                enabled=False,
                zones={zone: "" for zone in SCHEDULE_ZONES},
                weekend_zones={},
            )
        )
        saved = unwrap(result)["schedule"]
        self.assertEqual(saved["weekend_zones"], {zone: "" for zone in SCHEDULE_ZONES})

    def test_save_rejects_bad_weekend_id(self):
        import asyncio

        result = asyncio.run(
            self.plugin.save_schedule(
                enabled=True,
                zones={},
                weekend_zones={"day": "ghost-theme"},
            )
        )
        self.assertIsInstance(result.value, SdkError)
        self.assertIn("周末", str(result.value))


class WiringTests(unittest.TestCase):
    def test_get_schedule_exposes_day_kind(self):
        self.assertIn('"day_kinds": list(SCHEDULE_DAY_KINDS)', BACKEND)
        self.assertIn('"day_kind": day_kind,', BACKEND)
        self.assertIn('"weekend": day_kind == "weekend",', BACKEND)

    def test_save_schema_declares_weekend_zones(self):
        self.assertIn('"weekend_zones": {"type": "object"},', BACKEND)

    def test_tick_uses_zone_map_helper(self):
        self.assertIn("self._schedule_zone_map(schedule, day_kind).get(zone)", BACKEND)
        self.assertIn('schedule.get("last_day_kind", "weekday") == day_kind', BACKEND)

    def test_panel_has_weekend_toggle(self):
        self.assertIn('id="schedule-weekend"', INDEX_HTML)
        self.assertIn('id="schedule-rows-weekend"', INDEX_HTML)
        self.assertIn("周末（周六 / 周日）用另一套", INDEX_HTML)
        self.assertIn(".schedule-weekend-toggle", STYLE_CSS)

    def test_panel_sends_weekend_zones(self):
        self.assertIn("weekend_zones: weekend", APP_JS)
        self.assertIn("function scheduleWeekendHasValues(", APP_JS)
        self.assertIn("function collectScheduleZones(", APP_JS)
        self.assertIn("function renderScheduleGrid(", APP_JS)
        self.assertIn("scheduleState.weekendEnabled = !!this.checked;", APP_JS)

    def test_panel_shows_day_kind_in_summary(self):
        self.assertIn("var dayLabel = detail.day_kind === 'weekend' ? '周末' : '工作日';", APP_JS)
        self.assertIn("（周末表）", APP_JS)

    def test_panel_never_hardcodes_weekday_numbers(self):
        """星期几只在后端一份；前端只认 day_kind 字符串。"""
        import re

        segment = APP_JS[APP_JS.index("function scheduleMapOf("): APP_JS.index("async function refreshSchedule(")]
        self.assertIsNone(re.search(r"weekday\(\)|\bgetDay\(\)", segment), "前端不该自己算星期几")


if __name__ == "__main__":
    unittest.main()
