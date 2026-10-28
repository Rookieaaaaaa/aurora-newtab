#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""布局探针（QA）：引擎下拉在 900px 视口下是否溢出、窄屏表现。

用法：<装有 playwright 的 python> tests/layout_probe.py
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

MEASURE = """
() => {
  const menu = document.getElementById('engine-menu');
  const mr = menu.getBoundingClientRect();
  menu.scrollTop = menu.scrollHeight;          // 菜单自身可滚动，滚到底再看末项可达性
  const items = [...menu.querySelectorAll('[data-engine]')];
  const last = items[items.length - 1].getBoundingClientRect();
  const cx = Math.round(last.left + last.width / 2);
  const cy = Math.round(last.top + last.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    menu: {
      top: Math.round(mr.top), bottom: Math.round(mr.bottom), height: Math.round(mr.height),
      insideViewport: mr.top >= 0 && mr.bottom <= window.innerHeight,
    },
    scroll: { scrollHeight: menu.scrollHeight, clientHeight: menu.clientHeight,
              maxHeight: getComputedStyle(menu).maxHeight },
    flipped: menu.classList.contains('is-above'),
    itemCount: items.length,
    lastItem: {
      name: items[items.length - 1].textContent.trim(),
      top: Math.round(last.top), bottom: Math.round(last.bottom),
      fullyVisible: last.top >= 0 && last.bottom <= window.innerHeight,
      hitInside: Boolean(hit && (hit === document.elementFromPoint(cx, cy)) && (hit.className || '').length >= 0),
    },
    unreachable: !(last.top >= 0 && last.bottom <= window.innerHeight),
  };
}
"""


def run() -> int:
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
        for w, h in ((1440, 900), (1366, 768), (1440, 760), (480, 900)):
            ctx = browser.new_context(viewport={"width": w, "height": h}, locale="zh-CN")
            page = ctx.new_page()
            page.goto(BASE, wait_until="load")
            page.wait_for_timeout(1500)
            page.click("#engine-chip")
            page.wait_for_timeout(400)
            data = page.evaluate(MEASURE)
            data["viewportRequested"] = f"{w}x{h}"
            rows.append(data)
            page.screenshot(path=os.path.join(SHOTS, f"13-engine-menu-{w}x{h}.png"))
            ctx.close()
        browser.close()

    for row in rows:
        print(json.dumps(row, ensure_ascii=False))
    bad = [r for r in rows if not r["menu"]["insideViewport"] or r["unreachable"]]
    print("-" * 70)
    print(f"PASS {len(rows) - len(bad)} / FAIL {len(bad)}")
    for row in bad:
        print(f"  {row['viewportRequested']}: menu={row['menu']} last={row['lastItem']}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(run())
