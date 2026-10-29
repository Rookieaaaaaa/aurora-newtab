/* 自检/修复页：读扩展状态 + 现场拉一次本地壁纸 iframe，检查播放模式，必要时修好 */
import { APP_VERSION } from './src/defaults.js';

const out = [];
const line = (text) => {
  out.push(text);
  document.getElementById('out').textContent = out.join('\n');
};
const ok = (t) => `[OK] ${t}`;
const bad = (t) => `[!!] ${t}`;

const KEY = 'guoman.desktop-companion.personal-v2';

(async () => {
  const manifestVersion = chrome.runtime.getManifest().version;
  line(`manifest ${manifestVersion} / APP_VERSION ${APP_VERSION}`);

  const store = await chrome.storage.local.get(['settings', 'weLocalWeb']);
  const bg = ((store.settings || {}).background) || {};
  const id = String(bg.weCloudItemId || bg.weItemId || '');
  line(`背景 type=${bg.type} id=${id || '(空)'}`);
  line(`weLocalWeb ${JSON.stringify(store.weLocalWeb || null)}`);

  for (const dir of ['assets/we-web', 'assets/wallpapers']) {
    const url = `${chrome.runtime.getURL(`${dir}/${id}/index.html`)}?v=${APP_VERSION}`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      line(`探测 ${dir} → ${r.ok ? ok(String(r.status)) : bad(String(r.status))}`);
    } catch (err) {
      line(`探测 ${dir} → ${bad('失败 ' + err.message)}`);
    }
  }

  // 现场加载一次，看壁纸自己的播放模式
  const url = `${chrome.runtime.getURL(`assets/we-web/${id}/index.html`)}?v=${APP_VERSION}`;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
  frame.style.cssText = 'width:640px;height:360px;position:fixed;right:16px;bottom:16px;border:1px solid #2a3a4d;opacity:.9';
  frame.src = url;
  document.body.append(frame);

  await new Promise((r) => setTimeout(r, 4500));

  let doc = null;
  try {
    doc = frame.contentDocument;
  } catch (err) {
    line(bad('拿不到 iframe 文档：' + err.message));
  }
  if (!doc) {
    line(bad('iframe 无内容（跨源或加载失败）'));
    return;
  }

  const video = doc.getElementById('film');
  let prefs = {};
  try {
    prefs = JSON.parse(doc.defaultView.localStorage.getItem(KEY) || '{}') || {};
  } catch (err) {
    line(bad('读 localStorage 失败：' + err.message));
  }
  const groupModes = prefs.wardrobeModes || {};
  const notSingle = Object.keys(groupModes).filter((k) => groupModes[k] !== 'single');

  line(`壁纸 body=${doc.body.className || '(空)'}`);
  line(`视频 paused=${video ? video.paused : '?'} t=${video ? video.currentTime.toFixed(1) : '?'}`);
  line(`playbackMode=${prefs.playbackMode} 组模式非single=${notSingle.length}`);

  if (prefs.playbackMode !== 'single' || notSingle.length) {
    prefs.playbackMode = 'single';
    prefs.wardrobeModes = {};
    try {
      doc.defaultView.localStorage.setItem(KEY, JSON.stringify(prefs));
      line(ok('已改成单套循环。请关掉这个自检页，重开一个新标签页。'));
    } catch (err) {
      line(bad('写入失败：' + err.message));
    }
  } else {
    line(ok('播放模式本来就是单套循环。'));
  }

  if (video && video.paused) {
    line(bad('视频是暂停状态——说明还在定格，把这段截图发我。'));
  } else if (video) {
    line(ok('视频正在播。'));
  }
})().catch((err) => line(bad('自检异常：' + (err && err.message))));
