/**
 * storage.js — 存储层
 * 1) 优先使用 chrome.storage.local；
 * 2) 环境不支持时自动降级到 localStorage（同一 JSON 结构），
 *    方便用 python -m http.server 在普通浏览器中预览；
 * 3) 大文件（图片/视频）存 IndexedDB（库名 aurora-media / store files）。
 */

import {
  DEFAULT_SECRETS,
  DEFAULT_SETTINGS,
  DEFAULT_SITES,
  SETTINGS_VERSION,
  STORAGE_KEYS,
} from './defaults.js';
import { deepMerge, isValidUrl, normalizeUrl, uid } from './utils.js';

const LS_PREFIX = 'aurora:';
const DB_NAME = 'aurora-media';
const DB_VERSION = 1;
const DB_STORE = 'files';

let backendMode = 'unknown';

/* -------------------------------------------------------------------------- */
/*                              底层 key-value 读写                            */
/* -------------------------------------------------------------------------- */

/** 拿到 chrome.storage.local，不可用则返回 null。 */
function chromeArea() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/** 读取 chrome.runtime.lastError（必须在回调内同步读取）。 */
function readLastError() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
      return chrome.runtime.lastError.message || 'storage error';
    }
  } catch (err) {
    return 'storage error';
  }
  return '';
}

/**
 * 读取一条记录。
 * @param {string} key
 * @returns {Promise<any>}
 */
async function rawGet(key) {
  const area = chromeArea();
  if (area) {
    try {
      const result = await new Promise((resolve, reject) => {
        area.get(key, (payload) => {
          const message = readLastError();
          if (message) reject(new Error(message));
          else resolve(payload || {});
        });
      });
      backendMode = 'chrome';
      return result[key];
    } catch (err) {
      console.warn('[storage] chrome.storage 读取失败，回退 localStorage', err);
    }
  }
  backendMode = 'local';
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch (err) {
    console.warn('[storage] localStorage 读取失败', err);
    return undefined;
  }
}

/**
 * 写入一条记录。
 * @param {string} key
 * @param {any} value
 * @returns {Promise<boolean>} 是否成功
 */
async function rawSet(key, value) {
  const area = chromeArea();
  if (area) {
    try {
      await new Promise((resolve, reject) => {
        area.set({ [key]: value }, () => {
          const message = readLastError();
          if (message) reject(new Error(message));
          else resolve();
        });
      });
      backendMode = 'chrome';
      return true;
    } catch (err) {
      console.warn('[storage] chrome.storage 写入失败，回退 localStorage', err);
    }
  }
  backendMode = 'local';
  try {
    window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[storage] localStorage 写入失败', err);
    return false;
  }
}

/** 当前实际生效的存储后端，用于设置面板展示。 */
export function getBackend() {
  if (backendMode === 'unknown') {
    backendMode = chromeArea() ? 'chrome' : 'local';
  }
  return backendMode;
}

/* -------------------------------------------------------------------------- */
/*                                  设置                                       */
/* -------------------------------------------------------------------------- */

/** 规范化 settings（补齐默认值 + 版本迁移）。 */
function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, raw || {});
  merged.version = SETTINGS_VERSION;
  merged.background.blur = Math.min(20, Math.max(0, Number(merged.background.blur) || 0));
  merged.background.dim = Math.min(0.8, Math.max(0, Number(merged.background.dim) || 0));
  merged.ai.temperature = Math.min(2, Math.max(0, Number(merged.ai.temperature) || 0));
  // maxSources：0 是合法输入（夹到 1），只有非数字才回落默认 20；上限对齐元宝 Cnt 最大 50
  const maxSources = Number(merged.ai.maxSources);
  merged.ai.maxSources = Number.isFinite(maxSources)
    ? Math.min(50, Math.max(1, Math.trunc(maxSources)))
    : 20;
  merged.ai.stream = merged.ai.stream !== false;
  // 时效筛选：只接受已知档位，老数据 / 脏数据回落「不限时间」
  const freshness = String(merged.ai.searchFreshness || 'any');
  merged.ai.searchFreshness = ['any', 'd7', 'm1', 'y1'].indexOf(freshness) >= 0 ? freshness : 'any';
  return merged;
}

/** 读取设置（始终返回合并默认值后的完整对象）。 */
export async function getSettings() {
  const stored = await rawGet(STORAGE_KEYS.settings);
  const settings = normalizeSettings(stored);
  // 普通浏览器预览（没有 chrome.storage）时必应接口会被 CORS 拦截，
  // 首次加载默认改用动态渐变，避免每次打开都弹红色降级提示；扩展内仍默认必应。
  if (stored === undefined && !chromeArea()) {
    settings.background.type = 'gradient';
  }
  return settings;
}

/** 覆盖写入设置。 */
export async function setSettings(settings) {
  const normalized = normalizeSettings(settings);
  await rawSet(STORAGE_KEYS.settings, normalized);
  return normalized;
}

/** 局部更新设置（深合并），返回更新后的完整设置。 */
export async function patchSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings(deepMerge(current, patch || {}));
  await rawSet(STORAGE_KEYS.settings, next);
  return next;
}

/* -------------------------------------------------------------------------- */
/*                                  密钥                                       */
/* -------------------------------------------------------------------------- */

/** 读取密钥配置（绝不写入导出文件）。 */
export async function getSecrets() {
  const stored = await rawGet(STORAGE_KEYS.secrets);
  return deepMerge(DEFAULT_SECRETS, stored || {});
}

/** 写入密钥配置（深合并，支持局部更新）。 */
export async function setSecrets(patch) {
  const current = await getSecrets();
  const next = deepMerge(current, patch || {});
  await rawSet(STORAGE_KEYS.secrets, next);
  return next;
}

/* -------------------------------------------------------------------------- */
/*                                  站点                                       */
/* -------------------------------------------------------------------------- */

/** 规范化单个站点。 */
function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || '').trim();
  const url = normalizeUrl(raw.url);
  if (!title && !url) return null;
  if (!isValidUrl(url)) return null;
  const iconRaw = raw.icon && typeof raw.icon === 'object' ? raw.icon : {};
  const type = ['auto', 'url', 'upload'].includes(iconRaw.type) ? iconRaw.type : 'auto';
  return {
    id: raw.id ? String(raw.id) : uid('site'),
    title: title || url.replace(/^https?:\/\//, ''),
    url,
    icon: { type, value: typeof iconRaw.value === 'string' ? iconRaw.value : '' },
  };
}

/** 读取站点列表（无效数据自动丢弃；为空时返回默认站点）。 */
export async function getSites() {
  const stored = await rawGet(STORAGE_KEYS.sites);
  if (!Array.isArray(stored)) return DEFAULT_SITES.map((site) => ({ ...site, icon: { ...site.icon } }));
  const cleaned = stored.map(normalizeSite).filter(Boolean);
  if (!cleaned.length) return [];
  return cleaned;
}

/** 写入站点列表，返回写入后的数组。 */
export async function setSites(sites) {
  const cleaned = (Array.isArray(sites) ? sites : []).map(normalizeSite).filter(Boolean);
  await rawSet(STORAGE_KEYS.sites, cleaned);
  return cleaned;
}

/* -------------------------------------------------------------------------- */
/*                              通用缓存读写                                    */
/* -------------------------------------------------------------------------- */

/** 读取任意 key。 */
export async function getRaw(key) {
  return rawGet(key);
}

/** 写入任意 key。 */
export async function setRaw(key, value) {
  return rawSet(key, value);
}

/* -------------------------------------------------------------------------- */
/*                              IndexedDB 媒体库                                */
/* -------------------------------------------------------------------------- */

let dbPromise = null;

/** 打开（或复用）IndexedDB。 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
    request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
  });
  return dbPromise;
}

/**
 * 保存媒体文件。
 * @param {Blob} blob
 * @param {string} [name]
 * @returns {Promise<{id:string,name:string,type:string,size:number,createdAt:number}>}
 */
export async function saveMedia(blob, name = '') {  const db = await openDb();
  const record = {
    id: uid('media'),
    blob,
    name: name || 'file',
    type: blob && blob.type ? blob.type : 'application/octet-stream',
    size: blob && typeof blob.size === 'number' ? blob.size : 0,
    createdAt: Date.now(),
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('媒体写入失败'));
    tx.onabort = () => reject(tx.error || new Error('媒体写入被中止'));
  });
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    size: record.size,
    createdAt: record.createdAt,
  };
}

/**
 * 按 id 读取媒体记录。
 * @param {string} id
 * @returns {Promise<{id:string,blob:Blob,name:string,type:string,size:number,createdAt:number}|null>}
 */
export async function getMedia(id) {  if (!id) return null;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('媒体读取失败'));
  });
}

/** 删除媒体。 */
export async function deleteMedia(id) {
  if (!id) return false;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('媒体删除失败'));
  });
  return true;
}

/** 列出全部媒体元信息（不含 blob）。 */
export async function listMedia() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const request = tx.objectStore(DB_STORE).getAll();
    request.onsuccess = () => {
      const rows = Array.isArray(request.result) ? request.result : [];
      resolve(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          type: row.type,
          size: row.size,
          createdAt: row.createdAt,
        })),
      );
    };
    request.onerror = () => reject(request.error || new Error('媒体列表读取失败'));
  });
}

/* -------------------------------------------------------------------------- */
/*                              配置导入 / 导出                                 */
/* -------------------------------------------------------------------------- */

/**
 * 导出配置：settings + sites（严格剔除 secrets）。
 * @returns {Promise<object>}
 */
export async function exportConfig() {
  const [settings, sites] = await Promise.all([getSettings(), getSites()]);
  const payload = {
    app: 'aurora-newtab',
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    sites,
  };
  // 双保险：清理可能被误写入的密钥字段
  if (payload.settings && payload.settings.secrets) delete payload.settings.secrets;
  return payload;
}

/**
 * 导入配置：校验后深合并设置并整体替换站点。
 * @param {object} data 解析后的 JSON
 * @returns {Promise<{settings:object, sites:Array}>}
 */
export async function importConfig(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('配置文件内容为空或格式不正确');
  }
  const incomingSettings = data.settings;
  const incomingSites = data.sites;
  if (!incomingSettings && !incomingSites) {
    throw new Error('配置文件中缺少 settings / sites 字段');
  }
  if (incomingSettings && typeof incomingSettings !== 'object') {
    throw new Error('settings 字段格式不正确');
  }
  if (incomingSites && !Array.isArray(incomingSites)) {
    throw new Error('sites 字段必须是数组');
  }

  let settings = await getSettings();
  if (incomingSettings) {
    const sanitized = { ...incomingSettings };
    delete sanitized.secrets; // 导入不允许覆盖密钥
    settings = await setSettings(deepMerge(settings, sanitized));
  }

  let sites = await getSites();
  if (Array.isArray(incomingSites)) {
    sites = await setSites(incomingSites);
  }
  return { settings, sites };
}

/** 重置为默认配置（保留 secrets）。 */
export async function resetAll() {
  const settings = await setSettings(DEFAULT_SETTINGS);
  const sites = await setSites(DEFAULT_SITES);
  return { settings, sites };
}
