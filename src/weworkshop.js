/**
 * weworkshop.js — Wallpaper Engine 创意工坊源（Steam 数据）
 * 职责：
 * 1) browseWorkshop：浏览/搜索创意工坊。解析 workshop browse 网页，结果与官网一致
 *    （含条目总数；无密钥的 QueryFiles 接口已被 Steam 下线，网页是唯一公开入口）；
 * 2) fetchDetails / fetchPreviewAssets：条目详情与预览素材（视频 + 全尺寸截图）；
 * 3) getSteamSession / subscribeItem / unsubscribeItem / buildApplySteamUrl：
 *    用浏览器里已登录的 Steam 会话一键订阅，并生成让 Wallpaper Engine 立即应用壁纸的
 *    steam:// 控制链接（wallpaper32.exe -control openWallpaper，经 steam://rungameid 附加参数）；
 * 4) 起始页背景解析：resolveWeBackground 按「固定一张 / 收藏每日轮换」给出图片或动态视频地址，
 *    轮换结果当日缓存（storage key: weCache），收藏列表存 weLibrary。
 */

import { STORAGE_KEYS } from './defaults.js';
import { getRaw, setRaw } from './storage.js';
import { cloudAssetUrl, cloudIsCoolingDown, fetchCloudWallpaper } from './we-cloud.js';

export const WE_APPID = 431960;

const BROWSE_TIMEOUT = 12000;
const API_TIMEOUT = 10000;

/** 排序选项（网页端 browsesort 参数）。 */
export const WE_SORTS = [
  { value: 'trending', label: '热门' },
  { value: 'recent', label: '最新' },
  { value: 'subscribed', label: '最多订阅' },
];

/** 分类标签（UI 中文 → Steam 工坊英文 tag）。 */
export const WE_TAGS = [
  { value: '', label: '全部分类' },
  { value: 'Anime', label: '动漫' },
  { value: 'Cyberpunk', label: '赛博朋克' },
  { value: 'Nature', label: '自然风景' },
  { value: 'Sci-Fi', label: '科幻' },
  { value: 'Game', label: '游戏' },
  { value: 'Abstract', label: '抽象' },
  { value: 'Aesthetic', label: '唯美' },
  { value: 'Fantasy', label: '幻想' },
  { value: 'Space', label: '太空' },
  { value: 'Cityscape', label: '城市' },
  { value: 'Animal', label: '动物' },
  { value: 'Girls', label: '少女' },
  { value: 'Machinery', label: '机械' },
  { value: 'Pixel', label: '像素' },
];

/** 是否处于扩展环境（非扩展预览时订阅/cookie 不可用，仅浏览可用）。 */
function inExtension() {
  try {
    return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

/** 带超时的 fetch。 */
function timedFetch(url, timeout, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * 网络层失败（fetch 直接抛错）时的可操作提示。
 * 浏览器预览没有扩展的跨域豁免，必然失败，要明确区分开，避免误导去改代理。
 */
function networkHint() {
  if (!inExtension()) {
    return '无法连接 Steam：普通浏览器预览会被跨域拦截，请把扩展加载到 Chrome（chrome://extensions）后再试';
  }
  return '无法连接 Steam 创意工坊：请检查网络或代理（设置 → 壁纸库 → 专用代理，例如 127.0.0.1:7890），然后重试';
}

/* ---------------------------- 素材规格与标签解析 ---------------------------- */

/** 条目类型标签 → 内部类型（Wallpaper Engine 的工坊分类）。 */
const KIND_BY_TAG = { Video: 'video', Scene: 'scene', Web: 'web', Application: 'application' };

/** 特性标签（决定壁纸的玩法，展示在详情里）。 */
const FEATURE_TAGS = [
  'Audio responsive',
  'Puppet Warp',
  'Customizable',
  'Preset',
  'Interactive',
  'Audio',
];

/** 分级标签。 */
const MATURITY_TAGS = ['Everyone', 'Questionable', 'Mature'];

/** 纯噪声标签：没有信息量，不展示。 */
const NOISE_TAGS = new Set(['Wallpaper', 'Unspecified']);

/**
 * 把工坊标签解析成结构化画像。
 *
 * Wallpaper Engine 的作者上传时会勾选一组标准标签，其中就包含
 * 类型（Video/Scene/Web/Application）、原始分辨率（"3840 x 2160"、
 * "Ultrawide 2560 x 1080"）、特性（Audio responsive 等）与分级。
 * 这些是 Steam 唯一可靠暴露的素材规格——preview 图本身不含分辨率信息。
 *
 * @param {Array<{tag:string}|string>} tags
 * @returns {{kind:string, resolution:{width:number,height:number,label:string}|null,
 *            features:string[], maturity:string, styles:string[]}}
 */
export function parseWorkshopTags(tags) {
  const list = (Array.isArray(tags) ? tags : [])
    .map((tag) => (typeof tag === 'string' ? tag : tag && tag.tag))
    .filter(Boolean);

  let kind = '';
  let resolution = null;
  const features = [];
  let maturity = '';
  const styles = [];

  for (const tag of list) {
    if (KIND_BY_TAG[tag]) {
      if (!kind) kind = KIND_BY_TAG[tag];
      continue;
    }
    const dims = tag.match(/(\d{3,5})\s*[x×]\s*(\d{3,5})/);
    if (dims) {
      resolution = { width: Number(dims[1]), height: Number(dims[2]), label: tag };
      continue;
    }
    if (/^other resolution$/i.test(tag)) {
      resolution = { width: 0, height: 0, label: tag };
      continue;
    }
    if (FEATURE_TAGS.includes(tag)) {
      features.push(tag);
      continue;
    }
    if (MATURITY_TAGS.includes(tag)) {
      maturity = tag;
      continue;
    }
    if (NOISE_TAGS.has(tag)) continue;
    styles.push(tag);
  }

  return { kind, resolution, features, maturity, styles };
}

/** 类型的中文名。 */
export const KIND_LABELS = {
  video: '视频壁纸',
  scene: '3D 场景',
  web: '网页壁纸',
  application: '应用壁纸',
};

/**
 * 该壁纸在起始页里能被还原到什么程度。
 *
 * 起始页只有浏览器渲染能力，没有 Wallpaper Engine 运行时：能用的素材
 * 只有 Steam 提供的预览件。所以这里给的是「素材能力的上限」而不是猜测。
 *
 * @param {{kind:string}} profile
 * @param {{state:string, preview?:{width:number,height:number}, video?:object|null}} [cloud]
 *        云端已就绪的记录：有完整视频时起始页能直接播原片，能力比 Steam 预览高一档
 * @returns {{level:'full'|'preview'|'none', title:string, detail:string}}
 */
export function startPageCapability(profile, cloud) {
  const kind = (profile && profile.kind) || '';
  const cloudReady = Boolean(cloud && cloud.state === 'ready');
  const cloudVideo = Boolean(cloudReady && cloud.video);
  const cloudPreview = cloudReady && cloud.preview && cloud.preview.width && cloud.preview.height
    ? `${cloud.preview.width}×${cloud.preview.height}`
    : '';

  if (kind === 'web' || kind === 'application') {
    return {
      level: 'none',
      title: '无法在起始页展示',
      detail: '这类壁纸依赖 Wallpaper Engine 运行时，起始页只能显示它的预览图，壁纸本身不会运行。',
    };
  }
  if (kind === 'video') {
    if (cloudVideo) {
      return {
        level: 'full',
        title: '可完整动态播放',
        detail: '云端已提供完整视频，起始页会直接播放原片，动态效果不需要 Wallpaper Engine。',
      };
    }
    if (cloudPreview) {
      return {
        level: 'preview',
        title: '可展示清晰静态预览',
        detail: `云端已提供作者原图 ${cloudPreview}，起始页用它作静态背景；动态成片需在 Wallpaper Engine 中播放。`,
      };
    }
    return {
      level: 'preview',
      title: '可展示静态预览',
      detail: 'Steam 只提供低清动图和方形静态预览，起始页会用静态预览图铺满，动态效果需在 Wallpaper Engine 中查看。',
    };
  }
  if (kind === 'scene') {
    if (cloudPreview) {
      return {
        level: 'preview',
        title: '可展示清晰静态预览',
        detail: `3D 场景需 Wallpaper Engine 运行；云端已提供作者原图 ${cloudPreview}，起始页用它作静态背景。`,
      };
    }
    return {
      level: 'preview',
      title: '可展示静态预览',
      detail: '3D 场景需 Wallpaper Engine 运行，起始页会用预览图作静态背景。',
    };
  }
  return {
    level: 'full',
    title: '可在起始页展示',
    detail: cloudReady
      ? '起始页会用云端提供的作者原图铺满屏幕。'
      : '起始页会用 Steam 提供的预览图铺满屏幕。',
  };
}

/**
 * 生成指定尺寸的 Steam 图像地址。
 * CDN 的 imw/imh 必须配合 impolicy 才生效；方形预览按等比缩放不会产生黑边。
 * @param {string} url 原始地址（可带参数）
 * @param {number} size 目标边长（像素）
 */
export function steamThumbUrl(url, size) {
  const base = stripSteamImageParams(url);
  if (!base || !size) return base;
  const query = new URLSearchParams({
    ima: 'fit',
    impolicy: 'Letterbox',
    imcolor: '#000000',
    imw: String(size),
    imh: String(size),
    letterbox: 'true',
  });
  return `${base}?${query}`;
}

/** 探测结果缓存：同一张图在一个会话里只探一次。 */
const MEDIA_PROBE_CACHE = new Map();

/**
 * 探测预览素材的真实格式与像素尺寸。
 *
 * Steam 的 preview_url 指向的原图有两种：静态图（1024×1024 JPEG）和
 * 动态图（约 192×192 GIF）。光看 URL 分不出来，只能取回 blob 看类型，
 * GIF 直接读文件头拿尺寸，静态图用 createImageBitmap 解码。
 *
 * @param {string} url
 * @returns {Promise<{url:string, objectUrl:string, format:'gif'|'image'|'unknown', animated:boolean,
 *                    width:number, height:number, bytes:number}|null>}
 */
export async function probePreviewMedia(url) {
  const bare = stripSteamImageParams(url);
  if (!bare) return null;
  if (MEDIA_PROBE_CACHE.has(bare)) return MEDIA_PROBE_CACHE.get(bare);

  const task = (async () => {
    try {
      const response = await timedFetch(bare, BROWSE_TIMEOUT, { credentials: 'omit' });
      if (!response.ok) return null;
      const blob = await response.blob();
      const type = blob.type || '';
      let width = 0;
      let height = 0;
      if (type === 'image/gif') {
        const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
        width = head[6] | (head[7] << 8);
        height = head[8] | (head[9] << 8);
      } else if (type.startsWith('image/') && typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      }
      return {
        url: bare,
        // 已经下载过就不再让浏览器取第二遍：直接给 img 用这个本地地址
        objectUrl: typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : bare,
        format: type === 'image/gif' ? 'gif' : type.startsWith('image/') ? 'image' : 'unknown',
        animated: type === 'image/gif',
        width,
        height,
        bytes: blob.size,
      };
    } catch (err) {
      return null;
    }
  })();

  MEDIA_PROBE_CACHE.set(bare, task);
  return task;
}

/** 本地日期 key（轮换当日缓存用）。 */
function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

/** 年内第几天（轮换取模）。 */
function dayOfYear() {
  return Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
}

/* ------------------------------ 浏览 / 详情 ------------------------------ */

/**
 * 浏览创意工坊列表（与 Steam 官网浏览页一致，含总数）。
 * @param {{query?:string, sort?:'trending'|'recent'|'subscribed', tag?:string, page?:number, excludeMature?:boolean}} options
 * @returns {Promise<{items:Array<{id:string,title:string,preview:string}>, hasPrev:boolean, hasNext:boolean, total:number|null}>}
 */
export async function browseWorkshop(options = {}) {
  return browseViaWeb(options);
}

/** 方式一：解析 workshop browse 网页。 */
async function browseViaWeb({ query = '', sort = 'trending', tag = '', page = 1, excludeMature = true } = {}) {
  const params = new URLSearchParams({
    appid: String(WE_APPID),
    numperpage: '30',
    p: String(page),
  });
  if (query.trim()) {
    params.set('browsesort', 'textsearch');
    params.set('searchtext', query.trim());
  } else {
    const sorts = { trending: 'trendingscore', recent: 'mostrecent', subscribed: 'totaluniquesubscribers' };
    params.set('browsesort', sorts[sort] || 'trendingscore');
  }
  if (tag) params.set('requiredtags[0]', tag);
  // 年龄过滤：排除 Mature 标签后，列表里不再出现打不开的成人内容占位卡
  if (excludeMature) params.set('excludedtags[0]', 'Mature');

  // 带 Steam 会话：登录后列表与官网所见一致（含成人内容偏好与语言偏好）；
  // 未登录时没有登录 cookie，效果与匿名一致
  let response;
  try {
    response = await timedFetch(
      `https://steamcommunity.com/workshop/browse/?${params}`,
      BROWSE_TIMEOUT,
      { credentials: 'include' },
    );
  } catch (err) {
    throw new Error(networkHint());
  }
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Steam 提示请求过于频繁（429），请稍等一两分钟再试');
    }
    throw new Error(`创意工坊返回 HTTP ${response.status}`);
  }
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

  // 宽松解析：凡指向 filedetails 的链接都算一个条目，按 id 去重，对改版更鲁棒
  const byId = new Map();
  for (const anchor of doc.querySelectorAll('a[href*="/sharedfiles/filedetails/?id="]')) {
    const matched = anchor.href.match(/[?&]id=(\d+)/);
    if (!matched) continue;
    const id = matched[1];
    if (byId.has(id)) continue;
    const card = anchor.closest('.workshopItemSubscription') || anchor.parentElement;
    const img = anchor.querySelector('img') || (card ? card.querySelector('img') : null);
    // 新版浏览页的 class 名是构建哈希（每次发版都变），标题只稳定存在于 img 的 alt 上
    let title = img && img.alt ? img.alt.trim() : '';
    const titleEl = card ? card.querySelector('.workshopItemSubscriptionTitle') : null;
    if (!title && titleEl) title = titleEl.textContent.trim();
    if (!title && card) {
      for (const link of card.querySelectorAll('a')) {
        const text = link.textContent.trim();
        if (text) {
          title = text;
          break;
        }
      }
    }
    byId.set(id, {
      id,
      title: title || `壁纸 #${id}`,
      // 列表自带的地址是 imw=322 的灰边缩略图，放大必糊；统一换成 480 的净图
      preview: steamThumbUrl((img && (img.dataset.src || img.src)) || '', 480),
    });
  }

  // 翻页信息：新版页面翻页控件的 class 可能变化，解析不到时按「本页满 30 条」兜底，
  // 多点一页拿到空列表时再提示没有更多（下一页请求页码超出会返回空）
  let maxPage = page;
  let pagingFound = false;
  const paging = doc.querySelector('.workshopBrowsePagingControls');
  if (paging) {
    pagingFound = true;
    for (const link of paging.querySelectorAll('a[href*="p="]')) {
      const pm = link.href.match(/[?&]p=(\d+)/);
      if (pm) maxPage = Math.max(maxPage, Number(pm[1]));
    }
  }

  // 总数：优先分页信息元素，正文兜底；兼容中英文计数文本
  // （"2 929 228 entries matching filters" / "Showing 1-30 of 59 entries" / "共 59 个/条/张"）
  let total = null;
  const pagingInfo = doc.querySelector('.workshopBrowsePagingInfo');
  const totalSource = (pagingInfo ? pagingInfo.textContent : doc.body && doc.body.textContent) || '';
  const totalMatch = totalSource.match(
    /([\d][\d,.\u00a0\u202f\s]{0,15}?)\s*(?:entries matching filters|entries)|共\s*([\d][\d,.\u00a0\u202f\s]{0,15}?)\s*[个条张]/,
  );
  if (totalMatch) {
    const digits = (totalMatch[1] || totalMatch[2] || '').replace(/[^\d]/g, '');
    if (digits) total = Number(digits);
  }

  const perPage = Math.max(byId.size, 1);
  const hasNext = total
    ? page * perPage < total
    : pagingFound
      ? page < maxPage || byId.size >= 30
      : byId.size >= 30;

  return { items: [...byId.values()], hasPrev: page > 1, hasNext, total };
}

/**
 * 批量拉取条目详情。
 * @param {string[]} ids
 */
export async function fetchDetails(ids) {
  if (!ids.length) return [];
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, index) => body.append(`publishedfileids[${index}]`, id));
  const response = await timedFetch(
    'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    API_TIMEOUT,
    { method: 'POST', body, credentials: 'omit' },
  );
  if (!response.ok) throw new Error(`详情接口返回 HTTP ${response.status}`);
  const data = await response.json();
  return (data.response && data.response.publishedfiledetails) || [];
}

/**
 * 去掉 Steam 图像服务的压缩参数（imw/imh/impolicy 等），拿原始分辨率图。
 * steamstatic / steamuserimages 的 CDN 不带参数时返回原图。
 * @param {string} url
 * @returns {string}
 */
function stripSteamImageParams(url) {
  return String(url || '').replace(/\?.*$/, '');
}

/**
 * 取条目的预览素材（原图地址 + 条目详情）。
 *
 * 早先靠抓详情页 HTML 里的 #previewImage 拿图，但 Steam 已把详情页换成
 * React 前端渲染，旧标记只在 insideModal 的兼容片段里还留着，且该片段
 * 固定 bSkipVideos=true（永远没有视频），抓一次要试多个入口、极易触发 429。
 *
 * 实测结论：GetPublishedFileDetails 返回的 preview_url 去掉压缩参数后
 * 就是原图（静态件 1024×1024 JPEG、动态件约 192×192 GIF），已没有更高清
 * 的素材可用——所以这里直接走 API，一次请求拿到图与标签。
 *
 * @param {string} id
 * @returns {Promise<{video:null, image:string, detail:object|null}|null>} 拿不到图返回 null
 */
export async function fetchPreviewAssets(id) {
  try {
    const [detail] = await fetchDetails([String(id)]);
    const image = detail && detail.preview_url;
    if (!image) return null;
    return { video: null, image: stripSteamImageParams(image), detail: detail || null };
  } catch (err) {
    return null;
  }
}

/**
 * 兼容旧调用：只取动态视频地址。
 * @param {string} id
 * @returns {Promise<string|null>}
 */
export async function fetchPreviewVideo(id) {
  const assets = await fetchPreviewAssets(id);
  return assets ? assets.video : null;
}

/* ------------------------------ 订阅 / 应用桌面 ------------------------------ */

/**
 * 读取 steamcommunity.com 登录态与 sessionid（订阅接口需要）。
 * @returns {Promise<{loggedIn:boolean, sessionid:string}>}
 */
export async function getSteamSession() {
  if (!inExtension() || !chrome.cookies) return { loggedIn: false, sessionid: '' };
  const cookies = await chrome.cookies.getAll({ url: 'https://steamcommunity.com' });
  const sessionid = (cookies.find((cookie) => cookie.name === 'sessionid') || {}).value || '';
  const loggedIn = cookies.some(
    (cookie) => cookie.name === 'steamLoginSecure' || cookie.name === 'steamLogin',
  );
  return { loggedIn, sessionid };
}

async function postSubscriptionAction(id, kind) {
  const { loggedIn, sessionid } = await getSteamSession();
  if (!loggedIn) {
    const error = new Error('请先在浏览器登录 steamcommunity.com（订阅需要 Steam 登录态）');
    error.code = 'NO_LOGIN';
    throw error;
  }
  const body = new URLSearchParams({ appid: String(WE_APPID), id, sessionid });
  let response;
  try {
    response = await fetch(`https://steamcommunity.com/sharedfiles/${kind}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body.toString(),
    });
  } catch (err) {
    throw new Error(networkHint());
  }
  if (!response.ok) throw new Error(`${kind === 'subscribe' ? '订阅' : '退订'}接口返回 HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  if (data.success !== 1) throw new Error(data.error || '操作失败，请重试');
  return true;
}

/** 订阅创意工坊壁纸（成功后 Steam 客户端会自动下载）。 */
export function subscribeItem(id) {
  return postSubscriptionAction(id, 'subscribe');
}

/** 退订壁纸（换壁纸后顺手清理不用的）。 */
export function unsubscribeItem(id) {
  return postSubscriptionAction(id, 'unsubscribe');
}

/**
 * 生成「让 Wallpaper Engine 立即应用该壁纸」的 steam:// 控制链接。
 * WE 支持命令行控制 wallpaper32.exe -control openWallpaper <路径>，
 * 通过 steam://rungameid 附加参数即可把命令发给已运行的 WE。
 * @param {string} fileId 壁纸 publishedfileid
 * @param {string} workshopDir workshop/content/431960 目录
 * @returns {string}
 */
export function buildApplySteamUrl(fileId, workshopDir) {
  const dir = String(workshopDir || '').replace(/[\\/]+$/, '');
  const target = `${dir}\\${fileId}\\project.json`;
  return `steam://rungameid/${WE_APPID}/${encodeURIComponent(`-control openWallpaper "${target}"`)}`;
}

/* ------------------------------ 起始页背景 ------------------------------ */

/** 读取收藏列表（每日轮换池）。 */
export async function loadWeLibrary() {
  const record = await getRaw(STORAGE_KEYS.weLibrary).catch(() => null);
  return record && Array.isArray(record.items) ? record.items : [];
}

/** 覆盖写收藏列表。 */
export async function saveWeLibrary(items) {
  await setRaw(STORAGE_KEYS.weLibrary, { items });
}

/**
 * 按背景设置解析起始页要用的壁纸。
 * @param {object} bg settings.background
 * @returns {Promise<{image:string, video:string|null, item:object}>}
 *   video 有值时优先用动态视频作起始页背景，失败自然降级到 image（由调用方处理）。
 */
export async function resolveWeBackground(bg, cloud) {
  const mode = bg.weMode === 'daily' ? 'daily' : 'fixed';

  if (mode === 'fixed') {
    // 老数据里存的可能是带压缩参数的缩略图地址，去掉参数即原始分辨率
    const image = stripSteamImageParams(String(bg.weImage || '').trim());
    const video = String(bg.weVideo || '').trim();
    const item = { id: String(bg.weItemId || ''), title: String(bg.weTitle || '') };
    if (!image && !video) throw new Error('尚未选择工坊壁纸');
    return { image, video: video || null, item };
  }

  // daily：收藏池按年内第几天轮换，结果当日缓存（含视频/全尺寸截图）
  const library = await loadWeLibrary();
  if (!library.length) throw new Error('每日轮换需要先在工坊画廊里「加入轮换」');

  const today = localDateKey();
  const cache = await getRaw(STORAGE_KEYS.weCache).catch(() => null);
  const item = library[dayOfYear() % library.length];

  // 云端优先：这一张如果云端已有完整素材，直接用原片。
  // 也顺带解决「Steam 拿不到就整个失败」的问题——权重比预览清晰度更关键。
  if (cloud && cloud.url && !cloudIsCoolingDown()) {
    try {
      const record = await fetchCloudWallpaper(cloud, item.id, { timeout: 8000 });
      if (record && record.state === 'ready') {
        return {
          image: cloudAssetUrl(cloud, item.id, 'preview'),
          video: record.video ? cloudAssetUrl(cloud, item.id, 'video') : '',
          item: { ...item, cloud: true },
        };
      }
    } catch (err) {
      /* 云端不可用就继续走 Steam */
    }
  }

  // v4 = 直接取 API 原图（preview_url 去参数），不再抓详情页 HTML
  if (cache && cache.v === 4 && cache.date === today && cache.id === item.id) {
    return {
      image: stripSteamImageParams(cache.image || item.preview || ''),
      video: cache.video || null,
      item,
    };
  }

  // Steam 没有比 preview_url 原图更好的素材了：一次 API 请求即可，结果当日缓存
  const [detail] = await fetchDetails([item.id]).catch(() => [null]);
  const image = (detail && detail.preview_url) || item.preview || '';
  const video = null;
  await setRaw(STORAGE_KEYS.weCache, {
    v: 4,
    date: today,
    id: item.id,
    image: stripSteamImageParams(image),
    video: '',
  }).catch(() => false);
  if (!image && !video) throw new Error('工坊壁纸信息获取失败（网络或代理问题）');
  return { image: stripSteamImageParams(image), video, item };
}
