"""主题库「备份全部 / 恢复备份」（v0.4.16）的离线测试。

为什么值得测：

1. **备份包要能换台机器恢复**：包里绝不能留本机绝对地址
   （``/plugin/neko_theme_studio/ui/backgrounds/…``），必须是可移植的
   ``url("images/<name>")``；否则「备份」只是看起来像备份。
2. **恢复只新增、不覆盖**：用户点「恢复备份」的典型场景是重装后把老库拿回来，
   这时仓库里可能已经有同名主题；正确行为是各存一份，而不是静默顶掉新的。
3. **单条坏掉不能毁掉整包**：手改坏一条 JSON 是常事，其余几十套必须照样导入。
4. **备份包是别人给的文件**：按不可信输入处理 —— 体积、条目数、解压上限、
   坏 zip、base64 非法，全都要给出可读错误而不是抛 traceback。

跑法（无需宿主 SDK、无需 pytest）：
    python -m unittest discover -s plugin/tests -v
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from offline_backend import ROOT, load_backend

NS = load_backend()
SdkError = NS["SdkError"]
NekoThemeStudioPlugin = NS["NekoThemeStudioPlugin"]
LIBRARY_ARCHIVE_FORMAT = NS["LIBRARY_ARCHIVE_FORMAT"]

BACKEND = (ROOT / "plugin" / "__init__.py").read_text(encoding="utf-8-sig")

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 48


def make_plugin(tmp: Path):
    """不走 __init__（它要宿主 ctx 与文件日志）：直接造一个只看 static_dir 的实例。"""
    plugin = object.__new__(NekoThemeStudioPlugin)
    plugin.plugin_root = tmp
    plugin.static_dir = tmp / "static"
    for sub in ("presets", "themes", "backgrounds"):
        (plugin.static_dir / sub).mkdir(parents=True, exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.plugin_id = "neko_theme_studio"
    plugin.logger = None
    return plugin


def local_image(name: str) -> str:
    return f'url("/plugin/neko_theme_studio/ui/backgrounds/{name}")'


def add_theme(
    tmp: Path,
    theme_id: str,
    *,
    name: str,
    with_image: bool = False,
    note: str = "",
    tags: list | None = None,
    image_name: str = "",
) -> None:
    """往仓库里放一套主题；``with_image=True`` 时同时落一张真图片（引用本机绝对地址）。"""
    variables = {
        "--nts-accent": "#7fb8ff",
        "--nts-panel-bg": "rgba(12, 16, 28, 0.72)",
        "--nts-text": "#e8eefc",
    }
    dark = {"--nts-accent": "#9fc8ff", "--nts-panel-bg": "rgba(8, 10, 18, 0.8)"}
    if with_image:
        filename = image_name or f"{hashlib.sha256(PNG).hexdigest()[:16]}.png"
        (tmp / "static" / "backgrounds" / filename).write_bytes(PNG)
        variables["--nts-chat-bg-image"] = local_image(filename)
    record = {
        "schema": 1,
        "id": theme_id,
        "name": name,
        "saved_at": "2026-11-19T09:00:00+08:00",
        "vars": variables,
        "dark_vars": dark,
    }
    if note:
        record["note"] = note
    if tags:
        record["tags"] = tags
    (tmp / "static" / "themes" / f"{theme_id}.json").write_text(
        json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def unwrap(result) -> tuple:
    """entry 一律返回 Ok/Err；返回 ``(成功?, 值或 SdkError)``。"""
    value = result.value
    if isinstance(value, SdkError):
        return False, value
    return True, value


def must_err(testcase, result, needle: str = "") -> SdkError:
    ok, value = unwrap(result)
    testcase.assertFalse(ok, f"期望失败，实际成功：{value!r}")
    testcase.assertIsInstance(value, SdkError)
    if needle:
        testcase.assertIn(needle, str(value))
    return value


def import_payload(plugin, payload: bytes):
    data = base64.b64encode(payload).decode("ascii")
    result = asyncio.run(plugin.import_library(filename="backup.zip", data=data))
    ok, value = unwrap(result)
    if not ok:
        raise value
    return value


class BuildTests(unittest.TestCase):
    def test_empty_library_refuses(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            with self.assertRaises(SdkError) as ctx:
                plugin._build_library_archive()
            self.assertIn("没有什么可备份", str(ctx.exception))

    def test_archive_layout(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "seaside-1", name="海边", with_image=True)
            add_theme(tmp, "warm-2", name="暖阳", note="皮肤偏暖", tags=["warm"])
            filename, payload, count = plugin._build_library_archive()
            self.assertTrue(filename.startswith("neko-theme-studio-library-"))
            self.assertTrue(filename.endswith(".zip"))
            self.assertEqual(count, 2)
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                names = archive.namelist()
                self.assertIn("manifest.json", names)
                self.assertIn("README.txt", names)
                self.assertIn("themes/seaside-1.json", names)
                self.assertIn("themes/warm-2.json", names)
                # 图片跟着进包
                self.assertTrue(any(n.startswith("images/") for n in names))
                manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
                seaside = json.loads(
                    archive.read("themes/seaside-1.json").decode("utf-8")
                )
                warm = json.loads(archive.read("themes/warm-2.json").decode("utf-8"))
            self.assertEqual(manifest["format"], LIBRARY_ARCHIVE_FORMAT)
            self.assertEqual(len(manifest["themes"]), 2)
            by_id = {item["id"]: item for item in manifest["themes"]}
            self.assertTrue(by_id["seaside-1"]["has_image"])
            self.assertFalse(by_id["warm-2"]["has_image"])
            # 可移植性：绝不能把本机路径写进备份包
            for doc in (seaside, warm):
                blob = json.dumps(doc, ensure_ascii=False)
                self.assertNotIn("/plugin/", blob)
                self.assertNotIn("backgrounds/", blob)
                self.assertNotIn("C:", blob)
            self.assertTrue(seaside["vars"]["--nts-chat-bg-image"].startswith('url("images/'))
            self.assertEqual(warm.get("note"), "皮肤偏暖")
            self.assertEqual(warm.get("tags"), ["warm"])

    def test_broken_entry_is_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "good-1", name="好的")
            (tmp / "static" / "themes" / "broken.json").write_text(
                "{ not json", encoding="utf-8"
            )
            (tmp / "static" / "themes" / "empty.json").write_text(
                json.dumps({"id": "empty", "name": "空"}), encoding="utf-8"
            )
            filename, payload, count = plugin._build_library_archive()
            self.assertEqual(count, 1)
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                self.assertIn("themes/good-1.json", archive.namelist())
                self.assertNotIn("themes/broken.json", archive.namelist())

    def test_illegal_id_falls_back_to_filename(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "ok-1", name="正常")
            (tmp / "static" / "themes" / "legacy-7.json").write_text(
                json.dumps(
                    {
                        "id": "../../etc/passwd",
                        "name": "坏 id",
                        "vars": {"--nts-accent": "#fff"},
                        "dark_vars": {},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            _, payload, count = plugin._build_library_archive()
            self.assertEqual(count, 2)
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                self.assertIn("themes/legacy-7.json", archive.namelist())


class ImportTests(unittest.TestCase):
    def _round_trip(self, source_steps) -> tuple[Path, Path, dict]:
        src_td = tempfile.TemporaryDirectory()
        dst_td = tempfile.TemporaryDirectory()
        self.addCleanup(src_td.cleanup)
        self.addCleanup(dst_td.cleanup)
        src = Path(src_td.name)
        dst = Path(dst_td.name)
        source = make_plugin(src)
        source_steps(src)
        _, payload, _ = source._build_library_archive()
        target = make_plugin(dst)
        result = import_payload(target, payload)
        return src, dst, result

    def test_round_trip_restores_themes(self):
        def fill(tmp):
            add_theme(tmp, "seaside-1", name="海边", with_image=True)
            add_theme(tmp, "warm-2", name="暖阳", note="皮肤偏暖", tags=["warm"])

        _, dst, result = self._round_trip(fill)
        self.assertEqual(result["imported"], 2)
        self.assertEqual(result["skipped"], [])
        names = sorted(item["name"] for item in result["themes"])
        self.assertEqual(names, ["暖阳", "海边"])
        files = sorted(p.name for p in (dst / "static" / "themes").glob("*.json"))
        self.assertEqual(len(files), 2)

    def test_round_trip_restores_image_locally(self):
        def fill(tmp):
            add_theme(tmp, "seaside-1", name="海边", with_image=True)

        _, dst, result = self._round_trip(fill)
        self.assertEqual(result["imported"], 1)
        backgrounds = list((dst / "static" / "backgrounds").glob("*.png"))
        self.assertEqual(len(backgrounds), 1)
        record = json.loads(
            next((dst / "static" / "themes").glob("*.json")).read_text(encoding="utf-8")
        )
        value = record["vars"]["--nts-chat-bg-image"]
        # 恢复后必须是这台机器上的绝对 URL，而不是包里的 images/xxx
        self.assertIn("/ui/backgrounds/", value)
        self.assertNotIn('url("images/', value)

    def test_existing_theme_is_not_overwritten(self):
        src_td = tempfile.TemporaryDirectory()
        dst_td = tempfile.TemporaryDirectory()
        self.addCleanup(src_td.cleanup)
        self.addCleanup(dst_td.cleanup)
        src, dst = Path(src_td.name), Path(dst_td.name)
        target = make_plugin(dst)  # 先建好 static/ 子目录，再往里放主题
        add_theme(dst, "seaside-1", name="海边")  # 目标机已有同名主题
        before = (dst / "static" / "themes" / "seaside-1.json").read_text(
            encoding="utf-8"
        )
        source = make_plugin(src)
        add_theme(src, "seaside-1", name="海边")
        _, payload, _ = source._build_library_archive()
        result = import_payload(target, payload)
        self.assertEqual(result["imported"], 1)
        after = (dst / "static" / "themes" / "seaside-1.json").read_text(
            encoding="utf-8"
        )
        self.assertEqual(before, after, "原有的那套不许被覆盖")
        self.assertEqual(len(list((dst / "static" / "themes").glob("*.json"))), 2)

    def test_broken_entry_does_not_kill_the_rest(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("themes/ok.json", json.dumps({
                    "name": "好的",
                    "vars": {"--nts-accent": "#7fb8ff"},
                    "dark_vars": {"--nts-accent": "#9fc8ff"},
                }, ensure_ascii=False))
                archive.writestr("themes/broken.json", "{ nope")
                archive.writestr("themes/notheme.json", json.dumps(["x"]))
            result = import_payload(plugin, buffer.getvalue())
            self.assertEqual(result["imported"], 1)
            reasons = " ".join(item["reason"] for item in result["skipped"])
            self.assertIn("不是合法 JSON", reasons)
            self.assertIn("不是主题对象", reasons)

    def test_all_failed_reports_first_reason(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("themes/empty.json", json.dumps({"name": "空"}))
            must_err(self, asyncio.run(plugin.import_library(data=base64.b64encode(buffer.getvalue()).decode("ascii"))), "都没能导入")

    def test_bad_zip_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, asyncio.run(plugin.import_library(data=base64.b64encode(b"not a zip at all").decode("ascii"))), "不是有效的 zip")

    def test_no_themes_in_zip_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", "{}")
                archive.writestr("README.txt", "hi")
            must_err(self, asyncio.run(plugin.import_library(data=base64.b64encode(buffer.getvalue()).decode("ascii"))), "没有任何主题")

    def test_bad_base64_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, asyncio.run(plugin.import_library(data="这不是 base64!!")), "base64")

    def test_empty_data_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, asyncio.run(plugin.import_library(data="")), "为空")

    def test_too_many_entries_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                for i in range(6):
                    archive.writestr(f"themes/t{i}.json", "{}")
            globals_ = NekoThemeStudioPlugin._parse_library_archive.__globals__
            original = globals_["ARCHIVE_MAX_ENTRIES"]
            globals_["ARCHIVE_MAX_ENTRIES"] = 3
            try:
                must_err(self, asyncio.run(plugin.import_library(data=base64.b64encode(buffer.getvalue()).decode("ascii"))), "条目过多")
            finally:
                globals_["ARCHIVE_MAX_ENTRIES"] = original

    def test_oversized_archive_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            buffer = io.BytesIO()
            # 造一条「解压后」明显超限的条目（file_size 求和后才判定，所以内容必须真大）
            big = json.dumps({"name": "大的", "vars": {"--nts-pad": "x" * 4096}})
            with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("themes/a.json", big)
            globals_ = NekoThemeStudioPlugin._parse_library_archive.__globals__
            original = globals_["ARCHIVE_MAX_UNCOMPRESSED"]
            globals_["ARCHIVE_MAX_UNCOMPRESSED"] = 10
            try:
                must_err(self, asyncio.run(plugin.import_library(data=base64.b64encode(buffer.getvalue()).decode("ascii"))), "解压后过大")
            finally:
                globals_["ARCHIVE_MAX_UNCOMPRESSED"] = original


class ExportToFileTests(unittest.TestCase):
    def test_library_kind_writes_file(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            add_theme(tmp, "one-1", name="一套")
            ok, result = unwrap(
                asyncio.run(plugin.export_to_file(kind="library", target="plugin"))
            )
            self.assertTrue(ok, f"导出失败：{result}")
            self.assertTrue(result["path"].endswith(".zip"))
            self.assertEqual(result["kind"], "library")
            self.assertEqual(result["themes"], 1)
            path = Path(result["path"])
            self.assertTrue(path.is_file())
            self.assertEqual(path.stat().st_size, result["bytes"])
            with zipfile.ZipFile(path) as archive:
                self.assertIn("manifest.json", archive.namelist())

    def test_library_kind_empty_library_errors(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, asyncio.run(plugin.export_to_file(kind="library", target="plugin")), "没有什么可备份")

    def test_unknown_kind_names_library(self):
        with tempfile.TemporaryDirectory() as td:
            plugin = make_plugin(Path(td))
            must_err(self, asyncio.run(plugin.export_to_file(kind="bogus", target="plugin")), "library")


class UniquePathTests(unittest.TestCase):
    """导出文件名：长名字被截断时，扩展名不能跟着丢。"""

    def test_long_zip_name_keeps_extension(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            out = tmp / "exports"
            out.mkdir()
            path = plugin._unique_path(out, "neko-theme-studio-library-20261119095928.zip")
            self.assertEqual(path.suffix, ".zip", f"扩展名被截掉了：{path.name}")
            self.assertLessEqual(len(path.name), 48)

    def test_duplicate_gets_numeric_suffix_and_keeps_extension(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            out = tmp / "exports"
            out.mkdir()
            first = plugin._unique_path(out, "a" * 60 + ".json")
            first.write_text("{}", encoding="utf-8")
            second = plugin._unique_path(out, "a" * 60 + ".json")
            self.assertEqual(second.suffix, ".json")
            self.assertNotEqual(first, second)


class WiringTests(unittest.TestCase):
    def test_entry_and_actions_registered(self):
        self.assertIn('id="import_library"', BACKEND)
        self.assertIn('"id": "import_library", "entry_id": "import_library"', BACKEND)
        self.assertIn('"library"', BACKEND)
        self.assertIn("LIBRARY_ARCHIVE_FORMAT", BACKEND)

    def test_restore_does_not_delete_or_overwrite(self):
        """恢复路径里不许出现删主题/覆盖写主题的调用。"""
        start = BACKEND.index("    async def import_library(")
        body = BACKEND[start : start + 4200]
        self.assertIn("_save_library_item(", body)
        self.assertNotIn("unlink(", body)
        self.assertNotIn("write_text(", body)
        self.assertNotIn("delete_theme", body)

    def test_description_says_add_only(self):
        start = BACKEND.index('id="import_library"')
        block = BACKEND[start : start + 700]
        self.assertIn("不覆盖", block)


if __name__ == "__main__":
    unittest.main()


class PanelWiringTests(unittest.TestCase):
    """面板侧接线：按钮在、走对 entry、坏条目不静默。"""

    APP = (ROOT / "plugin" / "static" / "app.js").read_text(encoding="utf-8")
    HTML = (ROOT / "plugin" / "static" / "index.html").read_text(encoding="utf-8-sig")

    def test_buttons_exist(self):
        self.assertIn('id="btn-lib-backup"', self.HTML)
        self.assertIn('id="btn-lib-restore"', self.HTML)
        self.assertIn('id="lib-backup-file"', self.HTML)

    def test_backup_goes_through_export_to_file(self):
        self.assertIn("saveThemeFile({ kind: 'library', target: 'desktop' })", self.APP)

    def test_restore_goes_through_import_library(self):
        self.assertIn("callPlugin('import_library', {", self.APP)
        self.assertIn("data: base64", self.APP)

    def test_restore_reports_skipped(self):
        self.assertIn("skipped.length", self.APP)
        self.assertIn("没能恢复", self.APP)

    def test_no_dev_absolute_paths_leak_into_panel(self):
        self.assertNotIn("D:\\be", self.APP)


class WriteLockTests(unittest.TestCase):
    """写锁必须可重入；save_theme 不许自己在外面再套一层。

    真踩过：``save_theme`` 先 ``with _WRITE_LOCK`` 再调 ``_save_library_item``
    （内部同样持锁）→ 非重入 Lock 同线程二次加锁 → 永久阻塞。表现不是报错，
    而是点「保存」后整个插件的 entry 队列全挂、每条都 30s TIMEOUT。
    """

    def test_write_lock_is_reentrant(self):
        import threading

        lock = NS["_WRITE_LOCK"]
        self.assertIsInstance(lock, type(threading.RLock()),
                              "写锁必须是 RLock，否则嵌套加锁会自死锁")

    def test_save_theme_does_not_nest_the_lock(self):
        self.assertNotIn("with _WRITE_LOCK:", BACKEND[
            BACKEND.index("async def save_theme"):BACKEND.index("async def save_theme") + 1200
        ], "save_theme 不应再套一层 _WRITE_LOCK（_save_library_item 内部已持锁）")

    def test_save_theme_completes(self):
        """在独立线程里跑真 entry，5 秒内必须有结果（死锁会一直没结果）。"""
        import threading

        done = []
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)
            # 空调色板现在会被 save_theme 拒绝（空条目守卫），这里先落一个真实变量，
            # 本用例只关心「save_theme 会不会自死锁」。
            plugin._write_unlocked(
                plugin._normalize({"vars": {"--nts-accent": "#123456"}})
            )

            def run():
                done.append(asyncio.run(plugin.save_theme(name="锁测试")))

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(5.0)
            self.assertFalse(worker.is_alive(), "save_theme 5 秒没返回：写锁又自死锁了")
            ok, value = unwrap(done[0])
            self.assertTrue(ok, f"save_theme 失败：{value}")
            self.assertTrue((tmp / "static" / "themes").is_dir())

    def test_nested_acquire_does_not_block(self):
        import threading

        lock = NS["_WRITE_LOCK"]
        done = []
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            plugin = make_plugin(tmp)

            def run():
                with lock:
                    done.append(plugin._save_library_item(
                        name="嵌套", vars_map={"--nts-text": "#fff"}, dark_map={}
                    ))

            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            worker.join(5.0)
            self.assertFalse(worker.is_alive(), "持锁时再调持锁函数被永久阻塞")
            self.assertEqual(len(done), 1)
