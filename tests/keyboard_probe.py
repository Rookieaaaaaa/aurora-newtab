#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""键盘可达性探针（QA）：验证引擎 chip 的 Enter / Space 是否能确认选中。

用法：<装有 playwright 的 python> tests/keyboard_probe.py
"""

from __future__ import annotations

import json
import os

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
SHELL = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
    r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
)


def main() -> int:
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(1500)

        page.focus("#engine-chip")
        page.keyboard.press("Enter")          # 打开菜单
        page.wait_for_timeout(300)
        opened = page.evaluate(
            "() => ({ open: !document.getElementById('engine-menu').hidden,"
            " expanded: document.getElementById('engine-chip').getAttribute('aria-expanded') })"
        )
        page.keyboard.press("ArrowDown")      # 高亮下一项（DeepSeek）
        page.wait_for_timeout(200)
        active = page.evaluate(
            """() => {
                const item = document.querySelector('#engine-menu .menu-item[data-active="true"]');
                return item ? item.textContent.trim() : '';
            }"""
        )
        page.keyboard.press("Enter")          # 期望：确认选中；实际：再下移一格
        page.wait_for_timeout(400)
        after = page.evaluate(
            """() => ({
                menuOpen: !document.getElementById('engine-menu').hidden,
                chipLabel: document.getElementById('chip-label').textContent,
                active: (() => {
                    const item = document.querySelector('#engine-menu .menu-item[data-active="true"]');
                    return item ? item.textContent.trim() : '';
                })(),
            })"""
        )
        page.screenshot(path=os.path.join(SHOTS, "19-chip-enter.png"))
        rows.append({"opened": opened, "activeBeforeEnter": active, "afterEnter": after})
        ctx.close()
        browser.close()

    print(json.dumps(rows, ensure_ascii=False, indent=2))
    result = rows[0]
    ok = (result["afterEnter"]["menuOpen"] is False
          and result["afterEnter"]["chipLabel"].strip() == result["activeBeforeEnter"])
    print("-" * 70)
    print("chip 上 Enter 可确认选中：", "PASS" if ok else "FAIL")
    print(f"PASS {1 if ok else 0} / FAIL {0 if ok else 1}")
    print(f"  按下 Enter 前高亮={result['activeBeforeEnter']!r}，"
          f"Enter 后菜单打开={result['afterEnter']['menuOpen']}，"
          f"chip 文案={result['afterEnter']['chipLabel']!r}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
