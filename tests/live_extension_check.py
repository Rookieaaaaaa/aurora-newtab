#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""临时验证：真实 Chrome 扩展上下文里，TC3 签名的云 API 请求能否直连成功。

用法：<装有 playwright 的 python> tests/_live_extension_check.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe")
PROFILE = os.path.join(ROOT, "tests", ".tmp-ext-profile")


def read_ext_id(user_dir: str) -> str:
    """从 profile 的 Preferences 读取已加载扩展的真实 ID。"""
    for rel in (
        os.path.join("Default", "Preferences"),
        os.path.join("Default", "Secure Preferences"),
        "Preferences",
    ):
        path = os.path.join(user_dir, rel)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:  # noqa: BLE001
            continue
        settings = ((data.get("extensions") or {}).get("settings") or {})
        for key in settings:
            if len(key) == 32 and all("a" <= ch <= "p" for ch in key):
                return key
    return ""


def launch(p):
    return p.chromium.launch_persistent_context(
        PROFILE,
        headless=True,
        executable_path=CHROME,
        viewport={"width": 1440, "height": 900},
        locale="zh-CN",
        args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}"],
    )


def main() -> int:
    if os.path.isdir(PROFILE):
        shutil.rmtree(PROFILE, ignore_errors=True)

    with sync_playwright() as p:
        # 预热：让 Chrome 把扩展写入 Preferences，再读真实 ID
        warm = launch(p)
        (warm.pages[0] if warm.pages else warm.new_page()).wait_for_timeout(3000)
        warm.close()
        ext_id = read_ext_id(PROFILE)
        print("扩展 ID:", ext_id or "(未读到)")
        if not ext_id:
            return 1

        page_url = f"chrome-extension://{ext_id}/newtab.html"
        context = launch(p)
        page = context.pages[0] if context.pages else context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(page_url, wait_until="load")
        page.wait_for_timeout(1500)
        print("页面标题:", page.title())

        result = page.evaluate(
            """async () => {
                const mod = await import('./src/providers/yuanbao-mcp.js');
                const { DEFAULT_SETTINGS, DEFAULT_SECRETS } = await import('./src/defaults.js');
                const out = { sources: null, meta: null, error: '', text: '' };
                try {
                    await mod.run({
                        query: '腾讯云云开发是什么',
                        settings: DEFAULT_SETTINGS,
                        secrets: DEFAULT_SECRETS,
                        onSources: (list, meta) => { out.sources = list; out.meta = meta; },
                        onDelta: (d) => { out.text += d; },
                    });
                } catch (err) {
                    out.error = String(err && err.message ? err.message : err);
                }
                return {
                    count: out.sources ? out.sources.length : 0,
                    meta: out.meta,
                    error: out.error,
                    first: out.sources && out.sources[0] ? {
                        title: out.sources[0].title.slice(0, 40),
                        site: out.sources[0].site,
                        icon: out.sources[0].icon,
                        date: out.sources[0].date,
                        score: out.sources[0].score,
                    } : null,
                    textLen: out.text.length,
                };
            }"""
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if errors:
            print("pageerror:", "; ".join(errors[:3]))
        page.screenshot(path=os.path.join(ROOT, "tests", "screenshots", "29-tc3-live-extension.png"))
        context.close()

    ok = result.get("count", 0) > 0 and not result.get("error")
    print("\n结论:", "扩展内直连成功" if ok else "扩展内直连失败")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
