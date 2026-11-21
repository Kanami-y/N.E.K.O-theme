"""

from __future__ import annotations
分享包边界安全测试（v0.15.52）。

这些行为早就实现了，但**没有一条测试看着它们**：改一次 `_parse_archive` 或
`_rewrite_archive_refs`，把「非法路径拒绝」写成「静默跳过」，全量测试照样全绿
—— 危险的不是当时写错，是以后悄悄退化。

被测契约：

1. 路径类：`../`、绝对路径、带 `:` 的条目名一律拒绝。
2. 重名条目拒绝（重名能让「校验过的 theme.json」被后一个覆盖）。
3. 没有 theme.json 的包拒绝。
4. 图片按**魔数**判定格式，不看扩展名：HTML 冒充 .jpg 必须拒绝。
5. 单张图片上限 4 MiB。
6. 包内缺图 → 导入成功但引用丢弃（绝不把别人的路径写进 theme.json）。
7. 合法图片 → 按内容哈希命名落盘，引用改写成绝对 URL。
8. `javascript:` / `file://` 这类引用被校验丢掉。

跑法：python -m unittest discover -s plugin/tests -v
"""

import asyncio
import base64
import io
import json
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path

from offline_backend import load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
Q2 = chr(34)

PNG = bytes([137, 80, 78, 71, 13, 10, 26, 10]) + bytes(48)
HTML = b"<html><script>alert(1)</script></html>"


def img_ref(name: str) -> str:
    return "url(" + Q2 + "images/" + name + Q2 + ")"


def make_plugin(tmp: Path):
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for sub in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / sub).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.plugin_id = "neko_theme_studio"
    plugin.logger = None
    return plugin


def unwrap(result):
    value = result.value
    if isinstance(value, SdkError):
        return False, value
    return True, value


def zip_b64(theme, extra=(), theme_entries=1):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for _ in range(theme_entries):
            archive.writestr("theme.json", json.dumps(theme).encode("utf-8"))
        for name, data in extra:
            archive.writestr(name, data)
    return base64.b64encode(buf.getvalue()).decode("ascii")


PLAIN = {"name": "边界", "vars": {"--nts-chat-bg": "#101820"}}


class ArchiveCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.plugin = make_plugin(Path(self._tmp.name))

    def _import(self, theme, extra=(), theme_entries=1):
        return asyncio.run(
            self.plugin.import_theme_archive(data=zip_b64(theme, extra, theme_entries))
        )

    def _must_err(self, theme, extra=(), theme_entries=1, needle=""):
        ok, value = unwrap(self._import(theme, extra, theme_entries))
        self.assertFalse(ok, f"期望失败，实际成功：{value!r}")
        self.assertIsInstance(value, SdkError)
        if needle:
            self.assertIn(needle, str(value))
        return value

    def _ok(self, theme, extra=(), theme_entries=1):
        ok, value = unwrap(self._import(theme, extra, theme_entries))
        self.assertTrue(ok, f"期望成功，实际失败：{value!r}")
        return value

    def _record(self, theme_id: str) -> dict:
        path = self.plugin.static_dir / "themes" / (theme_id + ".json")
        self.assertTrue(path.is_file(), "仓库里没有 " + theme_id)
        return json.loads(path.read_text(encoding="utf-8"))

class ArchiveEntryTests(ArchiveCase):
    def test_parent_directory_reference_is_rejected(self):
        self._must_err(PLAIN, [("../evil.jpg", PNG)], needle="非法路径")

    def test_absolute_path_is_rejected(self):
        self._must_err(PLAIN, [("/etc/evil.jpg", PNG)], needle="非法路径")

    def test_drive_letter_style_name_is_rejected(self):
        self._must_err(PLAIN, [("C:evil.jpg", PNG)], needle="非法路径")

    def test_duplicate_entry_names_are_rejected(self):
        # zipfile 自己会 warn「Duplicate name」，那是构造用例的噪音，不是被测行为。
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self._must_err(PLAIN, theme_entries=2, needle="重复文件名")

    def test_archive_without_theme_json_is_rejected(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("readme.txt", b"hi")
        data = base64.b64encode(buf.getvalue()).decode("ascii")
        ok, value = unwrap(asyncio.run(self.plugin.import_theme_archive(data=data)))
        self.assertFalse(ok)
        self.assertIn("theme.json", str(value))


class ArchiveImageTests(ArchiveCase):
    """图片引用：按魔数校验内容、按哈希落盘、缺图与坏引用要丢弃。"""

    def _ref_theme(self, ref: str) -> dict:
        # 带一个颜色变量：图片引用被丢弃后仍要有可用变量，否则 import 会以
        # 「没有可用的调色板变量」拒绝，测不到图片策略本身。
        return {
            "name": "图片边界",
            "vars": {"--nts-chat-bg": "#101820", "--nts-chat-bg-image": ref},
        }

    def _bg_files(self):
        return list((self.plugin.static_dir / "backgrounds").iterdir())

    def test_html_masquerading_as_jpg_is_rejected(self):
        self._must_err(self._ref_theme(img_ref("evil.jpg")), [("evil.jpg", HTML)], needle="不支持的图片格式")

    def test_oversized_image_is_rejected(self):
        extra = [("big.png", PNG + bytes(4 * 1024 * 1024))]
        self._must_err(self._ref_theme(img_ref("big.png")), extra, needle="图片过大")

    def test_missing_image_drops_the_reference(self):
        value = self._ok(self._ref_theme(img_ref("missing.png")))
        record = self._record(value["theme"]["id"])
        self.assertNotIn("--nts-chat-bg-image", record["vars"])
        self.assertEqual(self._bg_files(), [])

    def test_valid_image_is_stored_by_content_hash(self):
        value = self._ok(self._ref_theme(img_ref("good.png")), [("good.png", PNG)])
        record = self._record(value["theme"]["id"])
        ref = record["vars"]["--nts-chat-bg-image"]
        self.assertIn("/plugin/neko_theme_studio/ui/backgrounds/", ref)
        files = self._bg_files()
        self.assertEqual(len(files), 1)
        self.assertEqual(len(files[0].stem), 16)
        self.assertTrue(all(ch in "0123456789abcdef" for ch in files[0].stem))

    def test_javascript_reference_is_dropped(self):
        value = self._ok(self._ref_theme("javascript:alert(1)"))
        record = self._record(value["theme"]["id"])
        self.assertNotIn("--nts-chat-bg-image", record["vars"])

    def test_local_file_reference_is_dropped(self):
        ref = "url(" + Q2 + "file:///C:/Windows/win.ini" + Q2 + ")"
        value = self._ok(self._ref_theme(ref))
        record = self._record(value["theme"]["id"])
        self.assertNotIn("--nts-chat-bg-image", record["vars"])


if __name__ == "__main__":
    unittest.main()