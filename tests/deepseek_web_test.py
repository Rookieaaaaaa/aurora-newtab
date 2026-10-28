#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DeepSeek 联网搜索的 DOM / 交互层回归（QA，Playwright + Chromium + 本地 mock）。

不依赖真实密钥与外网：本地起一个 OpenAI/DeepSeek 兼容的 mock 服务，
把 secrets.deepseek.baseUrl 指向它，验证本轮改动在真实浏览器里的表现：

  D1 结果列表渲染（编号 / 标题 / 站点 / 相关度 / 来源徽章 / 用时）
  D2 徽章：权威（authority≥3）/ 新（7 天内）/ 相关度（非有限值不显示）
  D3 favicon 降级链：site_icon 非法 → favicon.im → Google s2 → 移除节点
  D4 去重：同 URL、同域名近似标题，保留高分，编号在去重之后
  D5 空结果态 .ai-empty（且不请求 LLM）
  D6 缓存命中：「缓存」徽章 + 不重复检索 + 总结仍重新生成
  D7 引用点击：从「AI 总结」页签点 [n] 自动切回「搜索结果」并高亮
  D7b 停止：「已停止」+ data-tone=stop，且不会被 abort 分支回写「已完成」
  D8 纯对话 provider 仍走单页布局（不出现结果页签 / 空结果态）
  D9 设置页：provider 卡片随注册表派生、联网开关 checkbox 布尔持久化、时效下拉持久化

前置：项目根目录已启动静态服务
    python -m http.server 8765 --bind 127.0.0.1
用法：
    <装有 playwright 的 python> tests/deepseek_web_test.py
"""

from __future__ import annotations

import json
import os
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
MOCK_PORT = 8800
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
SHELL = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
    r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
)

RESULTS: list[tuple[str, str, str]] = []
STATE: dict = {
    "scenario": "normal",
    "search": 0,
    "fetch": 0,
    "chat": 0,
    "last_search": None,
}

# 1x1 透明 PNG（用于让 Google s2 favicon 请求「成功」，从而停在中间降级档）
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000d49444154789c6360000002000154a24f5f0000000049454e44ae"
    "426082"
)


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def info(name: str, detail: str) -> None:
    RESULTS.append(("INFO", name, detail))


def day(offset: int) -> str:
    return (date.today() - timedelta(days=offset)).isoformat()


def scenario(name: str) -> None:
    STATE["scenario"] = name


# --------------------------------------------------------------------------- #
# mock 服务：/v1/tools/search · /v1/tools/fetch · /v1/chat/completions
# --------------------------------------------------------------------------- #
NORMAL_RESULTS = [
    {
        "title": "腾讯云云开发入门",
        "url": "https://cloud.tencent.com/a",
        "snippet": "云开发（CloudBase）是腾讯云提供的 Serverless 后端服务。",
        "summary": "摘要备用",
        "site_name": "腾讯云开发者社区",
        "site_icon": "https://cloud.tencent.com/favicon.ico",
        "rerank_score": 2.4,
        "authority": 4,
        "date": day(2),
    },
    {
        "title": "云开发与自建后端对比",
        "url": "https://example.org/b",
        "snippet": "从成本与运维角度看两种方案的差异。",
        "site_name": "示例站",
        "rerank_score": 1.5,
        "authority": 1,
        "date": day(60),
    },
    {
        "title": "Serverless 实践笔记",
        "url": "https://example.net/c",
        "snippet": "",
        "summary": "snippet 为空时回落到 summary。",
        "rerank_score": 0.9,
        "authority": -1,
        "date": None,
    },
]

BADGE_RESULTS = [
    {
        "title": "权威且新",
        "url": "https://auth.test/1",
        "snippet": "authority=4 且 1 天内",
        "rerank_score": 3,
        "authority": 4,
        "date": day(1),
    },
    {
        "title": "一般来源",
        "url": "https://normal.test/2",
        "snippet": "authority=2 且 30 天前",
        "rerank_score": 1.5,
        "authority": 2,
        "date": day(30),
    },
    {
        "title": "未知来源无分数",
        "url": "https://unknown.test/3",
        "snippet": "authority=-1 且无 rerank_score",
        "authority": -1,
    },
]

DUP_RESULTS = [
    {"title": "标题甲完全一致的内容", "url": "https://x.test/a", "rerank_score": 2.7, "snippet": "高分"},
    {"title": "标题甲完全一致的内容", "url": "https://x.test/a/#frag", "rerank_score": 0.9, "snippet": "低分"},
    {"title": "长标题重复测试案例说明甲乙丙", "url": "https://y.test/1", "rerank_score": 1.5, "snippet": "低分"},
    {"title": "长标题重复测试案例说明甲乙丙", "url": "https://y.test/2", "rerank_score": 2.1, "snippet": "高分"},
]

ICON_RESULTS = [
    {
        "title": "无合法图标的站点",
        "url": "https://nofav.test/page",
        "snippet": "site_icon 非法，应走 favicon.im 降级链",
        "site_icon": "javascript:alert(1)",
        "rerank_score": 2,
        "authority": 0,
        "date": day(3),
    }
]

# 与 ICON_RESULTS 结构一致但换域名：避免浏览器图片缓存导致「降级链已走完」的假象
ICON2_RESULTS = [
    {
        "title": "无合法图标的站点二",
        "url": "https://nofav2.test/page",
        "snippet": "两个降级源都失败时应移除 img",
        "site_icon": "javascript:alert(1)",
        "rerank_score": 2,
        "authority": 0,
        "date": day(3),
    }
]


def results_for_scenario() -> list:
    name = STATE["scenario"]
    if name == "empty":
        return []
    if name == "badges":
        return BADGE_RESULTS
    if name == "dup":
        return DUP_RESULTS
    if name == "icons":
        return ICON_RESULTS
    if name == "icons2":
        return ICON2_RESULTS
    return NORMAL_RESULTS


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401, ANN002
        return

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self._cors()
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except Exception:  # noqa: BLE001
            payload = {}

        if self.path.endswith("/tools/search"):
            STATE["search"] += 1
            STATE["last_search"] = payload
            self._json(200, {"results": results_for_scenario()})
            return

        if self.path.endswith("/tools/fetch"):
            STATE["fetch"] += 1
            url = str(payload.get("url") or "")
            if STATE["scenario"] == "fetchfail":
                self._json(403, {"error": {"message": "forbidden"}})
                return
            self._json(200, {"title": "抓取到的标题", "content": f"正文内容 for {url}"})
            return

        if self.path.endswith("/chat/completions"):
            STATE["chat"] += 1
            slow = STATE["scenario"] == "slowchat"
            tokens = ["根据资料", "[1]", "，云开发是 ", "Serverless", " 后端服务", "[2]", "。"]
            self.send_response(200)
            self._cors()
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "keep-alive")
            self.end_headers()
            try:
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                for token in tokens:
                    frame = (
                        "data: "
                        + json.dumps({"choices": [{"delta": {"content": token}}]}, ensure_ascii=False)
                        + "\n\n"
                    ).encode()
                    self.wfile.write(frame)
                    self.wfile.flush()
                    time.sleep(0.55 if slow else 0.02)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                STATE["chat_aborted"] = True
            return

        self._json(404, {"error": {"message": f"unknown path {self.path}"}})


def start_mock() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# --------------------------------------------------------------------------- #
# 页面辅助
# --------------------------------------------------------------------------- #
def ask(page, query: str, timeout_ms: int = 20000) -> dict:
    """提交一次 AI 提问并等到「结束」（停止按钮隐藏 + 有内容）。"""
    page.fill("#search-input", query)
    page.press("#search-input", "Enter")
    waited = 0
    state: dict = {}
    while waited < timeout_ms:
        state = page.evaluate(
            """() => {
                const p = document.getElementById('ai-panel');
                const stop = p.querySelector('[data-act="stop"]');
                return {
                    badge: p.querySelector('[data-role="status"]').textContent,
                    answer: (p.querySelector('[data-role="answer"]') || {}).textContent || '',
                    errorHidden: p.querySelector('[data-role="error"]').hidden,
                    errMsg: (p.querySelector('[data-role="err-msg"]') || {}).textContent || '',
                    stopHidden: stop ? stop.hidden : true,
                };
            }"""
        )
        if state["errorHidden"] is False:
            return state
        if state["stopHidden"] and (state["answer"] or state["badge"] in ("已完成", "已停止", "演示")):
            return state
        page.wait_for_timeout(250)
        waited += 250
    return state


def snapshot(page) -> dict:
    """抓取结果面板的关键状态。"""
    return page.evaluate(
        """() => {
            const p = document.getElementById('ai-panel');
            const tabs = p.querySelector('[data-role="tabs"]');
            const paneResults = p.querySelector('[data-role="results"]');
            const empty = p.querySelector('[data-role="empty"]');
            const items = [...p.querySelectorAll('.res-list .res-item')];
            const status = p.querySelector('[data-role="status"]');
            const source = p.querySelector('[data-role="res-source"]');
            const cached = p.querySelector('[data-role="res-cached"]');
            return {
                badge: status.textContent,
                tone: status.dataset.tone || '',
                tabsHidden: tabs.hidden,
                tabsCount: (p.querySelector('[data-role="tab-count"]') || {}).textContent || '',
                resultsHidden: paneResults.hidden,
                emptyHidden: empty.hidden,
                resCount: (p.querySelector('[data-role="res-count"]') || {}).textContent || '',
                elapsed: (p.querySelector('[data-role="res-elapsed"]') || {}).textContent || '',
                sourceText: source.textContent,
                sourceHidden: source.hidden,
                cachedHidden: cached.hidden,
                items: items.map((li) => ({
                    index: li.getAttribute('data-index'),
                    num: (li.querySelector('.res-num') || {}).textContent || '',
                    title: (li.querySelector('.res-title') || {}).textContent || '',
                    site: (li.querySelector('.res-site') || {}).textContent || '',
                    score: (li.querySelector('.res-score') || {}).textContent || '',
                    tones: [...li.querySelectorAll('.res-badge')].map((b) => b.dataset.tone),
                    favSrc: (li.querySelector('.res-fav') || {}).src || '',
                    hasFav: Boolean(li.querySelector('.res-fav')),
                })),
                cites: [...p.querySelectorAll('.ai-answer a.cite')].map((a) => a.textContent),
                answerPaneHidden: p.querySelector('[data-pane="answer"]').hidden,
            };
        }"""
    )


def configure(page, extra_settings: dict | None = None) -> None:
    """把 provider 指向本地 mock，并清空缓存。"""
    settings = {"ai": {"provider": "deepseek-search", "demoMode": True, "maxSources": 20}}
    if extra_settings:
        for group, patch in extra_settings.items():
            settings.setdefault(group, {}).update(patch)
    # 输入框 Enter 走的是 search.defaultEngine，必须与 ai.provider 对齐
    engine_of = {
        "yuanbao": "ai-yuanbao",
        "deepseek": "ai-deepseek",
        "deepseek-search": "ai-deepseek-web",
        "custom": "ai-custom",
    }
    provider = settings["ai"]["provider"]
    settings.setdefault("search", {})["defaultEngine"] = engine_of.get(provider, "ai-yuanbao")
    page.evaluate(
        """async ({ port, settings }) => {
            const { clearCache } = await import('/src/providers/cache.js');
            clearCache();
            await window.__aurora.app.updateSecrets({
                deepseek: {
                    apiKey: 'mock-key',
                    baseUrl: `http://127.0.0.1:${port}/v1`,
                    model: 'mock-model',
                    webSearch: true,
                    searchDepth: 'normal',
                },
            });
            await window.__aurora.app.updateSettings(settings);
        }""",
        {"port": MOCK_PORT, "settings": settings},
    )
    page.wait_for_timeout(250)


def reset_panel(page) -> None:
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)


def toggle_checkbox(page, selector: str, checked: bool) -> str:
    """切换 checkbox：优先真实点击；抽屉内元素超出视口时退回 JS 派发 change 事件。

    两条路径都验证 wireSecretBindings 用的是 el.checked 布尔值。
    """
    locator = page.locator(selector)
    try:
        locator.scroll_into_view_if_needed(timeout=3000)
        if checked:
            locator.check(force=True, timeout=4000)
        else:
            locator.uncheck(force=True, timeout=4000)
        return "click"
    except Exception:  # noqa: BLE001
        page.evaluate(
            """({ selector, checked }) => {
                const el = document.querySelector(selector);
                if (!el) throw new Error('未找到 ' + selector);
                el.checked = checked;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            {"selector": selector, "checked": checked},
        )
        return "js"


def main() -> int:
    server = start_mock()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
            page = ctx.new_page()
            page.goto(BASE, wait_until="load")
            page.wait_for_timeout(1500)

            # ----------------------------------------------------------------- #
            # D1 正常渲染
            # ----------------------------------------------------------------- #
            scenario("normal")
            configure(page)
            before = dict(STATE)
            state = ask(page, "腾讯云云开发是什么")
            page.screenshot(path=os.path.join(SHOTS, "20-ds-results.png"))
            snap = snapshot(page)
            check("D1 检索成功无错误态", state["errorHidden"] is True,
                  json.dumps(state, ensure_ascii=False))
            check("D1 渲染 3 条结果", len(snap["items"]) == 3,
                  json.dumps([i["title"] for i in snap["items"]], ensure_ascii=False))
            check("D1 编号自 1 连续", [i["num"] for i in snap["items"]] == ["1", "2", "3"],
                  str([i["num"] for i in snap["items"]]))
            check("D1 标题 / 站点来自接口", snap["items"][0]["title"] == "腾讯云云开发入门"
                  and snap["items"][0]["site"] == "腾讯云开发者社区",
                  json.dumps(snap["items"][0], ensure_ascii=False))
            check("D1 相关度按百分比展示（2.4/3 → 80%）", snap["items"][0]["score"] == "相关度 80%",
                  snap["items"][0]["score"])
            check("D1 snippet 为空时用 summary 兜底",
                  page.evaluate("() => document.querySelectorAll('.res-list .res-snippet')[2].textContent")
                  == "snippet 为空时回落到 summary。",
                  page.evaluate("() => document.querySelectorAll('.res-list .res-snippet')[2].textContent"))
            check("D1 头部来源徽章显示 DeepSeek",
                  snap["sourceHidden"] is False and snap["sourceText"] == "DeepSeek",
                  json.dumps({"text": snap["sourceText"], "hidden": snap["sourceHidden"]}, ensure_ascii=False))
            check("D1 头部显示条数与用时",
                  "3 / 20 条" in snap["resCount"] and "用时" in snap["elapsed"],
                  json.dumps({"count": snap["resCount"], "elapsed": snap["elapsed"]}, ensure_ascii=False))
            check("D1 页签显示结果数 3", snap["tabsHidden"] is False and snap["tabsCount"] == "3",
                  json.dumps({"hidden": snap["tabsHidden"], "count": snap["tabsCount"]}, ensure_ascii=False))
            check("D1 AI 总结含 [1][2] 引用", snap["cites"][:2] == ["1", "2"],
                  str(snap["cites"][:4]))
            check("D1 请求体 query 为原始问题",
                  (STATE["last_search"] or {}).get("query") == "腾讯云云开发是什么",
                  json.dumps(STATE["last_search"], ensure_ascii=False))
            check("D1 请求体 count 与设置一致",
                  (STATE["last_search"] or {}).get("count") == 20,
                  str((STATE["last_search"] or {}).get("count")))
            check("D1 一次检索 + 一次总结", STATE["chat"] == before["chat"] + 1,
                  f"chat {before['chat']} -> {STATE['chat']}")

            # ----------------------------------------------------------------- #
            # D2 徽章
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("badges")
            configure(page)
            ask(page, "徽章测试")
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "21-ds-badges.png"))
            tones = [item["tones"] for item in snap["items"]]
            check("D2 authority=4 且 1 天内 → 权威 + 新", tones[0] == ["auth", "new"], str(tones[0]))
            check("D2 authority=2 且 30 天前 → 均不显示", tones[1] == [], str(tones[1]))
            check("D2 authority=-1 → 不显示权威",
                  "auth" not in tones[2], str(tones[2]))
            scores = [item["score"] for item in snap["items"]]
            check("D2 无 rerank_score 时不显示相关度",
                  scores[0] == "相关度 100%" and scores[2] == "",
                  json.dumps(scores, ensure_ascii=False))

            # ----------------------------------------------------------------- #
            # D3 favicon 降级链
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("icons")
            # 让 favicon.im 失败、Google s2 成功（停在中间档）
            ctx.route("https://favicon.im/**", lambda route: route.abort())
            ctx.route(
                "https://www.google.com/s2/favicons**",
                lambda route: route.fulfill(status=200, content_type="image/png", body=PNG_1PX),
            )
            configure(page)
            ask(page, "favicon 降级测试")
            page.wait_for_timeout(1200)
            snap = snapshot(page)
            check("D3 site_icon 非法时降级到 Google s2",
                  "google.com/s2/favicons" in snap["items"][0]["favSrc"],
                  snap["items"][0]["favSrc"])

            reset_panel(page)
            ctx.unroute("https://www.google.com/s2/favicons**")
            ctx.route("https://www.google.com/s2/favicons**", lambda route: route.abort())
            scenario("icons2")
            configure(page)
            ask(page, "favicon 全部失败测试")
            page.wait_for_timeout(1500)
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "22-ds-no-favicon.png"))
            check("D3 全部失败时移除 img（不留破图）", snap["items"][0]["hasFav"] is False,
                  json.dumps(snap["items"][0], ensure_ascii=False))
            ctx.unroute("https://favicon.im/**")
            ctx.unroute("https://www.google.com/s2/favicons**")

            # ----------------------------------------------------------------- #
            # D4 去重
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("dup")
            configure(page)
            ask(page, "去重测试")
            snap = snapshot(page)
            check("D4 同 URL + 同域名近似标题去重后剩 2 条", len(snap["items"]) == 2,
                  json.dumps([i["title"] for i in snap["items"]], ensure_ascii=False))
            check("D4 编号在去重之后重新排列", [i["num"] for i in snap["items"]] == ["1", "2"],
                  str([i["num"] for i in snap["items"]]))
            check("D4 保留高分那条（2.7/3=90% 与 2.1/3=70%）",
                  [i["score"] for i in snap["items"]] == ["相关度 90%", "相关度 70%"],
                  json.dumps([i["score"] for i in snap["items"]], ensure_ascii=False))
            check("D4 引用编号与去重后列表一一对应（不含 [3][4]）",
                  all(int(num) <= 2 for num in snap["cites"]), str(snap["cites"]))

            # ----------------------------------------------------------------- #
            # D5 空结果
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("empty")
            configure(page)
            chat_before = STATE["chat"]
            state = ask(page, "查不到结果的问题")
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "23-ds-empty.png"))
            check("D5 空结果显示 .ai-empty", snap["emptyHidden"] is False,
                  json.dumps({"empty": snap["emptyHidden"], "results": snap["resultsHidden"]}, ensure_ascii=False))
            check("D5 空结果停在「搜索结果」页签", snap["resultsHidden"] is False)
            check("D5 空结果头部显示 0 条", "0 条结果" in snap["resCount"], snap["resCount"])
            check("D5 空结果不请求 LLM", STATE["chat"] == chat_before,
                  f"chat {chat_before} -> {STATE['chat']}")
            check("D5 空结果给出可读概述",
                  "没有检索到" in state["answer"], state["answer"][:80])

            # ----------------------------------------------------------------- #
            # D6 缓存命中
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("normal")
            configure(page)
            ask(page, "缓存测试问题")
            first_search, first_chat = STATE["search"], STATE["chat"]
            reset_panel(page)
            ask(page, "缓存测试问题")
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "24-ds-cached.png"))
            check("D6 命中缓存显示「缓存」徽章", snap["cachedHidden"] is False,
                  json.dumps({"cachedHidden": snap["cachedHidden"]}, ensure_ascii=False))
            check("D6 命中缓存不重复检索", STATE["search"] == first_search,
                  f"search {first_search} -> {STATE['search']}")
            check("D6 命中缓存仍重新生成总结", STATE["chat"] == first_chat + 1,
                  f"chat {first_chat} -> {STATE['chat']}")
            check("D6 命中缓存结果条数不变", len(snap["items"]) == 3, str(len(snap["items"])))

            # ----------------------------------------------------------------- #
            # D7 引用点击切页签
            # ----------------------------------------------------------------- #
            page.click('.ai-tabs [data-tab="answer"]')
            page.wait_for_timeout(250)
            pane_before = page.evaluate(
                "() => document.querySelector('#ai-panel .ai-pane-results').hidden"
            )
            page.click('#ai-panel .ai-answer a.cite[data-cite="2"]')
            page.wait_for_timeout(400)
            after = page.evaluate(
                """() => ({
                    resultsHidden: document.querySelector('#ai-panel .ai-pane-results').hidden,
                    answerHidden: document.querySelector('#ai-panel [data-pane="answer"]').hidden,
                    tabActive: document.querySelector('.ai-tabs [data-tab="results"]')
                        .getAttribute('aria-selected'),
                    flash: document.querySelector('#ai-panel .res-item[data-index="2"]')
                        .classList.contains('is-flash'),
                })"""
            )
            page.screenshot(path=os.path.join(SHOTS, "25-ds-cite.png"))
            check("D7 总结页签下结果面板是隐藏的（前置条件）", pane_before is True, str(pane_before))
            check("D7 点引用后自动切回结果页签",
                  after["resultsHidden"] is False and after["answerHidden"] is True
                  and after["tabActive"] == "true",
                  json.dumps(after, ensure_ascii=False))
            check("D7 对应结果项被高亮", after["flash"] is True, json.dumps(after))

            # ----------------------------------------------------------------- #
            # D7b 停止生成
            # ----------------------------------------------------------------- #
            reset_panel(page)
            scenario("slowchat")
            configure(page)
            page.fill("#search-input", "停止生成测试")
            page.press("#search-input", "Enter")
            page.wait_for_selector('#ai-panel [data-act="stop"]:not([hidden])', timeout=10000)
            page.wait_for_timeout(500)
            page.click('#ai-panel [data-act="stop"]')
            page.wait_for_timeout(400)
            len_after_stop = page.evaluate(
                "() => document.querySelector('#ai-panel [data-role=\"answer\"]').textContent.length"
            )
            page.wait_for_timeout(1400)
            len_later = page.evaluate(
                "() => document.querySelector('#ai-panel [data-role=\"answer\"]').textContent.length"
            )
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "26-ds-stopped.png"))
            check("D7b 停止后徽标为「已停止」", snap["badge"] == "已停止", snap["badge"])
            check("D7b 停止后徽标 tone=stop", snap["tone"] == "stop", snap["tone"])
            check("D7b 停止后结果列表仍可查看", len(snap["items"]) == 3, str(len(snap["items"])))
            check("D7b 停止后不再接收增量（已停止的正文不再增长）",
                  len_after_stop == len_later and len_after_stop > 0,
                  f"stop 后 {len_after_stop} → 1.4s 后 {len_later}")
            scenario("normal")

            # ----------------------------------------------------------------- #
            # D8 纯对话 provider 仍走单页布局
            # ----------------------------------------------------------------- #
            reset_panel(page)
            configure(page, {"ai": {"provider": "deepseek"}})
            state = ask(page, "纯对话测试")
            snap = snapshot(page)
            page.screenshot(path=os.path.join(SHOTS, "27-ds-chat-only.png"))
            check("D8 纯对话 provider 无结果页签", snap["tabsHidden"] is True,
                  json.dumps({"tabsHidden": snap["tabsHidden"]}, ensure_ascii=False))
            check("D8 纯对话 provider 不显示空结果态", snap["emptyHidden"] is True)
            check("D8 纯对话 provider 停留在总结页", snap["answerPaneHidden"] is False)
            check("D8 纯对话 provider 正常出总结", "云开发" in state["answer"], state["answer"][:40])

            # ----------------------------------------------------------------- #
            # D9 设置页：provider 卡片 / checkbox 布尔持久化 / 时效下拉
            # ----------------------------------------------------------------- #
            reset_panel(page)
            configure(page)
            page.click("#btn-settings")
            page.wait_for_timeout(700)
            drawer = page.evaluate(
                """() => {
                    const d = document.getElementById('settings-drawer');
                    return {
                        cards: [...d.querySelectorAll('.provider-card')].map(c => c.getAttribute('data-provider')),
                        paneHidden: (d.querySelector('[data-role="ppane-deepseek"]') || {}).hidden,
                        hasSearchPane: Boolean(d.querySelector('[data-role="ppane-deepseek-search"]')),
                    };
                }"""
            )
            check("D9 provider 卡片由注册表派生（4 张，含 deepseek-search）",
                  drawer["cards"] == ["yuanbao", "deepseek", "deepseek-search", "custom"],
                  str(drawer["cards"]))
            check("D9 deepseek-search 复用 deepseek 密钥面板",
                  drawer["paneHidden"] is False and drawer["hasSearchPane"] is False,
                  json.dumps(drawer, ensure_ascii=False))

            # checkbox 布尔持久化：先取消勾选
            path_used = toggle_checkbox(page, 'input[data-secret="deepseek.webSearch"]', False)
            info("D9 checkbox 操作路径", path_used)
            page.wait_for_timeout(600)
            stored = page.evaluate(
                "() => JSON.parse(localStorage.getItem('aurora:secrets') || '{}').deepseek"
            )
            checked_now = page.evaluate(
                "() => document.querySelector('input[data-secret=\"deepseek.webSearch\"]').checked"
            )
            check("D9 联网开关取消勾选后持久化为布尔 false",
                  stored.get("webSearch") is False, json.dumps(stored, ensure_ascii=False))
            check("D9 取消勾选后控件状态同步为 false", checked_now is False, str(checked_now))

            # 关闭再打开抽屉，验证 syncValues 能把 false 回填到控件
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            page.click("#btn-settings")
            page.wait_for_timeout(700)
            checked_after_reopen = page.evaluate(
                "() => document.querySelector('input[data-secret=\"deepseek.webSearch\"]').checked"
            )
            check("D9 重新打开设置后 checkbox 仍为 false（syncValues 支持布尔）",
                  checked_after_reopen is False, str(checked_after_reopen))

            # 恢复为 true
            toggle_checkbox(page, 'input[data-secret="deepseek.webSearch"]', True)
            page.wait_for_timeout(600)
            restored = page.evaluate(
                "() => JSON.parse(localStorage.getItem('aurora:secrets') || '{}').deepseek.webSearch"
            )
            check("D9 重新勾选后持久化为 true", restored is True, str(restored))

            # 深度模式下拉（设置分组默认折叠，先展开）
            page.evaluate("() => { document.getElementById('sec-ai').open = true; }")
            page.wait_for_timeout(200)
            page.select_option('select[data-secret="deepseek.searchDepth"]', "deep")
            page.wait_for_timeout(450)
            depth = page.evaluate(
                "() => JSON.parse(localStorage.getItem('aurora:secrets') || '{}').deepseek.searchDepth"
            )
            check("D9 深度模式下拉持久化（deep）", depth == "deep", str(depth))

            # 时效筛选下拉
            page.select_option("#set-freshness", "d7")
            page.wait_for_timeout(450)
            freshness = page.evaluate(
                "() => JSON.parse(localStorage.getItem('aurora:settings') || '{}').ai.searchFreshness"
            )
            check("D9 时效筛选下拉持久化（d7）", freshness == "d7", str(freshness))

            # 时效筛选真实进入检索词
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            scenario("normal")
            configure(page, {"ai": {"searchFreshness": "d7", "provider": "deepseek-search"}})
            ask(page, "时效是否生效")
            last_query = str((STATE["last_search"] or {}).get("query") or "")
            check("D9 时效筛选以 after: 语法进入检索词",
                  last_query.startswith("时效是否生效") and "after:" in last_query, last_query)

            page.screenshot(path=os.path.join(SHOTS, "28-ds-settings.png"))
            browser.close()
    except Exception as exc:  # noqa: BLE001
        # 断言失败不应吞掉：中途抛错时把已完成的用例一并打印出来
        check("套件执行未抛异常", False, f"{type(exc).__name__}: {exc}")
    finally:
        server.shutdown()

    print("-" * 74)
    for level, name, detail in RESULTS:
        print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    fails = [row for row in RESULTS if row[0] == "FAIL"]
    passes = [row for row in RESULTS if row[0] == "PASS"]
    print("-" * 74)
    print(f"PASS {len(passes)} / FAIL {len(fails)} / TOTAL {len(passes) + len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
