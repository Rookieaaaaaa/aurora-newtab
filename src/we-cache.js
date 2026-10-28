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
import { fetchWebFileList, webAssetUrl } from './we-cloud.js';

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
