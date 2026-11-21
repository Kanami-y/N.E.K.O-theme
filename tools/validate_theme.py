"""校验一份「主题 JSON」是否可导入、可读、分类正确。

给人和 AI 共用的自检入口：生成的配色先过这一关，再导进面板。

跑法：
    python tools/validate_theme.py my-theme.json
    python tools/validate_theme.py plugin/static/presets/glass-crystal.json

检查项：
1. JSON 能解析，字段类型/长度符合契约；
2. 每个变量名在 KNOWN_VARS 里（写错的会被静默忽略 → 这里显式报出来）；
3. 每个值过插件自己的校验器（与导入时同一套）；
4. 推断出的风格族、变量数量、note/tags；
5. 亮/暗两套的 WCAG 对比度（正文 4.5 / 次要 3.0）。

退出码：0 = 可导入；1 = 有硬错误（坏值/坏字段）；2 = 仅对比度警告。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugin"))       # plugin/materials.py（离线后端走绝对导入）
sys.path.insert(0, str(ROOT / "plugin" / "tests"))  # offline_backend.py
sys.path.insert(0, str(ROOT / "tools"))           # audit_themes.py

from offline_backend import load_backend  # noqa: E402
import audit_themes  # noqa: E402

NS = load_backend()
KNOWN = NS["KNOWN_VARS"]
IMAGE_VARS = set(NS.get("IMAGE_VARS") or {"--nts-chat-bg-image"})
_validate_palette = NS["_validate_palette"]
_preset_family = NS["_preset_family"]
_preset_preview = NS["_preset_preview"]
_theme_note = NS["_theme_note"]
_theme_tags = NS["_theme_tags"]
FAMILIES = set(NS["PRESET_FAMILIES"]) if "PRESET_FAMILIES" in NS else {
    "glassy", "gradient", "dark", "light", "texture", "minimal"
}


def fail(msg: str) -> None:
    print(f"  ✗ {msg}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 1
    path = Path(argv[1])
    try:
        raw_text = path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        print(f"读不到文件：{exc}")
        return 1
    try:
        data = json.loads(raw_text)
    except ValueError as exc:
        print(f"不是合法 JSON：{exc}")
        return 1
    if not isinstance(data, dict):
        print("顶层必须是 JSON 对象。")
        return 1

    hard = 0
    print(f"文件：{path}  ({len(raw_text)} 字符)")

    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        fail("缺少 name（字符串）")
        hard += 1
    else:
        print(f"  name：{name.strip()[:40]}")
    if len(str(name or "")) > 24:
        fail(f"name 超过 24 字（现在 {len(str(name))}）")
        hard += 1

    note = _theme_note(data.get("note"))
    tags = _theme_tags(data.get("tags"))
    warnings: list[str] = []
    if data.get("note") and not note:
        warnings.append("note 为空或不是字符串，已忽略")
    if data.get("tags") and not tags:
        warnings.append("tags 为空或格式不对，已忽略")
    print(f"  note：{note or '（无）'}")
    print(f"  tags：{tags or '（无）'}")

    declared = data.get("family")
    if declared is not None and declared not in FAMILIES:
        fail(f"family 只能是 {sorted(FAMILIES)}，现在是 {declared!r}")
        hard += 1

    def _strip_images(section):
        """背景图变量合法形态是 url("images/<hash>")，_validate_palette 只认本机
        绝对地址，会把它判非法 —— 这里摘出来原样保留，避免误报。"""
        if not isinstance(section, dict):
            return section
        return {k: v for k, v in section.items() if k not in IMAGE_VARS}

    def _merge_images(clean, section):
        if not isinstance(section, dict):
            return clean
        for var in IMAGE_VARS:
            if var in section:
                clean[var] = section[var]
        return clean

    clean_vars, clean_dark, errors = _validate_palette(
        _strip_images(data.get("vars")), _strip_images(data.get("dark_vars"))
    )
    clean_vars = _merge_images(clean_vars, data.get("vars"))
    clean_dark = _merge_images(clean_dark, data.get("dark_vars"))
    if not clean_vars and not clean_dark:
        fail("没有可用的变量（vars / dark_vars 都为空或全被拒）")
        hard += 1

    all_keys = set()
    for key in ("vars", "dark_vars"):
        section = data.get(key)
        if section is None:
            continue
        if not isinstance(section, dict):
            fail(f"{key} 必须是对象")
            hard += 1
            continue
        for var in section:
            if var not in KNOWN:
                fail(f"未知变量：{var}（会被静默忽略）")
                hard += 1
            all_keys.add(var)

    print(f"  变量：亮 {len(clean_vars)} / 暗 {len(clean_dark)}（不重复名字共 {len(all_keys)}）")
    if errors:
        print(f"  被拒 {len(errors)} 条：")
        for item in errors[:20]:
            fail(item)
        if len(errors) > 20:
            print(f"    …还有 {len(errors) - 20} 条")
        hard += len(errors)

    family = _preset_family(data, clean_vars, clean_dark)
    print(f"  风格族：{family}")
    if declared and declared != family:
        warnings.append(f"声明 family={declared}，按内容推断是 {family}（声明优先，但别写错）")

    preview = _preset_preview(clean_vars, clean_dark)
    if not preview:
        warnings.append("preview 为空（缺关键颜色），卡片缩略图会是空白")

    contrast_bad = 0
    for mode, vars_map in (("亮", clean_vars), ("暗", clean_dark)):
        if not vars_map:
            continue
        rows = audit_themes.checks(vars_map, mode)
        worst = min((r[1] for r in rows), default=0)
        bad = [r for r in rows if not r[3]]
        print(f"  对比度·{mode}：最差 {worst:.2f}，{len(rows)} 项检查，{len(bad)} 项不达标")
        for item_name, ratio, need, ok in bad:
            if not ok:
                fail(f"对比度·{mode} {item_name}: {ratio:.2f} < {need:.1f}")
                contrast_bad += 1
        skipped = [r for r in rows if r[1] == 0]
        if skipped:
            warnings.append(f"对比度·{mode} 有 {len(skipped)} 项因为颜色写成了非 hex/rgb 而跳过")

    for item in warnings:
        print(f"  ! {item}")

    print()
    if hard:
        print(f"结果：不可导入（{hard} 个硬错误）")
        return 1
    if contrast_bad:
        print(f"结果：能导入，但对比度 {contrast_bad} 项不达标（建议修，暗光下会看不清）")
        return 2
    print("结果：通过 ✅  可以直接导入面板（主题仓库 → 导入）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
