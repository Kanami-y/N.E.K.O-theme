"""主题仓库「自定义」与「收藏」相关的离线测试。

覆盖两块容易回退的东西：

1. 导入别人分享的 ``.json`` 主题文件：结构校验必须是「有用的报错」而不是崩栈，
   并且 ``note`` / ``tags`` 要能跟着进仓库（面板「自定义」里会展示）。
2. 面板与后端接线：面板必须有「自定义」「收藏」两个分类、导入按钮接受 ``.json``，
   仓库列表必须带 ``preview``（自定义主题也要有缩略色板）。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import json
import unittest

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
_parse_theme_json = NS["_parse_theme_json"]
_theme_note = NS["_theme_note"]
_theme_tags = NS["_theme_tags"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8")
APP_JS = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "plugin" / "static" / "index.html").read_text(encoding="utf-8")


def _body(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


class ThemeJsonTests(unittest.TestCase):
    def test_full_theme_json_is_accepted(self):
        parsed = _parse_theme_json(
            _body(
                {
                    "schema": 1,
                    "name": "朋友的玻璃",
                    "vars": {"--nts-accent": "#7fb8ff"},
                    "dark_vars": {"--nts-accent": "#9fd0ff"},
                    "note": "冷调玻璃，适合夜里用",
                    "tags": ["玻璃", "冷色"],
                }
            )
        )
        self.assertEqual(parsed["name"], "朋友的玻璃")
        self.assertEqual(parsed["vars"]["--nts-accent"], "#7fb8ff")

    def test_minimal_json_is_accepted(self):
        parsed = _parse_theme_json(_body({"vars": {"--nts-radius": "12px"}}))
        self.assertIn("--nts-radius", parsed["vars"])

    def test_dark_only_json_is_accepted(self):
        parsed = _parse_theme_json(_body({"dark_vars": {"--nts-accent": "#000000"}}))
        self.assertIn("dark_vars", parsed)

    def test_bom_prefixed_json_is_accepted(self):
        payload = b"\xef\xbb\xbf" + _body({"vars": {"--nts-radius": "10px"}})
        self.assertIn("vars", _parse_theme_json(payload))

    def test_missing_vars_is_rejected_with_reason(self):
        with self.assertRaises(SdkError) as ctx:
            _parse_theme_json(_body({"name": "只有名字"}))
        self.assertIn("vars", str(ctx.exception))

    def test_array_json_is_rejected(self):
        with self.assertRaises(SdkError):
            _parse_theme_json(b'["not", "an", "object"]')

    def test_empty_file_is_rejected(self):
        with self.assertRaises(SdkError):
            _parse_theme_json(b"   \n  ")

    def test_broken_json_is_rejected(self):
        with self.assertRaises(SdkError):
            _parse_theme_json(b"{'vars': {}}")

    def test_oversize_file_is_rejected(self):
        huge = _body({"vars": {"--nts-radius": "1px" * 200000}})
        with self.assertRaises(SdkError):
            _parse_theme_json(huge)

    def test_binary_file_is_rejected(self):
        with self.assertRaises(SdkError):
            _parse_theme_json(b"\xff\xfe\x00\x00binary")


class NoteAndTagsTests(unittest.TestCase):
    def test_note_is_trimmed_to_120(self):
        self.assertEqual(len(_theme_note("x" * 500)), 120)
        self.assertEqual(_theme_note("  短介绍  "), "短介绍")
        self.assertEqual(_theme_note(None), "")
        self.assertEqual(_theme_note(123), "")

    def test_tags_take_first_four_and_clip(self):
        tags = _theme_tags(["a" * 40, "b", "c", "d", "e"])
        self.assertEqual(len(tags), 4)
        self.assertEqual(len(tags[0]), 12)
        self.assertEqual(tags[1], "b")

    def test_tags_ignore_non_strings(self):
        # 只取前 4 项，再逐项筛掉非字符串/空白（与内置主题的解析口径一致）。
        self.assertEqual(_theme_tags(["ok", 7, None, {"x": 1}, "也ok"]), ["ok"])
        self.assertEqual(_theme_tags(["a", "b", "c", "d", "e"]), ["a", "b", "c", "d"])
        self.assertEqual(_theme_tags("not-a-list"), [])


class BackendWiringTests(unittest.TestCase):
    def test_archive_import_uses_json_parser(self):
        # 裸 JSON 分支必须走统一解析器，而不是各写一份 json.loads。
        self.assertIn("_parse_theme_json(data)", BACKEND)

    def test_library_save_keeps_note_and_tags(self):
        self.assertIn("note=theme.get(\"note\")", BACKEND)
        self.assertIn("tags=theme.get(\"tags\")", BACKEND)

    def test_library_items_expose_preview(self):
        snippet = BACKEND.split("def _library_items", 1)[1].split("def _preset_items", 1)[0]
        self.assertIn("_preset_preview(clean_vars, clean_dark)", snippet)

    def test_archive_import_keeps_note_and_tags_on_disk(self):
        # _rewrite_archive_refs 会把分享包重建成「干净 dict」——曾经顺手把
        # note/tags 丢掉，导入回来的主题就变成一条没有出处的匿名配色。
        snippet = BACKEND.split("def _rewrite_archive_refs", 1)[1].split(
            "def _parse_archive", 1
        )[0]
        self.assertIn('out["note"]', snippet)
        self.assertIn('out["tags"]', snippet)

    def test_archive_export_packs_note_and_tags(self):
        snippet = BACKEND.split("def _build_archive", 1)[1].split(
            "def _rewrite_archive_refs", 1
        )[0]
        self.assertIn('record["note"]', snippet)
        self.assertIn('record["tags"]', snippet)


class PanelWiringTests(unittest.TestCase):
    def test_custom_family_constant_exists(self):
        self.assertIn("LIB_CUSTOM_FAMILY", APP_JS)
        self.assertIn("'自定义'", APP_JS)

    def test_both_virtual_families_are_always_rendered(self):
        snippet = APP_JS.split("function renderLibraryFamilies", 1)[1].split(
            "function focusFamilyTab", 1
        )[0]
        self.assertIn("makeTab(LIB_FAV_FAMILY, '收藏'", snippet)
        self.assertIn("makeTab(LIB_CUSTOM_FAMILY, '自定义'", snippet)
        self.assertNotIn("if (counts.fav)", snippet)

    def test_custom_family_matches_non_builtin(self):
        snippet = APP_JS.split("function libMatchesFamily", 1)[1].split("}", 1)[0]
        self.assertIn("LIB_CUSTOM_FAMILY", snippet)
        self.assertIn("builtin", snippet)

    def test_favorites_sort_first_in_custom_view(self):
        self.assertIn("libSortCustomWithFavorites", APP_JS)

    def test_import_button_accepts_json(self):
        self.assertIn('accept=".zip,.theme,.json', INDEX_HTML)
        self.assertIn('id="btn-lib-import"', INDEX_HTML)

    def test_empty_custom_text_guides_import(self):
        self.assertIn("导入包", APP_JS)
        self.assertIn("自定义", APP_JS)

    def test_favorite_button_is_labeled_and_visible(self):
        # 曾经是右上角 22px、opacity .5 的 ☆，实测「用户根本找不到收藏在哪」。
        self.assertIn("'☆ 收藏'", APP_JS)
        self.assertIn("'★ 已收藏'", APP_JS)
        # 收藏按钮必须进操作行（.lib-btns），而不是绝对定位在卡片角上。
        # 不锁死整个数组字面量：0.4.15 加了个「JSON」按钮，原来的精确匹配
        # 立刻就红了 —— 这里只要求「前三个是收藏/应用/分享，后面可以再续」。
        self.assertRegex(
            APP_JS, r"var libBtns = \[favBtn, applyBtn, exportBtn(?:, \w+)*\];"
        )
        self.assertIn("「☆ 收藏」按钮", APP_JS)
        style = (ROOT / "plugin" / "static" / "style.css").read_text(encoding="utf-8")
        fav_block = style.split(".lib-fav {", 1)[1].split("}", 1)[0]
        self.assertNotIn("position: absolute", fav_block)


if __name__ == "__main__":
    unittest.main()
