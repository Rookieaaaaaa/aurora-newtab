#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Provider 适配层联调测试（QA）：用本地 mock 服务验证 SSE 解析 / HTTP 错误映射 /
AbortSignal / MCP 三步握手 / mcp-session-id 透传 / sources 提取。

不依赖真实密钥与外网。用法：
    <装有 playwright 的 python> tests/mock_provider_test.py
"""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
MOCK_PORT = 8799
HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
SHELL = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
    r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
)

RESULTS: list[tuple[str, str, str]] = []
RECORDS: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    return ok


def info(name: str, detail: str) -> None:
    RESULTS.append(("INFO", name, detail))


SOURCES = [
    {"title": "来源一", "url": "https://example.com/a", "content": "摘要 A"},
    {"title": "来源二", "url": "https://example.org/b", "content": "摘要 B"},
    {"title": "来源三", "url": "https://example.net/c", "content": "摘要 C"},
]

STREAM_TOKENS = ["你好", "，这是", "**流式**", "回答。", "\n\n1. 第一点\n2. 第二点"]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D401, ANN002
        return  # 静音

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "mcp-session-id")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_json(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw or b"{}")
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self) -> None:  # noqa: N802
        if self.path.endswith("/models"):
            body = json.dumps({"data": [{"id": "mock"}]}).encode()
            self.send_response(200)
            self._cors()
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        payload = self._read_json()
        RECORDS.append(
            {
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": payload,
            }
        )

        if self.path.endswith("/chat/completions"):
            model = (payload.get("model") or "")
            if model == "err401":
                body = json.dumps({"error": {"message": "Invalid API key provided"}}).encode()
                self.send_response(401)
                self._cors()
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            slow = model == "slow"
            self.send_response(200)
            self._cors()
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "keep-alive")
            self.end_headers()
            try:
                # 心跳帧 + 故意把一个 data 行拆成两半发送，验证缓冲区拼接
                self.wfile.write(b": ping\n\n")
                self.wfile.flush()
                for index, token in enumerate(STREAM_TOKENS):
                    frame = (
                        "data: "
                        + json.dumps({"choices": [{"delta": {"content": token}}]}, ensure_ascii=False)
                        + "\n\n"
                    ).encode()
                    if index == 1:
                        cut = len(frame) // 2
                        self.wfile.write(frame[:cut])
                        self.wfile.flush()
                        time.sleep(0.08)
                        self.wfile.write(frame[cut:])
                    else:
                        self.wfile.write(frame)
                    self.wfile.flush()
                    time.sleep(0.9 if slow else 0.05)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                RECORDS.append({"path": self.path, "aborted": True})
            return

        if self.path.endswith("/mcp"):
            method = payload.get("method")
            if method == "initialize":
                body = json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": payload.get("id", 1),
                        "result": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "mock-mcp", "version": "0.0.1"},
                        },
                    }
                ).encode()
                self.send_response(200)
                self._cors()
                self.send_header("content-type", "application/json")
                self.send_header("mcp-session-id", "sess-abc-123")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if method == "notifications/initialized":
                self.send_response(202)
                self._cors()
                self.send_header("content-length", "0")
                self.end_headers()
                return
            if method == "tools/call":
                session = self.headers.get("mcp-session-id") or ""
                if session != "sess-abc-123":
                    body = json.dumps(
                        {"jsonrpc": "2.0", "id": payload.get("id", 2),
                         "error": {"code": -32000, "message": f"缺少 session 头: {session!r}"}}
                    ).encode()
                    self.send_response(400)
                    self._cors()
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                result = {
                    "jsonrpc": "2.0",
                    "id": payload.get("id", 2),
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps({"results": SOURCES}, ensure_ascii=False)}
                        ]
                    },
                }
                body = json.dumps(result, ensure_ascii=False).encode()
                # 用 SSE 返回，验证 text/event-stream 分支解析
                self.send_response(200)
                self._cors()
                self.send_header("content-type", "text/event-stream")
                self.end_headers()
                self.wfile.write(b"event: message\ndata: " + body + b"\n\n")
                self.wfile.flush()
                return
            self.send_error(400)
            return

        self.send_error(404)


def start_mock() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def ask(page, query: str, timeout_ms: int = 20000) -> dict:
    page.fill("#search-input", query)
    page.press("#search-input", "Enter")
    waited = 0
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
        if state["stopHidden"] and state["answer"]:
            return state
        page.wait_for_timeout(300)
        waited += 300
    return state


def main() -> int:
    server = start_mock()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, locale="zh-CN")
            page = ctx.new_page()
            page.goto(BASE, wait_until="load")
            page.wait_for_timeout(1800)

            # 配置自定义 provider 指向 mock
            page.evaluate(
                """async (port) => {
                    await window.__aurora.app.updateSecrets({
                        custom: {
                            apiKey: 'test-key',
                            baseUrl: `http://127.0.0.1:${port}/v1`,
                            model: 'mock-model',
                            authHeader: 'Authorization',
                            authPrefix: 'Bearer ',
                        },
                    });
                    await window.__aurora.app.updateSettings({ ai: { provider: 'custom', demoMode: true }, search: { defaultEngine: 'ai-custom' } });
                }""",
                MOCK_PORT,
            )

            # T1 流式成功
            state = ask(page, "流式测试")
            page.screenshot(path=os.path.join(SHOTS, "16-mock-stream.png"))
            check("T1 自定义 provider 流式成功", state["errorHidden"] is True, json.dumps(state, ensure_ascii=False))
            check("T1 收到全部 SSE token（含跨块拼接）",
                  "你好" in state["answer"] and "第一点" in state["answer"] and "**流式**" not in state["answer"],
                  state["answer"][:80])
            check("T1 Markdown 有序列表已渲染",
                  page.evaluate("() => document.querySelectorAll('#ai-panel .ai-answer ol li').length") == 2,
                  str(page.evaluate("() => document.querySelectorAll('#ai-panel .ai-answer ol li').length")))
            req = [r for r in RECORDS if r.get("path", "").endswith("/chat/completions")][-1]
            check("T1 请求体包含 stream=true 与 Authorization 头",
                  req["body"].get("stream") is True
                  and req["headers"].get("authorization") == "Bearer test-key",
                  json.dumps({"stream": req["body"].get("stream"),
                              "auth": req["headers"].get("authorization")}, ensure_ascii=False))

            # T2 HTTP 401 映射
            page.evaluate(
                """async () => {
                    await window.__aurora.app.updateSecrets({ custom: { model: 'err401' } });
                }"""
            )
            state = ask(page, "错误映射")
            page.screenshot(path=os.path.join(SHOTS, "17-mock-401.png"))
            check("T2 401 显示错误态", state["errorHidden"] is False, json.dumps(state, ensure_ascii=False))
            check("T2 错误文案为中文且含 401",
                  "401" in state["errMsg"] and ("密钥" in state["errMsg"] or "无效" in state["errMsg"]),
                  state["errMsg"])

            # T3 AbortSignal：慢速流中点击停止
            page.evaluate(
                """async () => {
                    await window.__aurora.app.updateSecrets({ custom: { model: 'slow' } });
                }"""
            )
            page.fill("#search-input", "中止测试")
            page.press("#search-input", "Enter")
            # 等停止按钮出现（说明流式已开始）后再稍等一会儿
            page.wait_for_selector('#ai-panel [data-act="stop"]:not([hidden])', timeout=8000)
            page.wait_for_timeout(400)
            before = page.evaluate(
                "() => document.querySelector('#ai-panel [data-role=\"answer\"]').textContent.length"
            )
            page.click('#ai-panel [data-act="stop"]')
            page.wait_for_timeout(1500)
            after = page.evaluate(
                "() => document.querySelector('#ai-panel [data-role=\"answer\"]').textContent.length"
            )
            badge = page.evaluate(
                """() => {
                    const s = document.querySelector('#ai-panel [data-role="status"]');
                    return { text: s.textContent, tone: s.dataset.tone || '' };
                }"""
            )
            toast_texts = page.evaluate(
                "() => [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())"
            )
            check("T3 停止后停止接收增量", after - before <= 8, f"{before} -> {after}")
            # 产品口径变更（本轮）：停止后徽标为「已停止」+ data-tone=stop，不再回写「已完成」
            check("T3 停止后徽标变为已停止", badge["text"] == "已停止", json.dumps(badge, ensure_ascii=False))
            check("T3 停止后徽标 tone=stop", badge["tone"] == "stop", json.dumps(badge, ensure_ascii=False))
            check("T3 停止有 toast 提示", any("已停止" in t for t in toast_texts), str(toast_texts))

            # T4 MCP 三步握手 + session 透传 + sources 提取
            page.evaluate(
                """async (port) => {
                    await window.__aurora.app.updateSecrets({
                        yuanbao: {
                            transport: 'mcp',
                            endpoint: `http://127.0.0.1:${port}/mcp`,
                            apiKey: 'mcp-key',
                            authMode: 'bearer',
                            secretId: '',
                            secretKey: '',
                            authHeader: 'Authorization',
                            authPrefix: 'Bearer ',
                            tool: 'web_search',
                            extraArgs: '',
                            llm: 'deepseek',
                        },
                        deepseek: { apiKey: '' },
                    });
                    await window.__aurora.app.updateSettings({ ai: { provider: 'yuanbao', maxSources: 6 }, search: { defaultEngine: 'ai-yuanbao' } });
                }""",
                MOCK_PORT,
            )
            state = ask(page, "MCP 检索测试", timeout_ms=25000)
            page.screenshot(path=os.path.join(SHOTS, "18-mock-mcp.png"))
            mcp_calls = [r for r in RECORDS if r.get("path", "").endswith("/mcp")]
            methods = [r["body"].get("method") for r in mcp_calls]
            check("T4 MCP 调用顺序 initialize → notifications/initialized → tools/call",
                  methods[-3:] == ["initialize", "notifications/initialized", "tools/call"],
                  str(methods[-3:]))
            tool_req = mcp_calls[-1]
            check("T4 mcp-session-id 透传到 tools/call",
                  tool_req["headers"].get("mcp-session-id") == "sess-abc-123",
                  str(tool_req["headers"].get("mcp-session-id")))
            check("T4 tools/call 入参含 query",
                  (tool_req["body"].get("params") or {}).get("arguments", {}).get("query") == "MCP 检索测试",
                  json.dumps(tool_req["body"].get("params"), ensure_ascii=False))
            sources = page.evaluate(
                """() => ({
                    count: document.querySelectorAll('#ai-panel .res-list .res-item').length,
                    titles: [...document.querySelectorAll('#ai-panel .res-title')].map(e => e.textContent),
                    hosts: [...document.querySelectorAll('#ai-panel .res-site')].map(e => e.textContent),
                    hrefs: [...document.querySelectorAll('#ai-panel .res-link')].map(e => e.getAttribute('href')),
                    resultsHidden: document.querySelector('#ai-panel .ai-pane-results').hidden,
                })"""
            )
            check("T4 从 MCP SSE 结果提取 3 条来源",
                  sources["count"] == 3 and sources["resultsHidden"] is False,
                  json.dumps(sources, ensure_ascii=False))
            check("T4 来源域名正确", sources["hosts"][:2] == ["example.com", "example.org"],
                  str(sources["hosts"]))
            # 文案口径（本轮）：无总结模型时降级为「已通过 <tool> 检索到 N 条结果」
            check("T4 无 LLM 密钥时降级为结果列表",
                  "检索到" in state["answer"] and "3 条" in state["answer"], state["answer"][:60])
            check("T4 来源链接均为 http(s)",
                  all(h.startswith("https://") for h in sources["hrefs"]), str(sources["hrefs"]))

            # T5 凭证不完整（partial：填了 baseUrl 缺 apiKey）→ NeedsConfig 且零网络请求
            # （两种产品口径下都成立，作为稳定断言）
            page.evaluate(
                """async () => {
                    await window.__aurora.app.updateSecrets({
                        custom: { apiKey: '', baseUrl: 'http://127.0.0.1:8799/v1', model: 'mock-model' },
                    });
                    await window.__aurora.app.updateSettings({ ai: { provider: 'custom', demoMode: false }, search: { defaultEngine: 'ai-custom' } });
                }"""
            )
            before_count = len(RECORDS)
            state = ask(page, "凭证不完整测试", timeout_ms=8000)
            check("T5 凭证不完整 → NeedsConfig 错误",
                  state["errorHidden"] is False and "API Key" in state["errMsg"],
                  json.dumps(state, ensure_ascii=False))
            check("T5 凭证不完整时未发起任何网络请求", len(RECORDS) == before_count,
                  f"{before_count} -> {len(RECORDS)}")

            # T6 凭证全空（missing）+ 演示开关默认开启 → 演示 provider，且零网络请求
            page.evaluate(
                """async () => {
                    await window.__aurora.app.updateSecrets({
                        custom: { apiKey: '', baseUrl: '', model: '' },
                    });
                    await window.__aurora.app.updateSettings({ ai: { provider: 'custom', demoMode: true }, search: { defaultEngine: 'ai-custom' } });
                }"""
            )
            before_count = len(RECORDS)
            page.fill("#search-input", "缺失凭证测试")
            page.press("#search-input", "Enter")
            page.wait_for_timeout(1800)
            missing = page.evaluate(
                """() => {
                    const p = document.getElementById('ai-panel');
                    const demo = p.querySelector('[data-role="demo"]');
                    return {
                        badge: p.querySelector('[data-role="status"]').textContent,
                        demoVisible: demo ? !demo.hidden : false,
                        errorHidden: p.querySelector('[data-role="error"]').hidden,
                    };
                }"""
            )
            check("T6 凭证全空 + 演示开启 → 演示态",
                  missing["demoVisible"] is True and missing["errorHidden"] is True,
                  json.dumps(missing, ensure_ascii=False))
            check("T6 演示模式未发起网络请求", len(RECORDS) == before_count,
                  f"{before_count} -> {len(RECORDS)}")

            browser.close()
    finally:
        server.shutdown()

    print("-" * 70)
    for level, name, detail in RESULTS:
        print(f"[{level}] {name}" + (f" -> {detail}" if detail else ""))
    fails = [r for r in RESULTS if r[0] == "FAIL"]
    print("-" * 70)
    print(f"PASS {len([r for r in RESULTS if r[0] == 'PASS'])} / FAIL {len(fails)} / TOTAL {len(fails) + len([r for r in RESULTS if r[0] == 'PASS'])}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
