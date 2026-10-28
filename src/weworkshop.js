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
  const response = await timedFetch(`https://steamcommunity.com/workshop/browse/?${params}`, BROWSE_TIMEOUT, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`创意工坊返回 HTTP ${response.status}`);
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

  // 宽松解析：凡指向 filedetails 的链接都算一个条目，按 id 去重，对改版更鲁棒
  const byId = new Map();
  for (const anchor of doc.querySelectorAll('a[href*="/sharedfiles/filedetails/?id="]')) {
    const matched = anchor.href.match(/[?&]id=(\d+)/);
    if (!matched) continue;
    const id = matched[1];
    if (byId.has(id)) continue;
    const card = anchor.closest('.workshopItemSubscription') || anchor.parentElement;
    const img = card ? card.querySelector('img') : null;
    let title = '';
    const titleEl = card ? card.querySelector('.workshopItemSubscriptionTitle') : null;
    if (titleEl) title = titleEl.textContent.trim();
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
      preview: (img && (img.dataset.src || img.src)) || '',
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
 * 从条目详情页抓预览素材：动态视频地址 + 原始预览图。
 *
 * 注意 Steam 已把详情页换成前端渲染（React）——首屏 HTML 里不再有
 * #previewImage / <video> / og:image，直接抓详情页只会拿到空壳。
 * 但带 insideModal=1（旧版快捷弹窗）的地址仍返回服务器渲染的旧标记，
 * 预览图就在其中；workshop/filedetails 作为第二入口兜底。
 * 预览图是 Steam 的方形裁切件（约 1024×1024），去掉 imw/imh/impolicy
 * 等压缩参数后取到的就是原图。（是否方形由调用方判断并做完整显示处理。）
 *
 * @param {string} id
 * @returns {Promise<{video:string|null, image:string|null}|null>} 失败返回 null，调用方自行降级
 */
export async function fetchPreviewAssets(id) {
  const endpoints = [
    `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}&insideModal=1`,
    `https://steamcommunity.com/workshop/filedetails/?id=${id}`,
    `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
  ];

  for (let i = 0; i < endpoints.length; i += 1) {
    try {
      // 带 Steam 会话：年龄门控的壁纸登录后才能拿到真实的视频与预览图
      const response = await timedFetch(endpoints[i], BROWSE_TIMEOUT, { credentials: 'include' });
      if (!response.ok) continue;
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');

      const videoEl = doc.querySelector('video');
      const video =
        ((videoEl && videoEl.querySelector('source[src]') && videoEl.querySelector('source[src]').src) ||
          (videoEl && videoEl.getAttribute('src')) ||
          null);

      let image = '';
      const mainImg = doc.querySelector(
        '#previewImage, img.workshopItemPreviewImageMain, img.workshopItemPreviewImageEnlargeable',
      );
      if (mainImg && mainImg.src) image = mainImg.src;
      if (!image && videoEl && videoEl.getAttribute('poster')) image = videoEl.getAttribute('poster');
      if (!image) {
        const og = doc.querySelector('meta[property="og:image"]');
        if (og) image = og.getAttribute('content') || '';
      }

      if (video || image) {
        return {
          video: video ? stripSteamImageParams(video) : null,
          image: image ? stripSteamImageParams(image) : null,
        };
      }
    } catch (err) {
      /* 换下一个入口 */
    }
  }
  return null;
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
  const response = await fetch(`https://steamcommunity.com/sharedfiles/${kind}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
  });
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
export async function resolveWeBackground(bg) {
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

  // v3 = insideModal 旧版页面抓取方案；老缓存（低清缩略图 / 抓取失败结果）自动失效重抓
  if (cache && cache.v === 3 && cache.date === today && cache.id === item.id) {
    return {
      image: stripSteamImageParams(cache.image || item.preview || ''),
      video: cache.video || null,
      item,
    };
  }

  // 抓视频 + 全尺寸截图（截图优先，视频分辨率不够时由背景引擎自适应取舍），
  // 结果当日缓存，避免反复请求
  const [assets, details] = await Promise.all([
    fetchPreviewAssets(item.id),
    fetchDetails([item.id]).catch(() => [null]),
  ]);
  const image =
    (assets && assets.image) ||
    (details[0] && details[0].preview_url) ||
    item.preview ||
    '';
  const video = (assets && assets.video) || null;
  await setRaw(STORAGE_KEYS.weCache, {
    v: 3,
    date: today,
    id: item.id,
    image: stripSteamImageParams(image),
    video: video || '',
  }).catch(() => false);
  if (!image && !video) throw new Error('工坊壁纸信息获取失败（网络或代理问题）');
  return { image: stripSteamImageParams(image), video, item };
}
