#!/usr/bin/env python3
"""loader_report 契约测试：诊断上报必须容错、必须截断、必须有上限。

为什么要这组测试：``loader_report`` 是唯一一条「页面 → 插件目录」的旁路写入口，
它每次整体覆写 diagnostics.json。三类真实风险：

1. **版本错配**：旧/新加载器送来的类型与当前解析不一致（字符串数字、布尔、对象），
   以前直接 ``int(...)`` 会让入口抛异常，正好在最需要诊断的时刻丢记录。
2. **无上限写入**：attrs / samples / history 不封顶时，一个渲染 bug 就能把插件目录
   写成几十 MB，还会拖慢下一次上报。
3. **历史失控**：history 只该保留最近 20 条，否则每次上报都复制一遍陈年样本。

跑法：cd plugin && python -m unittest discover -s tests -p "test_loader_report.py" -v
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from offline_backend import load_backend
from test_library_archive import make_plugin, unwrap

NS = load_backend()
Plugin = NS["NekoThemeStudioPlugin"]


class LoaderReportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.plugin = make_plugin(Path(self.tmp.name))

    def _send(self, payload):
        return asyncio.run(self.plugin.loader_report(report=payload))

    def _diag(self) -> dict:
        path = self.plugin.static_dir / "diagnostics.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_normal_report_is_persisted(self) -> None:
        ok, value = unwrap(self._send({
            "page": "/",
            "version": "1.6.39",
            "ntsVars": 164,
            "mtVars": 0,
            "rules": 58,
            "cssLen": 56095,
            "focusRules": 1,
            "attrs": {"data-theme": "dark"},
            "samples": {"--nts-mt-bg-c": "rgba(1, 2, 3, 0.5)", "--other": "x"},
        }))
        self.assertTrue(ok, value)
        self.assertTrue(value["path"].endswith("diagnostics.json"))
        diag = self._diag()
        self.assertEqual(diag["nts_vars"], 164)
        self.assertEqual(diag["loader_version"], "1.6.39")
        self.assertEqual(diag["samples"], {"--nts-mt-bg-c": "rgba(1, 2, 3, 0.5)"})
        self.assertEqual(diag["attrs"]["data-theme"], "dark")

    def test_hostile_types_do_not_raise(self) -> None:
        ok, value = unwrap(self._send({
            "ntsVars": "abc", "mtVars": None, "rules": {"a": 1}, "cssLen": [1, 2],
            "focusRules": "12", "mtRuleCount": -5, "mtDeclCount": 1.9,
            "errors": "not-a-list", "centerChain": "--nts-mt-bg quiet", "attrs": "x",
        }))
        self.assertTrue(ok, value)
        diag = self._diag()
        self.assertEqual(diag["nts_vars"], 0)
        self.assertEqual(diag["mt_vars"], 0)
        self.assertEqual(diag["rules"], 0)
        self.assertEqual(diag["css_len"], 0)
        self.assertEqual(diag["focus_rules"], 12, "数字字符串应当被接受")
        self.assertEqual(diag["mt_rule_count"], 0, "负数退回默认值")
        self.assertEqual(diag["mt_decl_count"], 1, "浮点向下取整")
        self.assertEqual(diag["errors"], [], "字符串不是数组，必须当空")
        self.assertEqual(diag["center_chain"], [], "字符串链路不能拆成单字符")
        self.assertEqual(diag["attrs"], {})

    def test_attrs_and_samples_are_capped(self) -> None:
        attrs = {("k%02d" % i): "v" * 500 for i in range(80)}
        samples = {("--nts-x%02d" % i): "s" * 500 for i in range(40)}
        ok, value = unwrap(self._send({"attrs": attrs, "samples": samples,
                                       "errors": ["e" * 900] * 40}))
        self.assertTrue(ok, value)
        diag = self._diag()
        self.assertLessEqual(len(diag["attrs"]), 40)
        self.assertLessEqual(max(len(v) for v in diag["attrs"].values()), 200)
        self.assertLessEqual(len(diag["samples"]), 20)
        self.assertLessEqual(max(len(v) for v in diag["samples"].values()), 160)
        self.assertLessEqual(len(diag["errors"]), 20)
        self.assertLessEqual(max(len(e) for e in diag["errors"]), 400)

    def test_history_keeps_last_twenty(self) -> None:
        for i in range(25):
            unwrap(self._send({"page": "/p%d" % i, "ntsVars": i}))
        diag = self._diag()
        self.assertEqual(len(diag["history"]), 20)
        self.assertEqual(diag["history"][-1]["nts_vars"], 24)
        self.assertEqual(diag["history"][0]["nts_vars"], 5)

    def test_non_object_report_is_rejected(self) -> None:
        # 离线桩里 Ok/Err 不可区分，这里直接看返回值内容（错误文案）
        for payload in (["nope"], None, "x"):
            result = asyncio.run(self.plugin.loader_report(report=payload))
            self.assertEqual(result.value, "report 必须是对象。")
        self.assertFalse((self.plugin.static_dir / "diagnostics.json").exists(),
                         "被拒绝的上报不能落盘")


if __name__ == "__main__":
    unittest.main()
