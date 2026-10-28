/**
 * utils.js — 通用工具函数与错误类型
 * 说明：本文件不依赖任何其它模块，避免循环引用。
 */

/** 生成唯一 id（优先使用 randomUUID）。 */
export function uid(prefix = 'id') {
  let core = '';
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      core = globalThis.crypto.randomUUID();
    }
  } catch (err) {
    core = '';
  }
  if (!core) {
    core = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  return `${prefix}-${core.replace(/[^a-zA-Z0-9-]/g, '')}`;
}

/** HTML 转义（渲染任何不可信字符串前必须调用）。 */
export function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 判断是否为普通对象。 */
function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * 深合并：patch 覆盖 base，返回全新对象（不修改任何入参）。
 * 数组整体替换，undefined 值忽略。
 */
export function deepMerge(base, patch) {
  const result = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  if (!isPlainObject(patch)) return result;
  Object.keys(patch).forEach((key) => {
    const next = patch[key];
    if (next === undefined) return;
    const prev = result[key];
    if (isPlainObject(next) && isPlainObject(prev)) {
      result[key] = deepMerge(prev, next);
    } else if (Array.isArray(next)) {
      result[key] = next.slice();
    } else {
      result[key] = next;
    }
  });
  return result;
}

/** 按 "a.b.c" 路径读取值。 */
export function getPath(obj, path, fallback) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
    cur = cur[parts[i]];
  }
  return cur === undefined ? fallback : cur;
}

/** 按 "a.b.c" 路径写入值（就地修改）。 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!isPlainObject(cur[key])) cur[key] = {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 防抖。 */
export function debounce(fn, wait = 200) {
  let timer = 0;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = 0;
  };
  wrapped.flush = (...args) => {
    if (timer) clearTimeout(timer);
    timer = 0;
    fn(...args);
  };
  return wrapped;
}

/** 数值夹取。 */
export function clamp(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}

/** 延迟。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 只允许 http/https/mailto 链接，其余返回空串。 */
export function sanitizeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return '';
}

/** 提取域名（失败返回空串）。 */
export function hostOf(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname.replace(/^www\./, '');
  } catch (err) {
    return '';
  }
}

/** 补全协议：github.com → https://github.com */
export function normalizeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return value;
  if (/^(mailto:|tel:)/i.test(value)) return value;
  return `https://${value}`;
}

/** 校验网址是否可用。 */
export function isValidUrl(raw) {
  try {
    const url = new URL(normalizeUrl(raw));
    return Boolean(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch (err) {
    return false;
  }
}

/** 未配置密钥 / 端点时抛出的错误，由面板提示「去填写密钥」。 */
export class NeedsConfigError extends Error {
  constructor(message = '尚未配置 AI 服务密钥') {
    super(message);
    this.name = 'NeedsConfigError';
  }
}

/** 服务端 / 网络错误。 */
export class ProviderError extends Error {
  constructor(message, status = 0, detail = '') {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.detail = detail;
  }
}

/** HTTP 状态码 → 中文可读原因。 */
export function mapHttpStatus(status) {
  switch (status) {
    case 400:
      return '请求参数有误（400），请检查模型名与请求体';
    case 401:
      return '密钥无效或已过期（401），请重新填写 API Key';
    case 403:
      return '没有访问权限（403），请检查密钥权限或服务开通状态';
    case 404:
      return '接口地址不存在（404），请检查 Base URL / MCP 端点是否填写正确';
    case 405:
      return '接口不支持该请求方法（405）';
    case 408:
      return '请求超时（408）';
    case 413:
      return '请求内容过大（413）';
    case 422:
      return '请求无法被处理（422），请检查参数格式';
    case 429:
      return '请求过于频繁，已被限流（429），请稍后再试';
    case 500:
    case 502:
    case 503:
    case 504:
      return `服务端异常（${status}），请稍后重试`;
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

/** 把任意异常转成可读中文提示。 */
export function describeError(error) {
  if (!error) return '未知错误';
  if (error.name === 'AbortError') return '请求已取消';
  if (error.name === 'NeedsConfigError') return error.message;
  if (error.name === 'ProviderError') return error.message;
  if (error instanceof TypeError) {
    return '网络异常或目标服务未允许跨域（CORS）访问，请检查地址、网络与代理设置';
  }
  if (error.name === 'TimeoutError') return '请求超时（30 秒），请检查网络或服务地址';
  return error.message ? String(error.message) : String(error);
}

/** 取得文本首字符（用于字母图标）。 */
export function firstChar(title) {
  const text = String(title || '').trim();
  if (!text) return '#';
  const chars = Array.from(text);
  return chars[0].toUpperCase();
}

/** 由字符串生成稳定的柔和渐变色。 */
export function softGradient(seed) {
  const text = String(seed || 'aurora');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360000;
  }
  const hue = hash % 360;
  const hue2 = (hue + 38) % 360;
  return `linear-gradient(135deg, hsl(${hue} 62% 56%), hsl(${hue2} 64% 44%))`;
}

/** 截断长文本。 */
export function truncate(text, max = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
