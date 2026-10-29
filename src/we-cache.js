/**
 * we-cache.js — WE 工坊壁纸资产本地缓存（IndexedDB，LRU 保留最近 5 张壁纸）
 *
 * 目的：起始页背景反复打开会反复拉云端原图/视频（视频单段 7~40MB），
 * 本地缓存命中后零流量、秒开。缓存按「壁纸」为粒度淘汰：同一张的
 * 预览图（p:{id}）和视频（v:{id}）算一组，超过 5 张时整组干掉最旧的。
 *
 * blob 本体存 storage.js 的 IndexedDB 媒体库（manifest 有 unlimitedStorage），
 * 索引（key → mediaId + 时间戳）存 chrome.storage.local。
 */

import { STORAGE_KEYS } from './defaults.js';
import { deleteMedia, getMedia, getRaw, saveMedia, setRaw } from './storage.js';
import { fetchWebFileList, isCloudReady, webAssetUrl } from './we-cloud.js';

/** 最多保留几张壁纸（图片+视频算一张）。 */
const MAX_WALLPAPERS = 5;

/** 网页壁纸整包预取的并发数。 */
const PREFETCH_CONCURRENCY = 4;

/** 本会话已在跑的预取任务（防重复触发）。 */
const runningPrefetch = new Set();

/* ------------------ 自定义缓存文件夹（File System Access API） ------------------ */

const DIR_DB = 'aurora-we-cache';
const DIR_STORE = 'handles';
const DIR_KEY = 'dir';
let dirDbPromise = null;

function openDirDb() {
  if (dirDbPromise) return dirDbPromise;
  dirDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DIR_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIR_STORE)) db.createObjectStore(DIR_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开句柄库失败'));
  });
  return dirDbPromise;
}

async function saveStoredHandle(key, handle) {
  const db = await openDirDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DIR_STORE, 'readwrite');
    tx.objectStore(DIR_STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadStoredHandle(key) {
  try {
    const db = await openDirDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE, 'readonly');
      const request = tx.objectStore(DIR_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    return null;
  }
}

async function usableStoredDir(key) {
  const handle = await loadStoredHandle(key);
  if (!handle) return null;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return handle;
  } catch (err) {
    return null;
  }
}

async function saveDirHandle(handle) {
  await saveStoredHandle(DIR_KEY, handle);
}

async function loadDirHandle() {
  try {
    const db = await openDirDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE, 'readonly');
      const request = tx.objectStore(DIR_STORE).get(DIR_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    return null;
  }
}

/** 清除已设置的缓存文件夹（回到浏览器默认存储）。 */
export async function clearWeCacheDirHandle() {
  try {
    const db = await openDirDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE, 'readwrite');
      tx.objectStore(DIR_STORE).delete(DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    /* ignore */
  }
}

/** 记住用户选的缓存文件夹。 */
export async function setWeCacheDirHandle(handle) {
  await saveDirHandle(handle);
}

/** 重授权已记住的文件夹（需用户手势；按钮点击里调用）。 */
export async function reauthorizeWeCacheDir() {
  const handle = await loadDirHandle();
  if (!handle) return false;
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch (err) {
    return false;
  }
}

/** 当前缓存文件夹状态（设置面板展示用）。 */
export async function getWeCacheDirState() {
  const handle = await loadDirHandle();
  if (!handle) return { configured: false, usable: false, name: '' };
  let permission = 'granted';
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch (err) {
    permission = 'prompt';
  }
  return {
    configured: true,
    usable: permission === 'granted',
    permission,
    name: handle.name,
  };
}

/** 可写状态的目录句柄；未设置/权限失效返回 null（调用方回退浏览器存储）。 */
async function usableDir() {
  const handle = await loadDirHandle();
  if (!handle) return null;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return handle;
  } catch (err) {
    return null;
  }
}

/* ---------------- 网页壁纸本地整包（chrome-extension:// 可直接加载） ---------------- */
//
// 为什么单独一套目录、还必须是扩展自己的目录：
// 网页壁纸是 iframe 跑作者的原版页面，资源路径全是相对的、还有由它自己脚本动态
// 拼出来的（images/${id}.jpg、media/original/${file}），扩展没法可靠地重写。
// 唯一能让它零网络的办法是让整包有一个 chrome-extension:// 前缀——也就是文件必须
// 落在扩展安装目录里。这个目录由用户授权一次，之后同步整包、LRU 淘汰都在这里做。
// 装成 crx（目录只读）时这里必然失败，调用方静默回落到云端直链。

const WEB_DIR_KEY = 'webDir';

/** 最多保留几套网页壁纸整包（与图片/视频的 LRU 口径一致）。 */
export const MAX_WEB_PACKAGES = 5;

/** 整包索引：{ items: { [壁纸ID]: { at, bytes, files:[], incomplete } } } */
const LOCAL_WEB_KEY = 'weLocalWeb';

/** 记住「网页壁纸本地包」根目录。 */
export function setWeWebDirHandle(handle) {
  return saveStoredHandle(WEB_DIR_KEY, handle);
}

/** 忘记根目录（不动磁盘上的包）。 */
export async function clearWeWebDirHandle() {
  try {
    const db = await openDirDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DIR_STORE, 'readwrite');
      tx.objectStore(DIR_STORE).delete(WEB_DIR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    /* ignore */
  }
}

/** 已记住的整包根目录（不看权限，用于重新授权）。 */
async function loadWebDirHandle() {
  return loadStoredHandle(WEB_DIR_KEY);
}

/** 可写的整包根目录；没设或权限失效返回 null。 */
export async function usableWebDir() {
  const handle = await loadWebDirHandle();
  if (!handle) return null;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    return handle;
  } catch (err) {
    return null;
  }
}

/** 重授权（需用户手势）。 */
export async function reauthorizeWeWebDir() {
  const handle = await loadWebDirHandle();
  if (!handle) return false;
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch (err) {
    return false;
  }
}

/** 当前整包目录状态（设置面板展示用）。 */
export async function getWeWebDirState() {
  const handle = await loadWebDirHandle();
  if (!handle) return { configured: false, usable: false, name: '', permission: 'none' };
  let permission = 'granted';
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch (err) {
    permission = 'prompt';
  }
  return { configured: true, usable: permission === 'granted', permission, name: handle.name };
}

/**
 * 验证这个文件夹是不是「扩展能直接读到」的那一个（…\assets\wallpapers）。
 * 猜路径不可靠，直接写个探针文件再从 chrome-extension:// 取回来——取得到才算数。
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export async function verifyWeWebDir(handle) {
  if (!handle) return false;
  const name = `__probe-${Date.now()}.txt`;
  try {
    await writeDirFile(handle, name, new Blob(['ok'], { type: 'text/plain' }));
    const url = chrome.runtime.getURL(`assets/we-web/${name}`);
    const res = await fetch(url, { cache: 'no-store' });
    const ok = res.ok && (await res.text()) === 'ok';
    await handle.removeEntry(name).catch(() => false);
    return ok;
  } catch (err) {
    return false;
  }
}

/** 读整包索引。 */
export async function loadLocalWebPackages() {
  const raw = await getRaw(LOCAL_WEB_KEY).catch(() => null);
  if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
    return { items: {} };
  }
  return { items: raw.items };
}

/** 已缓存的整包列表（最近使用在前）。 */
export async function listLocalWebPackages() {
  const index = await loadLocalWebPackages();
  return Object.entries(index.items)
    .map(([id, row]) => ({ id, at: Number(row.at) || 0, bytes: Number(row.bytes) || 0, files: Number(row.files && row.files.length) || 0, incomplete: Number(row.incomplete) || 0, manual: row.manual === true }))
    .sort((a, b) => b.at - a.at);
}

/** 目录里这个文件的大小（断点续传用）；不存在返回 -1。 */
async function dirFileSize(rootDir, relPath) {
  try {
    const segs = String(relPath).split('/').filter(Boolean);
    const name = segs.pop();
    let cur = rootDir;
    for (const seg of segs) cur = await cur.getDirectoryHandle(seg);
    const handle = await cur.getFileHandle(name);
    const file = await handle.getFile();
    return file.size;
  } catch (err) {
    return -1;
  }
}

/** 超过 MAX_WEB_PACKAGES 时删最旧的整包（连目录一起）。 */
async function evictWebPackages(index, dir) {
  const rows = Object.entries(index.items).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const drop = rows.slice(MAX_WEB_PACKAGES).map(([key]) => key);
  for (const key of drop) {
    if (dir) await dir.removeEntry(key, { recursive: true }).catch(() => false);
    delete index.items[key];
  }
  return drop;
}

/**
 * 这套整包在本地是否完整可用。
 *
 * - ready    索引登记过、文件齐了 → 可以放心用 chrome-extension:// 加载
 * - partial  正在同步 / 上次没下完 → 不能用（视频会 404，壁纸直接坏）
 * - unknown  没登记过（用户手动把包丢进 assets/we-web）→ 交给调用方探测
 *
 * @param {string} id
 * @returns {Promise<'ready'|'partial'|'unknown'>}
 */
export async function localWebPackageState(id) {
  const index = await loadLocalWebPackages();
  const row = index.items[String(id || '')];
  if (!row) return 'unknown';
  return Number(row.incomplete) > 0 ? 'partial' : 'ready';
}

/**
 * 首次探测到「手动放进 assets/wallpapers」的整包时补一条索引，
 * 让设置面板统计得到、LRU 也算得上。已有条目不动（不刷使用时间，避免每次开新标签写库）。
 * @param {string} id
 */
export async function markLocalWebPackage(id) {
  const key = String(id || '').trim();
  if (!key) return;
  const index = await loadLocalWebPackages();
  if (index.items[key]) return;
  index.items[key] = { at: Date.now(), bytes: 0, files: [], incomplete: 0, manual: true };
  await setRaw(LOCAL_WEB_KEY, index).catch(() => false);
}

/** 删一套本地整包。 */
export async function removeLocalWebPackage(id) {  const key = String(id || '').trim();
  if (!key) return false;
  const index = await loadLocalWebPackages();
  const dir = await usableWebDir();
  if (dir) await dir.removeEntry(key, { recursive: true }).catch(() => false);
  if (index.items[key]) {
    delete index.items[key];
    await setRaw(LOCAL_WEB_KEY, index).catch(() => false);
  }
  return true;
}

/** 清空全部本地整包。 */
export async function clearLocalWebPackages() {
  const index = await loadLocalWebPackages();
  const dir = await usableWebDir();
  for (const key of Object.keys(index.items)) {
    if (dir) await dir.removeEntry(key, { recursive: true }).catch(() => false);
  }
  await setRaw(LOCAL_WEB_KEY, { items: {} }).catch(() => false);
  return true;
}

/**
 * 把一套网页壁纸整包同步到本地目录。
 *
 * 逐文件下载、4 并发、单文件重试 3 次、已存在则跳过（中断后再点能接着下）。
 * 下完的包在扩展目录里，iframe 用 chrome-extension:// 直接读盘，一个字节都不出海。
 *
 * @param {{url:string, token:string}} cloud 云服务配置
 * @param {string} id 壁纸 ID
 * @param {{onProgress?:Function, force?:boolean}} [options]
 * @returns {Promise<{id:string, total:number, done:number, bytes:number, missing:string[], dropped:string[]}>}
 */
export async function syncLocalWebPackage(cloud, id, options = {}) {
  const key = String(id || '').trim();
  if (!key) throw new Error('缺少壁纸 ID');
  if (!isCloudReady(cloud)) throw new Error('未配置云服务地址');
  const dir = await usableWebDir();
  if (!dir) throw new Error('还没选本地包目录（扩展目录下的 assets\\wallpapers）');

  const files = await fetchWebFileList(cloud, key);
  if (!files.length) throw new Error('云端没有这套壁纸的文件清单（/web/files 为空）');

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const force = options.force === true;

  let cursor = 0;
  let finished = 0;
  let bytes = 0;
  let failed = 0;
  const okFiles = [];

  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      try {
        const present = force ? -1 : await dirFileSize(dir, `${key}/${file}`);
        if (present >= 0) {
          bytes += present;
          okFiles.push(file);
        } else {
          const url = webAssetUrl(cloud, key, file);
          let blob = null;
          for (let attempt = 0; attempt < 3 && !blob; attempt += 1) {
            try {
              const res = await fetch(url, { credentials: 'omit' });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const got = await res.blob();
              if (got && got.size) blob = got;
            } catch (err) {
              if (attempt === 2) throw err;
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
          await writeDirFile(dir, `${key}/${file}`, blob);
          bytes += blob.size;
          okFiles.push(file);
        }
      } catch (err) {
        failed += 1;
      }
      finished += 1;
      if (onProgress) onProgress({ done: finished, total: files.length, bytes, failed });
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));

  const missing = files.filter((file) => !okFiles.includes(file));
  const index = await loadLocalWebPackages();
  index.items[key] = {
    at: Date.now(),
    bytes,
    files: okFiles,
    incomplete: missing.length,
  };
  const dropped = await evictWebPackages(index, dir);
  await setRaw(LOCAL_WEB_KEY, index).catch(() => false);

  return { id: key, total: files.length, done: okFiles.length, bytes, missing, dropped };
}

function extOf(mime) {
  const type = String(mime || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('mp4')) return 'mp4';
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  return 'bin';
}

async function loadIndex() {
  const record = await getRaw(STORAGE_KEYS.weAssetCache).catch(() => null);
  return record && Array.isArray(record.entries) ? record : { entries: [] };
}

async function saveIndex(index) {
  await setRaw(STORAGE_KEYS.weAssetCache, index).catch(() => false);
}

/**
 * 读取缓存的资产 blob。命中会刷新最后使用时间（LRU 依据）；
 * 指向的媒体已丢失（被清storage 等）时自动清理悬空条目。
 * @param {string} key 如 `p:2858284176` / `v:2858284176`
 * @returns {Promise<Blob|null>}
 */
export async function getCachedWeAsset(key) {
  const index = await loadIndex();
  const entry = index.entries.find((row) => row.key === key);
  if (!entry) return null;

  // 自定义文件夹模式：资产是文件夹里的真实文件
  if (entry.file) {
    const dir = await usableDir();
    let blob = null;
    if (dir) {
      try {
        const handle = await dir.getFileHandle(entry.file);
        const file = await handle.getFile();
        if (file && file.size) blob = file; // File 即 Blob,可直接 createObjectURL
      } catch (err) {
        blob = null;
      }
    }
    if (blob) {
      entry.at = Date.now();
      await saveIndex(index);
      return blob;
    }
    index.entries = index.entries.filter((row) => row.key !== key);
    await saveIndex(index);
    return null;
  }

  // 浏览器默认存储模式：IndexedDB 媒体库
  const media = await getMedia(entry.mediaId).catch(() => null);
  if (!media || !media.blob) {
    index.entries = index.entries.filter((row) => row.key !== key);
    await saveIndex(index);
    return null;
  }
  entry.at = Date.now();
  await saveIndex(index);
  return media.blob;
}

/** 淘汰最旧的壁纸（整组），使剩余壁纸数不超过 MAX_WALLPAPERS。 */
async function evict(index, dir) {
  const byId = new Map();
  for (const entry of index.entries) {
    const id = entry.key.slice(entry.key.indexOf(':') + 1);
    const group = byId.get(id) || { at: 0, keys: [] };
    group.at = Math.max(group.at, entry.at);
    group.keys.push(entry.key);
    byId.set(id, group);
  }
  const sorted = [...byId.entries()].sort((a, b) => b[1].at - a[1].at);
  const dropKeys = new Set(sorted.slice(MAX_WALLPAPERS).flatMap(([, group]) => group.keys));
  if (!dropKeys.size) return;
  for (const entry of index.entries.filter((row) => dropKeys.has(row.key))) {
    if (entry.file && dir) await dir.removeEntry(entry.file).catch(() => false);
    if (entry.mediaId) await deleteMedia(entry.mediaId).catch(() => false);
  }
  index.entries = index.entries.filter((row) => !dropKeys.has(row.key));
}

/**
 * 写入/更新一个资产条目（同 key 覆盖），并按最近使用淘汰旧壁纸。
 * 设置了自定义文件夹 → 落成真实文件；否则进浏览器 IndexedDB 媒体库。
 * @param {string} key
 * @param {Blob} blob
 * @returns {Promise<boolean>} 是否成功入库
 */
export async function putCachedWeAsset(key, blob) {
  if (!blob || !blob.size) return false;
  const index = await loadIndex();
  const dir = await usableDir();
  const existing = index.entries.find((row) => row.key === key);
  if (existing) {
    if (existing.file && dir) await dir.removeEntry(existing.file).catch(() => false);
    if (existing.mediaId) await deleteMedia(existing.mediaId).catch(() => false);
    index.entries = index.entries.filter((row) => row.key !== key);
  }

  if (dir) {
    try {
      const file = `weasset-${key.replace(':', '-')}.${extOf(blob.type)}`;
      const handle = await dir.getFileHandle(file, { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      index.entries.push({ key, file, at: Date.now(), size: blob.size });
      await evict(index, dir);
      await saveIndex(index);
      return true;
    } catch (err) {
      /* 文件夹写入失败（磁盘满/权限被收回），回退浏览器存储 */
    }
  }

  const saved = await saveMedia(blob, `weasset-${key.replace(':', '-')}`).catch(() => null);
  if (!saved) return false;
  index.entries.push({ key, mediaId: saved.id, size: blob.size, at: Date.now() });
  await evict(index, null);
  await saveIndex(index);
  return true;
}

/**
 * 从 URL 拉取资产并入库，返回 blob（失败返回 null）。
 * 大视频建议不 await——fire-and-forget 让下一次打开零流量。
 * @param {string} url
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
export async function cacheWeAssetFromUrl(url, key) {
  if (!url) return null;
  try {
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob || !blob.size) return null;
    await putCachedWeAsset(key, blob);
    return blob; // 入库失败也把 blob 给调用方用（展示优先）
  } catch (err) {
    return null;
  }
}

/* ---------------------- 网页壁纸整包后台预取 ---------------------- */
//
// 目标：把网页壁纸的全部文件（含 JS 动态引用的 media/*.webm）提前拉到
// 浏览器 HTTP 磁盘缓存（fetch 用默认缓存模式，响应按服务端缓存头落地），
// 之后 iframe 里的相对路径请求全部命中本地磁盘，零服务器流量。
// 注意：单文件的"本地与否"由浏览器 HTTP 缓存管理——配合服务端
// max-age=31536000 immutable 即等效整包本地化；扩展负责的是"后台拉全"。

async function loadPrefetchJobs() {
  const record = await getRaw(STORAGE_KEYS.weWebPrefetch).catch(() => null);
  return record && typeof record === 'object' ? record : {};
}

async function savePrefetchJobs(jobs) {
  await setRaw(STORAGE_KEYS.weWebPrefetch, jobs).catch(() => false);
}

/**
 * 确保某张网页壁纸的整包文件已拉到本地（幂等：running/done 直接返回）。
 * fire-and-forget 调用即可，进度写在 weWebPrefetch[id]。
 * @param {{url:string, token:string}} cloud
 * @param {string} id
 */
export async function ensureWeWebPrefetch(cloud, id) {
  if (!cloud || !id || runningPrefetch.has(id)) return;
  const jobs = await loadPrefetchJobs();
  const job = jobs[id];
  if (job && (job.state === 'running' || job.state === 'done')) return;

  const files = await fetchWebFileList(cloud, id);
  if (!files.length) {
    // 云端还没有 /web/files 端点：记 unsupported，不反复骚扰
    jobs[id] = { state: 'unsupported', at: Date.now() };
    await savePrefetchJobs(jobs);
    return;
  }

  runningPrefetch.add(id);
  const doneFiles = (job && job.files) || {};
  const queue = files.filter((file) => !doneFiles[file]);
  jobs[id] = {
    state: 'running',
    total: files.length,
    done: files.length - queue.length,
    at: Date.now(),
  };
  await savePrefetchJobs(jobs);

  try {
    let index = 0;
    const worker = async () => {
      while (index < queue.length) {
        const file = queue[index];
        index += 1;
        try {
          // 默认缓存模式：响应按服务端缓存头落入 HTTP 磁盘缓存
          await fetch(webAssetUrl(cloud, id, file), { credentials: 'omit' });
        } catch (err) {
          /* 单文件失败不中断整包，下次触发补漏 */
        }
        jobs[id].done += 1;
        if (jobs[id].done % 5 === 0 || jobs[id].done === jobs[id].total) {
          await savePrefetchJobs(jobs);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PREFETCH_CONCURRENCY, queue.length) }, worker),
    );
    jobs[id].state = 'done';
    jobs[id].files = files.reduce((map, file) => ((map[file] = 1), map), {});
    await savePrefetchJobs(jobs);
  } finally {
    runningPrefetch.delete(id);
  }
}

/* ---------------------- 桌面工具交接文件夹 ---------------------- */
//
// 办公电脑等没有 Steam / Wallpaper Engine 的机器：扩展把云端原图写进一个
// 用户选定的交接文件夹，配套的 aurora-desktop-wallpaper 小工具以 --watch
// 模式监视该文件夹，发现新图自动应用为桌面（纯静态，无需任何游戏平台）。

const HANDOFF_KEY = 'handoff';

/** 已记住的交接文件夹（未设置或权限失效返回 null）。 */
export function getHandoffDir() {
  return usableStoredDir(HANDOFF_KEY);
}

/** 记住交接文件夹。 */
export function saveHandoffDir(handle) {
  return saveStoredHandle(HANDOFF_KEY, handle);
}

/** 向交接文件夹写入一个文件。 */
export async function writeHandoffFile(name, blob) {
  const dir = await usableStoredDir(HANDOFF_KEY);
  if (!dir) return false;
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

/* ---------------------- Lively 桌面联动 ---------------------- */
//
// Lively Wallpaper（免费开源，无需 Steam）：把壁纸文件写进它的库目录
// （默认 %USERPROFILE%\LivelyProjects），它会自动扫描出新壁纸。
// 视频类写单个 mp4；网页类写整个目录树（index.html 为入口）。

const LIVELY_KEY = 'lively';

/** 已记住的 Lively 库目录（未设置或权限失效返回 null）。 */
export function getLivelyDir() {
  return usableStoredDir(LIVELY_KEY);
}

/** 记住 Lively 库目录。 */
export function saveLivelyDir(handle) {
  return saveStoredHandle(LIVELY_KEY, handle);
}

/** 在目录下按相对路径写文件（自动逐级建子目录）。 */
export async function writeDirFile(rootDir, relPath, blob) {
  const segments = String(relPath).split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error('非法的相对路径');
  let cur = rootDir;
  for (const segment of segments) {
    cur = await cur.getDirectoryHandle(segment, { create: true });
  }
  const handle = await cur.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}
