"""「复制主题 JSON」（v0.4.15）的离线测试。

为什么值得测：

1. **图片必须被摘掉**：纯文本里放不下背景图。如果漏摘，贴出去的人会看到一条
   指向分享者本机 ``backgrounds/<hash>`` 的地址 —— 要么 404、要么（更糟）
   如果他恰好有同名文件，看到的是别人那套图。导出文本里**不允许**出现本机路径。
2. **图片张数必须在「变量被校验丢掉」之前数**：内置主题（``presets/*.json``）
   里存的是可移植的 ``url("images/<hash>")``，而 ``_validate_palette`` 只认本机
   ``backgrounds/`` 地址，校验会把这条变量判非法丢掉。先校验再数，面板就会对
   一眼就看得出有背景图的主题显示「含 0 张背景图」，提示自相矛盾。
3. **导出的东西必须能再导入回来**：这是「复制 JSON」的唯一用途。所以这里不
   只比字段，还用 ``_validate_palette`` 回头吃一遍 payload。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
_validate_palette = NS["_validate_palette"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8-sig")
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
STYLE_CSS = (ROOT / "plugin" / "static" / "style.css").read_text(encoding="utf-8-sig")

PORTABLE_IMAGE = 'url("images/aaaa1111bbbb2222.jpg")'
LOCAL_IMAGE = 'url("/plugin/neko_theme_studio/ui/backgrounds/cccc3333dddd4444.jpg")'


def make_plugin(tmp: Path):
    """不走 __init__（它要宿主 ctx 与文件日志）：直接造一个只看 static_dir 的实例。"""
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    plugin.static_dir.mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "presets").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "themes").mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "backgrounds").mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    return plugin


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def preset(tmp: Path, theme_id: str, *, name: str, with_image: bool, note: str = "",
           tags: list | None = None) -> None:
    variables = {"--nts-accent": "#7fb8ff", "--nts-panel-bg": "rgba(12, 16, 28, 0.72)"}
    if with_image:
        variables["--nts-chat-bg-image"] = PORTABLE_IMAGE
    write_json(
        tmp / "static" / "presets" / f"{theme_id}.json",
        {
            "schema": 1,
            "name": name,
            "note": note,
            "tags": list(tags or []),
            "vars": variables,
            "dark_vars": dict(variables),
            "builtin": True,
        },
    )


def library_item(tmp: Path, theme_id: str, *, with_local_image: bool) -> None:
    variables = {"--nts-accent": "#ff9f6b"}
    if with_local_image:
        variables["--nts-chat-bg-image"] = LOCAL_IMAGE
    write_json(
        tmp / "static" / "themes" / f"{theme_id}.json",
        {
            "schema": 1,
            "id": theme_id,
            "name": "我的主题",
            "saved_at": "2026-11-19T09:00:00",
            "vars": variables,
            "dark_vars": dict(variables),
        },
    )


def run(plugin, **kwargs):
    return asyncio.run(plugin.theme_json(**kwargs))


class PayloadShapeTests(unittest.TestCase):
    """导出的 JSON 结构：够分享、不夹带本机路径。"""

    def test_preset_with_image_drops_image_var_and_counts_it(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "starry-meow", name="星辰喵", with_image=True, note="深空",
                   tags=["深色", "夜空"])
            result = run(plugin, theme_id="starry-meow")
            self.assertIsInstance(result.value, dict, msg="应当成功")
            payload = json.loads(result.value["payload"])
            self.assertNotIn("--nts-chat-bg-image", payload["vars"])
            self.assertNotIn("--nts-chat-bg-image", payload["dark_vars"])
            self.assertEqual(result.value["images"], 1)
            self.assertNotIn("backgrounds/", result.value["payload"])
            self.assertNotIn("images/", result.value["payload"])

    def test_payload_has_shareable_top_level_fields(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "no-image", name="纯色", with_image=False, note="简单",
                   tags=["浅色"])
            result = run(plugin, theme_id="no-image")
            payload = json.loads(result.value["payload"])
            self.assertEqual(
                set(payload), {"schema", "name", "note", "tags", "vars", "dark_vars"}
            )
            self.assertEqual(payload["name"], "纯色")
            self.assertEqual(payload["note"], "简单")
            self.assertEqual(payload["tags"], ["浅色"])
            self.assertEqual(payload["schema"], 1)

    def test_no_image_theme_keeps_vars_and_reports_zero(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "no-image", name="纯色", with_image=False)
            result = run(plugin, theme_id="no-image")
            payload = json.loads(result.value["payload"])
            self.assertEqual(result.value["images"], 0)
            self.assertIn("--nts-accent", payload["vars"])
            self.assertEqual(result.value["light"], len(payload["vars"]))
            self.assertEqual(result.value["dark"], len(payload["dark_vars"]))

    def test_library_item_with_local_image_is_stripped_too(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            library_item(tmp, "mine-20260101000000", with_local_image=True)
            result = run(plugin, theme_id="mine-20260101000000")
            self.assertEqual(result.value["images"], 1)
            self.assertNotIn("--nts-chat-bg-image", result.value["payload"])
            self.assertNotIn("/plugin/", result.value["payload"])

    def test_payload_is_sorted_indented_utf8(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "pretty", name="好看的主题", with_image=False)
            text = run(plugin, theme_id="pretty").value["payload"]
            self.assertIn("好看的主题", text, msg="中文不该被转成 \\u 转义")
            self.assertIn('\n  "dark_vars"', text)
            keys = list(json.loads(text)["vars"])
            self.assertEqual(keys, sorted(keys), msg="变量应排序，方便 diff")

    def test_byte_count_matches_payload(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "bytes", name="字节", with_image=False)
            result = run(plugin, theme_id="bytes")
            self.assertEqual(
                result.value["bytes"], len(result.value["payload"].encode("utf-8"))
            )


class ImportableTests(unittest.TestCase):
    """导出的文本必须能被「导入」再吃回去（这是它唯一的用途）。"""

    def test_payload_passes_validation_round_trip(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "round-trip", name="来回", with_image=False)
            payload = json.loads(run(plugin, theme_id="round-trip").value["payload"])
            _vars, _dark, errors = _validate_palette(payload["vars"], payload["dark_vars"])
            self.assertEqual(errors, [], msg=f"自家导出的变量不该被判非法：{errors}")


class ErrorTests(unittest.TestCase):
    """错误必须是 Err + 可读文案，绝不能让 entry 抛异常打崩面板。"""

    def test_unknown_theme_returns_err(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            result = run(plugin, theme_id="no-such-theme")
            self.assertIsInstance(result.value, SdkError)
            self.assertIn("没有这个主题", str(result.value))

    def test_illegal_id_shape_returns_err(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            for bad in ("../etc/passwd", "UPPER", "with_underscore", "-leading"):
                with self.subTest(bad=bad):
                    result = run(plugin, theme_id=bad)
                    self.assertIsInstance(result.value, SdkError)

    def test_id_alias_is_accepted(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            preset(tmp, "alias-theme", name="别名", with_image=False)
            result = run(plugin, id="alias-theme")
            self.assertIsInstance(result.value, dict)
            self.assertEqual(json.loads(result.value["payload"])["name"], "别名")

    def test_theme_without_any_vars_returns_err(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            plugin = make_plugin(tmp)
            write_json(
                tmp / "static" / "presets" / "empty-theme.json",
                {"schema": 1, "name": "空", "vars": {}, "dark_vars": {}},
            )
            result = run(plugin, theme_id="empty-theme")
            self.assertIsInstance(result.value, SdkError)
            self.assertIn("没有可分享", str(result.value))


class WiringTests(unittest.TestCase):
    """entry 注册 / actions 登记 / 面板接线（防「后端加了、面板没按钮」）。"""

    def test_entry_exists(self):
        self.assertIn('id="theme_json"', BACKEND)
        self.assertTrue(hasattr(NekoThemeStudioPlugin, "theme_json"))

    def test_action_registered(self):
        self.assertIn('{"id": "theme_json", "entry_id": "theme_json"}', BACKEND)

    def test_entry_declares_both_id_aliases(self):
        block = BACKEND.split('id="theme_json"', 1)[1].split("async def theme_json", 1)[0]
        self.assertIn('"theme_id"', block)
        self.assertIn('"id"', block)

    def test_panel_has_json_button_and_handler(self):
        self.assertIn("copyLibraryItemJson", APP_JS)
        self.assertIn("class: 'btn btn-mini lib-json'", APP_JS)
        self.assertIn("'data-act': 'json'", APP_JS)
        self.assertIn("callPlugin('theme_json'", APP_JS)
        self.assertIn("openModal('export', '主题 JSON · '", APP_JS)

    def test_panel_warns_about_dropped_images(self):
        block = APP_JS.split("async function copyLibraryItemJson", 1)[1].split(
            "async function deleteLibraryItem", 1
        )[0]
        self.assertIn("images > 0", block)
        self.assertIn("导", block)
        self.assertIn("zip", block)

    def test_button_is_in_card_action_row(self):
        block = APP_JS.split("function buildLibraryItem", 1)[1].split("function renderLibraryFamilies", 1)[0]
        self.assertIn("jsonBtn", block)
        self.assertIn("var libBtns = [favBtn, applyBtn, exportBtn, jsonBtn];", block)

    def test_button_has_own_style(self):
        self.assertIn(".lib-json {", STYLE_CSS)


if __name__ == "__main__":
    unittest.main()
