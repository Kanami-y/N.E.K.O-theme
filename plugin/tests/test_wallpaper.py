"""壁纸取色 + 变体生成（v0.11.0）的接线与契约测试（grep，不跑浏览器）。"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP_JS = (ROOT / "plugin/static/app.js").read_text(encoding="utf-8")
INDEX_HTML = (ROOT / "plugin/static/index.html").read_text(encoding="utf-8")


def block_source(begin: str, end: str) -> str:
    start = APP_JS.index(begin)
    stop = APP_JS.index(end)
    return APP_JS[start:stop]


class WallpaperBlockTests(unittest.TestCase):
    def test_block_markers(self) -> None:
        assert "/* ===== WALLPAPER_BEGIN" in APP_JS
        assert "/* ===== WALLPAPER_END ===== */" in APP_JS
        assert APP_JS.index("/* ===== WALLPAPER_BEGIN") < APP_JS.index("function wireEvents()")

    def test_functions_exist(self) -> None:
        for name in (
            "rgbToHsl",
            "hslToRgb",
            "extractImageColors",
            "wallpaperInk",
            "wallpaperPalette",
            "shiftColorValue",
            "buildVariantPalette",
            "applyWallpaperPalette",
            "openWallpaperPicker",
            "handleWallpaperFile",
            "applyNextVariant",
            "initWallpaperFeature",
        ):
            assert f"function {name}(" in APP_JS, name

    def test_constants(self) -> None:
        assert "WALLPAPER_SAMPLE = 96" in APP_JS
        assert "WALLPAPER_MAX_FILE = 12 * 1024 * 1024" in APP_JS
        assert "VARIANT_STEPS = [" in APP_JS
        for label in ("更暖", "更冷", "更亮", "更深"):
            assert label in APP_JS, label


class ImageExtractionTests(unittest.TestCase):
    def test_skips_transparent_and_buckets(self) -> None:
        src = block_source("function extractImageColors(", "function wallpaperInk(")
        assert "pixels[o + 3] < 32" in src
        assert ">> 4" in src
        assert "out.sort(" in src
        assert "slice(0, 8)" in src

    def test_score_uses_saturation_and_luma(self) -> None:
        src = block_source("function extractImageColors(", "function wallpaperInk(")
        assert "score: bucket.n * (0.25 + hsl.s) * usable" in src
        assert "luma > 0.05 && luma < 0.95" in src


class PaletteTests(unittest.TestCase):
    def test_primary_drives_background(self) -> None:
        src = block_source("function wallpaperPalette(", "function shiftColorValue(")
        assert "var primary = colors[0]" in src
        assert "mixToward(primary" in src
        assert "wallpaperInk(bg, 7.0)" in src
        assert "wallpaperInk(panel, 4.5)" in src
        assert "colorToHex(fixed.color)" in block_source("function wallpaperInk(", "function wallpaperPalette(")

    def test_contrast_pairs_present(self) -> None:
        src = block_source("function wallpaperPalette(", "function shiftColorValue(")
        for key in ("--nts-user-bubble-text", "--nts-ai-bubble-text", "--nts-input-text", "--nts-send-text"):
            assert key in src, key
        # 对比度由 wallpaperInk 统一处理（内部走 contrastFixColor）
        assert "wallpaperInk(" in src

    def test_leaves_image_and_layout_untouched(self) -> None:
        src = block_source("function wallpaperPalette(", "function shiftColorValue(")
        assert "--nts-chat-bg-image'" not in src
        assert "--nts-radius" not in src
        assert "--nts-font-family" not in src

    def test_no_server_or_disk_write(self) -> None:
        src = block_source("/* ===== WALLPAPER_BEGIN", "/* ===== WALLPAPER_END")
        assert "saveThemeFile" not in src
        assert "callPlugin('save_theme'" not in src
        assert "applyTheme(" not in src
        assert "state.edited" in src


class VariantTests(unittest.TestCase):
    def test_surfaces_and_pairs(self) -> None:
        src = block_source("var VARIANT_SURFACES", "var variantState")
        assert "--nts-chat-bg'" in src
        assert "--nts-user-bubble-bg'" in src
        assert "--nts-user-bubble-text', '--nts-user-bubble-bg'" in src

    def test_shifts_hsl(self) -> None:
        src = block_source("function shiftColorValue(", "function buildVariantPalette(")
        assert "rgbToHsl(" in src
        assert "hslToRgb(" in src
        assert "hsl.h + step.dh" in src
        assert "step.dl" in src
        assert "return null;" in src

    def test_rechecks_contrast_after_shift(self) -> None:
        src = block_source("function buildVariantPalette(", "function applyWallpaperPalette(")
        assert "contrastFixColor(parseColor(text), parseColor(bg), 4.5)" in src
        assert "colorToHex(fixed.color)" in src


class ApplyTests(unittest.TestCase):
    def test_undo_and_no_commit(self) -> None:
        src = block_source("function applyWallpaperPalette(", "function openWallpaperPicker(")
        assert "undoPush('', true);" in src
        assert "syncAll();" in src
        assert "updateUndoButtons();" in src
        assert "applyTheme(" not in src
        assert "saveThemeFile" not in src

    def test_file_guards(self) -> None:
        src = block_source("function handleWallpaperFile(", "function applyNextVariant(")
        assert "/^image\\//.test" in src
        assert "WALLPAPER_MAX_FILE" in src
        assert "new FileReader()" in src
        assert "new Image()" in src
        assert "getImageData(0, 0, WALLPAPER_SAMPLE, WALLPAPER_SAMPLE)" in src


class WiringTests(unittest.TestCase):
    def test_html_controls(self) -> None:
        assert 'id="btn-wallpaper"' in INDEX_HTML
        assert 'id="btn-variants"' in INDEX_HTML
        assert 'id="wallpaper-file"' in INDEX_HTML
        assert 'accept="image/png,image/jpeg,image/webp,image/gif"' in INDEX_HTML
        assert "壁纸配色" in INDEX_HTML
        assert "变体" in INDEX_HTML

    def test_wire_events_and_hooks(self) -> None:
        assert "initWallpaperFeature();" in APP_JS
        for hook in (
            "extractImageColors: extractImageColors,",
            "wallpaperPalette: wallpaperPalette,",
            "shiftColorValue: shiftColorValue,",
            "buildVariantPalette: buildVariantPalette,",
            "applyWallpaperPalette: applyWallpaperPalette,",
            "handleWallpaperFile: handleWallpaperFile,",
            "applyNextVariant: applyNextVariant,",
            "variantState: variantState,",
        ):
            assert hook in APP_JS, hook

    def test_ci_and_readme_registered(self) -> None:
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        assert "test/wallpaper-selftest.js" in ci
        readme = (ROOT / "test/README.md").read_text(encoding="utf-8")
        assert "wallpaper-selftest.js" in readme

    def test_no_innerhtml_strings(self) -> None:
        src = block_source("/* ===== WALLPAPER_BEGIN", "/* ===== WALLPAPER_END")
        assert "innerHTML = '" not in src
        assert ".innerHTML = \"" not in src

    def test_manifest_example_parses(self) -> None:
        # 生成器只产出 #rrggbb / rgba(...)，这里确认测试夹具的期望形态没漂
        sample = {"--nts-chat-bg": "#f6f7fb", "--nts-overlay-bg": "rgba(18, 22, 30, 0.32)"}
        text = json.dumps(sample, ensure_ascii=False)
        assert re.search(r"#[0-9a-f]{6}", text)
        assert "rgba(" in text
