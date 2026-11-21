"""v0.4.22：排程里引用了「已不在仓库」的主题时，别每 30 秒刷日志、也别让它悄悄变空。

三个真问题一起测：
1. ``_read_schedule`` 每读一次就 ``_log("warning", …)``，后台线程 30 秒读一次 →
   一天 2880 条，真出问题时反而把有用的日志淹掉；现在同一组错误只记一次。
2. 失效时段被静默丢掉，用户只看到「这个时段还没选主题」；现在 ``get_schedule``
   用 ``stale`` 报出来，面板能解释「引用的主题已不在仓库里」。
3. 主题重新导入之后要能自动恢复（不能因为「上次已切过」的标记而永远短路）。
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import ROOT as REPO_ROOT, load_backend  # noqa: E402
from test_schedule import FIXED_NOW, make_plugin, write_preset  # noqa: E402

NS = load_backend()
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
_zone_for_hour = NS["_zone_for_hour"]

ROOT = REPO_ROOT
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
INIT_PY = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8")


class FakeLog:
    """``_log`` 只要求 ``logger.warning(msg)`` / ``logger.info(msg)`` 可调用。"""

    def __init__(self):
        self.warnings = []
        self.infos = []

    def warning(self, message):
        self.warnings.append(str(message))

    def info(self, message):
        self.infos.append(str(message))

    def error(self, message):  # pragma: no cover - 兼容其它日志级别
        self.warnings.append(str(message))


def unwrap(result):
    """entry 返回 Ok/Err 包装对象；测试里只关心 value。"""
    return result.value


class BaseCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        write_preset(self.tmp, "starry-meow", "星辰喵")
        self.log = FakeLog()
        self.plugin.logger = self.log
        self.applied = []
        plugin = self.plugin

        def fake_apply(theme_id):
            plugin._theme_exists(theme_id) or self.fail(f"应用到不存在的主题 {theme_id}")
            self.applied.append(theme_id)
            return {"theme": {"id": theme_id, "name": theme_id}, "light": 1, "dark": 1, "rejected": []}

        self.plugin._apply_theme_record = fake_apply

    def tearDown(self):
        self._tmp.cleanup()

    def _write_schedule(self, payload: dict) -> None:
        self.plugin._schedule_path().write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def _zone(self) -> str:
        return _zone_for_hour(FIXED_NOW.hour)

    def _schedule(self):
        return unwrap(asyncio.run(self.plugin.get_schedule()))

    def _ghost_warnings(self):
        return [m for m in self.log.warnings if "引用了不存在的主题" in m]


class StaleReportingTests(BaseCase):
    def test_deleted_theme_is_reported_as_stale_not_silently_empty(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "ghost-theme"}})
        state = self.plugin._schedule_tick()
        self.assertEqual(state["action"], "unset", "失效时段在读取阶段就被丢掉了")
        payload = self._schedule()
        self.assertEqual(len(payload["stale"]), 1)
        item = payload["stale"][0]
        self.assertEqual(item["zone"], zone)
        self.assertEqual(item["theme_id"], "ghost-theme")
        self.assertEqual(item["day_kind"], "weekday")
        self.assertEqual(payload["schedule"]["zones"].get(zone, ""), "", "失效值不该被当成有效配置返回")

    def test_weekend_stale_theme_is_tagged_weekend(self):
        self._write_schedule(
            {"schema": 2, "enabled": True, "zones": {}, "weekend_zones": {"night": "ghost-weekend"}}
        )
        payload = self._schedule()
        kinds = {(item["day_kind"], item["zone"], item["theme_id"]) for item in payload["stale"]}
        self.assertIn(("weekend", "night", "ghost-weekend"), kinds)

    def test_no_stale_when_everything_exists(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "starry-meow"}})
        self.plugin._schedule_tick()
        self.assertEqual(self._schedule()["stale"], [])


class WarnOnceTests(BaseCase):
    def test_same_stale_theme_warns_only_once(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "ghost-theme"}})
        for _ in range(6):
            self.plugin._schedule_tick()
        self.assertEqual(len(self._ghost_warnings()), 1, self.log.warnings)

    def test_warning_comes_back_after_config_changes_again(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "ghost-theme"}})
        self.plugin._read_schedule()
        self.assertEqual(len(self._ghost_warnings()), 1)
        # 用户把这个时段改回有效主题 → 不再有错误，签名归零
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "starry-meow"}})
        self.plugin._read_schedule()
        self.assertEqual(len(self._ghost_warnings()), 1)
        # 又删掉 / 又写坏一次：应该重新看到一条
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "ghost-theme"}})
        self.plugin._read_schedule()
        self.assertEqual(len(self._ghost_warnings()), 2)

    def test_healthy_schedule_logs_nothing(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "starry-meow"}})
        for _ in range(3):
            self.plugin._schedule_tick()
        self.assertEqual(self._ghost_warnings(), [])


class SelfHealTests(BaseCase):
    def test_theme_comes_back_and_is_applied(self):
        zone = self._zone()
        self._write_schedule({"schema": 2, "enabled": True, "zones": {zone: "yui-ice"}})
        self.assertEqual(self.plugin._schedule_tick()["action"], "unset")
        self.assertEqual(self.applied, [])
        # 用户把主题重新导入 / 恢复备份回来了
        write_preset(self.tmp, "yui-ice", "唯冰")
        state = self.plugin._schedule_tick()
        self.assertEqual(state["action"], "applied", "主题回来后必须能自动恢复")
        self.assertEqual(self.applied, ["yui-ice"])
        self.assertEqual(self.plugin._schedule_tick()["action"], "unchanged")
        self.assertEqual(self.applied, ["yui-ice"], "恢复之后不该每 30 秒重切一次")


class WiringTests(unittest.TestCase):
    """跨端接线：这类「后端报、前端显示」的东西最容易只有一半。"""

    def test_normalize_accepts_dropped_sink(self):
        self.assertIn("dropped: list[dict[str, Any]] | None = None", INIT_PY)
        self.assertIn('dropped.append({"field": field, "zone": zone, "theme_id": value})', INIT_PY)

    def test_read_schedule_des_spanning(self):
        self.assertIn("self._schedule_stale = dropped", INIT_PY)
        self.assertIn('if signature != getattr(self, "_schedule_warn_sig", ""):', INIT_PY)

    def test_get_schedule_reports_stale(self):
        self.assertIn('"stale": stale,', INIT_PY)
        self.assertIn('"day_kind": "weekend" if item.get("field") == "weekend_zones" else "weekday"', INIT_PY)

    def test_panel_shows_stale_and_refreshes_schedule(self):
        self.assertIn("if (scheduleState.loaded) renderSchedule();\n    return items;", APP_JS)
        self.assertIn("scheduleState.stale = (result && result.stale instanceof Array) ? result.stale : [];", APP_JS)
        self.assertIn("else if (scheduleState.stale.length) {", APP_JS)
        self.assertIn("个时段引用的主题已不在仓库里", APP_JS)
        self.assertIn("if (scheduleState.loaded) await refreshSchedule();", APP_JS)

    def test_panel_warns_before_deleting_referenced_theme(self):
        self.assertIn("var refs = scheduleRefsFor(item.id);", APP_JS)
        self.assertIn("正被自动换主题使用", APP_JS)
        self.assertRegex(APP_JS, r"\[['\"]weekday['\"], schedule\.zones\], \['weekend', schedule\.weekend_zones\]\]")
        self.assertIn("known ? name : name + '（已不存在）'", APP_JS)

    def test_debug_hooks(self):
        self.assertIn("scheduleRefsFor: scheduleRefsFor,", APP_JS)
        self.assertIn("scheduleStaleText: scheduleStaleText,", APP_JS)

    def test_no_hardcoded_zone_hours_in_panel(self):
        # 时段边界只有后端一份；前端只能拿 scheduleWindowText 的 start/end。
        section = APP_JS[APP_JS.index("function scheduleRefsFor(themeId)"):]
        section = section[: section.index("/** 按 scheduleState 重渲染整张卡。 */")]
        self.assertNotRegex(section, re.compile(r"hour\s*[<>=]"))


class BackgroundLogTests(BaseCase):
    """同一张背景图反复「保存」不该刷日志（一次 list_themes 曾刷 4 行）。"""

    PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 48

    def _info_lines(self):
        return [m for m in self.log.infos if "背景图已保存" in m]

    def test_first_write_is_logged(self):
        name = self.plugin._save_background_bytes(self.PNG, label="测试")
        self.assertEqual(len(self._info_lines()), 1)
        self.assertTrue((self.plugin._backgrounds_dir() / name).is_file())

    def test_repeat_write_is_silent(self):
        self.plugin._save_background_bytes(self.PNG, label="测试")
        for _ in range(4):
            self.plugin._save_background_bytes(self.PNG, label="内置主题 starry-meow")
        self.assertEqual(len(self._info_lines()), 1, f"重复保存不该再记：{self._info_lines()}")

    def test_changed_bytes_are_logged_again(self):
        self.plugin._save_background_bytes(self.PNG, label="测试")
        other = b"\x89PNG\r\n\x1a\n" + b"\x01" * 48
        name = self.plugin._save_background_bytes(other, label="测试")
        self.assertEqual(len(self._info_lines()), 2, "新图（不同内容）当然要记")
        self.assertTrue((self.plugin._backgrounds_dir() / name).is_file())


class ApplyErrorDebounceTests(unittest.TestCase):
    """1.0.5：条目本身坏掉（如旧版本存的空配色）时 apply 一直失败，而排程线程
    每 30s 重试 → 原实现会刷出一天 2880 条一模一样的 warning。

    修后行为（与「主题被删」分支同口径，按 last_missing 指纹去抖）：
    1. 同一条失败只记第一次 warning；
    2. 条目被改好后下一轮 tick 自动恢复（不能因为去抖而永远不再尝试）；
    3. 恢复成功后回非 force tick 走 unchanged（last_* 正常推进）。
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.plugin = make_plugin(self.tmp)
        self.log = FakeLog()
        self.plugin.logger = self.log

    def tearDown(self):
        self._tmp.cleanup()

    def _break_entry(self, theme_id: str) -> dict:
        path = self.plugin.static_dir / "themes" / f"{theme_id}.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        good = dict(record)
        record["vars"] = {}
        record["dark_vars"] = {}
        path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        return good

    def test_warning_is_debounced_and_entry_can_recover(self):
        asyncio.run(self.plugin.apply_theme(name="好", vars={"--nts-accent": "#123456"}))
        saved = asyncio.run(self.plugin.save_theme(name="条目")).value["theme"]["id"]
        good = self._break_entry(saved)
        zone = _zone_for_hour(self.plugin._now().hour)
        asyncio.run(self.plugin.save_schedule(enabled=True, zones={zone: saved}))
        # save_schedule 保存时立即 tick 过一次 → 此刻应已有且只有 1 条 warning
        self.assertEqual(len(self.log.warnings), 1)
        for _ in range(3):
            out = self.plugin._schedule_tick(force=True)
            self.assertEqual(out.get("action"), "error")
        self.assertEqual(len(self.log.warnings), 1, f"去抖失败：{self.log.warnings}")
        self.assertIn("自动换主题失败", self.log.warnings[0])
        # 条目被改好 → 下一轮 tick 自动恢复，不需要用户碰排程
        path = self.plugin.static_dir / "themes" / f"{saved}.json"
        path.write_text(json.dumps(good, ensure_ascii=False), encoding="utf-8")
        out = self.plugin._schedule_tick(force=True)
        self.assertEqual(out.get("action"), "applied")
        self.assertEqual(out.get("theme_id"), saved)
        self.assertEqual(len(self.log.warnings), 1, "恢复不该再记 warning")
        self.assertIn("自动换主题", self.log.infos[-1])
        out2 = self.plugin._schedule_tick()
        self.assertEqual(out2.get("action"), "unchanged")


if __name__ == "__main__":
    unittest.main()
