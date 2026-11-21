"""「面板感知磁盘外部改动」（v0.4.14）的离线测试。

为什么单独立一条：这段代码的失效方式**用户看不见**。

- 面板只在打开时 ``get_theme`` 一次。按时段自动换主题的后台线程、
  开着面板的其它窗口、命令行都会改 ``theme.json``，面板却一直显示打开那一刻
  的旧值 —— 主题名、颜色、可读性自检全是过期的，用户毫无察觉。
- 反过来更危险：如果「跟随」的条件写宽了，面板会**直接覆盖用户尚未应用的
  改动**。用户敲了十几个颜色没点应用，五秒后一次轮询把它们全清了，
  界面上只留下一个一闪而过的 toast。

所以这里锁两件事：①该跟的时候真会跟；②面板有未提交改动/弹窗/忙时一律让路。
纯函数部分由 ``test/sync-selftest.js`` 覆盖（11 + 10 条断言）；本文件覆盖
「接线是否真的接上了」以及「不许出现静默覆盖的写法」。

跑法（无需宿主 SDK）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import re
import unittest

from offline_backend import HAS_REPO_TREE, PLUGIN_DIR, ROOT

APP_JS = (PLUGIN_DIR / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (PLUGIN_DIR / "static" / "index.html").read_text(encoding="utf-8")


def _block(start_marker: str, end_marker: str) -> str:
    start = APP_JS.find(start_marker)
    end = APP_JS.find(end_marker, start + 1)
    if start < 0 or end < 0:
        return ""
    return APP_JS[start:end]


SYNC_BLOCK = _block("function paletteSignature(", "function startExternalSync()")


class ConstantsTests(unittest.TestCase):
    def test_poll_interval_is_sane(self):
        match = re.search(r"var EXTERNAL_SYNC_INTERVAL_MS = (\d+);", APP_JS)
        self.assertIsNotNone(match, "缺少轮询间隔常量")
        value = int(match.group(1))
        # 太密烧 CPU（面板常开），太疏感知明显；5s 是「换主题后基本立刻发现」的量级。
        self.assertGreaterEqual(value, 1000)
        self.assertLessEqual(value, 15000)

    def test_start_delay_exists(self):
        match = re.search(r"var EXTERNAL_SYNC_START_DELAY_MS = (\d+);", APP_JS)
        self.assertIsNotNone(match, "缺少启动延迟常量（会和首屏那几发请求抢）")
        self.assertGreaterEqual(int(match.group(1)), 500)

    def test_poll_has_its_own_timeout(self):
        # 轮询用 POST_TIMEOUT_MS（30s）会让一次卡住的请求把轮询坑 30 秒。
        self.assertIn("EXTERNAL_SYNC_TIMEOUT_MS", APP_JS)
        match = re.search(r"var EXTERNAL_SYNC_TIMEOUT_MS = (\d+);", APP_JS)
        self.assertIsNotNone(match)
        self.assertLessEqual(int(match.group(1)), 10000)


class SignatureTests(unittest.TestCase):
    def test_signature_hashes_content(self):
        """v0.5.0：签名必须是**内容哈希**，不是 updated_at + 键数。

        旧实现漏掉了「手改了一个已有变量的值、但没动 updated_at」—— 而那正是这个
        功能存在的理由（面板不是 theme.json 的唯一写入方）。"""
        block = _block("function paletteSignature(", "function externalSyncDecision(")
        self.assertTrue(block)
        self.assertIn("hashText([", block)
        self.assertIn("pairBlock(p.vars)", block)
        self.assertIn("pairBlock(p.dark_vars)", block)
        self.assertIn("Object.keys(map).sort()", block)
        self.assertIn("String(map[key])", block)
        # 主题名与启用状态也要进签名：改名 / 开关主题都是可见变化。
        self.assertIn("String(p.name || '')", block)
        self.assertIn("p.enabled === false ? '0' : '1'", block)
        # 不能退回到时间戳/计数。
        self.assertNotIn("updated_at", block)

    def test_hash_function_is_stable_fnv(self):
        block = _block("function hashText(", "function paletteSignature(")
        self.assertIn("0x811c9dc5", block, "FNV-1a 偏移基数")
        self.assertIn(">>> 0", block, "必须转成无符号 32 位，否则负数会出 '-'")

    def test_signature_never_thrrows_on_garbage(self):
        block = _block("function paletteSignature(", "function externalSyncDecision(")
        # 拿到坏 JSON / null 时必须返回空串而不是抛（否则轮询会把面板打崩）。
        self.assertIn("if (!p || typeof p !== 'object') return '';", block)
        self.assertIn("if (!map || typeof map !== 'object') return '';", block)


class DecisionTests(unittest.TestCase):
    def test_blockers_take_priority(self):
        block = _block("function externalSyncDecision(", "function externalSyncBlockers(")
        self.assertTrue(block)
        # 顺序是有意义的：busy 先于 dirty 先于 modal —— 状态越「不能动」越靠前。
        order = [block.find(item) for item in ("opts.busy", "opts.dirty", "opts.modalOpen")]
        self.assertTrue(all(i >= 0 for i in order), "三个阻塞条件都要在")
        self.assertEqual(order, sorted(order), "判断顺序变了，会改变 reason 语义")

    def test_never_applies_when_dirty(self):
        block = _block("function externalSyncDecision(", "function externalSyncBlockers(")
        self.assertIn("if (opts.dirty > 0) return { apply: false, reason: 'dirty' };", block)
        # apply:true 只能出现在最后一个 return（前面全被挡住）。
        self.assertEqual(block.count("apply: true"), 1)


class WiringTests(unittest.TestCase):
    def test_polls_static_theme_json_directly(self):
        # 走 /runs 调 get_theme 会真正跑一次插件 entry（有轮询开销、有 CSRF、
        # 还会在 runs 里堆垃圾）；磁盘文件是 48916 直接静态服务的。
        self.assertIn("fetchWithTimeout('theme.json?_=' + Date.now()", APP_JS)
        self.assertNotIn("callPlugin('get_theme', {})", SYNC_BLOCK)

    def test_bypasses_cache(self):
        block = _block("async function checkExternalChange(", "function startExternalSync()")
        self.assertIn("cache: 'no-store'", block)
        # theme.json 端点带 max-age=3600；不带时间戳/不 no-store 就会拿到一小时前的旧值。
        self.assertIn("Date.now()", block)

    def test_hidden_tab_does_not_poll(self):
        self.assertIn("document.visibilityState === 'hidden'", APP_JS)
        self.assertIn("document.addEventListener('visibilitychange'", APP_JS)

    def test_bootstrap_starts_after_first_paint(self):
        self.assertIn("setTimeout(startExternalSync, EXTERNAL_SYNC_START_DELAY_MS)", APP_JS)

    def test_reload_refreshes_baseline(self):
        # 不回填基线 = 每次点「重新读取」之后立刻误报一次「外部改动」。
        block = _block("async function reloadPalette(", "function setRowControlsDisabled(")
        self.assertIn("externalSyncState.lastSignature = paletteSignature(palette);", block)
        self.assertIn("externalSyncState.pending = null;", block)

    def test_follow_uses_silent_reload(self):
        self.assertIn("reloadPalette({ silent: true })", SYNC_BLOCK)

    def test_no_dirty_clear_in_sync_path(self):
        # 清脏标记只能由 applyTheme 的成功路径做（它还负责 invalid 态与回填）。
        # 这里一旦出现，就是「外部同步把用户没应用的改动擦掉」。
        for forbidden in ("state.edited =", "state.cleared =", "markAllRowsValid()"):
            self.assertNotIn(forbidden, SYNC_BLOCK, f"同步路径不该出现 {forbidden}")

    def test_surfaces_feedback(self):
        self.assertIn("已同步外部改动", SYNC_BLOCK)
        self.assertIn("磁盘主题已变化，未自动覆盖", SYNC_BLOCK)
        # 提示必须告诉用户怎么才能跟上，否则只是一个死胡同警告。
        self.assertIn("重新读取", SYNC_BLOCK)

    def test_debug_hooks_exposed(self):
        self.assertIn("externalSyncState: externalSyncState,", APP_JS)
        self.assertIn("paletteSignature: paletteSignature,", APP_JS)
        self.assertIn("externalSyncDecision: externalSyncDecision,", APP_JS)
        self.assertIn("checkExternalChange: checkExternalChange,", APP_JS)


class LifecycleTests(unittest.TestCase):
    def test_start_is_idempotent(self):
        block = _block("function startExternalSync(", "function stopExternalSync(")
        # 先 stop 再 setInterval：重复调用不会留下两个定时器（可见的自测页面会在
        # 一个会话里反复 start）。
        self.assertIn("stopExternalSync();", block)
        self.assertIn("clearInterval", _block("function stopExternalSync(", "function revertMode("))

    def test_inflight_guard(self):
        # 上一轮还没回来时不能再发一轮：慢网络下会雪崩成并发请求。
        block = _block("async function checkExternalChange(", "function startExternalSync()")
        self.assertIn("externalSyncState.inFlight", block)
        self.assertIn("finally", block)


class RegressionTests(unittest.TestCase):
    def test_existing_features_untouched(self):
        # 外部同步是纯增量的旁路功能，不许改动既有路径的语义。
        for marker in ("function refreshSchedule(", "function saveSchedule(",
                       "function refreshLibrary(", "function applyTheme(",
                       "function renderLibrary("):
            self.assertIn(marker, APP_JS, f"{marker} 不见了")

    def test_schedule_still_reloads(self):
        # 按时段自动换主题在面板侧的「保存后回读」不能因为新增轮询被删。
        block = _block("async function saveSchedule(", "function revertMode(")
        self.assertIn("reloadPalette({ silent: true })", block)

    def test_selftest_file_exists(self):
        self.assertTrue((ROOT / "test" / "sync-selftest.js").is_file(),
                        "test/sync-selftest.js 缺失（纯函数断言在那份里）")


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
