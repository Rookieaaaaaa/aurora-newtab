#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""AI 搜索能力的逻辑层回归（QA）：不依赖浏览器与外网。

覆盖本轮新增 / 改动的纯逻辑：
  cache.js 缓存语义、deepseek-search 归一化与错误映射、deep 模式降级、
  空结果不调 LLM、缓存命中、providers/index 注册与 kind、defaults 引擎与 bang、
  storage 设置夹取与老数据兼容、ai-panel 的 dedupeSources / 新鲜度判定。

实现方式：调用 tests/logic_probe.mjs（Node ESM，import 真实源码 + fetch 桩），
本脚本负责汇总断言结果，并对源码做语法校验与 CSS 静态核查。

用法：
    python tests/test_ai_search.py            # 只看汇总
    python tests/test_ai_search.py -v         # 打印每条用例
退出码：0 全部通过；1 有失败。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PROBE = os.path.join(HERE, "logic_probe.mjs")

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
        return handle.read()


# --------------------------------------------------------------------------- #
# 1. 语法：src 下所有 ES Module 均可被 Node 解析
# --------------------------------------------------------------------------- #
def check_syntax() -> None:
    files = []
    for base, _dirs, names in os.walk(os.path.join(ROOT, "src")):
        for name in names:
            if name.endswith(".js"):
                files.append(os.path.relpath(os.path.join(base, name), ROOT).replace("\\", "/"))
    if not files:
        check("src 下存在 .js 文件", False, "未找到任何源文件")
        return
    bad = []
    for path in sorted(files):
        with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
            proc = subprocess.run(
                ["node", "--input-type=module", "--check"],
                stdin=handle,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
        if proc.returncode != 0:
            bad.append(f"{path}: {(proc.stderr or '').strip().splitlines()[:1]}")
    check(
        f"语法：{len(files)} 个 ES Module 通过 node --check",
        not bad,
        "; ".join(bad),
    )


# --------------------------------------------------------------------------- #
# 2. 逻辑层：运行 Node 探针
# --------------------------------------------------------------------------- #
def run_probe() -> tuple[int, int]:
    if not os.path.isfile(PROBE):
        check("逻辑探针存在", False, PROBE)
        return 0, 1
    proc = subprocess.run(
        ["node", PROBE],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    if proc.returncode != 0 or not (proc.stdout or "").strip():
        check(
            "逻辑探针可执行",
            False,
            f"exit={proc.returncode} err={(proc.stderr or '')[-500:]}",
        )
        return 0, 1
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        check("逻辑探针输出为合法 JSON", False, f"{exc}；输出前 200 字：{proc.stdout[:200]}")
        return 0, 1

    cases = payload.get("cases") or []
    check("逻辑探针用例数 ≥ 60", len(cases) >= 60, f"实际 {len(cases)}")
    passes = 0
    for case in cases:
        name = str(case.get("name") or "未命名")
        if case.get("ok"):
            check(f"逻辑：{name}", True, str(case.get("detail") or ""))
            passes += 1
        else:
            check(f"逻辑：{name}", False, str(case.get("detail") or ""))
    return passes, len(cases) - passes


# --------------------------------------------------------------------------- #
# 3. 样式静态核查（新增徽章 / 空态 / 停止色）
# --------------------------------------------------------------------------- #
def check_styles() -> None:
    css = read("styles/panels.css")
    rules = [
        (r"\.res-badge\b", ".res-badge 徽章样式"),
        (r'\.res-badge\[data-tone="auth"\]', "权威徽章配色"),
        (r'\.res-badge\[data-tone="new"\]', "新鲜徽章配色"),
        (r'\.res-badge\[data-tone="cache"\]', "缓存徽章配色"),
        (r"\.res-badge\[data-tone=\"?source\"?\]", "来源徽章配色"),
        (r"\.ai-empty\b", "空结果态样式"),
        (r'\.badge\[data-tone="stop"\]', "已停止徽章配色"),
        (r"\.res-meta\b", "结果 meta 行样式"),
    ]
    for pattern, label in rules:
        check(f"样式：{label} 存在", re.search(pattern, css) is not None)
    meta_blocks = re.findall(r"\.res-meta\s*\{[^}]*\}", css)
    check(
        "样式：.res-meta 允许换行（flex-wrap）",
        any("flex-wrap" in block for block in meta_blocks),
        f"{len(meta_blocks)} 个 .res-meta 规则，均无 flex-wrap",
    )
    fav_block = re.search(r"\.res-fav\s*\{[^}]*\}", css)
    check("样式：.res-fav favicon 尺寸已定义", bool(fav_block))


# --------------------------------------------------------------------------- #
# 4. 源码接线核查（避免「函数写了但没被调用」）
# --------------------------------------------------------------------------- #
def check_wiring() -> None:
    panel = read("src/ai-panel.js")
    settings = read("src/settings.js")
    providers_index = read("src/providers/index.js")

    wiring = [
        (panel, r"dedupeSources\(Array\.isArray\(sources\)", "ai-panel: renderResults 调用 dedupeSources"),
        (panel, r"this\.setPane\('results'\);", "ai-panel: focusResult 会切回结果页签"),
        (panel, r"isFreshDate\(source\.date\)", "ai-panel: 使用 isFreshDate 判定「新」"),
        (panel, r"authority\s*>=\s*3", "ai-panel: 权威徽章阈值 ≥3"),
        (panel, r"favicon\.im", "ai-panel: favicon 降级链含 favicon.im"),
        (panel, r"google\.com/s2/favicons", "ai-panel: favicon 降级链含 Google s2"),
        (panel, r"img\.remove\(\)", "ai-panel: favicon 全部失败时移除节点"),
        (panel, r"provider\.meta\.kind", "ai-panel: isSearch 依据 provider.meta.kind"),
        (settings, r'data-secret="deepseek\.webSearch"', "settings: 联网搜索开关绑定"),
        (settings, r'data-secret="deepseek\.searchDepth"', "settings: 深度模式下拉绑定"),
        (settings, r'data-path="ai\.searchFreshness"', "settings: 时效筛选下拉绑定"),
        (settings, r"isCheckbox\s*=\s*el\.type === 'checkbox'", "settings: 密钥绑定支持 checkbox"),
        (settings, r"PROVIDER_IDS\.forEach", "settings: provider 面板显隐从 PROVIDER_IDS 派生"),
        (settings, r"webSearch !== false", "settings: 测试连接按联网开关追加真实搜索"),
        (providers_index, r"kind:\s*'search'", "providers: META 声明 kind"),
        (providers_index, r"providerId === 'deepseek' \|\| providerId === 'deepseek-search'",
         "providers: configState 复用 deepseek.apiKey"),
    ]
    for text, pattern, label in wiring:
        check(f"接线：{label}", re.search(pattern, text) is not None)


def main() -> int:
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    check_syntax()
    run_probe()
    check_styles()
    check_wiring()

    fails = [row for row in RESULTS if row[0] == "FAIL"]
    if verbose:
        print("-" * 74)
        for level, name, detail in RESULTS:
            if level == "FAIL" or verbose:
                print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    else:
        for level, name, detail in fails:
            print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    print("-" * 74)
    total = len([row for row in RESULTS if row[0] == "PASS"]) + len(fails)
    print(f"PASS {total - len(fails)} / FAIL {len(fails)} / TOTAL {total}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
