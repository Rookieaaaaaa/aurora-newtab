/**
 * settings.js — 设置抽屉
 * 覆盖：外观 / 时钟 / 搜索 / AI 搜索（含密钥与测试连接）/ 常用网站 / 通用（导入导出、恢复默认）
 * 所有改动即时生效，输入类 debounce 200ms 持久化。
 */

import {
  AI_ENGINES,
  APP_VERSION,
  GRADIENTS,
  WALLHAVEN_CATEGORIES,
  WEB_ENGINES,
  findEngine,
} from './defaults.js';
import { confirmDialog, openModal, toast } from './dialog.js';
import { createSiteIcon } from './dock.js';
import { icon } from './icons.js';
import { PROVIDER_IDS, PROVIDER_META, hasCredentials } from './providers/index.js';
import { testConnection as testDeepseekSearch } from './providers/deepseek-search.js';
import { testConnection as testYuanbao } from './providers/yuanbao-mcp.js';
import * as storage from './storage.js';
import { debounce, deepMerge, describeError, getPath, hostOf, setPath } from './utils.js';
import { fetchWallhavenList } from './wallhaven.js';
import {
  getSteamSession,
} from './weworkshop.js';

const CARET = `<span class="sec-caret">${icon('chevronDown')}</span>`;

/** 壁纸库画廊的排序选项。 */
const WH_SORTS = [
  { value: 'toplist-1M', label: '热门 · 近一月' },
  { value: 'toplist-1y', label: '热门 · 近一年' },
  { value: 'date_added', label: '最新上传' },
  { value: 'random', label: '随机' },
];

/** 通用测试连接：GET {base}/models。 */
async function testOpenAiCompatible({ baseUrl, apiKey, authHeader = 'Authorization', authPrefix = 'Bearer ' }) {
  if (!baseUrl) throw new Error('请先填写 Base URL');
  if (!apiKey) throw new Error('请先填写 API Key');
  const base = String(baseUrl).trim().replace(/\/+$/, '');
  const headerName = String(authHeader || 'Authorization').trim() || 'Authorization';
  const prefix = authPrefix === undefined ? 'Bearer ' : String(authPrefix);
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { [headerName]: `${prefix}${apiKey}` },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (err) {
    throw new Error(describeError(err));
  }
  const latency = Math.round(performance.now() - started);
  if (!response.ok) {
    if (response.status === 401) throw new Error('密钥无效（401）');
    if (response.status === 403) throw new Error('无权限（403）');
    if (response.status === 429) throw new Error('请求被限流（429），请稍后再试');
    if (response.status === 404) throw new Error('接口地址不存在（404），请检查 Base URL');
    throw new Error(`请求失败（HTTP ${response.status}）`);
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== 'object') throw new Error('返回格式异常');
  } catch (err) {
    throw new Error('返回格式异常，请确认这是一个 OpenAI 兼容端点');
  }
  return latency;
}

export class SettingsDrawer {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root #settings-drawer
   * @param {HTMLElement} options.backdrop #settings-backdrop
   * @param {object} options.app 应用上下文 { getSettings, getSecrets, getSites, updateSettings, updateSecrets, updateSites, resetAll }
   * @param {{open:Function}} options.siteEditor
   * @param {{open:Function}} [options.weShop] 壁纸工坊入口
   * @param {Function} [options.onSitesChanged]
   * @param {Function} [options.onOpen]
   * @param {Function} [options.onClose]
   */
  constructor({ root, backdrop, app, siteEditor, weShop, onSitesChanged, onOpen, onClose }) {
    this.root = root;
    this.backdrop = backdrop;
    this.app = app;
    this.siteEditor = siteEditor || { open: () => {} };
    this.weShop = weShop || { open: () => {} };
    this.onSitesChanged = typeof onSitesChanged === 'function' ? onSitesChanged : () => {};
    this.onOpen = typeof onOpen === 'function' ? onOpen : () => {};
    this.onClose = typeof onClose === 'function' ? onClose : () => {};

    this.mounted = false;
    this.openState = false;
    this.pendingSettings = {};
    this.pendingSecrets = {};
    // 本地视图快照：让 UI 在 debounce 持久化之前就能即时反馈
    this.viewSettings = null;
    this.testing = { yuanbao: false, deepseek: false, custom: false };

    this.persistSettings = debounce(() => this.flushSettings(), 200);
    this.persistSecrets = debounce(() => this.flushSecrets(), 200);
  }

  /* ------------------------------ 构建 ------------------------------ */

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    this.root.innerHTML = `
      <div class="settings-head">
        <div>
          <div class="sett-title">设置</div>
          <div class="sett-sub">所有配置仅保存在本机浏览器</div>
        </div>
        <div class="spacer"></div>
        <button class="icon-btn" type="button" data-act="close" title="关闭（Esc）" aria-label="关闭设置">${icon('close')}</button>
      </div>
      <div class="settings-body scroll-thin" data-role="body">
        ${this.templateAppearance()}
        ${this.templateClock()}
        ${this.templateSearch()}
        ${this.templateAi()}
        ${this.templateSites()}
        ${this.templateGeneral()}
      </div>
      <div class="settings-foot">Aurora New Tab v${APP_VERSION} · 快捷键 <b>/</b> 聚焦搜索 · <b>Ctrl/Cmd + K</b></div>
    `;

    this.root.querySelector('[data-act="close"]').addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());

    this.wireAppearance();
    this.wireAi();
    this.wireSites();
    this.wireGeneral();
    this.wireGenericBindings();

    this.renderSwatches();
    this.renderSiteList();
    this.syncValues();
  }

  /* ------------------------------ 模板 ------------------------------ */

  templateAppearance() {
    return `
      <details class="sec" id="sec-appearance" open>
        <summary>${icon('image')}外观${CARET}</summary>
        <div class="sec-body">
          <div class="field">
            <span class="field-label">背景类型</span>
            <div class="seg" data-role="bgtype">
              <button type="button" data-bgtype="bing">必应每日</button>
              <button type="button" data-bgtype="wallhaven">壁纸库</button>
              <button type="button" data-bgtype="we">WE 工坊</button>
              <button type="button" data-bgtype="static">图片</button>
              <button type="button" data-bgtype="video">视频</button>
              <button type="button" data-bgtype="gradient">渐变</button>
            </div>
          </div>

          <div data-role="pane-bing" hidden>
            <div class="notice info">${icon('info')}<span>使用必应每日壁纸，无需密钥。当天结果会缓存在本机。</span></div>
            <div class="field">
              <label for="set-bing-mkt">壁纸地区</label>
              <select id="set-bing-mkt" class="select" data-path="background.bingMkt">
                <option value="zh-CN">中国（zh-CN）</option>
                <option value="en-US">美国（en-US）</option>
                <option value="ja-JP">日本（ja-JP）</option>
                <option value="en-GB">英国（en-GB）</option>
                <option value="de-DE">德国（de-DE）</option>
              </select>
            </div>
          </div>

          <div data-role="pane-wallhaven" hidden>
            <div class="notice info">${icon('info')}<span>来自 wallhaven.cc 境外壁纸库（免密钥）。没开代理会自动使用本机缓存的上一张壁纸；下方可配置壁纸库专用代理，让壁纸长期可用。</span></div>
            <div class="field">
              <label for="set-wh-mode">壁纸来源</label>
              <select id="set-wh-mode" class="select" data-path="background.wallhavenMode">
                <option value="daily">每日精选（每天自动换一张）</option>
                <option value="random">随机热门（每个新标签不同）</option>
                <option value="search">关键词搜索（按天轮换）</option>
              </select>
            </div>
            <div class="field" data-role="wh-query-row" hidden>
              <label for="set-wh-query">搜索关键词</label>
              <input id="set-wh-query" class="input" type="text" data-path="background.wallhavenQuery" placeholder="如：mountain, night city" />
              <div class="hint">建议用英文关键词，逗号分隔多个；当天结果会缓存在本机。</div>
            </div>
            <div class="field">
              <label for="set-wh-cat">分类</label>
              <select id="set-wh-cat" class="select" data-path="background.wallhavenCategories">
                ${WALLHAVEN_CATEGORIES.map((cat) => `<option value="${cat.value}">${cat.label}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label for="set-wh-proxy">专用代理（可选）</label>
              <input id="set-wh-proxy" class="input" type="text" data-path="background.wallhavenProxy" placeholder="127.0.0.1:7890" />
              <div class="hint">填写本地代理端口（Clash 默认 <b>127.0.0.1:7890</b>）后，仅 wallhaven 的流量走代理、其它网站不受影响，无需常开系统代理。留空则不接管。<b>注意：</b>开启期间浏览器的代理设置由本扩展接管（其它网站直连）；若你依赖系统代理访问其它网站，请改用系统代理并留空此项。</div>
            </div>
            <div class="row">
              <div class="row-text">
                <span class="row-title">无代理时尝试中转</span>
                <span class="row-desc">直连失败时经中转站拉取；彻底断网时用内置精选包（10 张，按天轮换）</span>
              </div>
              <label class="switch"><input type="checkbox" data-path="background.wallhavenRelay" /><span></span></label>
            </div>
            <div class="field">
              <label for="set-wh-relay">自定义中转（可选）</label>
              <input id="set-wh-relay" class="input" type="text" data-path="background.wallhavenRelayUrl" placeholder="https://my-relay.workers.dev/?url={url}" />
              <div class="hint">需包含 <b>{url}</b> 占位符。推荐自建 Cloudflare Worker（免费、国内可达、最稳定），会排在公共中转之前尝试；公共中转为免费服务，可用性无保证。</div>
            </div>
            <button class="btn ghost sm" type="button" data-role="wh-browse">${icon('image')}浏览壁纸库，手动挑一张</button>
          </div>

          <div data-role="pane-we" hidden>
            <div class="notice info">${icon('info')}<span>来自 Steam 创意工坊（Wallpaper Engine）。可把工坊壁纸（含动态视频）设为起始页背景，也能一键订阅并应用到桌面——订阅用浏览器里的 Steam 登录态，Steam 客户端负责下载。需浏览器能访问 steamcommunity.com。</span></div>
            <div class="field">
              <label for="set-we-mode">起始页背景来源</label>
              <select id="set-we-mode" class="select" data-path="background.weMode">
                <option value="fixed">固定一张（在画廊里挑选）</option>
                <option value="daily">收藏池每日轮换（每天自动换）</option>
              </select>
            </div>
            <div class="field">
              <label for="set-we-fit">背景显示方式</label>
              <select id="set-we-fit" class="select" data-path="background.weFit">
                <option value="cover">尽量填满（比例差距大时自动改为完整显示）</option>
                <option value="contain">完整显示（不裁切，四周用同图虚化铺底填满）</option>
              </select>
              <div class="hint">工坊预览多为方形件（约 1024px）：直接铺满会裁掉大半且发糊，所以比例差距大时会自动按「完整显示 + 虚化铺底」呈现，画面不裁切、也不放大。</div>
            </div>
            <button class="btn ghost sm" type="button" data-role="we-browse">${icon('image')}浏览创意工坊，挑壁纸 / 订阅 / 设背景</button>
            <div class="field" data-role="we-current" hidden>
              <div class="hint" data-role="we-current-text"></div>
            </div>
            <div class="field">
              <label for="set-we-path">Workshop 内容目录（应用到桌面用）</label>
              <input id="set-we-path" class="input" type="text" data-path="background.weWorkshopPath" placeholder="C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960" />
              <div class="hint">按 <b>目录\\壁纸ID\\project.json</b> 定位文件，Steam 装在其他盘（如 D:\\SteamLibrary）时改成对应路径即可。</div>
            </div>
            <div class="row">
              <div class="row-text">
                <span class="row-title">订阅后自动应用到桌面</span>
                <span class="row-desc">订阅成功后等待下载完成，自动向 Wallpaper Engine 发送应用命令</span>
              </div>
              <label class="switch"><input type="checkbox" data-path="background.weAutoApply" /><span></span></label>
            </div>
            <div class="field">
              <label for="set-we-delay">自动应用前等待（秒）</label>
              <input id="set-we-delay" class="input" type="number" min="5" max="300" step="5" data-path="background.weApplyDelay" />
              <div class="hint">大型壁纸下载慢可调大，默认 20 秒。首次应用时 Chrome 会询问「是否打开 Steam」，请允许。</div>
            </div>
            <div class="test-line" data-state="loading" data-role="we-login"><span class="dot"></span><span data-role="we-login-text">正在检查 Steam 登录状态…</span></div>
            <button class="btn ghost sm" type="button" data-role="we-login-btn" hidden>前往 Steam 登录 ↗</button>
          </div>

          <div data-role="pane-static" hidden>
            <div class="field">
              <label for="set-image-url">图片地址</label>
              <input id="set-image-url" class="input" type="text" data-path="background.imageUrl" placeholder="https://example.com/wallpaper.jpg" />
              <div class="hint" data-role="static-source"></div>
            </div>
            <div class="upload-row">
              <button class="btn ghost sm" type="button" data-role="upload-image">${icon('upload')}上传本地图片</button>
              <span class="file-name" data-role="image-name">未选择文件</span>
              <input type="file" accept="image/*" data-role="image-file" hidden />
            </div>
          </div>

          <div data-role="pane-video" hidden>
            <div class="field">
              <label for="set-video-url">视频地址（mp4 / webm）</label>
              <input id="set-video-url" class="input" type="text" data-path="background.videoUrl" placeholder="https://example.com/bg.mp4" />
              <div class="hint">建议使用 URL，大文件上传会占用较多本机存储。</div>
            </div>
            <div class="upload-row">
              <button class="btn ghost sm" type="button" data-role="upload-video">${icon('upload')}上传本地视频</button>
              <span class="file-name" data-role="video-name">未选择文件</span>
              <input type="file" accept="video/*" data-role="video-file" hidden />
            </div>
          </div>

          <div data-role="pane-gradient" hidden>
            <div class="field">
              <span class="field-label">渐变主题</span>
              <div class="swatch-grid" data-role="swatches"></div>
            </div>
            <div class="row">
              <div class="row-text">
                <span class="row-title">漂浮粒子</span>
                <span class="row-desc">低透明度细粒子，营造空气感</span>
              </div>
              <label class="switch">
                <input type="checkbox" data-path="background.particles" />
                <span></span>
              </label>
            </div>
          </div>

          <div class="field" style="margin-top:12px">
            <label for="set-blur">背景模糊</label>
            <div class="slider-row">
              <input id="set-blur" type="range" min="0" max="20" step="1" data-path="background.blur" />
              <span class="slider-val" data-role="blur-val">0px</span>
            </div>
          </div>
          <div class="field">
            <label for="set-dim">背景暗化</label>
            <div class="slider-row">
              <input id="set-dim" type="range" min="0" max="0.8" step="0.02" data-path="background.dim" />
              <span class="slider-val" data-role="dim-val">22%</span>
            </div>
          </div>
        </div>
      </details>
    `;
  }

  templateClock() {
    return `
      <details class="sec" id="sec-clock">
        <summary>${icon('clock')}时钟${CARET}</summary>
        <div class="sec-body">
          <div class="row">
            <div class="row-text"><span class="row-title">12 小时制</span><span class="row-desc">关闭则使用 24 小时制</span></div>
            <label class="switch"><input type="checkbox" data-path="clock.hour12" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">显示秒</span></div>
            <label class="switch"><input type="checkbox" data-path="clock.showSeconds" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">显示日期</span></div>
            <label class="switch"><input type="checkbox" data-path="clock.showDate" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">显示问候语</span></div>
            <label class="switch"><input type="checkbox" data-path="clock.showGreeting" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">Dock 显示名称</span><span class="row-desc">图标下方显示站点名</span></div>
            <label class="switch"><input type="checkbox" data-path="clock.showDockLabels" /><span></span></label>
          </div>
        </div>
      </details>
    `;
  }

  templateSearch() {
    const options = AI_ENGINES.concat(WEB_ENGINES)
      .map((engine) => `<option value="${engine.id}">${engine.group === 'ai' ? 'AI · ' : ''}${engine.name}</option>`)
      .join('');
    return `
      <details class="sec" id="sec-search">
        <summary>${icon('search')}搜索${CARET}</summary>
        <div class="sec-body">
          <div class="field">
            <label for="set-engine">默认搜索引擎</label>
            <select id="set-engine" class="select" data-path="search.defaultEngine">${options}</select>
            <div class="hint">AI 引擎会打开结果面板；网页引擎直接跳转。</div>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">网页搜索新标签打开</span><span class="row-desc">关闭后在当前标签页跳转</span></div>
            <label class="switch"><input type="checkbox" data-path="search.newTab" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text"><span class="row-title">显示引擎图标</span></div>
            <label class="switch"><input type="checkbox" data-path="search.showEngineIcon" /><span></span></label>
          </div>
        </div>
      </details>
    `;
  }

  templateAi() {
    const cards = Object.keys(PROVIDER_META)
      .map((id) => {
        const meta = PROVIDER_META[id];
        return `
          <button class="provider-card" type="button" data-provider="${id}">
            <span class="pc-radio"></span>
            <span class="pc-text">
              <span class="pc-name">${meta.name}</span>
              <span class="pc-desc">${meta.desc}</span>
            </span>
          </button>`;
      })
      .join('');

    return `
      <details class="sec" id="sec-ai">
        <summary>${icon('sparkles')}AI 搜索${CARET}</summary>
        <div class="sec-body">
          <div class="notice">${icon('shield')}<span>密钥仅保存在本机浏览器（chrome.storage.local），不会上传到任何服务器。</span></div>

          <div class="provider-list" data-role="provider-list">${cards}</div>

          <!-- 元宝搜索 -->
          <div data-role="ppane-yuanbao" hidden>
            <div class="field">
              <label for="set-yb-authmode">鉴权方式</label>
              <select id="set-yb-authmode" class="select" data-secret="yuanbao.authMode">
                <option value="tc3">腾讯云云 API 签名（推荐）</option>
                <option value="bearer">网关 API Key（Bearer）</option>
              </select>
              <div class="hint">官方接口 wsa.tencentcloudapi.com 使用 TC3-HMAC-SHA256 签名，需要 SecretId + SecretKey；元宝 MCP 网关才用 Bearer Key。</div>
            </div>

            <div data-role="yb-tc3">
              <div class="field">
                <label for="set-yb-secretid">SecretId</label>
                <input id="set-yb-secretid" class="input" type="text" data-secret="yuanbao.secretId" placeholder="AKIDxxxxxxxxxxxxxxxx" />
              </div>
              <div class="field">
                <label for="set-yb-secretkey">SecretKey</label>
                <div class="input-group">
                  <input id="set-yb-secretkey" class="input" type="password" data-secret="yuanbao.secretKey" placeholder="腾讯云 API 密钥" />
                  <button class="input-eye" type="button" data-reveal="1" aria-label="显示/隐藏">${icon('eye')}</button>
                </div>
                <div class="hint">控制台「访问管理 → API 密钥管理」获取，仅保存在本机。</div>
              </div>
              <div class="field">
                <label for="set-yb-version">接口版本（Version）</label>
                <input id="set-yb-version" class="input" type="text" data-secret="yuanbao.version" placeholder="2025-05-08" />
                <div class="hint">动作固定 SearchPro，服务名固定 wsa。</div>
              </div>
            </div>

            <div data-role="yb-bearer">
              <div class="field">
                <label for="set-yb-transport">接入方式</label>
                <select id="set-yb-transport" class="select" data-secret="yuanbao.transport">
                  <option value="mcp">MCP（Streamable HTTP，工具 SearchPro）</option>
                  <option value="http">HTTP 直连 SearchPro（更简单）</option>
                </select>
                <div class="hint">MCP 端点：https://api.wsa.cloud.tencent.com/Mcp · 直连：https://api.wsa.cloud.tencent.com/SearchPro</div>
              </div>
              <div class="field">
                <label for="set-yb-endpoint">服务地址</label>
                <input id="set-yb-endpoint" class="input" type="text" data-secret="yuanbao.endpoint" placeholder="https://api.wsa.cloud.tencent.com/Mcp" />
                <div class="hint">需服务端允许浏览器跨域访问（CORS）。</div>
              </div>
              <div class="field">
                <label for="set-yb-key">API Key</label>
                <div class="input-group">
                  <input id="set-yb-key" class="input" type="password" data-secret="yuanbao.apiKey" placeholder="sk-xxxxxxxx（元宝搜索服务 API KEY）" />
                  <button class="input-eye" type="button" data-reveal="1" aria-label="显示/隐藏">${icon('eye')}</button>
                </div>
              </div>
              <div class="field">
                <label for="set-yb-tool">搜索工具名</label>
                <input id="set-yb-tool" class="input" type="text" data-secret="yuanbao.tool" placeholder="SearchPro" />
                <div class="hint">元宝 MCP 固定为 SearchPro；其它 MCP 服务填服务端实际工具名。</div>
              </div>
              <div class="field">
                <label for="set-yb-header">鉴权 Header 名</label>
                <input id="set-yb-header" class="input" type="text" data-secret="yuanbao.authHeader" placeholder="Authorization" />
              </div>
              <div class="field">
                <label for="set-yb-prefix">鉴权前缀</label>
                <input id="set-yb-prefix" class="input" type="text" data-secret="yuanbao.authPrefix" placeholder="Bearer " />
                <div class="hint">注意保留前缀末尾的空格。</div>
              </div>
            </div>

            <div class="field">
              <label for="set-yb-mode">结果类型（Mode）</label>
              <select id="set-yb-mode" class="select" data-secret="yuanbao.mode">
                <option value="0">公开网页</option>
                <option value="1">权威垂直信源</option>
                <option value="2">混合（推荐）</option>
              </select>
            </div>
            <div class="field">
              <label for="set-yb-freshness">时效范围（可空）</label>
              <input id="set-yb-freshness" class="input" type="text" data-secret="yuanbao.freshness" placeholder="d7 / m3 / y1" />
              <div class="hint">d[N] 近 N 天、m[N] 近 N 月、y[N] 近 N 年，或 2026-08-20,2026-08-30。</div>
            </div>
            <div class="field">
              <label for="set-yb-industry">垂直领域（可空）</label>
              <select id="set-yb-industry" class="select" data-secret="yuanbao.industry">
                <option value="">不限制</option>
                <option value="gov">政府</option>
                <option value="news">新闻</option>
                <option value="acad">学术</option>
                <option value="finance">财经</option>
              </select>
            </div>
            <div class="field">
              <label for="set-yb-llm">用于总结的模型</label>
              <select id="set-yb-llm" class="select" data-secret="yuanbao.llm">
                <option value="deepseek">DeepSeek</option>
                <option value="custom">自定义模型</option>
              </select>
            </div>
            <div class="field">
              <label for="set-yb-extra">额外参数 JSON（可空）</label>
              <input id="set-yb-extra" class="input" type="text" data-secret="yuanbao.extraArgs" placeholder='{"Site":"docs.python.org"}' />
            </div>
            <button class="btn ghost sm" type="button" data-test="yuanbao">测试连接</button>
            <div class="test-line" data-role="test-yuanbao"><span class="dot"></span><span data-role="test-yuanbao-text">未测试</span></div>
            <div class="hint">测试会真实调用一次搜索接口（消耗 1 次额度）；签名方式会返回账号版本（standard / flagship）。</div>
          </div>

          <!-- DeepSeek -->
          <div data-role="ppane-deepseek" hidden>
            <div class="field">
              <label for="set-ds-key">API Key</label>
              <div class="input-group">
                <input id="set-ds-key" class="input" type="password" data-secret="deepseek.apiKey" placeholder="sk-xxxxxxxxxxxxxxxx" />
                <button class="input-eye" type="button" data-reveal="1" aria-label="显示/隐藏">${icon('eye')}</button>
              </div>
            </div>
            <div class="field">
              <label for="set-ds-base">Base URL</label>
              <input id="set-ds-base" class="input" type="text" data-secret="deepseek.baseUrl" placeholder="https://api.deepseek.com/v1" />
            </div>
            <div class="field">
              <label for="set-ds-model">模型</label>
              <input id="set-ds-model" class="input" type="text" data-secret="deepseek.model" placeholder="deepseek-chat" />
            </div>
            <div class="row">
              <div class="row-text">
                <span class="row-title">联网搜索</span>
                <span class="row-desc">开启后「DeepSeek 联网」引擎走 /v1/tools/search</span>
              </div>
              <label class="switch"><input type="checkbox" data-secret="deepseek.webSearch" /><span></span></label>
            </div>
            <div class="field">
              <label for="set-ds-depth">深度模式</label>
              <select id="set-ds-depth" class="select" data-secret="deepseek.searchDepth">
                <option value="off">仅检索（不抓取正文，最省额度）</option>
                <option value="normal">标准（检索 + 带引用总结）</option>
                <option value="deep">精读（额外抓取前 3 篇正文）</option>
              </select>
              <div class="hint">精读会额外调用 /v1/tools/fetch（单篇失败自动跳过），正文更长、回答更准。</div>
            </div>
            <button class="btn ghost sm" type="button" data-test="deepseek">测试连接</button>
            <div class="test-line" data-role="test-deepseek"><span class="dot"></span><span data-role="test-deepseek-text">未测试</span></div>
            <div class="hint">开启联网搜索时，「测试连接」会额外真实调用一次搜索接口（返回 3 条结果验证）。</div>
          </div>

          <!-- 自定义 -->
          <div data-role="ppane-custom" hidden>
            <div class="field">
              <label for="set-cu-base">Base URL</label>
              <input id="set-cu-base" class="input" type="text" data-secret="custom.baseUrl" placeholder="https://api.example.com/v1" />
            </div>
            <div class="field">
              <label for="set-cu-model">模型</label>
              <input id="set-cu-model" class="input" type="text" data-secret="custom.model" placeholder="gpt-4o-mini" />
            </div>
            <div class="field">
              <label for="set-cu-key">API Key</label>
              <div class="input-group">
                <input id="set-cu-key" class="input" type="password" data-secret="custom.apiKey" placeholder="sk-xxxxxxxx" />
                <button class="input-eye" type="button" data-reveal="1" aria-label="显示/隐藏">${icon('eye')}</button>
              </div>
            </div>
            <div class="field">
              <label for="set-cu-header">鉴权 Header 名</label>
              <input id="set-cu-header" class="input" type="text" data-secret="custom.authHeader" placeholder="Authorization" />
            </div>
            <div class="field">
              <label for="set-cu-prefix">鉴权前缀</label>
              <input id="set-cu-prefix" class="input" type="text" data-secret="custom.authPrefix" placeholder="Bearer " />
            </div>
            <button class="btn ghost sm" type="button" data-test="custom">测试连接</button>
            <div class="test-line" data-role="test-custom"><span class="dot"></span><span data-role="test-custom-text">未测试</span></div>
          </div>

          <div class="group-gap"></div>
          <div class="row">
            <div class="row-text"><span class="row-title">流式输出</span><span class="row-desc">关闭后等待完整回答再显示</span></div>
            <label class="switch"><input type="checkbox" data-path="ai.stream" /><span></span></label>
          </div>
          <div class="row">
            <div class="row-text">
              <span class="row-title">演示模式</span>
              <span class="row-desc">未填写密钥时使用本地演示回答；关闭后提示去填写密钥</span>
            </div>
            <label class="switch"><input type="checkbox" data-path="ai.demoMode" /><span></span></label>
          </div>
          <div class="field" style="margin-top:10px">
            <label for="set-temp">温度（temperature）</label>
            <div class="slider-row">
              <input id="set-temp" type="range" min="0" max="1.5" step="0.1" data-path="ai.temperature" />
              <span class="slider-val" data-role="temp-val">0.6</span>
            </div>
          </div>
          <div class="field">
            <label for="set-max-sources">每次检索条数</label>
            <select id="set-max-sources" class="select" data-path="ai.maxSources">
              <option value="10">10 条</option>
              <option value="20">20 条</option>
              <option value="30">30 条</option>
              <option value="50">50 条</option>
            </select>
            <div class="hint">元宝只支持 10 / 20 / 30 / 40 / 50（自动就近取档）；DeepSeek 联网支持 1~50。</div>
          </div>
          <div class="field">
            <label for="set-freshness">时效筛选</label>
            <select id="set-freshness" class="select" data-path="ai.searchFreshness">
              <option value="any">不限时间</option>
              <option value="d7">最近 7 天</option>
              <option value="m1">最近一个月</option>
              <option value="y1">最近一年</option>
            </select>
            <div class="hint">当前由 DeepSeek 联网通过 <b>after:</b> 语法生效；元宝请用上方「时效范围」。</div>
          </div>
          <div class="field">
            <label for="set-sys-prompt">系统提示词（可空）</label>
            <textarea id="set-sys-prompt" class="textarea" data-path="ai.systemPrompt" placeholder="留空则使用内置提示词"></textarea>
          </div>
        </div>
      </details>
    `;
  }

  templateSites() {
    return `
      <details class="sec" id="sec-sites">
        <summary>${icon('globe')}常用网站${CARET}</summary>
        <div class="sec-body">
          <div class="site-list" data-role="site-list"></div>
          <button class="btn ghost sm" type="button" data-role="add-site">${icon('plus')}添加网站</button>
        </div>
      </details>
    `;
  }

  templateGeneral() {
    return `
      <details class="sec" id="sec-general">
        <summary>${icon('database')}通用${CARET}</summary>
        <div class="sec-body">
          <div class="btn-row">
            <button class="btn ghost sm" type="button" data-role="export">${icon('download')}导出配置</button>
            <button class="btn ghost sm" type="button" data-role="import">${icon('upload')}导入配置</button>
            <button class="btn ghost sm" type="button" data-role="reset">${icon('reset')}恢复默认</button>
          </div>
          <input type="file" accept="application/json,.json" data-role="import-file" hidden />
          <div class="hint" style="margin-top:8px">
            导出文件仅包含设置与站点，<b>不包含任何密钥</b>。
          </div>
          <div class="hint" style="margin-top:6px" data-role="backend-info"></div>
        </div>
      </details>
    `;
  }

  /* ------------------------------ 绑定 ------------------------------ */

  /** 通用数据绑定（settings）。 */
  wireGenericBindings() {
    this.root.querySelectorAll('[data-path]').forEach((el) => {
      const path = el.getAttribute('data-path');
      const isCheckbox = el.type === 'checkbox';
      const isSelect = el.tagName === 'SELECT';
      const isRange = el.type === 'range';
      const eventName = isCheckbox || isSelect ? 'change' : 'input';

      el.addEventListener(eventName, () => {
        let value;
        if (isCheckbox) value = el.checked;
        else if (isRange || el.type === 'number') value = Number(el.value);
        else value = el.value;
        this.queueSettings(path, value);
        this.updateRangeLabels();
        this.syncDerivedUi();
      });
    });
  }

  /** 通用数据绑定（secrets）。 */
  wireSecretBindings() {
    this.root.querySelectorAll('[data-secret]').forEach((el) => {
      const path = el.getAttribute('data-secret');
      const isCheckbox = el.type === 'checkbox';
      const eventName = el.tagName === 'SELECT' || isCheckbox ? 'change' : 'input';
      el.addEventListener(eventName, () => {
        const value = isCheckbox ? Boolean(el.checked) : el.value;
        this.pendingSecrets = setPath({ ...this.pendingSecrets }, path, value);
        this.persistSecrets();
        // 切换元宝鉴权方式时立即同步字段显隐，避免用户在多套凭证之间困惑
        if (path === 'yuanbao.authMode') this.syncYuanbaoAuth();
      });
    });
  }

  wireAppearance() {
    const seg = this.root.querySelector('[data-role="bgtype"]');
    seg.addEventListener('click', (event) => {
      const button = event.target.closest('[data-bgtype]');
      if (!button) return;
      const type = button.getAttribute('data-bgtype');
      this.queueSettings('background.type', type);
      this.syncDerivedUi();
    });

    const imageFile = this.root.querySelector('[data-role="image-file"]');
    this.root.querySelector('[data-role="upload-image"]').addEventListener('click', () => imageFile.click());
    imageFile.addEventListener('change', async () => {
      const file = imageFile.files && imageFile.files[0];
      if (!file) return;
      const nameEl = this.root.querySelector('[data-role="image-name"]');
      nameEl.textContent = file.name;
      try {
        const record = await storage.saveMedia(file, file.name);
        await this.app.updateSettings({ background: { type: 'static', imageMediaId: record.id } });
        this.syncValues();
        toast('本地图片已应用', 'ok');
      } catch (err) {
        toast(`图片保存失败：${describeError(err)}`, 'error');
      }
    });

    const videoFile = this.root.querySelector('[data-role="video-file"]');
    this.root.querySelector('[data-role="upload-video"]').addEventListener('click', () => videoFile.click());
    videoFile.addEventListener('change', async () => {
      const file = videoFile.files && videoFile.files[0];
      if (!file) return;
      const nameEl = this.root.querySelector('[data-role="video-name"]');
      nameEl.textContent = file.name;
      try {
        const record = await storage.saveMedia(file, file.name);
        await this.app.updateSettings({ background: { type: 'video', videoMediaId: record.id } });
        this.syncValues();
        toast('本地视频已应用', 'ok');
      } catch (err) {
        toast(`视频保存失败：${describeError(err)}`, 'error');
      }
    });

    const swatches = this.root.querySelector('[data-role="swatches"]');
    swatches.addEventListener('click', (event) => {
      const button = event.target.closest('[data-gradient]');
      if (!button) return;
      this.queueSettings('background.gradient', button.getAttribute('data-gradient'));
      this.syncDerivedUi();
    });

    const browseBtn = this.root.querySelector('[data-role="wh-browse"]');
    if (browseBtn) browseBtn.addEventListener('click', () => this.openWallhavenGallery());

    const weBrowseBtn = this.root.querySelector('[data-role="we-browse"]');
    if (weBrowseBtn) weBrowseBtn.addEventListener('click', () => this.weShop.open());

    const weLoginBtn = this.root.querySelector('[data-role="we-login-btn"]');
    if (weLoginBtn) {
      weLoginBtn.addEventListener('click', () => {
        window.open('https://steamcommunity.com/login/', '_blank', 'noopener');
      });
    }
  }

  wireAi() {
    const list = this.root.querySelector('[data-role="provider-list"]');
    list.addEventListener('click', (event) => {
      const card = event.target.closest('[data-provider]');
      if (!card) return;
      this.queueSettings('ai.provider', card.getAttribute('data-provider'));
      this.syncDerivedUi();
    });

    this.root.querySelectorAll('[data-reveal]').forEach((button) => {
      button.addEventListener('click', () => {
        const input = button.parentElement.querySelector('input');
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        button.innerHTML = icon(show ? 'eyeOff' : 'eye');
      });
    });

    this.root.querySelectorAll('[data-test]').forEach((button) => {
      button.addEventListener('click', () => this.runTest(button.getAttribute('data-test')));
    });

    this.wireSecretBindings();
  }

  wireSites() {
    const list = this.root.querySelector('[data-role="site-list"]');
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-site-act]');
      if (!button) return;
      const id = button.getAttribute('data-site-id');
      const act = button.getAttribute('data-site-act');
      const sites = this.app.getSites();
      const site = sites.find((item) => item.id === id);
      if (!site) return;
      if (act === 'edit') {
        this.siteEditor.open(site);
      } else if (act === 'delete') {
        const ok = await confirmDialog({
          title: '删除网站',
          message: `确定要移除「${site.title}」吗？`,
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        await this.app.updateSites(sites.filter((item) => item.id !== id));
        this.renderSiteList();
        this.onSitesChanged();
        toast('已删除', 'ok');
      }
    });

    this.root.querySelector('[data-role="add-site"]').addEventListener('click', () => {
      this.siteEditor.open(null);
    });
  }

  wireGeneral() {
    this.root.querySelector('[data-role="export"]').addEventListener('click', async () => {
      try {
        const data = await storage.exportConfig();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 10);
        link.href = url;
        link.download = `aurora-newtab-${stamp}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast('配置已导出（不含密钥）', 'ok');
      } catch (err) {
        toast(`导出失败：${describeError(err)}`, 'error');
      }
    });

    const importFile = this.root.querySelector('[data-role="import-file"]');
    this.root.querySelector('[data-role="import"]').addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await storage.importConfig(data);
        await this.app.reload();
        this.syncValues();
        this.renderSiteList();
        this.onSitesChanged();
        toast('配置已导入', 'ok');
      } catch (err) {
        toast(`导入失败：${describeError(err)}`, 'error');
      } finally {
        importFile.value = '';
      }
    });

    this.root.querySelector('[data-role="reset"]').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '恢复默认设置',
        message: '将重置外观、时钟、搜索、AI 与常用网站为默认值。密钥不会被清除，确定继续吗？',
        confirmText: '恢复默认',
        danger: true,
      });
      if (!ok) return;
      await this.app.resetAll();
      this.syncValues();
      this.renderSiteList();
      this.onSitesChanged();
      toast('已恢复默认设置', 'ok');
    });

    const backend = this.root.querySelector('[data-role="backend-info"]');
    const mode = storage.getBackend();
    backend.textContent = `存储位置：${mode === 'chrome' ? 'chrome.storage.local' : 'localStorage（浏览器预览模式）'}`;
  }

  /* ------------------------------ 壁纸库画廊 ------------------------------ */

  /** 打开 wallhaven 浏览画廊（网格 + 搜索 + 加载更多 + 预览应用）。 */
  openWallhavenGallery() {
    const view = this.ensureView();

    const wrap = document.createElement('div');
    wrap.className = 'wh-gallery';
    wrap.innerHTML = `
      <div class="wh-toolbar">
        <input class="input wh-q" type="text" data-role="wh-q" placeholder="关键词，如 mountain / night city" />
        <select class="select" data-role="wh-sort" aria-label="排序">
          ${WH_SORTS.map((sort) => `<option value="${sort.value}">${sort.label}</option>`).join('')}
        </select>
        <select class="select" data-role="wh-cat" aria-label="分类">
          ${WALLHAVEN_CATEGORIES.map((cat) => `<option value="${cat.value}">${cat.label}</option>`).join('')}
        </select>
        <button class="btn ghost sm" type="button" data-role="wh-search">${icon('search')}搜索</button>
      </div>
      <div class="wh-grid scroll-thin" data-role="wh-grid"></div>
      <div class="wh-foot">
        <button class="btn ghost sm" type="button" data-role="wh-more" hidden>加载更多</button>
        <span class="wh-status" data-role="wh-status"></span>
      </div>
    `;

    const qInput = wrap.querySelector('[data-role="wh-q"]');
    const grid = wrap.querySelector('[data-role="wh-grid"]');
    const moreBtn = wrap.querySelector('[data-role="wh-more"]');
    const statusEl = wrap.querySelector('[data-role="wh-status"]');
    qInput.value = String(getPath(view, 'background.wallhavenQuery', '') || '');
    wrap.querySelector('[data-role="wh-cat"]').value =
      getPath(view, 'background.wallhavenCategories', '111');

    const state = { page: 1, loading: false, done: false };

    const sortParams = () => {
      const value = wrap.querySelector('[data-role="wh-sort"]').value;
      if (value === 'toplist-1y') return { sorting: 'toplist', topRange: '1y' };
      if (value === 'random') {
        return { sorting: 'random', seed: Math.random().toString(36).slice(2, 8) };
      }
      if (value === 'date_added') return { sorting: 'date_added' };
      return { sorting: 'toplist', topRange: '1M' };
    };

    const load = async (reset) => {
      if (state.loading) return;
      if (reset) {
        state.page = 1;
        state.done = false;
        grid.textContent = '';
      }
      if (state.done) return;
      state.loading = true;
      statusEl.textContent = '加载中…';
      moreBtn.hidden = true;
      try {
        const result = await fetchWallhavenList({
          q: qInput.value,
          categories: wrap.querySelector('[data-role="wh-cat"]').value,
          page: state.page,
          relay: getPath(view, 'background.wallhavenRelay', true) !== false,
          relayUrl: String(getPath(view, 'background.wallhavenRelayUrl', '') || '').trim(),
          ...sortParams(),
        });
        result.items.forEach((item) => grid.appendChild(this.buildWallhavenCard(item)));
        state.page += 1;
        // wallhaven 每页固定 24 条，不足一页说明到底
        if (result.items.length < 24) {
          state.done = true;
          statusEl.textContent = '没有更多了';
        } else {
          statusEl.textContent = '';
          moreBtn.hidden = false;
        }
      } catch (err) {
        statusEl.textContent = describeError(err);
      } finally {
        state.loading = false;
      }
    };

    wrap.querySelector('[data-role="wh-search"]').addEventListener('click', () => load(true));
    qInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') load(true);
    });
    moreBtn.addEventListener('click', () => load(false));

    const handle = openModal({
      title: 'wallhaven 壁纸库',
      content: wrap,
      onMount: () => {
        load(true);
      },
    });
    handle.el.style.width = 'min(920px, 94vw)';
    this.whGalleryHandle = handle;
  }

  /** 构造单张壁纸卡片。 */
  buildWallhavenCard(item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'wh-card';
    card.title = `${item.resolution} · ♥ ${item.favorites}`;
    card.innerHTML = `
      <img class="wh-img" loading="lazy" alt="" referrerpolicy="no-referrer" />
      <span class="wh-meta"><span class="wh-res"></span><span class="wh-fav"></span></span>
    `;
    card.querySelector('.wh-img').src = item.thumb;
    card.querySelector('.wh-res').textContent = item.resolution;
    card.querySelector('.wh-fav').textContent = `♥ ${item.favorites}`;
    card.addEventListener('click', () => this.previewWallhaven(item));
    return card;
  }

  /** 大图预览 + 应用。 */
  previewWallhaven(item) {
    const preview = document.createElement('div');
    preview.className = 'wh-preview';
    preview.innerHTML = `
      <img class="wh-preview-img" alt="壁纸预览" referrerpolicy="no-referrer" />
      <div class="wh-preview-meta"></div>
    `;
    preview.querySelector('.wh-preview-img').src = item.url;
    preview.querySelector('.wh-preview-meta').textContent =
      `${item.resolution} · ♥ ${item.favorites} · wallhaven.cc/w/${item.id}`;

    const handle = openModal({
      title: '壁纸预览',
      content: preview,
      actions: [
        {
          label: '打开原页',
          kind: 'ghost',
          closeOnClick: false,
          onClick: () => {
            window.open(item.pageUrl, '_blank', 'noopener');
            return false;
          },
        },
        { label: '设为背景', kind: 'primary', onClick: () => this.applyWallhaven(item) },
      ],
    });
    handle.el.style.width = 'min(980px, 94vw)';
  }

  /** 把选中的壁纸应用为静态背景（复用 static 类型，地址指向 wallhaven 图床）。 */
  async applyWallhaven(item) {
    try {
      await this.app.updateSettings({
        background: { type: 'static', imageUrl: item.url, imageMediaId: '' },
      });
      this.syncValues();
      toast('壁纸已应用', 'ok');
      if (this.whGalleryHandle) {
        this.whGalleryHandle.close();
        this.whGalleryHandle = null;
      }
    } catch (err) {
      toast(`应用失败：${describeError(err)}`, 'error');
    }
  }

  /* ------------------------------ WE 工坊画廊 ------------------------------ */

  /** 刷新 Steam 登录状态行（未登录时显示「前往登录」按钮）。 */
  async syncWeLogin() {
    const line = this.root.querySelector('[data-role="we-login"]');
    const label = this.root.querySelector('[data-role="we-login-text"]');
    const loginBtn = this.root.querySelector('[data-role="we-login-btn"]');
    if (!line || !label) return;
    const { loggedIn } = await getSteamSession().catch(() => ({ loggedIn: false }));
    line.setAttribute('data-state', loggedIn ? 'ok' : 'err');
    if (loginBtn) loginBtn.hidden = loggedIn;
    label.textContent = loggedIn
      ? 'Steam 已登录，可一键订阅并应用到桌面'
      : '未检测到 Steam 登录：浏览/设起始页背景可用，订阅需先在浏览器登录 steamcommunity.com';
  }

  /* ------------------------------ 持久化 ------------------------------ */

  /** 取本地视图快照（避免读到尚未落盘的旧值）。 */
  ensureView() {
    if (!this.viewSettings) {
      this.viewSettings = deepMerge({}, this.app.getSettings());
    }
    return this.viewSettings;
  }

  /** 记录一条设置改动并排队持久化。 */
  queueSettings(path, value) {
    this.pendingSettings = setPath(this.pendingSettings, path, value);
    setPath(this.ensureView(), path, value);
    this.persistSettings();
  }

  /** 立即写入挂起的设置。 */
  async flushSettings() {
    const patch = this.pendingSettings;
    this.pendingSettings = {};
    if (!patch || !Object.keys(patch).length) return;
    try {
      await this.app.updateSettings(patch);
    } catch (err) {
      toast(`保存失败：${describeError(err)}`, 'error');
    }
  }

  /** 立即写入挂起的密钥。 */
  async flushSecrets() {
    const patch = this.pendingSecrets;
    this.pendingSecrets = {};
    if (!patch || !Object.keys(patch).length) return;
    try {
      await this.app.updateSecrets(patch);
    } catch (err) {
      toast(`密钥保存失败：${describeError(err)}`, 'error');
    }
  }

  /* ------------------------------ 视图同步 ------------------------------ */

  /** 把 settings / secrets 当前值同步到控件。 */
  syncValues() {
    if (!this.mounted) return;
    const settings = this.app.getSettings();
    const secrets = this.app.getSecrets();
    this.viewSettings = deepMerge({}, settings);

    this.root.querySelectorAll('[data-path]').forEach((el) => {
      const value = getPath(settings, el.getAttribute('data-path'));
      if (el.type === 'checkbox') {
        el.checked = Boolean(value);
      } else if (document.activeElement !== el) {
        el.value = value === undefined || value === null ? '' : String(value);
      }
    });

    this.root.querySelectorAll('[data-secret]').forEach((el) => {
      const value = getPath(secrets, el.getAttribute('data-secret'));
      if (el.type === 'checkbox') {
        el.checked = Boolean(value);
        return;
      }
      if (document.activeElement !== el) {
        el.value = value === undefined || value === null ? '' : String(value);
      }
    });

    this.updateRangeLabels();
    this.renderSwatches();
    this.syncDerivedUi();
    this.syncYuanbaoAuth();
  }

  /**
   * 元宝鉴权方式：TC3 用 SecretId/SecretKey，Bearer 用地址 + API Key。
   * 两套字段互斥显示，避免用户在两套凭证之间填错。
   */
  syncYuanbaoAuth() {
    const select = this.root.querySelector('[data-secret="yuanbao.authMode"]');
    if (!select) return;
    const secrets = this.app.getSecrets() || {};
    const cfg = secrets.yuanbao || {};
    // 首屏未触发 change 时，回落到已保存的配置
    const mode = String(select.value || cfg.authMode || (cfg.secretId && cfg.secretKey ? 'tc3' : 'bearer')).toLowerCase();
    const tc3Box = this.root.querySelector('[data-role="yb-tc3"]');
    const bearerBox = this.root.querySelector('[data-role="yb-bearer"]');
    if (tc3Box) tc3Box.hidden = mode !== 'tc3';
    if (bearerBox) bearerBox.hidden = mode === 'tc3';
  }

  /** 更新滑块右侧数值。 */
  updateRangeLabels() {
    const settings = this.ensureView();
    const blur = this.root.querySelector('[data-role="blur-val"]');
    const dim = this.root.querySelector('[data-role="dim-val"]');
    const temp = this.root.querySelector('[data-role="temp-val"]');
    if (blur) blur.textContent = `${Math.round(Number(getPath(settings, 'background.blur', 0)))}px`;
    if (dim) dim.textContent = `${Math.round(Number(getPath(settings, 'background.dim', 0.22)) * 100)}%`;
    if (temp) temp.textContent = Number(getPath(settings, 'ai.temperature', 0.6)).toFixed(1);
  }

  /** 同步分段控件 / 卡片 / 面板显隐等派生状态。 */
  syncDerivedUi() {
    const settings = this.ensureView();
    const bgType = getPath(settings, 'background.type', 'bing');
    const provider = getPath(settings, 'ai.provider', 'yuanbao');
    const gradient = getPath(settings, 'background.gradient', 'forest');

    this.root.querySelectorAll('[data-bgtype]').forEach((button) => {
      button.setAttribute(
        'data-active',
        button.getAttribute('data-bgtype') === bgType ? 'true' : 'false',
      );
    });

    const panes = ['bing', 'wallhaven', 'we', 'static', 'video', 'gradient'];
    panes.forEach((name) => {
      const pane = this.root.querySelector(`[data-role="pane-${name}"]`);
      if (pane) pane.hidden = name !== bgType;
    });

    // WE 工坊面板：登录状态与当前固定壁纸提示
    if (bgType === 'we') {
      this.syncWeLogin();
      const currentRow = this.root.querySelector('[data-role="we-current"]');
      const currentText = this.root.querySelector('[data-role="we-current-text"]');
      if (currentRow && currentText) {
        const title = String(getPath(settings, 'background.weTitle', '') || '');
        currentRow.hidden = !title;
        if (title) {
          currentText.textContent = `当前固定壁纸：「${title}」（#${getPath(settings, 'background.weItemId', '')}）`;
        }
      }
    }

    // wallhaven：仅关键词模式显示输入框
    const queryRow = this.root.querySelector('[data-role="wh-query-row"]');
    if (queryRow) {
      queryRow.hidden = getPath(settings, 'background.wallhavenMode', 'daily') !== 'search';
    }

    // 图片地址来源提示（从壁纸库挑选的壁纸显示出处）
    const sourceHint = this.root.querySelector('[data-role="static-source"]');
    if (sourceHint) {
      const imageUrl = String(getPath(settings, 'background.imageUrl', '') || '');
      sourceHint.textContent = imageUrl.indexOf('w.wallhaven.cc') >= 0 ? '当前壁纸来自 wallhaven 壁纸库。' : '';
    }

    this.root.querySelectorAll('[data-provider]').forEach((card) => {
      card.setAttribute(
        'data-active',
        card.getAttribute('data-provider') === provider ? 'true' : 'false',
      );
    });

    // deepseek-search 与 deepseek 共用同一套密钥面板
    const paneId = provider === 'deepseek-search' ? 'deepseek' : provider;
    PROVIDER_IDS.forEach((id) => {
      const pane = this.root.querySelector(`[data-role="ppane-${id}"]`);
      if (pane) pane.hidden = id !== paneId;
    });

    this.root.querySelectorAll('[data-gradient]').forEach((button) => {
      button.setAttribute(
        'data-active',
        button.getAttribute('data-gradient') === gradient ? 'true' : 'false',
      );
    });
  }

  /** 渲染渐变主题色卡。 */
  renderSwatches() {
    const container = this.root.querySelector('[data-role="swatches"]');
    if (!container) return;
    container.textContent = '';
    Object.keys(GRADIENTS).forEach((key) => {
      const theme = GRADIENTS[key];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.setAttribute('data-gradient', key);
      button.style.background = `linear-gradient(150deg, ${theme.colors[1]}, ${theme.colors[3]} 55%, ${
        theme.colors[2]
      })`;
      const label = document.createElement('span');
      label.textContent = theme.name;
      button.appendChild(label);
      container.appendChild(button);
    });
    this.syncDerivedUi();
  }

  /** 渲染站点列表。 */
  renderSiteList() {
    if (!this.mounted) return;
    const container = this.root.querySelector('[data-role="site-list"]');
    if (!container) return;
    const sites = this.app.getSites();
    container.textContent = '';

    if (!sites.length) {
      const empty = document.createElement('div');
      empty.className = 'site-list-empty';
      empty.textContent = '还没有添加常用网站';
      container.appendChild(empty);
      return;
    }

    sites.forEach((site) => {
      const row = document.createElement('div');
      row.className = 'site-row';

      const iconBox = document.createElement('div');
      iconBox.className = 'sr-icon';
      iconBox.appendChild(createSiteIcon(site));

      const text = document.createElement('div');
      text.className = 'sr-text';
      const name = document.createElement('div');
      name.className = 'sr-name';
      name.textContent = site.title;
      const host = document.createElement('div');
      host.className = 'sr-host';
      host.textContent = hostOf(site.url) || site.url;
      text.appendChild(name);
      text.appendChild(host);

      const actions = document.createElement('div');
      actions.className = 'sr-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'icon-btn';
      editBtn.title = '编辑';
      editBtn.setAttribute('data-site-act', 'edit');
      editBtn.setAttribute('data-site-id', site.id);
      editBtn.innerHTML = icon('edit');

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'icon-btn danger';
      delBtn.title = '删除';
      delBtn.setAttribute('data-site-act', 'delete');
      delBtn.setAttribute('data-site-id', site.id);
      delBtn.innerHTML = icon('trash');

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(iconBox);
      row.appendChild(text);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  /* ------------------------------ 测试连接 ------------------------------ */

  setTestState(kind, state, text) {
    const line = this.root.querySelector(`[data-role="test-${kind}"]`);
    const label = this.root.querySelector(`[data-role="test-${kind}-text"]`);
    if (!line || !label) return;
    line.setAttribute('data-state', state);
    label.textContent = text;
    const dot = line.querySelector('.dot');
    if (dot) dot.classList.toggle('pulse', state === 'loading');
  }

  async runTest(kind) {
    if (this.testing[kind]) return;
    this.testing[kind] = true;
    this.setTestState(kind, 'loading', '正在测试连接…');
    const secrets = this.app.getSecrets();

    try {
      let latency = 0;
      if (kind === 'deepseek') {
        latency = await testOpenAiCompatible({
          baseUrl: secrets.deepseek.baseUrl,
          apiKey: secrets.deepseek.apiKey,
        });
        // 联网搜索开关打开时，额外真实跑一次 /v1/tools/search，确认搜索可用
        if (secrets.deepseek.webSearch !== false) {
          const search = await testDeepseekSearch(secrets.deepseek);
          const count = Number.isFinite(search.results) ? search.results : 0;
          this.setTestState(
            kind,
            'ok',
            `对话与联网搜索均可用，合计延迟 ${latency + search.latency} ms · 本次搜索返回 ${count} 条结果`,
          );
          return;
        }
      } else if (kind === 'custom') {
        latency = await testOpenAiCompatible({
          baseUrl: secrets.custom.baseUrl,
          apiKey: secrets.custom.apiKey,
          authHeader: secrets.custom.authHeader,
          authPrefix: secrets.custom.authPrefix,
        });
      } else {
        const result = await testYuanbao(secrets.yuanbao);
        latency = result.latency;
        if (Number.isFinite(result.results)) {
          const authLabel = result.auth === 'TC3' ? '云 API 签名' : 'Bearer';
          const versionLabel = result.version ? ` · 账号版本 ${result.version}` : '';
          this.setTestState(
            kind,
            'ok',
            `连接正常（${authLabel}），延迟 ${latency} ms · 返回 ${result.results} 条结果${versionLabel}`,
          );
          return;
        }
      }
      this.setTestState(kind, 'ok', `连接正常，延迟 ${latency} ms`);
    } catch (err) {
      this.setTestState(kind, 'err', describeError(err));
    } finally {
      this.testing[kind] = false;
    }
  }

  /* ------------------------------ 开关 ------------------------------ */

  /** 打开抽屉，可选定位到某个分组。 */
  open(section) {
    this.mount();
    this.syncValues();
    this.renderSiteList();
    this.openState = true;
    this.root.classList.add('is-open');
    this.root.setAttribute('aria-hidden', 'false');
    this.backdrop.hidden = false;
    // 强制重排以触发过渡
    void this.backdrop.offsetHeight;
    this.backdrop.classList.add('is-open');
    this.onOpen();

    if (section) {
      const el = this.root.querySelector(`#sec-${section}`);
      if (el) {
        el.open = true;
        window.setTimeout(() => {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
      }
    }
  }

  /** 关闭抽屉。 */
  close() {
    if (!this.openState) return false;
    this.persistSettings.flush();
    this.persistSecrets.flush();
    this.openState = false;
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.backdrop.classList.remove('is-open');
    window.setTimeout(() => {
      if (!this.openState) this.backdrop.hidden = true;
    }, 240);
    this.onClose();
    return true;
  }

  isOpen() {
    return this.openState;
  }

  /** 站点头部摘要（用于调试/展示）。 */
  summary() {
    const settings = this.app.getSettings();
    const secrets = this.app.getSecrets();
    const ids = PROVIDER_IDS.slice();
    const configured = ids.filter((id) => hasCredentials(id, secrets));
    return {
      engine: findEngine(settings.search.defaultEngine).name,
      provider: PROVIDER_META[settings.ai.provider]
        ? PROVIDER_META[settings.ai.provider].name
        : '未知',
      configured,
    };
  }
}
