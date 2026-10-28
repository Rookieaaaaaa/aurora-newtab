/**
 * providers/deepseek-search.js — DeepSeek 原生联网搜索（Search + Fetch）
 *
 * 官方文档：
 *   POST https://api.deepseek.com/v1/tools/search   —— 联网检索
 *   POST https://api.deepseek.com/v1/tools/fetch    —— 抓取单页正文（Markdown）
 *
 * 流程：
 *   1) 调 /v1/tools/search 拿到 results[]；
 *   2) 归一化成项目统一的 source 结构；
 *   3) （可选）深度模式对前 3 条结果并发调用 /v1/tools/fetch 补正文；
 *   4) 用同一个 DeepSeek 密钥调 streamChat() 生成带 [1][2] 引用的总结；
 *   5) 没有可用总结模型时降级成「结果列表 + 一句概述」。
 *
 * 约定（与面板消费字段严格一致）：
 *   { title, url, snippet, domain, site, date, score, authority, icon, content? }
 *   score 为 0~1（面板按百分比展示），authority 为 0~4 或 null（-1 未知）。
 */

import { DEFAULT_AI_PROMPT } from '../defaults.js';
import { NeedsConfigError, ProviderError, describeError, hostOf, sleep, truncate } from '../utils.js';
import { buildCacheKey, getCached, setCached } from './cache.js';
import { streamChat } from './deepseek.js';

/** provider id（缓存 key 前缀）。 */
const PROVIDER_ID = 'deepseek-search';

/** 接口路径（相对 /v1）。 */
const SEARCH_PATH = '/tools/search';
const FETCH_PATH = '/tools/fetch';

/** 默认 Base URL（用户清空 baseUrl 时兜底）。 */
const DEFAULT_CHAT_BASE = 'https://api.deepseek.com/v1';

/** 超时（文档限速：Search 100 QPS / Fetch 25 QPS，这里只负责单请求超时）。 */
const SEARCH_TIMEOUT = 20000;
const FETCH_TIMEOUT = 12000;

/** 文档约束：query / ori_question 均为 1~128 字符，count 为 1~50。 */
const MAX_QUERY_LEN = 128;
const MAX_ORI_LEN = 128;
const MAX_COUNT = 50;
const DEFAULT_COUNT = 20;

/** 深度模式：抓取前 N 条 + 单条正文截断长度（控制 token）。 */
const DEEP_FETCH_LIMIT = 3;
const DEEP_CONTENT_LIMIT = 4000;
const SUMMARY_CONTENT_LIMIT = 1200;

/** 深度模式取值。 */
const DEPTH_VALUES = ['off', 'normal', 'deep'];

/** 时效筛选 → 天数（拼进 query 的 after: 语法）。 */
const FRESHNESS_DAYS = { d7: 7, m1: 31, y1: 366 };

/* -------------------------------------------------------------------------- */
/*                                  小工具                                     */
/* -------------------------------------------------------------------------- */

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 把任意输入压成单行文本并夹到指定长度（按 Unicode 码点截断，避免拆坏代理对）。
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function normalizeText(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * 保留换行的截断（用于抓取回来的 Markdown 正文）。
 * @param {*} value
 * @param {number} max
 * @returns {string}
 */
function clip(value, max) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把 secrets.deepseek.baseUrl 归一化成可拼 /tools/* 的 API 前缀。
 * 例：https://api.deepseek.com → https://api.deepseek.com/v1
 *     https://api.deepseek.com/v1 → 原样
 *     https://api.deepseek.com/v1/chat/completions → https://api.deepseek.com/v1
 * @param {string} baseUrl
 * @returns {string}
 */
export function resolveApiBase(baseUrl) {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return 'https://api.deepseek.com/v1';
  base = base.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
  if (!base) return 'https://api.deepseek.com/v1';
  if (/\/v\d+(?:[a-z0-9-]*)$/i.test(base)) return base;
  // 只有 host（或 host + 空路径）时补 /v1；带自定义路径的代理原样使用
  try {
    const url = new URL(base);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path) return `${base}/v1`;
  } catch (err) {
    return `${base}/v1`;
  }
  return base;
}

/**
 * 条数夹取到 1~50，非法值回落默认 20。
 * @param {*} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function normalizeCount(value, fallback = DEFAULT_COUNT) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(MAX_COUNT, Math.max(1, Math.trunc(num)));
}

/**
 * 深度模式规整（off | normal | deep），未知值回落 normal。
 * @param {*} value
 * @returns {'off'|'normal'|'deep'}
 */
export function normalizeDepth(value) {
  const key = String(value || '').trim().toLowerCase();
  return DEPTH_VALUES.indexOf(key) >= 0 ? key : 'normal';
}

/**
 * 时效筛选 → 搜索语法片段 `after:YYYY-MM-DD`（any / 未知值返回空串）。
 * @param {*} freshness
 * @param {Date} [now]
 * @returns {string}
 */
export function buildFreshnessClause(freshness, now = new Date()) {
  const key = String(freshness || '').trim().toLowerCase();
  const days = FRESHNESS_DAYS[key];
  if (!days) return '';
  const date = new Date(now.getTime() - days * 86400000);
  if (Number.isNaN(date.getTime())) return '';
  return `after:${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 把时效片段拼到查询词末尾（长度受 128 字符上限约束，优先保留片段）。
 * @param {string} query
 * @param {*} freshness
 * @returns {string}
 */
export function applyFreshness(query, freshness) {
  const text = normalizeText(query, MAX_QUERY_LEN);
  const clause = buildFreshnessClause(freshness);
  if (!text || !clause) return text;
  if (text.indexOf(clause) >= 0) return text;
  const room = Math.max(1, MAX_QUERY_LEN - clause.length - 1);
  return `${normalizeText(text, room)} ${clause}`;
}

/**
 * 时间归一成 YYYY-MM-DD（文档中是 UTC RFC3339 或 null）。
 * @param {*} value
 * @returns {string} 解析失败返回空串
 */
function normalizeDate(value) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return '';
  const simple = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (simple) return `${simple[1]}-${pad2(simple[2])}-${pad2(simple[3])}`;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 1e8) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }
  }
  return truncate(text, 19);
}

/**
 * 归一化一条 search 结果。
 * @param {object} raw 官方返回的单条 result
 * @returns {object|null} 非法（无 http(s) URL）返回 null
 */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = String(raw.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;

  const domain = hostOf(url);
  const rerank = Number(raw.rerank_score);
  // rerank_score 0~3 → 面板需要的 0~1
  const score = Number.isFinite(rerank) ? Math.min(1, Math.max(0, rerank / 3)) : null;

  const authorityRaw = Number(raw.authority);
  // authority 0~4，-1 表示未知
  const authority = Number.isFinite(authorityRaw) && authorityRaw >= 0 ? authorityRaw : null;

  const snippetText = String(raw.snippet || '').trim();
  const summaryText = String(raw.summary || '').trim();
  const snippet = truncate(snippetText || summaryText, 260);

  const siteName = String(raw.site_name || '').trim();
  const iconRaw = String(raw.site_icon || '').trim();
  const content = typeof raw.content === 'string' ? raw.content : '';

  return {
    title: truncate(String(raw.title || '').trim() || domain || url, 140),
    url,
    snippet,
    domain,
    site: truncate(siteName || domain, 40),
    date: normalizeDate(raw.date),
    score,
    authority,
    icon: /^https?:\/\//i.test(iconRaw) ? iconRaw : '',
    summary: clip(summaryText, 800),
    content,
  };
}

/**
 * 归一化并去重（同 URL 只保留第一条）。
 * @param {Array<object>} list
 * @param {number} limit
 * @returns {Array<object>}
 */
export function normalizeResults(list, limit) {
  const items = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  items.forEach((raw) => {
    const item = normalizeResult(raw);
    if (!item) return;
    const key = item.url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out.slice(0, Math.max(1, Number(limit) || DEFAULT_COUNT));
}

/* -------------------------------------------------------------------------- */
/*                              请求基础设施                                    */
/* -------------------------------------------------------------------------- */

/**
 * 组合「外部 AbortSignal + 内部超时」。
 * @param {AbortSignal|null} signal 外部信号
 * @param {number} timeoutMs 超时毫秒
 * @returns {{signal:AbortSignal, state:{timedOut:boolean}, cleanup:Function}}
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    try {
      controller.abort(new DOMException('请求超时', 'TimeoutError'));
    } catch (err) {
      controller.abort();
    }
  }, timeoutMs);

  const onAbort = () => {
    try {
      controller.abort();
    } catch (err) {
      /* ignore */
    }
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  };

  return { signal: controller.signal, state, cleanup };
}

/**
 * 读取错误响应体（OpenAI 兼容格式：{ error: { message } }），截断到 200 字符。
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  try {
    const text = await response.text();
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    try {
      const json = JSON.parse(trimmed);
      const message =
        (json && json.error && (json.error.message || json.error.msg)) ||
        (json && (json.message || json.msg)) ||
        '';
      if (message) return String(message).slice(0, 200);
    } catch (err) {
      /* 非 JSON，按纯文本截断 */
    }
    return trimmed.slice(0, 200);
  } catch (err) {
    return '';
  }
}

/**
 * HTTP 状态码 → 中文可读原因（区分 search / fetch 两种场景）。
 * @param {number} status
 * @param {'search'|'fetch'} scene
 * @param {string} detail
 * @returns {string}
 */
function mapStatusMessage(status, scene, detail) {
  const tail = detail ? `（${truncate(detail, 120)}）` : '';
  switch (status) {
    case 400:
      return `搜索参数不合法（400）${tail}`;
    case 401:
      return 'API Key 无效（401），请重新填写 DeepSeek API Key';
    case 402:
      return 'DeepSeek 账户余额不足，请先充值';
    case 403:
      return scene === 'fetch' ? '目标网页无法抓取（403）' : `没有访问权限（403）${tail}`;
    case 404:
      return scene === 'fetch'
        ? '目标网页无法抓取（404）'
        : `接口地址不存在（404），请检查 Base URL 是否为 https://api.deepseek.com/v1${tail}`;
    case 408:
      return '读取请求体超时（408），请稍后重试';
    case 413:
      return '请求内容过大（413），请减少检索条数';
    case 429:
      return scene === 'fetch'
        ? '抓取请求过于频繁（429），已跳过本次正文抓取'
        : '触发搜索限速，请稍后重试';
    case 500:
      return `DeepSeek 服务内部错误（500）${tail}`;
    case 504:
      return 'DeepSeek 下游超时（504），请稍后重试';
    default:
      return `DeepSeek 请求失败（HTTP ${status}）${tail}`;
  }
}

/**
 * 统一的 JSON 请求（自动带超时 / 外部取消 / 错误映射）。
 * @param {object} options
 * @param {string} options.apiBase
 * @param {string} options.path
 * @param {string} options.apiKey
 * @param {object} options.body
 * @param {AbortSignal|null} [options.signal]
 * @param {number} [options.timeout]
 * @param {'search'|'fetch'} [options.scene]
 * @returns {Promise<object>} 解析后的 JSON
 */
async function postJson(options) {
  const {
    apiBase,
    path,
    apiKey,
    body,
    signal = null,
    timeout = SEARCH_TIMEOUT,
    scene = 'search',
  } = options;

  if (!apiKey) throw new NeedsConfigError('尚未配置 DeepSeek API Key');

  const guard = withTimeout(signal, timeout);
  try {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: guard.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      // 外部取消：必须原样抛出，交由上层识别为用户主动停止
      if (signal && signal.aborted) throw err;
      if (err && err.name === 'AbortError') throw err;
      if (guard.state.timedOut || (err && err.name === 'TimeoutError')) {
        const label = scene === 'fetch' ? '网页抓取' : '搜索';
        throw new ProviderError(`${label}请求超时（${Math.round(timeout / 1000)} 秒），请稍后重试`);
      }
      throw new ProviderError(`无法连接 DeepSeek 搜索服务：${describeError(err)}`);
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new ProviderError(mapStatusMessage(response.status, scene, detail), response.status, detail);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ProviderError('DeepSeek 返回内容不是合法 JSON');
    }
    if (payload && payload.error) {
      const message = String((payload.error && payload.error.message) || 'DeepSeek 返回错误');
      throw new ProviderError(message.slice(0, 300));
    }
    return payload && typeof payload === 'object' ? payload : {};
  } finally {
    guard.cleanup();
  }
}

/* -------------------------------------------------------------------------- */
/*                                  配置                                        */
/* -------------------------------------------------------------------------- */

/**
 * 规整 secrets.deepseek（与 deepseek.js 同源，不额外保存密钥）。
 * @param {object} cfg secrets.deepseek
 * @returns {{apiKey:string, apiBase:string, chatBaseUrl:string, model:string, webSearch:boolean, depth:'off'|'normal'|'deep'}}
 */
export function resolveConfig(cfg) {
  const source = cfg || {};
  const rawBase = String(source.baseUrl || '').trim().replace(/\/+$/, '');
  const chatBaseUrl = rawBase || DEFAULT_CHAT_BASE;
  return {
    apiKey: String(source.apiKey || '').trim(),
    apiBase: resolveApiBase(rawBase),
    chatBaseUrl,
    model: String(source.model || '').trim() || 'deepseek-chat',
    // 老数据没有该字段时视为开启，保持向后兼容
    webSearch: source.webSearch !== false,
    depth: normalizeDepth(source.searchDepth),
  };
}

/* -------------------------------------------------------------------------- */
/*                              检索 / 抓取                                     */
/* -------------------------------------------------------------------------- */

/**
 * 调用 /v1/tools/search。
 * @param {object} cfg secrets.deepseek
 * @param {object} [options]
 * @param {string} options.query 已拼好语法的检索词（1~128 字符）
 * @param {string} [options.oriQuestion] 用户原始问题（帮助理解意图）
 * @param {number} [options.count] 1~50
 * @param {boolean} [options.needContent] 是否需要官方正文（默认 false）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{sources:Array<object>, elapsedMs:number, requested:number}>}
 */
export async function searchWeb(cfg, options = {}) {
  const config = resolveConfig(cfg);
  const query = normalizeText(options.query, MAX_QUERY_LEN);
  if (!query) throw new ProviderError('搜索关键词不能为空');
  const count = normalizeCount(options.count);
  const oriQuestion = normalizeText(options.oriQuestion, MAX_ORI_LEN);

  const body = { query, count };
  if (oriQuestion) body.ori_question = oriQuestion;
  if (options.needContent === true) body.need_content = true;

  const started = performance.now();
  const payload = await postJson({
    apiBase: config.apiBase,
    path: SEARCH_PATH,
    apiKey: config.apiKey,
    body,
    signal: options.signal || null,
    timeout: SEARCH_TIMEOUT,
    scene: 'search',
  });

  const sources = normalizeResults(payload.results, count);
  return {
    sources,
    elapsedMs: Math.round(performance.now() - started),
    requested: count,
  };
}

/**
 * 调用 /v1/tools/fetch 抓取单页正文（Markdown）。
 * @param {object} cfg secrets.deepseek
 * @param {string} url 含 host 的 http/https 地址
 * @param {AbortSignal} [signal]
 * @returns {Promise<{title:string, content:string}>}
 */
export async function fetchPage(cfg, url, signal = null) {
  const config = resolveConfig(cfg);
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target) || target.length > 8192) {
    throw new ProviderError('目标网页地址不合法');
  }
  const payload = await postJson({
    apiBase: config.apiBase,
    path: FETCH_PATH,
    apiKey: config.apiKey,
    body: { url: target },
    signal,
    timeout: FETCH_TIMEOUT,
    scene: 'fetch',
  });
  return {
    title: truncate(payload.title, 140),
    content: typeof payload.content === 'string' ? payload.content : '',
  };
}

/**
 * 深度模式：给前 N 条结果补正文（并发度 ≤ N，单条失败静默降级）。
 * @param {object} cfg secrets.deepseek
 * @param {Array<object>} sources 会被就地写入 content 字段
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.limit]
 * @param {number} [options.maxChars]
 * @returns {Promise<number>} 成功补到正文的条数
 */
export async function attachContents(cfg, sources, options = {}) {
  const list = Array.isArray(sources) ? sources : [];
  const limit = Math.max(0, Math.min(list.length, Number(options.limit) || DEEP_FETCH_LIMIT));
  const maxChars = Number(options.maxChars) || DEEP_CONTENT_LIMIT;
  const signal = options.signal || null;
  const targets = list.slice(0, limit);
  if (!targets.length) return 0;

  let filled = 0;
  await Promise.all(
    targets.map(async (source) => {
      try {
        const page = await fetchPage(cfg, source.url, signal);
        const content = clip(page.content, maxChars);
        if (content) {
          source.content = content;
          if (!source.title && page.title) source.title = page.title;
          filled += 1;
        }
      } catch (err) {
        // 用户取消要向上传递，其余（超时 / 403 / 404 / 网络）一律静默降级
        if (err && err.name === 'AbortError') throw err;
      }
    }),
  );
  return filled;
}

/* -------------------------------------------------------------------------- */
/*                              总结 / 概述                                     */
/* -------------------------------------------------------------------------- */

/**
 * 无可用总结模型 / 无检索结果时的一句概述（不跨文件复用 yuanbao 的实现）。
 * @param {Array<object>} sources
 * @param {{elapsedMs?:number}} meta
 * @returns {string}
 */
function buildOverview(sources, meta) {
  const count = Array.isArray(sources) ? sources.length : 0;
  const elapsed = meta && Number.isFinite(meta.elapsedMs) ? meta.elapsedMs : 0;
  if (!count) {
    return [
      '这次没有检索到可用结果。',
      '',
      '> 可以换个说法、放宽时效范围（或去掉 `site:` 之类的限定语法），或换一个搜索源再试。',
    ].join('\n');
  }
  return [
    `已通过 **DeepSeek 联网搜索** 检索到 **${count} 条**结果${
      elapsed ? `（用时 ${elapsed} ms）` : ''
    }，已按相关度排在下方。`,
    '',
    '> 当前没有可用的总结模型，仅展示检索结果列表。',
  ].join('\n');
}

/**
 * 把一段文本按小块推给面板，保持流式观感。
 * @param {string} text
 * @param {(delta:string)=>void} onDelta
 * @param {AbortSignal|null} signal
 */
async function emitInChunks(text, onDelta, signal) {
  const content = String(text || '');
  const size = 6;
  for (let i = 0; i < content.length; i += size) {
    if (signal && signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (typeof onDelta === 'function') onDelta(content.slice(i, i + size));
    await sleep(18);
  }
}

/**
 * 拼给模型的资料段落：编号与结果列表一一对应，深度模式下附带正文节选。
 * @param {Array<object>} sources
 * @returns {string}
 */
function buildContext(sources) {
  return sources
    .map((source, index) => {
      const lines = [`[${index + 1}] ${source.title}`, source.url];
      const siteInfo = [source.site || source.domain, source.date].filter(Boolean).join(' · ');
      if (siteInfo) lines.push(siteInfo);
      if (source.snippet) lines.push(source.snippet);
      if (source.content) lines.push(`正文节选：${clip(source.content, SUMMARY_CONTENT_LIMIT)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*                                 主流程                                       */
/* -------------------------------------------------------------------------- */

/**
 * 统一 provider 接口：run(context) => Promise<{text, sources, model, meta}>
 * @param {object} context
 * @param {string} context.query
 * @param {object} context.settings
 * @param {object} context.secrets
 * @param {AbortSignal} [context.signal]
 * @param {(delta:string)=>void} [context.onDelta]
 * @param {(sources:Array<object>, meta:object)=>void} [context.onSources]
 * @param {(status:object)=>void} [context.onStatus]
 */
export async function run(context) {
  const { query, settings, secrets, signal, onDelta, onSources, onStatus } = context;
  const aiSettings = (settings && settings.ai) || {};
  // 原始配置（含 baseUrl）交给底层请求函数，它们会各自再归一化一次
  const rawCfg = (secrets && secrets.deepseek) || {};
  const config = resolveConfig(rawCfg);

  if (!config.apiKey) throw new NeedsConfigError('尚未配置 DeepSeek API Key');
  if (!config.webSearch) {
    throw new ProviderError('DeepSeek 联网搜索已在设置中关闭，请打开「联网搜索」开关后再试');
  }

  const notify = (payload) => {
    if (typeof onStatus === 'function') onStatus(payload);
  };

  const count = normalizeCount(aiSettings.maxSources);
  const question = normalizeText(query, MAX_ORI_LEN);
  const searchQuery = applyFreshness(question, aiSettings.searchFreshness);
  const cacheKey = buildCacheKey(PROVIDER_ID, searchQuery, count);

  notify({ demo: false, phase: 'searching', providerName: 'DeepSeek 联网', model: 'tools/search' });

  let sources = [];
  let meta = {
    resultCount: 0,
    elapsedMs: 0,
    tool: 'tools/search',
    transport: 'HTTPS',
    requested: count,
  };

  const cached = getCached(cacheKey);
  if (cached && Array.isArray(cached.sources)) {
    // 命中缓存：不再扣费，但总结仍然重新生成
    sources = cached.sources.map((item) => ({ ...item }));
    meta = { ...(cached.meta || {}), requested: count, cached: true };
    notify({
      demo: false,
      phase: 'searching',
      cached: true,
      providerName: 'DeepSeek 联网',
      model: 'tools/search · 缓存',
    });
  } else {
    const outcome = await searchWeb(rawCfg, {
      query: searchQuery,
      oriQuestion: question,
      count,
      signal,
    });
    sources = outcome.sources;
    meta = {
      resultCount: sources.length,
      elapsedMs: outcome.elapsedMs,
      tool: 'tools/search',
      transport: 'HTTPS',
      requested: outcome.requested,
    };
  }

  // 先把结果列表交给面板（用户尽快看到内容），再决定要不要抓正文
  if (typeof onSources === 'function') onSources(sources, meta);

  // 深度模式：只给「还没有正文」的前几条补抓，命中缓存时不会再重复抓取
  const needFetch = sources.filter((item) => !item.content);
  if (config.depth === 'deep' && needFetch.length) {
    notify({ phase: 'reading', providerName: 'DeepSeek 联网', model: 'tools/fetch' });
    try {
      const filled = await attachContents(rawCfg, needFetch, { signal });
      if (filled) meta = { ...meta, fetched: filled };
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      // 抓取阶段整体失败：静默降级，不影响检索结果与总结
    }
  }

  // 深度模式下正文也一起进缓存，避免重复抓取
  if (!cached) setCached(cacheKey, { sources, meta });

  const canSummarize = Boolean(config.apiKey && config.chatBaseUrl && config.model);
  if (!sources.length || !canSummarize) {
    const text = buildOverview(sources, meta);
    notify({ phase: 'answering', providerName: 'DeepSeek 联网', model: 'tools/search · 仅检索' });
    await emitInChunks(text, onDelta, signal);
    return { text, sources, model: 'tools/search · 仅检索', meta };
  }

  notify({ phase: 'answering', providerName: 'DeepSeek 联网', model: config.model });

  const customPrompt = String(aiSettings.systemPrompt || '').trim();
  const basePrompt = customPrompt || DEFAULT_AI_PROMPT;
  const grounding = [
    '以下是通过 DeepSeek 联网搜索检索到的资料，请基于资料回答用户问题。',
    '在引用处使用 [1][2] 这样的编号标注来源；资料不足或互相矛盾时请明确说明，不要编造。',
    `本次共检索到 ${sources.length} 条资料，编号与结果列表一一对应。`,
    '',
    buildContext(sources),
  ].join('\n');

  // 统计是否已经向面板推过正文：推过之后就不适合再降级成概述（内容会串）
  let streamedAny = false;
  const handleDelta = (delta) => {
    if (!delta) return;
    streamedAny = true;
    if (typeof onDelta === 'function') onDelta(delta);
  };

  let text;
  try {
    text = await streamChat({
      baseUrl: config.chatBaseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        { role: 'system', content: `${basePrompt}\n\n${grounding}` },
        { role: 'user', content: String(query || '') },
      ],
      temperature: aiSettings.temperature === undefined ? 0.6 : aiSettings.temperature,
      stream: aiSettings.stream !== false,
      signal,
      onDelta: handleDelta,
    });
  } catch (err) {
    // 用户取消：原样抛出
    if (err && err.name === 'AbortError') throw err;
    // 已推过部分正文：交给面板展示错误，避免拼接出混乱内容
    if (streamedAny) throw err;
    // 还没开始输出：降级成「结果列表 + 一句概述」，不让用户丢掉已检索到的结果
    const fallback = buildOverview(sources, meta);
    notify({ phase: 'answering', providerName: 'DeepSeek 联网', model: 'tools/search · 仅检索' });
    await emitInChunks(fallback, onDelta, signal);
    return { text: fallback, sources, model: 'tools/search · 仅检索', meta };
  }

  return { text, sources, model: config.model, meta };
}

/**
 * 设置页「测试连接」：真实跑一次 search（count=3），验证 Key 与接口可用。
 * @param {object} cfg secrets.deepseek
 * @returns {Promise<{latency:number, results:number}>}
 */
export async function testConnection(cfg) {
  const config = resolveConfig(cfg);
  if (!config.apiKey) throw new NeedsConfigError('请先填写 DeepSeek API Key');
  const started = performance.now();
  const outcome = await searchWeb(cfg, { query: '腾讯云 云开发', count: 3, signal: null });
  return {
    latency: Math.round(performance.now() - started),
    results: outcome.sources.length,
  };
}

/** 供设置页展示的接口地址（避免各处重复拼路径）。 */
export const ENDPOINTS = {
  search: SEARCH_PATH,
  fetch: FETCH_PATH,
};
