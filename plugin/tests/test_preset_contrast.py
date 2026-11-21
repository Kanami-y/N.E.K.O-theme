"""内置主题的可读性底线：每套预设的关键文字与背景对比度必须达标。

为什么要这条测试：配色「好不好看」没法自动判断，但「看不看得清」可以量化。
内置主题是用户第一次打开就会看到的默认选项，一旦出现白字压浅蓝、灰字压灰底，
用户的第一感受是「这个插件很粗糙」，而不是「这套配色不合我口味」。

阈值沿用 WCAG AA：正文 4.5:1，次要文字/占位符 3.0:1。
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
PRESET_DIR = PLUGIN_DIR / "static" / "presets"

MIN_TEXT = 4.5
MIN_SUBTLE = 3.0

# 只认这 4 个真的接收渐变串的变量；--nts-panel-edge-gradient 是 0–1 数值，别误判。
GRADIENT_VARS = frozenset(
    {
        "--nts-chat-gradient",
        "--nts-panel-gradient",
        "--nts-user-bubble-gradient",
        "--nts-ai-bubble-gradient",
    }
)


def parse_color(value: object):
    """解析 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/white/black/transparent。"""
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text:
        return None
    if text in ("white", "#fff", "#ffffff"):
        return (255.0, 255.0, 255.0, 1.0)
    if text in ("black", "#000", "#000000"):
        return (0.0, 0.0, 0.0, 1.0)
    if text == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    match = re.fullmatch(r"#([0-9a-f]{3,8})", text)
    if match:
        digits = match.group(1)
        if len(digits) in (3, 4):
            digits = "".join(ch * 2 for ch in digits)
        values = [int(digits[i : i + 2], 16) for i in (0, 2, 4)]
        alpha = int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0
        return (float(values[0]), float(values[1]), float(values[2]), alpha)
    match = re.fullmatch(
        r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)",
        text,
    )
    if match:
        alpha = float(match.group(4)) if match.group(4) is not None else 1.0
        return (
            float(match.group(1)),
            float(match.group(2)),
            float(match.group(3)),
            alpha,
        )
    return None


def over(top, bottom):
    """alpha 合成：top 盖在 bottom 上。"""
    if top is None:
        return bottom
    if bottom is None:
        return top
    tr, tg, tb, ta = top
    br, bg_, bb, ba = bottom
    alpha = ta + ba * (1 - ta)
    if alpha <= 0:
        return (0.0, 0.0, 0.0, 0.0)
    return (
        (tr * ta + br * ba * (1 - ta)) / alpha,
        (tg * ta + bg_ * ba * (1 - ta)) / alpha,
        (tb * ta + bb * ba * (1 - ta)) / alpha,
        alpha,
    )


def _channel(value: float) -> float:
    value /= 255.0
    return value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4


def luma(color) -> float:
    r, g, b, _ = color
    return 0.2126 * _channel(r) + 0.7152 * _channel(g) + 0.0722 * _channel(b)


def contrast(foreground, background) -> float:
    light, dark = sorted((luma(foreground), luma(background)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def ratio(theme_vars: dict, fg_key: str, bg_color) -> float | None:
    fg = parse_color(theme_vars.get(fg_key))
    if fg is None or bg_color is None:
        return None
    return contrast(over(fg, bg_color) if fg[3] < 1 else fg, bg_color)


def _preset_files():
    return sorted(PRESET_DIR.glob("*.json"))


class PresetContrastTest(unittest.TestCase):
    """内置主题的文字/背景对比度底线。"""

    def test_every_preset_is_readable(self):
        failures = []
        for path in _preset_files():
            data = json.loads(path.read_text(encoding="utf-8"))
            for mode, key in (("亮", "vars"), ("暗", "dark_vars")):
                theme_vars = data.get(key) or {}
                if not theme_vars:
                    continue
                chat_bg = parse_color(theme_vars.get("--nts-chat-bg"))
                if chat_bg is None:
                    chat_bg = (255.0, 255.0, 255.0, 1.0)
                surface = parse_color(theme_vars.get("--nts-topbar-bg")) or chat_bg
                input_bg = over(parse_color(theme_vars.get("--nts-input-bg")), chat_bg)
                ai_bg = over(parse_color(theme_vars.get("--nts-ai-bubble-bg")), chat_bg)
                chip_bg = over(parse_color(theme_vars.get("--nts-chip-bg")), chat_bg)
                glass = over(parse_color(theme_vars.get("--nts-panel-glass-tint")), chat_bg)
                user_bg = (
                    over(parse_color(theme_vars.get("--nts-user-bubble-bg")), chat_bg)
                    if theme_vars.get("--nts-user-bubble-bg")
                    else None
                )
                send_bg = parse_color(theme_vars.get("--nts-send-bg"))

                checks = [
                    ("正文/聊天背景", "--nts-panel-text", chat_bg, MIN_TEXT),
                    ("正文/顶栏", "--nts-topbar-text", surface, MIN_TEXT),
                    ("正文/输入框", "--nts-input-text", input_bg, MIN_TEXT),
                    ("正文/面板玻璃", "--nts-panel-text", glass, MIN_TEXT),
                    ("正文/AI 气泡", "--nts-ai-bubble-text", ai_bg, MIN_TEXT),
                    ("用户气泡文字", "--nts-user-bubble-text", user_bg, MIN_TEXT),
                    ("发送键文字", "--nts-send-text", send_bg, MIN_TEXT),
                    ("placeholder", "--nts-input-placeholder", input_bg, MIN_SUBTLE),
                    ("chip 文字", "--nts-chip-text", chip_bg, MIN_SUBTLE),
                    ("链接", "--nts-link", chat_bg, MIN_SUBTLE),
                ]
                if not theme_vars.get("--nts-user-bubble-bg"):
                    checks = [row for row in checks if row[0] != "用户气泡文字"]
                for label, fg_key, bg, need in checks:
                    value = ratio(theme_vars, fg_key, bg)
                    if value is None:
                        continue
                    if value < need:
                        failures.append(
                            f"{path.stem} {mode} {label}: {value:.2f} < {need:.1f}"
                        )
        self.assertEqual(failures, [], "内置主题对比度不达标：\n" + "\n".join(failures))

    def test_gradient_stops_are_parsable(self):
        """渐变变量的每个色标都必须能被面板/加载器解析，否则整条变量会被丢弃。"""
        stop_re = re.compile(r"#[0-9a-fA-F]{3,8}|rgba?\([^()]*\)")
        for path in _preset_files():
            data = json.loads(path.read_text(encoding="utf-8"))
            for key in ("vars", "dark_vars"):
                for name, value in (data.get(key) or {}).items():
                    if name not in GRADIENT_VARS or not isinstance(value, str):
                        continue
                    stops = stop_re.findall(value)
                    self.assertGreaterEqual(len(stops), 2, f"{path.stem}/{key}/{name}")
                    for stop in stops:
                        self.assertIsNotNone(
                            parse_color(stop), f"{path.stem}/{key}/{name} 色标 {stop}"
                        )


if __name__ == "__main__":
    unittest.main()
