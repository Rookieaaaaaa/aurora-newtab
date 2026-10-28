/**
 * logic_probe.mjs — 纯逻辑层测试（Node，无需浏览器 / 无需外网）
 *
 * 覆盖本轮新增与改动：
 *   - providers/cache.js        缓存 key 归一化 / TTL / 上限 FIFO / 命中未命中
 *   - providers/deepseek-search 归一化 / resolveApiBase / 错误映射 / deep 模式降级 /
 *                               空结果不调 LLM / 缓存命中仍重新总结 / testConnection
 *   - providers/index.js        kindOf / configState / getProvider 演示分支 / demo sources 结构
 *   - defaults.js               AI_ENGINES 4 条、!ds 映射、默认值
 *   - storage.js                normalizeSettings 夹取（searchFreshness / maxSources）、
 *                               老 secrets 缺 webSearch/searchDepth 时的兼容
 *   - ai-panel.js 纯逻辑        dedupeSources / isFreshDate / shortProviderName（非导出函数，
 *                               通过剥离 import 后附加 export 的方式加载）
 *
 * 用法：node tests/logic_probe.mjs        （由 tests/test_ai_search.py 调用）
 * 输出：JSON {cases:[{name,ok,detail}], fatal:""}
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/*                               断言小框架                                    */
/* -------------------------------------------------------------------------- */

const cases = [];

/**
 * 注册并立即执行一个用例。
 * @param {string} name 用例名
 * @param {() => any} fn 断言体（抛错即失败，返回值作为 detail）
 */
function check(name, fn) {
  try {
    const detail = fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

/** 异步用例。 */
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

/** 严格相等断言。 */
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} 期望 ${e}，实际 ${a}`);
  return a;
}

/** 真值断言。 */
function ok(value, label = '') {
  if (!value) throw new Error(`${label} 期望为真，实际 ${JSON.stringify(value)}`);
  return 'true';
}

/** 字符串包含断言。 */
function has(text, needle, label = '') {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.indexOf(needle) < 0) {
    throw new Error(`${label} 期望包含「${needle}」，实际「${value.slice(0, 160)}」`);
  }
  return needle;
}

/** 浮点近似断言（避免 2.4/3 这类除法的精度误差）。 */
function close(actual, expected, label = '', eps = 1e-9) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${label} 期望 ≈${expected}，实际 ${actual}`);
  }
  return String(actual);
}

/** 断言 Promise 抛错，并返回错误对象。 */
async function rejects(promise, label = '') {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error(`${label} 期望抛错，实际成功返回`);
}

/* -------------------------------------------------------------------------- */
/*                              fetch 桩 / 响应桩                              */
/* -------------------------------------------------------------------------- */

/** 全部被拦截的请求记录。 */
const calls = [];
/** 当前请求处理函数。 */
let handler = () => {
  throw new Error('fetch 桩未设置 handler');
};

globalThis.fetch = (url, init = {}) => {
  const body = init && typeof init.body === 'string' ? safeJson(init.body) : null;
  const record = { url: String(url), body, headers: init.headers || {}, init };
  calls.push(record);
  return Promise.resolve().then(() => handler(record));
};

/** 尽力解析 JSON，失败返回原文。 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return text;
  }
}

/** 伪造 JSON 响应。 */
function jsonResponse(status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
  };
}

/**
 * 伪造 SSE 响应（streamChat 需要 response.body.getReader）。
 * @param {string[]} chunks 原样写入的 SSE 片段
 */
function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  return { ok: true, status: 200, body, text: async () => chunks.join('') };
}

/** 生成 chat/completions 的 SSE 分片。 */
function chatSse(text) {
  const parts = [];
  Array.from(text).forEach((char) => {
    parts.push(`data: ${JSON.stringify({ choices: [{ delta: { content: char } }] })}\n\n`);
  });
  parts.push('data: [DONE]\n\n');
  return parts;
}

/** 重置请求记录与 handler。 */
function resetFetch(next) {
  calls.length = 0;
  handler = next;
}

/** 延迟。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/*                                  被测模块                                   */
/* -------------------------------------------------------------------------- */

const SRC = new URL('../src/', import.meta.url);

const cache = await import(new URL('providers/cache.js', SRC).href);
const search = await import(new URL('providers/deepseek-search.js', SRC).href);
const providers = await import(new URL('providers/index.js', SRC).href);
const defaults = await import(new URL('defaults.js', SRC).href);

/* -------------------------------------------------------------------------- */
/*                                 1. cache.js                                 */
/* -------------------------------------------------------------------------- */

const BASE_CFG = { apiKey: 'sk-test', baseUrl: 'https://mock.deepseek.test' };

check('cache: normalizeQuery 去首尾空白并折叠连续空格', () =>
  eq(cache.normalizeQuery('  hello   world  '), 'hello world'),
);

check('cache: buildCacheKey 形如 provider::query::count', () =>
  eq(cache.buildCacheKey(' deepseek-search ', '  a   b ', 20), 'deepseek-search::a b::20'),
);

check('cache: buildCacheKey 非法 count 归 0', () =>
  eq(cache.buildCacheKey('p', 'q', 'abc'), 'p::q::0'),
);

check('cache: 命中与未命中', () => {
  cache.clearCache();
  eq(cache.getCached('k'), null, '未命中');
  ok(cache.setCached('k', { sources: [1] }), 'setCached 返回 true');
  eq(cache.getCached('k'), { sources: [1] }, '命中');
  cache.clearCache();
  eq(cache.getCached('k'), null, '清空后');
  return 'ok';
});

check('cache: 空 key / 空 value 不写入', () => {
  cache.clearCache();
  eq(cache.setCached('', { a: 1 }), false, '空 key');
  eq(cache.setCached('x', null), false, '空 value');
  eq(cache.setCached('x', undefined), false, 'undefined value');
  eq(cache.cacheSize(), 0, '缓存条数');
  return 'ok';
});

check('cache: TTL 10 分钟内可读、超时读不到', () => {
  cache.clearCache();
  const realNow = Date.now;
  let fake = 1_700_000_000_000;
  Date.now = () => fake;
  try {
    cache.setCached('ttl', { v: 1 });
    fake += cache.CACHE_TTL_MS - 1000;
    ok(cache.getCached('ttl'), 'TTL 内应命中');
    fake += 2000;
    eq(cache.getCached('ttl'), null, 'TTL 外应未命中');
    eq(cache.cacheSize(), 0, '过期条目被清理');
  } finally {
    Date.now = realNow;
  }
  return `ttl=${cache.CACHE_TTL_MS}`;
});

check('cache: 上限 50 条，超出后 FIFO 淘汰最早写入', () => {
  cache.clearCache();
  eq(cache.CACHE_MAX_ENTRIES, 50, '上限常量');
  for (let i = 0; i < 51; i += 1) cache.setCached(`k${i}`, { i });
  eq(cache.cacheSize(), 50, '条数');
  eq(cache.getCached('k0'), null, 'k0 应被淘汰');
  ok(cache.getCached('k1'), 'k1 仍在');
  ok(cache.getCached('k50'), '最新一条仍在');
  cache.clearCache();
  return 'ok';
});

check('cache: 重复写入同一 key 会刷新淘汰顺序', () => {
  cache.clearCache();
  cache.setCached('a', 1);
  for (let i = 0; i < 49; i += 1) cache.setCached(`b${i}`, i);
  cache.setCached('a', 2); // 重写 → 变成最新
  cache.setCached('c', 3); // 触发淘汰，应淘汰 b0 而不是 a
  eq(cache.cacheSize(), 50, '条数');
  eq(cache.getCached('b0'), null, 'b0 被淘汰');
  eq(cache.getCached('a'), 2, 'a 仍在且为最新值');
  cache.clearCache();
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                         2. deepseek-search 归一化                           */
/* -------------------------------------------------------------------------- */

check('归一化: rerank_score 2.4 → score 0.8，authority 3 保留', () => {
  const item = search.normalizeResult({
    title: '标题',
    url: 'https://example.com/a',
    rerank_score: 2.4,
    authority: 3,
    date: '2024-05-06T10:00:00Z',
  });
  close(item.score, 0.8, 'score');
  eq(item.authority, 3, 'authority');
  eq(item.date, '2024-05-06', 'date');
  eq(item.domain, 'example.com', 'domain');
  return 'ok';
});

check('归一化: score 夹取到 0~1', () => {
  eq(search.normalizeResult({ url: 'https://a.com', rerank_score: 9 }).score, 1, '上限');
  eq(search.normalizeResult({ url: 'https://a.com', rerank_score: -5 }).score, 0, '下限');
  eq(search.normalizeResult({ url: 'https://a.com' }).score, null, '缺失 → null');
  return 'ok';
});

check('归一化: authority -1 → null，非数字 → null', () => {
  eq(search.normalizeResult({ url: 'https://a.com', authority: -1 }).authority, null, '-1');
  eq(search.normalizeResult({ url: 'https://a.com', authority: 'x' }).authority, null, '字符串');
  eq(search.normalizeResult({ url: 'https://a.com', authority: 0 }).authority, 0, '0 是合法值');
  return 'ok';
});

check('归一化: site_name 为空时回落 host，icon 非 http(s) 丢弃', () => {
  const item = search.normalizeResult({
    url: 'https://news.qq.com/x',
    site_name: null,
    site_icon: 'javascript:alert(1)',
  });
  eq(item.site, 'news.qq.com', 'site');
  eq(item.icon, '', 'icon');
  const withIcon = search.normalizeResult({ url: 'https://a.com', site_icon: 'https://a.com/i.png' });
  eq(withIcon.icon, 'https://a.com/i.png', '合法 icon');
  return 'ok';
});

check('归一化: snippet 为空时用 summary，title 为空时回退 host', () => {
  const item = search.normalizeResult({ url: 'https://a.com/p', snippet: '', summary: '结论摘要' });
  eq(item.snippet, '结论摘要', 'snippet');
  eq(item.title, 'a.com', 'title');
  return 'ok';
});

check('归一化: 非 http(s) URL 被过滤', () => {
  eq(search.normalizeResult({ url: 'ftp://a.com' }), null, 'ftp');
  eq(search.normalizeResult({ url: 'javascript:alert(1)' }), null, 'javascript');
  eq(search.normalizeResult({ url: '' }), null, '空');
  eq(search.normalizeResult(null), null, 'null');
  eq(search.normalizeResult([]), null, '数组');
  return 'ok';
});

check('归一化: normalizeResults 按 URL 去重（忽略 hash 与末尾斜杠）', () => {
  const list = search.normalizeResults(
    [
      { url: 'https://a.com/x', title: 'A' },
      { url: 'https://a.com/x#frag', title: 'A2' },
      { url: 'https://a.com/x/', title: 'A3' },
      { url: 'https://b.com/y', title: 'B' },
    ],
    20,
  );
  eq(list.length, 2, '去重后条数');
  eq(list[0].url, 'https://a.com/x', '保留第一条');
  return 'ok';
});

check('归一化: normalizeResults 按 limit 截断', () => {
  const list = search.normalizeResults(
    [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }, { url: 'https://a.com/3' }],
    2,
  );
  eq(list.length, 2, '条数');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                            3. resolveApiBase 等                             */
/* -------------------------------------------------------------------------- */

check('resolveApiBase: 裸域名补 /v1', () =>
  eq(search.resolveApiBase('https://api.deepseek.com'), 'https://api.deepseek.com/v1'),
);

check('resolveApiBase: 已含 /v1 原样返回', () => {
  eq(search.resolveApiBase('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1');
  eq(search.resolveApiBase('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1', '尾斜杠');
  return 'ok';
});

check('resolveApiBase: 误填 /chat/completions 会被剥掉', () => {
  eq(
    search.resolveApiBase('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1',
  );
  eq(
    search.resolveApiBase('https://api.deepseek.com/chat/completions'),
    'https://api.deepseek.com/v1',
    '缺 /v1 时补上',
  );
  return 'ok';
});

check('resolveApiBase: 空值回落官方默认', () =>
  eq(search.resolveApiBase(''), 'https://api.deepseek.com/v1'),
);

check('resolveApiBase: 自定义代理带路径时原样使用', () =>
  eq(search.resolveApiBase('https://proxy.example.com/openai'), 'https://proxy.example.com/openai'),
);

check('normalizeCount / normalizeDepth 夹取', () => {
  eq(search.normalizeCount(0), 20, '0 → 默认');
  eq(search.normalizeCount(999), 50, '上限 50');
  eq(search.normalizeCount('7'), 7, '字符串数字');
  eq(search.normalizeDepth('deep'), 'deep');
  eq(search.normalizeDepth('xxx'), 'normal', '未知值回落 normal');
  eq(search.normalizeDepth('OFF'), 'off', '大小写');
  return 'ok';
});

check('时效筛选: d7 拼出 after: 片段且幂等', () => {
  const now = new Date('2024-05-20T00:00:00Z');
  const clause = search.buildFreshnessClause('d7', now);
  ok(/^after:\d{4}-\d{2}-\d{2}$/.test(clause), `片段格式 ${clause}`);
  eq(search.applyFreshness('腾讯云', 'any'), '腾讯云', 'any 不拼接');
  const once = search.applyFreshness('腾讯云', 'd7');
  has(once, 'after:', '拼接');
  eq(search.applyFreshness(once, 'd7'), once, '重复调用不叠加');
  return once;
});

/* -------------------------------------------------------------------------- */
/*                              4. 请求 / 错误映射                             */
/* -------------------------------------------------------------------------- */

await checkAsync('searchWeb: 请求体与鉴权头正确', async () => {
  cache.clearCache();
  resetFetch(() =>
    jsonResponse(200, { results: [{ url: 'https://a.com/1', title: 'A', rerank_score: 3 }] }),
  );
  const outcome = await search.searchWeb(BASE_CFG, {
    query: ' 腾讯云  云开发 ',
    oriQuestion: '腾讯云云开发怎么用',
    count: 3,
  });
  const req = calls[0];
  eq(req.url, 'https://mock.deepseek.test/v1/tools/search', 'endpoint');
  eq(req.body.query, '腾讯云 云开发', 'query 归一化');
  eq(req.body.count, 3, 'count');
  eq(req.body.ori_question, '腾讯云云开发怎么用', 'ori_question');
  eq(req.headers.authorization, 'Bearer sk-test', 'authorization');
  eq(outcome.sources.length, 1, 'sources');
  eq(outcome.requested, 3, 'requested');
  ok(Number.isFinite(outcome.elapsedMs), 'elapsedMs');
  return 'ok';
});

await checkAsync('searchWeb: need_content 只在显式 true 时携带', async () => {
  resetFetch(() => jsonResponse(200, { results: [] }));
  await search.searchWeb(BASE_CFG, { query: 'q', count: 1 });
  eq(calls[0].body.need_content, undefined, '默认不带');
  resetFetch(() => jsonResponse(200, { results: [] }));
  await search.searchWeb(BASE_CFG, { query: 'q', count: 1, needContent: true });
  eq(calls[0].body.need_content, true, '显式为 true');
  return 'ok';
});

await checkAsync('错误映射: 402 余额不足', async () => {
  resetFetch(() => jsonResponse(402, { error: { message: 'Insufficient Balance' } }));
  const err = await rejects(search.searchWeb(BASE_CFG, { query: 'q' }), '402');
  has(err.message, '余额不足', '文案');
  eq(err.status, 402, 'status');
  return err.message;
});

await checkAsync('错误映射: 429 限速（search 场景）', async () => {
  resetFetch(() => jsonResponse(429, {}));
  const err = await rejects(search.searchWeb(BASE_CFG, { query: 'q' }), '429');
  has(err.message, '限速', '文案');
  return err.message;
});

await checkAsync('错误映射: 401 Key 无效', async () => {
  resetFetch(() => jsonResponse(401, { error: { message: 'Authentication Fails' } }));
  const err = await rejects(search.searchWeb(BASE_CFG, { query: 'q' }), '401');
  has(err.message, 'API Key', '文案');
  has(err.message, '401', '状态码');
  return err.message;
});

await checkAsync('错误映射: fetch 403 / 404 提示「网页无法抓取」', async () => {
  resetFetch(() => jsonResponse(403, {}));
  const err403 = await rejects(search.fetchPage(BASE_CFG, 'https://a.com/x'), '403');
  has(err403.message, '无法抓取', '403 文案');
  resetFetch(() => jsonResponse(404, {}));
  const err404 = await rejects(search.fetchPage(BASE_CFG, 'https://a.com/x'), '404');
  has(err404.message, '无法抓取', '404 文案');
  return `${err403.message} | ${err404.message}`;
});

await checkAsync('错误映射: 404 且为 search 场景时提示检查 Base URL', async () => {
  resetFetch(() => jsonResponse(404, {}));
  const err = await rejects(search.searchWeb(BASE_CFG, { query: 'q' }), '404');
  has(err.message, 'Base URL', '文案');
  return err.message;
});

await checkAsync('错误映射: 网络异常转为中文可读文案', async () => {
  resetFetch(() => {
    throw new TypeError('Failed to fetch');
  });
  const err = await rejects(search.searchWeb(BASE_CFG, { query: 'q' }), '网络异常');
  has(err.message, '无法连接', '文案');
  return err.message;
});

await checkAsync('错误映射: 未配置 Key → NeedsConfigError', async () => {
  resetFetch(() => jsonResponse(200, {}));
  const err = await rejects(search.searchWeb({ apiKey: '' }, { query: 'q' }), 'no key');
  eq(err.name, 'NeedsConfigError', '错误类型');
  ok(calls.length === 0, '不应发起请求');
  return err.message;
});

await checkAsync('取消: 外部 signal 中止时原样抛出 AbortError', async () => {
  resetFetch(
    (record) =>
      new Promise((resolve, reject) => {
        const signal = record.init && record.init.signal;
        if (!signal) return;
        if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  const controller = new AbortController();
  const pending = search.searchWeb(BASE_CFG, { query: 'q', signal: controller.signal });
  await sleep(10);
  controller.abort();
  const err = await rejects(pending, 'abort');
  eq(err.name, 'AbortError', '错误类型（必须是 AbortError，且不能被映射成中文文案）');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                              5. 深度模式                                    */
/* -------------------------------------------------------------------------- */

/** 构造一条归一化后的 source。 */
function fakeSource(index) {
  return {
    title: `T${index}`,
    url: `https://a.com/${index}`,
    snippet: 'S',
    domain: 'a.com',
    site: 'a.com',
    date: '2024-05-01',
    score: 0.5,
    authority: null,
    icon: '',
  };
}

await checkAsync('深度模式: 前 3 条并发抓取（不串行）', async () => {
  resetFetch(async (record) => {
    if (record.url.endsWith('/tools/fetch')) {
      await sleep(100);
      return jsonResponse(200, { title: 'P', content: 'X'.repeat(6000) });
    }
    return jsonResponse(200, {});
  });
  const sources = [fakeSource(1), fakeSource(2), fakeSource(3)];
  const started = Date.now();
  const filled = await search.attachContents(BASE_CFG, sources, {});
  const elapsed = Date.now() - started;
  eq(filled, 3, '成功条数');
  eq(calls.length, 3, '抓取次数');
  ok(elapsed < 280, `并发耗时 ${elapsed}ms（串行应 ≥300ms）`);
  ok(sources[0].content.length <= 4001, `正文截断长度 ${sources[0].content.length}`);
  return `elapsed=${elapsed}ms, len=${sources[0].content.length}`;
});

await checkAsync('深度模式: 单条失败静默降级，其余仍返回正文', async () => {
  resetFetch((record) => {
    const url = record.body && record.body.url;
    if (url.endsWith('/1')) return jsonResponse(403, {});
    if (url.endsWith('/2')) return jsonResponse(200, { title: 'P2', content: '正文二' });
    return Promise.reject(new TypeError('Failed to fetch'));
  });
  const sources = [fakeSource(1), fakeSource(2), fakeSource(3)];
  const filled = await search.attachContents(BASE_CFG, sources, {});
  eq(filled, 1, '成功条数');
  eq(sources[0].content, undefined, '失败项不写 content');
  eq(sources[1].content, '正文二', '成功项写入 content');
  eq(sources[2].content, undefined, '网络失败项不写 content');
  return 'ok';
});

await checkAsync('深度模式: 外部取消时向上抛出 AbortError', async () => {
  resetFetch(
    (record) =>
      new Promise((resolve, reject) => {
        const signal = record.init && record.init.signal;
        if (signal && signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else if (signal) signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
  );
  const controller = new AbortController();
  const pending = search.attachContents(BASE_CFG, [fakeSource(1)], { signal: controller.signal });
  await sleep(10);
  controller.abort();
  const err = await rejects(pending, 'abort');
  eq(err.name, 'AbortError', '错误类型');
  return 'ok';
});

await checkAsync('attachContents: 只抓前 limit 条', async () => {
  resetFetch(() => jsonResponse(200, { content: 'x' }));
  const sources = [fakeSource(1), fakeSource(2), fakeSource(3), fakeSource(4)];
  const filled = await search.attachContents(BASE_CFG, sources, { limit: 2 });
  eq(filled, 2, '条数');
  eq(calls.length, 2, '请求数');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                               6. run() 主流程                               */
/* -------------------------------------------------------------------------- */

/** 构造 run() 的上下文。 */
function makeContext(query, extra = {}) {
  const state = { deltas: '', sources: null, meta: null, statuses: [] };
  return {
    state,
    context: {
      query,
      settings: { ai: { maxSources: 5, searchFreshness: 'any', temperature: 0.6, stream: true } },
      secrets: { deepseek: { apiKey: 'sk-test', baseUrl: 'https://mock.deepseek.test' } },
      signal: extra.signal || null,
      onDelta: (delta) => {
        state.deltas += delta;
      },
      onSources: (sources, meta) => {
        state.sources = sources;
        state.meta = meta;
      },
      onStatus: (payload) => state.statuses.push(payload),
    },
  };
}

/** 标准 search 响应。 */
function searchPayload(count) {
  const results = [];
  for (let i = 1; i <= count; i += 1) {
    results.push({
      title: `结果${i}`,
      url: `https://site${i}.com/p`,
      snippet: `摘要${i}`,
      rerank_score: 2.4,
      authority: i === 1 ? 4 : -1,
      site_name: `站点${i}`,
      date: '2024-05-01',
    });
  }
  return { results };
}

await checkAsync('run: 检索 → onSources → 带引用总结', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(3));
    return sseResponse(chatSse('总结【1】'));
  });
  const { context, state } = makeContext('测试问题');
  const result = await search.run(context);
  eq(calls.length, 2, '请求数（1 次 search + 1 次 chat）');
  eq(state.sources.length, 3, 'onSources 条数');
  eq(result.text, '总结【1】', '返回文本');
  eq(state.deltas, '总结【1】', '流式增量累计');
  eq(result.sources.length, 3, '结果条数');
  has(state.statuses[0].phase, 'searching', '首个状态为检索中');
  eq(state.statuses[0].providerName, 'DeepSeek 联网', 'provider 名称');
  close(state.sources[0].score, 0.8, '首条 score 已归一化');
  eq(state.sources[0].authority, 4, '首条 authority');
  eq(state.sources[1].authority, null, '-1 → null');
  return 'ok';
});

await checkAsync('run: 空结果不调用 LLM', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, { results: [] });
    throw new Error(`不应请求 ${record.url}`);
  });
  const { context, state } = makeContext('没人知道的问题');
  const result = await search.run(context);
  eq(calls.length, 1, '只允许 1 次 search 请求');
  has(result.text, '没有检索到可用结果', '概述文案');
  eq(result.sources.length, 0, '结果条数');
  eq(state.sources.length, 0, 'onSources 传空数组');
  return 'ok';
});

await checkAsync('run: 总结失败且未吐字 → 降级为结果列表 + 概述', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(2));
    return jsonResponse(500, { error: { message: 'boom' } });
  });
  const { context } = makeContext('总结会失败的问题');
  const result = await search.run(context);
  eq(calls.length, 2, '请求数');
  has(result.text, '仅展示检索结果列表', '降级文案');
  eq(result.sources.length, 2, '结果仍完整返回');
  return 'ok';
});

await checkAsync('run: 深度模式抓取失败不影响结果与总结', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(3));
    if (record.url.endsWith('/tools/fetch')) return jsonResponse(403, {});
    return sseResponse(chatSse('总结'));
  });
  const { context, state } = makeContext('深度模式');
  context.secrets.deepseek.searchDepth = 'deep';
  const result = await search.run(context);
  eq(result.sources.length, 3, '结果完整');
  eq(result.text, '总结', '总结正常');
  eq(state.sources.filter((item) => item.content).length, 0, '正文抓取全部失败');
  ok(calls.some((call) => call.url.endsWith('/tools/fetch')), '确实尝试过抓取');
  ok(
    state.statuses.some((payload) => payload.phase === 'reading'),
    '有「正在精读」状态',
  );
  return 'ok';
});

await checkAsync('run: 深度模式抓取成功时正文写入 source', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(3));
    if (record.url.endsWith('/tools/fetch')) return jsonResponse(200, { content: '正文内容' });
    return sseResponse(chatSse('总结'));
  });
  const { context, state } = makeContext('深度模式成功');
  context.secrets.deepseek.searchDepth = 'deep';
  const result = await search.run(context);
  eq(result.sources.filter((item) => item.content === '正文内容').length, 3, '3 条正文');
  eq(result.meta.fetched, 3, 'result.meta.fetched');
  return 'ok';
});

await checkAsync('run: 缓存命中不重复检索，但总结重新生成', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(2));
    return sseResponse(chatSse('总结'));
  });
  const first = makeContext('缓存问题');
  await search.run(first.context);
  const searchCallsAfterFirst = calls.filter((call) => call.url.endsWith('/tools/search')).length;
  eq(searchCallsAfterFirst, 1, '第一次检索次数');

  const second = makeContext('缓存问题');
  const result = await search.run(second.context);
  eq(calls.filter((call) => call.url.endsWith('/tools/search')).length, 1, '第二次不再检索');
  eq(calls.filter((call) => call.url.includes('/chat/completions')).length, 2, '总结每次都重新生成');
  eq(second.state.meta.cached, true, 'meta.cached');
  eq(result.sources.length, 2, '结果条数');
  ok(
    second.state.statuses.some((payload) => payload.cached === true),
    '有缓存状态通知',
  );
  return 'ok';
});

await checkAsync('run: 时效筛选会改变检索词与缓存 key', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(1));
    return sseResponse(chatSse('总结'));
  });
  const first = makeContext('时效问题');
  await search.run(first.context);
  const second = makeContext('时效问题');
  second.context.settings.ai.searchFreshness = 'd7';
  await search.run(second.context);
  const searchCalls = calls.filter((call) => call.url.endsWith('/tools/search'));
  eq(searchCalls.length, 2, '不同时效 → 不同 key → 重新检索');
  has(searchCalls[1].body.query, 'after:', '第二次检索词带 after:');
  return searchCalls[1].body.query;
});

await checkAsync('run: 联网搜索开关关闭 → 明确报错且不发请求', async () => {
  cache.clearCache();
  resetFetch(() => jsonResponse(200, searchPayload(1)));
  const { context } = makeContext('关闭联网');
  context.secrets.deepseek.webSearch = false;
  const err = await rejects(search.run(context), 'webSearch=false');
  has(err.message, '已在设置中关闭', '文案');
  eq(calls.length, 0, '不应发起请求');
  return err.message;
});

await checkAsync('run: 无 Key → NeedsConfigError', async () => {
  cache.clearCache();
  resetFetch(() => jsonResponse(200, {}));
  const { context } = makeContext('无 Key');
  context.secrets.deepseek.apiKey = '';
  const err = await rejects(search.run(context), 'no key');
  eq(err.name, 'NeedsConfigError', '错误类型');
  return err.message;
});

await checkAsync('run: 老数据缺 webSearch / searchDepth 时按「开启 + 标准」处理', async () => {
  cache.clearCache();
  resetFetch((record) => {
    if (record.url.endsWith('/tools/search')) return jsonResponse(200, searchPayload(1));
    return sseResponse(chatSse('总结'));
  });
  const { context } = makeContext('老数据');
  context.secrets.deepseek = { apiKey: 'sk-test', baseUrl: 'https://mock.deepseek.test' };
  const result = await search.run(context);
  eq(result.sources.length, 1, '仍能检索');
  ok(!calls.some((call) => call.url.endsWith('/tools/fetch')), '默认标准模式不抓正文');
  return 'ok';
});

await checkAsync('testConnection: 使用 count=3 真实检索', async () => {
  cache.clearCache();
  resetFetch(() => jsonResponse(200, searchPayload(3)));
  const outcome = await search.testConnection({ apiKey: 'sk-test', baseUrl: 'https://mock.deepseek.test' });
  eq(calls[0].body.count, 3, 'count');
  eq(outcome.results, 3, 'results');
  ok(Number.isFinite(outcome.latency), 'latency');
  return `latency=${outcome.latency}`;
});

await checkAsync('testConnection: 无 Key 时抛 NeedsConfigError', async () => {
  resetFetch(() => jsonResponse(200, {}));
  const err = await rejects(search.testConnection({}), 'no key');
  eq(err.name, 'NeedsConfigError', '错误类型');
  return err.message;
});

/* -------------------------------------------------------------------------- */
/*                               7. providers/index.js                         */
/* -------------------------------------------------------------------------- */

check('index: kindOf 覆盖 search / chat / 未知', () => {
  eq(providers.kindOf('yuanbao'), 'search');
  eq(providers.kindOf('deepseek-search'), 'search');
  eq(providers.kindOf('deepseek'), 'chat');
  eq(providers.kindOf('custom'), 'chat');
  eq(providers.kindOf('nope'), 'chat', '未知回落 chat');
  return 'ok';
});

check('index: PROVIDER_META 全部声明 kind', () => {
  const ids = Object.keys(providers.PROVIDER_META);
  eq(ids, ['yuanbao', 'deepseek', 'deepseek-search', 'custom'], '注册顺序');
  ids.forEach((id) => {
    const kind = providers.PROVIDER_META[id].kind;
    ok(kind === 'search' || kind === 'chat', `${id}.kind=${kind}`);
  });
  eq(providers.PROVIDER_META['deepseek-search'].name, 'DeepSeek 联网', '显示名');
  eq(providers.PROVIDER_IDS, ids, 'PROVIDER_IDS 与 META 同步');
  return ids.join(',');
});

check('index: configState 对 deepseek-search 复用 deepseek.apiKey', () => {
  eq(providers.configState('deepseek-search', {}), 'missing', '空');
  eq(providers.configState('deepseek-search', { deepseek: { apiKey: '  ' } }), 'missing', '空白');
  eq(providers.configState('deepseek-search', { deepseek: { apiKey: 'sk-1' } }), 'ready', '已填');
  eq(providers.hasCredentials('deepseek-search', { deepseek: { apiKey: 'sk-1' } }), true, 'hasCredentials');
  eq(providers.configState('custom', { custom: { baseUrl: 'x' } }), 'partial', 'custom partial');
  return 'ok';
});

check('index: 未知 provider 回落 yuanbao', () => {
  eq(providers.metaOf('nope').id, 'yuanbao', 'metaOf');
  const provider = providers.getProvider({ ai: { provider: 'nope', demoMode: true } }, {});
  eq(provider.meta.id, 'yuanbao', 'getProvider');
  return 'ok';
});

check('index: deepseek-search 无密钥 + 演示开 → 演示 provider 且 kind=search', () => {
  const provider = providers.getProvider(
    { ai: { provider: 'deepseek-search', demoMode: true } },
    { deepseek: { apiKey: '' } },
  );
  eq(provider.meta.demo, true, 'demo');
  eq(provider.meta.kind, 'search', 'kind');
  eq(provider.meta.id, 'deepseek-search', 'id');
  return 'ok';
});

check('index: deepseek-search 有密钥 → 真实 provider', () => {
  const provider = providers.getProvider(
    { ai: { provider: 'deepseek-search', demoMode: true } },
    { deepseek: { apiKey: 'sk-1' } },
  );
  eq(provider.meta.demo, false, 'demo');
  eq(provider.meta.configured, true, 'configured');
  eq(typeof provider.run, 'function', 'run');
  return 'ok';
});

await checkAsync('index: 演示 provider 输出 20 条结构完整的结果且不发请求', async () => {
  resetFetch(() => {
    throw new Error('演示模式不应发起网络请求');
  });
  const provider = providers.createDemoProvider('deepseek-search', 'missing-credentials');
  let received = null;
  let streamed = '';
  const result = await provider.run({
    query: '演示问题',
    settings: { ai: { maxSources: 20 } },
    onSources: (sources) => {
      received = sources;
    },
    onDelta: (delta) => {
      streamed += delta;
    },
  });
  ok(Array.isArray(received), 'sources 是数组');
  eq(received.length, 20, '条数');
  eq(calls.length, 0, '零网络请求');
  ok(typeof result.text === 'string' && result.text.length > 0, '演示文本非空');
  eq(streamed, result.text, 'onDelta 累计等于返回文本');
  eq(result.meta.tool, 'demo', 'meta.tool');
  const first = received[0];
  ['title', 'url', 'snippet', 'domain', 'site', 'date'].forEach((key) => {
    ok(String(first[key] || '').length > 0, `${key} 非空`);
  });
  ok(Number.isFinite(first.score), 'score 为数字');
  eq(first.authority, null, 'authority');
  return '结构完整';
});

/* -------------------------------------------------------------------------- */
/*                                 8. defaults.js                              */
/* -------------------------------------------------------------------------- */

check('defaults: AI_ENGINES 4 条 / WEB 7 条 / ENGINES 11 条', () => {
  eq(defaults.AI_ENGINES.length, 4, 'AI');
  eq(defaults.WEB_ENGINES.length, 7, 'WEB');
  eq(defaults.ENGINES.length, 11, '合计');
  return '[4, 7, 11]';
});

check('defaults: 第 4 个 AI 引擎是 ai-deepseek-web → provider deepseek-search', () => {
  eq(defaults.AI_ENGINES[2].id, 'ai-deepseek-web', 'id');
  eq(defaults.AI_ENGINES[2].name, 'DeepSeek 联网', 'name');
  eq(defaults.AI_ENGINES[2].provider, 'deepseek-search', 'provider');
  eq(defaults.AI_ENGINES[3].id, 'ai-custom', '顺序（自定义仍在最后）');
  return 'ok';
});

check('defaults: 引擎 id 唯一', () => {
  const ids = defaults.ENGINES.map((engine) => engine.id);
  eq(new Set(ids).size, ids.length, '重复 id');
  return 'ok';
});

check('defaults: BANGS 含 !ds → ai-deepseek-web，且 BANG_HINTS 同步', () => {
  eq(defaults.BANGS['!ds'], 'ai-deepseek-web');
  eq(defaults.BANGS['!d'], 'ai-deepseek', '!d 未被误改');
  const hint = defaults.BANG_HINTS.find((item) => item.cmd === '!ds');
  ok(hint, '!ds 提示存在');
  eq(hint.desc, 'DeepSeek 联网', '提示文案');
  Object.keys(defaults.BANGS).forEach((cmd) => {
    ok(defaults.ENGINES.some((engine) => engine.id === defaults.BANGS[cmd]), `${cmd} 指向存在的引擎`);
  });
  return 'ok';
});

check('defaults: 默认密钥 / 设置新增字段', () => {
  eq(defaults.DEFAULT_SECRETS.deepseek.webSearch, true, 'webSearch');
  eq(defaults.DEFAULT_SECRETS.deepseek.searchDepth, 'normal', 'searchDepth');
  eq(defaults.DEFAULT_SETTINGS.ai.searchFreshness, 'any', 'searchFreshness');
  eq(defaults.findEngine('ai-deepseek-web').provider, 'deepseek-search', 'findEngine');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                                  9. storage.js                              */
/* -------------------------------------------------------------------------- */

/** 内存 localStorage 桩。 */
const memoryStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, value),
    removeItem: (key) => memoryStore.delete(key),
  },
};
globalThis.indexedDB = undefined;

const storage = await import(new URL('storage.js', SRC).href);

await checkAsync('storage: searchFreshness 只接受合法档位', async () => {
  memoryStore.clear();
  await storage.setSettings({ ai: { searchFreshness: 'd7' } });
  eq((await storage.getSettings()).ai.searchFreshness, 'd7', '合法值保留');
  await storage.setSettings({ ai: { searchFreshness: 'zzz' } });
  eq((await storage.getSettings()).ai.searchFreshness, 'any', '非法值回落 any');
  await storage.setSettings({ ai: { searchFreshness: '' } });
  eq((await storage.getSettings()).ai.searchFreshness, 'any', '空串回落 any');
  return 'ok';
});

await checkAsync('storage: maxSources / temperature 夹取仍有效（回归）', async () => {
  memoryStore.clear();
  await storage.setSettings({ ai: { maxSources: 0 } });
  eq((await storage.getSettings()).ai.maxSources, 1, 'maxSources 0 → 1');
  await storage.setSettings({ ai: { maxSources: 999 } });
  eq((await storage.getSettings()).ai.maxSources, 50, '上限 50');
  await storage.setSettings({ ai: { temperature: 9 } });
  eq((await storage.getSettings()).ai.temperature, 2, 'temperature 上限');
  await storage.setSettings({ ai: { stream: false } });
  eq((await storage.getSettings()).ai.stream, false, 'stream 可关闭');
  return 'ok';
});

await checkAsync('storage: 老 secrets 缺 webSearch / searchDepth 时补齐默认', async () => {
  memoryStore.clear();
  memoryStore.set('aurora:secrets', JSON.stringify({ deepseek: { apiKey: 'sk-old' } }));
  const secrets = await storage.getSecrets();
  eq(secrets.deepseek.apiKey, 'sk-old', '已有字段保留');
  eq(secrets.deepseek.webSearch, true, 'webSearch 默认 true');
  eq(secrets.deepseek.searchDepth, 'normal', 'searchDepth 默认 normal');
  // 元宝改为云 API 签名后默认走 HTTP 直连（MCP 网关只支持 Bearer）
  eq(secrets.yuanbao.transport, 'http', '其它 provider 默认值仍在');
  eq(secrets.yuanbao.authMode, 'tc3', '默认鉴权方式为 TC3 签名');
  return 'ok';
});

await checkAsync('storage: 设置写坏 JSON 时不抛错', async () => {
  memoryStore.clear();
  memoryStore.set('aurora:settings', '{not json');
  const settings = await storage.getSettings();
  eq(settings.ai.provider, 'yuanbao', '回落默认 provider');
  eq(settings.version, defaults.SETTINGS_VERSION, '版本号');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                       10. ai-panel.js 纯逻辑（非导出）                       */
/* -------------------------------------------------------------------------- */

/**
 * 加载 ai-panel.js 内部的纯函数（它们没有 export）：
 * 去掉 import 语句后附加 export，再用 data: URL 导入。
 * 只导入、不执行任何依赖 DOM 的方法，因此无需 jsdom。
 */
async function loadPanelInternals() {
  const file = fileURLToPath(new URL('ai-panel.js', SRC));
  const source = await readFile(file, 'utf8');
  const stripped = source.replace(/^import[^\n]*from[^\n]*;\s*$/gm, '');
  if (/^import\s/m.test(stripped)) throw new Error('ai-panel.js 仍有未剥离的 import（可能写成了多行）');
  const names = ['dedupeSources', 'isFreshDate', 'urlKeyOf', 'titleKeyOf', 'shortProviderName', 'domainOf'];
  // 被剥离的 import 里只有 hostOf 会被这些纯函数用到，这里补一个等价实现
  const shim = [
    'const hostOf = (raw) => {',
    '  try { return new URL(String(raw || "")).hostname.replace(/^www\\./, ""); }',
    '  catch (err) { return ""; }',
    '};',
  ].join('\n');
  const code = `${shim}\n${stripped}\nexport { ${names.join(', ')} };\n`;
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
  return { mod: await import(url), source };
}

const panelBundle = await loadPanelInternals();
const panel = panelBundle.mod;

/** 按「N 天前」生成 YYYY-MM-DD（UTC，避免本地时区导致边界漂移）。 */
function daysAgo(days) {
  const now = new Date();
  const stamp = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - days * 86400000;
  const date = new Date(stamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

check('dedupe: 同 URL（忽略 hash / 尾斜杠 / 大小写）只留 score 高者', () => {
  const list = [
    { url: 'https://A.com/x', title: '标题一', score: 0.3 },
    { url: 'https://a.com/x/#part', title: '标题一', score: 0.9 },
    { url: 'https://a.com/y', title: '标题二', score: 0.5 },
  ];
  const out = panel.dedupeSources(list);
  eq(out.length, 2, '条数');
  eq(out[0].score, 0.9, '保留高分');
  return 'ok';
});

check('dedupe: 同域名 + 标题前 12 字相同（忽略空白）判重', () => {
  const list = [
    { url: 'https://a.com/1', title: '腾讯云 云开发 入门指南完全版上篇', score: 0.4 },
    { url: 'https://a.com/2', title: '腾讯云云开发入门指南完全版下篇', score: 0.8 },
  ];
  const out = panel.dedupeSources(list);
  eq(out.length, 1, '条数');
  eq(out[0].score, 0.8, '保留高分');
  eq(out[0].url, 'https://a.com/2', '保留的是高分那条');
  return 'ok';
});

check('dedupe: 同域名但标题不同 → 不去重', () => {
  const list = [
    { url: 'https://a.com/1', title: '完全不同的标题甲甲甲甲甲甲甲甲', score: 0.4 },
    { url: 'https://a.com/2', title: '另外一篇标题乙乙乙乙乙乙乙乙乙', score: 0.8 },
  ];
  eq(panel.dedupeSources(list).length, 2);
  return 'ok';
});

check('dedupe: 无 url / 非数组 / 超短同标题的容错', () => {
  eq(panel.dedupeSources(null), [], 'null');
  eq(panel.dedupeSources([{ title: '无链接' }]), [], '无 url 被过滤');
  const out = panel.dedupeSources([
    { url: 'https://a.com/1', title: '短', score: 0.2 },
    { url: 'https://a.com/2', title: '短', score: 0.6 },
  ]);
  eq(out.length, 1, '同域名 + 完全相同的短标题同样判重');
  eq(out[0].score, 0.6, '保留高分');
  return 'ok';
});

check('dedupe: score 缺失时按 -1 处理不崩', () => {
  const out = panel.dedupeSources([
    { url: 'https://a.com/1', title: '无分数标题一二三四五六七八九十' },
    { url: 'https://a.com/1', title: '无分数标题一二三四五六七八九十', score: 0.2 },
  ]);
  eq(out.length, 1, '条数');
  eq(out[0].score, 0.2, '有分者胜出');
  return 'ok';
});

check('fresh: 6 天 / 7 天算新，8 天不算', () => {
  eq(panel.isFreshDate(daysAgo(6)), true, '6 天');
  eq(panel.isFreshDate(daysAgo(7)), true, '7 天');
  eq(panel.isFreshDate(daysAgo(8)), false, '8 天');
  eq(panel.isFreshDate(daysAgo(0)), true, '今天');
  return `6d=true 7d=true 8d=false (today=${daysAgo(0)})`;
});

check('fresh: 非法 / 空 / 非日期文本返回 false', () => {
  eq(panel.isFreshDate(''), false, '空');
  eq(panel.isFreshDate(null), false, 'null');
  eq(panel.isFreshDate('昨天'), false, '中文');
  eq(panel.isFreshDate(daysAgo(3).replace(/-/g, '/')), true, '斜杠格式可解析（近期）');
  return 'ok';
});

check('panel: shortProviderName 映射', () => {
  eq(panel.shortProviderName({ id: 'yuanbao' }), '元宝');
  eq(panel.shortProviderName({ id: 'deepseek-search' }), 'DeepSeek');
  eq(panel.shortProviderName({ id: 'deepseek' }), 'DeepSeek');
  eq(panel.shortProviderName({ id: 'custom' }), '自定义');
  return 'ok';
});

check('panel: 源码静态约束（节流 80ms / visibilitychange 补渲染 / 去重先于编号）', () => {
  const source = panelBundle.source;
  has(source, 'const RENDER_INTERVAL = 80', '流式节流 80ms');
  has(source, 'visibilitychange', '页面可见性补渲染');
  has(source, 'document.hidden', '隐藏时跳过渲染');
  has(source, "setBadge('已停止', 'stop')", '停止徽标文案 + tone');
  has(source, 'this.stopped', '停止后防 abort 分支回写');
  const renderResults = source.slice(source.indexOf('renderResults(sources, meta)'));
  const dedupeAt = renderResults.indexOf('dedupeSources(');
  const mapAt = renderResults.indexOf('this.results = list.map');
  ok(dedupeAt > 0 && mapAt > dedupeAt, '去重发生在编号之前');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                                  输出                                       */
/* -------------------------------------------------------------------------- */

process.stdout.write(`${JSON.stringify({ cases }, null, 2)}\n`);
