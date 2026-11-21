"""主题库「编辑名称 / 备注 / 标签」（v0.4.18）的离线测试。

为什么值得测：

1. **条目 id 必须稳定**：收藏（面板 localStorage）、按时段排程（schedule.json）、
   库备份包的 manifest 都拿 id 认主题。改名顺手改 id = 用户「收藏的那套突然没了」。
   这条是本次改动的核心约束，必须有测试盯着。
2. **只认仓库里自己的主题**：内置主题随插件发布，改了会在下次安装时被覆盖掉，
   所以要明确拒绝，并给出「先另存一份」的出路。
3. **清空语义**：传空备注/空标签 = 把字段从条目里去掉，而不是存一个空字符串
   （否则面板会显示一条空白的「描述」行）。
4. **路径安全**：仓库 JSON 是可写文件，``id`` 字段可以是 ``../../x``。拼路径前
   必须按 id 语法再校验一次 —— 这个 entry 是「写」操作，比删除更值得防。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
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
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]

APP_JS = (PLUGIN_DIR / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (PLUGIN_DIR / "static" / "index.html").read_text(encoding="utf-8-sig")
STYLE_CSS = (PLUGIN_DIR / "static" / "style.css").read_text(encoding="utf-8-sig")
BACKEND = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8-sig")

#: update_theme_meta 的源码片段（WiringTests 用它做「只改元信息」的静态检查）。
META_START = BACKEND.index('id="update_theme_meta"')
META_END = BACKEND.index('id="import_theme_archive"', META_START)
META_SRC = BACKEND[META_START:META_END]


def write_preset(tmp: Path, theme_id: str, name: str) -> None:
    """造一套「内置主题」（presets/ 下、builtin=true）。"""
    record = {
        "schema": 1,
        "id": theme_id,
        "name": name,
        "builtin": True,
        "saved_at": "2026-11-18T22:59:34+08:00",
        "vars": {"--nts-accent": "#c96a32"},
        "dark_vars": {"--nts-accent": "#e0834a"},
    }
    (tmp / "static" / "presets" / f"{theme_id}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def read_theme(tmp: Path, theme_id: str) -> dict:
    path = tmp / "static" / "themes" / f"{theme_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


def call_meta(plugin, **kwargs):
    return asyncio.run(plugin.update_theme_meta(**kwargs))


class RenameTests(unittest.TestCase):
    def test_rename_keeps_id_and_palette(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "seaside-1", name="海边", with_image=True,
                      note="偏冷", tags=["冷色"])
            before = read_theme(tmp, "seaside-1")
            ok, value = unwrap(call_meta(plugin, theme_id="seaside-1", name="海边的夏夜"))
            self.assertTrue(ok, value)
            self.assertTrue(value["updated"])
            self.assertEqual(value["changed"], ["name"])
            self.assertEqual(value["theme_id"], "seaside-1")
            after = read_theme(tmp, "seaside-1")
            # id / 调色板 / 保存时间一律不变 —— 只有 name 动。
            self.assertEqual(after["id"], before["id"])
            self.assertEqual(after["vars"], before["vars"])
            self.assertEqual(after["dark_vars"], before["dark_vars"])
            self.assertEqual(after["saved_at"], before["saved_at"])
            self.assertEqual(after["name"], "海边的夏夜")
            # 文件名没变（id 没变），旧文件不残留。
            self.assertEqual(
                sorted(p.name for p in (tmp / "static" / "themes").glob("*.json")),
                ["seaside-1.json"],
            )

    def test_rename_shows_up_in_library_list(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            unwrap(call_meta(plugin, id="warm-2", name="暖阳 · 升级版"))
            items = plugin._library_items()
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["name"], "暖阳 · 升级版")
            self.assertEqual(items[0]["id"], "warm-2")

    def test_unchanged_name_is_noop(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳", note="偏暖", tags=["暖色"])
            ok, value = unwrap(call_meta(plugin, theme_id="warm-2", name="暖阳"))
            self.assertTrue(ok, value)
            self.assertFalse(value["updated"])
            self.assertEqual(value["changed"], [])

    def test_empty_name_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            must_err(self, call_meta(plugin, theme_id="warm-2", name="   "), "不能为空")
            self.assertEqual(read_theme(tmp, "warm-2")["name"], "暖阳")

    def test_long_name_is_clipped_to_60(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            unwrap(call_meta(plugin, theme_id="warm-2", name="长" * 80))
            self.assertEqual(len(read_theme(tmp, "warm-2")["name"]), 60)


class NoteAndTagsTests(unittest.TestCase):
    def test_note_set_and_cleared(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            unwrap(call_meta(plugin, theme_id="warm-2", note="落日橘，适合傍晚"))
            self.assertEqual(read_theme(tmp, "warm-2")["note"], "落日橘，适合傍晚")
            # 空字符串 = 清掉字段，而不是留一个空的 note。
            ok, value = unwrap(call_meta(plugin, theme_id="warm-2", note=""))
            self.assertTrue(ok, value)
            self.assertIn("note", value["changed"])
            self.assertNotIn("note", read_theme(tmp, "warm-2"))

    def test_note_note_is_clipped_to_120(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            unwrap(call_meta(plugin, theme_id="warm-2", note="备" * 300))
            self.assertEqual(len(read_theme(tmp, "warm-2")["note"]), 120)

    def test_tags_from_list(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            unwrap(call_meta(plugin, theme_id="warm-2", tags=["暖色", "渐变", "氛围"]))
            self.assertEqual(
                read_theme(tmp, "warm-2")["tags"], ["暖色", "渐变", "氛围"]
            )

    def test_tags_from_string_and_limits(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            # 手写「暖色，渐变 ; 深色、极简 多余」也接受；只留 4 个、每个 12 字。
            unwrap(
                call_meta(
                    plugin,
                    theme_id="warm-2",
                    tags="暖色，渐变 ; 深色、极简 多余" + "超" * 20,
                )
            )
            tags = read_theme(tmp, "warm-2")["tags"]
            self.assertEqual(tags[:4], ["暖色", "渐变", "深色", "极简"])
            self.assertLessEqual(len(tags), 4)
            self.assertTrue(all(len(tag) <= 12 for tag in tags))

    def test_tags_cleared(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳", tags=["暖色"])
            ok, value = unwrap(call_meta(plugin, theme_id="warm-2", tags=[]))
            self.assertTrue(ok, value)
            self.assertNotIn("tags", read_theme(tmp, "warm-2"))

    def test_only_given_fields_change(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳", note="偏暖", tags=["暖色"])
            unwrap(call_meta(plugin, theme_id="warm-2", note="改过的说明"))
            after = read_theme(tmp, "warm-2")
            self.assertEqual(after["name"], "暖阳")
            self.assertEqual(after["note"], "改过的说明")
            self.assertEqual(after["tags"], ["暖色"])


class RejectTests(unittest.TestCase):
    def test_builtin_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            write_preset(tmp, "starry-meow", "星辰喵")
            must_err(self, call_meta(plugin, theme_id="starry-meow", name="改个名"), "内置主题")
            preset = json.loads(
                (tmp / "static" / "presets" / "starry-meow.json").read_text(encoding="utf-8")
            )
            self.assertEqual(preset["name"], "星辰喵")

    def test_missing_theme(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, call_meta(plugin, theme_id="no-such-theme", name="x"), "没有这个主题")

    def test_bad_id_shapes(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            for bad in ("../etc/passwd", "UPPER", "with_underscore", "-leading", "a" * 65):
                with self.subTest(bad=bad):
                    must_err(self, call_meta(plugin, theme_id=bad, name="x"))

    def test_record_id_field_cannot_redirect_the_write(self):
        """记录里被塞了 ``id: "../../evil"`` 也不能把写入引到别处。

        文件名才是仓库主键：读取时 ``id`` 会被归一成文件名，所以改的仍然是
        warm-2.json，目录外不会出现任何文件。（旧实现按记录 id 拼路径 —— 那才是
        真正的逃逸面，也是「删 beta 却删掉 alpha」这类事故的来源。）
        """
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            path = tmp / "static" / "themes" / "warm-2.json"
            record = json.loads(path.read_text(encoding="utf-8"))
            record["id"] = "../../evil"
            path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

            ok, value = unwrap(call_meta(plugin, theme_id="warm-2", name="越狱"))
            self.assertTrue(ok, value)
            self.assertEqual(value["theme_id"], "warm-2")
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["name"], "越狱")
            # id 归一：写回去的记录不再带着那个被改坏的 id。
            self.assertEqual(saved["id"], "warm-2")
            self.assertFalse((tmp / "static" / "evil.json").exists())
            self.assertEqual(
                sorted(item.name for item in (tmp / "static" / "themes").glob("*.json")),
                ["warm-2.json"],
            )

    def test_nothing_to_change(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "warm-2", name="暖阳")
            must_err(self, call_meta(plugin, theme_id="warm-2"), "没有要修改的内容")


class WiringTests(unittest.TestCase):
    def test_entry_and_action_registered(self):
        self.assertIn('id="update_theme_meta"', BACKEND)
        self.assertIn(
            '{"id": "update_theme_meta", "entry_id": "update_theme_meta"}', BACKEND
        )

    def test_input_schema_has_three_fields(self):
        self.assertIn('"name": {"type": "string", "maxLength": 60}', META_SRC)
        self.assertIn('"note": {"type": "string", "maxLength": 120}', META_SRC)
        self.assertIn('"maxItems": 4', META_SRC)

    def test_entry_only_touches_metadata(self):
        """静态锁：这个 entry 不该出现删除/写标题以外的破坏性字样。"""
        for forbidden in ("unlink", "shutil.", "rmtree", "delete_theme"):
            self.assertNotIn(forbidden, META_SRC)
        self.assertIn("_write_json_atomic(path, payload)", META_SRC)
        self.assertIn("with _WRITE_LOCK:", META_SRC)

    def test_panel_wiring(self):
        self.assertIn("function openMetaModal(", APP_JS)
        self.assertIn("async function saveThemeMeta(", APP_JS)
        self.assertIn("callPlugin('update_theme_meta'", APP_JS)
        self.assertIn("state.modalMode === 'meta'", APP_JS)
        self.assertIn("'data-act': 'meta'", APP_JS)
        self.assertIn("if (metaBtn) libBtns.push(metaBtn);", APP_JS)
        for element_id in ("meta-name", "meta-note", "meta-tags", "modal-fields"):
            self.assertIn(f'id="{element_id}"', INDEX_HTML)
        self.assertIn(".modal-fields", STYLE_CSS)
        self.assertIn(".lib-meta", STYLE_CSS)

    def test_meta_button_not_rendered_for_builtin(self):
        # metaBtn 的创建必须有 builtin 守卫，否则内置主题上会出现一个点了就报错的按钮。
        self.assertRegex(APP_JS, r"var metaBtn = item\.builtin \? null : el\('button'")

    def test_restart_hint(self):
        self.assertIn('id="restart-hint"', INDEX_HTML)
        self.assertIn('id="restart-hint-close"', INDEX_HTML)
        self.assertIn("第一次使用（或刚更新过插件）请重启一次 N.E.K.O 窗口", INDEX_HTML)
        self.assertIn("var RESTART_HINT_KEY = 'nts.restartHint.dismissed';", APP_JS)
        self.assertIn("function initRestartHint(", APP_JS)
        self.assertIn("initRestartHint();", APP_JS)
        self.assertIn(".panel-hint", STYLE_CSS)
        # localStorage 不可用（隐私模式）时不能抛：必须有 try/catch。
        hint_src = APP_JS[APP_JS.index("function initRestartHint("):]
        hint_src = hint_src[: hint_src.index("async function deleteLibraryItem(")]
        self.assertIn("try { dismissed = localStorage.getItem(RESTART_HINT_KEY) === '1'; } catch", hint_src)
        self.assertIn("try { localStorage.setItem(RESTART_HINT_KEY, '1'); } catch", hint_src)


if __name__ == "__main__":
    unittest.main()
