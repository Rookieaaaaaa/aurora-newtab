#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""定向探针（QA）：覆盖冒烟脚本难以一次断言完的行为。

A. 演示模式徽标随时间的变化（复现「演示」被「流式」覆盖）
B. favicon 三级降级（长时间等待后是否落到字母块）
C. 中文输入法组合期回车不提交
D. Esc 层级关闭顺序（Dock 菜单优先于 AI 面板）
E. 拖拽排序后是否落库
F. 秒针模式下的定时刷新（验证 schedule 生效）
G. 以真实扩展方式加载（--load-extension），验证 MV3 上下文 + chrome.storage + CSP

用法：<装有 playwright 的 python> tests/focused_probe.py
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHOTS = os.path.join(HERE, "screenshots")
os.makedirs(SHOTS, exist_ok=True)

CHROME = os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe")
HEADLESS_SHELL = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
    r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
)

RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def info(name: str, detail: str) -> None:
    RESULTS.append(("INFO", name, detail))


def unpacked_id(path: str) -> str:
    digest = hashlib.sha256(path.encode("utf-8")).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


def probe_badge(page) -> None:
    """A. 演示模式徽标变化。"""
    # 显式隔离凭证：默认配置可能带真实密钥，否则会打到外网并转成错误态
    page.evaluate(
        """async () => {
            await window.__aurora.app.updateSecrets({
                yuanbao: { endpoint: '', apiKey: '', secretId: '', secretKey: '', authMode: 'bearer' },
                deepseek: { apiKey: '' },
                custom: { baseUrl: '', apiKey: '', model: '' },
            });
        }"""
    )
    page.wait_for_timeout(400)
    page.fill("#search-input", "徽标观察")
    page.press("#search-input", "Enter")
    seen: list[str] = []
    for _ in range(40):
        badge = page.evaluate(
            "() => document.querySelector('#ai-panel [data-role=\"status\"]').textContent"
        )
        if not seen or seen[-1] != badge:
            seen.append(badge)
        page.wait_for_timeout(120)
    info("A. 演示模式徽标序列", " -> ".join(seen))
    check(
        "A. 演示模式流式期间徽标保持「演示」",
        all("演示" in s or "准备" in s for s in seen[:-1]) if len(seen) > 1 else True,
        " -> ".join(seen),
    )
    page.wait_for_timeout(300)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def probe_favicon(page) -> None:
    """B. favicon 三级降级（外部图片请求已在 main 里被 route 立即 aborted，避免受网络超时影响）。"""
    page.evaluate(
        """() => window.__aurora.app.updateSites([
            { id: 's1', title: '中文站点名', url: 'https://zh.example.cn', icon: { type: 'auto', value: '' } },
            { id: 's2', title: 'BrokenIcon', url: 'https://example.com', icon: { type: 'url', value: 'http://127.0.0.1:1/none.png' } },
        ])"""
    )
    letters = []
    for _ in range(20):
        letters = page.evaluate(
            "() => [...document.querySelectorAll('#dock .dock-letter')].map(l => l.textContent)"
        )
        if len(letters) >= 2:
            break
        page.wait_for_timeout(500)
    info("B. 10s 后字母块", f"{len(letters)} -> {letters}")
    check("B. 自动图标失败后降级为字母块（三级降级）", len(letters) == 2, str(letters))
    check("B. 中文标题取首字", "中" in letters, str(letters))
    page.screenshot(path=os.path.join(SHOTS, "10-favicon-fallback.png"))


def probe_ime(page) -> None:
    """C. 输入法组合期回车不提交。"""
    page.fill("#search-input", "zhongwen")
    page.evaluate(
        """() => {
            const input = document.getElementById('search-input');
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
            }));
        }"""
    )
    page.wait_for_timeout(600)
    opened = page.evaluate("() => document.getElementById('ai-panel').classList.contains('is-open')")
    value = page.input_value("#search-input")
    page.evaluate(
        """() => document.getElementById('search-input')
            .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))"""
    )
    check("C. 组合期回车不触发 AI 请求", opened is False, f"panelOpen={opened}")
    check("C. 组合期输入内容保留", value == "zhongwen", value)
    page.fill("#search-input", "")


def probe_esc_order(page) -> None:
    """D. Esc 层级顺序：Dock 菜单 → AI 面板。"""
    page.fill("#search-input", "层级测试")
    page.press("#search-input", "Enter")
    page.wait_for_timeout(800)
    page.hover("#dock .dock-item:first-child")
    page.click("#dock .dock-item:first-child .dock-more")
    page.wait_for_timeout(400)
    state1 = page.evaluate(
        """() => ({
            ctx: Boolean(document.querySelector('.ctx-menu')),
            ai: document.getElementById('ai-panel').classList.contains('is-open'),
        })"""
    )
    page.keyboard.press("Escape")
    page.wait_for_timeout(350)
    state2 = page.evaluate(
        """() => ({
            ctx: Boolean(document.querySelector('.ctx-menu')),
            ai: document.getElementById('ai-panel').classList.contains('is-open'),
        })"""
    )
    page.keyboard.press("Escape")
    page.wait_for_timeout(350)
    state3 = page.evaluate(
        "() => document.getElementById('ai-panel').classList.contains('is-open')"
    )
    check("D. Dock 菜单与 AI 面板可同时存在", state1["ctx"] and state1["ai"],
          json.dumps(state1))
    check("D. 第一次 Esc 只关闭 Dock 菜单", state2["ctx"] is False and state2["ai"] is True,
          json.dumps(state2))
    check("D. 第二次 Esc 关闭 AI 面板", state3 is False, str(state3))


def probe_drag(page) -> None:
    """E. 拖拽排序落库。"""
    page.evaluate(
        """() => window.__aurora.app.updateSites([
            { id: 'a', title: 'A', url: 'https://a.example.com', icon: { type: 'auto', value: '' } },
            { id: 'b', title: 'B', url: 'https://b.example.com', icon: { type: 'auto', value: '' } },
            { id: 'c', title: 'C', url: 'https://c.example.com', icon: { type: 'auto', value: '' } },
        ])"""
    )
    page.wait_for_timeout(500)
    before = page.evaluate("() => window.__aurora.sites.map(s => s.id)")
    page.evaluate(
        """() => {
            const items = [...document.querySelectorAll('#dock .dock-item')];
            const dt = new DataTransfer();
            items[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            items[2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
            items[2].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
            items[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        }"""
    )
    page.wait_for_timeout(900)
    after = page.evaluate("() => window.__aurora.sites.map(s => s.id)")
    stored = page.evaluate(
        "() => JSON.parse(localStorage.getItem('aurora:sites') || '[]').map(s => s.id)"
    )
    dom_order = page.evaluate(
        "() => [...document.querySelectorAll('#dock .dock-item')].map(i => i.dataset.id)"
    )
    check("E. 拖拽后内存顺序变化", before != after, f"{before} -> {after}")
    check("E. 拖拽后顺序已落库 localStorage", stored == after, f"stored={stored} mem={after}")
    check("E. 拖拽后 DOM 顺序一致", dom_order == after, f"dom={dom_order}")


def probe_clock_seconds(page) -> None:
    """F. 秒针模式定时刷新。"""
    page.evaluate(
        """async () => { await window.__aurora.app.updateSettings({ clock: { showSeconds: true } }); }"""
    )
    page.wait_for_timeout(400)
    first = page.inner_text("#clock-time")
    page.wait_for_timeout(1600)
    second = page.inner_text("#clock-time")
    check("F. 开启秒后时间每秒刷新", first != second and second.count(":") == 2,
          f"{first} -> {second}")
    page.evaluate(
        """async () => { await window.__aurora.app.updateSettings({ clock: { showSeconds: false } }); }"""
    )
    page.wait_for_timeout(300)


def probe_extension(pw) -> None:
    """G. 真实扩展上下文加载（先启动一次让 Chromium 写入 Preferences 取真实 ID）。"""
    if not os.path.isfile(CHROME):
        info("G. 扩展上下文验证", f"未找到 Chromium：{CHROME}，跳过")
        return
    user_dir = tempfile.mkdtemp(prefix="aurora-profile-")
    args = [
        f"--disable-extensions-except={os.path.abspath(ROOT)}",
        f"--load-extension={os.path.abspath(ROOT)}",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    def real_extension_id() -> str:
        """从 profile 的 Preferences 中读取已加载扩展的真实 ID。"""
        for rel in (os.path.join("Default", "Preferences"),
                    os.path.join("Default", "Secure Preferences"),
                    "Preferences"):
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

    ext_id = ""
    try:
        warm = pw.chromium.launch_persistent_context(
            user_dir, headless=True, executable_path=CHROME, args=args,
            viewport={"width": 1440, "height": 900}, locale="zh-CN",
        )
        warm_page = warm.pages[0] if warm.pages else warm.new_page()
        warm_page.wait_for_timeout(3000)
        warm.close()
        ext_id = real_extension_id()
    except Exception as exc:  # noqa: BLE001
        info("G. 扩展上下文验证", f"预热启动失败：{exc}")
        return

    info("G. 真实扩展 ID", ext_id or "未能从 Preferences 读取")
    if not ext_id:
        info("G. 扩展上下文验证", "无法确定扩展 ID，跳过 chrome-extension:// 页面验证")
        return

    try:
        ctx = pw.chromium.launch_persistent_context(
            user_dir, headless=True, executable_path=CHROME, args=args,
            viewport={"width": 1440, "height": 900}, locale="zh-CN",
        )
    except Exception as exc:  # noqa: BLE001
        info("G. 扩展上下文验证", f"启动带扩展的 Chromium 失败：{exc}")
        return

    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda err: errors.append(str(err)))
    url = f"chrome-extension://{ext_id}/newtab.html"
    try:
        page.goto(url, wait_until="load", timeout=15000)
        page.wait_for_timeout(2500)
        state = page.evaluate(
            """() => ({
                ready: Boolean(window.__aurora && window.__aurora.settings),
                hasChromeStorage: Boolean(window.chrome && chrome.storage && chrome.storage.local),
                runtimeId: (window.chrome && chrome.runtime && chrome.runtime.id) || '',
                backend: (document.querySelector('[data-role="backend-info"]') || {}).textContent || '',
                clock: (document.getElementById('clock-time') || {}).textContent || '',
                dockItems: document.querySelectorAll('#dock .dock-item').length,
            })"""
        )
        page.screenshot(path=os.path.join(SHOTS, "11-extension-context.png"))
        check("G. chrome-extension:// 页面可加载", state["ready"] is True,
              json.dumps(state, ensure_ascii=False))
        check("G. 扩展上下文存在 chrome.storage.local", state["hasChromeStorage"] is True)
        check("G. chrome.runtime.id 与目录推导一致",
              state["runtimeId"] == ext_id, f"runtime={state['runtimeId']} expect={ext_id}")
        check("G. 扩展页无未捕获异常", not errors, "; ".join(errors[:3]))
        check("G. 扩展页 Dock 正常渲染", state["dockItems"] == 12, str(state["dockItems"]))

        # chrome.storage.local 真实读写链路
        storage_probe = page.evaluate(
            """async () => {
                const mod = await import('/src/storage.js');
                await mod.patchSettings({ search: { defaultEngine: 'baidu' } });
                const settings = await mod.getSettings();
                const backend = mod.getBackend();
                const payload = await mod.exportConfig();
                const raw = await new Promise(res => chrome.storage.local.get('settings', r => res(r)));
                return {
                    backend,
                    engine: settings.search.defaultEngine,
                    inChromeStorage: Boolean(raw && raw.settings),
                    exportHasSecrets: JSON.stringify(payload).includes('apiKey'),
                };
            }"""
        )
        check("G. chrome.storage 写入/读取链路可用",
              storage_probe["inChromeStorage"] and storage_probe["engine"] == "baidu",
              json.dumps(storage_probe, ensure_ascii=False))
        check("G. 扩展上下文 getBackend() == chrome", storage_probe["backend"] == "chrome",
              storage_probe["backend"])
        check("G. 导出内容不含 apiKey", storage_probe["exportHasSecrets"] is False,
              json.dumps(storage_probe, ensure_ascii=False))

        # CSP：扩展页内联脚本应被拦截
        csp = page.evaluate(
            """() => {
                const s = document.createElement('script');
                s.textContent = 'window.__inlineRan = 1';
                document.body.appendChild(s);
                return window.__inlineRan === 1;
            }"""
        )
        check("G. MV3 CSP 拦截内联脚本", csp is False, f"inlineRan={csp}")

        # 扩展上下文里的必应壁纸（host_permissions 绕过 CORS）
        bg = page.evaluate(
            """async () => {
                const r = await fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN')
                    .then(res => ({ ok: res.ok, status: res.status }))
                    .catch(err => ({ ok: false, status: String(err) }));
                return r;
            }"""
        )
        info("G. 扩展上下文访问必应壁纸接口", json.dumps(bg, ensure_ascii=False))

        # 等待真实壁纸渲染（验证落图链路 + 记录首屏加载时长）
        waited = 0
        bg_state = {}
        while waited < 20000:
            bg_state = page.evaluate(
                """() => {
                    const media = document.querySelector('.bg-layer[data-active="true"] .bg-media');
                    return {
                        tag: media ? media.tagName : '',
                        w: media ? (media.naturalWidth || media.width || 0) : 0,
                        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
                    };
                }"""
            )
            if bg_state["tag"] == "IMG" and bg_state["w"] > 0:
                break
            page.wait_for_timeout(500)
            waited += 500
        page.screenshot(path=os.path.join(SHOTS, "12-extension-context-loaded.png"))
        info("G. 扩展上下文首屏背景", f"{waited}ms -> {json.dumps(bg_state, ensure_ascii=False)}")
        check("G. 扩展上下文背景最终渲染出图片",
              bg_state["tag"] == "IMG" and bg_state["w"] > 0,
              json.dumps(bg_state, ensure_ascii=False))

        # 扩展页里打开设置（校验内联 style 属性未被 CSP 拦截）+ 跑一次演示问答
        console_msgs: list[str] = []
        page.on("console", lambda msg: console_msgs.append(f"{msg.type}: {msg.text}"))
        page.click("#btn-settings")
        page.wait_for_timeout(900)
        drawer = page.evaluate(
            """() => {
                const d = document.getElementById('settings-drawer');
                const probe = d.querySelector('[data-role="pane-bing"]') || d;
                return {
                    open: d.classList.contains('is-open'),
                    width: Math.round(d.getBoundingClientRect().width),
                    inlineStyleApplied: getComputedStyle(
                        d.querySelector('.field[style]') || probe).marginTop,
                    backend: (d.querySelector('[data-role="backend-info"]') || {}).textContent || '',
                };
            }"""
        )
        page.screenshot(path=os.path.join(SHOTS, "14-extension-settings.png"))
        check("G. 扩展页设置抽屉可打开", drawer["open"] is True, json.dumps(drawer, ensure_ascii=False))
        check("G. 内联 style 属性未被 CSP 拦截", drawer["inlineStyleApplied"] != "0px",
              json.dumps(drawer, ensure_ascii=False))
        check("G. 扩展页存储后端显示 chrome.storage",
              "chrome.storage" in drawer["backend"], drawer["backend"])
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        # 扩展上下文同样需要隔离凭证，否则会走真实请求
        page.evaluate(
            """async () => {
                await window.__aurora.app.updateSecrets({
                    yuanbao: { endpoint: '', apiKey: '', secretId: '', secretKey: '', authMode: 'bearer' },
                    deepseek: { apiKey: '' },
                    custom: { baseUrl: '', apiKey: '', model: '' },
                });
            }"""
        )
        page.wait_for_timeout(400)
        page.fill("#search-input", "扩展内演示")
        page.press("#search-input", "Enter")
        demo_len = 0
        for _ in range(40):
            demo_len = page.evaluate(
                "() => (document.querySelector('#ai-panel [data-role=\"answer\"]') || {}).textContent?.length || 0"
            )
            if demo_len > 100:
                break
            page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOTS, "15-extension-ai-demo.png"))
        # 演示文案当前为 136 字符（同一段固定文本），阈值取 100 即可判定「流式真的在跑」；
        # 不再用文案长度反推渲染能力（列表 / 代码块改由 smoke R13 直接验证渲染器）。
        check("G. 扩展上下文演示模式流式输出正常", demo_len > 100, f"chars={demo_len}")
        csp_violations = [m for m in console_msgs
                          if "Content Security Policy" in m or "Refused to" in m]
        check("G. 扩展页无 CSP 违规日志", not csp_violations, "; ".join(csp_violations[:3]))
    except Exception as exc:  # noqa: BLE001
        check("G. chrome-extension:// 页面可加载", False, f"{exc}")
    finally:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=HEADLESS_SHELL, args=["--no-sandbox"])
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
        page = context.new_page()
        # 让外部图标请求立即失败，使 favicon 降级逻辑不依赖真实网络超时
        context.route(
            "**://www.google.com/s2/favicons**", lambda route: route.abort()
        )
        context.route("**://zh.example.cn/**", lambda route: route.abort())
        context.route("**://example.com/**", lambda route: route.abort())
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(2000)

        probe_ime(page)
        probe_badge(page)
        probe_esc_order(page)
        probe_clock_seconds(page)
        probe_drag(page)
        probe_favicon(page)

        browser.close()
        probe_extension(pw)

    fails = [row for row in RESULTS if row[0] == "FAIL"]
    for level, name, detail in RESULTS:
        if level == "PASS":
            continue
        print(f"[{level}] {name} -> {detail}")
    print("-" * 70)
    print(f"PASS {len([r for r in RESULTS if r[0] == 'PASS'])} / FAIL {len(fails)} / "
          f"TOTAL {len([r for r in RESULTS if r[0] != 'INFO'])}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
