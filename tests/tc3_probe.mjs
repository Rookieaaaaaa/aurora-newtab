/**
 * tc3_probe.mjs — 腾讯云 TC3 签名与元宝云 API 接入的纯逻辑测试
 * 不依赖外网：所有 HTTP 均走本地 fetch 桩。
 *
 * 用法：node tests/tc3_probe.mjs
 * 输出：JSON {cases:[{name,ok,detail}]}
 */

import { signTc3 } from '../src/providers/tc3.js';
import { useTc3, extractSources, pagesFromPayload, normalizeCnt, TC_DEFAULTS } from '../src/providers/yuanbao-mcp.js';
import { configState, getProvider, metaOf } from '../src/providers/index.js';
import { DEFAULT_SETTINGS, DEFAULT_SECRETS } from '../src/defaults.js';

const cases = [];

function check(name, fn) {
  try {
    const detail = fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

function ok(value, label) {
  if (!value) throw new Error(label || '断言为假');
  return 'ok';
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} 期望 ${e}，实际 ${a}`);
  return a;
}

/* -------------------------------------------------------------------------- */
/*                                  fetch 桩                                   */
/* -------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;
let captured = null;
let nextResponse = null;

function stubFetch(handler) {
  captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: init && init.body ? String(init.body) : '' };
    return handler(captured);
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

/** 构造一条官方 Pages（JSON 字符串形态）。 */
function page(overrides = {}) {
  return JSON.stringify({
    title: '示例标题',
    url: 'https://cloud.tencent.com/document/product/1',
    date: '2026/08/10 11:04:00',
    passage: '这是标准摘要 passage',
    content: '这是动态摘要 content，比 passage 更长一些',
    site: '腾讯云',
    favicon: 'https://cdn-yb.icon.qq.com/zuowei_dir/cloud_tencent_cn.ico',
    score: 0.786,
    ...overrides,
  });
}

const SECRET = { secretId: 'AKIDtest0000000000000', secretKey: 'testsecret0000000000' };

/* -------------------------------------------------------------------------- */
/*                              1. TC3 签名                                    */
/* -------------------------------------------------------------------------- */

await checkAsync('tc3: 相同输入签名幂等', async () => {
  const args = {
    ...SECRET,
    host: 'wsa.tencentcloudapi.com',
    action: 'SearchPro',
    version: '2025-05-08',
    body: '{"Query":"x"}',
    timestamp: 1761200000,
  };
  const a = await signTc3(args);
  const b = await signTc3(args);
  ok(a.signature === b.signature, '两次签名不一致');
  eq(a.signature.length, 64, '签名长度');
  return a.signature.slice(0, 12);
});

await checkAsync('tc3: Authorization 结构与 credential scope 正确', async () => {
  const { headers } = await signTc3({
    ...SECRET,
    host: 'wsa.tencentcloudapi.com',
    action: 'SearchPro',
    version: '2025-05-08',
    body: '{}',
    timestamp: 1761200000,
  });
  const auth = headers.Authorization;
  ok(auth.startsWith('TC3-HMAC-SHA256 Credential=AKIDtest0000000000000/'), `前缀错误：${auth.slice(0, 40)}`);
  ok(auth.includes('/wsa/tc3_request'), 'credential scope 缺少 /wsa/tc3_request');
  ok(auth.includes('SignedHeaders=content-type;host'), 'SignedHeaders 不正确');
  ok(/Signature=[0-9a-f]{64}$/.test(auth), 'Signature 不是 64 位小写 hex');
  return auth.slice(0, 48);
});

await checkAsync('tc3: 时间戳按 UTC 取日期', async () => {
  // 1761200000 = 2025-10-23T04:53:20Z
  const { headers } = await signTc3({
    ...SECRET,
    host: 'wsa.tencentcloudapi.com',
    action: 'SearchPro',
    version: '2025-05-08',
    body: '{}',
    timestamp: 1761200000,
  });
  ok(headers.Authorization.includes('/2025-10-23/wsa/tc3_request'), headers.Authorization.slice(0, 80));
  eq(headers['X-TC-Action'], 'SearchPro', 'X-TC-Action');
  eq(headers['X-TC-Version'], '2025-05-08', 'X-TC-Version');
  eq(headers['X-TC-Timestamp'], '1761200000', 'X-TC-Timestamp');
  eq(headers['Content-Type'], 'application/json', 'Content-Type');
  return '2025-10-23';
});

await checkAsync('tc3: 缺少 SecretId 抛错', async () => {
  let thrown = null;
  try {
    await signTc3({ ...SECRET, secretId: '', host: 'h', action: 'A', version: 'V', body: '{}' });
  } catch (err) {
    thrown = err;
  }
  ok(thrown && /SecretId/.test(thrown.message), '未抛出 SecretId 相关错误');
  return thrown.message;
});

await checkAsync('tc3: 缺少 SecretKey 抛错', async () => {
  let thrown = null;
  try {
    await signTc3({ ...SECRET, secretKey: '', host: 'h', action: 'A', version: 'V', body: '{}' });
  } catch (err) {
    thrown = err;
  }
  ok(thrown && /SecretKey/.test(thrown.message), '未抛出 SecretKey 相关错误');
  return thrown.message;
});

await checkAsync('tc3: 签名随请求体变化（防“签名与 body 不一致”回归）', async () => {
  const base = {
    ...SECRET,
    host: 'wsa.tencentcloudapi.com',
    action: 'SearchPro',
    version: '2025-05-08',
    timestamp: 1761200000,
  };
  const a = await signTc3({ ...base, body: '{"Query":"a"}' });
  const b = await signTc3({ ...base, body: '{"Query":"b"}' });
  ok(a.signature !== b.signature, '不同请求体产生了相同签名');
  return 'differs';
});

/* -------------------------------------------------------------------------- */
/*                          2. 鉴权方式判定与配置态                             */
/* -------------------------------------------------------------------------- */

check('authMode: 显式 tc3', () => eq(useTc3({ authMode: 'tc3', apiKey: 'sk-x' }), true));
check('authMode: 显式 bearer 即使有密钥对也走 Bearer', () =>
  eq(useTc3({ authMode: 'bearer', secretId: 'a', secretKey: 'b' }), false));
check('authMode: 未配置时按密钥对自动判定', () =>
  eq(useTc3({ secretId: 'a', secretKey: 'b' }), true));
check('authMode: 只有 API Key 时走 Bearer', () => eq(useTc3({ apiKey: 'sk-x' }), false));
check('authMode: 空配置不崩', () => eq(useTc3(null), false));

check('configState: TC3 密钥齐全即 ready（endpoint 有默认值）', () =>
  eq(configState('yuanbao', { yuanbao: { authMode: 'tc3', ...SECRET } }), 'ready'));
check('configState: TC3 只填 SecretId 为 partial', () =>
  eq(configState('yuanbao', { yuanbao: { authMode: 'tc3', secretId: 'a' } }), 'partial'));
check('configState: TC3 全空为 missing', () =>
  eq(configState('yuanbao', { yuanbao: { authMode: 'tc3' } }), 'missing'));
check('configState: Bearer 需要地址 + Key', () =>
  eq(configState('yuanbao', { yuanbao: { authMode: 'bearer', endpoint: 'https://x/', apiKey: 'k' } }), 'ready'));
check('configState: 默认配置直接可用', () =>
  eq(configState('yuanbao', DEFAULT_SECRETS), 'ready'));

check('getProvider: yuanbao 默认为搜索类 provider', () => {
  const provider = getProvider(DEFAULT_SETTINGS, DEFAULT_SECRETS);
  eq(provider.meta.id, 'yuanbao');
  eq(provider.meta.kind, 'search');
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                        3. Pages 解析与字段归一化                             */
/* -------------------------------------------------------------------------- */

check('pages: 官方 Pages 为 JSON 字符串数组', () => {
  const payload = { Response: { Pages: [page(), page({ url: 'https://a.com/2' })], Version: 'standard' } };
  const pages = pagesFromPayload(payload);
  eq(pages.length, 2, 'Pages 条数');
  eq(pages[0].title, '示例标题');
  return 'ok';
});

check('normalize: favicon → icon', () => {
  const payload = { Response: { Pages: [page()] } };
  const [item] = extractSources(payload, 10);
  eq(item.icon, 'https://cdn-yb.icon.qq.com/zuowei_dir/cloud_tencent_cn.ico');
  return item.icon;
});

check('normalize: content 字段保留并截断', () => {
  const payload = { Response: { Pages: [page({ content: 'x'.repeat(3000) })] } };
  const [item] = extractSources(payload, 10);
  ok(typeof item.content === 'string' && item.content.length <= 1201, `content 长度 ${item.content.length}`);
  return `${item.content.length} 字符`;
});

check('normalize: snippet 优先 passage', () => {
  const payload = { Response: { Pages: [page()] } };
  const [item] = extractSources(payload, 10);
  eq(item.snippet, '这是标准摘要 passage');
  return 'ok';
});

check('normalize: date 归一为 YYYY-MM-DD', () => {
  const payload = { Response: { Pages: [page({ date: '2026/08/10 11:04:00' })] } };
  const [item] = extractSources(payload, 10);
  eq(item.date, '2026-08-10');
  return 'ok';
});

check('normalize: score 落在 0~1', () => {
  const payload = { Response: { Pages: [page({ score: 0.786 })] } };
  const [item] = extractSources(payload, 10);
  eq(item.score, 0.786);
  return 'ok';
});

check('normalize: 标准版无 authority_level 时 authority 为 null', () => {
  const payload = { Response: { Pages: [page()] } };
  const [item] = extractSources(payload, 10);
  eq(item.authority, null);
  return 'ok';
});

check('normalize: 旗舰版 authority_level 原样保留', () => {
  const payload = { Response: { Pages: [page({ authority_level: 5 })] } };
  const [item] = extractSources(payload, 10);
  eq(item.authority, 5);
  return 'ok';
});

check('normalize: pics 计数字段存在', () => {
  const payload = {
    Response: { Pages: [page({ pics: [{ caption: 'a', origin_url: 'https://x/1.jpg' }] })] },
  };
  const [item] = extractSources(payload, 10);
  eq(item.pics, 1);
  return 'ok';
});

check('normalize: 同 URL 去重', () => {
  const payload = { Response: { Pages: [page(), page()] } };
  eq(extractSources(payload, 10).length, 1);
  return 'ok';
});

check('normalize: 非 http(s) 结果被丢弃', () => {
  const payload = { Response: { Pages: [page({ url: 'ftp://x/y' }), page({ url: 'https://b.com/2' })] } };
  eq(extractSources(payload, 10).length, 1);
  return 'ok';
});

check('cnt: 只允许 10/20/30/40/50', () => {
  eq([1, 7, 10, 19, 20, 35, 50, 99, 0].map(normalizeCnt), [10, 10, 10, 20, 20, 30, 50, 50, 20]);
  return 'ok';
});

/* -------------------------------------------------------------------------- */
/*                            4. 真实请求链路（桩）                             */
/* -------------------------------------------------------------------------- */

let querySeq = 0;

/**
 * 用 fetch 桩跑一次 run()。
 * 每次换唯一 query 并清空缓存，避免用例之间互相“命中缓存”导致断言失真。
 */
function runWith(payload, secrets = DEFAULT_SECRETS) {
  stubFetch(() => jsonResponse(payload));
  return {
    run: async () => {
      const collected = { sources: null, meta: null, statuses: [], text: '' };
      const cache = await import('../src/providers/cache.js');
      cache.clearCache();
      const mod = await import('../src/providers/yuanbao-mcp.js');
      querySeq += 1;
      const result = await mod.run({
        query: `腾讯云云开发是什么-用例${querySeq}`,
        settings: DEFAULT_SETTINGS,
        secrets,
        onStatus: (s) => collected.statuses.push(s),
        onSources: (list, meta) => {
          collected.sources = list;
          collected.meta = meta;
        },
        onDelta: (delta) => {
          collected.text += delta;
        },
      });
      return { ...collected, result };
    },
  };
}

await checkAsync('请求: TC3 模式命中云 API 默认地址', async () => {
  const helper = runWith({ Response: { Pages: [page()], Version: 'standard', RequestId: 'r1' } });
  await helper.run();
  eq(captured.url, 'https://wsa.tencentcloudapi.com/');
  return captured.url;
});

await checkAsync('请求: Action/Version 走请求头而非请求体', async () => {
  const helper = runWith({ Response: { Pages: [page()], Version: 'standard' } });
  await helper.run();
  const headers = captured.init.headers;
  eq(headers['X-TC-Action'], 'SearchPro');
  eq(headers['X-TC-Version'], '2025-05-08');
  const body = JSON.parse(captured.body);
  ok(body.Action === undefined, 'body 不应包含 Action');
  ok(body.Version === undefined, 'body 不应包含 Version');
  ok(Boolean(body.Query), 'body 应包含 Query');
  return Object.keys(body).join(',');
});

await checkAsync('请求: Authorization 为 TC3 签名', async () => {
  const helper = runWith({ Response: { Pages: [page()], Version: 'standard' } });
  await helper.run();
  ok(/^TC3-HMAC-SHA256 Credential=/.test(captured.init.headers.Authorization), 'Authorization 不是 TC3 格式');
  return 'TC3';
});

await checkAsync('请求: 请求头不含 Bearer', async () => {
  const helper = runWith({ Response: { Pages: [page()], Version: 'standard' } });
  await helper.run();
  const auth = captured.init.headers.Authorization;
  ok(!/^Bearer/.test(auth), 'TC3 模式下不应带 Bearer');
  return auth.slice(0, 20);
});

await checkAsync('结果: meta.transport 标识 TC3', async () => {
  const helper = runWith({ Response: { Pages: [page()], Version: 'standard' } });
  const { meta } = await helper.run();
  eq(meta.transport, 'TC3');
  eq(meta.tool, 'SearchPro');
  return JSON.stringify(meta);
});

await checkAsync('鉴权: 业务错误码 ResourceNotFound 给出中文指引', async () => {
  const helper = runWith({
    Response: { Error: { Code: 'ResourceNotFound', Message: 'resource not found' }, RequestId: 'r2' },
  });
  let thrown = null;
  try {
    await helper.run();
  } catch (err) {
    thrown = err;
  }
  ok(thrown, '未抛错');
  ok(/尚未开通/.test(thrown.message), `文案缺失指引：${thrown.message}`);
  return thrown.message;
});

await checkAsync('鉴权: 签名失败 AuthFailure 给出密钥检查提示', async () => {
  const helper = runWith({
    Response: { Error: { Code: 'AuthFailure', Message: 'signature mismatch' } },
  });
  let thrown = null;
  try {
    await helper.run();
  } catch (err) {
    thrown = err;
  }
  ok(thrown && /SecretId/.test(thrown.message), thrown ? thrown.message : '未抛错');
  return thrown.message;
});

await checkAsync('鉴权: RequestLimitExceeded 提示稍后重试', async () => {
  const helper = runWith({ Response: { Error: { Code: 'RequestLimitExceeded', Message: 'qps' } } });
  let thrown = null;
  try {
    await helper.run();
  } catch (err) {
    thrown = err;
  }
  ok(thrown && /稍后重试/.test(thrown.message), thrown ? thrown.message : '未抛错');
  return thrown.message;
});

await checkAsync('鉴权: Bearer 模式下改回 Bearer 头（向后兼容）', async () => {
  const bearerSecrets = {
    ...DEFAULT_SECRETS,
    yuanbao: {
      ...DEFAULT_SECRETS.yuanbao,
      authMode: 'bearer',
      transport: 'http',
      endpoint: 'https://api.wsa.cloud.tencent.com/SearchPro',
      apiKey: 'sk-test',
    },
  };
  const helper = runWith({ Response: { Pages: [page()] } }, bearerSecrets);
  await helper.run();
  ok(/^Bearer sk-test$/.test(captured.init.headers.Authorization), captured.init.headers.Authorization);
  eq(captured.url, 'https://api.wsa.cloud.tencent.com/SearchPro');
  const body = JSON.parse(captured.body);
  eq(body.Action, 'SearchPro', 'Bearer 模式 body 需带 Action');
  return 'Bearer';
});

await checkAsync('缓存: 第二次相同查询不再发起检索请求', async () => {
  const mod = await import('../src/providers/yuanbao-mcp.js');
  const cache = await import('../src/providers/cache.js');
  cache.clearCache();
  stubFetch(() => jsonResponse({ Response: { Pages: [page()], Version: 'standard' } }));
  const ctx = {
    query: '缓存测试唯一查询',
    settings: DEFAULT_SETTINGS,
    secrets: DEFAULT_SECRETS,
    onStatus: () => {},
    onSources: () => {},
    onDelta: () => {},
  };
  await mod.run(ctx);
  const firstUrl = captured.url;
  captured = null;
  const hit = { sources: null, meta: null };
  await mod.run({
    ...ctx,
    onSources: (list, meta) => {
      hit.sources = list;
      hit.meta = meta;
    },
  });
  ok(captured === null, '缓存命中时不应再发请求');
  ok(hit.meta && hit.meta.cached === true, 'meta.cached 应为 true');
  return `first=${firstUrl ? 'yes' : 'no'}`;
});

/* -------------------------------------------------------------------------- */
/*                                 输出                                        */
/* -------------------------------------------------------------------------- */

globalThis.fetch = realFetch;

const failed = cases.filter((item) => !item.ok);
process.stdout.write(`${JSON.stringify({ cases, summary: { total: cases.length, failed: failed.length } }, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
