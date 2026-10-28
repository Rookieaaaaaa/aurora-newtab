/**
 * we-cloud.js — 自建壁纸云服务客户端
 *
 * 为什么需要它：
 * Steam 只给工坊条目 1024×1024 的压缩预览（视频件更只有 192×192 GIF），
 * 而壁纸的真实素材（作者原图、完整 mp4）存在工坊文件里，取它要走 Steam 的
 * depot 协议（CM 握手 + manifest + 分块 AES 解密）——浏览器开不了 TCP、
 * 也跑不了这套协议栈，扩展端不可能直连下载。
 *
 * 所以由用户自己的云服务器跑 steamcmd 下载并解包，扩展只引用它的 HTTP 地址：
 *   <服务>/api/wallpaper/<id>/preview.jpg   作者原图，直链给 <img>
 *   <服务>/api/wallpaper/<id>/video.mp4     完整成片，直链给 <video>（Range 流式）
 * 浏览器自己发 Range 请求，本地零落盘、零复制。
 *
 * 鉴权说明：
 * <img src> / <video src> 无法携带自定义请求头，因此资源直链必须支持
 * `?token=` 查询参数（需求文档 §4.5 已同步）。API JSON 请求则双保险：
 * Authorization 头 + query 参数同时带上，反向代理剥掉哪个都能过。
 */

import { getPath, sleep } from './utils.js';
import { STORAGE_KEYS } from './defaults.js';
import { getRaw, setRaw } from './storage.js';

/** 单次请求的默认超时（毫秒）。Steam 下载是异步的，接口本身应该秒回。 */
const DEFAULT_TIMEOUT = 15000;

/** 云端状态里视为「终态」的取值（停止轮询）。 */
const TERMINAL_STATES = new Set(['ready', 'failed', 'need_auth', 'not_found']);

/**
 * 最近一次「网络层」失败的时间戳。
 * 服务没起 / 地址写错时，每次打开详情都白等一个超时非常难受；
 * 失败后冷却一分钟，期间直接当作不可用处理。配置改动或连上即恢复。
 */
let lastNetworkFailure = 0;
const FAILURE_COOLDOWN = 60000;

/** 是否处于失败冷却期内。 */
export function cloudIsCoolingDown() {
  return Date.now() - lastNetworkFailure < FAILURE_COOLDOWN;
}

/** 清除冷却（改了配置后立刻重试时用）。 */
export function resetCloudCooldown() {
  lastNetworkFailure = 0;
}

/**
 * 归一化服务地址：补协议、去尾部斜杠、容忍直接粘贴的 `/api`。
 * 非法输入返回空串（视为未配置）。
 * @param {string} raw 如 aurora.example.com 或 https://aurora.example.com/api/
 * @returns {string} 如 https://aurora.example.com
 */
export function normalizeServiceUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.host) return '';
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch (err) {
    return '';
  }
}

/**
 * 从设置与密钥里取出云服务配置。
 * token 属于密钥，单独存在 secrets.weCloud.token，不随配置导出。
 * @param {object} background settings.background
 * @param {object} secrets secrets
 * @returns {{url:string, token:string, enabled:boolean}}
 */
export function readCloudConfig(background, secrets) {
  const bg = background || {};
  const token = String(getPath(secrets, 'weCloud.token', '') || '').trim();
  return {
    url: normalizeServiceUrl(bg.weCloudUrl),
    token,
    // 显式关闭开关时不启用；老配置没有这个字段，按启用处理
    enabled: bg.weCloudEnabled !== false,
  };
}

/** 是否可用（有地址且没被关掉）。token 允许为空，方便内网或反代已鉴权的部署。 */
export function isCloudReady(config) {
  return Boolean(config && config.enabled && config.url);
}

/**
 * 拼一个带鉴权的接口地址。
 * @param {{url:string, token:string}} config
 * @param {string} path 相对 /api 的路径
 * @param {Record<string, string|number>} [params]
 */
function buildUrl(config, path, params) {
  const url = new URL(`${config.url}/api/${String(path || '').replace(/^\/+/, '')}`);
  if (config.token) url.searchParams.set('token', config.token);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

/**
 * 资源直链（给 <img> / <video> 用，鉴权走 query 参数）。
 * @param {{url:string, token:string}} config
 * @param {string} id 壁纸 ID
 * @param {'preview'|'video'} asset
 * @returns {string} 未配置时返回空串
 */
export function cloudAssetUrl(config, id, asset) {
  if (!isCloudReady(config) || !id) return '';
  const name = asset === 'video' ? 'video.mp4' : asset === 'web' ? 'web/index.html' : 'preview.jpg';
  return buildUrl(config, `wallpaper/${encodeURIComponent(id)}/${name}`);
}

/**
 * Steam 图片中转：images.steamusercontent.com 在国内路由极差（单张 13 秒+），
 * 浏览页给的还是全尺寸原图（约 900KB/张）。云端网络好，代拉一次缓存住，
 * 缩到指定宽度再回给浏览器，列表秒开。
 * @param {{url:string, token:string}} config
 * @param {string} sourceUrl Steam 图片原始地址
 * @param {number} [width] 目标宽度（服务端按宽等比缩小，webp 输出）
 * @returns {string} 未配置云端或源地址非 Steam 图床时返回空串
 */
export function cloudThumbUrl(config, sourceUrl, width = 512) {
  if (!isCloudReady(config)) return '';
  const source = String(sourceUrl || '');
  if (!/^https:\/\/([\w.-]*steamstatic\.com|[\w.-]*steamuserimages-a\.akamaihd\.net|images\.steamusercontent\.com)\//.test(source)) {
    return '';
  }
  return buildUrl(config, 'thumb', { u: source, w: width });
}

/**
 * 网页壁纸包内任意文件的直链（带 token）。
 * @param {{url:string, token:string}} config
 * @param {string} id
 * @param {string} path 包内相对路径（index.html / app.js / media/.../xxx.webm）
 * @returns {string}
 */
export function webAssetUrl(config, id, path) {
  if (!isCloudReady(config) || !id || !path) return '';
  const clean = String(path).replace(/^\/+/, '');
  return buildUrl(config, `wallpaper/${encodeURIComponent(id)}/web/${clean}`);
}

/**
 * 拉取网页壁纸的完整文件清单（云端遍历项目目录生成）。
 * @param {{url:string, token:string}} config
 * @param {string} id
 * @returns {Promise<string[]>} 失败/端点不存在时返回空数组
 */
export async function fetchWebFileList(config, id) {
  try {
    const data = await requestCloud(config, `wallpaper/${encodeURIComponent(id)}/web/files`, {
      timeout: 10000,
    });
    const files = data && (data.files || data.list || data);
    if (!Array.isArray(files)) return [];
    return files
      .map((row) => String(typeof row === 'string' ? row : row && row.path).replace(/^\/+/, ''))
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

/**
 * 发一个 API 请求并解析 JSON。
 * @param {{url:string, token:string}} config
 * @param {string} path 相对 /api 的路径
 * @param {{method?:string, timeout?:number, params?:object}} [options]
 * @returns {Promise<any>}
 */
export async function requestCloud(config, path, options = {}) {
  if (!config || !config.url) throw new Error('未配置云服务地址');
  const timeout = Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(buildUrl(config, path, options.params), {
      method: options.method || 'GET',
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : undefined,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
    }
    if (!response.ok) {
      const message = (data && (data.message || data.error)) || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    if (data === null) throw new Error('云服务返回的不是合法 JSON，请检查地址是否指向服务根路径');
    lastNetworkFailure = 0;
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      lastNetworkFailure = Date.now();
      throw new Error('云服务响应超时');
    }
    if (err instanceof TypeError) {
      // fetch 抛 TypeError = 请求没走出去（DNS / 拒连 / CORS 预检失败）
      lastNetworkFailure = Date.now();
      throw new Error('无法访问云服务：请检查地址、HTTPS 证书与服务端 CORS 配置');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 统一标签结构：服务端可能给 ["Anime"] 或 [{tag:"Anime"}]。 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => (typeof tag === 'string' ? tag : tag && tag.tag))
    .map((tag) => String(tag || '').trim())
    .filter(Boolean);
}

/**
 * 把服务端返回整理成稳定结构（字段缺失或被云端实现写成别的类型都不至于崩）。
 * @param {any} data
 * @param {string} [fallbackId]
 */
export function normalizeCloudRecord(data, fallbackId) {
  const raw = data && typeof data === 'object' ? data : {};
  const preview = raw.preview && typeof raw.preview === 'object' ? raw.preview : {};
  const video = raw.video && typeof raw.video === 'object' ? raw.video : null;
  const state = String(raw.state || '').toLowerCase();
  // 服务端偶发把网页入口误报成视频（video.file=index.html）——这种"视频"
  // 不能要，否则界面出现「完整视频 0.0MB」、背景引擎还会拿它当 mp4 播
  const videoLooksFake =
    !video || !Number(video.bytes) || /\.html?$/i.test(String(video.file || ''));
  return {
    id: String(raw.id || fallbackId || ''),
    state: state || 'unknown',
    title: String(raw.title || ''),
    type: String(raw.type || '').toLowerCase(),
    // 网页壁纸：服务端检测到项目根目录有 index.html 时置 true，直链 web/index.html 可用
    web: raw.web === true || String(raw.type || '').toLowerCase() === 'web',
    preview: {
      width: Number(preview.width) || 0,
      height: Number(preview.height) || 0,
      bytes: Number(preview.bytes) || 0,
    },
    video: video && !videoLooksFake
      ? {
          file: String(video.file || ''),
          bytes: Number(video.bytes) || 0,
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          duration: Number(video.duration) || 0,
        }
      : null,
    tags: normalizeTags(raw.tags),
    message: String(raw.message || ''),
    fetchedAt: Number(raw.fetchedAt) || 0,
  };
}

/** 健康检查：地址与 token 是否配对成功。 */
export async function cloudHealth(config) {
  return requestCloud(config, 'health', { timeout: 8000 });
}

/**
 * 查询某张壁纸的云端状态。首次查询会顺带触发服务端下载。
 * @param {{url:string, token:string}} config
 * @param {string} id
 * @param {{timeout?:number}} [options]
 * @returns {Promise<ReturnType<typeof normalizeCloudRecord>>}
 */
export async function fetchCloudWallpaper(config, id, options = {}) {
  const data = await requestCloud(config, `wallpaper/${encodeURIComponent(id)}`, {
    timeout: options.timeout,
  });
  return normalizeCloudRecord(data, id);
}

/** 显式触发下载（用户点「设为背景」时调用）。 */
export async function prepareCloudWallpaper(config, id) {
  const data = await requestCloud(config, `wallpaper/${encodeURIComponent(id)}/prepare`, {
    method: 'POST',
    params: {},
  });
  return normalizeCloudRecord(data, id);
}

/**
 * 云端库里已缓存的壁纸 id 集合（用于在工坊列表上打「云端」标记）。
 * 失败时返回 null，调用方静默跳过——这只是锦上添花，不该打断主流程。
 * @returns {Promise<Set<string>|null>}
 */
export async function fetchCloudLibraryIds(config, { page = 1, size = 200 } = {}) {
  if (!isCloudReady(config)) return null;
  try {
    const data = await requestCloud(config, 'library', { params: { page, size }, timeout: 10000 });
    // 兼容 {items:[...]} / {library:[...]} / 直接数组
    const list = Array.isArray(data) ? data : data && (data.items || data.library || data.data);
    if (!Array.isArray(list)) return null;
    const ids = new Set();
    list.forEach((entry) => {
      const id = typeof entry === 'string' || typeof entry === 'number' ? entry : entry && entry.id;
      if (id) ids.add(String(id));
    });
    return ids;
  } catch (err) {
    return null;
  }
}

/**
 * 轮询直到就绪或进入终态。
 * @param {{url:string, token:string}} config
 * @param {string} id
 * @param {{interval?:number, timeout?:number, shouldContinue?:() => boolean}} [options]
 * @returns {Promise<ReturnType<typeof normalizeCloudRecord>|null>} 主动中止时返回 null
 */
export async function waitCloudReady(config, id, options = {}) {
  const interval = Math.max(1500, Number(options.interval) || 3000);
  const deadline = Date.now() + (Number(options.timeout) || 180000);
  let last = null;
  while (Date.now() < deadline) {
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return null;
    // 第一次先等一个间隔：刚 prepare 完立刻查大概率还是 downloading，白跑一趟
    await sleep(interval);
    if (typeof options.shouldContinue === 'function' && !options.shouldContinue()) return null;
    try {
      last = await fetchCloudWallpaper(config, id);
    } catch (err) {
      continue;
    }
    if (last && TERMINAL_STATES.has(last.state)) return last;
  }
  return last;
}

/**
 * 带本地 TTL 缓存的元数据查询：ready 状态的记录（视频/网页标记）短期内不会变，
 * 每次打开新标签页都真请求接口纯属浪费——命中缓存零网络、毫秒返回。
 * 非 ready 状态不缓存（downloading→ready 需要尽快反映到界面）。
 */
export async function fetchCloudWallpaperCached(config, id, ttlMs = 6 * 3600 * 1000) {
  const key = `${config.url}|${id}`;
  const map = (await getRaw(STORAGE_KEYS.weCloudMeta).catch(() => null)) || {};
  const hit = map[key];
  if (hit && hit.data && Date.now() - (hit.at || 0) < ttlMs) {
    return normalizeCloudRecord(hit.data, id);
  }
  const record = await fetchCloudWallpaper(config, id);
  if (record && record.state === 'ready') {
    map[key] = { at: Date.now(), data: record };
    const keys = Object.keys(map);
    if (keys.length > 50) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const stale of keys.slice(0, keys.length - 50)) delete map[stale];
    }
    await setRaw(STORAGE_KEYS.weCloudMeta, map).catch(() => false);
  }
  return record;
}

/** 状态 → 可读文案（tone 供 UI 上色）。 */
export function describeCloudState(record) {
  const state = (record && record.state) || 'unknown';
  switch (state) {
    case 'ready':
      return { tone: 'ok', text: '云端已就绪' };
    case 'downloading':
      return { tone: 'busy', text: '云端正在从 Steam 下载' };
    case 'queued':
      return { tone: 'busy', text: '云端排队中' };
    case 'failed':
      return { tone: 'warn', text: record.message ? `云端下载失败：${record.message}` : '云端下载失败' };
    case 'need_auth':
      return { tone: 'warn', text: '该壁纸需要登录 Steam 账号才能下载' };
    case 'not_found':
      return { tone: 'warn', text: '云端找不到这个条目' };
    default:
      return { tone: 'muted', text: '云端尚无此壁纸' };
  }
}

/**
 * 云端记录的规格摘要，用来替代「Steam 侧 1024 压缩件」的说明。
 * @param {ReturnType<typeof normalizeCloudRecord>} record
 */
export function describeCloudMedia(record) {
  if (!record || record.state !== 'ready') return '';
  const parts = [];
  if (record.preview.width && record.preview.height) {
    parts.push(`云端原图 ${record.preview.width}×${record.preview.height}`);
  }
  if (record.video) {
    const size = record.video.width && record.video.height
      ? ` ${record.video.width}×${record.video.height}`
      : '';
    const mb = record.video.bytes ? ` · ${(record.video.bytes / 1048576).toFixed(1)}MB` : '';
    parts.push(`完整视频${size}${mb}`);
  }
  return parts.join(' · ');
}
