#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v2 回归专项断言（QA，Round 2）。

按 team-lead 指定的 5 组「新改动」断言：
  V1 1440×900 / 1366×768 下引擎菜单最后一项必须落在视口内且可命中（elementFromPoint）
  V2 离线（favicon 请求立即失败）时 12 个默认站点在 1s 内全部显示字母块
  V3 AI 面板打开后时钟与搜索框仍完全可见且可点击（未被面板遮挡）
  V4 Dock 仅 2 个站点时容器宽度 < 300px（宽度自适应）
  V5 480×900 无横向溢出

前置：项目根目录已启动静态服务 `python -m http.server 8765`
用法：<装有 playwright 的 python> tests/v2_regression.py
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

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def info(name: str, detail: str) -> None:
    RESULTS.append(("INFO", name, detail))


LAST_ITEM_PROBE = """
() => {
  const menu = document.getElementById('engine-menu');
  const search = document.getElementById('search').getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  // 把菜单滚到底，验证最后一项确实可达（菜单是可滚动容器，未滚动时末项被自身裁剪属正常）
  menu.scrollTop = menu.scrollHeight;
  const items = [...menu.querySelectorAll('[data-engine]')];
  const last = items[items.length - 1];
  const r = last.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hit = document.elementFromPoint(cx, cy);
  return {
    vh: window.innerHeight,
    name: last.textContent.trim(),
    menu: {
      top: Math.round(mr.top),
      bottom: Math.round(mr.bottom),
      h: Math.round(mr.height),
      insideViewport: mr.top >= 0 && mr.bottom <= window.innerHeight,
      scrollable: menu.scrollHeight > menu.clientHeight,
      maxScroll: menu.scrollHeight - menu.clientHeight,
    },
    search: { top: Math.round(search.top), bottom: Math.round(search.bottom) },
    noOverlapWithSearch: mr.bottom <= search.top + 0.5 || mr.top >= search.bottom - 0.5,
    last: {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      h: Math.round(r.height),
      fullyVisible: r.top >= 0 && r.bottom <= window.innerHeight,
      hitInside: Boolean(hit && (last === hit || last.contains(hit))),
      hitDesc: hit ? (hit.className || hit.tagName) : 'none',
    },
  };
}
"""

CLOCK_SEARCH_PROBE = """
() => {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      fullyVisible: r.top >= 0 && r.left >= 0
        && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      hitInside: Boolean(hit && (el === hit || el.contains(hit))),
      hitDesc: hit ? (hit.className || hit.tagName) : 'none',
    };
  };
  const panel = document.getElementById('ai-panel');
  const pr = panel.getBoundingClientRect();
  return {
    clock: rectOf(document.getElementById('clock')),
    search: rectOf(document.getElementById('search')),
    panel: { top: Math.round(pr.top), bottom: Math.round(pr.bottom), open: panel.classList.contains('is-open') },
    vh: window.innerHeight,
  };
}
"""

DOCK_PROBE = """
() => {
  const dock = document.getElementById('dock');
  const wrap = document.getElementById('dock-wrap');
  const letters = [...document.querySelectorAll('#dock .dock-letter, #dock [class*="letter"]')]
    .filter(el => el.textContent.trim());
  return {
    items: document.querySelectorAll('#dock .dock-item').length,
    letters: letters.length,
    letterTexts: letters.map(el => el.textContent.trim()),
    dockWidth: Math.round(dock.getBoundingClientRect().width),
    wrapWidth: Math.round(wrap.getBoundingClientRect().width),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}
"""


def probe_engine_menu(browser) -> None:
    for width, height in ((1440, 900), (1366, 768)):
        ctx = browser.new_context(viewport={"width": width, "height": height}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(1500)
        page.click("#engine-chip")
        page.wait_for_timeout(400)
        data = page.evaluate(LAST_ITEM_PROBE)
        page.screenshot(path=os.path.join(SHOTS, f"v2-engine-menu-{width}x{height}.png"))
        info(f"V1 {width}×{height} 菜单与末项", json.dumps(data, ensure_ascii=False))
        check(
            f"V1 {width}×{height} 菜单整体在视口内且不与搜索框重叠",
            data["menu"]["insideViewport"] and data["noOverlapWithSearch"],
            json.dumps({"menu": data["menu"], "noOverlap": data["noOverlapWithSearch"]},
                       ensure_ascii=False),
        )
        check(
            f"V1 {width}×{height} 滚动到底后最后一项完整可见且可命中",
            data["last"]["fullyVisible"] and data["last"]["hitInside"],
            json.dumps(data["last"], ensure_ascii=False),
        )
        ctx.close()


def probe_favicon_offline(browser) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    ctx.route("**/favicons**", lambda route: route.abort())
    ctx.route("**/favicon.ico", lambda route: route.abort())
    page = ctx.new_page()
    page.goto(BASE, wait_until="load")
    # 默认 12 个站点均走 auto 图标；请求立即失败后应在 1s 内落到字母块
    page.wait_for_timeout(1000)
    data = page.evaluate(DOCK_PROBE)
    page.screenshot(path=os.path.join(SHOTS, "v2-favicon-offline.png"))
    info("V2 离线 favicon 1s 后状态", json.dumps(data, ensure_ascii=False))
    check(
        "V2 离线时 12 个默认站点 1s 内显示字母块",
        data["items"] == 12 and data["letters"] == 12,
        json.dumps(data, ensure_ascii=False),
    )
    ctx.close()


def probe_ai_panel_overlap(browser) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1500)

    before = page.evaluate(CLOCK_SEARCH_PROBE)
    info("V3 面板未打开时", json.dumps(before, ensure_ascii=False))
    check(
        "V3 基线：时钟与搜索框完整可见可点击",
        all(before[key]["fullyVisible"] and before[key]["hitInside"] for key in ("clock", "search")),
        json.dumps({"clock": before["clock"], "search": before["search"]}, ensure_ascii=False),
    )

    page.fill("#search-input", "面板遮挡检查")
    page.press("#search-input", "Enter")
    page.wait_for_timeout(1800)
    after = page.evaluate(CLOCK_SEARCH_PROBE)
    page.screenshot(path=os.path.join(SHOTS, "v2-ai-panel-overlap.png"))
    info("V3 面板打开后", json.dumps(after, ensure_ascii=False))
    check("V3 AI 面板已打开", after["panel"]["open"] is True, json.dumps(after["panel"]))
    check(
        "V3 面板打开时时钟仍完整可见且可点击",
        after["clock"]["fullyVisible"] and after["clock"]["hitInside"],
        json.dumps(after["clock"], ensure_ascii=False),
    )
    check(
        "V3 面板打开时搜索框仍完整可见且可点击",
        after["search"]["fullyVisible"] and after["search"]["hitInside"],
        json.dumps(after["search"], ensure_ascii=False),
    )

    # 面板打开时仍可输入（真实可点击性验证）
    page.click("#search-input")
    page.keyboard.type("还能输入")
    typed = page.input_value("#search-input")
    check("V3 面板打开时搜索框仍可聚焦输入", "还能输入" in typed, typed)
    ctx.close()


def probe_dock_width(browser) -> None:
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1500)
    page.evaluate(
        """async () => window.__aurora.app.updateSites([
            { id: 'w1', title: 'A', url: 'https://a.example.com', icon: { type: 'auto', value: '' } },
            { id: 'w2', title: 'B', url: 'https://b.example.com', icon: { type: 'auto', value: '' } },
        ])"""
    )
    page.wait_for_timeout(700)
    data = page.evaluate(DOCK_PROBE)
    page.screenshot(path=os.path.join(SHOTS, "v2-dock-2-sites.png"))
    info("V4 两站点时 Dock 尺寸", json.dumps(data, ensure_ascii=False))
    check(
        "V4 Dock 仅 2 个站点时容器宽度 < 300px",
        data["items"] == 2 and max(data["dockWidth"], data["wrapWidth"]) < 300,
        json.dumps(data, ensure_ascii=False),
    )
    ctx.close()


def probe_narrow(browser) -> None:
    ctx = browser.new_context(viewport={"width": 480, "height": 900}, locale="zh-CN")
    page = ctx.new_page()
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1600)
    data = page.evaluate(
        """() => {
            const dock = document.getElementById('dock');
            const search = document.getElementById('search').getBoundingClientRect();
            return {
                overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                searchRight: Math.round(search.right),
                vw: window.innerWidth,
                clockFont: parseFloat(getComputedStyle(document.getElementById('clock-time')).fontSize),
                dockScrollable: dock.scrollWidth > dock.clientWidth,
            };
        }"""
    )
    page.screenshot(path=os.path.join(SHOTS, "v2-480px.png"))
    info("V5 480×900", json.dumps(data, ensure_ascii=False))
    check("V5 480×900 无横向溢出", data["overflowX"] <= 1, json.dumps(data, ensure_ascii=False))
    check("V5 480×900 搜索框在视口内", data["searchRight"] <= data["vw"], json.dumps(data, ensure_ascii=False))
    ctx.close()


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
        probe_engine_menu(browser)
        probe_favicon_offline(browser)
        probe_ai_panel_overlap(browser)
        probe_dock_width(browser)
        probe_narrow(browser)
        browser.close()

    for level, name, detail in RESULTS:
        if level == "INFO":
            print(f"[INFO] {name} -> {detail}")
    for level, name, detail in RESULTS:
        if level == "FAIL":
            print(f"[FAIL] {name} -> {detail}")
    total = len([r for r in RESULTS if r[0] != "INFO"])
    passed = len([r for r in RESULTS if r[0] == "PASS"])
    print("-" * 78)
    print(f"PASS {passed} / FAIL {total - passed}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
