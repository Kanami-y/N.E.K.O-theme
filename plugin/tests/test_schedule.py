"""「按时段自动换主题」（v0.4.13）的离线测试。

三块容易回退的东西：

1. **时段边界只有一份**：``_zone_for_hour`` 必须严格由 ``SCHEDULE_ZONE_HOURS``
   推出，night 要跨零点。曾经把边界抄在三个地方（后端/加载器/面板文案），
   结果「22 点算夜晚还是夜里」各说各话。
2. **坏数据不能打崩 entry**：schedule.json 可能被手改坏、指向已删除的主题、
   或整份不是 JSON。读取路径必须降级成「未启用」，保存路径必须整体拒绝并
   给出可读错误 —— 半保存（enabled 存了、zones 丢了）比失败更糟。
3. **不重复写盘**：后台每 30s 检查一次，但只有「时段变了」才写 theme.json。
   每次写都会让加载器重绘一次，用户正在看窗口时是可见的闪动。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
_zone_for_hour = NS["_zone_for_hour"]
_schedule_windows = NS["_schedule_windows"]
SCHEDULE_ZONES = NS["SCHEDULE_ZONES"]
SCHEDULE_ZONE_HOURS = NS["SCHEDULE_ZONE_HOURS"]
SCHEDULE_TICK_SECONDS = NS["SCHEDULE_TICK_SECONDS"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8")
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "plugin" / "static" / "index.html").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "plugin" / "static" / "style.css").read_text(encoding="utf-8")
INSTALL_PS1 = (ROOT / "install.ps1").read_text(encoding="utf-8-sig")


# 固定时钟：2026-01-05 是周一 10:00（weekday / morning 时段）。
# 用真实时间会让用例在午夜跨日、周五变周六时随机变红 —— 那是测试不稳，不是功能坏。
FIXED_NOW = datetime(2026, 1, 5, 10, 0, 0)


def make_plugin(tmp: Path):
    """不走 __init__（它要宿主 ctx 与文件日志）：直接造一个只看 static_dir 的实例。"""
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
    plugin._now = lambda: FIXED_NOW
    return plugin


def write_preset(tmp: Path, theme_id: str, name: str) -> None:
    payload = {
        "schema": 1,
        "name": name,
        "vars": {"--nts-accent": "#7fb8ff"},
        "dark_vars": {"--nts-accent": "#9fd0ff"},
        "builtin": True,
    }
    path = tmp / "static" / "presets" / f"{theme_id}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


class ZoneTests(unittest.TestCase):
    """``_zone_for_hour`` 的边界与跨零点。"""

    def test_every_zone_boundary_is_left_closed(self):
        for zone in SCHEDULE_ZONES:
            start, _end = SCHEDULE_ZONE_HOURS[zone]
            self.assertEqual(_zone_for_hour(start), zone, f"{zone} 的起点 {start} 点应属于自己")

    def test_every_zone_boundary_is_right_open(self):
        for zone in SCHEDULE_ZONES:
            _start, end = SCHEDULE_ZONE_HOURS[zone]
            if end <= _start:  # night 的 end=6 是「另一个半区的起点」，另行断言
                continue
            self.assertNotEqual(_zone_for_hour(end), zone, f"{zone} 的终点 {end} 点不该还属于它")

    def test_night_crosses_midnight(self):
        for hour in (22, 23, 0, 1, 2, 3, 4, 5):
            self.assertEqual(_zone_for_hour(hour), "night", f"{hour} 点应在 night")

    def test_full_day_is_covered_exactly_once(self):
        covered = [_zone_for_hour(hour) for hour in range(24)]
        self.assertEqual(len(covered), 24)
        for zone in SCHEDULE_ZONES:
            self.assertGreater(covered.count(zone), 0, f"{zone} 一分钟都没覆盖到")
        # 每个小时都必须落到某个已知时段（不能靠兜底返回值蒙混）
        self.assertTrue(set(covered).issubset(set(SCHEDULE_ZONES)))

    def test_bad_input_falls_back_to_night(self):
        # 手工改坏的 schedule.json 里可能出现字符串/null；绝不能因此抛异常。
        for bad in (None, "abc", [], {}, 3.7):
            self.assertIn(_zone_for_hour(bad), SCHEDULE_ZONES)

    def test_hour_is_normalized_modulo_24(self):
        self.assertEqual(_zone_for_hour(24), _zone_for_hour(0))
        self.assertEqual(_zone_for_hour(30), _zone_for_hour(6))
        self.assertEqual(_zone_for_hour(-1), _zone_for_hour(23))

    def test_windows_match_hour_table(self):
        windows = _schedule_windows()
        self.assertEqual([w["zone"] for w in windows], list(SCHEDULE_ZONES))
        for window in windows:
            start, end = SCHEDULE_ZONE_HOURS[window["zone"]]
            self.assertEqual(window["start"], start)
            self.assertEqual(window["end"], end)

    def test_tick_interval_is_reasonable(self):
        # 加载器 1.5s 轮询；时段粒度是小时。间隔太长会让「到点」明显延迟，
        # 太短就是白转线程。
        self.assertGreaterEqual(SCHEDULE_TICK_SECONDS, 5)
        self.assertLessEqual(SCHEDULE_TICK_SECONDS, 120)


class NormalizeTests(unittest.TestCase):
    """``_normalize_schedule``：strict 整体拒绝，非 strict 丢坏项。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        write_preset(self.tmp, "starry-meow", "星辰喵")
        write_preset(self.tmp, "yui-ice", "唯冰")

    def tearDown(self):
        self._tmp.cleanup()

    def test_defaults_when_empty(self):
        schedule, errors = self.plugin._normalize_schedule(None, strict=True)
        self.assertEqual(errors, [])
        self.assertFalse(schedule["enabled"])
        self.assertEqual(schedule["zones"], {zone: "" for zone in SCHEDULE_ZONES})
        # v0.4.19 起默认 schema 2：多一张 weekend_zones（周末另一套），空表 = 沿用工作日。
        self.assertEqual(schedule["schema"], 2)
        self.assertEqual(schedule["weekend_zones"], {zone: "" for zone in SCHEDULE_ZONES})

    def test_accepts_known_theme(self):
        raw = {"enabled": True, "zones": {"morning": "starry-meow"}}
        schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(errors, [])
        self.assertTrue(schedule["enabled"])
        self.assertEqual(schedule["zones"]["morning"], "starry-meow")
        self.assertEqual(schedule["zones"]["day"], "")

    def test_rejects_unknown_theme(self):
        raw = {"enabled": True, "zones": {"day": "no-such-theme"}}
        _schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(len(errors), 1)
        self.assertIn("不存在", errors[0])

    def test_rejects_illegal_id_shape(self):
        for bad in ("../etc/passwd", "UPPER", "with_underscore", "-leading", "a" * 65):
            raw = {"zones": {"day": bad}}
            _schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
            self.assertTrue(errors, f"{bad!r} 应被拒绝")
            self.assertTrue(any("不合法" in e or "不存在" in e for e in errors), bad)

    def test_rejects_unknown_zone(self):
        raw = {"zones": {"morning": "starry-meow", "noon": "starry-meow"}}
        _schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(len(errors), 1)
        self.assertIn("未知时段", errors[0])
        self.assertIn("noon", errors[0])

    def test_rejects_non_bool_enabled(self):
        _schedule, errors = self.plugin._normalize_schedule({"enabled": "maybe"}, strict=True)
        self.assertEqual(len(errors), 1)
        self.assertIn("enabled", errors[0])

    def test_coerces_string_bool_like_palette(self):
        # 与 theme.json 的 enabled 用同一套解析：手写 "true"/1 都该认。
        for value, expected in (("true", True), ("false", False), (1, True), (0, False)):
            schedule, errors = self.plugin._normalize_schedule({"enabled": value}, strict=False)
            self.assertEqual(errors, [])
            self.assertEqual(schedule["enabled"], expected, f"{value!r} → {expected}")

    def test_non_strict_drops_bad_items(self):
        # 读取路径不拒绝整份，坏项被丢弃；错误照样收集（调用方拿去记 warning），
        # 这样「手改坏的 schedule.json」既不会让 entry 崩，也不会静默。
        raw = {
            "enabled": True,
            "zones": {
                "morning": "starry-meow",
                "day": "missing-theme",
                "evening": "../x",
                "noon": "starry-meow",
            },
        }
        schedule, errors = self.plugin._normalize_schedule(raw, strict=False)
        self.assertTrue(schedule["enabled"], "坏项不该连累 enabled")
        self.assertEqual(schedule["zones"]["morning"], "starry-meow")
        self.assertEqual(schedule["zones"]["day"], "")
        self.assertEqual(schedule["zones"]["evening"], "")
        self.assertEqual(len(errors), 3, errors)  # day / evening / 未知时段 noon
        self.assertTrue(any("day" in e for e in errors))
        self.assertTrue(any("noon" in e for e in errors))
        self.assertNotIn("noon", schedule["zones"])

    def test_non_dict_raw_is_rejected_in_strict(self):
        for bad in ([], "x", 3):
            _schedule, errors = self.plugin._normalize_schedule(bad, strict=True)
            self.assertEqual(len(errors), 1)
            self.assertIn("JSON 对象", errors[0])

    def test_zones_not_a_dict(self):
        _schedule, errors = self.plugin._normalize_schedule({"zones": "nope"}, strict=True)
        self.assertEqual(len(errors), 1)
        self.assertIn("zones", errors[0])

    def test_whitespace_around_id_is_trimmed(self):
        schedule, errors = self.plugin._normalize_schedule(
            {"zones": {"night": "  starry-meow  "}}, strict=True
        )
        self.assertEqual(errors, [])
        self.assertEqual(schedule["zones"]["night"], "starry-meow")

    def test_runtime_markers_round_trip(self):
        raw = {"enabled": True, "zones": {}, "last_zone": "night", "last_theme": "yui-ice"}
        schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(errors, [])
        self.assertEqual(schedule["last_zone"], "night")
        self.assertEqual(schedule["last_theme"], "yui-ice")

    def test_bad_runtime_markers_are_dropped_silently(self):
        # 标记只是运行时记录，坏掉不该让保存失败（否则用户永远存不上）。
        raw = {"enabled": True, "zones": {}, "last_zone": "noon", "last_theme": "../../x"}
        schedule, errors = self.plugin._normalize_schedule(raw, strict=True)
        self.assertEqual(errors, [])
        self.assertNotIn("last_zone", schedule)
        self.assertNotIn("last_theme", schedule)


class ReadScheduleTests(unittest.TestCase):
    """``_read_schedule``：任何坏情况都降级成「未启用」，绝不抛。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        write_preset(self.tmp, "starry-meow", "星辰喵")
        self.path = self.plugin._schedule_path()

    def tearDown(self):
        self._tmp.cleanup()

    def test_missing_file_means_disabled(self):
        schedule = self.plugin._read_schedule()
        self.assertFalse(schedule["enabled"])
        self.assertEqual(schedule["zones"], {zone: "" for zone in SCHEDULE_ZONES})

    def test_broken_json_means_disabled(self):
        self.path.write_text("{not json", encoding="utf-8")
        schedule = self.plugin._read_schedule()
        self.assertFalse(schedule["enabled"])

    def test_wrong_shape_means_disabled(self):
        self.path.write_text('["a", "b"]', encoding="utf-8")
        self.assertFalse(self.plugin._read_schedule()["enabled"])

    def test_deleted_theme_is_dropped_on_read(self):
        self.path.write_text(
            json.dumps(
                {"schema": 1, "enabled": True, "zones": {"day": "ghost-theme"}},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        schedule = self.plugin._read_schedule()
        self.assertTrue(schedule["enabled"])
        self.assertEqual(schedule["zones"]["day"], "", "已删除的主题不该继续留在排程里")

    def test_round_trip_via_save(self):
        schedule, errors = self.plugin._normalize_schedule(
            {"enabled": True, "zones": {"evening": "starry-meow"}}, strict=True
        )
        self.assertEqual(errors, [])
        self.plugin._save_schedule_unlocked(schedule)
        self.assertTrue(self.path.is_file())
        again = self.plugin._read_schedule()
        self.assertTrue(again["enabled"])
        self.assertEqual(again["zones"]["evening"], "starry-meow")

    def test_save_is_atomic_and_leaves_no_tmp(self):
        schedule, _ = self.plugin._normalize_schedule({"enabled": True, "zones": {}}, strict=True)
        self.plugin._save_schedule_unlocked(schedule)
        leftovers = [p.name for p in self.plugin.static_dir.iterdir() if ".tmp" in p.name]
        self.assertEqual(leftovers, [])


class TickTests(unittest.TestCase):
    """``_schedule_tick``：什么时候换、什么时候什么都不做。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        write_preset(self.tmp, "starry-meow", "星辰喵")
        write_preset(self.tmp, "yui-ice", "唯冰")
        self.applied = []
        plugin = self.plugin

        def fake_apply(theme_id):
            plugin._theme_exists(theme_id) or self.fail(f"应用到不存在的主题 {theme_id}")
            self.applied.append(theme_id)
            return {"theme": {"id": theme_id, "name": theme_id}, "light": 1, "dark": 1, "rejected": []}

        self.plugin._apply_theme_record = fake_apply

    def tearDown(self):
        self._tmp.cleanup()

    def _save(self, payload: dict) -> None:
        self.plugin._schedule_path().write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def _current_zone(self) -> str:
        return _zone_for_hour(FIXED_NOW.hour)

    def test_disabled_does_nothing(self):
        self._save({"schema": 1, "enabled": False, "zones": {self._current_zone(): "starry-meow"}})
        self.assertEqual(self.plugin._schedule_tick()["action"], "disabled")
        self.assertEqual(self.applied, [])

    def test_unset_zone_does_nothing(self):
        self._save({"schema": 1, "enabled": True, "zones": {}})
        state = self.plugin._schedule_tick()
        self.assertEqual(state["action"], "unset")
        self.assertEqual(self.applied, [])

    def test_applies_configured_theme_for_current_zone(self):
        zone = self._current_zone()
        self._save({"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}})
        state = self.plugin._schedule_tick()
        self.assertEqual(state["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow"])
        self.assertEqual(state["zone"], zone)

    def test_second_tick_is_unchanged(self):
        # 关键：30s 一次检查不能每次都重写 theme.json（会让加载器重绘）。
        zone = self._current_zone()
        self._save({"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}})
        self.assertEqual(self.plugin._schedule_tick()["action"], "applied")
        self.assertEqual(self.plugin._schedule_tick()["action"], "unchanged")
        self.assertEqual(self.applied, ["starry-meow"], "同一时段不该重复应用")

    def test_marker_is_persisted(self):
        zone = self._current_zone()
        self._save({"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}})
        self.plugin._schedule_tick()
        saved = json.loads(self.plugin._schedule_path().read_text(encoding="utf-8"))
        self.assertEqual(saved["last_zone"], zone)
        self.assertEqual(saved["last_theme"], "starry-meow")

    def test_force_reapplies_same_zone(self):
        # 用户在面板点「保存」时要立刻生效，不能被 last_zone 抑制。
        zone = self._current_zone()
        self._save(
            {"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}, "last_zone": zone,
             "last_theme": "starry-meow"}
        )
        self.assertEqual(self.plugin._schedule_tick()["action"], "unchanged")
        self.assertEqual(self.plugin._schedule_tick(force=True)["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow"])

    def test_theme_switch_is_applied(self):
        zone = self._current_zone()
        self._save(
            {"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}, "last_zone": zone,
             "last_theme": "yui-ice"}
        )
        self.assertEqual(self.plugin._schedule_tick()["action"], "applied")
        self.assertEqual(self.applied, ["starry-meow"])

    def test_missing_theme_is_reported_not_applied(self):
        zone = self._current_zone()
        # 直接写文件绕过 _normalize（模拟「选了主题之后又把它删了」）。
        self._save({"schema": 1, "enabled": True, "zones": {zone: "ghost-theme"}})
        state = self.plugin._schedule_tick()
        # ghost-theme 在读取阶段就被丢弃 → 当前时段没主题
        self.assertEqual(state["action"], "unset")
        self.assertEqual(self.applied, [])

    def test_apply_failure_does_not_raise_or_mark(self):
        def boom(theme_id):
            raise SdkError("模拟切换失败")

        self.plugin._apply_theme_record = boom
        zone = self._current_zone()
        self._save({"schema": 1, "enabled": True, "zones": {zone: "starry-meow"}})
        state = self.plugin._schedule_tick()
        self.assertEqual(state["action"], "error")
        self.assertIn("模拟切换失败", state["error"])
        saved = json.loads(self.plugin._schedule_path().read_text(encoding="utf-8"))
        self.assertNotIn("last_zone", saved, "失败时不该记标记，否则以后永远不再重试")

    def test_broken_schedule_file_does_not_raise(self):
        self.plugin._schedule_path().write_text("@@@", encoding="utf-8")
        self.assertEqual(self.plugin._schedule_tick()["action"], "disabled")


class WiringTests(unittest.TestCase):
    """源码级接线：这类「三处各写一份」的东西最容易在重构里被悄悄改掉。"""

    def test_entries_registered(self):
        self.assertIn('id="get_schedule"', BACKEND)
        self.assertIn('id="save_schedule"', BACKEND)
        self.assertIn("async def get_schedule", BACKEND)
        self.assertIn("async def save_schedule", BACKEND)

    def test_studio_context_lists_actions(self):
        context_block = BACKEND.split("async def studio_context", 1)[1].split("# ---", 1)[0]
        self.assertIn("get_schedule", context_block)
        self.assertIn("save_schedule", context_block)

    def test_startup_starts_worker(self):
        startup_block = BACKEND.split('@lifecycle(id="startup")', 1)[1].split("@lifecycle", 1)[0]
        self.assertIn("self._start_schedule_worker()", startup_block)

    def test_shutdown_stops_worker(self):
        shutdown_block = BACKEND.split('@lifecycle(id="shutdown")', 1)[1].split("@ui.context", 1)[0]
        self.assertIn("self._schedule_stop = True", shutdown_block)

    def test_worker_is_daemon_and_named(self):
        self.assertIn('name="nts-schedule"', BACKEND)
        self.assertIn("daemon=True", BACKEND)

    def test_worker_start_is_idempotent(self):
        block = BACKEND.split("def _start_schedule_worker", 1)[1].split("def ", 1)[0]
        self.assertIn("if self._schedule_started", block)
        self.assertIn("self._schedule_started = True", block)

    def test_apply_saved_theme_and_tick_share_one_path(self):
        # 两条路都必须走 _apply_theme_record，否则「面板切过去背景 404、自动切换正常」
        # 这种只在一半情况下复现的 bug 会再次出现。
        for fn in ("async def apply_saved_theme", "def _schedule_tick"):
            block = BACKEND.split(fn, 1)[1].split("\n    def ", 1)[0]
            self.assertIn("_apply_theme_record", block, f"{fn} 没有走共用路径")

    def test_panel_has_card(self):
        self.assertIn('class="card schedule-card"', INDEX_HTML)
        self.assertIn('id="schedule-enabled"', INDEX_HTML)
        self.assertIn('id="btn-schedule-save"', INDEX_HTML)
        self.assertIn('id="schedule-rows"', INDEX_HTML)
        self.assertIn('id="schedule-now"', INDEX_HTML)

    def test_panel_calls_both_entries(self):
        self.assertIn("callPlugin('get_schedule'", APP_JS)
        self.assertIn("callPlugin('save_schedule'", APP_JS)

    def test_panel_wires_save_button(self):
        self.assertIn("$('btn-schedule-save').addEventListener('click', saveSchedule)", APP_JS)

    def test_panel_loads_schedule_at_bootstrap(self):
        boot = APP_JS.split("function bootstrap()", 1)[1].split("if (document.readyState", 1)[0]
        self.assertIn("refreshSchedule()", boot)
        # 下拉框要有内容可选，必须先有仓库列表
        self.assertIn("refreshLibrary()", boot)

    def test_panel_does_not_hardcode_hour_boundaries(self):
        # 边界由 get_schedule 的 windows 下发；前端写死数字就会出现第三份实现。
        block = APP_JS.split("var SCHEDULE_ZONE_LABELS", 1)[1].split("function revertMode", 1)[0]
        for forbidden in ("hour >= 6", "hour < 10", "hour >= 10", "hour < 18", "hour >= 22"):
            self.assertNotIn(forbidden, block, f"前端不应自己算时段边界：{forbidden}")

    def test_panel_refills_after_schedule_apply(self):
        # 自动切换后如果不回读，用户一按「应用」就把自动切换结果覆盖回去。
        block = APP_JS.split("async function saveSchedule", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("reloadPalette({ silent: true })", block)

    def test_style_has_card_rules(self):
        for selector in (".schedule-card", ".schedule-row", ".schedule-when", ".schedule-select", ".schedule-now"):
            self.assertIn(selector, STYLE_CSS, f"style.css 缺少 {selector}")

    def test_panel_escaping_no_innerHTML_with_names(self):
        block = APP_JS.split("var SCHEDULE_ZONE_LABELS", 1)[1].split("function revertMode", 1)[0]
        # 主题名来自仓库 JSON，绝不能拼进 innerHTML。
        self.assertNotIn("innerHTML = '<", block)

    def test_install_backs_up_schedule(self):
        # 重装会删旧插件目录；schedule.json 与 theme.json 同级，必须一起备份/恢复。
        backup_block = INSTALL_PS1.split("function Backup-NtsUserData", 1)[1].split("function Restore-NtsUserData", 1)[0]
        restore_block = INSTALL_PS1.split("function Restore-NtsUserData", 1)[1].split("function ", 1)[0]
        self.assertIn("schedule.json", backup_block)
        self.assertIn("ScheduleBytes", backup_block)
        self.assertIn("schedule.json", restore_block)


if __name__ == "__main__":
    unittest.main()
