"""Round 27 的两处「逻辑正确性」回归：阻塞事件循环、重复注入、预热串号。

三件事都不是「界面不好看」，而是**能安静地把功能弄坏**：

1. ``repair_app`` 以前在协程里同步跑 ``_run_app_patch``（里面起 powershell 找应用根，
   最长 8 秒）。那几秒里事件循环被占死，宿主派来的其它 entry 全部排队 → 用户看到
   「点了修复，面板整体没反应」。现在用 ``run_in_executor`` 丢到线程池。
2. loader / 面板被同一页面注入两次时，会各起一套定时器与监听器。加一次性哨兵。
3. 背景图预热：p1 的预热还没结束就来了 p2，p1 的回调会把 p2 直接 apply（图没预热），
   所以给每次预发热身一个票号，旧票号直接丢弃。
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import PLUGIN_DIR, load_backend  # noqa: E402

NS = load_backend()
PY_FILE = PLUGIN_DIR / "__init__.py"
LOADER_JS = PLUGIN_DIR / "static" / "loader" / "neko-theme-studio.js"
APP_JS = PLUGIN_DIR / "static" / "app.js"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


class RepairAppOffLoopTests(unittest.TestCase):
    def test_source_uses_executor(self):
        src = read(PY_FILE)
        at = src.index("async def repair_app(self")
        body = src[at:at + 1200]
        self.assertIn("run_in_executor(None, self._run_app_patch)", body)
        # 不许再出现同步直调（那会退回阻塞）
        self.assertNotIn("result = self._run_app_patch()", body)

    def test_asyncio_imported(self):
        self.assertRegex(read(PY_FILE), r"(?m)^import asyncio$")

    def test_runs_off_the_event_loop_thread(self):
        """真跑一次：打桩的 _run_app_patch 必须不在主线程执行。"""
        plugin = object.__new__(NS["NekoThemeStudioPlugin"])
        seen = {}

        def fake_patch():
            seen["ident"] = threading.get_ident()
            seen["main"] = threading.main_thread().ident
            time.sleep(0.05)
            return {"status": "ok", "marker": "stub"}

        plugin._run_app_patch = fake_patch
        result = asyncio.run(plugin.repair_app())
        self.assertTrue(getattr(result, "ok", True))
        self.assertIn("ident", seen)
        self.assertNotEqual(seen["ident"], seen["main"], "_run_app_patch 仍在事件循环线程里跑")

    def test_result_passed_through(self):
        plugin = object.__new__(NS["NekoThemeStudioPlugin"])
        plugin._run_app_patch = lambda: {"patched": 3}
        result = asyncio.run(plugin.repair_app())
        payload = getattr(result, "value", None)
        if payload is None:  # Ok 在桩里的形态可能不同
            payload = result
        self.assertEqual(payload, {"patched": 3})


class DuplicateInjectionTests(unittest.TestCase):
    def test_loader_sentinel_before_work(self):
        src = read(LOADER_JS)
        sentinel = src.index("__NTS_LOADER_LOADED__")
        first_work = src.index("var PLUGIN_ID =")
        self.assertLess(sentinel, first_work, "哨兵必须在任何轮询/监听之前")
        self.assertIn("if (window.__NTS_LOADER_LOADED__) return;", src)
        self.assertIn("window.__NTS_LOADER_LOADED__ = true;", src)
        # 哨兵之后才允许 return —— 也就是说它必须写在 IIFE 函数体内（不是顶层）
        self.assertGreater(sentinel, src.index("(function () {"))

    def test_panel_sentinel(self):
        src = read(APP_JS)
        self.assertIn("if (window.__NTS_PANEL_BOOTED__) return;", src)
        self.assertIn("window.__NTS_PANEL_BOOTED__ = true;", src)
        # 必须在 bootstrap 开头（早于 buildEditor/wireEvents），否则监听器已经绑过两遍
        boot = src.index("function bootstrap() {")
        sentinel = src.index("__NTS_PANEL_BOOTED__", boot)
        self.assertLess(sentinel, src.index("buildEditor();", boot))
        self.assertLess(sentinel, src.index("wireEvents();", boot))


class WarmTokenTests(unittest.TestCase):
    def test_sequence_declared(self):
        src = read(LOADER_JS)
        self.assertIn("var warmSeq = 0;", src)
        self.assertIn("var warmToken = (warmSeq += 1);", src)

    def test_stale_callback_is_dropped_before_apply(self):
        src = read(LOADER_JS)
        start = src.index("warmToken = (warmSeq += 1)")
        end = src.index("return true;", start)
        block = src[start:end]
        guard = block.index("warmToken !== warmSeq")
        apply_at = block.index("applyPalette(queued)")
        self.assertLess(guard, apply_at, "票号比对必须在 applyPalette 之前")
        self.assertIn("return;", block[guard:apply_at])

    def test_pending_cleared_only_by_latest(self):
        src = read(LOADER_JS)
        start = src.index("warmToken !== warmSeq")
        block = src[start:start + 400]
        self.assertIn("warmPending = null;", block)
        self.assertIn("warmingKey = null;", block)


if __name__ == "__main__":
    unittest.main()
