"""Round 30：theme.json 的资源指纹（css_sha8 / loader_version）与加载器零下载判断。

为什么要这组测试：加载器的两个自愈动作以前都是「先整份下载，再判断要不要动作」——
15s 一次下载 158KB CSS 只为比签名、60s 一次下载 126KB JS 只为正则读一行版本号。
现在 theme.json 里带上两枚指纹，加载器零下载就能判断。风险点有三个，都在这里钉住：

1. 指纹必须是**磁盘上真实文件**的哈希 / 版本号（算错 → 加载器永远认为页面是旧的，
   换表/reload 循环）。
2. 文件缺失时必须是空字符串（退回旧的下载路径），不能编假指纹、也不能抛异常。
3. 加载器里「零下载」分支必须真的在下载之前返回，且不能把旧的下载路径删掉 ——
   用户可能正在跑旧版插件（theme.json 没有这两个字段）。
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from offline_backend import HAS_REPO_TREE, PLUGIN_DIR, load_backend  # noqa: E402
from offline_backend import ROOT as REPO_ROOT

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]

LOADER_DIR = PLUGIN_DIR / "static" / "loader"
CSS_BYTES = (LOADER_DIR / "neko-theme-studio.css").read_bytes()
JS_TEXT = (LOADER_DIR / "neko-theme-studio.js").read_text(encoding="utf-8")
CSS8 = hashlib.sha256(CSS_BYTES).hexdigest()[:8]
JS_VER = re.search(r"var SCRIPT_VERSION = '(\d+\.\d+\.\d+)';", JS_TEXT).group(1)


def make_plugin(root: Path) -> Plugin:
    plugin = object.__new__(Plugin)
    plugin.plugin_root = root
    plugin.static_dir = root / "static"
    plugin.static_dir.mkdir(parents=True, exist_ok=True)
    (plugin.static_dir / "themes").mkdir(exist_ok=True)
    plugin.theme_path = plugin.static_dir / "theme.json"
    plugin.logger = None
    return plugin


def install_loader_files(plugin: Plugin) -> None:
    target = plugin.static_dir / "loader"
    target.mkdir(parents=True, exist_ok=True)
    (target / "neko-theme-studio.css").write_bytes(CSS_BYTES)
    (target / "neko-theme-studio.js").write_text(JS_TEXT, encoding="utf-8")


class AssetMetaTests(unittest.TestCase):
    """后端算指纹。"""

    def test_matches_disk_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            install_loader_files(plugin)
            meta = plugin._asset_meta()
            self.assertEqual(meta["css_sha8"], CSS8)
            self.assertEqual(meta["loader_version"], JS_VER)
            # 再调一次走缓存，结果必须一致（缓存键是 mtime+size）。
            self.assertEqual(plugin._asset_meta(), meta)

    def test_missing_files_yield_empty_strings(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            meta = plugin._asset_meta()
            self.assertEqual(meta, {"css_sha8": "", "loader_version": ""})

    def test_with_asset_meta_copies(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            install_loader_files(plugin)
            palette = {"name": "t", "enabled": True, "vars": {}, "dark_vars": {}}
            payload = plugin._with_asset_meta(palette)
            self.assertEqual(payload["css_sha8"], CSS8)
            self.assertEqual(payload["loader_version"], JS_VER)
            self.assertIsNot(payload, palette)
            self.assertNotIn("css_sha8", palette, "不能污染调用方的调色板对象")

    def test_write_includes_meta_and_read_ignores_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            install_loader_files(plugin)
            palette = {
                "schema": 1,
                "name": "指纹测试",
                "enabled": True,
                "updated_at": "2026-11-19T00:00:00+00:00",
                "vars": {"--nts-font-size": "14px"},
                "dark_vars": {"--nts-font-size": "14px"},
            }
            plugin._write_unlocked(palette)
            on_disk = json.loads(plugin.theme_path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["css_sha8"], CSS8)
            self.assertEqual(on_disk["loader_version"], JS_VER)
            # 读回来只保留契约字段：指纹不能混进 vars / dark_vars，也不能被当成变量。
            read_back = plugin._read_unlocked(strict=True)
            self.assertEqual(
                set(read_back),
                {"schema", "name", "enabled", "updated_at", "vars", "dark_vars", "materials"},
            )
            self.assertEqual(read_back["vars"], {"--nts-font-size": "14px"})

    def test_corrupt_loader_js_has_no_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = make_plugin(Path(tmp))
            install_loader_files(plugin)
            (plugin.static_dir / "loader" / "neko-theme-studio.js").write_text("// broken", encoding="utf-8")
            meta = plugin._asset_meta()
            self.assertEqual(meta["loader_version"], "")
            self.assertEqual(meta["css_sha8"], CSS8, "CSS 指纹与 JS 是否可解析无关")


class LoaderZeroDownloadTests(unittest.TestCase):
    """加载器侧的接线与顺序（纯静态检查：这段代码在浏览器里才跑）。"""

    def test_meta_remembered_from_palette(self):
        self.assertIn("function rememberAssetMeta(p) {", JS_TEXT)
        self.assertIn("rememberAssetMeta(p);", JS_TEXT)
        # 必须在 raw 比对之前记：否则 raw 不变时提前 return，字段永远不更新。
        self.assertLess(JS_TEXT.index("rememberAssetMeta(p);"), JS_TEXT.index("if (!force && raw === lastRaw)"))

    def test_stylesheet_uses_hash_without_fetch(self):
        start = JS_TEXT.index("function refreshStaleStylesheet(")
        end = JS_TEXT.index("function reloadForUpgrade(")
        body = JS_TEXT[start:end]
        self.assertIn("if (assetMeta.css8) {", body)
        self.assertIn("readSheetHash(href)", body)
        # 零下载分支必须在 fetch 之前，且要真的 return。
        meta_at = body.index("if (assetMeta.css8) {")
        fetch_at = body.index("fetch(abs,")
        self.assertLess(meta_at, fetch_at, "指纹判断必须排在下载之前")
        segment = body[meta_at:fetch_at]
        self.assertIn("return;", segment, "hash 命中时必须直接返回，不能继续往里走")
        # 换表只改 hash 段（不下载 CSS 再解析）。
        self.assertIn("swapped !== href", body)
        # 旧模板（href 里没有 hash 段）仍要走老的下载+签名比对：fetch 不能被删。
        self.assertIn("probe.replaceSync(css)", body)

    def test_upgrade_uses_version_without_fetch(self):
        start = JS_TEXT.index("function selfUpgradeIfNeeded(")
        end = JS_TEXT.index("function currentMode(")
        body = JS_TEXT[start:end]
        self.assertIn("if (assetMeta.loaderVersion && assetMeta.loaderVersion === SCRIPT_VERSION) return;", body)
        self.assertIn("reloadForUpgrade(assetMeta.loaderVersion, now);", body)
        # 下载路径必须保留（旧版插件没有字段）。
        self.assertIn("fetch(url, { cache: 'reload'", body)
        self.assertIn(r"/SCRIPT_VERSION\s*=\s*'([^']+)'/", body)
        # 守卫（草稿/流式让路 + 落盘顺序）在共享函数里，两条路径都经过它。
        self.assertIn("function reloadForUpgrade(remote, now) {", JS_TEXT)

    def test_guard_still_before_reload(self):
        start = JS_TEXT.index("function reloadForUpgrade(")
        end = JS_TEXT.index("function selfUpgradeIfNeeded(")
        body = JS_TEXT[start:end]
        self.assertLess(body.index("self-upgrade deferred"), body.index("SELF_UPGRADE_GUARD_KEY, SCRIPT_VERSION"))
        self.assertLess(body.index("SELF_UPGRADE_GUARD_KEY, SCRIPT_VERSION"), body.index("window.location.reload()"))

    def test_version_and_mirrors(self):
        version = tuple(int(x) for x in JS_VER.split("."))
        self.assertGreaterEqual(version, (1, 5, 25), "零下载判断是 1.5.25 引入的")
        mirrors = [
            REPO_ROOT / "app" / "neko-theme-studio.js",
            REPO_ROOT / "app-patch" / "files" / "neko-theme-studio.js",
        ]
        for mirror in mirrors:
            self.assertEqual(mirror.read_bytes(), (LOADER_DIR / "neko-theme-studio.js").read_bytes(),
                             f"{mirror} 没同步（改完 loader 要跑 tools/sync-assets.js）")


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
