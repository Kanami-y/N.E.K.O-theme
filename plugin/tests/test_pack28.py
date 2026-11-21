"""安装/打包侧的 Round 28 回归断言（audit28-pack 的 P0-A / P0-B / P1-E / P1-G）。

这些是**静态**断言：PowerShell 脚本不方便在单测里真跑（会改宿主机），但下面几件事
每一条都是「改一行就静默坏掉、且只有装到纯净机器上才会暴露」的：

* P0-A 两件套的源必须来自插件自带 loader，而不是发布包里根本没有的 `app\\` 镜像。
* P0-B 启动插件后必须**等**异步自愈补齐页面标记，否则纯净机器首装必失败。
* P1-E `-PurgeStaging` 必须先把插件本体（全部主题数据）备份走，失败就不删。
* P1-G 发布物与源码要有可执行的对账脚本（`tools/check-dist-sync.ps1`）。
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INSTALL = ROOT / "install.ps1"
UNINSTALL = ROOT / "uninstall.ps1"
PACKAGE_DIST = ROOT / "tools" / "package-dist.ps1"
CHECK_SYNC = ROOT / "tools" / "check-dist-sync.ps1"


class InstallSideTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = INSTALL.read_text(encoding="utf-8-sig")

    def test_bom_is_preserved(self) -> None:
        self.assertTrue(INSTALL.read_bytes().startswith(b"\xef\xbb\xbf"), "install.ps1 必须保留 UTF-8 BOM（PS 5.1 中文）")

    # -------------------------------------------------------------- P0-A
    def test_assets_come_from_plugin_loader(self) -> None:
        self.assertIn(r"$AssetCssSrc      = Join-Path $ThemeRoot 'plugin\static\loader\neko-theme-studio.css'", self.text)
        self.assertIn(r"$AssetJsSrc       = Join-Path $ThemeRoot 'plugin\static\loader\neko-theme-studio.js'", self.text)

    def test_no_app_mirror_source(self) -> None:
        self.assertNotIn(r"'app\css\neko-theme-studio.css'", self.text)
        self.assertNotIn(r"'app\neko-theme-studio.js'", self.text)

    def test_missing_asset_fails_before_writing(self) -> None:
        self.assertIn("throw (\"缺少 loader 源文件", self.text)
        guard_at = self.text.index("throw (\"缺少 loader 源文件")
        # 守卫必须排在任何写操作之前。注意函数定义都在脚本前部，所以拿「C 段开始」
        # （真正开始复制文件的那一段）而不是函数声明来比。
        first_write = self.text.index("Write-Head 'C. 复制应用侧两件套到 static")
        self.assertLess(guard_at, first_write, "fail-fast 必须发生在改模板/动用户数据之前")

    # -------------------------------------------------------------- P0-B
    def test_waits_for_plugin_self_heal(self) -> None:
        self.assertIn("function Wait-NtsTemplatePropagation {", self.text)
        self.assertIn("Wait-NtsTemplatePropagation -Targets $propTargets -TimeoutSeconds 45", self.text)
        self.assertIn("F7c：等插件异步自愈把全部页面的标记补齐", self.text)

    def test_wait_checks_markers_and_hashes(self) -> None:
        body = self.text[self.text.index("function Wait-NtsTemplatePropagation {"):]
        body = body[:body.index("function Invoke-Verification {")]
        self.assertIn("Get-NtsMarkerCounts -Text $pr.Text", body)
        self.assertIn("$pr.Text.Contains($JinjaSentinel + '-' + $AssetCssHash8)", body)
        self.assertIn("Start-Sleep -Milliseconds 700", body)


class UninstallSideTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = UNINSTALL.read_text(encoding="utf-8-sig")

    def test_bom_is_preserved(self) -> None:
        self.assertTrue(UNINSTALL.read_bytes().startswith(b"\xef\xbb\xbf"))

    # -------------------------------------------------------------- P1-E
    def test_purge_backs_up_first(self) -> None:
        self.assertIn("'purged-plugin-'", self.text)
        self.assertIn("Copy-Item -LiteralPath $StagingDir -Destination $purgeBackup -Recurse -Force -ErrorAction Stop", self.text)

    def test_purge_aborts_when_backup_fails(self) -> None:
        self.assertIn("备份插件本体失败，已中止删除", self.text)
        backup_at = self.text.index("$backupOk = $true")
        guard_at = self.text.index("if ($backupOk) {")
        delete_at = self.text.index("Remove-Item -LiteralPath $StagingDir", guard_at)
        self.assertLess(backup_at, guard_at, "备份成功标志必须早于删除判断")
        self.assertLess(guard_at, delete_at, "删除必须在备份成功之后")


class PackageTests(unittest.TestCase):
    def test_dist_ships_loader_pair(self) -> None:
        text = PACKAGE_DIST.read_text(encoding="utf-8-sig")
        self.assertIn("'plugin/static/loader/neko-theme-studio.js'", text)
        self.assertIn("'plugin/static/loader/neko-theme-studio.css'", text)
        self.assertIn("'plugin/static'", text)

    def test_dist_does_not_ship_dev_dirs(self) -> None:
        text = PACKAGE_DIST.read_text(encoding="utf-8-sig")
        for name in ("'test'", "'tools'", "'_work'", "'app'", "'app-patch'"):
            self.assertIn(name, text, f"{name} 应该被排除在发布包外")

    def test_check_dist_sync_exists(self) -> None:
        self.assertTrue(CHECK_SYNC.is_file(), "缺少 tools/check-dist-sync.ps1")
        text = CHECK_SYNC.read_text(encoding="utf-8-sig")
        self.assertIn("Get-FileHash", text)
        self.assertIn("plugin/plugin.toml", text)
        self.assertIn("exit 1", text, "漂移必须是非零退出码，否则 CI 看不见")
        self.assertIn(".sha256", text)


if __name__ == "__main__":
    unittest.main()
