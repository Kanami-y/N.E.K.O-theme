#!/usr/bin/env python3
"""把当前插件的源码与发布包各留一份快照到独立目录，按版本号分文件夹。

为什么需要它：插件本体装在
``%LOCALAPPDATA%\\N.E.K.O\\.neko-plugin-installations\\plugins\\neko_theme_studio``，
每次 ``install.ps1`` 都会整目录替换掉；仓库里的 ``plugin/`` 只有一个"当前版本"。
所以"上个版本长什么样"在更新之后就没有了 —— 这个工具把每轮的完成态另存一份。

用法：
    python tools/archive-version.py                # 按 plugin/plugin.toml 的版本归档
    python tools/archive-version.py --check        # 只看会写到哪里/是否已存在
    python tools/archive-version.py --dest D:/x    # 换目录（也可用环境变量 NTS_VERSION_ARCHIVE）
    python tools/archive-version.py --backfill _work/legacy-dist/neko-theme-studio-0.4.21.zip
    python tools/archive-version.py --backfill-all  # 把 dist/ 与 _work/legacy-dist/ 里所有 zip 补档

默认归档根：仓库同级的 ``_nts-plugin-versions``（即 ``D:\\be\\_nts-plugin-versions``，
不随插件安装/更新动作被动过；也可以在环境变量里指定到别的盘）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugin"
TOML = PLUGIN / "plugin.toml"
DEFAULT_DEST = Path(os.environ.get("NTS_VERSION_ARCHIVE") or (ROOT.parent / "_nts-plugin-versions"))
SKIP_DIRS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
SKIP_SUFFIXES = {".pyc", ".pyo"}
ZIP_GLOBS = ("dist/neko-theme-studio-*.zip", "_work/legacy-dist/neko-theme-studio-*.zip")


def read_text(path: Path) -> str:
    return path.read_bytes().decode("utf-8-sig")


def current_version() -> str:
    match = re.search(r'^version\s*=\s*"([^"]+)"', read_text(TOML), re.M)
    if not match:
        raise SystemExit("plugin/plugin.toml 里找不到 version = \"…\"")
    return match.group(1)


def loader_version() -> str:
    match = re.search(r"var SCRIPT_VERSION = '([^']+)';", read_text(PLUGIN / "static" / "loader" / "neko-theme-studio.js"))
    return match.group(1) if match else ""


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_plugin_tree(src: Path, dest: Path) -> tuple[int, int]:
    files = 0
    total = 0
    for path in sorted(src.rglob("*")):
        rel = path.relative_to(src)
        if any(part in SKIP_DIRS for part in rel.parts):
            continue
        if path.is_dir():
            continue
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        files += 1
        total += target.stat().st_size
    return files, total


def find_dist_zip(version: str) -> Path | None:
    for pattern in ZIP_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            if path.name == f"neko-theme-studio-{version}.zip":
                return path
    return None


def write_readme(dest: Path, version: str, meta: dict) -> None:
    lines = [
        f"# N.E.K.O 主题插件 · v{version} 快照",
        "",
        f"- 归档时间：{meta['archived_at']}",
        f"- 来源：`{meta['source_root']}`",
        f"- 插件版本：{meta['plugin_version']}（loader {meta['loader_version'] or '?'}）",
        f"- 文件：{meta['files']} 个 / {meta['bytes']:,} 字节",
    ]
    if meta.get("zip"):
        lines.append(f"- 发布包：`{meta['zip']}`（sha256 `{meta['zip_sha256']}`）")
    if meta.get("plugin_package"):
        lines.append(f"- 官方插件包：`{meta['plugin_package']}`（sha256 `{meta['plugin_package_sha256']}`）")
    lines += [
        "",
        "## 这个目录是什么",
        "",
        "插件每次 `install.ps1` 都会把安装目录整目录替换掉，仓库里的 `plugin/` 也只保留",
        "当前版本。这个目录是**某一轮完成时的快照**，更新之后依然在，用来回看/回滚。",
        "",
        "## 怎么用",
        "",
        "1. 只想装回这一版：用同目录的 `neko-theme-studio-<版本>.zip`（面板里的「插件市场 → 导入」",
        "   或直接解到 `.neko-plugin-installations/plugins/`），然后重启 N.E.K.O 窗口。",
        "2. 想继续改这一版的代码：把 `plugin/` 拷回仓库（先备份当前 `plugin/`），",
        "   再跑 `node tools/gen-version.js --check` 与 `powershell -File install.ps1 -AppRoot <宿主目录>`。",
        "3. 覆盖前请先退出 N.E.K.O（含托盘图标），否则宿主可能正在读这些文件。",
    ]
    if meta.get("note"):
        lines += ["", f"> {meta['note']}"]
    (dest / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def archive_current(dest_root: Path, *, force: bool, note: str = "") -> Path:
    version = current_version()
    dest = dest_root / f"v{version}"
    if (dest / "VERSION.json").exists() and not force:
        print(f"skip: v{version} 已归档（想覆盖加 --force）：{dest}")
        return dest
    if dest.exists() and force:
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    files, total = copy_plugin_tree(PLUGIN, dest / "plugin")
    zip_path = find_dist_zip(version)
    meta = {
        "version": version,
        "plugin_version": version,
        "loader_version": loader_version(),
        "archived_at": datetime.now().isoformat(timespec="seconds"),
        "source_root": str(ROOT),
        "files": files,
        "bytes": total,
        "zip": "",
        "zip_sha256": "",
        "plugin_package": "",
        "plugin_package_sha256": "",
        "note": note,
    }
    if zip_path is not None:
        shutil.copy2(zip_path, dest / zip_path.name)
        sha_file = zip_path.with_suffix(".sha256")
        if sha_file.exists():
            shutil.copy2(sha_file, dest / sha_file.name)
        meta["zip"] = zip_path.name
        meta["zip_sha256"] = sha256_of(dest / zip_path.name)
    # 官方插件包（单文件 .neko-plugin，tools/package-plugin.ps1 产出）：存在就一起存档，
    # 这样「某一版的可分发产物」不用回头重建（重建会带上新的构建时间戳、sha 也不同）。
    pkg_path = ROOT / "dist" / "neko_theme_studio.neko-plugin"
    if pkg_path.is_file():
        shutil.copy2(pkg_path, dest / pkg_path.name)
        pkg_sha = pkg_path.with_name(pkg_path.name + ".sha256")
        if pkg_sha.exists():
            shutil.copy2(pkg_sha, dest / pkg_sha.name)
        meta["plugin_package"] = pkg_path.name
        meta["plugin_package_sha256"] = sha256_of(dest / pkg_path.name)
    (dest / "VERSION.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    write_readme(dest, version, meta)
    print(f"archived: v{version} -> {dest}（{files} 文件 / {total:,} 字节）")
    return dest


def archive_zip(dest_root: Path, zip_path: Path, *, force: bool) -> Path:
    match = re.search(r"neko-theme-studio-([0-9][0-9A-Za-z.\-]*)\.zip$", zip_path.name)
    if not match:
        raise SystemExit(f"看不懂这个文件名：{zip_path.name}")
    version = match.group(1)
    dest = dest_root / f"v{version}"
    if (dest / "VERSION.json").exists() and not force:
        print(f"skip: v{version} 已归档：{dest}")
        return dest
    if dest.exists() and force:
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)
    files = 0
    total = 0
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or not name.startswith("plugin/"):
                continue
            rel = name[len("plugin/"):]
            if any(part in SKIP_DIRS for part in Path(rel).parts):
                continue
            target = dest / "plugin" / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))
            files += 1
            total += target.stat().st_size
    shutil.copy2(zip_path, dest / zip_path.name)
    meta = {
        "version": version,
        "plugin_version": version,
        "loader_version": "",
        "archived_at": datetime.now().isoformat(timespec="seconds"),
        "source_root": str(ROOT),
        "files": files,
        "bytes": total,
        "zip": zip_path.name,
        "zip_sha256": sha256_of(dest / zip_path.name),
        "note": "由历史发布包补档（不是从源码归档，可能与该版源码的 app/ 镜像不完全一致）。",
    }
    (dest / "VERSION.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    write_readme(dest, version, meta)
    print(f"backfilled: v{version} -> {dest}（{files} 文件 / {total:,} 字节）")
    return dest


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="把当前插件版本快照归档到独立目录")
    parser.add_argument("--dest", default=str(DEFAULT_DEST), help="归档根目录")
    parser.add_argument("--force", action="store_true", help="同版本已归档时覆盖")
    parser.add_argument("--check", action="store_true", help="只报告，不写文件")
    parser.add_argument("--note", default="", help="写进 README 的备注")
    parser.add_argument("--backfill", action="append", default=[], help="从某个发布 zip 补档")
    parser.add_argument("--backfill-all", action="store_true", help="把 dist/ 与 _work/legacy-dist/ 的 zip 全补档")
    args = parser.parse_args(argv)

    dest_root = Path(args.dest)
    if args.check:
        version = current_version()
        print(f"当前版本：{version}")
        print(f"归档根：{dest_root}")
        print(f"目标：{dest_root / ('v' + version)}")
        print("状态：已归档" if (dest_root / f"v{version}" / "VERSION.json").exists() else "状态：未归档")
        zips = sorted({p for pattern in ZIP_GLOBS for p in ROOT.glob(pattern)})
        print(f"可补档的历史包：{len(zips)} 个")
        return 0

    dest_root.mkdir(parents=True, exist_ok=True)
    targets: list[Path] = []
    for raw in args.backfill:
        targets.append(archive_zip(dest_root, Path(raw), force=args.force))
    if args.backfill_all:
        seen = set()
        for pattern in ZIP_GLOBS:
            for path in sorted(ROOT.glob(pattern)):
                if path.name in seen:
                    continue
                seen.add(path.name)
                targets.append(archive_zip(dest_root, path, force=args.force))
    if not args.backfill and not args.backfill_all:
        targets.append(archive_current(dest_root, force=args.force, note=args.note))

    print(f"\n归档根：{dest_root}")
    for path in targets:
        print(f"  - {path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
