/**
 * providers/yuanbao-mcp.js — 腾讯云元宝搜索 MCP 客户端
 * 协议：JSON-RPC 2.0 over MCP Streamable HTTP
 *   1) initialize（读取 mcp-session-id）
 *   2) notifications/initialized
 *   3) tools/call
 *   4) 解析 result.content → sources
 *   5) 若配置了 LLM 密钥，把资料交给模型流式总结；否则直接渲染结果列表
 */

import { DEFAULT_AI_PROMPT } from '../defaults.js';
import {
  NeedsConfigError,
  ProviderError,
  describeError,
  hostOf,
  mapHttpStatus,
  sleep,
  truncate,
} from '../utils.js';
import { streamChat } from './deepseek.js';
import { signTc3 } from './tc3.js';
import { buildCacheKey, getCached, setCached } from './cache.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'aurora-newtab', version: '0.1.0' };
const RPC_TIMEOUT = 30000;

/** 构造 MCP 请求头。 */
function buildHeaders(cfg, extra = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
  const name = String(cfg.authHeader || 'Authorization').trim();
  const prefix = cfg.authPrefix === undefined || cfg.authPrefix === null ? 'Bearer ' : String(cfg.authPrefix);
  if (name && cfg.apiKey) {
    headers[name] = `${prefix}${cfg.apiKey}`;
  }
  return headers;
}

/** 安全读取响应文本（截断）。 */
async function safeReadText(response) {
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
      if (message) return String(message).slice(0, 300);
    } catch (err) {
      /* 非 JSON */
    }
    return trimmed.slice(0, 300);
  } catch (err) {
    return '';
  }
}

/**
 * 发送一条 JSON-RPC 消息（带 30s 超时）。
 * @returns {Promise<Response>}
 */
async function postRpc(endpoint, cfg, payload, options = {}) {
  const { sessionId = '', signal = null, timeout = RPC_TIMEOUT } = options;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort(new DOMException('MCP 请求超时', 'TimeoutError'));
    } catch (err) {
      controller.abort();
    }
  }, timeout);

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

  try {
    const extraHeaders = {};
    if (sessionId) {
      extraHeaders['mcp-session-id'] = sessionId;
      extraHeaders['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(cfg, extraHeaders),
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (timedOut || (err && err.name === 'TimeoutError')) {
        throw new ProviderError('MCP 请求超时（30 秒），请检查服务地址与网络');
      }
      if (err && err.name === 'AbortError') throw err;
      throw new ProviderError(`无法连接 MCP 服务：${describeError(err)}`);
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      const message = detail
        ? `${mapHttpStatus(response.status)} · ${detail}`
        : mapHttpStatus(response.status);
      throw new ProviderError(message, response.status, detail);
    }
    return response;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 解析单个 SSE 事件块为 JSON。 */
function parseSseEvent(chunk) {
  const lines = String(chunk || '').split('\n');
  const dataLines = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join('\n');
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}

/**
 * 解析 JSON-RPC 响应（同时兼容 application/json 与 text/event-stream）。
 * @param {Response} response
 * @param {number} expectedId
 */
async function parseRpc(response, expectedId) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('text/event-stream')) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const raw = await response.text();
      const messages = String(raw)
        .split(/\n\n/)
        .map((chunk) => parseSseEvent(chunk))
        .filter(Boolean);
      return messages.find((item) => item.id === expectedId) || messages[messages.length - 1] || null;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const collected = [];
    let finished = false;

    try {
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const message = parseSseEvent(chunk);
          if (message) {
            collected.push(message);
            if (message.id === expectedId) {
              finished = true;
              break;
            }
          }
          index = buffer.indexOf('\n\n');
        }
      }
    } finally {
      if (finished && reader.cancel) {
        try {
          await reader.cancel();
        } catch (err) {
          /* ignore */
        }
      }
    }

    // 服务端最后一个事件可能没有以空行结尾，流结束后把残留 buffer 再解析一次
    try {
      buffer += decoder.decode();
    } catch (err) {
      /* ignore */
    }
    if (buffer.trim()) {
      const tail = parseSseEvent(buffer);
      if (tail) collected.push(tail);
    }

    return collected.find((item) => item.id === expectedId) || collected[collected.length - 1] || null;
  }

  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProviderError('MCP 返回内容不是合法 JSON，请确认端点指向 MCP 服务');
  }
}

/** 1) initialize 握手。 */
async function initialize(endpoint, cfg, signal) {
  const response = await postRpc(
    endpoint,
    cfg,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
    { signal },
  );

  const sessionId =
    response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || '';
  const payload = await parseRpc(response, 1);

  if (payload && payload.error) {
    const message = payload.error.message || payload.error.code || '未知错误';
    throw new ProviderError(`MCP 初始化失败：${message}`);
  }
  return { sessionId, payload };
}

/** 2) 发送 initialized 通知（无 id）。 */
async function notifyInitialized(endpoint, cfg, sessionId, signal) {
  const response = await postRpc(
    endpoint,
    cfg,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { sessionId, signal },
  );
  try {
    // 消费响应体，避免连接悬挂
    await response.text();
  } catch (err) {
    /* ignore */
  }
}

/** 3) 调用工具。 */
async function callTool(endpoint, cfg, sessionId, toolName, args, signal) {
  const response = await postRpc(
    endpoint,
    cfg,
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    },
    { sessionId, signal },
  );

  const payload = await parseRpc(response, 2);
  if (!payload) throw new ProviderError('MCP 服务没有返回有效结果');
  if (payload.error) {
    const message = payload.error.message || payload.error.code || '未知错误';
    throw new ProviderError(`MCP 工具调用失败：${message}`);
  }
  return payload.result || {};
}

/* -------------------------------------------------------------------------- */
/*                              结果 → 来源列表                                 */
/* -------------------------------------------------------------------------- */

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function pickString(node, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const value = node[keys[i]];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** 把各种时间格式统一成 YYYY-MM-DD（解析失败原样返回，最多 19 字符）。 */
function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const simple = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (simple) {
    const month = String(simple[2]).padStart(2, '0');
    const day = String(simple[3]).padStart(2, '0');
    return `${simple[1]}-${month}-${day}`;
  }
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric > 0) {
    // 10 位时间戳按秒处理
    const ms = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : 0;
    if (ms) {
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
          date.getDate(),
        ).padStart(2, '0')}`;
      }
    }
  }
  return truncate(text, 19);
}

/** 统一规整一条搜索结果（兼容元宝 Pages 与通用 MCP 搜索工具的字段）。 */
function normalizePage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const url = pickString(raw, ['url', 'link', 'href', 'httpUrl', 'source_url', 'sourceUrl', 'target_url']);
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const title = pickString(raw, ['title', 'name', 'headline', 'site_name', 'siteName']);
  const snippet = pickString(raw, [
    'passage',
    'snippet',
    'summary',
    'description',
    'abstract',
    'content',
    'text',
  ]);
  const site = pickString(raw, ['site', 'siteName', 'source', 'publisher', 'show_source']);
  const date = pickString(raw, ['date', 'publish_time', 'publishTime', 'pubDate', 'published_date', 'time']);

  // 元宝标准版会返回腾讯自家图标 CDN（cdn-yb.icon.qq.com），比第三方 favicon 服务稳定得多
  const icon = pickString(raw, ['favicon', 'icon', 'site_icon', 'siteIcon', 'favicon_url']);
  // content 为“动态摘要”，比 passage 长，留给总结链路使用
  const content = pickString(raw, ['content', 'dynamic_passage', 'dynamicPassage']);
  const pics = Array.isArray(raw.pics) ? raw.pics.length : 0;

  const rawScore = Number(raw.score !== undefined ? raw.score : raw.relevance);
  const score = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(1, rawScore > 1 ? rawScore / 100 : rawScore))
    : null;
  const authorityRaw = Number(raw.authority_level !== undefined ? raw.authority_level : raw.authorityLevel);

  return {
    title: truncate(title || hostOf(url), 140),
    url,
    snippet: truncate(snippet, 260),
    domain: hostOf(url),
    site: truncate(site || hostOf(url), 40),
    date: normalizeDate(date),
    score,
    authority: Number.isFinite(authorityRaw) ? authorityRaw : null,
    icon,
    content: truncate(content, 1200),
    pics,
  };
}

/**
 * 从元宝搜索响应中取出 Pages。
 * 官方返回形态：{ Response: { Pages: ["{\"title\":...}", ...] } }（Pages 是 JSON 字符串数组）
 * 同时兼容 Pages 为对象数组、以及多包一层 Result/Data 的情况。
 * @returns {Array<object>}
 */
export function pagesFromPayload(payload) {
  let node = payload;
  if (typeof node === 'string') node = tryParseJson(node);
  if (!node || typeof node !== 'object') return [];

  const wrappers = [node, node.Response, node.response, node.result, node.result?.Response, node.data];
  for (let i = 0; i < wrappers.length; i += 1) {
    const wrapper = wrappers[i];
    if (!wrapper || typeof wrapper !== 'object') continue;
    const pages =
      wrapper.Pages || wrapper.pages || wrapper.Results || wrapper.results || wrapper.Docs || wrapper.docs;
    if (!pages) continue;
    const list = typeof pages === 'string' ? tryParseJson(pages) : pages;
    if (!Array.isArray(list)) continue;
    return list.map((item) => (typeof item === 'string' ? tryParseJson(item) : item)).filter(Boolean);
  }
  return [];
}

/** 递归从任意结构中挑选带 url 的节点。 */
function collectFromNode(node, out, depth) {
  if (!node || depth > 6 || out.length >= 60) return;

  if (typeof node === 'string') {
    const text = node.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      const parsed = tryParseJson(text);
      if (parsed) collectFromNode(parsed, out, depth + 1);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item) => collectFromNode(item, out, depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const page = normalizePage(node);
  if (page) {
    out.push(page);
    return;
  }

  Object.keys(node).forEach((key) => collectFromNode(node[key], out, depth + 1));
}

/** 从纯文本里提取 URL。 */
function collectUrlsFromText(text, out) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>"'）)\]]+/g);
  if (!matches) return;
  matches.slice(0, 20).forEach((url) => {
    const clean = url.replace(/[.,;，。；]+$/, '');
    out.push({ title: hostOf(clean), url: clean, snippet: '', domain: hostOf(clean), site: hostOf(clean), date: '', score: null });
  });
}

/**
 * 从 tools/call 结果中提取结果列表。
 * 优先按元宝 SearchPro 的 Pages 解析，再退回通用递归 / 文本 URL 提取。
 * @param {object} result JSON-RPC result 或 HTTP 响应体
 * @param {number} max 最多条数
 * @returns {Array<{title:string,url:string,snippet:string,domain:string,site:string,date:string,score:number|null}>}
 */
export function extractSources(result, max) {
  const limit = Math.max(1, Number(max) || 20);
  const contents = result && Array.isArray(result.content) ? result.content : [];
  const texts = [];
  contents.forEach((item) => {
    if (item && item.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  });
  if (result && result.structuredContent) texts.push(JSON.stringify(result.structuredContent));
  if (!texts.length && typeof result === 'string') texts.push(result);
  if (!texts.length && result && typeof result === 'object') texts.push(JSON.stringify(result));

  const found = [];
  texts.forEach((text) => {
    const parsed = tryParseJson(text);
    if (parsed) {
      // 1) 元宝 SearchPro：Response.Pages
      pagesFromPayload(parsed).forEach((page) => {
        const item = normalizePage(page);
        if (item) found.push(item);
      });
      // 2) 通用结构
      collectFromNode(parsed, found, 0);
    }
    if (!found.length) collectUrlsFromText(text, found);
  });

  // 去重：同一 URL 保留第一条（Pages 解析结果在先，字段更完整）
  const seen = new Set();
  const list = [];
  found.forEach((item) => {
    if (!item || !item.url || seen.has(item.url)) return;
    seen.add(item.url);
    list.push(item);
  });
  return list.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*                              搜索参数与直连                                  */
/* -------------------------------------------------------------------------- */

/** 元宝 Cnt 只接受 10/20/30/40/50，取最接近的一档。 */
export function normalizeCnt(value) {
  const allowed = [10, 20, 30, 40, 50];
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return allowed.reduce((best, item) => (Math.abs(item - n) < Math.abs(best - n) ? item : best), 20);
}

/**
 * 构造搜索工具入参。
 * SearchPro 使用 PascalCase（Query/Mode/Cnt），其余 MCP 搜索工具使用 query。
 */
export function buildSearchArgs({ toolName, query, cfg, cnt }) {
  const text = String(query || '');
  const isSearchPro = /^search.?pro$/i.test(String(toolName || '').trim());
  const args = isSearchPro ? { Query: text, Mode: Number(cfg.mode) || 0, Cnt: cnt } : { query: text };

  if (isSearchPro) {
    if (cfg.freshness) args.Freshness = String(cfg.freshness).trim();
    if (cfg.industry) args.Industry = String(cfg.industry).trim();
  }

  const extraRaw = typeof cfg.extraArgs === 'string' ? cfg.extraArgs.trim() : '';
  if (extraRaw) {
    const extra = tryParseJson(extraRaw);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new ProviderError('「额外参数 JSON」格式不正确，请填写形如 {"top_k": 5} 的对象');
    }
    Object.assign(args, extra);
  }
  if (isSearchPro) args.Query = text;
  else args.query = text;
  return args;
}

/* -------------------------------------------------------------------------- */
/*                        腾讯云云 API 3.0（TC3 签名）                          */
/* -------------------------------------------------------------------------- */

/** 云 API 直连常量。 */
export const TC_DEFAULTS = {
  host: 'wsa.tencentcloudapi.com',
  endpoint: 'https://wsa.tencentcloudapi.com/',
  service: 'wsa',
  action: 'SearchPro',
  version: '2025-05-08',
};

/** 云 API 业务错误码 → 可读中文（比原始 Message 更能指导操作）。 */
const TC_ERROR_HINTS = {
  ResourceNotFound: '该账号尚未开通元宝搜索服务，请先到腾讯云控制台开通',
  ResourceUnavailable: '元宝搜索服务当前不可用，请检查套餐状态或稍后重试',
  UnauthorizedOperation: '当前账号无权调用元宝搜索，请检查密钥权限',
  RequestLimitExceeded: '请求频率超出限制，请稍后重试',
  InvalidParameter: '请求参数不合法',
  InvalidParameterValue: '请求参数取值不合法',
  InternalError: '元宝搜索内部错误，请稍后重试',
  AuthFailure: '密钥签名校验失败，请检查 SecretId / SecretKey',
  AuthFailure_SignatureExpire: '签名已过期，请检查本机时间是否准确',
  AuthFailure_SecretIdNotFound: 'SecretId 不存在，请检查密钥是否被删除',
};

/**
 * 是否使用腾讯云 TC3 签名。
 * 显式配置优先；未配置时按“填了 SecretId + SecretKey 就走签名”自动判定，
 * 这样老用户仅填 API Key 的 Bearer 配置不会被打断。
 * @param {object} cfg secrets.yuanbao
 */
export function useTc3(cfg) {
  const mode = String((cfg && cfg.authMode) || '').toLowerCase();
  if (mode === 'bearer') return false;
  if (mode === 'tc3') return true;
  return Boolean(cfg && cfg.secretId && cfg.secretKey);
}

/** 解析实际请求地址（云 API 默认根路径）。 */
function resolveEndpoint(cfg) {
  const raw = String((cfg && cfg.endpoint) || '').trim();
  return raw || TC_DEFAULTS.endpoint;
}

/** 云 API 业务错误 → ProviderError（带中文指引）。 */
function tcError(payload) {
  const error = payload && payload.Response && payload.Response.Error;
  if (!error) return null;
  const code = String(error.Code || '');
  const hint = TC_ERROR_HINTS[code] || TC_ERROR_HINTS[code.split('.')[0]];
  const message = hint
    ? `${hint}${error.Message ? `（${error.Message}）` : ''}`
    : error.Message || code || '未知错误';
  return new ProviderError(`元宝搜索失败：${message}`, 0, code);
}

/** HTTP 直连 SearchPro（支持腾讯云 TC3 签名 / Bearer API Key 两种鉴权）。 */
async function callSearchHttp(cfg, args, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort(new DOMException('请求超时', 'TimeoutError'));
    } catch (err) {
      controller.abort();
    }
  }, RPC_TIMEOUT);

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

  const tc3 = useTc3(cfg);
  const endpoint = resolveEndpoint(cfg);

  try {
    let response;
    // 先构造请求头与请求体：TC3 签名必须基于“实际发送的请求体原文”，两者不能各算一次
    let headers;
    let body;
    try {
      if (tc3) {
        if (!cfg.secretId || !cfg.secretKey) {
          throw new NeedsConfigError('TC3 签名需要 SecretId 与 SecretKey');
        }
        // 云 API 3.0：Action / Version 走请求头，请求体只放业务参数
        body = JSON.stringify(args);
        const signed = await signTc3({
          secretId: String(cfg.secretId).trim(),
          secretKey: String(cfg.secretKey).trim(),
          host: hostOf(endpoint) || TC_DEFAULTS.host,
          service: String(cfg.service || TC_DEFAULTS.service),
          action: String(cfg.action || TC_DEFAULTS.action),
          version: String(cfg.version || TC_DEFAULTS.version),
          body,
        });
        headers = signed.headers;
      } else {
        body = JSON.stringify({
          Action: String(cfg.action || TC_DEFAULTS.action),
          Version: String(cfg.version || TC_DEFAULTS.version),
          ...args,
        });
        headers = buildHeaders(cfg);
      }
    } catch (err) {
      if (err instanceof NeedsConfigError || err instanceof ProviderError) throw err;
      throw new ProviderError(`生成请求签名失败：${describeError(err)}`);
    }

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (timedOut || (err && err.name === 'TimeoutError')) {
        throw new ProviderError('元宝搜索请求超时（30 秒），请检查网络或服务地址');
      }
      if (err && err.name === 'AbortError') throw err;
      throw new ProviderError(`无法连接元宝搜索：${describeError(err)}`);
    }

    if (!response.ok) {
      const detail = await safeReadText(response);
      throw new ProviderError(
        detail ? `${mapHttpStatus(response.status)} · ${detail}` : mapHttpStatus(response.status),
        response.status,
        detail,
      );
    }

    const raw = await response.text();
    const payload = tryParseJson(raw);
    if (!payload) throw new ProviderError('元宝搜索返回内容不是合法 JSON');
    const businessError = tcError(payload);
    if (businessError) throw businessError;
    return payload;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/* -------------------------------------------------------------------------- */
/*                                   主流程                                    */
/* -------------------------------------------------------------------------- */

/** 解析用于总结的 LLM 配置；未配置返回 null。 */
function resolveSummaryLlm(settings, secrets, cfg) {
  const target = String((cfg && cfg.llm) || 'deepseek').toLowerCase();
  if (target === 'custom') {
    const custom = (secrets && secrets.custom) || {};
    if (custom.apiKey && custom.baseUrl && custom.model) {
      return {
        kind: 'custom',
        baseUrl: custom.baseUrl,
        apiKey: custom.apiKey,
        model: custom.model,
        authHeader: custom.authHeader || 'Authorization',
        authPrefix: custom.authPrefix === undefined ? 'Bearer ' : custom.authPrefix,
      };
    }
    // 自定义未配置齐全时，若 DeepSeek 有密钥则回退
  }
  const deepseek = (secrets && secrets.deepseek) || {};
  if (deepseek.apiKey) {
    return {
      kind: 'deepseek',
      baseUrl: deepseek.baseUrl || 'https://api.deepseek.com/v1',
      apiKey: deepseek.apiKey,
      model: deepseek.model || 'deepseek-chat',
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
    };
  }
  return null;
}

/**
 * 无 LLM 密钥时的引导文案。
 * 检索结果本体交给面板的列表渲染，这里只给一句概括，避免把 20 条链接塞进 Markdown。
 */
function buildSearchOverview(sources, toolName, elapsedMs) {
  if (!sources.length) {
    return '这次没有检索到可用结果。可以换个说法、放宽时效范围，或检查服务端返回格式。';
  }
  return [
    `已通过 **${toolName}** 检索到 **${sources.length} 条**结果，已按相关度排在下方。`,
    '',
    '> 配置 DeepSeek 或自定义模型密钥后，这里会生成一段带 `[1][2]` 引用的 AI 总结；当前仅展示检索结果。',
  ].join('\n');
}

/** 分段推送文本，保持前端流式体验。 */
async function emitInChunks(text, onDelta, signal) {
  const content = String(text || '');
  const size = 6;
  for (let i = 0; i < content.length; i += size) {
    if (signal && signal.aborted) {
      throw new DOMException('已取消', 'AbortError');
    }
    if (typeof onDelta === 'function') onDelta(content.slice(i, i + size));
    await sleep(18);
  }
}

/**
 * 统一 provider 接口。
 */
export async function run(context) {
  const { query, settings, secrets, signal, onDelta, onSources, onStatus } = context;
  const cfg = (secrets && secrets.yuanbao) || {};
  // 先看通道：显式选 MCP 就尊重 MCP（MCP 网关只支持 Bearer，不受 authMode 影响）；
  // 只有走 HTTP 直连时，TC3 签名才有意义。
  const transport = String(cfg.transport || 'http').toLowerCase() === 'mcp' ? 'mcp' : 'http';
  const tc3 = transport === 'http' && useTc3(cfg);
  const toolName = String(cfg.tool || 'SearchPro').trim() || 'SearchPro';
  const limit = settings.ai && settings.ai.maxSources ? settings.ai.maxSources : 20;
  const cnt = normalizeCnt(limit);

  // 凭证校验按鉴权方式分流：TC3 只需密钥对，Bearer 才需要 API Key
  if (transport === 'http' && tc3) {
    if (!String(cfg.secretId || '').trim()) {
      throw new NeedsConfigError('尚未配置腾讯云 SecretId（云 API 密钥，形如 AKID...）');
    }
    if (!String(cfg.secretKey || '').trim()) {
      throw new NeedsConfigError('尚未配置腾讯云 SecretKey');
    }
  } else {
    if (!cfg.endpoint) {
      throw new NeedsConfigError(
        transport === 'http'
          ? '尚未配置元宝搜索服务地址（SearchPro 端点，如 https://api.wsa.cloud.tencent.com/SearchPro）'
          : '尚未配置元宝 MCP 服务地址（如 https://api.wsa.cloud.tencent.com/Mcp）',
      );
    }
    if (!cfg.apiKey) throw new NeedsConfigError('尚未配置元宝搜索的 API Key');
  }

  const notify = (payload) => {
    if (typeof onStatus === 'function') onStatus(payload);
  };

  const args = buildSearchArgs({ toolName, query, cfg, cnt });
  const cacheKey = buildCacheKey(`yuanbao-${transport}-${toolName}`, query, cnt);
  const started = performance.now();

  // 命中缓存时直接复用结果（避免调试期重复扣费），但总结仍然重新生成
  const cachedEntry = getCached(cacheKey);
  let sources;
  let meta;

  if (cachedEntry && Array.isArray(cachedEntry.sources)) {
    sources = cachedEntry.sources.map((item) => ({ ...item }));
    meta = { ...(cachedEntry.meta || {}), requested: cnt, cached: true };
    notify({
      demo: false,
      phase: 'searching',
      cached: true,
      providerName: '元宝 AI 搜索',
      model: `${toolName} · 缓存`,
    });
  } else {
    let payload;
    if (transport === 'http') {
      notify({
        demo: false,
        phase: 'searching',
        providerName: '元宝 AI 搜索',
        model: tc3 ? 'SearchPro · TC3' : 'SearchPro · HTTP',
      });
      payload = await callSearchHttp(cfg, args, signal);
    } else {
      notify({ demo: false, phase: 'connecting', providerName: '元宝 AI 搜索', model: 'MCP' });
      const handshake = await initialize(cfg.endpoint, cfg, signal);
      await notifyInitialized(cfg.endpoint, cfg, handshake.sessionId, signal);
      notify({ phase: 'searching', model: toolName });
      payload = await callTool(cfg.endpoint, cfg, handshake.sessionId, toolName, args, signal);
    }

    const elapsedMs = Math.round(performance.now() - started);
    sources = extractSources(payload, limit);
    meta = {
      resultCount: sources.length,
      elapsedMs,
      tool: toolName,
      transport: transport === 'http' ? (tc3 ? 'TC3' : 'HTTP') : 'MCP',
      requested: cnt,
    };
    setCached(cacheKey, { sources, meta });
  }

  if (typeof onSources === 'function') onSources(sources, meta);

  const llm = resolveSummaryLlm(settings, secrets, cfg);

  if (!llm) {
    const text = buildSearchOverview(sources, toolName, meta.elapsedMs);
    notify({ phase: 'answering', model: `${toolName} · 仅检索` });
    await emitInChunks(text, onDelta, signal);
    return { text, sources, model: `${toolName} · ${meta.transport}`, meta };
  }

  notify({ phase: 'answering', model: llm.model });

  const contextText = sources
    .map((source, index) => `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet}`)
    .join('\n\n');

  const customPrompt =
    settings.ai && settings.ai.systemPrompt ? String(settings.ai.systemPrompt).trim() : '';
  const basePrompt = customPrompt || DEFAULT_AI_PROMPT;
  const grounding = [
    '以下是通过联网搜索检索到的资料，请基于资料回答用户问题。',
    '在引用处使用 [1][2] 这样的编号标注来源；资料不足或互相矛盾时请明确说明，不要编造。',
    `本次共检索到 ${sources.length} 条资料，编号与结果列表一一对应。`,
    '',
    contextText || '（本次检索没有返回任何资料，请直接说明未能检索到相关信息。）',
  ].join('\n');

  const text = await streamChat({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    messages: [
      { role: 'system', content: `${basePrompt}\n\n${grounding}` },
      { role: 'user', content: String(query || '') },
    ],
    temperature: settings.ai ? settings.ai.temperature : 0.6,
    stream: settings.ai ? settings.ai.stream !== false : true,
    authHeader: llm.authHeader,
    authPrefix: llm.authPrefix,
    signal,
    onDelta,
  });

  return { text, sources, model: llm.model, meta };
}

/**
 * 轻量连通性测试：
 * - MCP：只做 initialize 握手；
 * - HTTP：真实调用一次 SearchPro（会消耗 1 次调用额度），同时验证返回结构。
 * @param {object} cfg secrets.yuanbao
 * @returns {Promise<{latency:number, results?:number}>}
 */
export async function testConnection(cfg) {
  if (!cfg) throw new NeedsConfigError('请先填写服务地址或密钥');
  const transport = String(cfg.transport || 'http').toLowerCase() === 'mcp' ? 'mcp' : 'http';
  const tc3 = transport === 'http' && useTc3(cfg);

  if (transport === 'http' && tc3) {
    if (!String(cfg.secretId || '').trim()) throw new NeedsConfigError('请先填写 SecretId');
    if (!String(cfg.secretKey || '').trim()) throw new NeedsConfigError('请先填写 SecretKey');
  } else if (!cfg.endpoint) {
    throw new NeedsConfigError('请先填写服务地址');
  }

  const started = performance.now();
  if (transport === 'http') {
    const payload = await callSearchHttp(cfg, { Query: '腾讯云', Mode: 0, Cnt: 10 }, null);
    const pages = pagesFromPayload(payload);
    const version = (payload && payload.Response && payload.Response.Version) || '';
    return {
      latency: Math.round(performance.now() - started),
      results: pages.length,
      auth: tc3 ? 'TC3' : 'Bearer',
      version,
    };
  }
  await initialize(cfg.endpoint, cfg, null);
  return { latency: Math.round(performance.now() - started), auth: 'Bearer' };
}
