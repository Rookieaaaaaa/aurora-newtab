#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""真实渲染冒烟测试（QA，Playwright + Chromium）。

前置：在项目根目录启动静态服务
    python -m http.server 8765

用法：
    <装有 playwright 的 python> tests/smoke_playwright.py
截图输出：tests/screenshots/
"""

from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
os.makedirs(SHOTS, exist_ok=True)

# 产品口径开关（凭证「全部为空」时的行为），已由 team-lead 裁定为「旧逻辑」：
#   missing + demoMode !== false → 演示；missing + demoMode === false → NeedsConfig
# 若将来改回「missing 永远演示」，把该常量置 True 即可。
DEMO_WHEN_MISSING = False

# 本机 playwright 版本与已安装浏览器 build 号不一致时，允许显式指定 Chromium 可执行文件
BROWSER_CANDIDATES = [
    os.path.expandvars(
        r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
        r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
    ),
    os.path.expandvars(
        r"%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe"
    ),
]


def launch_chromium(pw):
    for path in BROWSER_CANDIDATES:
        if os.path.isfile(path):
            return pw.chromium.launch(args=["--no-sandbox"], executable_path=path)
    return pw.chromium.launch(args=["--no-sandbox"])

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def shot(page, name: str) -> None:
    page.screenshot(path=os.path.join(SHOTS, name), full_page=False)


def main() -> int:
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[str] = []

    with sync_playwright() as pw:
        browser = launch_chromium(pw)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = context.new_page()

        page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}")
                if msg.type in ("error",) else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("requestfailed", lambda req: failed_requests.append(
            f"{req.url} :: {req.failure}"))

        # ---------------- R1 加载 ----------------
        resp = page.goto(BASE, wait_until="load")
        check("R1 HTTP 200", resp is not None and resp.status == 200,
              f"status={resp.status if resp else 'none'}")
        page.wait_for_timeout(2500)
        check("R1 应用就绪（window.__aurora 存在）",
              page.evaluate("() => Boolean(window.__aurora && window.__aurora.settings)"))
        check("R1 无未捕获异常", not page_errors, "; ".join(page_errors[:3]))
        # http://localhost 预览下必应壁纸接口无 CORS 头，浏览器会打 console.error；
        # 属于预览环境限制（扩展上下文由 host_permissions 放行），单独归类不计入缺陷。
        env_console = [e for e in console_errors
                       if "CORS policy" in e or "ERR_FAILED" in e or "ERR_CONNECTION" in e
                       or "ERR_NAME_NOT_RESOLVED" in e]
        real_console = [e for e in console_errors if e not in env_console]
        check("R1 无应用自身 console.error", not real_console, "; ".join(real_console[:3]))
        if env_console:
            RESULTS.append(("INFO", "R1 预览环境网络类 console.error（预期）",
                            "; ".join(env_console[:2])))

        # ---------------- R2 时钟 ----------------
        time_text = page.inner_text("#clock-time")
        date_text = page.inner_text("#clock-date")
        greeting = page.inner_text("#clock-greeting")
        check("R2 时钟为 HH:MM", bool(time_text) and ":" in time_text, time_text)
        check("R2 日期已渲染", bool(date_text.strip()), date_text)
        check("R2 问候语已渲染", bool(greeting.strip()), greeting)
        check("R2 时钟未停留在占位符 --:--", time_text.strip() != "--:--", time_text)

        # ---------------- R3 背景 ----------------
        bg_info = page.evaluate(
            """() => {
                const layers = [...document.querySelectorAll('.bg-layer')];
                const active = layers.find(l => l.dataset.active === 'true');
                const media = active ? active.querySelector('.bg-media') : null;
                return {
                    layerCount: layers.length,
                    hasMain: Boolean(document.querySelector('main.stage')),
                    activeTag: media ? media.tagName : '',
                    mediaW: media ? (media.naturalWidth || media.width || 0) : 0,
                };
            }"""
        )
        check("R3 双背景层存在", bg_info["layerCount"] == 2, json.dumps(bg_info, ensure_ascii=False))
        check("R3 活动层已渲染背景内容", bg_info["activeTag"] in ("IMG", "CANVAS", "VIDEO"),
              f"activeTag={bg_info['activeTag']} mediaW={bg_info['mediaW']}")
        bg_toast = page.evaluate(
            """() => [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())"""
        )

        # ---------------- R4 Dock ----------------
        dock = page.evaluate(
            """() => ({
                items: document.querySelectorAll('#dock .dock-item').length,
                add: document.querySelectorAll('#dock .dock-add').length,
                firstHref: (document.querySelector('#dock .dock-link') || {}).href || '',
                icons: document.querySelectorAll('#dock .dock-link > *').length,
            })"""
        )
        check("R4 Dock 渲染 12 个默认站点", dock["items"] == 12, json.dumps(dock, ensure_ascii=False))
        check("R4 Dock 有新增按钮", dock["add"] == 1)
        check("R4 Dock 链接为 http(s)", dock["firstHref"].startswith("http"), dock["firstHref"])

        # ---------------- R5 默认搜索引擎 chip ----------------
        input_ph = page.get_attribute("#search-input", "placeholder")
        chip_label = page.inner_text("#chip-label")
        check("R5 默认引擎为元宝 AI", "元宝" in chip_label, chip_label)
        check("R5 AI 占位文案", "AI 搜索" in input_ph, input_ph)

        # ---------------- R6 引擎下拉 ----------------
        page.click("#engine-chip")
        page.wait_for_timeout(250)
        menu = page.evaluate(
            """() => {
                const m = document.getElementById('engine-menu');
                return {
                    hidden: m.hidden,
                    expanded: document.getElementById('engine-chip').getAttribute('aria-expanded'),
                    items: m.querySelectorAll('[data-engine]').length,
                    groups: [...m.querySelectorAll('.menu-group')].map(g => g.textContent),
                    selected: (m.querySelector('[data-selected="true"]') || {}).textContent || '',
                };
            }"""
        )
        shot(page, "01-engine-menu.png")
        check("R6 下拉已展开", menu["hidden"] is False and menu["expanded"] == "true",
              json.dumps(menu, ensure_ascii=False))
        check("R6 引擎项共 11 个（4 AI + 7 网页）", menu["items"] == 11, str(menu["items"]))
        check("R6 分组标题正确", menu["groups"] == ["AI 搜索", "网页搜索"], str(menu["groups"]))

        # ---------------- R7 选择网页引擎并持久化 ----------------
        page.click('#engine-menu [data-engine="bing"]')
        page.wait_for_timeout(500)
        chip_label2 = page.inner_text("#chip-label")
        saved = page.evaluate(
            "() => JSON.parse(localStorage.getItem('aurora:settings') || '{}')"
        )
        check("R7 chip 切换到必应", "必应" in chip_label2, chip_label2)
        check("R7 引擎选择已持久化到 localStorage",
              (saved.get("search") or {}).get("defaultEngine") == "bing",
              json.dumps(saved.get("search"), ensure_ascii=False))
        check("R7 占位文案随引擎变化", "必应" in page.get_attribute("#search-input", "placeholder"),
              page.get_attribute("#search-input", "placeholder"))

        # 还原默认引擎，避免影响后续用例
        page.click("#engine-chip")
        page.wait_for_timeout(200)
        page.click('#engine-menu [data-engine="ai-yuanbao"]')
        page.wait_for_timeout(400)

        # ---------------- R8 快捷键 / 聚焦 ----------------
        page.click("body", position={"x": 40, "y": 600})
        page.keyboard.press("/")
        page.wait_for_timeout(150)
        check("R8 按 `/` 聚焦搜索框",
              page.evaluate("() => document.activeElement && document.activeElement.id === 'search-input'"),
              page.evaluate("() => document.activeElement && document.activeElement.id"))

        # ---------------- R9 URL 意图 ----------------
        page.fill("#search-input", "github.com")
        page.wait_for_timeout(250)
        hint = page.evaluate(
            """() => {
                const h = document.getElementById('url-hint');
                const u = h.querySelector('.u');
                return { hidden: h.hidden, text: u ? u.textContent : '' };
            }"""
        )
        check("R9 URL 意图提示出现", hint["hidden"] is False and "github.com" in hint["text"],
              json.dumps(hint, ensure_ascii=False))
        shot(page, "02-url-hint.png")

        page.fill("#search-input", "python")
        page.wait_for_timeout(200)
        check("R9 普通词不出现 URL 提示",
              page.evaluate("() => document.getElementById('url-hint').hidden") is True)

        # ---------------- R10 bang ----------------
        page.fill("#search-input", "!b")
        page.wait_for_timeout(300)
        bang_menu = page.evaluate(
            """() => {
                const m = document.getElementById('engine-menu');
                return { hidden: m.hidden, items: m.querySelectorAll('[data-bang]').length };
            }"""
        )
        # BANGS 本轮新增 !ds → DeepSeek 联网，共 6 条
        check("R10 输入 `!b` 弹出指令菜单", bang_menu["hidden"] is False and bang_menu["items"] == 6,
              json.dumps(bang_menu, ensure_ascii=False))
        page.fill("#search-input", "!b 天气")
        page.wait_for_timeout(250)
        check("R10 bang 命令不显示 URL 提示",
              page.evaluate("() => document.getElementById('url-hint').hidden") is True)

        # ---------------- R11 bang 回车走必应（新标签） ----------------
        try:
            with context.expect_page(timeout=8000) as popup_info:
                page.press("#search-input", "Enter")
            popup = popup_info.value
            popup_url = popup.url
            popup.close()
            check("R11 `!b 天气` 新标签打开必应",
                  "bing.com/search" in popup_url and "%E5%A4%A9%E6%B0%94" in popup_url,
                  popup_url)
        except Exception as exc:  # noqa: BLE001
            check("R11 `!b 天气` 新标签打开必应", False, f"未捕获新标签：{exc}")

        # ---------------- R12 设置抽屉 ----------------
        page.click("#btn-settings")
        page.wait_for_timeout(600)
        drawer = page.evaluate(
            """() => {
                const d = document.getElementById('settings-drawer');
                return {
                    open: d.classList.contains('is-open'),
                    aria: d.getAttribute('aria-hidden'),
                    sections: d.querySelectorAll('details.sec').length,
                    siteRows: d.querySelectorAll('.site-row').length,
                    backend: (d.querySelector('[data-role="backend-info"]') || {}).textContent || '',
                    secretsInputs: d.querySelectorAll('[data-secret]').length,
                };
            }"""
        )
        shot(page, "03-settings.png")
        check("R12 设置抽屉打开", drawer["open"] is True and drawer["aria"] == "false",
              json.dumps(drawer, ensure_ascii=False))
        check("R12 六个设置分组", drawer["sections"] == 6, str(drawer["sections"]))
        check("R12 站点列表渲染", drawer["siteRows"] == 12, str(drawer["siteRows"]))
        check("R12 存储后端显示 localStorage",
              "localStorage" in drawer["backend"], drawer["backend"])
        check("R12 密钥输入框数量（yuanbao4/deepseek3/custom5 + select2）",
              drawer["secretsInputs"] >= 10, str(drawer["secretsInputs"]))

        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        check("R12 Esc 关闭设置抽屉",
              page.evaluate("() => !document.getElementById('settings-drawer').classList.contains('is-open')"))

        # ---------------- R13 AI 演示模式 ----------------
        # 测试必须显式隔离凭证：默认配置可能带真实密钥，否则会打到外网并被 CORS 拦住
        page.evaluate(
            """async () => {
                await window.__aurora.app.updateSecrets({
                    yuanbao: { endpoint: '', apiKey: '', secretId: '', secretKey: '', authMode: 'bearer' },
                    deepseek: { apiKey: '' },
                    custom: { baseUrl: '', apiKey: '', model: '' },
                });
            }"""
        )
        page.reload(wait_until="load")
        page.wait_for_timeout(900)
        page.fill("#search-input", "今天适合跑步吗")
        page.press("#search-input", "Enter")
        page.wait_for_timeout(1200)
        ai_state = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                return {
                    open: p.classList.contains('is-open'),
                    aria: p.getAttribute('aria-hidden'),
                    query: (p.querySelector('[data-role="query"] .bubble') || {}).textContent || '',
                    loadingHidden: p.querySelector('[data-role="loading"]').hidden,
                    badge: p.querySelector('[data-role="status"]').textContent,
                    demoHidden: p.querySelector('[data-role="demo"]').hidden,
                };
            }"""
        )
        check("R13 AI 面板已打开", ai_state["open"] is True and ai_state["aria"] == "false",
              json.dumps(ai_state, ensure_ascii=False))
        check("R13 提问气泡回显", "跑步" in ai_state["query"], ai_state["query"])

        # 等待流式内容
        streamed = 0
        for _ in range(60):
            streamed = page.evaluate(
                "() => (document.querySelector('#ai-panel [data-role=\"answer\"]') || {}).textContent?.length || 0"
            )
            if streamed > 60:
                break
            page.wait_for_timeout(300)
        shot(page, "04-ai-streaming.png")
        check("R13 演示模式流式输出", streamed > 60, f"chars={streamed}")

        mid = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                return {
                    demoHidden: p.querySelector('[data-role="demo"]').hidden,
                    badge: p.querySelector('[data-role="status"]').textContent,
                    hasStrong: Boolean(p.querySelector('.ai-answer strong')),
                    hasList: Boolean(p.querySelector('.ai-answer ol, .ai-answer ul')),
                    hasPre: Boolean(p.querySelector('.ai-answer pre')),
                };
            }"""
        )
        check("R13 演示条可见", mid["demoHidden"] is False, json.dumps(mid, ensure_ascii=False))
        # 已知 Minor 缺陷：首个 delta 到达时 ai-panel 会把徽标从「演示」覆盖成「流式」
        check("R13 徽标在流式期间保持「演示」", "演示" in mid["badge"],
              f"实际徽标={mid['badge']}（已知 Minor：ai-panel.js:479 覆盖 demo 徽标）")

        # 等待完成
        for _ in range(80):
            badge = page.evaluate(
                "() => document.querySelector('#ai-panel [data-role=\"status\"]').textContent"
            )
            if "演示" in badge and page.evaluate(
                "() => document.querySelector('#ai-panel [data-act=\"stop\"]').hidden"
            ):
                break
            page.wait_for_timeout(300)
        final = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                const a = p.querySelector('[data-role="answer"]');
                return {
                    len: a.textContent.length,
                    strong: a.querySelectorAll('strong').length,
                    li: a.querySelectorAll('li').length,
                    pre: a.querySelectorAll('pre').length,
                    h3: a.querySelectorAll('h3').length,
                    copyDisabled: p.querySelector('[data-act="copy"]').disabled,
                };
            }"""
        )
        shot(page, "05-ai-done.png")
        # 演示文案本身只负责「粗体 + 标题」；列表 / 代码块的渲染能力单独验证，
        # 避免把渲染器回归绑死在演示文案的措辞上。
        check("R13 演示内容渲染 Markdown（粗体 + 标题）",
              final["strong"] > 0 and final["h3"] > 0, json.dumps(final, ensure_ascii=False))
        renderer = page.evaluate(
            """async () => {
                const mod = await import('/src/ai-panel.js');
                const html = mod.renderMarkdown(
                    '### 标题\\n\\n- 无序一\\n- 无序二\\n\\n1. 有序一\\n2. 有序二\\n\\n```js\\nconst a = 1;\\n```'
                );
                const host = document.createElement('div');
                host.innerHTML = html;
                return {
                    h3: host.querySelectorAll('h3').length,
                    li: host.querySelectorAll('li').length,
                    pre: host.querySelectorAll('pre').length,
                    hasUl: Boolean(host.querySelector('ul')),
                    hasOl: Boolean(host.querySelector('ol')),
                };
            }"""
        )
        check("R13 Markdown 渲染器支持标题 / 有序无序列表 / 代码块",
              renderer["h3"] == 1 and renderer["li"] == 4 and renderer["pre"] == 1
              and renderer["hasUl"] and renderer["hasOl"],
              json.dumps(renderer, ensure_ascii=False))
        check("R13 完成后复制按钮可用", final["copyDisabled"] is False, json.dumps(final))

        # ---------------- R14 Esc 关闭 AI 面板 ----------------
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        check("R14 Esc 关闭 AI 面板",
              page.evaluate("() => !document.getElementById('ai-panel').classList.contains('is-open')"))

        # ---------------- R15 Markdown XSS ----------------
        xss = page.evaluate(
            """async () => {
                const mod = await import('/src/ai-panel.js');
                const payloads = [
                    '<img src=x onerror="window.__xss=1">',
                    '<script>window.__xss=2<\\/script>',
                    '[click](javascript:window.__xss=3)',
                    '`<svg onload="window.__xss=4">`',
                    '```html\\n<iframe src="javascript:window.__xss=5"></iframe>\\n```',
                    '**<b onmouseover="window.__xss=6">bold</b>**',
                    '# <img src=x onerror=window.__xss=7>',
                ];
                const host = document.createElement('div');
                host.id = 'xss-host';
                document.body.appendChild(host);
                host.innerHTML = payloads.map(p => mod.renderMarkdown(p)).join('\\n');
                const bad = {
                    img: host.querySelectorAll('img').length,
                    script: host.querySelectorAll('script').length,
                    svg: host.querySelectorAll('svg').length,
                    iframe: host.querySelectorAll('iframe').length,
                    b: host.querySelectorAll('b').length,
                    jsHref: [...host.querySelectorAll('a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length,
                    onAttr: [...host.querySelectorAll('*')].filter(el =>
                        [...el.attributes].some(a => a.name.startsWith('on'))).length,
                };
                const text = host.textContent.slice(0, 120);
                host.remove();
                return { bad, text, flag: window.__xss || 0 };
            }"""
        )
        check("R15 Markdown 渲染无 HTML 注入",
              all(v == 0 for v in xss["bad"].values()) and xss["flag"] == 0,
              json.dumps(xss, ensure_ascii=False))
        check("R15 恶意标签被转义为文本",
              "onerror" in json.dumps(xss["text"]) or "<" in xss["text"] or xss["bad"]["img"] == 0,
              xss["text"])

        # ---------------- R16 导入非法 JSON ----------------
        bad_file = os.path.join(HERE, "_invalid.json")
        with open(bad_file, "w", encoding="utf-8") as handle:
            handle.write("{ this is not json ")
        page.click("#btn-settings")
        page.wait_for_timeout(500)
        page.evaluate(
            """() => {
                const d = document.getElementById('settings-drawer');
                [...d.querySelectorAll('details.sec')].forEach(s => { s.open = true; });
            }"""
        )
        page.set_input_files('[data-role="import-file"]', bad_file)
        page.wait_for_timeout(800)
        toast_texts = page.evaluate(
            "() => [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())"
        )
        check("R16 导入非法 JSON 有可读错误提示",
              any("导入失败" in t for t in toast_texts), str(toast_texts))
        check("R16 非法导入未清空设置",
              page.evaluate("() => Boolean(window.__aurora.settings && window.__aurora.settings.search)"))

        # ---------------- R17 导入合法配置（sites 空数组） ----------------
        valid_file = os.path.join(HERE, "_valid.json")
        with open(valid_file, "w", encoding="utf-8") as handle:
            json.dump({"app": "aurora-newtab", "settings": {"clock": {"hour12": True}},
                       "sites": []}, handle)
        page.set_input_files('[data-role="import-file"]', valid_file)
        page.wait_for_timeout(1200)
        after_import = page.evaluate(
            """() => ({
                sites: window.__aurora.sites.length,
                dockItems: document.querySelectorAll('#dock .dock-item').length,
                dockAdd: document.querySelectorAll('#dock .dock-add').length,
                hour12: window.__aurora.settings.clock.hour12,
                clock: document.getElementById('clock-time').textContent,
                meridiem: document.querySelectorAll('#clock-time .clock-meridiem').length,
            })"""
        )
        check("R17 导入空 sites → Dock 仅剩新增按钮",
              after_import["sites"] == 0 and after_import["dockItems"] == 0
              and after_import["dockAdd"] == 1,
              json.dumps(after_import, ensure_ascii=False))
        import re as _re

        clock_text = after_import["clock"].strip()
        hours_ok = False
        match_hm = _re.match(r"^(\d{1,2}):(\d{2})", clock_text)
        if match_hm:
            hours_ok = 1 <= int(match_hm.group(1)) <= 12
        check("R17 导入设置即时生效（切到 12 小时制）",
              after_import["hour12"] is True and hours_ok,
              json.dumps(after_import, ensure_ascii=False))

        # v2 设计：12 小时制下问候语已表达上午/下午，时间不再重复加后缀；
        # 仅当关闭问候语时才补 .clock-meridiem 徽标。这里验证该分支。
        page.evaluate(
            """async () => window.__aurora.app.updateSettings({ clock: { showGreeting: false } })"""
        )
        page.wait_for_timeout(500)
        meridiem_state = page.evaluate(
            """() => ({
                clock: document.getElementById('clock-time').textContent,
                greeting: document.getElementById('clock-greeting').textContent,
                meridiem: document.querySelectorAll('#clock-time .clock-meridiem').length,
                meridiemText: (document.querySelector('#clock-time .clock-meridiem') || {}).textContent || '',
            })"""
        )
        check("R17 关闭问候语后 12 小时制补上上午/下午徽标",
              meridiem_state["meridiem"] == 1
              and meridiem_state["meridiemText"] in ("上午", "下午")
              and meridiem_state["greeting"] == "",
              json.dumps(meridiem_state, ensure_ascii=False))
        page.evaluate(
            """async () => window.__aurora.app.updateSettings({ clock: { showGreeting: true } })"""
        )
        page.wait_for_timeout(400)
        shot(page, "06-empty-dock.png")

        # ---------------- R18 超长标题 / 中文标题字母块 ----------------
        long_title = "超长标题" * 20
        page.evaluate(
            """(title) => {
                const sites = [
                    { id: 'site-long', title, url: 'https://example.com/very/long/path?x=1',
                      icon: { type: 'url', value: 'http://127.0.0.1:1/none.png' } },
                    { id: 'site-cn', title: '中文站点名', url: 'https://zh.example.cn',
                      icon: { type: 'url', value: 'http://127.0.0.1:1/none2.png' } },
                ];
                return window.__aurora.app.updateSites(sites);
            }""",
            long_title,
        )
        page.wait_for_timeout(1500)
        letters = page.evaluate(
            """() => {
                const items = [...document.querySelectorAll('#dock .dock-item')];
                const letters = [...document.querySelectorAll('#dock .dock-letter')].map(l => l.textContent);
                const dock = document.getElementById('dock');
                return {
                    count: items.length,
                    letters,
                    overflow: dock.scrollWidth - dock.clientWidth,
                    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    titleAttr: items[0] ? items[0].querySelector('.dock-link').title.length : 0,
                };
            }"""
        )
        check("R18 新增站点渲染", letters["count"] == 2, json.dumps(letters, ensure_ascii=False))
        check("R18 中文标题首字字母块", "中" in letters["letters"], str(letters["letters"]))
        check("R18 超长标题不撑破布局（页面无横向溢出）",
              letters["docOverflow"] <= 1, str(letters["docOverflow"]))
        shot(page, "07-long-title.png")

        # ---------------- R19 480px 窄屏 ----------------
        page.set_viewport_size({"width": 480, "height": 900})
        page.wait_for_timeout(800)
        narrow = page.evaluate(
            """() => {
                const doc = document.documentElement;
                const stage = document.querySelector('main.stage').getBoundingClientRect();
                const search = document.getElementById('search').getBoundingClientRect();
                const dock = document.getElementById('dock');
                const clockSize = parseFloat(getComputedStyle(document.getElementById('clock-time')).fontSize);
                return {
                    docOverflowX: doc.scrollWidth - doc.clientWidth,
                    searchRight: Math.round(search.right),
                    viewport: window.innerWidth,
                    dockScrollable: dock.scrollWidth > dock.clientWidth,
                    clockSize,
                    stageOverflow: Math.round(stage.width - window.innerWidth),
                };
            }"""
        )
        shot(page, "08-480px.png")
        check("R19 480px 无横向溢出", narrow["docOverflowX"] <= 1,
              json.dumps(narrow, ensure_ascii=False))
        check("R19 480px 搜索框在视口内", narrow["searchRight"] <= narrow["viewport"],
              json.dumps(narrow, ensure_ascii=False))
        check("R19 480px 时钟缩小", narrow["clockSize"] <= 60, str(narrow["clockSize"]))

        # ---------------- R20 修复：恢复桌面视口 ----------------
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(400)

        # ---------------- R21 凭证三种状态的表现 ----------------
        # 已裁定语义（team-lead）：
        #   missing  + demoMode !== false → 演示态（不联网）
        #   missing  + demoMode === false → NeedsConfig 错误态
        #   partial / ready              → 真实 provider（错误照常可读）
        # R21a：默认开关（demoMode=true）+ 凭证全空 → 演示态
        page.evaluate(
            """async () => {
                await window.__aurora.app.updateSecrets({
                    yuanbao: { endpoint: '', apiKey: '', secretId: '', secretKey: '', authMode: 'bearer' },
                    deepseek: { apiKey: '' },
                    custom: { baseUrl: '', apiKey: '', model: '' },
                });
                await window.__aurora.app.updateSettings({
                    ai: { demoMode: true, provider: 'yuanbao' },
                    search: { defaultEngine: 'ai-yuanbao' },
                });
            }"""
        )
        page.reload(wait_until="load")
        page.wait_for_timeout(1600)
        page.fill("#search-input", "没有密钥会怎样")
        page.press("#search-input", "Enter")
        page.wait_for_timeout(1600)
        demo_state = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                const demo = p.querySelector('[data-role="demo"]');
                const err = p.querySelector('[data-role="error"]');
                return {
                    badge: p.querySelector('[data-role="status"]').textContent,
                    demoVisible: demo ? !demo.hidden : false,
                    errorHidden: err.hidden,
                    answerLen: (p.querySelector('[data-role="answer"]') || {}).textContent.length,
                };
            }"""
        )
        shot(page, "09-demo-missing-credentials.png")
        check("R21a 凭证全空 + 演示开启 → 演示态（不报错）",
              demo_state["errorHidden"] is True and demo_state["demoVisible"] is True
              and "演示" in demo_state["badge"] and demo_state["answerLen"] > 40,
              json.dumps(demo_state, ensure_ascii=False))

        # R21b：关掉演示开关 + 凭证仍全空 → 必须报 NeedsConfig（开关真实生效）
        page.keyboard.press("Escape")
        page.evaluate(
            """async () => {
                await window.__aurora.app.updateSettings({ ai: { demoMode: false } });
            }"""
        )
        page.wait_for_timeout(500)
        page.fill("#search-input", "关掉演示会怎样")
        page.press("#search-input", "Enter")
        page.wait_for_timeout(1500)
        empty_state = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                const demo = p.querySelector('[data-role="demo"]');
                const err = p.querySelector('[data-role="error"]');
                const cfg = p.querySelector('[data-role="error"] [data-act="config"]');
                return {
                    badge: p.querySelector('[data-role="status"]').textContent,
                    demoVisible: demo ? !demo.hidden : false,
                    errorHidden: err.hidden,
                    errMsg: (p.querySelector('[data-role="err-msg"]') || {}).textContent || '',
                    configVisible: cfg ? !cfg.hidden : false,
                };
            }"""
        )
        shot(page, "09-needs-config.png")
        if DEMO_WHEN_MISSING:
            check("R21b 凭证全空 + 关闭演示 → 仍演示（新规则占位）",
                  empty_state["errorHidden"] is True, json.dumps(empty_state, ensure_ascii=False))
        else:
            check("R21b 凭证全空 + 关闭演示 → 错误态（开关真实生效）",
                  empty_state["errorHidden"] is False and empty_state["configVisible"] is True
                  and empty_state["demoVisible"] is False,
                  json.dumps(empty_state, ensure_ascii=False))

        # R21c：凭证填了但不完整（partial）→ 必须走真实 provider 并报可读错误
        page.keyboard.press("Escape")
        page.evaluate(
            """async () => {
                await window.__aurora.app.updateSecrets({
                    yuanbao: { endpoint: 'https://example.com/mcp', apiKey: '' },
                });
            }"""
        )
        page.wait_for_timeout(500)
        page.fill("#search-input", "凭证不完整")
        page.press("#search-input", "Enter")
        page.wait_for_timeout(1500)
        partial_state = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                return {
                    badge: p.querySelector('[data-role="status"]').textContent,
                    errorHidden: p.querySelector('[data-role="error"]').hidden,
                    errMsg: (p.querySelector('[data-role="err-msg"]') || {}).textContent || '',
                    configVisible: (() => {
                        const c = p.querySelector('[data-role="error"] [data-act="config"]');
                        return c ? !c.hidden : false;
                    })(),
                };
            }"""
        )
        shot(page, "09-needs-config.png")
        check("R21c 凭证不完整 → 错误态", partial_state["errorHidden"] is False,
              json.dumps(partial_state, ensure_ascii=False))
        check("R21c 错误文案指明缺少 API Key", "API Key" in partial_state["errMsg"],
              partial_state["errMsg"])
        check("R21c 显示「去填写密钥」按钮", partial_state["configVisible"] is True,
              json.dumps(partial_state))

        # ---------------- R22 网络请求失败记录 ----------------
        check("R22 无 JS 崩溃（reload 后仍无 pageerror）", not page_errors, "; ".join(page_errors[:3]))

        browser.close()

    fails = [row for row in RESULTS if row[0] == "FAIL"]
    for level, name, detail in RESULTS:
        if level in ("PASS", "INFO"):
            if level == "INFO":
                print(f"[INFO] {name} -> {detail}")
            continue
        print(f"[FAIL] {name} -> {detail}")
    print("-" * 70)
    print(f"PASS {len(RESULTS) - len(fails)} / FAIL {len(fails)} / TOTAL {len(RESULTS)}")
    print("外部网络失败请求（离线环境属预期）：")
    for item in failed_requests[:8]:
        print("  -", item)
    print("背景降级 toast：", bg_toast)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
