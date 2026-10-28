/**
 * defaults.js — 默认配置、默认引擎、默认站点与全局常量
 */

export const APP_NAME = 'Aurora New Tab';
export const APP_VERSION = '0.5.0';
export const SETTINGS_VERSION = 1;

/** 默认系统提示词（设置里留空时使用）。 */
export const DEFAULT_AI_PROMPT =
  '你是 Aurora 起始页内置的中文问答助手。回答要准确、简洁、结构清晰：先用一到两句话给出结论，再补充必要要点；可使用 Markdown 列表与代码块。不要编造事实，不确定时明确说明。';

/** 默认设置（storage key: settings）。 */
export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  background: {
    type: 'bing', // bing | wallhaven | static | video | gradient
    imageUrl: '',
    imageMediaId: '',
    videoUrl: '',
    videoMediaId: '',
    gradient: 'forest', // forest | aurora | dusk | mono
    particles: true,
    blur: 0,
    dim: 0.22,
    bingMkt: 'zh-CN',
    // wallhaven 壁纸库（境外服务，需要代理）
    wallhavenMode: 'daily', // daily（每日精选）| random（每次随机）| search（关键词搜索）
    wallhavenQuery: '',
    wallhavenCategories: '111', // 111 全部 | 100 风景人物 | 001 动漫
    // 壁纸库专用代理（host:port，如 127.0.0.1:7890）。留空 = 不接管浏览器代理；
    // 填写后仅 wallhaven 域名走该代理，其它网站直连
    wallhavenProxy: '',
    // 无代理时尝试公共中转（境外可达的 HTTPS 中转站）。关闭后仅直连/专用代理
    wallhavenRelay: true,
    // 自定义中转模板（可选，须含 {url} 占位符），例如自建 Cloudflare Worker：
    // https://my-relay.example.workers.dev/?url={url} —— 填了会排在公共中转之前
    wallhavenRelayUrl: '',
    // Wallpaper Engine 创意工坊（Steam 数据）：起始页背景 + 一键订阅/应用到桌面
    weMode: 'fixed', // fixed（固定一张）| daily（收藏每日轮换）
    weItemId: '',
    weTitle: '',
    weImage: '', // 起始页背景用：静态预览图地址
    weVideo: '', // 起始页背景用：动态视频地址（webm，有值时优先）
    // 本地壁纸库里该作者原图的媒体 id（有值时优先于 weImage —— Steam 只给 1024 压缩件）
    weLocalMediaId: '',
    weFit: 'cover', // cover（填满裁切）| contain（完整显示，等比缩放留边）
    // 应用到桌面：Steam 的 workshop/content/431960 目录（按 <目录>\<壁纸ID>\project.json 定位）
    weWorkshopPath: 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960',
    // 订阅成功后等待下载完成再自动发送应用命令
    weAutoApply: true,
    weApplyDelay: 20, // 秒，大壁纸可调大
  },
  clock: {
    hour12: false,
    showSeconds: false,
    showDate: true,
    showGreeting: true,
    showDockLabels: false,
  },
  search: {
    defaultEngine: 'ai-yuanbao',
    newTab: true,
    showEngineIcon: true,
  },
  ai: {
    provider: 'yuanbao', // yuanbao | deepseek | deepseek-search | custom
    stream: true,
    temperature: 0.6,
    systemPrompt: '',
    maxSources: 20,
    // 时效筛选：any | d7 | m1 | y1（当前由 DeepSeek 联网通过 after: 语法实现）
    searchFreshness: 'any',
    // 演示模式：未填写密钥时使用本地演示回答（不联网）。
    // 关闭后，未配置密钥会直接提示「去填写密钥」。开关必须真实有效。
    demoMode: true,
  },
  ui: {
    dockOpacity: 1,
    compact: false,
  },
};

/** 默认密钥配置（storage key: secrets，永不进入导出文件）。 */
export const DEFAULT_SECRETS = {
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    // 联网搜索开关：开启后「DeepSeek 联网」引擎走 /v1/tools/search（老数据缺字段按开启处理）
    webSearch: true,
    // 深度模式：off 仅检索 / normal 标准 / deep 精读前 3 篇正文
    searchDepth: 'normal',
  },
  yuanbao: {
    // mcp：JSON-RPC over Streamable HTTP；http：直连云 API SearchPro
    transport: 'http',
    endpoint: 'https://wsa.tencentcloudapi.com/',
    apiKey: '',
    // 鉴权方式：tc3 = 腾讯云云 API 签名（SecretId + SecretKey）；bearer = 网关 API Key
    // 留空时自动判定：填了 SecretId/SecretKey 走签名，否则走 Bearer
    authMode: 'tc3',
    // 密钥只在设置面板填写、存于本机 chrome.storage.local，代码内不内置任何凭证
    secretId: '',
    secretKey: '',
    service: 'wsa',
    action: 'SearchPro',
    version: '2025-05-08',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    tool: 'SearchPro',
    mode: 2, // 0 公开网页 / 1 权威垂信源 / 2 混合
    freshness: '', // d7 / m3 / y1，可空
    industry: '', // gov / news / acad / finance，可空
    llm: 'deepseek',
    extraArgs: '',
  },
  custom: {
    apiKey: '',
    baseUrl: '',
    model: '',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
  },
};

/** AI 引擎（提交后走 AI 面板）。 */
export const AI_ENGINES = [
  {
    id: 'ai-yuanbao',
    name: '元宝 AI 搜索',
    group: 'ai',
    provider: 'yuanbao',
    icon: 'sparkles',
    badge: '默认',
  },
  {
    id: 'ai-deepseek',
    name: 'DeepSeek',
    group: 'ai',
    provider: 'deepseek',
    icon: 'sparkles',
  },
  {
    id: 'ai-deepseek-web',
    name: 'DeepSeek 联网',
    group: 'ai',
    provider: 'deepseek-search',
    icon: 'sparkles',
  },
  {
    id: 'ai-custom',
    name: '自定义模型',
    group: 'ai',
    provider: 'custom',
    icon: 'sparkles',
  },
];

/** 传统搜索引擎（直接跳转）。 */
export const WEB_ENGINES = [
  { id: 'bing', name: '必应', group: 'web', icon: 'globe', url: 'https://www.bing.com/search?q=' },
  { id: 'google', name: '谷歌', group: 'web', icon: 'globe', url: 'https://www.google.com/search?q=' },
  { id: 'baidu', name: '百度', group: 'web', icon: 'globe', url: 'https://www.baidu.com/s?wd=' },
  { id: 'ddg', name: 'DuckDuckGo', group: 'web', icon: 'globe', url: 'https://duckduckgo.com/?q=' },
  {
    id: 'zhihu',
    name: '知乎',
    group: 'web',
    icon: 'globe',
    url: 'https://www.zhihu.com/search?type=content&q=',
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    group: 'web',
    icon: 'globe',
    url: 'https://search.bilibili.com/all?keyword=',
  },
  { id: 'github', name: 'GitHub', group: 'web', icon: 'globe', url: 'https://github.com/search?q=' },
];

/** 全部引擎（顺序即下拉顺序）。 */
export const ENGINES = AI_ENGINES.concat(WEB_ENGINES);

/** 按 id 查找引擎。 */
export function findEngine(engineId) {
  return ENGINES.find((engine) => engine.id === engineId) || AI_ENGINES[0];
}

/** bang 指令 → 引擎 id。 */
export const BANGS = {
  '!b': 'bing',
  '!g': 'google',
  '!d': 'ai-deepseek',
  '!ds': 'ai-deepseek-web',
  '!y': 'ai-yuanbao',
  '!gh': 'github',
};

/** bang 提示文案。 */
export const BANG_HINTS = [
  { cmd: '!b', desc: '必应' },
  { cmd: '!g', desc: '谷歌' },
  { cmd: '!d', desc: 'DeepSeek' },
  { cmd: '!ds', desc: 'DeepSeek 联网' },
  { cmd: '!y', desc: '元宝 AI' },
  { cmd: '!gh', desc: 'GitHub' },
];

/** 四套渐变主题（colors: 深-中-亮-深 五档，glow/beam 用于高光与光束）。 */
export const GRADIENTS = {
  forest: {
    name: '森林晨雾',
    colors: ['#06120c', '#123c28', '#357a4e', '#b3cf93', '#040d08'],
    glow: '#f2edc2',
    beam: '#f4f2d2',
  },
  aurora: {
    name: '极光',
    colors: ['#04091a', '#10306e', '#1f8fb8', '#5ef0d0', '#050a18'],
    glow: '#8ef7dd',
    beam: '#a08bff',
  },
  dusk: {
    name: '暮色',
    colors: ['#170a26', '#43205e', '#a8446a', '#ffb27a', '#150820'],
    glow: '#ffc079',
    beam: '#ff9f7a',
  },
  mono: {
    name: '静夜',
    colors: ['#0a0d12', '#242b35', '#48535f', '#8b98a8', '#090c11'],
    glow: '#b9c8da',
    beam: '#dfe9f5',
  },
};

/** 默认 12 个常用站点。 */
export const DEFAULT_SITES = [
  { id: 'site-google', title: 'Google', url: 'https://www.google.com', icon: { type: 'auto', value: '' } },
  { id: 'site-github', title: 'GitHub', url: 'https://github.com', icon: { type: 'auto', value: '' } },
  {
    id: 'site-bilibili',
    title: '哔哩哔哩',
    url: 'https://www.bilibili.com',
    icon: { type: 'auto', value: '' },
  },
  { id: 'site-zhihu', title: '知乎', url: 'https://www.zhihu.com', icon: { type: 'auto', value: '' } },
  { id: 'site-weibo', title: '微博', url: 'https://weibo.com', icon: { type: 'auto', value: '' } },
  { id: 'site-taobao', title: '淘宝', url: 'https://www.taobao.com', icon: { type: 'auto', value: '' } },
  { id: 'site-jd', title: '京东', url: 'https://www.jd.com', icon: { type: 'auto', value: '' } },
  { id: 'site-douban', title: '豆瓣', url: 'https://www.douban.com', icon: { type: 'auto', value: '' } },
  {
    id: 'site-netease-music',
    title: '网易云音乐',
    url: 'https://music.163.com',
    icon: { type: 'auto', value: '' },
  },
  { id: 'site-youtube', title: 'YouTube', url: 'https://www.youtube.com', icon: { type: 'auto', value: '' } },
  {
    id: 'site-xiaohongshu',
    title: '小红书',
    url: 'https://www.xiaohongshu.com',
    icon: { type: 'auto', value: '' },
  },
  {
    id: 'site-chatgpt',
    title: 'ChatGPT',
    url: 'https://chat.openai.com',
    icon: { type: 'auto', value: '' },
  },
];

/** 问候语分段（按小时）。 */
export const GREETINGS = [
  { from: 0, text: '凌晨好' },
  { from: 5, text: '早上好' },
  { from: 8, text: '上午好' },
  { from: 11, text: '中午好' },
  { from: 13, text: '下午好' },
  { from: 18, text: '晚上好' },
];

/** 按小时返回问候语。 */
export function greetingAt(hour) {
  let text = GREETINGS[0].text;
  for (let i = 0; i < GREETINGS.length; i += 1) {
    if (hour >= GREETINGS[i].from) text = GREETINGS[i].text;
  }
  return text;
}

/** 存储 key 常量。 */
export const STORAGE_KEYS = {
  settings: 'settings',
  secrets: 'secrets',
  sites: 'sites',
  bingCache: 'bingCache',
  wallhavenCache: 'wallhavenCache',
  wallhavenLast: 'wallhavenLast',
  weLibrary: 'weLibrary', // WE 工坊：每日轮换收藏池
  weCache: 'weCache', // WE 工坊：当日轮换结果缓存
};

/** Bing 壁纸接口。 */
export const BING_API = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=';

/** wallhaven 壁纸库接口（免密钥）。 */
export const WALLHAVEN_API = 'https://wallhaven.cc/api/v1/search';

/** 内置精选壁纸包（断网/无代理的最后兜底，来源见 assets/wallpapers/CREDITS.md）。 */
export const BUNDLED_WALLPAPERS = [
  'w01.jpg', 'w02.jpg', 'w03.jpg', 'w04.jpg', 'w05.jpg',
  'w06.jpg', 'w07.jpg', 'w08.jpg', 'w09.jpg', 'w10.jpg',
];

/** 内置壁纸相对路径（newtab.html 同级，扩展与本地预览都适用）。任意整数安全取模。 */
export function bundledWallpaperUrl(index) {
  const total = BUNDLED_WALLPAPERS.length;
  const n = Number(index);
  const i = Number.isFinite(n) ? ((Math.trunc(n) % total) + total) % total : 0;
  return `assets/wallpapers/${BUNDLED_WALLPAPERS[i]}`;
}

/**
 * 公共中转站：wallhaven 直连失败时的网络兜底（免费公共服务，可用性随缘；
 * wsrv.nl 等图片代理按政策封锁 wallhaven 域名，不可用）。自定义中转见 buildCustomRelayUrl。
 */
export const WALLHAVEN_RELAYS = {
  json: [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ],
  image: [(url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`],
};

/**
 * 用自定义模板生成中转地址。模板须含 {url} 占位符（会被 URL 编码替换）。
 * 非法模板（缺占位符 / 非本扩展可访问的 http(s) 地址）返回 null。
 * @param {string} template 如 https://my-relay.example.workers.dev/?url={url}
 * @param {string} target 目标地址
 * @returns {string|null}
 */
export function buildCustomRelayUrl(template, target) {
  const tpl = String(template || '').trim();
  if (!tpl.includes('{url}')) return null;
  const head = tpl.slice(0, tpl.indexOf('{url}'));
  try {
    const parsed = new URL(head);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch (err) {
    return null;
  }
  return tpl.replace('{url}', encodeURIComponent(String(target || '')));
}

/** wallhaven 分类选项（与设置面板下拉一致）。 */
export const WALLHAVEN_CATEGORIES = [
  { value: '111', label: '全部' },
  { value: '100', label: '风景人物' },
  { value: '001', label: '动漫' },
];

/**
 * 构造 wallhaven 搜索 URL（纯函数，便于测试）。
 * @param {{q?:string, categories?:string, sorting?:string, page?:number, seed?:string, topRange?:string}} params
 * @returns {string}
 */
export function buildWallhavenUrl(params = {}) {
  const url = new URL(WALLHAVEN_API);
  // 全部锁定 SFW（purity=100），免密钥接口本身也只能拿到 SFW
  url.searchParams.set('purity', '100');
  url.searchParams.set('ratios', 'landscape');
  // 最低分辨率：由调用方按屏幕 DPR 决定（高分屏要更大的原图才清晰）
  url.searchParams.set('atleast', String(params.atleast || '1920x1080'));
  const q = String(params.q || '').trim();
  if (q) url.searchParams.set('q', q);
  const categories = String(params.categories || '111');
  if (categories !== '111' && /^[0-1]{3}$/.test(categories)) {
    url.searchParams.set('categories', categories);
  }
  const sorting = String(params.sorting || '');
  if (sorting) url.searchParams.set('sorting', sorting);
  const topRange = String(params.topRange || '');
  if (topRange && sorting === 'toplist') url.searchParams.set('topRange', topRange);
  const seed = String(params.seed || '');
  if (seed) url.searchParams.set('seed', seed);
  const page = Number(params.page);
  if (Number.isFinite(page) && page > 1) url.searchParams.set('page', String(Math.trunc(page)));
  return url.toString();
}

/**
 * 归一化壁纸库代理地址：去掉协议前缀与尾部斜杠，只留 host:port。
 * 非法输入返回空串（视为关闭）。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeProxyAddr(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  value = value.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[\w.-]+:\d+$/.test(value)) return '';
  return value;
}

/**
 * 生成壁纸素材专用 PAC 脚本：wallhaven 与 Steam（创意工坊）域名走指定代理，其余直连
 * （纯函数，便于测试）。
 *
 * 为什么必须包含 Steam：chrome.proxy 设置的是浏览器级 PAC，会覆盖系统代理。
 * 早先只放行 wallhaven.cc，导致开了专用代理后 Steam 反而被强制直连，
 * 创意工坊就会报「网络异常 / 跨域」。这里把工坊相关域名一并纳入。
 *
 * 域名覆盖：
 * - wallhaven.cc：壁纸库
 * - steamcommunity.com：工坊浏览页 / 详情页 / 订阅接口
 * - steampowered.com：api.steampowered.com 详情接口
 * - steamstatic.com：cdn/shared/community/video.akamai.steamstatic.com 静态素材
 * - steamusercontent.com：images.steamusercontent.com 预览图
 * @param {string} addr 已归一化的 host:port
 * @returns {string}
 */
export function buildWallhavenPac(addr) {
  const target = normalizeProxyAddr(addr);
  if (!target) return '';
  return [
    'function FindProxyForURL(url, host) {',
    '  if (dnsDomainIs(host, "wallhaven.cc")) {',
    `    return "PROXY ${target}";`,
    '  }',
    '  if (dnsDomainIs(host, "steamcommunity.com") || dnsDomainIs(host, "steampowered.com")',
    '      || dnsDomainIs(host, "steamstatic.com") || dnsDomainIs(host, "steamusercontent.com")) {',
    `    return "PROXY ${target}";`,
    '  }',
    '  return "DIRECT";',
    '}',
  ].join('\n');
}
