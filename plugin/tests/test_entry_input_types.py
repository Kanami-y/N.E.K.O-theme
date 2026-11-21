#!/usr/bin/env python3
"""入口参数类型守卫：非字符串参数必须回 Err，不能抛 AttributeError（500）。

为什么要这组测试：`_work/audit_entry_fuzz.py` 对 20 个入口塞了 248 次非法输入，
唯一炸掉的是 export_to_file —— 它对 kind / target / name 直接 .strip()，收到数字或
对象就是 AttributeError。面板虽然只送字符串，但入口是公开契约（宿主、脚本、未来的
面板版本都可能调），报错应该是 Err 而不是未捕获异常。

跑法：cd plugin && python -m unittest discover -s tests -p "test_entry_input_types.py" -v
"""
from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from offline_backend import load_backend
from test_library_archive import make_plugin, must_err

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]


class ExportToFileArgGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plugin = make_plugin(Path(self.tmp.name))

    def _export(self, **kwargs):
        return asyncio.run(self.plugin.export_to_file(**kwargs))

    def test_non_string_kind_is_rejected(self) -> None:
        for bad in (123, {"a": 1}, [], True):
            with self.subTest(kind=bad):
                must_err(self, self._export(kind=bad), "kind 必须是字符串")

    def test_non_string_target_is_rejected(self) -> None:
        for bad in (123, {"a": 1}, [], False):
            with self.subTest(target=bad):
                must_err(self, self._export(target=bad), "target 必须是字符串")

    def test_non_string_name_is_rejected(self) -> None:
        for bad in (123, {"a": 1}, []):
            with self.subTest(name=bad):
                must_err(self, self._export(name=bad), "name 必须是字符串")

    def test_string_arguments_still_work(self) -> None:
        """守卫不能误伤正常字符串：不支持的格式仍走原来的分支。"""
        must_err(self, self._export(kind="bogus"), "不支持的导出格式")
        must_err(self, self._export(target="elsewhere"), "不支持的导出位置")


if __name__ == "__main__":
    unittest.main()
