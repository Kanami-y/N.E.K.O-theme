"""``--nts-chat-bg-fit``：壁纸「铺满 / 整图可见」开关的三端契约。

用户诉求（m06827 → 0.4.25 之后）：壁纸是 ``cover``（铺满必然裁切），希望可以切成
``contain``（整图可见、两侧留底色）。这个变量是**关键字型**（不是颜色、不是长度），
所以它比普通变量多碰两处：后端 ``_value_kind`` / 加载器 ``NON_COLOR_VARS``。
只改一处的后果是「面板选得动、窗口不变」——本测试就是锁住三端一致。

锁住的契约：
1. 后端：``_value_kind('--nts-chat-bg-fit') == 'keyword'``，只收 ``cover`` / ``contain``
   （大小写不敏感），规范化统一小写；``KNOWN_VARS`` 里有它、``_validate_palette`` 收得下。
2. 加载器：``NON_COLOR_VARS`` 登记为 ``keyword``，``isSafeValue`` 只放这两个值。
3. 面板：CATALOG 里是 ``select``，两个选项；``buildRow`` 造了 ``.fit-select``；值变化走
   ``markEdited``。变量总数 96。
4. CSS：生成器用 ``var(--nts-chat-bg-fit)`` 覆盖 ``background-size``，且**排在**
   ``background-size: cover`` 那批规则之后（否则会被压回去）。
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import ROOT, load_backend  # noqa: E402

LOADER_JS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.js"
LOADER_CSS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.css"
APP_JS = ROOT / "plugin" / "static" / "app.js"
TARGETS_JS = ROOT / "test" / "targets.js"
GEN_CSS = ROOT / "tools" / "gen-css.js"

VAR = "--nts-chat-bg-fit"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


NS = load_backend()


class BackendTests(unittest.TestCase):
    def test_registered_and_keyword_kind(self):
        self.assertIn(VAR, NS["KNOWN_VARS"])
        self.assertEqual(NS["_value_kind"](VAR), "keyword")
        self.assertEqual(NS["KEYWORD_VARS"][VAR], ("cover", "contain"))

    def test_safe_values(self):
        safe = NS["_is_safe_value"]
        for good in ("cover", "contain", "CONTAIN", "Cover"):
            with self.subTest(value=good):
                self.assertTrue(safe(VAR, good))
        for bad in ("", "coverx", "fill", "scale-down", "url(x)", "1px", "contain; color: red"):
            with self.subTest(value=bad):
                self.assertFalse(safe(VAR, bad))

    def test_canonicalize_lowercases(self):
        self.assertEqual(NS["_canonicalize_value"](VAR, "CONTAIN"), "contain")
        self.assertEqual(NS["_canonicalize_value"](VAR, "Cover"), "cover")

    def test_palette_round_trip(self):
        palette = {"--nts-chat-bg-fit": "contain"}
        variables, dark_vars, errors = NS["_validate_palette"](dict(palette), {})
        self.assertEqual(errors, [])
        self.assertEqual(variables[VAR], "contain")

    def test_palette_rejects_unknown_keyword(self):
        _, _, errors = NS["_validate_palette"]({VAR: "fill"}, {})
        self.assertTrue(errors, "fill 不是合法关键字，应当被拒")


class LoaderTests(unittest.TestCase):
    def test_non_color_vars_registers_keyword(self):
        src = read(LOADER_JS)
        self.assertRegex(src, r"'--nts-chat-bg-fit':\s*'keyword'")

    def test_is_safe_value_whitelists_two_values(self):
        src = read(LOADER_JS)
        head = src.index("function isSafeValue(")
        body = src[head:head + 2600]
        self.assertIn("kind === 'keyword'", body)
        # v0.8.0 起关键字白名单收进 KEYWORD_VALUES（同一个分支也要服务
        # --nts-corner-style 的 round/continuous），所以断言看表本身而不是
        # 函数体里的字面量。
        table = src[src.index("var KEYWORD_VALUES = {"):src.index("function isSafeValue(")]
        self.assertIn("'--nts-chat-bg-fit': ['cover', 'contain']", table)
        self.assertIn("KEYWORD_VALUES[name]", body)

    def test_mirrors_agree(self):
        version = re.search(r"var SCRIPT_VERSION = '(\d+\.\d+\.\d+)';", read(LOADER_JS)).group(1)
        for mirror in ("app/neko-theme-studio.js", "app-patch/files/neko-theme-studio.js"):
            with self.subTest(mirror=mirror):
                other = read(ROOT / mirror)
                self.assertIn("'--nts-chat-bg-fit': 'keyword'", other)
                self.assertIn("var SCRIPT_VERSION = '%s';" % version, other)


class PanelTests(unittest.TestCase):
    def test_catalog_entry_is_select(self):
        src = read(APP_JS)
        at = src.index("key: '--nts-chat-bg-fit'")
        entry = src[at:at + 400]
        self.assertIn("type: 'select'", entry)
        self.assertIn("value: 'cover'", entry)
        self.assertIn("value: 'contain'", entry)

    def test_builds_select_control(self):
        src = read(APP_JS)
        self.assertIn("class: 'fit-select'", src)
        self.assertIn("markEdited(item.key, selectInput.value)", src)
        self.assertIn("selectInput: selectInput", src)

    def test_catalog_total_matches_known_vars(self):
        # CATALOG 与 KNOWN_VARS 必须一一对应（少一个 = 面板里没法调，多一个 = 存了没用）
        keys = set(re.findall(r"key:\s*'(--nts-[a-z0-9-]+)'", read(APP_JS)))
        self.assertEqual(len(keys), len(NS["KNOWN_VARS"]))
        self.assertEqual(keys, set(NS["KNOWN_VARS"]))

    def test_css_has_fit_select_style(self):
        css = read(ROOT / "plugin" / "static" / "style.css")
        self.assertIn(".fit-select {", css)


class CssTests(unittest.TestCase):
    def test_six_rules_use_the_variable(self):
        css = read(LOADER_CSS)
        self.assertEqual(css.count("var(--nts-chat-bg-fit)"), 6)

    def test_fit_rules_come_after_cover_rules(self):
        css = read(LOADER_CSS)
        last_cover = css.rfind("background-size: cover !important")
        first_fit = css.find("var(--nts-chat-bg-fit)")
        self.assertGreater(last_cover, 0)
        self.assertGreater(first_fit, 0)
        self.assertGreater(first_fit, last_cover, "fit 规则必须排在 cover 之后，否则被压回 cover")

    def test_generator_keeps_explanation(self):
        self.assertIn("chatBackgroundFit", read(GEN_CSS))

    def test_targets_lists_fixed_size_containers(self):
        src = read(TARGETS_JS)
        at = src.index("chatBackgroundFit")
        block = src[at:at + 400]
        self.assertIn("'--nts-chat-bg-fit'", block)
        for selector in (".compact-export-history-scroll", ".message-list", ".chat-body"):
            with self.subTest(selector=selector):
                self.assertIn("'%s'" % selector, block)
        self.assertNotIn("-content", block)


if __name__ == "__main__":
    unittest.main()
