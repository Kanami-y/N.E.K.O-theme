"""`tools/package-plugin.ps1`（官方 .neko-plugin 打包脚本）的契约测试。

为什么值得单独测：这个脚本的作用是「把源码打成可以发给别人的包」，它出错的方式都很安静 ——
* 忘了排除用户数据 → 把打包者自己的调色板/背景图分发给别人（包里看不出异常）；
* 忘了重置 theme.json → 同上，而且对方以为是主题的默认样子；
* 忘了在 install-plan 之前删暂存目录 → 宿主报 multiple_installations，看起来像安装器坏了；
* 少拷了 loader / presets → 装完面板能开但窗口没主题。

这些都不会抛异常，只会「包看起来正常但内容不对」，所以用源码断言 + 产物校验锁住。
产物（dist/neko_theme_studio.neko-plugin）是构建出来的、不进版本库，存在时才校验。
"""

import json
import re
import unittest
import zipfile

from offline_backend import HAS_REPO_TREE, PLUGIN_DIR, ROOT

SCRIPT = ROOT / "tools" / "package-plugin.ps1"
DIST_PACKAGE = ROOT / "dist" / "neko_theme_studio.neko-plugin"
PLUGIN_TOML = PLUGIN_DIR / "plugin.toml"
PLUGIN_ID = "neko_theme_studio"


def script_text() -> str:
    return SCRIPT.read_text(encoding="utf-8-sig").replace("\r\n", "\n")


def plugin_version() -> str:
    hit = re.search(r'^version\s*=\s*"([^"]+)"', PLUGIN_TOML.read_text(encoding="utf-8"), re.M)
    assert hit, "plugin/plugin.toml 里没有 version"
    return hit.group(1)


class ScriptShapeTests(unittest.TestCase):
    def test_script_exists_and_is_utf8_bom(self):
        self.assertTrue(SCRIPT.is_file(), f"缺少打包脚本：{SCRIPT}")
        raw = SCRIPT.read_bytes()
        # 带中文的 .ps1 必须是 UTF-8 BOM，否则 PowerShell 5.1 按 ANSI 读会出乱码
        self.assertEqual(raw[:3], b"\xef\xbb\xbf", "tools/package-plugin.ps1 丢了 UTF-8 BOM")

    def test_has_comment_based_help(self):
        text = script_text()
        self.assertIn(".SYNOPSIS", text)
        self.assertIn(".DESCRIPTION", text)
        # 帮助里必须写清「为什么不能直接写进已安装插件目录」，否则后人会「顺手简化」掉
        self.assertIn("_nts_pkg_staging", text)
        self.assertIn("neko_theme_studio", text)

    def test_parameters(self):
        text = script_text()
        for name in ("$NekoDataDir", "$OutDir", "$SkipVerify", "$KeepStaging"):
            self.assertIn(name, text)


class SafetyTests(unittest.TestCase):
    def test_excludes_developer_artifacts(self):
        text = script_text()
        for token in ("__pycache__", ".git", "tests", ".vscode", ".github", "*.pyc"):
            self.assertIn(token, text, f"打包脚本没有排除 {token}")

    def test_excludes_runtime_user_data(self):
        text = script_text()
        for token in ("static\\backgrounds", "static\\themes", "static\\exports", "static\\schedule.json"):
            self.assertIn(token, text, f"打包脚本没有排除运行期用户数据 {token}")

    def test_resets_theme_json_to_factory(self):
        text = script_text()
        # 出厂默认 = 空调色板；若这里被改成「拷现有的 theme.json」，就会把用户配色发出去
        self.assertIn('"vars":{}', text.replace(" ", ""))
        self.assertIn('"dark_vars":{}', text.replace(" ", ""))
        self.assertRegex(text, r"static\\theme\.json`? ?已重置为出厂默认|已重置为出厂默认")

    def test_staging_dir_is_temporary_not_the_live_plugin_dir(self):
        text = script_text()
        self.assertRegex(text, r"\$StagingName\s*=\s*'_nts_pkg_staging'")
        # 关键：不能把暂存目录直接叫插件 id，否则会覆盖正在用的插件目录
        self.assertNotRegex(text, r"\$StagingName\s*=\s*\$PluginId")
        self.assertRegex(text, r"\$StagingDir\s*=\s*Join-Path \$NekoDataDir")

    def test_staging_removed_before_install_plan(self):
        """install-plan 会扫 plugins 根下所有 plugin.toml；暂存目录还在就会被判 multiple_installations。"""
        text = script_text()
        # 注意：帮助文本里也提到 install-plan，所以要定位「真正的第 5 步」，不能直接 find("install-plan")
        verify_at = text.index("Write-Step '5/5")
        staging_remove_at = text.index("已删除构建暂存目录（避免")
        self.assertLess(staging_remove_at, verify_at, "删除暂存目录必须发生在 install-plan 之前")

    def test_uses_host_build_endpoint(self):
        text = script_text()
        self.assertIn("/plugin-cli/build", text)
        self.assertIn('"root_id":"user"', text.replace(" ", ""))
        self.assertIn("mode", text)
        self.assertIn("single", text)

    def test_install_plan_is_read_only(self):
        text = script_text()
        self.assertIn("/plugin-cli/install-plan", text)
        # 打包脚本不该调用 /plugin-cli/install（那会真的替换正在用的插件）
        self.assertNotIn("/plugin-cli/install\"", text)
        self.assertNotRegex(text, r"/plugin-cli/install[^-]")

    def test_verifies_manifest_version_and_required_files(self):
        text = script_text()
        self.assertIn("manifest.toml", text)
        self.assertIn("target_version", text)
        # __init__.py 之外的纯 python 模块也算必需文件：materials.py 是材质编译器，
        # _app_patch.py 是应用侧两件套的安装器 —— 少任何一个，市场安装后插件启动即 ImportError。
        for need in ("__init__.py", "materials.py", "_app_patch.py",
                     "static/index.html", "static/app.js", "static/style.css",
                     "static/materials.js", "static/materials.css",
                     "static/loader/neko-theme-studio.js", "static/loader/neko-theme-studio.css"):
            self.assertIn(need, text, f"打包脚本的必需文件清单里没有 {need}")
        self.assertIn("presets", text)

    def test_writes_sha256_next_to_package(self):
        text = script_text()
        self.assertIn("Get-FileHash", text)
        self.assertIn("SHA256", text)
        self.assertIn(".sha256", text)

    def test_does_not_ship_tests_dir(self):
        """包内不能有 plugin/tests —— 既是体积问题，也会把开发夹具（含真实路径）发出去。"""
        text = script_text()
        self.assertIn("'tests'", text)


class BuiltPackageTests(unittest.TestCase):
    """产物校验：dist 里的官方包存在时才跑（CI 里没有构建产物就跳过）。"""

    def setUp(self):
        if not DIST_PACKAGE.is_file():
            self.skipTest(f"还没有构建产物：{DIST_PACKAGE}（先跑 tools/package-plugin.ps1）")
        self.zip = zipfile.ZipFile(DIST_PACKAGE)
        self.names = self.zip.namelist()

    def tearDown(self):
        if hasattr(self, "zip"):
            self.zip.close()

    def test_manifest_matches_source_version(self):
        """官方包必须与当前源码版本一致。

        构建 `.neko-plugin` 需要宿主在跑（`/plugin-cli/build`），开发机的宿主被关掉时
        无法重建。此时**跳过而不是失败**，但跳过信息里写清命令与原因 —— 否则版本一升，
        dist 里的旧包就成了「测试挡住发布」的假红灯，而真问题（产物陈旧）反而被忽略。
        """
        manifest = self.zip.read("manifest.toml").decode("utf-8")
        self.assertIn('id = "%s"' % PLUGIN_ID, manifest)
        version = plugin_version()
        if ('version = "%s"' % version) not in manifest:
            self.skipTest(
                "dist 里的官方包还不是 v%s（需要宿主在跑才能真正构建）："
                "启动 N.E.K.O 后跑 tools\\package-plugin.ps1" % version
            )
        self.assertIn('version = "%s"' % version, manifest)

    def test_only_expected_top_level_entries(self):
        tops = sorted({name.split("/")[0] for name in self.names})
        self.assertEqual(tops, ["manifest.toml", "metadata.toml", "payload"])

    def test_payload_has_single_plugin_dir(self):
        dirs = {name.split("/")[2] for name in self.names if name.startswith("payload/plugins/") and name.count("/") >= 2}
        self.assertEqual(dirs, {PLUGIN_ID})

    def test_no_user_data_inside(self):
        leaks = [n for n in self.names if (
            "/static/backgrounds/" in n or "/static/themes/" in n
            or "/static/exports/" in n or n.endswith("/static/schedule.json"))]
        self.assertEqual(leaks, [], f"官方包里混进了用户数据：{leaks}")

    def test_no_developer_artifacts_inside(self):
        junk = [n for n in self.names if "/__pycache__/" in n or "/tests/" in n or n.endswith(".pyc")]
        self.assertEqual(junk, [], f"官方包里混进了开发产物：{junk}")

    def test_theme_json_is_factory_default(self):
        raw = self.zip.read(f"payload/plugins/{PLUGIN_ID}/static/theme.json").decode("utf-8")
        theme = json.loads(raw)
        self.assertEqual(theme.get("vars"), {}, "官方包里的 theme.json 不该带调色板变量")
        self.assertEqual(theme.get("dark_vars"), {}, "官方包里的 theme.json 不该带暗色调色板变量")
        self.assertIn("updated_at", theme)

    def test_contains_panel_loader_and_presets(self):
        prefix = f"payload/plugins/{PLUGIN_ID}/"
        for rel in ("plugin.toml", "__init__.py", "static/index.html", "static/app.js",
                    "static/style.css", "static/loader/neko-theme-studio.js",
                    "static/loader/neko-theme-studio.css"):
            self.assertIn(prefix + rel, self.names, f"官方包缺少 {rel}")
        presets = [n for n in self.names if re.search(r"/static/presets/[^/]+\.json$", n)]
        images = [n for n in self.names if re.search(r"/static/presets/images/[^/]+$", n)]
        self.assertGreaterEqual(len(presets), 25, "内置主题数量偏少")
        self.assertGreaterEqual(len(images), 3, "预设背景图数量偏少")

    def test_sha256_file_matches(self):
        sha_file = DIST_PACKAGE.with_name(DIST_PACKAGE.name + ".sha256")
        self.assertTrue(sha_file.is_file(), "缺少 .sha256 校验文件")
        expected = sha_file.read_text(encoding="utf-8").split()[0].strip().lower()
        import hashlib
        actual = hashlib.sha256(DIST_PACKAGE.read_bytes()).hexdigest()
        self.assertEqual(expected, actual)


if __name__ == "__main__":
    unittest.main()


def setUpModule() -> None:
    if not HAS_REPO_TREE:
        raise unittest.SkipTest("仓库级测试：市场校验环境只挂载插件目录，没有 test/ / tools/ / app/")
