"""内置主题的可读性审计：按 WCAG 对比度逐套算，低于阈值就报错。

为什么要这个：配色「好看」很主观，但「文字看得清」可以量化。主题一旦把
气泡文字/背景凑成低对比（尤其是亮色主题里的 placeholder 和暗色主题里的
次要文字），用户第一反应是「刺眼」或「看不清」，而不是「这套配色有问题」。
这里用 4.5:1（正文）/ 3.0:1（次要文字、大字号）两档把关。

跑法：python tools/audit_themes.py [--fix]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRESET_DIR = ROOT / "plugin" / "static" / "presets"


def parse_color(value: str):
    """把 #rgba / rgb() / rgba() / 命名色（只认 white/black/transparent）解析成 (r,g,b,a)。"""
    value = (value or "").strip()
    if not value:
        return None
    if value.lower() in ("white", "#fff", "#ffffff"):
        return (255, 255, 255, 1.0)
    if value.lower() in ("black", "#000", "#000000"):
        return (0, 0, 0, 1.0)
    if value.lower() == "transparent":
        return (0, 0, 0, 0.0)
    m = re.match(r"^#([0-9a-f]{3,8})$", value, re.I)
    if m:
        digits = m.group(1)
        if len(digits) in (3, 4):
            digits = "".join(ch * 2 for ch in digits)
        r, g, b = (int(digits[i : i + 2], 16) for i in (0, 2, 4))
        alpha = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
        return (r, g, b, alpha)
    m = re.match(
        r"^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})"
        r"\s*(?:,\s*([0-9.]+)\s*)?\)$",
        value,
        re.I,
    )
    if m:
        r, g, b = (int(m.group(i)) for i in (1, 2, 3))
        alpha = float(m.group(4)) if m.group(4) is not None else 1.0
        return (r, g, b, alpha)
    return None


def over(top, bottom):
    """alpha 合成：top 叠在 bottom 上。"""
    if top is None:
        return bottom
    if bottom is None:
        return top
    tr, tg, tb, ta = top
    br, bg_, bb, ba = bottom
    a = ta + ba * (1 - ta)
    if a <= 0:
        return (0, 0, 0, 0.0)
    return (
        (tr * ta + br * ba * (1 - ta)) / a,
        (tg * ta + bg_ * ba * (1 - ta)) / a,
        (tb * ta + bb * ba * (1 - ta)) / a,
        a,
    )


def _channel(value: float) -> float:
    value /= 255
    return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4


def luma(color) -> float:
    r, g, b, _ = color
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast(fg, bg) -> float:
    l1, l2 = luma(fg), luma(bg)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def gradient_mid(value: str):
    """取渐变最中间那个色标，作为气泡文字的对比参考。"""
    stops = [
        parse_color(m.group(1))
        for m in re.finditer(
            r"(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))", value or ""
        )
    ]
    stops = [s for s in stops if s]
    if not stops:
        return None
    return stops[len(stops) // 2]


def checks(theme_vars: dict, label: str):
    get = theme_vars.get
    chat_bg = parse_color(get("--nts-chat-bg"))
    surface = parse_color(get("--nts-topbar-bg")) or chat_bg
    panel_glass = parse_color(get("--nts-panel-glass-tint")) or surface
    input_bg = over(parse_color(get("--nts-input-bg")), chat_bg)
    user_grad = gradient_mid(get("--nts-user-bubble-gradient"))
    user_bg = over(parse_color(get("--nts-user-bubble-bg")), chat_bg) if get("--nts-user-bubble-bg") else user_grad
    ai_bg = over(parse_color(get("--nts-ai-bubble-bg")), chat_bg)

    cases = [
        ("正文/聊天背景", get("--nts-panel-text"), chat_bg, 4.5),
        ("正文/顶栏", get("--nts-topbar-text"), surface, 4.5),
        ("正文/输入框", get("--nts-input-text"), input_bg, 4.5),
        ("正文/面板玻璃", get("--nts-panel-text"), over(panel_glass, chat_bg), 4.5),
        ("正文/AI 气泡", get("--nts-ai-bubble-text"), ai_bg, 4.5),
        ("用户气泡文字", get("--nts-user-bubble-text"), user_bg, 4.5),
        ("发送键文字", get("--nts-send-text"), parse_color(get("--nts-send-bg")), 4.5),
        ("次要文字/聊天背景", get("--nts-panel-text-sub"), chat_bg, 3.0),
        ("placeholder", get("--nts-input-placeholder"), input_bg, 3.0),
        ("chip 文字", get("--nts-chip-text"), over(parse_color(get("--nts-chip-bg")), chat_bg), 3.0),
        ("链接/聊天背景", get("--nts-link"), chat_bg, 3.0),
    ]
    out = []
    for name, fg_raw, bg, need in cases:
        fg = parse_color(fg_raw) if isinstance(fg_raw, str) else fg_raw
        if fg is None or bg is None:
            continue
        fg = over(fg, bg) if fg[3] < 1 else fg
        ratio = contrast(fg, bg)
        out.append((name, round(ratio, 2), need, ratio >= need))
    return out


def main() -> int:
    files = sorted(PRESET_DIR.glob("*.json"))
    failures = 0
    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        for mode, key in (("亮", "vars"), ("暗", "dark_vars")):
            rows = checks(data.get(key) or {}, path.stem)
            bad = [r for r in rows if not r[3]]
            mark = "OK " if not bad else "!! "
            print(f"{mark}{path.stem:<18}{mode}  最差 {min(r[1] for r in rows):>4.2f}")
            for name, ratio, need, ok in bad:
                failures += 1
                print(f"      {name}: {ratio:.2f} < {need:.1f}")
    print(f"\n共 {len(files)} 套，低于阈值 {failures} 项")
    print(
        "NOTE 仅供逐项明细参考，退出码恒 0；真正的门禁是 CI 里的对比度基线棘轮"
        "（plugin/tests/test_contract.py + test_contrast_baseline.py）。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
