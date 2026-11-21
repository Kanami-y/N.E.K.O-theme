"""Round 26（v0.4.26）修掉的逻辑缺陷的回归测试。

这一轮不是加功能，是把审计出来的「看起来一切正常、实际在悄悄出错」的地方钉住：

1. **排程 tick 的写回会冲掉用户刚保存的配置**
   tick 在锁外读整份 schedule.json，算完再把「开始时读到的那份」写回；期间用户
   刚点保存的新 enabled/zones 就被旧快照覆盖 —— 表现是「刚保存就失效 / 开关自己
   跳回」，日志里一条报错都没有。修法：``_update_schedule_stamp`` 在锁内重读，
   只合并 ``last_*`` 标记。

2. **背景图落盘的 tmp 名固定**
   排程线程 apply 与面板 list_themes/import_background 同时落同一张图时，共用
   ``<hash>.jpg.tmp``：先完成的一方 os.replace 成功后，另一方找不到自己的 tmp
   （报「保存图片失败」），失败还会残留 .tmp。

3. **install.ps1 的用户数据备份是空操作（P0，数据丢失）**
   ``Copy-Item -LiteralPath (Join-Path $src '*')`` 在 PS 5.1 下不展开通配符：既不
   报错也不复制任何文件，而日志照样打印「已备份 N 个文件」。修法：新增
   ``Copy-DirectoryContents``（逐项复制 + 返回数量），备份/恢复都校验数量。

4. **面板「重新读取」不清脏 / 主题名与启用开关不算脏**
   见 ``test/panel-selftest.js`` 的 §6.13（前端行为），这里只钉源码接线。

跑法：``python -m unittest discover -s plugin/tests -v``
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
_zone_for_hour = NS["_zone_for_hour"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8")
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
INSTALL_PS1 = (ROOT / "install.ps1").read_text(encoding="utf-8-sig")
LOADER_JS = (ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js").read_text(encoding="utf-8")

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 48


def make_plugin(tmp: Path):
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.plugin_id = "neko_theme_studio"
    plugin.static_dir = tmp / "static"
    plugin.static_dir.mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "presets").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "themes").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "backgrounds").mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    plugin._schedule_stop = False
    plugin._schedule_started = False
    plugin._schedule_last_result = {}
    # 固定时钟（周一 10:00）：真实时间会让「当前时段」在运行中跳变，用例随机红。
    plugin._now = lambda: datetime(2026, 1, 5, 10, 0, 0)
    return plugin


def write_preset(tmp: Path, theme_id: str, name: str) -> None:
    (tmp / "static" / "presets" / f"{theme_id}.json").write_text(
        json.dumps({"schema": 1, "name": name, "vars": {"--nts-chat-bg": "#101820"},
                    "dark_vars": {"--nts-chat-bg": "#05070c"}}),
        encoding="utf-8",
    )


def load_app_patch():
    path = ROOT / "plugin" / "_app_patch.py"
    spec = importlib.util.spec_from_file_location("nts_app_patch_r26", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ScheduleRaceTests(unittest.TestCase):
    """tick 的写回只能合并 last_*，不能把用户刚存的 zones 冲掉。"""

    def _install(self, plugin, zone: str) -> None:
        """让当前时段指向某套主题。"""
        plugin._save_schedule_unlocked({
            "schema": 2,
            "enabled": True,
            "zones": {zone: "morning-a"},
            "weekend_zones": {},
        })

    def test_tick_keeps_config_saved_meanwhile(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            plugin = make_plugin(tmp)
            write_preset(tmp, "morning-a", "晨间")
            write_preset(tmp, "night-b", "夜猫")
            zone = _zone_for_hour(10)  # make_plugin 固定了周一 10:00（morning 时段）
            self._install(plugin, zone)

            # 模拟「tick 正在 apply 时，用户点了保存」：直接把另一份配置写进磁盘。
            user_saved = {
                "schema": 2,
                "enabled": True,
                "zones": {"night": "night-b"},
                "weekend_zones": {},
            }

            def fake_apply(theme_id):
                plugin._save_schedule_unlocked(dict(user_saved))
                return {"theme": {"id": theme_id, "name": "晨间"}, "light": 1, "dark": 1}

            plugin._apply_theme_record = fake_apply
            result = plugin._schedule_tick(force=True)
            self.assertEqual(result.get("action"), "applied")

            on_disk = json.loads((tmp / "static" / "schedule.json").read_text(encoding="utf-8"))
            # 用户刚保存的配置必须还在 —— 旧实现会把 tick 开始时的快照写回来，
            # 这里就变回 {"morning": "morning-a"} 了（读盘时 _normalize_schedule
            # 会把四个时段键补齐成空串，所以按值比较）。
            self.assertEqual(on_disk["zones"].get("night"), "night-b")
            self.assertNotIn("morning-a", on_disk["zones"].values())
            self.assertTrue(on_disk.get("enabled"))
            # 运行期标记照常推进。
            self.assertEqual(on_disk.get("last_zone"), zone)
            self.assertEqual(on_disk.get("last_theme"), "morning-a")

    def test_stamp_merge_only_touches_given_keys(self):
        """_update_schedule_stamp 是「只合并标记」的唯一写回口。

        缺主题分支（missing）在正常路径其实不可达：_read_schedule 在读取阶段就把
        引用不存在主题的时段丢掉了（tick 于是走 unset）。所以这里直接测合并函数
        本身：它必须保留用户配置、只改传进来的键、value=None 表示删除。
        """
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            plugin = make_plugin(tmp)
            write_preset(tmp, "night-b", "夜猫")
            plugin._save_schedule_unlocked({
                "schema": 2,
                "enabled": True,
                "zones": {"night": "night-b"},
                "weekend_zones": {},
                "last_missing": "weekday|night|ghost",
            })
            plugin._update_schedule_stamp(last_zone="night", last_theme="night-b", last_missing=None)
            on_disk = json.loads((tmp / "static" / "schedule.json").read_text(encoding="utf-8"))
            self.assertEqual(on_disk["zones"].get("night"), "night-b")
            self.assertTrue(on_disk["enabled"])
            self.assertEqual(on_disk["last_zone"], "night")
            self.assertEqual(on_disk["last_theme"], "night-b")
            self.assertNotIn("last_missing", on_disk)

    def test_tick_does_not_write_whole_snapshot(self):
        start = BACKEND.index("    def _schedule_tick(")
        end = BACKEND.index("    def _run_schedule_worker(")
        body = BACKEND[start:end]
        self.assertIn("_update_schedule_stamp(", body)
        # 旧写法：把开始时读到的整个 schedule 写回 —— 会冲掉用户并发保存的配置。
        self.assertNotIn("self._save_schedule_unlocked(schedule)", body)
        self.assertIn("def _update_schedule_stamp", BACKEND)


class BackgroundTmpTests(unittest.TestCase):
    """同一张图并发落盘不能互相踩 tmp，失败也不能留垃圾。"""

    def test_concurrent_save_same_bytes(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            plugin = make_plugin(tmp)
            errors = []

            def worker():
                try:
                    plugin._save_background_bytes(PNG, label="test")
                except Exception as exc:  # noqa: BLE001
                    errors.append(exc)

            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(10)
            self.assertEqual(errors, [])
            files = list((tmp / "static" / "backgrounds").glob("*"))
            self.assertEqual(len([p for p in files if p.suffix == ".png"]), 1)
            self.assertEqual([p for p in files if p.suffix == ".tmp"], [])

    def test_failed_replace_leaves_no_tmp(self):
        with tempfile.TemporaryDirectory() as raw:
            tmp = Path(raw)
            plugin = make_plugin(tmp)
            real_replace = os.replace

            def boom(src, dst):
                raise PermissionError("locked")

            with mock.patch.object(NS["os"], "replace", side_effect=boom):
                with self.assertRaises(SdkError):
                    plugin._save_background_bytes(PNG, label="test")
            leftovers = list((tmp / "static" / "backgrounds").glob("*.tmp"))
            self.assertEqual(leftovers, [], "写入失败后不应残留 .tmp")
            self.assertIs(real_replace, os.replace)


class AppPatchRobustnessTests(unittest.TestCase):
    """单个模板被占用不能让整轮补丁中止。"""

    def test_template_read_permission_error_is_skipped(self):
        module = load_app_patch()
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            template = root / "chat.html"
            template.write_text("<link rel='stylesheet' href='/css/dark-mode.css'>", encoding="utf-8")
            original = template.read_bytes()
            result = {"warnings": [], "templates_skipped": [], "patched": [], "errors": []}
            logs = []
            with mock.patch.object(Path, "read_bytes", side_effect=PermissionError("locked by host")):
                module._patch_template(template, "<!-- NTS:BEGIN -->x<!-- NTS:END -->",
                                      lambda level, message: logs.append((level, message)),
                                      result, root)
            self.assertTrue(result["warnings"])
            self.assertIn("读取失败", result["warnings"][0])
            self.assertEqual(template.read_bytes(), original, "读不到就不该动这个文件")
            self.assertTrue(any(level == "warning" for level, _ in logs))


class AutostartOnceTests(unittest.TestCase):
    """auto_start 只替用户校正一次，之后尊重用户在宿主里的选择。"""

    def test_corrects_once_then_respects_user_choice(self):
        module = load_app_patch()
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            puts = []
            state = {"persisted": False}

            def fake_put(base, plugin_id, value):
                puts.append(value)
                if value is True:
                    state["persisted"] = True  # 模拟宿主真的把 true 落盘

            with mock.patch.object(module, "_autostart_persisted", side_effect=lambda root_, pid: state["persisted"]), \
                 mock.patch.object(module, "_put_autostart", side_effect=fake_put), \
                 mock.patch.object(module.time, "sleep", lambda seconds: None):
                module._ensure_autostart(root, lambda level, message: None)
                self.assertEqual(puts, [True], "第一次应该把 auto_start 打开")
                marker = module._autostart_marker_path(root)
                self.assertTrue(marker.exists(), "校正成功后要落标记")

                puts.clear()
                module._ensure_autostart(root, lambda level, message: None)
                self.assertEqual(puts, [], "已经有标记：用户之后关掉的不能被改回 true")

    def test_marker_lives_outside_plugin_package_when_possible(self):
        module = load_app_patch()
        root = Path("/fake/N.E.K.O/.neko-plugin-installations/plugins/neko_theme_studio")
        marker = module._autostart_marker_path(root)
        self.assertNotIn("neko-plugin-installations", marker.as_posix())


class InstallScriptTests(unittest.TestCase):
    """install.ps1 的用户数据备份必须是真复制（P0：以前一个文件都没拷）。"""

    def test_copy_helper_exists_and_is_used(self):
        self.assertIn("function Copy-DirectoryContents {", INSTALL_PS1)
        self.assertIn("Copy-DirectoryContents -Source $srcDir -Destination $dstDir", INSTALL_PS1)
        # 旧写法（-LiteralPath + 通配符）既不报错也不复制，是这次数据丢失的根因。
        self.assertNotIn("Copy-Item -LiteralPath (Join-Path $srcDir '*')", INSTALL_PS1)
        self.assertNotIn("Copy-Item -LiteralPath (Join-Path $src '*')", INSTALL_PS1)

    def test_backup_verifies_file_count(self):
        self.assertIn("备份用户数据 static\\{0}\\ 失败", INSTALL_PS1)
        self.assertIn("throw (", INSTALL_PS1)

    def test_plugin_failure_is_not_reported_as_success(self):
        self.assertIn("if (-not $pluginStateOk) {", INSTALL_PS1)
        self.assertIn("但插件安装未成功", INSTALL_PS1)


class PanelWiringTests(unittest.TestCase):
    """面板侧两处行为修复的源码接线（行为本身在 test/panel-selftest.js §6.13）。"""

    def test_reload_discards_edits(self):
        self.assertIn("var discardEdits = !!(options && options.discardEdits);", APP_JS)
        self.assertIn("reloadPalette({ discardEdits: true })", APP_JS)
        start = APP_JS.index("async function reloadPalette(")
        end = APP_JS.index("function setRowControlsDisabled(", start)
        body = APP_JS[start:end]
        self.assertIn("state.edited = { light: {}, dark: {} };", body)
        self.assertIn("state.cleared = { light: {}, dark: {} };", body)
        self.assertIn("markAllRowsValid();", body)
        self.assertIn("clearRgbMemory();", body)

    def test_meta_dirty_is_counted(self):
        self.assertIn("function metaDirtyCount() {", APP_JS)
        self.assertIn("function pendingChangeCount() { return dirtyCount() + metaDirtyCount(); }", APP_JS)
        self.assertIn("var n = pendingChangeCount();", APP_JS)
        self.assertIn("dirty: pendingChangeCount(),", APP_JS)
        # 用户改了名称/开关后，renderMeta 不能拿服务端的值把输入框冲掉。
        start = APP_JS.index("function renderMeta() {")
        end = APP_JS.index("function updateButtons(", start)
        body = APP_JS[start:end]
        self.assertIn("var keepEdits = metaDirtyCount() > 0;", body)
        self.assertIn("if (!keepEdits) $('theme-enabled').checked", body)
        # busy 期间这两个控件要禁用，否则回读会覆盖刚敲的字。
        self.assertIn("['theme-name', 'theme-enabled'].forEach", APP_JS)


class LoaderGuardOrderTests(unittest.TestCase):
    """self-upgrade 守卫只能在真的要 reload 时才落盘。"""

    def test_guard_after_defer_checks(self):
        # v0.7.0 起「让路判断 + 落盘守卫 + reload」被抽进 reloadForUpgrade()，
        # 因为现在有两条进入方式：theme.json 的 loader_version（零下载）与老的
        # 下载 JS 读版本号。两条都必须遵守同一顺序，所以按函数体断言。
        start = LOADER_JS.index("function reloadForUpgrade(")
        end = LOADER_JS.index("function selfUpgradeIfNeeded(")
        body = LOADER_JS[start:end]
        defer_at = body.index("self-upgrade deferred")
        guard_at = body.index("SELF_UPGRADE_GUARD_KEY, SCRIPT_VERSION")
        reload_at = body.index("window.location.reload()")
        self.assertLess(defer_at, guard_at, "守卫必须排在「草稿/流式让路」之后")
        self.assertLess(guard_at, reload_at, "守卫必须落在 reload 之前（重载后新实例才认它）")

    def test_script_version_bumped(self):
        # 不钉死字面版本号（见 test_loader_warm 里的同类注释）：只要求是 semver
        # 且不低於本缺陷（self-upgrade 守卫顺序）修复所在版本 1.5.22。
        match = re.search(r"var SCRIPT_VERSION = '(\d+)\.(\d+)\.(\d+)';", LOADER_JS)
        self.assertIsNotNone(match, "loader 里找不到 SCRIPT_VERSION")
        version = tuple(int(x) for x in match.groups())
        self.assertGreaterEqual(version, (1, 5, 22))


if __name__ == "__main__":
    unittest.main()
