#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""腾讯云 TC3 签名与元宝云 API 接入的回归（QA）：不依赖外网。

覆盖：
  - src/providers/tc3.js 签名算法（幂等、Authorization 结构、UTC 日期、缺失密钥）
  - 鉴权方式判定（tc3 / bearer / 自动）与 configState 分支
  - 元宝 Pages 归一化新增字段（favicon → icon、content、pics、authority_level）
  - 云 API 错误码中文映射
  - TC3 模式请求形态（Action/Version 走请求头、body 不含公共参数）
  - Bearer 向后兼容
  - 缓存命中
  - 源码接线（设置页绑定、默认 endpoint、provider 注册）

实现方式：调用 tests/tc3_probe.mjs（Node ESM，import 真实源码 + fetch 桩）。

用法：
    python tests/test_tc3.py            # 只看失败与汇总
    python tests/test_tc3.py -v         # 打印每条用例
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
PROBE = os.path.join(HERE, "tc3_probe.mjs")

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def read(path: str) -> str:
    with open(os.path.join(ROOT, path), "r", encoding="utf-8") as handle:
        return handle.read()


def run_probe() -> None:
    if not os.path.isfile(PROBE):
        check("TC3 探针存在", False, PROBE)
        return
    proc = subprocess.run(
        ["node", PROBE],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    stdout = (proc.stdout or "").strip()
    if not stdout:
        check("TC3 探针可执行", False, f"exit={proc.returncode} err={(proc.stderr or '')[-400:]}")
        return
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        check("TC3 探针输出为合法 JSON", False, f"{exc}；前 200 字：{stdout[:200]}")
        return

    cases = payload.get("cases") or []
    check("TC3 探针用例数 ≥ 35", len(cases) >= 35, f"实际 {len(cases)}")
    for case in cases:
        name = str(case.get("name") or "未命名")
        check(f"逻辑：{name}", bool(case.get("ok")), str(case.get("detail") or ""))


def check_wiring() -> None:
    tc3 = read("src/providers/tc3.js")
    yuanbao = read("src/providers/yuanbao-mcp.js")
    index = read("src/providers/index.js")
    settings = read("src/settings.js")
    defaults = read("src/defaults.js")

    wiring = [
        (tc3, r"TC3-HMAC-SHA256", "tc3.js: 使用 TC3-HMAC-SHA256"),
        (tc3, r"crypto\.subtle\.sign", "tc3.js: 通过 WebCrypto 计算 HMAC"),
        (tc3, r"SignedHeaders=\$\{signedHeaders\}", "tc3.js: 组装 SignedHeaders"),
        (tc3, r"toISOString\(\)\.slice\(0, 10\)", "tc3.js: credential 日期取 UTC"),
        (yuanbao, r"import \{ signTc3 \} from './tc3\.js'", "yuanbao: 引入签名模块"),
        (yuanbao, r"export function useTc3", "yuanbao: 导出 useTc3"),
        (yuanbao, r"authMode", "yuanbao: 支持 authMode"),
        (yuanbao, r"wsa\.tencentcloudapi\.com", "yuanbao: 云 API 默认域名"),
        (yuanbao, r"await signTc3\(", "yuanbao: 发起请求前调用签名"),
        (yuanbao, r"TC_ERROR_HINTS", "yuanbao: 云 API 错误码映射表"),
        (yuanbao, r"ResourceNotFound", "yuanbao: 未开通资源提示"),
        (yuanbao, r"'favicon'", "yuanbao: 解析 favicon 字段"),
        (yuanbao, r"icon,", "yuanbao: 归一化输出 icon"),
        (index, r"cfg\.secretId", "index: configState 识别 SecretId"),
        (index, r"cfg\.secretKey", "index: configState 识别 SecretKey"),
        (settings, r'data-secret="yuanbao\.secretId"', "settings: SecretId 输入绑定"),
        (settings, r'data-secret="yuanbao\.secretKey"', "settings: SecretKey 输入绑定"),
        (settings, r'data-secret="yuanbao\.authMode"', "settings: 鉴权方式下拉绑定"),
        (settings, r"syncYuanbaoAuth", "settings: 鉴权方式切换字段显隐"),
        (defaults, r"authMode: 'tc3'", "defaults: 默认走 TC3 签名"),
        (defaults, r"endpoint: 'https://wsa\.tencentcloudapi\.com/'", "defaults: 默认云 API 地址"),
    ]
    for text, pattern, label in wiring:
        check(f"接线：{label}", re.search(pattern, text) is not None)

    # 密钥字段必须存在，但不允许把具体密钥写进断言（避免测试文件泄露凭证）
    check(
        "接线：defaults 提供 SecretId 字段（值不落测试）",
        re.search(r"secretId:\s*'", defaults) is not None,
    )
    check(
        "接线：defaults 提供 SecretKey 字段（值不落测试）",
        re.search(r"secretKey:\s*'", defaults) is not None,
    )


def main() -> int:
    verbose = "-v" in sys.argv or "--verbose" in sys.argv
    run_probe()
    check_wiring()

    fails = [row for row in RESULTS if row[0] == "FAIL"]
    if verbose:
        print("-" * 74)
        for level, name, detail in RESULTS:
            print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    else:
        for level, name, detail in fails:
            print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    print("-" * 74)
    total = len(RESULTS)
    print(f"PASS {total - len(fails)} / FAIL {len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
