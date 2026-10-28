#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一键回归入口（QA）：依次运行全部测试套件并汇总。

前置：项目根目录已启动静态服务
    python -m http.server 8765

用法：
    <装有 playwright 的 python> tests/run_all.py

退出码：0 全部通过；1 有失败。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable

SUITES = [
    ("静态审计", "static_audit.py", None),
    ("搜索逻辑", "test_ai_search.py", PY),
    ("TC3 签名", "test_tc3.py", PY),
    ("单元测试", "unit_browser.py", PY),
    ("渲染冒烟", "smoke_playwright.py", PY),
    ("定向探针", "focused_probe.py", PY),
    ("Provider 联调", "mock_provider_test.py", PY),
    ("联网搜索 DOM", "deepseek_web_test.py", PY),
    ("布局探针", "layout_probe.py", PY),
    ("v2 专项", "v2_regression.py", PY),
    ("键盘探针", "keyboard_probe.py", PY),
]

SUMMARY = re.compile(r"PASS (\d+) / FAIL (\d+)")


def main() -> int:
    overall_fail = 0
    rows = []
    for label, script, interpreter in SUITES:
        cmd = [interpreter or PY, os.path.join(HERE, script)]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        output = (proc.stdout or "") + (proc.stderr or "")
        match = SUMMARY.search(output)
        if match:
            passed, failed = int(match.group(1)), int(match.group(2))
        else:
            passed, failed = 0, 1 if proc.returncode else 0
        overall_fail += failed + (1 if proc.returncode and not match else 0)
        rows.append((label, script, passed, failed, proc.returncode))
        tail = "\n".join(
            line for line in output.splitlines()
            if line.startswith(("[FAIL]", "   ", "溢出", "  ")) and "外部网络" not in line
        )
        if failed or proc.returncode:
            print(f"--- {label} ({script}) 失败明细 ---")
            print(tail[-3000:])

    print("=" * 78)
    print(f"{'套件':<16}{'通过':>6}{'失败':>6}  脚本")
    for label, script, passed, failed, code in rows:
        flag = "" if code == 0 else "  <= 非零退出"
        print(f"{label:<16}{passed:>6}{failed:>6}  {script}{flag}")
    total_failed = sum(row[3] for row in rows)
    print("=" * 78)
    print(f"合计失败：{total_failed}")
    return 0 if overall_fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
