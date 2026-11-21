"""AI-THEME-GUIDE.md 的守卫测试。

指南是「人类 + AI」写主题的唯一规格书，内容必须和代码对齐，否则 AI 会照着错的
契约生成不可导入的 JSON。这里断言：

1. 文件存在，章节结构完整；
2. 95 个变量全部出现在总表里（代码新增变量而忘了重新生成 → 立刻红）；
3. 指南里的**可导入示例**（```json 块）真的能过插件自己的校验器、且对比度全绿。
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from offline_backend import ROOT, load_backend

GUIDE = ROOT / "AI-THEME-GUIDE.md"


def read_guide() -> str:
    if not GUIDE.is_file():
        raise AssertionError(f"缺少 {GUIDE}，跑 `python _work/gen_ai_guide.py` 生成")
    return GUIDE.read_text(encoding="utf-8")


class GuideStructureTests(unittest.TestCase):
    def test_guide_exists_and_has_sections(self) -> None:
        text = read_guide()
        for prefix in (
            "## 0. ", "## 1. ", "## 2. 变量总表", "## 3. 类型与合法取值",
            "## 4. 风格族", "## 5. ", "## 6. 配方", "## 7. 校验",
            "## 8. 常见错误", "## 9. 完整示例", "## 10. ", "## 11. 变量影响面",
        ):
            self.assertTrue(prefix in text, f"指南缺少章节：{prefix}")

    def test_every_known_variable_is_documented(self) -> None:
        text = read_guide()
        missing = sorted(v for v in load_backend()["KNOWN_VARS"] if v not in text)
        self.assertEqual(missing, [], f"指南里缺少这些变量（重新生成指南）：{missing}")


class GuideExampleTests(unittest.TestCase):
    def _strict_blocks(self) -> list[str]:
        return re.findall(r"```json\n(.*?)```", read_guide(), re.S)

    def test_importable_examples_pass_backend_validation(self) -> None:
        ns = load_backend()
        validate = ns["_validate_palette"]
        blocks = self._strict_blocks()
        self.assertGreaterEqual(len(blocks), 2, "至少要有『最快上手』和『完整示例』两个可导入示例")
        for raw in blocks:
            with self.subTest(example=raw[:40]):
                theme = json.loads(raw)
                self.assertIsInstance(theme.get("name"), str)
                self.assertTrue(theme["name"].strip())
                clean_vars, clean_dark, errors = validate(
                    theme.get("vars"), theme.get("dark_vars")
                )
                self.assertEqual(errors, [], f"示例里有被拒的值：{errors}")
                self.assertTrue(clean_vars or clean_dark)

    def test_field_contract_block_is_marked_non_importable(self) -> None:
        text = read_guide()
        self.assertIn("不是可直接导入的文件", text)


class ValidatorToolTests(unittest.TestCase):
    def test_validator_script_is_runnable_source(self) -> None:
        path = ROOT / "_work" / "validate_theme.py"
        self.assertTrue(path.is_file(), "缺少 _work/validate_theme.py")
        source = path.read_text(encoding="utf-8")
        self.assertIn("def main(", source)
        self.assertIn("_work/validate_theme.py", source)


if __name__ == "__main__":
    unittest.main()
