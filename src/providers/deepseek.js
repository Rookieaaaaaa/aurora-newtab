/**
 * providers/deepseek.js — DeepSeek（OpenAI 兼容）SSE 流式客户端
 * 同时导出通用能力 streamChat / buildMessages，供 custom.js 与 yuanbao-mcp.js 复用。
 */

import { DEFAULT_AI_PROMPT } from '../defaults.js';
import { NeedsConfigError, ProviderError, describeError, mapHttpStatus } from '../utils.js';

/** 拼接 Base URL 与接口路径。 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new NeedsConfigError('尚未配置 Base URL');
  if (path === '/chat/completions' && /\/chat\/completions$/.test(base)) return base;
  if (/\/completions$/.test(base) && path === '/chat/completions') {
    // 例如用户填了 .../v1/completions，纠正为 chat/completions
    return base.replace(/\/completions$/, '/chat/completions');
  }
  return `${base}${path}`;
}

/** 构造鉴权头。 */
export function buildAuthHeaders({ apiKey, authHeader, authPrefix }) {
  const headers = {};
  const name = String(authHeader || 'Authorization').trim() || 'Authorization';
  const prefix = authPrefix === undefined || authPrefix === null ? 'Bearer ' : String(authPrefix);
  if (apiKey) headers[name] = `${prefix}${apiKey}`;
  return headers;
}

/** 构造消息列表（系统提示词为空时使用内置提示词）。 */
export function buildMessages(settings, query, extraSystem = '') {
  const custom = settings && settings.ai && settings.ai.systemPrompt ? settings.ai.systemPrompt.trim() : '';
  const base = custom || DEFAULT_AI_PROMPT;
  const system = extraSystem ? `${base}\n\n${extraSystem}` : base;
  return [
    { role: 'system', content: system },
    { role: 'user', content: String(query || '') },
  ];
}

/** 安全读取响应文本（截断到 300 字符，便于展示错误原因）。 */
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
      /* 非 JSON，直接截断 */
    }
    return trimmed.slice(0, 300);
  } catch (err) {
    return '';
  }
}

/**
 * 发起一次 Chat Completions 请求。
 * @param {object} options
 * @param {string} options.baseUrl
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {Array<{role:string,content:string}>} options.messages
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.temperature]
 * @param {boolean} [options.stream]
 * @param {string} [options.authHeader]
 * @param {string} [options.authPrefix]
 * @param {(delta:string)=>void} options.onDelta
 * @returns {Promise<string>} 完整文本
 */
export async function streamChat(options) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    signal,
    temperature = 0.6,
    stream = true,
    authHeader = 'Authorization',
    authPrefix = 'Bearer ',
    onDelta,
  } = options;

  if (!baseUrl) throw new NeedsConfigError('尚未配置 Base URL');
  if (!apiKey) throw new NeedsConfigError('尚未配置 API Key');
  if (!model) throw new NeedsConfigError('尚未配置模型名称');

  const endpoint = joinUrl(baseUrl, '/chat/completions');
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    ...buildAuthHeaders({ apiKey, authHeader, authPrefix }),
  };

  const body = {
    model,
    messages,
    temperature: Math.min(2, Math.max(0, Number(temperature) || 0)),
    stream: Boolean(stream),
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ProviderError(`无法连接模型服务：${describeError(err)}`);
  }

  if (!response.ok) {
    const detail = await safeReadText(response);
    const message = detail ? `${mapHttpStatus(response.status)} · ${detail}` : mapHttpStatus(response.status);
    throw new ProviderError(message, response.status, detail);
  }

  const emit = (text) => {
    if (typeof onDelta === 'function' && text) onDelta(text);
  };

  // 非流式：一次性返回
  if (!stream) {
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ProviderError('模型返回内容不是合法 JSON');
    }
    const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
    const text =
      (choice && choice.message && typeof choice.message.content === 'string'
        ? choice.message.content
        : '') || '';
    if (!text) throw new ProviderError('模型没有返回任何内容');
    emit(text);
    return text;
  }

  // 流式：逐行解析 SSE
  if (!response.body || typeof response.body.getReader !== 'function') {
    const raw = await response.text();
    const fallback = extractContentFromSse(raw);
    if (!fallback) throw new ProviderError('当前环境不支持流式读取，且响应中没有可用内容');
    emit(fallback);
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let pending = '';
  let lastFlush = 0;
  let finished = false;

  const flush = (force) => {
    if (!pending) return;
    const now = performance.now();
    if (!force && now - lastFlush < 40) return;
    lastFlush = now;
    const chunk = pending;
    pending = '';
    emit(chunk);
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payloadText = line.slice(5).trim();
        if (payloadText === '[DONE]') {
          finished = true;
          break;
        }
        let json = null;
        try {
          json = JSON.parse(payloadText);
        } catch (err) {
          continue; // 忽略无法解析的心跳帧
        }
        if (json && json.error) {
          throw new ProviderError(
            (json.error && json.error.message) || '模型服务返回错误',
            0,
            String(json.error),
          );
        }
        const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
        const delta = choice && choice.delta ? choice.delta.content : '';
        if (typeof delta === 'string' && delta) {
          full += delta;
          pending += delta;
          flush(false);
        }
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      flush(true);
      throw err;
    }
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(`流式读取中断：${describeError(err)}`);
  } finally {
    flush(true);
    if (finished && reader.cancel) {
      try {
        await reader.cancel();
      } catch (err) {
        /* ignore */
      }
    }
  }

  if (!full) throw new ProviderError('模型没有返回任何内容，请检查模型名称是否正确');
  return full;
}

/** 从完整 SSE 文本中提取内容（不支持流式读取时的兜底）。 */
function extractContentFromSse(raw) {
  const lines = String(raw || '').split('\n');
  let text = '';
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const delta = choice && choice.delta ? choice.delta.content : '';
      if (typeof delta === 'string') text += delta;
    } catch (err) {
      /* ignore */
    }
  });
  return text;
}

/**
 * 统一 provider 接口：run(context) => Promise<{text, sources, model}>
 */
export async function run(context) {
  const { query, settings, secrets, signal, onDelta, onSources, onStatus } = context;
  const cfg = (secrets && secrets.deepseek) || {};
  if (!cfg.apiKey) throw new NeedsConfigError('尚未配置 DeepSeek API Key');

  const baseUrl = cfg.baseUrl || 'https://api.deepseek.com/v1';
  const model = cfg.model || 'deepseek-chat';

  if (typeof onStatus === 'function') {
    onStatus({ demo: false, phase: 'answering', providerName: 'DeepSeek', model });
  }

  const text = await streamChat({
    baseUrl,
    apiKey: cfg.apiKey,
    model,
    messages: buildMessages(settings, query),
    temperature: settings.ai ? settings.ai.temperature : 0.6,
    stream: settings.ai ? settings.ai.stream !== false : true,
    signal,
    onDelta,
  });

  if (typeof onSources === 'function') onSources([]);
  return { text, sources: [], model };
}
