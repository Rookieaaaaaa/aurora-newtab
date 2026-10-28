#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""单元测试（QA）：在真实浏览器里 import 各 ES Module，对纯函数与存储层做断言。

采用「用例表」形式，便于阅读与扩充；每个用例记录 name / expression / expected。
用法：<装有 playwright 的 python> tests/unit_browser.py
"""

from __future__ import annotations

import json
import os

from playwright.sync_api import sync_playwright

BASE = "http://localhost:8765/newtab.html"
SHELL = os.path.expandvars(
    r"%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-1243"
    r"\chrome-headless-shell-win64\chrome-headless-shell.exe"
)

PY_RUNNER = """
async (cases) => {
  const mods = {};
  const load = async (name) => {
    if (!mods[name]) mods[name] = await import(name);
    return mods[name];
  };
  const out = [];
  for (const item of cases) {
    try {
      const fn = new Function('load', 'aux', `return (async () => { ${item.code} })();`);
      const aux = {
        makeEl: (tag = 'div') => document.createElement(tag),
        cleanup: (el) => el && el.parentNode && el.parentNode.removeChild(el),
      };
      const value = await fn(load, aux);
      out.push({ name: item.name, ok: item.expect === undefined ? true : deepEqual(value, item.expect),
                 value, expect: item.expect });
    } catch (err) {
      out.push({ name: item.name, ok: false, value: `EXCEPTION: ${err && err.message}`, expect: item.expect });
    }
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a && b && typeof a === 'object') {
      const ka = Object.keys(a); const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => deepEqual(a[k], b[k]));
    }
    return false;
  }
  return out;
}
"""

CASES = [
    # ---------------- utils ----------------
    {"name": "escapeHtml 转义五个危险字符",
     "code": "const u = await load('/src/utils.js'); return u.escapeHtml('<a href=\"x\">\\'&');",
     "expect": "&lt;a href=&quot;x&quot;&gt;&#39;&amp;"},
    {"name": "escapeHtml(null) 返回空串",
     "code": "const u = await load('/src/utils.js'); return u.escapeHtml(null);",
     "expect": ""},
    {"name": "deepMerge 递归合并且不改入参",
     "code": """const u = await load('/src/utils.js');
        const base = {a: {x: 1, y: 2}, list: [1, 2]};
        const patch = {a: {y: 3}, list: [9]};
        const merged = u.deepMerge(base, patch);
        return [merged.a.x, merged.a.y, merged.list, base.a.y, base.list.length];""",
     "expect": [1, 3, [9], 2, 2]},
    {"name": "deepMerge 忽略 undefined",
     "code": "const u = await load('/src/utils.js'); return u.deepMerge({a: 1}, {a: undefined}).a;",
     "expect": 1},
    {"name": "normalizeUrl 补全协议",
     "code": """const u = await load('/src/utils.js');
        return [u.normalizeUrl('github.com'), u.normalizeUrl('https://a.com'), u.normalizeUrl('mailto:a@b.c')];""",
     "expect": ["https://github.com", "https://a.com", "mailto:a@b.c"]},
    {"name": "isValidUrl 拒绝非 http(s)",
     "code": """const u = await load('/src/utils.js');
        return [u.isValidUrl('github.com'), u.isValidUrl('javascript:alert(1)'),
                u.isValidUrl('ftp://a.com'), u.isValidUrl(''), u.isValidUrl('localhost:3000')];""",
     "expect": [True, False, False, False, True]},
    {"name": "sanitizeUrl 只放行 http/https/mailto",
     "code": """const u = await load('/src/utils.js');
        return [u.sanitizeUrl('https://a.com'), u.sanitizeUrl('javascript:alert(1)'),
                u.sanitizeUrl('data:text/html,<script>'), u.sanitizeUrl('mailto:a@b.c')];""",
     "expect": ["https://a.com", "", "", "mailto:a@b.c"]},
    {"name": "hostOf 去掉 www 前缀",
     "code": "const u = await load('/src/utils.js'); return [u.hostOf('https://www.a.com/x'), u.hostOf('bad url')];",
     "expect": ["a.com", ""]},
    {"name": "firstChar 支持中文与空值",
     "code": "const u = await load('/src/utils.js'); return [u.firstChar('中文站'), u.firstChar(''), u.firstChar('github')];",
     "expect": ["中", "#", "G"]},
    {"name": "truncate 截断并加省略号",
     "code": "const u = await load('/src/utils.js'); return u.truncate('a b  c', 3);",
     "expect": "a b…"},
    {"name": "clamp 非法值回落 min",
     "code": "const u = await load('/src/utils.js'); return [u.clamp('x', 2, 8), u.clamp(99, 2, 8)];",
     "expect": [2, 8]},
    {"name": "mapHttpStatus 覆盖常见状态码",
     "code": """const u = await load('/src/utils.js');
        return [u.mapHttpStatus(401).includes('401'), u.mapHttpStatus(429).includes('429'),
                u.mapHttpStatus(418).includes('418')];""",
     "expect": [True, True, True]},
    {"name": "describeError 把 TypeError 归因为网络/CORS",
     "code": "const u = await load('/src/utils.js'); return u.describeError(new TypeError('failed')).includes('CORS');",
     "expect": True},
    {"name": "uid 生成唯一前缀 id",
     "code": "const u = await load('/src/utils.js'); const a = u.uid('site'); const b = u.uid('site'); return [a.startsWith('site-'), a !== b];",
     "expect": [True, True]},
    {"name": "debounce.flush 立即执行",
     "code": """const u = await load('/src/utils.js');
        let n = 0;
        const f = u.debounce(() => { n += 1; }, 50);
        f(); f(); f.flush();
        return n;""",
     "expect": 1},
    {"name": "softGradient 生成合法 CSS 渐变",
     "code": "const u = await load('/src/utils.js'); return u.softGradient('知乎').startsWith('linear-gradient(');",
     "expect": True},

    # ---------------- defaults ----------------
    {"name": "greetingAt 分段正确",
     "code": """const d = await load('/src/defaults.js');
        return [d.greetingAt(0), d.greetingAt(6), d.greetingAt(9), d.greetingAt(12),
                d.greetingAt(15), d.greetingAt(20), d.greetingAt(23)];""",
     "expect": ["凌晨好", "早上好", "上午好", "中午好", "下午好", "晚上好", "晚上好"]},
    {"name": "findEngine 未知 id 回落第一个 AI 引擎",
     "code": "const d = await load('/src/defaults.js'); return d.findEngine('nope').id;",
     "expect": "ai-yuanbao"},
    {"name": "ENGINES 数量 = AI 4 + WEB 7（含 ai-deepseek-web）",
     "code": "const d = await load('/src/defaults.js'); return [d.AI_ENGINES.length, d.WEB_ENGINES.length, d.ENGINES.length];",
     "expect": [4, 7, 11]},

    # ---------------- search ----------------
    {"name": "detectUrlIntent 识别域名/协议/IP/localhost",
     "code": """const s = await load('/src/search.js');
        return [s.detectUrlIntent('github.com'), s.detectUrlIntent('https://a.com/x'),
                s.detectUrlIntent('127.0.0.1:8080'), s.detectUrlIntent('localhost:3000'),
                s.detectUrlIntent('hello world'), s.detectUrlIntent('怎么学习 python'),
                s.detectUrlIntent('a.b')];""",
     "expect": ["https://github.com", "https://a.com/x", "http://127.0.0.1:8080",
                "http://localhost:3000", "", "", ""]},
    {"name": "parseBang 解析已知指令并拒绝未知/无空格",
     "code": """const s = await load('/src/search.js');
        return [s.parseBang('!b 天气'), s.parseBang('!GH react'), s.parseBang('!x 你好'),
                s.parseBang('!b天气'), s.parseBang('天气')];""",
     "expect": [{"engineId": "bing", "query": "天气"},
                {"engineId": "github", "query": "react"},
                None, None, None]},

    # ---------------- ai-panel: Markdown ----------------
    {"name": "renderMarkdown 标题/列表/代码块",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('# 标题\\n\\n- 一\\n- 二\\n\\n```js\\nconst x=1;\\n```');
        return [html.includes('<h1>标题</h1>'), html.includes('<ul>'), html.includes('<pre data-lang="js">'),
                html.includes('const x=1;')];""",
     "expect": [True, True, True, True]},
    {"name": "renderMarkdown 转义 HTML 标签",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('<img src=x onerror=alert(1)>');
        return [html.includes('&lt;img'), html.includes('<img')];""",
     "expect": [True, False]},
    {"name": "renderMarkdown 拒绝 javascript: 链接",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('[点我](javascript:alert(1))');
        return [html.includes('javascript:'), html.includes('点我')];""",
     "expect": [False, True]},
    {"name": "renderMarkdown 未闭合围栏也按代码块处理（流式安全）",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('```js\\nconst a = 1;');
        return html.includes('<pre') && html.includes('const a = 1;');""",
     "expect": True},
    {"name": "renderMarkdown 表格降级为等宽文本",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('| a | b | c |\\n| - | - | - |');
        return html.includes('class="md-plain"');""",
     "expect": True},
    {"name": "renderMarkdown 裸链接自动加 a 标签且 rel 安全",
     "code": """const a = await load('/src/ai-panel.js');
        const html = a.renderMarkdown('见 https://example.com/a 说明');
        return html.includes('rel="noopener noreferrer"') && html.includes('href="https://example.com/a"');""",
     "expect": True},

    # ---------------- storage ----------------
    {"name": "getSettings 补齐默认值并夹取范围（预览环境默认渐变背景）",
     "code": """const st = await load('/src/storage.js');
        await st.setRaw('settings', {background: {blur: 999, dim: -3}, ai: {temperature: 9, maxSources: 0}});
        const s = await st.getSettings();
        // 无 chrome.storage 的预览环境下首次加载应改用渐变，避免必应壁纸被 CORS 拦截
        return [s.background.blur, s.background.dim, s.ai.temperature, s.ai.maxSources,
                s.background.type, s.search.defaultEngine, s.version,
                Boolean(window.chrome && window.chrome.storage)];""",
     "expect": [20, 0, 2, 1, "gradient", "ai-yuanbao", 1, False]},
    {"name": "patchSettings 深合并保留同级字段",
     "code": """const st = await load('/src/storage.js');
        await st.setRaw('settings', {});
        await st.patchSettings({search: {defaultEngine: 'google'}});
        const s = await st.patchSettings({clock: {hour12: true}});
        return [s.search.defaultEngine, s.search.newTab, s.clock.hour12, s.clock.showDate];""",
     "expect": ["google", True, True, True]},
    {"name": "getSites 丢弃非法站点",
     "code": """const st = await load('/src/storage.js');
        await st.setRaw('sites', [
            {title: 'A', url: 'a.com'},
            {title: '', url: 'javascript:alert(1)'},
            'not-an-object',
            {title: 'B', url: 'ftp://x.com'},
        ]);
        const sites = await st.getSites();
        return [sites.length, sites[0].url];""",
     "expect": [1, "https://a.com"]},
    {"name": "getSites 空数组不被默认站点覆盖",
     "code": """const st = await load('/src/storage.js');
        await st.setRaw('sites', []);
        const sites = await st.getSites();
        return sites.length;""",
     "expect": 0},
    {"name": "exportConfig 不含 secrets",
     "code": """const st = await load('/src/storage.js');
        await st.setSecrets({deepseek: {apiKey: 'sk-super-secret'}});
        const payload = await st.exportConfig();
        const text = JSON.stringify(payload);
        return [text.includes('sk-super-secret'), 'secrets' in payload, Boolean(payload.sites)];""",
     "expect": [False, False, True]},
    {"name": "importConfig 拒绝空对象/错误类型",
     "code": """const st = await load('/src/storage.js');
        const errors = [];
        for (const bad of [null, {}, {settings: 'x'}, {sites: 'x'}]) {
            try { await st.importConfig(bad); errors.push('no-error'); }
            catch (err) { errors.push(err.message); }
        }
        return errors;""",
     "expect": ["配置文件内容为空或格式不正确", "配置文件中缺少 settings / sites 字段",
                "settings 字段格式不正确", "sites 字段必须是数组"]},
    {"name": "importConfig 不接受导入 secrets",
     "code": """const st = await load('/src/storage.js');
        await st.setSecrets({deepseek: {apiKey: 'keep-me'}});
        await st.importConfig({settings: {secrets: {deepseek: {apiKey: 'evil'}}}});
        const s = await st.getSecrets();
        return s.deepseek.apiKey;""",
     "expect": "keep-me"},
    {"name": "resetAll 保留密钥",
     "code": """const st = await load('/src/storage.js');
        await st.setSecrets({custom: {apiKey: 'still-here'}});
        await st.resetAll();
        const s = await st.getSecrets();
        return s.custom.apiKey;""",
     "expect": "still-here"},

    # ---------------- dock: icon 三级降级 ----------------
    # v2 起 createSiteIcon 返回 <span class="dock-icon"> 外壳（内含 .dock-letter，图片加载成功才 has-img），
    # 因此断言只看「结构无关的行为」：是否含字母块 / 是否指向期望的图片地址 / 安全属性是否到位。
    {"name": "createSiteIcon 自动模式同时具备字母块与 Google favicon 图片",
     "code": """const d = await load('/src/dock.js');
        const el = d.createSiteIcon({title: 'X', url: 'https://x.com', icon: {type: 'auto', value: ''}});
        const img = el.querySelector('img');
        return [el.className.includes('dock-icon'), Boolean(el.querySelector('.dock-letter')),
                Boolean(img && img.src.includes('google.com/s2/favicons')),
                img ? img.referrerPolicy : 'no-img', el.textContent.trim()];""",
     "expect": [True, True, True, "no-referrer", "X"]},
    {"name": "createSiteIcon 无 host 时只有字母块（无图片）",
     "code": """const d = await load('/src/dock.js');
        const el = d.createSiteIcon({title: 'Zeta', url: '', icon: {type: 'auto', value: ''}});
        return [Boolean(el.querySelector('img')), (el.querySelector('.dock-letter') || {}).textContent];""",
     "expect": [False, "Z"]},
    {"name": "createSiteIcon 自定义图片地址优先",
     "code": """const d = await load('/src/dock.js');
        const el = d.createSiteIcon({title: 'X', url: 'https://x.com', icon: {type: 'url', value: 'https://cdn/x.png'}});
        const img = el.querySelector('img');
        return [Boolean(img), img ? img.src : ''];""",
     "expect": [True, "https://cdn/x.png"]},
    {"name": "createSiteIcon 图片未加载时字母块仍在（离线可见）",
     "code": """const d = await load('/src/dock.js');
        const el = d.createSiteIcon({title: '离线站点', url: 'https://offline.example', icon: {type: 'auto', value: ''}});
        const letter = el.querySelector('.dock-letter');
        return [Boolean(letter), letter ? letter.textContent : '', el.className.includes('has-img')];""",
     "expect": [True, "离", False]},
    {"name": "createLetterBlock 使用稳定渐变",
     "code": """const d = await load('/src/dock.js');
        const el = d.createLetterBlock('知乎');
        return [el.textContent, el.style.background.includes('linear-gradient')];""",
     "expect": ["知", True]},

    # ---------------- providers: 演示模式 / 凭证判定 ----------------
    {"name": "hasCredentials 判定三 provider",
     "code": """const p = await load('/src/providers/index.js');
        return [p.hasCredentials('deepseek', {deepseek: {apiKey: 'k'}}),
                p.hasCredentials('deepseek', {deepseek: {apiKey: ''}}),
                p.hasCredentials('yuanbao', {yuanbao: {endpoint: 'https://x', apiKey: 'k'}}),
                p.hasCredentials('yuanbao', {yuanbao: {endpoint: '', apiKey: 'k'}}),
                p.hasCredentials('custom', {custom: {baseUrl: 'u', apiKey: 'k', model: ''}})];""",
     "expect": [True, False, True, False, False]},
    {"name": "getProvider 无凭证返回 demo（demo:true）",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'deepseek', demoMode: true}}, {deepseek: {apiKey: ''}});
        return [provider.meta.demo, provider.meta.model];""",
     "expect": [True, "aurora-demo"]},
    {"name": "getProvider 凭证全空 + 演示开启 → demo",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'deepseek', demoMode: true}}, {deepseek: {apiKey: ''}});
        return [provider.meta.demo, provider.meta.model, provider.meta.demoReason];""",
     "expect": [True, "aurora-demo", "missing-credentials"]},
    {"name": "getProvider 凭证全空 + 关闭演示 → 真实 provider（开关真实生效）",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'deepseek', demoMode: false}}, {deepseek: {apiKey: ''}});
        return [provider.meta.demo, provider.meta.configState, typeof provider.run];""",
     "expect": [False, "missing", "function"]},
    {"name": "getProvider 未知 provider 回落 yuanbao",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'nope', demoMode: true}}, {});
        return provider.meta.name;""",
     "expect": "元宝 AI 搜索"},
    # ---------------- providers: 凭证完整度 ----------------
    {"name": "configState 三态判定（missing/partial/ready）",
     "code": """const p = await load('/src/providers/index.js');
        return [
            p.configState('deepseek', {deepseek: {apiKey: ''}}),
            p.configState('deepseek', {deepseek: {apiKey: 'k'}}),
            p.configState('yuanbao', {yuanbao: {endpoint: '', apiKey: ''}}),
            p.configState('yuanbao', {yuanbao: {endpoint: 'https://x', apiKey: ''}}),
            p.configState('yuanbao', {yuanbao: {endpoint: 'https://x', apiKey: 'k'}}),
            p.configState('custom', {custom: {baseUrl: 'u', apiKey: '', model: 'm'}}),
            p.configState('custom', {custom: {baseUrl: 'u', apiKey: 'k', model: 'm'}}),
        ];""",
     "expect": ["missing", "ready", "missing", "partial", "ready", "partial", "ready"]},
    {"name": "configState 把纯空白视为未填写",
     "code": """const p = await load('/src/providers/index.js');
        return [p.configState('deepseek', {deepseek: {apiKey: '   '}}),
                p.configState('yuanbao', {yuanbao: {endpoint: '  ', apiKey: 'k'}})];""",
     "expect": ["missing", "partial"]},
    {"name": "hasCredentials 等价于 configState === 'ready'",
     "code": """const p = await load('/src/providers/index.js');
        return [p.hasCredentials('yuanbao', {yuanbao: {endpoint: 'https://x', apiKey: 'k'}}),
                p.hasCredentials('yuanbao', {yuanbao: {endpoint: 'https://x', apiKey: ''}})];""",
     "expect": [True, False]},
    {"name": "getProvider 凭证不完整(partial) → 真实 provider（可抛可读错误）",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'yuanbao', demoMode: false}},
                                       {yuanbao: {endpoint: 'https://x', apiKey: ''}});
        return [provider.meta.demo, typeof provider.run];""",
     "expect": [False, "function"]},
    {"name": "getProvider 凭证齐全 → 真实 provider（configured=true）",
     "code": """const p = await load('/src/providers/index.js');
        const provider = p.getProvider({ai: {provider: 'deepseek', demoMode: true}},
                                       {deepseek: {apiKey: 'k'}});
        return [provider.meta.demo, provider.meta.configured, provider.meta.configState];""",
     "expect": [False, True, "ready"]},
    {"name": "joinUrl 处理 /v1 与误填 completions",
     "code": """const ds = await load('/src/providers/deepseek.js');
        return [ds.joinUrl('https://api.deepseek.com/v1', '/chat/completions'),
                ds.joinUrl('https://api.deepseek.com/v1/', '/chat/completions'),
                ds.joinUrl('https://x/v1/chat/completions', '/chat/completions'),
                ds.joinUrl('https://x/v1/completions', '/chat/completions')];""",
     "expect": ["https://api.deepseek.com/v1/chat/completions",
                "https://api.deepseek.com/v1/chat/completions",
                "https://x/v1/chat/completions",
                "https://x/v1/chat/completions"]},
    {"name": "buildAuthHeaders 支持自定义 header 与空前缀",
     "code": """const ds = await load('/src/providers/deepseek.js');
        return [ds.buildAuthHeaders({apiKey: 'k'}), 
                ds.buildAuthHeaders({apiKey: 'k', authHeader: 'x-api-key', authPrefix: ''}),
                ds.buildAuthHeaders({apiKey: ''})];""",
     "expect": [{"Authorization": "Bearer k"}, {"x-api-key": "k"}, {}]},
    {"name": "buildMessages 自定义提示词为空时用内置",
     "code": """const ds = await load('/src/providers/deepseek.js');
        const m1 = ds.buildMessages({ai: {systemPrompt: ''}}, 'hi');
        const m2 = ds.buildMessages({ai: {systemPrompt: '  自定义  '}}, 'hi', 'extra');
        return [m1.length, m1[1].content, m2[0].content.includes('自定义'), m2[0].content.includes('extra')];""",
     "expect": [2, "hi", True, True]},
    {"name": "joinUrl 空地址抛 NeedsConfigError",
     "code": """const ds = await load('/src/providers/deepseek.js');
        try { ds.joinUrl('', '/chat/completions'); return 'no-error'; }
        catch (err) { return [err.name, err.message]; }""",
     "expect": ["NeedsConfigError", "尚未配置 Base URL"]},
]


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=SHELL, args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1200, "height": 900}, locale="zh-CN")
        page = ctx.new_page()
        page.goto(BASE, wait_until="load")
        page.wait_for_timeout(1500)
        results = page.evaluate(PY_RUNNER, CASES)
        ctx.close()
        browser.close()

    fails = [r for r in results if not r["ok"]]
    for row in results:
        flag = "PASS" if row["ok"] else "FAIL"
        if not row["ok"]:
            print(f"[{flag}] {row['name']}\n       actual  = {json.dumps(row['value'], ensure_ascii=False)}"
                  f"\n       expect  = {json.dumps(row['expect'], ensure_ascii=False)}")
    print("-" * 78)
    print(f"PASS {len(results) - len(fails)} / FAIL {len(fails)} / TOTAL {len(results)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
