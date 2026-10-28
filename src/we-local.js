/**
 * we-local.js — 本地 Wallpaper Engine 壁纸库
 *
 * 为什么需要它：
 * Steam 只给工坊条目两级预览素材——静态件 1024×1024 JPEG、视频件约 192×192 GIF，
 * 这是 Steam 侧的硬上限，无论换什么接口都拿不到更大/更完整的。
 *
 * 但用户订阅过的壁纸其实已经躺在本地：
 *   <Steam库>\steamapps\workshop\content\431960\<壁纸ID>\
 *     preview.jpg    作者上传的原始预览（实测 524~1431px，普遍比自己从 Steam 拿的大）
 *     project.json   类型 / 标题 / 标签（含真实类型 scene|video|web）
 *     <视频>.mp4     视频壁纸的完整成片（1080p/2K，几十到几百 MB）
 *     scene.pkg      场景壁纸的打包文件（浏览器无法渲染，只能取 preview）
 *
 * 用 File System Access API 读这个目录，把 preview.jpg 复制进扩展的媒体库
 * （IndexedDB），之后背景 / 详情 / 列表拿到的都是作者原图，不再受 1024 限制。
 * mp4 动辄上百 MB，不复制，只在索引里记文件名，需要时再按权限现读。
 */

import { deleteMedia, getMedia, saveMedia, getRaw, setRaw } from './storage.js';

/** 索引存放在通用存储里（体积小、需要同步读）。 */
export const WE_LOCAL_KEY = 'weLocalLibrary';

/** 视频类壁纸的媒体扩展名。 */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

/** 空索引。 */
function emptyIndex() {
  return { items: {}, scannedAt: 0, dirName: '', count: 0 };
}

/**
 * 读取本地库索引。
 * @returns {Promise<{items:Object<string,object>, scannedAt:number, dirName:string, count:number}>}
 */
export async function loadLocalLibrary() {
  const raw = await getRaw(WE_LOCAL_KEY).catch(() => null);
  if (!raw || typeof raw !== 'object' || !raw.items || typeof raw.items !== 'object') {
    return emptyIndex();
  }
  return {
    items: raw.items,
    scannedAt: Number(raw.scannedAt) || 0,
    dirName: String(raw.dirName || ''),
    count: Number(raw.count) || Object.keys(raw.items).length,
  };
}

/** 取单张本地壁纸的索引项。 */
export async function getLocalWallpaper(id) {
  if (!id) return null;
  const library = await loadLocalLibrary();
  return library.items[String(id)] || null;
}

/**
 * 取本地预览图的 Blob 地址。
 * 调用方负责在合适时机 URL.revokeObjectURL。
 * @param {string} id 壁纸 ID
 * @returns {Promise<string>} 拿不到返回空串
 */
export async function getLocalPreviewUrl(id) {
  const entry = await getLocalWallpaper(id);
  if (!entry || !entry.mediaId) return '';
  try {
    const media = await getMedia(entry.mediaId);
    if (!media || !media.blob) return '';
    return URL.createObjectURL(media.blob);
  } catch (err) {
    return '';
  }
}

/** 读一个目录下的 project.json（缺失或损坏都返回空对象）。 */
async function readProject(dir) {
  try {
    const handle = await dir.getFileHandle('project.json');
    const text = await (await handle.getFile()).text();
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** 找 preview.jpg；WE 固定用这个名字，缺失时退而求其次找任意图片。 */
async function readPreview(dir) {
  try {
    const handle = await dir.getFileHandle('preview.jpg');
    return { file: await handle.getFile(), name: 'preview.jpg' };
  } catch (err) {
    /* 继续找其他图片 */
  }
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && /\.(jpe?g|png|webp)$/i.test(name)) {
        return { file: await handle.getFile(), name };
      }
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/** 找视频成片：优先 project.json 的 file 字段，其次按扩展名扫一遍。 */
async function findVideoName(dir, project) {
  const declared = project && typeof project.file === 'string' ? project.file.trim() : '';
  if (declared && VIDEO_EXT.test(declared)) return declared;
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && VIDEO_EXT.test(name)) return name;
    }
  } catch (err) {
    /* ignore */
  }
  return '';
}

/** 读取单个壁纸条目。没有可用预览图就返回 null。 */
async function readOne(id, dir) {
  const preview = await readPreview(dir);
  if (!preview) return null;

  const project = await readProject(dir);
  const video = await findVideoName(dir, project);

  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(preview.file);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch (err) {
    /* 量不出尺寸不影响使用 */
  }

  // 复制进媒体库：之后无论文件权限是否还在，都能拿到这张原图
  const media = await saveMedia(preview.file, `${id}-${preview.name}`);

  return {
    id,
    mediaId: media.id,
    title: String(project.title || id),
    // WE 的 project.json 里大小写不统一（有 scene / Scene、video / Video）
    type: String(project.type || '').toLowerCase(),
    width,
    height,
    bytes: preview.file.size,
    video: video || '',
    tags: Array.isArray(project.tags)
      ? project.tags
          .map((tag) => (typeof tag === 'string' ? tag : tag && tag.tag))
          .filter(Boolean)
      : [],
  };
}

/**
 * 让用户选 WE 工坊目录并扫描入库。
 *
 * 目录结构必须是 .../steamapps/workshop/content/431960，里面每个子目录名就是壁纸 ID。
 *
 * @param {(progress:{done:number,total:number,id:string})=>void} [onProgress]
 * @returns {Promise<{items:Object, scannedAt:number, dirName:string, count:number}>}
 */
export async function scanLocalLibrary(onProgress) {
  if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
    throw new Error('当前浏览器不支持读取本地文件夹，请用 Chrome 打开扩展页面再试');
  }

  let root;
  try {
    root = await window.showDirectoryPicker({ id: 'aurora-we-workshop', mode: 'read' });
  } catch (err) {
    // 用户取消不算错误，直接抛出由调用方静默处理
    if (err && err.name === 'AbortError') throw err;
    throw new Error('无法打开文件夹选择器，请确认浏览器已授权');
  }

  return scanDirectory(root, onProgress);
}

/**
 * 扫描一个目录句柄并入库。
 *
 * 与 showDirectoryPicker 返回的对象同契约（name / entries / getFileHandle），
 * 单独拆出来既方便测试注入构造的句柄，也让「选目录」和「读目录」职责分开。
 *
 * @param {FileSystemDirectoryHandle|{name:string,entries:Function}} root
 * @param {(progress:{done:number,total:number,id:string})=>void} [onProgress]
 */
export async function scanDirectory(root, onProgress) {
  if (!root || typeof root.entries !== 'function') {
    throw new Error('目录句柄无效');
  }

  const dirs = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind === 'directory' && /^\d+$/.test(name)) dirs.push({ id: name, handle });
  }
  if (!dirs.length) {
    throw new Error('这个目录里没有壁纸，请选到 ...\\steamapps\\workshop\\content\\431960 这一层');
  }

  // 重扫前清掉旧媒体，避免 IndexedDB 里留着已经不在库中的图
  const previous = await loadLocalLibrary();
  await Promise.all(
    Object.values(previous.items).map((item) => deleteMedia(item.mediaId).catch(() => false)),
  );

  const items = {};
  let done = 0;
  for (const { id, handle } of dirs) {
    done += 1;
    if (typeof onProgress === 'function') onProgress({ done, total: dirs.length, id });
    try {
      const entry = await readOne(id, handle);
      if (entry) items[id] = entry;
    } catch (err) {
      /* 单个条目坏了就跳过，不影响整批 */
    }
  }

  const index = {
    items,
    scannedAt: Date.now(),
    dirName: root.name || '431960',
    count: Object.keys(items).length,
  };
  await setRaw(WE_LOCAL_KEY, index);
  return index;
}

/** 清空本地库（连同缓存的预览图）。 */
export async function clearLocalLibrary() {
  const previous = await loadLocalLibrary();
  await Promise.all(
    Object.values(previous.items).map((item) => deleteMedia(item.mediaId).catch(() => false)),
  );
  await setRaw(WE_LOCAL_KEY, emptyIndex());
  return emptyIndex();
}

/** 统计：总数 / 各类型数量 / 视频数，给设置面板显示。 */
export function summarizeLibrary(library) {
  const items = Object.values((library && library.items) || {});
  const summary = { total: items.length, video: 0, scene: 0, web: 0, other: 0, maxWidth: 0, hasVideoFile: 0 };
  for (const item of items) {
    if (item.type === 'video') summary.video += 1;
    else if (item.type === 'scene') summary.scene += 1;
    else if (item.type === 'web') summary.web += 1;
    else summary.other += 1;
    if (item.video) summary.hasVideoFile += 1;
    if (item.width > summary.maxWidth) summary.maxWidth = item.width;
  }
  return summary;
}

/**
 * 背景引擎用：按本地库里的媒体 id 取原图，产出与 resolveWeBackground 同形的记录。
 *
 * 返回的 image 是 blob 地址，调用方用完需要 URL.revokeObjectURL。
 *
 * @param {{weLocalMediaId?:string, weItemId?:string, weTitle?:string}} bg
 * @returns {Promise<{image:string, video:null, item:object}|null>}
 */
export async function resolveLocalWeBackground(bg) {
  const mediaId = bg && bg.weLocalMediaId;
  if (!mediaId) return null;
  try {
    const media = await getMedia(mediaId);
    if (!media || !media.blob) return null;
    return {
      image: URL.createObjectURL(media.blob),
      video: null,
      item: { id: String(bg.weItemId || ''), title: String(bg.weTitle || ''), local: true },
    };
  } catch (err) {
    return null;
  }
}
