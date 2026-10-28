/**
 * wallhaven.js — wallhaven 壁纸库源（免密钥）
 * 职责：
 * 1) fetchWallhavenList / fetchWallhavenBlob：直连 → 公共中转 的两级网络获取
 *    （扩展环境有 host 权限直连优先；普通浏览器预览中转优先，绕开 CORS）；
 * 2) resolveWallhaven：按背景模式（每日精选 / 每次随机 / 关键词）选一张，
 *    结果列表当天缓存在本机（storage key: wallhavenCache），当天内不重复请求接口；
 * 3) loadLastWallhaven / persistWallhavenBlob：上一张壁纸持久化（IndexedDB），
 *    断网时由 background 层兜底展示；
 * 4) loadBundledWallhaven：内置精选包按天轮换，零网络的最后兜底。
 */

import { BUNDLED_WALLPAPERS, STORAGE_KEYS, WALLHAVEN_RELAYS, buildCustomRelayUrl, buildWallhavenUrl, bundledWallpaperUrl } from './defaults.js';
import { deleteMedia, getMedia, getRaw, saveMedia, setRaw } from './storage.js';

const FETCH_TIMEOUT = 8000;
const BLOB_TIMEOUT = 15000;
const RELAY_TIMEOUT = 5000;
/** 当日缓存的最大条数（wallhaven 默认每页 24 条，正好一页）。 */
const LIST_LIMIT = 24;

/** 是否处于扩展环境（有 host 权限免跨域）；普通浏览器预览走中转优先。 */
function inExtension() {
  try {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

/** 带超时的 fetch。 */
function timedFetch(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit' }).finally(
    () => clearTimeout(timer),
  );
}

/** 本地日期 key（当日缓存用）。 */
function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** 规范化 API 返回的单条壁纸。 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.path) return null;
  const thumbs = raw.thumbs && typeof raw.thumbs === 'object' ? raw.thumbs : {};
  return {
    id: String(raw.id),
    url: String(raw.path),
    pageUrl: raw.url ? String(raw.url) : `https://wallhaven.cc/w/${raw.id}`,
    thumb: String(thumbs.large || thumbs.small || raw.path),
    resolution: String(raw.resolution || ''),
    favorites: Number(raw.favorites) || 0,
  };
}

/** 从 settings.background 归一化参数（老数据缺字段时回落默认值）。 */
function paramsOf(bg) {
  const mode = ['daily', 'random', 'search'].indexOf(bg.wallhavenMode) >= 0 ? bg.wallhavenMode : 'daily';
  return {
    mode,
    query: String(bg.wallhavenQuery || '').trim(),
    categories: /^[0-1]{3}$/.test(String(bg.wallhavenCategories)) ? String(bg.wallhavenCategories) : '111',
    relay: bg.wallhavenRelay !== false,
    relayUrl: String(bg.wallhavenRelayUrl || '').trim(),
  };
}

/** 组装中转候选：自定义模板优先，公共中转殿后。 */
function relayAttempts(kind, target, relayUrl) {
  const attempts = [];
  const custom = buildCustomRelayUrl(relayUrl, target);
  if (custom) attempts.push(custom);
  WALLHAVEN_RELAYS[kind].forEach((wrap) => attempts.push(wrap(target)));
  return attempts;
}

/**
 * 拉取一页壁纸列表。
 * 获取顺序：直连（扩展环境）→ 公共中转（境外可达，无本地代理也能通）。
 * @param {{q?:string, categories?:string, sorting?:string, topRange?:string, page?:number, seed?:string, relay?:boolean}} options
 * @returns {Promise<{items:Array, meta:object}>}
 */
export async function fetchWallhavenList(options = {}) {
  const requestUrl = buildWallhavenUrl(options);
  const useRelay = options.relay !== false;
  const relayFirst = useRelay && !inExtension(); // 预览环境直连必被 CORS 拦，中转优先

  const attempts = [];
  if (!relayFirst) attempts.push({ url: requestUrl, timeout: FETCH_TIMEOUT });
  if (useRelay) {
    relayAttempts('json', requestUrl, options.relayUrl).forEach((url) =>
      attempts.push({ url, timeout: RELAY_TIMEOUT }),
    );
  }
  if (relayFirst) attempts.push({ url: requestUrl, timeout: FETCH_TIMEOUT });

  let lastError = null;
  for (const attempt of attempts) {
    let response;
    try {
      response = await timedFetch(attempt.url, attempt.timeout);
    } catch (err) {
      lastError = new Error('壁纸库连接失败（wallhaven 为境外服务，请确认代理已开启）');
      continue;
    }
    if (!response.ok) {
      lastError = new Error(`壁纸库接口返回 HTTP ${response.status}`);
      continue;
    }
    try {
      const data = await response.json();
      const rows = data && Array.isArray(data.data) ? data.data : [];
      const items = rows.map(normalizeItem).filter(Boolean);
      if (items.length) return { items: items.slice(0, LIST_LIMIT), meta: data.meta || {} };
      lastError = new Error('没有找到符合条件的壁纸');
    } catch (err) {
      lastError = new Error('壁纸库返回数据异常');
    }
  }
  throw lastError || new Error('壁纸库获取失败');
}

/** 计算某个模式应使用的搜索参数。 */
function searchParamsFor({ mode, query, categories }) {
  if (mode === 'search' && query) {
    return { q: query, categories, sorting: 'relevance' };
  }
  // daily / random：月度热门榜，质量有保障
  return { categories, sorting: 'toplist', topRange: '1M' };
}

/** 当日缓存 key（模式 + 关键词 + 分类一致才复用）。 */
function cacheKeyOf(params) {
  return `${params.mode}|${params.query}|${params.categories}`;
}

/**
 * 按背景设置选出今天的壁纸。
 * @param {object} bg settings.background
 * @returns {Promise<{url:string, item:object}>}
 */
export async function resolveWallhaven(bg) {
  const params = paramsOf(bg);
  const key = cacheKeyOf(params);
  const today = localDateKey();

  const cache = await getRaw(STORAGE_KEYS.wallhavenCache).catch(() => null);
  let items = cache && cache.date === today && cache.key === key && Array.isArray(cache.items)
    ? cache.items
    : null;

  if (!items) {
    const result = await fetchWallhavenList({
      ...searchParamsFor(params),
      relay: params.relay,
      relayUrl: params.relayUrl,
    });
    items = result.items;
    await setRaw(STORAGE_KEYS.wallhavenCache, { date: today, key, items }).catch(() => false);
  }

  // daily / search：按“年内第几天”取模，同一天稳定、每天自动换；
  // random：每次打开新标签随机换
  let index = 0;
  if (params.mode === 'random') {
    index = Math.floor(Math.random() * items.length);
  } else {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    index = dayOfYear % items.length;
  }
  const item = items[index];
  return { url: item.url, item };
}

/**
 * 拉取壁纸图片本体（blob）。一次下载同时用于展示与本地持久化。
 * 直连失败时依次尝试公共图片中转（wsrv 顺带压到 1920 宽）。
 * @param {string} url
 * @param {{relay?:boolean}} [options]
 * @returns {Promise<Blob>}
 */
export async function fetchWallhavenBlob(url, options = {}) {
  if (!url) throw new Error('壁纸地址为空');
  const useRelay = options.relay !== false;
  const relayFirst = useRelay && !inExtension();

  const attempts = [];
  if (!relayFirst) attempts.push({ url, timeout: BLOB_TIMEOUT });
  if (useRelay) {
    relayAttempts('image', url, options.relayUrl).forEach((wrapped) =>
      attempts.push({ url: wrapped, timeout: RELAY_TIMEOUT }),
    );
  }
  if (relayFirst) attempts.push({ url, timeout: BLOB_TIMEOUT });

  let lastError = null;
  for (const attempt of attempts) {
    let response;
    try {
      response = await timedFetch(attempt.url, attempt.timeout);
    } catch (err) {
      lastError = new Error('壁纸图片下载失败（请确认代理已开启或专用代理地址正确）');
      continue;
    }
    if (!response.ok) {
      lastError = new Error(`壁纸图片下载失败（HTTP ${response.status}）`);
      continue;
    }
    try {
      const blob = await response.blob();
      if (blob && blob.size) return blob;
      lastError = new Error('壁纸图片内容为空');
    } catch (err) {
      lastError = new Error('壁纸图片下载失败');
    }
  }
  throw lastError || new Error('壁纸图片下载失败');
}

/**
 * 读取上一张成功展示的壁纸（IndexedDB 媒体），断网/代理关闭时的兜底。
 * @returns {Promise<{url:string, blob:Blob}|null>}
 */
export async function loadLastWallhaven() {
  const record = await getRaw(STORAGE_KEYS.wallhavenLast).catch(() => null);
  if (!record || !record.mediaId) return null;
  const media = await getMedia(record.mediaId).catch(() => null);
  if (!media || !media.blob) return null;
  return { url: String(record.url || ''), blob: media.blob };
}

/**
 * 持久化当前壁纸（替换旧媒体）。任何失败都静默降级——展示不受影响。
 * @param {string} url
 * @param {Blob} blob
 */
export async function persistWallhavenBlob(url, blob) {
  const prev = await getRaw(STORAGE_KEYS.wallhavenLast).catch(() => null);
  if (prev && prev.url === url && prev.mediaId) return; // 同一张，无需重复保存
  const saved = await saveMedia(blob, `wallhaven-${Date.now()}`).catch(() => null);
  if (!saved) return;
  await setRaw(STORAGE_KEYS.wallhavenLast, { url, mediaId: saved.id }).catch(() => false);
  if (prev && prev.mediaId && prev.mediaId !== saved.id) {
    await deleteMedia(prev.mediaId).catch(() => false);
  }
}

/**
 * 内置精选壁纸（本地文件，零网络零依赖的最后兜底）。按年内第几天轮换。
 * @returns {string} 相对路径，可直接作为 <img src>
 */
export function loadBundledWallhaven() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return bundledWallpaperUrl(dayOfYear);
}

/** 内置包张数（供测试与提示文案使用）。 */
export const BUNDLED_COUNT = BUNDLED_WALLPAPERS.length;
