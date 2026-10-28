/**
 * wallhaven_probe.mjs — wallhaven 壁纸库源逻辑测试（Node，离线，stub fetch）
 *
 * 覆盖：
 *   - defaults.js    buildWallhavenUrl 参数拼装（purity 锁定 / 分类 / 页码 / topRange 依附 toplist）
 *   - wallhaven.js   fetchWallhavenList 归一化与错误映射（含代理提示文案）
 *                    resolveWallhaven 三种模式的选图行为（daily 当天稳定 / random 池内 / search 传参）
 *   - background.js  signatureOf 覆盖 wallhaven 字段（切换模式会触发重绘）
 *   - 模块可加载性    background.js / settings.js 在 Node 下完整解析（语法 + 链接检查）
 *
 * 用法：node tests/wallhaven_probe.mjs
 * 输出：JSON {cases:[{name,ok,detail}], fatal:""}
 */

let fatal = '';
const cases = [];

function check(name, fn) {
  try {
    const detail = fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    cases.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (err) {
    cases.push({ name, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} 期望 ${e}，实际 ${a}`);
  return a;
}

const SRC = new URL('../src/', import.meta.url);
const realFetch = globalThis.fetch;
let defaults;
let wallhaven;
let backgroundMod;
let proxyMod;

try {
  defaults = await import(new URL('defaults.js', SRC).href);
  wallhaven = await import(new URL('wallhaven.js', SRC).href);
  // 语法 + 模块链接检查（不实例化，不触 DOM）
  backgroundMod = await import(new URL('background.js', SRC).href);
  await import(new URL('settings.js', SRC).href);
  // main.js 顶层访问 document，Node 下执行必然失败；只要不是语法/链接错误即可
  try {
    await import(new URL('main.js', SRC).href);
  } catch (err) {
    if (!(err instanceof ReferenceError)) throw err;
  }
  proxyMod = await import(new URL('proxy.js', SRC).href);
} catch (err) {
  fatal = `模块加载失败：${err && err.message ? err.message : err}`;
}

const stubFetch = (handler) => {
  globalThis.fetch = handler;
};
const restoreFetch = () => {
  globalThis.fetch = realFetch;
};

/** 构造 n 条 wallhaven API 风格的原始数据（可注入脏数据）。 */
function makeRawItems(n, dirty) {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    path: `https://w.wallhaven.cc/full/w/wallhaven-w${i}.jpg`,
    url: `https://wallhaven.cc/w/w${i}`,
    thumbs: { large: `https://th.w.wallhaven.cc/w${i}.jpg`, small: `https://th.w.wallhaven.cc/s-w${i}.jpg` },
    resolution: '3840x2160',
    favorites: 500 - i,
  }));
  if (dirty) rows.push({ id: 'broken', resolution: '1x1' }); // 缺 path，应被丢弃
  return rows;
}

const jsonResponse = (payload) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });

/** 从直连或中转包裹的请求地址里还原 wallhaven API 原始 URL（Node/预览环境为中转优先）。 */
function extractApiUrl(requested) {
  const outer = new URL(String(requested));
  if (outer.hostname === 'wallhaven.cc') return outer;
  const inner = outer.searchParams.get('url') || outer.searchParams.get('quest');
  return new URL(inner);
}

if (!fatal) {
  /* ---------------- buildWallhavenUrl ---------------- */

  check('URL：默认参数锁定 SFW + 横屏 + 最低 1080p', () => {
    const url = new URL(defaults.buildWallhavenUrl({}));
    eq(url.searchParams.get('purity'), '100', 'purity');
    eq(url.searchParams.get('ratios'), 'landscape', 'ratios');
    eq(url.searchParams.get('atleast'), '1920x1080', 'atleast');
    eq(url.searchParams.get('q'), null, '无关键词时不应带 q');
    eq(url.searchParams.get('page'), null, '第 1 页不显式传参');
    return url.toString();
  });

  check('URL：关键词 / 分类 / 页码正确拼装', () => {
    const url = new URL(
      defaults.buildWallhavenUrl({ q: 'night city', categories: '001', page: 3 }),
    );
    eq(url.searchParams.get('q'), 'night city', 'q');
    eq(url.searchParams.get('categories'), '001', 'categories');
    eq(url.searchParams.get('page'), '3', 'page');
    return url.toString();
  });

  check('URL：topRange 只在 toplist 排序下生效', () => {
    const withList = new URL(defaults.buildWallhavenUrl({ sorting: 'toplist', topRange: '1M' }));
    eq(withList.searchParams.get('topRange'), '1M', 'toplist 带 topRange');
    const noList = new URL(defaults.buildWallhavenUrl({ sorting: 'date_added', topRange: '1M' }));
    eq(noList.searchParams.get('topRange'), null, '非 toplist 忽略 topRange');
    return 'ok';
  });

  check('URL：非法分类（老数据脏值）回落全部', () => {
    const url = new URL(defaults.buildWallhavenUrl({ categories: 'abc' }));
    eq(url.searchParams.get('categories'), null, '非法分类不传，接口默认 111');
    return 'ok';
  });

  /* ---------------- fetchWallhavenList ---------------- */

  await checkAsync('列表：字段归一化 + 脏数据丢弃 + 只取 24 条', async () => {
    let requested;
    stubFetch((input) => {
      requested = String(input);
      return jsonResponse({ data: makeRawItems(24, true), meta: { current_page: 1 } });
    });
    try {
      const { items } = await wallhaven.fetchWallhavenList({ q: 'forest' });
      eq(items.length, 24, '条数');
      eq(items[0].id, 'w0', 'id');
      eq(items[0].url, 'https://w.wallhaven.cc/full/w/wallhaven-w0.jpg', '原图地址');
      eq(items[0].thumb, 'https://th.w.wallhaven.cc/w0.jpg', '缩略图取 large');
      eq(items[0].favorites, 500, '收藏数');
      return requested;
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('列表：HTTP 错误映射', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    try {
      await wallhaven.fetchWallhavenList({});
      throw new Error('应当抛错');
    } catch (err) {
      if (!/HTTP 503/.test(err.message)) throw new Error(`文案不符：${err.message}`);
      return err.message;
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('列表：网络失败提示需要代理', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    try {
      await wallhaven.fetchWallhavenList({});
      throw new Error('应当抛错');
    } catch (err) {
      if (!/代理/.test(err.message)) throw new Error(`文案不符：${err.message}`);
      return err.message;
    } finally {
      restoreFetch();
    }
  });

  /* ---------------- resolveWallhaven ---------------- */

  await checkAsync('选图：daily 模式当天稳定（年内第几天取模）', async () => {
    stubFetch((input) => jsonResponse({ data: makeRawItems(24), meta: {} }));
    try {
      const first = await wallhaven.resolveWallhaven({ wallhavenMode: 'daily' });
      const second = await wallhaven.resolveWallhaven({ wallhavenMode: 'daily' });
      const dayOfYear = Math.floor(
        (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000,
      );
      const expected = `https://w.wallhaven.cc/full/w/wallhaven-w${dayOfYear % 24}.jpg`;
      eq(first.url, expected, '取模索引正确');
      eq(second.url, first.url, '两次结果一致（当天稳定）');
      return first.url;
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('选图：random 模式结果落在当日池内', async () => {
    stubFetch((input) => jsonResponse({ data: makeRawItems(24), meta: {} }));
    try {
      for (let i = 0; i < 8; i += 1) {
        const { url } = await wallhaven.resolveWallhaven({ wallhavenMode: 'random' });
        if (!/wallhaven-w\d+\.jpg$/.test(url) || Number(url.match(/w(\d+)\.jpg$/)[1]) > 23) {
          throw new Error(`越界结果：${url}`);
        }
      }
      return 'ok';
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('选图：search 模式按关键词走相关性排序', async () => {
    let requested;
    stubFetch((input) => {
      requested = String(input);
      return jsonResponse({ data: makeRawItems(24), meta: {} });
    });
    try {
      await wallhaven.resolveWallhaven({
        wallhavenMode: 'search',
        wallhavenQuery: 'mountain',
        wallhavenCategories: '001',
      });
      const url = extractApiUrl(requested);
      eq(url.searchParams.get('q'), 'mountain', 'q');
      eq(url.searchParams.get('sorting'), 'relevance', 'sorting');
      eq(url.searchParams.get('categories'), '001', 'categories');
      return requested.slice(0, 70);
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('选图：老数据缺 wallhaven 字段回落 daily + 月度热门', async () => {
    let requested;
    stubFetch((input) => {
      requested = String(input);
      return jsonResponse({ data: makeRawItems(24), meta: {} });
    });
    try {
      const { url } = await wallhaven.resolveWallhaven({});
      const reqUrl = extractApiUrl(requested);
      eq(reqUrl.searchParams.get('sorting'), 'toplist', '默认走热门榜');
      eq(reqUrl.searchParams.get('topRange'), '1M', '默认近一月');
      if (!/wallhaven-w\d+\.jpg$/.test(url)) throw new Error(`异常结果：${url}`);
      return 'ok';
    } finally {
      restoreFetch();
    }
  });

  /* ---------------- 专用代理 ---------------- */

  check('代理地址归一化：协议前缀 / 尾斜杠 / 非法值', () => {
    eq(defaults.normalizeProxyAddr('http://127.0.0.1:7890/'), '127.0.0.1:7890', '带协议与斜杠');
    eq(defaults.normalizeProxyAddr('127.0.0.1:7890'), '127.0.0.1:7890', '标准写法');
    eq(defaults.normalizeProxyAddr('  '), '', '空白');
    eq(defaults.normalizeProxyAddr('不是地址'), '', '非法输入视为关闭');
    eq(defaults.normalizeProxyAddr('127.0.0.1'), '', '缺端口视为非法');
    return 'ok';
  });

  check('PAC 脚本：仅 wallhaven 域名走代理，其余直连', () => {
    const pac = defaults.buildWallhavenPac('127.0.0.1:7890');
    if (!pac.includes('dnsDomainIs(host, "wallhaven.cc")')) throw new Error('缺少域名匹配');
    if (!pac.includes('"PROXY 127.0.0.1:7890"')) throw new Error('缺少代理指令');
    if (!pac.includes('"DIRECT"')) throw new Error('缺少直连兜底');
    eq(defaults.buildWallhavenPac('bad addr'), '', '非法地址返回空脚本');
    return 'ok';
  });

  check('proxy.js：无 chrome.proxy 的环境（Node/预览）安全跳过', () => {
    proxyMod.resetProxyStateForTest();
    proxyMod.syncWallhavenProxy('127.0.0.1:7890'); // 不应抛错
    proxyMod.syncWallhavenProxy(''); // 清理路径同样安全
    return 'ok';
  });

  await checkAsync('本地兜底：无存储环境返回 null（不抛错）', async () => {
    const last = await wallhaven.loadLastWallhaven();
    eq(last, null, '无 IndexedDB 存储时返回 null');
    return 'ok';
  });

  await checkAsync('blob 拉取：网络失败给出代理提示', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    try {
      await wallhaven.fetchWallhavenBlob('https://w.wallhaven.cc/full/x/y.jpg');
      throw new Error('应当抛错');
    } catch (err) {
      if (!/代理/.test(err.message)) throw new Error(`文案不符：${err.message}`);
      return err.message;
    } finally {
      restoreFetch();
    }
  });

  /* ---------------- 公共中转与内置包 ---------------- */

  check('中转 URL：公共中转正确包裹目标地址', () => {
    const target = 'https://wallhaven.cc/api/v1/search?sorting=toplist';
    const jsonUrls = defaults.WALLHAVEN_RELAYS.json.map((wrap) => wrap(target));
    if (!jsonUrls[0].includes('allorigins.win/raw?url=' + encodeURIComponent(target))) {
      throw new Error('allorigins 拼装不符');
    }
    if (jsonUrls.some((u) => u.includes('wsrv.nl'))) {
      throw new Error('wsrv 按政策封锁 wallhaven，不应出现在中转列表');
    }
    return 'ok';
  });

  check('自定义中转：模板校验与占位符替换', () => {
    const tpl = 'https://my-relay.workers.dev/?url={url}';
    const built = defaults.buildCustomRelayUrl(tpl, 'https://wallhaven.cc/api/v1/search?a=1&b=2');
    if (!built.startsWith('https://my-relay.workers.dev/?url=')) throw new Error('前缀不符');
    if (!built.includes(encodeURIComponent('https://wallhaven.cc/api/v1/search?a=1&b=2'))) {
      throw new Error('目标地址应被编码');
    }
    eq(defaults.buildCustomRelayUrl('https://x.dev/?q=1', 'https://y'), null, '缺占位符');
    eq(defaults.buildCustomRelayUrl('ftp://x.dev/{url}', 'https://y'), null, '非 http(s) 协议');
    eq(defaults.buildCustomRelayUrl('不是地址{url}', 'https://y'), null, '非法 URL');
    eq(defaults.buildCustomRelayUrl('', 'https://y'), null, '空模板');
    return 'ok';
  });

  await checkAsync('自定义中转优先：排在公共中转之前且能成功', async () => {
    const seen = [];
    stubFetch((input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('my-relay.workers.dev')) {
        return jsonResponse({ data: makeRawItems(24), meta: {} });
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    try {
      const { items } = await wallhaven.fetchWallhavenList({
        q: 'forest',
        relay: true,
        relayUrl: 'https://my-relay.workers.dev/?url={url}',
      });
      eq(items.length, 24, '自定义中转拿到数据');
      if (!seen[0].includes('my-relay.workers.dev')) throw new Error('自定义中转未优先（首请求是 ' + seen[0].slice(0, 50) + '）');
      return 'ok';
    } finally {
      restoreFetch();
    }
  });

  check('内置包：10 个文件齐全且按天取模', async () => {
    const { access } = await import('node:fs/promises');
    eq(defaults.BUNDLED_WALLPAPERS.length, 10, '内置张数');
    for (const name of defaults.BUNDLED_WALLPAPERS) {
      await access(new URL(`../assets/wallpapers/${name}`, import.meta.url));
    }
    eq(defaults.bundledWallpaperUrl(0), 'assets/wallpapers/w01.jpg', '第 0 天');
    eq(defaults.bundledWallpaperUrl(10), 'assets/wallpapers/w01.jpg', '第 10 天回到第 1 张');
    eq(defaults.bundledWallpaperUrl(-1), 'assets/wallpapers/w10.jpg', '负数安全取模');
    return 'ok';
  });

  await checkAsync('中转兜底：直连失败自动走公共中转拿数据', async () => {
    const seen = [];
    stubFetch((input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('wallhaven.cc/api')) {
        return Promise.reject(new TypeError('Failed to fetch')); // 直连失败
      }
      if (url.includes('allorigins.win')) {
        return jsonResponse({ data: makeRawItems(24), meta: {} }); // 中转成功
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    try {
      const { items } = await wallhaven.fetchWallhavenList({ q: 'forest', relay: true });
      eq(items.length, 24, '中转拿到 24 条');
      if (!seen.some((u) => u.includes('allorigins.win'))) throw new Error('没有尝试中转');
      return `尝试了 ${seen.length} 次请求`;
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('中转开关关闭：直连失败后不再尝试中转', async () => {
    const seen = [];
    stubFetch((input) => {
      seen.push(String(input));
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    try {
      await wallhaven.fetchWallhavenList({ relay: false });
      throw new Error('应当抛错');
    } catch (err) {
      if (seen.some((u) => u.includes('allorigins') || u.includes('wsrv') || u.includes('codetabs'))) {
        throw new Error('relay=false 时不应请求中转');
      }
      if (!/壁纸库连接失败/.test(err.message)) throw new Error(`文案不符：${err.message}`);
      return 'ok';
    } finally {
      restoreFetch();
    }
  });

  await checkAsync('图片中转：直连失败后依次尝试中转', async () => {
    const seen = [];
    stubFetch((input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('w.wallhaven.cc/full')) return Promise.reject(new TypeError('blocked'));
      if (url.includes('allorigins.win')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: () => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })),
        });
      }
      return Promise.reject(new TypeError('Failed to fetch'));
    });
    try {
      const blob = await wallhaven.fetchWallhavenBlob('https://w.wallhaven.cc/full/a/b.jpg', { relay: true });
      eq(blob.size, 1, '中转 blob 可用');
      if (!seen.some((u) => u.includes('allorigins.win'))) throw new Error('没有尝试图片中转');
      return 'ok';
    } finally {
      restoreFetch();
    }
  });

  check('内置包选图：按年内第几天稳定轮换', () => {
    const first = wallhaven.loadBundledWallhaven();
    const second = wallhaven.loadBundledWallhaven();
    if (first !== second) throw new Error('同一天结果应稳定');
    if (!/^assets\/wallpapers\/w\d{2}\.jpg$/.test(first)) throw new Error(`路径异常：${first}`);
    return first;
  });

  /* ---------------- background 签名 ---------------- */

  check('签名：wallhaven 模式/关键词变化会触发背景重绘', () => {
    const { BackgroundController } = backgroundMod;
    const base = { background: { type: 'wallhaven', wallhavenMode: 'daily', wallhavenQuery: '', wallhavenCategories: '111' } };
    const changedMode = { background: { ...base.background, wallhavenMode: 'random' } };
    const changedQuery = { background: { ...base.background, wallhavenQuery: 'lake' } };
    const changedCat = { background: { ...base.background, wallhavenCategories: '001' } };
    const s0 = BackgroundController.signatureOf(base);
    if (s0 === BackgroundController.signatureOf(changedMode)) throw new Error('模式变化未入签名');
    if (s0 === BackgroundController.signatureOf(changedQuery)) throw new Error('关键词变化未入签名');
    if (s0 === BackgroundController.signatureOf(changedCat)) throw new Error('分类变化未入签名');
    return 'ok';
  });
}

const failed = cases.filter((item) => !item.ok);
console.log(JSON.stringify({ cases, fatal }, null, 2));
process.exitCode = fatal || failed.length ? 1 : 0;
