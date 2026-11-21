"""聊天背景图必须「钉住」：不随历史记录滚动、也不随历史变长被放大。

用户 2026-11-19 两次反馈：
1. 「背景图片显示不全，我要固定背景，就是不会和历史记录滑动」
2. 「还是有问题，历史记录长了之后，背景图就被伸缩，随着文字移动放大移动」

真正的成因（v0.4.24 用 ``background-attachment: fixed`` 修过一次，没用）：
- 壁纸被同时画在 ``.compact-export-history-scroll``（滚动容器，盒子尺寸固定）和
  ``.compact-export-history-scroll-content``（内容元素，高度 = 历史总高）上。
  后者的 ``background-size: cover`` 按它的盒子缩放，历史越长盒子越高 → 图被放大，
  看起来就是「被伸缩」；盒子本身跟着滚动一起走 → 「随着文字移动」。
- 而 ``background-attachment: fixed`` 在 Chromium 里对这个自带合成滚动层的滚动容器
  会退化成 ``local``（跟着内容滚），祖先 ``.compact-chat-surface-frame`` 还有
  ``backdrop-filter`` 会重新定义 fixed 的包含块。所以 fixed 既救不了、还制造错觉。

正确做法（本测试锁住的契约）：
1. 只把壁纸画在**尺寸固定**的容器上：``.compact-export-history-scroll``（滚动容器，
   它自己的背景在内部内容滚动时不动）、``.message-list``、``.chat-body``；
   **不再**包含 ``.compact-export-history-scroll-content`` 这种内容元素。
2. ``background-attachment`` 用 ``scroll``（相对元素 border-box，不随内部内容滚动），
   不再用 ``fixed``。
3. 生成器 ``tools/gen-css.js`` 里保留上面的成因说明，避免以后又被改回 fixed。
4. 三个 CSS 副本字节一致，且 ``node tools/gen-css.js`` 重新生成的结果与仓库一致
   （防止手改 CSS 后再生成一次就丢）。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from offline_backend import ROOT  # noqa: E402

LOADER_CSS = ROOT / "plugin" / "static" / "loader" / "neko-theme-studio.css"
GEN_CSS_JS = ROOT / "tools" / "gen-css.js"
MIRRORS = (
    ROOT / "app" / "css" / "neko-theme-studio.css",
    ROOT / "app-patch" / "files" / "css" / "neko-theme-studio.css",
)

FIXED_SIZE_CONTAINERS = (
    ".compact-export-history-scroll",
    ".message-list",
    ".chat-body",
)
TALL_CONTENT_CONTAINER = ".compact-export-history-scroll-content"


class BackgroundAnchorTests(unittest.TestCase):
    """壁纸只画在尺寸固定的容器上，靠 scroll 相对定位钉住。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.css = LOADER_CSS.read_text(encoding="utf-8")
        cls.rules = [line for line in cls.css.splitlines() if "--nts-chat-bg-image" in line]

    def test_every_background_rule_uses_scroll_attachment(self) -> None:
        self.assertTrue(self.rules, "没找到画 --nts-chat-bg-image 的规则")
        for rule in self.rules:
            self.assertIn("background-attachment: scroll", rule, rule[:160])
            self.assertNotIn("background-attachment: fixed", rule, rule[:160])
            self.assertNotIn("background-attachment: local", rule, rule[:160])

    def test_rule_count_is_three_containers_times_two_modes_times_two_families(self) -> None:
        self.assertEqual(len(self.rules), 12,
                         "应为 3 容器 × 亮/暗 × 纯图/带亮度；数量变了说明选择器或模式漏改")

    def test_each_fixed_size_container_is_covered(self) -> None:
        for selector in FIXED_SIZE_CONTAINERS:
            hit = [r for r in self.rules if " body " + selector + " {" in r]
            self.assertEqual(len(hit), 4, selector + " 应有 4 条（亮/暗 × 纯图/带亮度）")

    def test_tall_content_container_is_not_painted(self) -> None:
        for rule in self.rules:
            self.assertNotIn(" body " + TALL_CONTENT_CONTAINER + " {", rule,
                             "内容元素高度 = 历史总高，画上去就会被 cover 放大并跟着滚动")

    def test_every_rule_keeps_a_fixed_framing(self) -> None:
        # cover 是把图铺满（会裁切），这是「壁纸」语义；改成 contain 会让两侧露底色。
        for rule in self.rules:
            self.assertIn("background-size: cover", rule, rule[:160])
            self.assertIn("background-position: center center", rule, rule[:160])
            self.assertIn("background-repeat: no-repeat", rule, rule[:160])

    def test_generator_explains_why_not_fixed(self) -> None:
        source = GEN_CSS_JS.read_text(encoding="utf-8")
        self.assertEqual(source.count("background-attachment: scroll !important;"), 2,
                         "纯图家族与亮度家族各要有一条（两层 attachment 必须一致）")
        self.assertEqual(source.count("background-attachment: fixed !important;"), 0,
                         "fixed 对滚动容器会被 Chromium 退化成 local，别再写回去")
        self.assertIn("降级成 local", source, "成因说明要留在生成器里")
        self.assertIn("被伸缩", source, "把用户原话的成因留在注释里，方便以后追溯")

    def test_selector_list_drops_the_tall_content_container(self) -> None:
        targets = (ROOT / "test" / "targets.js").read_text(encoding="utf-8")
        block = targets.split("chatBackgroundImage:", 1)[1].split("chatBackgroundImageBrightness:", 1)[0]
        # 注释里可以提到这个类名（说明为什么不要），但选择器列表里不能出现。
        self.assertNotIn("'" + TALL_CONTENT_CONTAINER + "'", block)
        for selector in FIXED_SIZE_CONTAINERS:
            self.assertIn("'" + selector + "'", block)

    def test_copies_are_byte_identical(self) -> None:
        source = LOADER_CSS.read_bytes()
        for mirror in MIRRORS:
            self.assertTrue(mirror.is_file(), str(mirror))
            self.assertEqual(mirror.read_bytes(), source,
                             f"{mirror.name} 和 loader 里的 CSS 不一致，跑 node tools/sync-assets.js")

    def test_generator_is_reproducible(self) -> None:
        node = shutil.which("node")
        candidates = [node] if node else []
        candidates.append(str(Path("C:/Users/Administrator/.dsh/dsh-runtimes/"
                                   "dsh-next-primary-runtime/dependencies/node/bin/node.exe")))
        exe = next((c for c in candidates if c and Path(c).is_file()), None)
        if not exe:
            self.skipTest("找不到 node，跳过可复现性检查")
        build = ROOT / "build"
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out.css"
            vars_out = Path(tmp) / "vars.json"
            proc = subprocess.run(
                [exe, str(GEN_CSS_JS), str(build / "native-light.json"),
                 str(build / "native-dark.json"), str(out), str(vars_out), str(build / "ab.json")],
                cwd=str(ROOT), capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr[-800:])
            self.assertEqual(out.read_bytes(), LOADER_CSS.read_bytes(),
                             "仓库里的 loader CSS 和生成器输出不一致：手改过 CSS？重新生成并 sync-assets")


if __name__ == "__main__":
    unittest.main()
