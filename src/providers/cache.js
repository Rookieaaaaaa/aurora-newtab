/**
 * providers/cache.js — 检索结果内存缓存
 *
 * 目的：减少调试 / 反复重试时的重复扣费。
 * 特点：
 *   1) 纯内存 Map，不落盘（关闭标签页即失效），不占用 chrome.storage 配额；
 *   2) TTL 10 分钟，过期读不到；
 *   3) 上限 50 条，超出后按插入顺序淘汰最早写入的一条（FIFO）；
 *   4) 只缓存「检索结果」，不缓存 AI 总结（总结每次都重新生成）。
 *
 * key 约定：`provider::query::count`，query 会去掉首尾空白并折叠连续空格，
 * 保证「同一个问题、同样的条数」能命中同一条缓存。
 */

/** 缓存有效期（10 分钟）。 */
export const CACHE_TTL_MS = 10 * 60 * 1000;

/** 最多缓存的条目数。 */
export const CACHE_MAX_ENTRIES = 50;

/** key -> { value, expireAt }，Map 的插入顺序即淘汰顺序。 */
const store = new Map();

/**
 * 规范化检索词：去首尾空白 + 折叠连续空白。
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query === null || query === undefined ? '' : query)
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 构造缓存 key。
 * @param {string} provider provider id，例如 'yuanbao' / 'deepseek-search'
 * @param {string} query 用户问题（可能带 site: / after: 等语法）
 * @param {number} count 本次请求的条数
 * @returns {string}
 */
export function buildCacheKey(provider, query, count) {
  const id = String(provider || 'unknown').trim() || 'unknown';
  const text = normalizeQuery(query);
  const size = Number(count);
  const limit = Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
  return `${id}::${text}::${limit}`;
}

/**
 * 读取缓存（过期的条目会被顺手清理）。
 * @param {string} key
 * @returns {object|null} 未命中 / 已过期返回 null
 */
export function getCached(key) {
  if (!key) return null;
  const record = store.get(key);
  if (!record) return null;
  if (Date.now() >= record.expireAt) {
    store.delete(key);
    return null;
  }
  return record.value === undefined ? null : record.value;
}

/**
 * 写入缓存。
 * 已存在的 key 会先删除再写入，保证淘汰顺序反映「最近一次写入」。
 * @param {string} key
 * @param {object} value 建议形如 { sources, meta }
 * @returns {boolean} 是否写入成功
 */
export function setCached(key, value) {
  if (!key) return false;
  if (value === undefined || value === null) return false;
  if (store.has(key)) store.delete(key);
  store.set(key, { value, expireAt: Date.now() + CACHE_TTL_MS });
  while (store.size > CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  return true;
}

/** 清空缓存（设置变更 / 手动清缓存时使用）。 */
export function clearCache() {
  store.clear();
}

/** 当前有效缓存条数（会先清理过期项）。 */
export function cacheSize() {
  const now = Date.now();
  store.forEach((record, key) => {
    if (now >= record.expireAt) store.delete(key);
  });
  return store.size;
}
