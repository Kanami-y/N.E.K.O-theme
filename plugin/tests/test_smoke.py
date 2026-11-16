import importlib
import json
import tomllib
from pathlib import Path


def test_plugin_entry_and_theme_assets() -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = tomllib.loads((root / "plugin.toml").read_text(encoding="utf-8"))["plugin"]
    assert manifest["id"] == "neko_theme_studio"
    module_name, class_name = manifest["entry"].split(":")
    module = importlib.import_module(module_name)
    assert getattr(module, class_name) is module.NekoThemeStudioPlugin

    for panel in manifest["ui"]["panel"]:
        assert (root / panel["entry"]).is_file()
    for asset in ("neko-theme-studio.css", "neko-theme-studio.js"):
        assert (root / "static" / "loader" / asset).stat().st_size > 0

    shipped = json.loads((root / "static" / "theme.json").read_text(encoding="utf-8"))
    defaults = module.default_palette()
    assert shipped["schema"] == defaults["schema"]
    assert isinstance(shipped["vars"], dict)
    assert isinstance(shipped["dark_vars"], dict)
