/**
 * we-shop.js — 壁纸工坊（Wallpaper Engine 创意工坊全屏浏览页）
 * 大搜索框 + 标签/排序 chips 筛选 + 大卡片网格 + 翻页；
 * 详情弹窗：动态视频预览、一键订阅并应用到桌面、设为起始页背景、加入每日轮换。
 * 从起始页顶栏按钮或设置 → WE 工坊面板进入。
 */

import { openModal, toast } from './dialog.js';
import { icon } from './icons.js';
import { describeError, getPath } from './utils.js';
import {
  cloudAssetUrl,
  cloudIsCoolingDown,
  fetchWebFileList,
  webAssetUrl,
  cloudThumbUrl,
  describeCloudMedia,
  describeCloudState,
  fetchCloudLibraryIds,
  fetchCloudWallpaper,
  isCloudReady,
  prepareCloudWallpaper,
  readCloudConfig,
  waitCloudReady,
} from './we-cloud.js';
import { getHandoffDir, getLivelyDir, saveHandoffDir, saveLivelyDir, writeDirFile, writeHandoffFile } from './we-cache.js';
import {
  getLocalPreviewUrl,
  getLocalWallpaper,
  loadLocalLibrary,
  syncLocalLibrary,
} from './we-local.js';
import {
  KIND_LABELS,
  WE_AGES,
  WE_RESOLUTIONS,
  WE_SORTS,
  WE_TAGS,
  WE_TYPES,
  browseWorkshop,
  buildApplySteamUrl,
  fetchDetails,
  fetchPreviewAssets,
  getSteamSession,
  loadWeHistory,
  loadWeLibrary,
  parseWorkshopTags,
  probePreviewMedia,
  recordWeApply,
  saveWeLibrary,
  startPageCapability,
  subscribeItem,
  unsubscribeItem,
} from './weworkshop.js';

/**
 * 一句话说明这张预览素材到底是什么规格。
 * 关键在于如实区分「预览件」和「壁纸本体」——两者常被用户混为一谈。
 * @param {{width:number,height:number,animated:boolean}|null} probe
 * @param {{resolution:{label:string}|null}} profile
 */
function describePreviewMedia(probe, profile) {
  const target = profile && profile.resolution ? profile.resolution.label : '';
  const parts = [];
  if (!probe) {
    parts.push('预览素材未解析');
  } else if (probe.animated) {
    parts.push(`动态预览 ${probe.width}×${probe.height}（Steam 只给低清动图）`);
  } else if (probe.width) {
    parts.push(`预览图 ${probe.width}×${probe.height}`);
  }
  if (target) parts.push(`壁纸本体 ${target}`);
  return parts.join(' · ');
}

export class WorkshopShop {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root #we-shop
   * @param {object} options.app 应用上下文（updateSettings / getSettings）
   * @param {Function} [options.onToast] (message, type) => void
   */
  constructor({ root, app, onToast }) {
    this.root = root;
    this.app = app;
    this.onToast = typeof onToast === 'function' ? onToast : (message, type) => toast(message, type);
    this.mounted = false;
    this.openState = false;
    this.loaded = false;
    this.state = {
      query: '',
      sort: 'trending',
      tag: '',
      type: '', // 壁纸类型：'' | Video | Scene | Web | Application
      res: '', // 分辨率筛选：'' | '3840 x 2160' | ...
      age: 'safe', // 内容分级：everyone（仅全年龄）| safe（排除成人，默认）| all
      page: 1,
      hasPrev: false,
      hasNext: false,
      loading: false,
    };
  }

  /* ------------------------------ 构建 ------------------------------ */

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    this.root.innerHTML = `
      <div class="ws-shell">
        <header class="ws-top">
          <div class="ws-brand">
            <span class="ws-brand-badge">${icon('image')}</span>
            <div class="ws-brand-text"><b>壁纸工坊</b><small>Wallpaper Engine 创意工坊</small></div>
          </div>
          <div class="ws-search">
            <input class="ws-q" type="text" data-role="ws-q" placeholder="搜索创意工坊壁纸，回车搜索…" autocomplete="off" />
            <button class="ws-clear" type="button" data-role="ws-clear" title="清空" hidden>×</button>
            <button class="ws-go" type="button" data-role="ws-go">搜索</button>
          </div>
          <button class="ws-chip" type="button" data-role="ws-history" title="应用过的壁纸">🕘 历史</button>
          <div class="ws-sorts" data-role="ws-sorts">
            ${WE_SORTS.map((sort) => `<button class="ws-chip" type="button" data-sort="${sort.value}">${sort.label}</button>`).join('')}
          </div>
          <button class="icon-btn ws-close" type="button" data-role="ws-close" title="关闭（Esc）" aria-label="关闭壁纸工坊">${icon('close')}</button>
        </header>

        <nav class="ws-tags" data-role="ws-types">
          <span class="ws-age-label">类型</span>
          ${WE_TYPES.map((item) => `<button class="ws-chip" type="button" data-type="${item.value}">${item.label}</button>`).join('')}
        </nav>

        <nav class="ws-tags" data-role="ws-tags">
          ${WE_TAGS.map((tag) => `<button class="ws-chip" type="button" data-tag="${tag.value}">${tag.label}</button>`).join('')}
        </nav>

        <nav class="ws-tags" data-role="ws-meta">
          <span class="ws-age-label">分辨率</span>
          <select class="ws-select" data-role="ws-res" aria-label="分辨率">
            ${WE_RESOLUTIONS.map((item) => `<option value="${item.value}">${item.label}</option>`).join('')}
          </select>
          <span class="ws-age-group">
            <span class="ws-age-label">内容分级</span>
            ${WE_AGES.map((item) => `<button class="ws-chip" type="button" data-age="${item.value}">${item.label}</button>`).join('')}
          </span>
        </nav>

        <div class="ws-login-tip" data-role="ws-login-tip" hidden>
          <span class="ws-login-text">Steam 未登录：浏览和「设为起始页背景」可用，「订阅 + 应用到桌面」需要先在浏览器登录 Steam</span>
          <button class="ws-login-btn" type="button" data-role="ws-login-go">一键去登录</button>
        </div>

        <main class="ws-body scroll-thin">
          <div class="ws-status" data-role="ws-status">输入关键词或直接浏览热门壁纸</div>
          <div class="ws-grid" data-role="ws-grid"></div>
        </main>

        <footer class="ws-foot">
          <button class="ws-page" type="button" data-role="ws-prev" disabled>‹ 上一页</button>
          <span class="ws-page-label" data-role="ws-page-label">第 1 页</span>
          <button class="ws-page" type="button" data-role="ws-next" disabled>下一页 ›</button>
          <span class="ws-count" data-role="ws-count"></span>
        </footer>
      </div>
    `;

    const qInput = this.root.querySelector('[data-role="ws-q"]');
    const clearBtn = this.root.querySelector('[data-role="ws-clear"]');

    this.root.querySelector('[data-role="ws-go"]').addEventListener('click', () => {
      this.state.query = qInput.value;
      this.load(true);
    });
    qInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.state.query = qInput.value;
        this.load(true);
      }
    });
    qInput.addEventListener('input', () => {
      clearBtn.hidden = !qInput.value;
    });
    clearBtn.addEventListener('click', () => {
      qInput.value = '';
      clearBtn.hidden = true;
      qInput.focus();
      if (this.state.query) {
        this.state.query = '';
        this.load(true);
      }
    });

    this.root.querySelector('[data-role="ws-sorts"]').addEventListener('click', (event) => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      this.state.sort = button.getAttribute('data-sort');
      // 切排序时清掉搜索词，避免仍停留在相关性排序
      if (this.state.query) {
        this.state.query = '';
        qInput.value = '';
        clearBtn.hidden = true;
      }
      this.syncChips();
      this.load(true);
    });

    this.root.querySelector('[data-role="ws-types"]').addEventListener('click', (event) => {
      const typeBtn = event.target.closest('[data-type]');
      if (!typeBtn) return;
      this.state.type = typeBtn.getAttribute('data-type');
      this.syncChips();
      this.load(true);
    });

    const resSelect = this.root.querySelector('[data-role="ws-res"]');
    if (resSelect) {
      resSelect.addEventListener('change', () => {
        this.state.res = resSelect.value;
        this.load(true);
      });
    }

    // 分类 chips 挂在 ws-tags 容器里；内容分级在 ws-meta——两棵子树分开监听
    this.root.querySelector('[data-role="ws-tags"]').addEventListener('click', (event) => {
      const tagBtn = event.target.closest('[data-tag]');
      if (!tagBtn) return;
      this.state.tag = tagBtn.getAttribute('data-tag');
      this.syncChips();
      this.load(true);
    });

    this.root.querySelector('[data-role="ws-meta"]').addEventListener('click', (event) => {
      const ageBtn = event.target.closest('[data-age]');
      if (!ageBtn) return;
      this.state.age = ageBtn.getAttribute('data-age');
      this.syncChips();
      this.load(true);
    });

    this.root.querySelector('[data-role="ws-prev"]').addEventListener('click', () => {
      if (this.state.hasPrev && this.state.page > 1) {
        this.state.page -= 1;
        this.load(false, true);
      }
    });
    this.root.querySelector('[data-role="ws-next"]').addEventListener('click', () => {
      if (this.state.hasNext) {
        this.state.page += 1;
        this.load(false, true);
      }
    });

    this.root.querySelector('[data-role="ws-close"]').addEventListener('click', () => this.close());

    const historyBtn = this.root.querySelector('[data-role="ws-history"]');
    if (historyBtn) historyBtn.addEventListener('click', () => this.openHistory());

    const loginGo = this.root.querySelector('[data-role="ws-login-go"]');
    if (loginGo) {
      loginGo.addEventListener('click', () => {
        window.open('https://steamcommunity.com/login/', '_blank', 'noopener');
      });
    }

    // 从登录页切回来时自动刷新登录状态（横幅消失即代表可订阅）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.openState) this.refreshLoginState();
    });

    this.syncChips();
  }

  /** 检查 Steam 登录态：未登录则显示顶部提示横幅（含一键登录入口）。 */
  async refreshLoginState() {
    const tip = this.root.querySelector('[data-role="ws-login-tip"]');
    if (!tip) return;
    const { loggedIn } = await getSteamSession().catch(() => ({ loggedIn: false }));
    const wasShowing = !tip.hidden;
    tip.hidden = loggedIn;
    // 横幅刚消失 = 用户刚登录回来：登录态影响列表可见内容（年龄门控），自动重刷
    if (wasShowing && loggedIn && this.loaded) {
      this.onToast('检测到 Steam 已登录，正在按你的账号偏好刷新列表', 'ok');
      this.load(true);
    }
  }

  /** 高亮当前排序 / 类型 / 分类 / 分级 chip，同步分辨率下拉。 */
  syncChips() {
    this.root.querySelectorAll('[data-sort]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-sort') === this.state.sort ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-type]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-type') === this.state.type ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-tag]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-tag') === this.state.tag ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-age]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-age') === this.state.age ? 'true' : 'false');
    });
    const resSelect = this.root.querySelector('[data-role="ws-res"]');
    if (resSelect) resSelect.value = this.state.res;
  }

  /* ------------------------------ 列表 ------------------------------ */

  /**
   * 加载列表。
   * @param {boolean} reset 重置到第一页并清空网格
   * @param {boolean} keepPage 翻页时保留页码（reset 优先）
   */
  async load(reset, keepPage) {
    if (this.state.loading) return;
    const grid = this.root.querySelector('[data-role="ws-grid"]');
    const statusEl = this.root.querySelector('[data-role="ws-status"]');
    if (reset) {
      this.state.page = 1;
      grid.textContent = '';
    } else if (!keepPage) {
      this.state.page = 1;
    }

    this.state.loading = true;
    statusEl.hidden = false;
    statusEl.textContent = '正在从创意工坊加载…';
    try {
      // 每次加载刷新一次云端配置：缩略图中转按它决定走云端还是 Steam 原图
      this._cloudConfig = this.cloudConfig();
      const result = await browseWorkshop({
        query: this.state.query,
        sort: this.state.sort,
        tag: this.state.tag,
        type: this.state.type,
        res: this.state.res,
        age: this.state.age,
        page: this.state.page,
      });
      this.state.hasPrev = result.hasPrev;
      this.state.hasNext = result.hasNext;
      grid.textContent = '';
      result.items.forEach((item) => grid.appendChild(this.buildCard(item)));
      if (result.items.length) {
        statusEl.hidden = true;
        this.annotateKinds(grid, result.items);
        this.markLocalWallpapers(grid, result.items);
        void this.markCloudWallpapers(grid, result.items);
      } else if (this.state.page > 1) {
        statusEl.textContent = '没有更多了';
        this.state.hasNext = false;
        this.root.querySelector('[data-role="ws-next"]').disabled = true;
      } else {
        statusEl.textContent = '没有找到符合条件的壁纸，换个关键词或分类试试';
      }
      this.root.querySelector('[data-role="ws-page-label"]').textContent = `第 ${this.state.page} 页`;
      this.root.querySelector('[data-role="ws-count"]').textContent = result.total
        ? `共 ${result.total.toLocaleString('zh-CN')} 张 · 本页 ${result.items.length} 张`
        : `本页 ${result.items.length} 张`;
      this.root.querySelector('[data-role="ws-prev"]').disabled = !result.hasPrev;
      this.root.querySelector('[data-role="ws-next"]').disabled = !result.hasNext;
      this.loaded = true;
    } catch (err) {
      statusEl.hidden = false;
      statusEl.textContent = `加载失败：${describeError(err)}`;
      // 出错时直接给下一步：一键重试，不用关掉面板重进
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ws-retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => this.load(true));
      statusEl.appendChild(retry);
    } finally {
      this.state.loading = false;
    }
  }

  /**
   * 标出哪些壁纸本地已经有原图，并把新下载的补进本地库。
   *
   * 这是「订阅 → 可用」闭环的关键一步：用户在工坊点订阅，Steam 客户端在后台下完，
   * 下次打开工坊时这里会自动发现并收进来——不用开 WE、不用手动重扫。
   * 目录授权失效时静默跳过，只在有新增时提示一句。
   */
  async markLocalWallpapers(grid, items) {
    try {
      const ids = items.map((item) => String(item.id));
      // 先补漏：本地已有但还没入库的（比如刚订阅下载完的那几张）
      const sync = await syncLocalLibrary(ids);
      const library = await loadLocalLibrary();
      const localIds = new Set(Object.keys(library.items || {}));

      for (const item of items) {
        if (!localIds.has(String(item.id))) continue;
        const card = grid.querySelector(`[data-id="${item.id}"]`);
        if (!card || card.querySelector('.ws-local-tag')) continue;
        const tag = document.createElement('span');
        tag.className = 'ws-local-tag';
        tag.textContent = '本地原图';
        card.appendChild(tag);
      }

      if (sync && sync.added > 0) {
        this.onToast(`本地库里补入 ${sync.added} 张原图`, 'ok');
      }
    } catch (err) {
      /* 标注失败不影响浏览 */
    }
  }

  /**
   * 标出云端已经缓存过的壁纸。
   * 只发一次 /api/library，失败静默——这是提示，不该影响浏览。
   */
  async markCloudWallpapers(grid, items) {
    const config = this.cloudConfig();
    if (!config) return;
    const ids = await fetchCloudLibraryIds(config);
    if (!ids || !ids.size) return;
    for (const item of items) {
      if (!ids.has(String(item.id))) continue;
      const card = grid.querySelector(`[data-id="${item.id}"]`);
      if (!card || card.querySelector('.ws-cloud-tag')) continue;
      const tag = document.createElement('span');
      tag.className = 'ws-cloud-tag';
      tag.textContent = '云端';
      tag.title = '服务端已缓存这张壁纸的原图 / 视频，点开可看原片';
      card.appendChild(tag);
    }
  }

  /**
   * 批量补上类型标记（视频 / 3D 场景 / 网页…）。
   *
   * 视频类的预览件只是 192px 的动图，放大到卡片尺寸必然发虚——不标一句
   * 很容易被当成「加载失败」。标签只能靠详情接口拿，所以一次批量请求补齐。
   */
  annotateKinds(grid, items) {
    fetchDetails(items.map((item) => item.id))
      .then((list) => {
        for (const detail of list) {
          if (!detail || !detail.publishedfileid) continue;
          const profile = parseWorkshopTags(detail.tags);
          if (!profile.kind) continue;
          const card = grid.querySelector(`[data-id="${detail.publishedfileid}"]`);
          if (!card || card.querySelector('.ws-kind')) continue;
          const badge = document.createElement('span');
          badge.className = `ws-kind ws-kind-${profile.kind}`;
          badge.textContent = KIND_LABELS[profile.kind] || profile.kind;
          card.appendChild(badge);
          if (profile.resolution) {
            card.title = `${detail.title || ''} · ${profile.resolution.label}`;
          }
        }
      })
      .catch(() => {
        /* 类型标记是锦上添花，拿不到不影响浏览 */
      });
  }

  /** 构造单张壁纸卡片（大图 + 常显标题）。 */
  buildCard(item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ws-card';
    card.dataset.id = item.id;
    card.title = `${item.title}（#${item.id}）`;
    card.innerHTML = `
      <img class="ws-img" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" />
      <span class="ws-info"><span class="ws-title"></span><span class="ws-sub">#${item.id}</span></span>
    `;
    const img = card.querySelector('.ws-img');
    // 缩略图走云端中转（Steam 图床在国内单张十几秒，30 张串行能把列表拖成全黑）；
    // 中转不可用（服务端没实现 / 云端未配置）时回退 Steam 原图
    const thumb = cloudThumbUrl(this._cloudConfig, item.preview, 512);
    if (thumb) {
      let fellBack = false;
      img.addEventListener('error', () => {
        if (fellBack || !item.preview) return;
        fellBack = true;
        img.src = item.preview;
      });
      img.src = thumb;
    } else {
      img.src = item.preview;
    }
    card.querySelector('.ws-title').textContent = item.title;
    card.addEventListener('click', () => this.openDetail(item));
    return card;
  }

  /* ------------------------------ 应用历史 ------------------------------ */

  /** 应用历史面板：最近用过的壁纸，点击进详情可再次应用。 */
  async openHistory() {
    const wrap = document.createElement('div');
    const list = await loadWeHistory();
    wrap.className = 'ws-hist';
    if (!list.length) {
      wrap.innerHTML = '<div class="ws-status">还没有应用过壁纸——挑一张「设为起始页背景」后就会出现在这里</div>';
    } else {
      wrap.innerHTML = `
        <div class="ws-grid ws-hist-grid">
          ${list
            .map(
              (entry) => `
            <button class="ws-card" type="button" data-id="${entry.id}">
              <img class="ws-img" loading="lazy" decoding="async" alt="" referrerpolicy="no-referrer" />
              <span class="ws-info"><span class="ws-title"></span><span class="ws-sub"></span></span>
            </button>`,
            )
            .join('')}
        </div>
        <div class="ws-status">按最近应用排序 · 点击卡片查看详情并再次应用</div>
      `;
      const buttons = wrap.querySelectorAll('.ws-card');
      list.forEach((entry, index) => {
        const card = buttons[index];
        const img = card.querySelector('.ws-img');
        const thumb = cloudThumbUrl(this._cloudConfig || this.cloudConfig(), entry.preview, 512);
        if (thumb) {
          let fellBack = false;
          img.addEventListener('error', () => {
            if (fellBack || !entry.preview) return;
            fellBack = true;
            img.src = entry.preview;
          });
          img.src = thumb;
        } else if (entry.preview) {
          img.src = entry.preview;
        }
        card.querySelector('.ws-title').textContent = entry.title || `#${entry.id}`;
        card.querySelector('.ws-sub').textContent = new Date(entry.at).toLocaleString('zh-CN', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        card.addEventListener('click', () => this.openDetail(entry));
      });
    }

    const handle = openModal({ title: '应用历史', content: wrap });
    handle.el.style.width = 'min(920px, 94vw)';
  }

  /* ------------------------------ 详情 ------------------------------ */

  /** 当前云服务配置（未配置返回 null）。 */
  cloudConfig() {
    try {
      const settings = (this.app.getSettings && this.app.getSettings()) || {};
      const secrets = (this.app.getSecrets && this.app.getSecrets()) || {};
      const config = readCloudConfig(settings.background || {}, secrets);
      return isCloudReady(config) ? config : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * 查询云端状态。
   * 返回结构区分「服务说你没有这张」和「服务根本没连上」——前者是正常状态，
   * 后者要如实告诉用户，否则会误以为服务在跑只是没缓存。
   * @returns {Promise<{record: object|null, failed: boolean}>}
   */
  async queryCloud(id, config) {
    if (!config) return { record: null, failed: false };
    // 刚连不上过就先跳过，别让每次打开详情都白等一个超时
    if (cloudIsCoolingDown()) return { record: null, failed: true };
    try {
      // fetchCloudWallpaper 内部已经规范化过，直接用
      const record = await fetchCloudWallpaper(config, id, { timeout: 6000 });
      return { record, failed: false };
    } catch (err) {
      return { record: null, failed: true };
    }
  }

  /** 详情弹窗：左侧按素材真实比例预览，右侧给出类型/分辨率/效果与起始页能力。 */
  openDetail(item) {
    // 本地原图走的是 blob 地址，弹窗关闭时要还回去
    let localObjectUrl = '';
    const media = document.createElement('div');
    media.className = 'ws-detail';
    media.innerHTML = `
      <div class="ws-detail-stage">
        <div class="ws-detail-frame">
          <img class="ws-detail-img" alt="壁纸预览" referrerpolicy="no-referrer" />
        </div>
        <div class="ws-detail-caption">预览素材加载中…</div>
      </div>
      <aside class="ws-detail-side">
        <h3 class="ws-detail-title"></h3>
        <div class="ws-detail-chips"></div>
        <div class="ws-detail-cap"></div>
        <dl class="ws-detail-stats"></dl>
        <div class="ws-cloud" data-role="ws-cloud" hidden></div>
        <div class="ws-startpage">
          <div class="ws-sp-canvas">
            <div class="ws-sp-bg" aria-hidden="true"></div>
            <img class="ws-sp-img" alt="起始页效果预览" referrerpolicy="no-referrer" />
          </div>
          <div class="ws-sp-note"></div>
        </div>
        <div class="ws-detail-id"></div>
      </aside>
    `;

    const img = media.querySelector('.ws-detail-img');
    const captionEl = media.querySelector('.ws-detail-caption');
    const chipsEl = media.querySelector('.ws-detail-chips');
    const capEl = media.querySelector('.ws-detail-cap');

    media.querySelector('.ws-detail-title').textContent = item.title;
    media.querySelector('.ws-detail-id').textContent = `创意工坊 #${item.id}`;
    img.src = item.preview || '';

    // 列表缩略图先顶上，再补全规格——网络慢也不至于整块空白
    fetchPreviewAssets(item.id)
      .then(async (assets) => {
        if (!document.body.contains(media)) return;
        const detail = (assets && assets.detail) || null;
        const profile = parseWorkshopTags(detail && detail.tags);

        // 徽章：类型 / 壁纸本体分辨率 / 分级
        chipsEl.replaceChildren();
        const addChip = (text, tone) => {
          const chip = document.createElement('span');
          chip.className = `ws-chip ws-chip-${tone}`;
          chip.textContent = text;
          chipsEl.appendChild(chip);
        };
        if (profile.kind) addChip(KIND_LABELS[profile.kind] || profile.kind, 'kind');
        if (profile.resolution) addChip(profile.resolution.label, 'res');
        else addChip('分辨率未标注', 'muted');
        if (profile.maturity && profile.maturity !== 'Everyone') addChip(profile.maturity, 'warn');

        // 效果：音频响应 / 木偶变形 / 可自定义等
        if (profile.features.length) {
          const row = document.createElement('div');
          row.className = 'ws-features';
          const labelEl = document.createElement('span');
          labelEl.className = 'ws-feature-label';
          labelEl.textContent = '效果';
          row.appendChild(labelEl);
          profile.features.forEach((name) => {
            const tag = document.createElement('span');
            tag.className = 'ws-feature';
            tag.textContent = name;
            row.appendChild(tag);
          });
          chipsEl.after(row);
        }

        // 起始页能力：说清楚「能还原到什么程度」。
        // 先按 Steam 素材给一版，云端查完若能力更强再刷新（避免为等网络拖慢首屏）
        const renderCapability = (cloudState) => {
          const capability = startPageCapability(profile, cloudState);
          capEl.className = `ws-detail-cap is-${capability.level}`;
          capEl.innerHTML =
            '<span class="ws-cap-dot"></span><span class="ws-cap-body"><b></b><i></i></span>';
          capEl.querySelector('b').textContent = capability.title;
          capEl.querySelector('i').textContent = capability.detail;
        };
        renderCapability(null);

        // 统计
        const subs = Number(detail && detail.subscriptions) || 0;
        const favs = Number(detail && detail.favorited) || 0;
        const sizeMb = detail && detail.file_size ? (detail.file_size / 1024 / 1024).toFixed(1) : '?';
        const updated =
          detail && detail.time_updated
            ? new Date(detail.time_updated * 1000).toLocaleDateString('zh-CN')
            : '?';
        const statsEl = media.querySelector('.ws-detail-stats');
        statsEl.replaceChildren();
        [
          ['订阅', subs.toLocaleString('zh-CN')],
          ['收藏', favs.toLocaleString('zh-CN')],
          ['文件大小', `${sizeMb} MB`],
          ['最近更新', updated],
        ].forEach(([label, value]) => {
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          statsEl.append(dt, dd);
        });

        // 预览素材优先级：云端直链（作者原图 / 完整视频）> 本地 WE 目录 > Steam 原件
        const full = (assets && assets.image) || item.preview;
        const cloud = this.cloudConfig();
        let cloudProbe = cloud
          ? await this.queryCloud(item.id, cloud)
          : { record: null, failed: false };
        // 未缓存的条目首次查询是「下载中」——就地轮询等它就绪（首次触发下载
        // 是云端的标准流程），就绪后能力文案与预览自动升级，不用用户重开详情
        if (
          cloud &&
          cloudProbe.record &&
          ['downloading', 'queued'].includes(cloudProbe.record.state)
        ) {
          const pendingEl = media.querySelector('[data-role="ws-cloud"]');
          if (pendingEl && !pendingEl.hidden) {
            const label = pendingEl.querySelector('span');
            if (label) label.textContent = '云端正在下载壁纸素材，就绪后原图/动态画面会自动升级…';
          }
          const finalRecord = await waitCloudReady(cloud, item.id, {
            timeout: 90000,
            interval: 4000,
            shouldContinue: () => document.body.contains(media),
          });
          if (!document.body.contains(media)) return;
          if (finalRecord && finalRecord.state === 'ready') {
            cloudProbe = { record: finalRecord, failed: false };
          }
        }
        const cloudRecord = cloudProbe.record;
        if (!document.body.contains(media)) return;
        const cloudReady = Boolean(cloudRecord && cloudRecord.state === 'ready');
        const cloudPreview = cloudReady ? cloudAssetUrl(cloud, item.id, 'preview') : '';
        const cloudVideo = cloudReady && cloudRecord.video ? cloudAssetUrl(cloud, item.id, 'video') : '';
        // 云端已就绪就不必再下载 Steam 那张 1024 压缩件
        const probe = cloudReady ? null : await probePreviewMedia(full);
        if (!document.body.contains(media)) return;

        // 云端状态行：没配置服务就不显示；配置了就把服务端真实状态讲清楚
        const cloudEl = media.querySelector('[data-role="ws-cloud"]');
        if (cloudEl && cloud) {
          const state = cloudProbe.failed
            ? { tone: 'warn', text: '云端连接失败，已回落到 Steam / 本地素材' }
            : describeCloudState(cloudRecord);
          cloudEl.hidden = false;
          cloudEl.dataset.tone = state.tone;
          cloudEl.innerHTML = `${icon('database')}<span></span>`;
          cloudEl.querySelector('span').textContent = cloudReady
            ? `云端已就绪${cloudRecord.video ? ' · 含完整视频' : ''}`
            : state.text;
        }
        // 云端有完整视频时，起始页能力从「静态预览」升级为「完整动态播放」
        if (cloudReady) renderCapability(cloudRecord);

        // 本地 WE 目录里是作者上传的原图，Steam 那张 1024 只是它的压缩件
        const local = cloudReady ? null : await getLocalWallpaper(item.id);
        const localUrl = local && local.mediaId ? await getLocalPreviewUrl(item.id) : '';
        if (!document.body.contains(media)) return;
        if (localUrl) localObjectUrl = localUrl;

        let source = (probe && probe.objectUrl) || full;
        let cloudVideoEl = null;
        if (cloudPreview) {
          source = cloudPreview;
          img.classList.remove('is-lowres');
          const parts = [describeCloudMedia(cloudRecord)];
          if (profile.resolution) parts.push(`壁纸本体 ${profile.resolution.label}`);
          captionEl.textContent = parts.filter(Boolean).join(' · ');
          // 有完整成片就换成可播放的 <video>——Steam 那边只给 192px 动图
          if (cloudVideo) {
            cloudVideoEl = document.createElement('video');
            cloudVideoEl.className = 'ws-detail-img ws-detail-video';
            cloudVideoEl.src = cloudVideo;
            cloudVideoEl.autoplay = true;
            cloudVideoEl.loop = true;
            cloudVideoEl.muted = true;
            cloudVideoEl.playsInline = true;
            cloudVideoEl.preload = 'metadata';
            cloudVideoEl.setAttribute('playsinline', '');
            cloudVideoEl.setAttribute('muted', '');
            const playPromise = cloudVideoEl.play();
            if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
            // 服务端 ffprobe 可能缺失或不准，视频元数据到手后按实际分辨率改写说明
            cloudVideoEl.addEventListener('loadedmetadata', () => {
              if (!cloudVideoEl.videoWidth || !document.body.contains(media)) return;
              const parts = [];
              if (cloudRecord.preview.width && cloudRecord.preview.height) {
                parts.push(`云端原图 ${cloudRecord.preview.width}×${cloudRecord.preview.height}`);
              }
              parts.push(`完整视频 ${cloudVideoEl.videoWidth}×${cloudVideoEl.videoHeight}`);
              if (profile.resolution) parts.push(`壁纸本体 ${profile.resolution.label}`);
              captionEl.textContent = parts.join(' · ');
            });
          }
        } else if (localUrl) {
          source = localUrl;
          img.classList.remove('is-lowres');
          const parts = [`本地原图 ${local.width}×${local.height}`];
          if (profile.resolution) parts.push(`壁纸本体 ${profile.resolution.label}`);
          if (local.video) parts.push('含成片视频');
          captionEl.textContent = parts.join(' · ');
        } else {
          // 视频类的预览件只有 192px，按容器放大到可辨认的尺寸（会略糊，但总好过指甲盖大小）
          if (probe && probe.width && probe.width < 640) img.classList.add('is-lowres');
          else img.classList.remove('is-lowres');
          captionEl.textContent = describePreviewMedia(probe, profile);
        }
        if (cloudVideoEl) img.replaceWith(cloudVideoEl);
        else if (source) img.src = source;

        // 网页壁纸：云端 serve 了项目目录时，详情里直接实时运行（与起始页同一套沙箱）
        if (!cloudVideoEl && profile.kind === 'web' && cloudReady && cloudRecord.web && cloud) {
          const frame = document.createElement('iframe');
          frame.className = 'ws-detail-img ws-web-frame';
          frame.title = '网页壁纸实时预览';
          frame.src = cloudAssetUrl(cloud, item.id, 'web');
          frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-pointer-lock');
          frame.setAttribute('scrolling', 'no');
          frame.style.border = '0';
          frame.style.background = '#000';
          img.replaceWith(frame);
          captionEl.textContent = '网页壁纸实时运行中（鼠标可交互）';
        }

        // 起始页效果：按当前显示方式先模拟一遍，方形素材铺到屏幕上到底什么样
        const spImg = media.querySelector('.ws-sp-img');
        const spBg = media.querySelector('.ws-sp-bg');
        const spCanvas = media.querySelector('.ws-sp-canvas');
        const spNote = media.querySelector('.ws-sp-note');
        if (source && spImg && spCanvas) {
          spImg.src = source;
          spBg.style.backgroundImage = `url("${source}")`;
          const background = this.app.getSettings().background || {};
          const weFit = background.weFit || 'cover';
          // 与背景引擎同一套判定：contain，或比例差 >15% 时改用「完整显示 + 虚化铺底」
          const screenRatio = (window.innerWidth || 1280) / (window.innerHeight || 720);
          // 有视频时背景会优先播视频铺满，按视频比例模拟才准
          let mediaRatio = screenRatio;
          if (cloudVideo && cloudRecord.video.width && cloudRecord.video.height) {
            mediaRatio = cloudRecord.video.width / cloudRecord.video.height;
          } else if (cloudReady && cloudRecord.preview.width && cloudRecord.preview.height) {
            mediaRatio = cloudRecord.preview.width / cloudRecord.preview.height;
          } else if (probe && probe.width && probe.height) {
            mediaRatio = probe.width / probe.height;
          }
          const ratioGap = Math.abs(mediaRatio - screenRatio) / screenRatio;
          // 与背景引擎同一套判定：显示方式完全由用户设置决定
          const useContain = weFit === 'contain';
          spCanvas.classList.toggle('is-contain', useContain);
          spNote.textContent = useContain
            ? '起始页效果：完整显示 + 同图虚化铺底'
            : ratioGap > 0.15
              ? '起始页效果：铺满屏幕（方形图会裁掉较多上下边缘，想看全图改「完整显示」）'
              : '起始页效果：铺满屏幕（两侧会被裁切）';
        }
      })
      .catch(() => {
        if (document.body.contains(media)) {
          captionEl.textContent = '预览素材获取失败，当前显示的是列表缩略图';
        }
      });

    openModal({
      title: '壁纸详情',
      content: media,
      // 宽度走 openModal 的 width（它设的是 max-width）；只改 el.style.width 会被 460px 上限截住
      width: 1120,
      onClose: () => {
        if (localObjectUrl) {
          URL.revokeObjectURL(localObjectUrl);
          localObjectUrl = '';
        }
      },
      actions: [
        {
          label: '订阅 + 应用到桌面',
          kind: 'primary',
          closeOnClick: false,
          onClick: async () => {
            await this.subscribeApply(item);
            return false;
          },
        },
        {
          label: '应用到桌面（免 Steam 静态）',
          kind: 'ghost',
          closeOnClick: false,
          onClick: async () => {
            try {
              await this.sendToDesktopTool(item);
            } catch (err) {
              if (err && err.name === 'AbortError') return false;
              this.onToast(`发送失败：${describeError(err)}`, 'error');
            }
            return false;
          },
        },
        {
          label: '安装到 Lively 桌面',
          kind: 'ghost',
          closeOnClick: false,
          onClick: async () => {
            try {
              await this.installToLively(item);
            } catch (err) {
              if (err && err.name === 'AbortError') return false;
              this.onToast(`安装失败：${describeError(err)}`, 'error');
            }
            return false;
          },
        },
        { label: '设为起始页背景', kind: 'ghost', onClick: () => this.applyBackground(item) },
        {
          label: '加入每日轮换',
          kind: 'ghost',
          closeOnClick: false,
          onClick: async () => {
            await this.addToLibrary(item);
            return false;
          },
        },
        {
          label: '工坊页面',
          kind: 'ghost',
          closeOnClick: false,
          onClick: () => {
            window.open(
              `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
              '_blank',
              'noopener',
            );
            return false;
          },
        },
        {
          label: '取消订阅',
          kind: 'ghost',
          closeOnClick: false,
          onClick: async () => {
            try {
              await unsubscribeItem(item.id);
              this.onToast('已取消订阅', 'ok');
            } catch (err) {
              this.onToast(describeError(err), 'error');
            }
            return false;
          },
        },
      ],
    }).el.style.width = 'min(1120px, 96vw)';
  }

  /** 订阅并（可选）延时应用到桌面 Wallpaper Engine。 */
  async subscribeApply(item) {
    try {
      await subscribeItem(item.id);
      this.onToast('已订阅，Steam 正在下载…', 'ok');
    } catch (err) {
      if (err && err.code === 'NO_LOGIN') {
        this.onToast(err.message, 'error');
        window.open('https://steamcommunity.com/login/', '_blank', 'noopener');
      } else {
        this.onToast(`订阅失败：${describeError(err)}`, 'error');
      }
      return;
    }

    const settings = this.app.getSettings();
    const bg = (settings && settings.background) || {};
    if (bg.weAutoApply === false) {
      this.onToast('下载完成后可在工坊页面手动应用（已关闭自动应用）', 'ok');
      return;
    }
    const delay = Math.min(300, Math.max(5, Number(bg.weApplyDelay) || 20));
    this.onToast(
      `将在 ${delay} 秒后自动应用到桌面（等 Steam 下载完成）。若桌面没换：检查 设置 → WE 工坊 → Workshop 内容目录 是否为本机 Steam 库路径（如 D:\\SteamLibrary\\steamapps\\workshop\\content\\431960）`,
      'ok',
    );
    window.setTimeout(() => this.fireSteamApply(item.id, bg.weWorkshopPath), delay * 1000);
  }

  /** 触发 steam:// 应用命令（首次 Chrome 会弹「打开 Steam」确认）。 */
  fireSteamApply(fileId, workshopPath) {
    const link = document.createElement('a');
    link.href = buildApplySteamUrl(fileId, workshopPath);
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  /** 设为起始页背景：云端原片优先，其次本地原图，最后 Steam 预览。 */
  async applyBackground(item) {
    const cloud = this.cloudConfig();
    if (cloud && (await this.applyCloudBackground(item, cloud))) return;
    await this.applyLocalOrSteamBackground(item);
  }

  /**
   * 走云端：已就绪立即生效；还在下载则先用现成素材顶上，后台等就绪后自动切换。
   * @returns {Promise<boolean>} 是否已由云端接管（false 表示调用方应回落到本地/Steam）
   */
  async applyCloudBackground(item, cloud) {
    let record = null;
    try {
      record = await prepareCloudWallpaper(cloud, item.id);
    } catch (err) {
      // 服务不可达就静默回落，别拿网络错误打断「换壁纸」这件事
      return false;
    }
    if (!record) return false;

    if (record.state === 'ready') {
      await this.applyCloudSettings(item, record);
      return true;
    }
    if (record.state === 'failed' || record.state === 'need_auth' || record.state === 'not_found') {
      this.onToast(`${describeCloudState(record).text}，改用可用素材`, 'warn');
      return false;
    }

    // downloading / queued：先用本地或 Steam 顶上，就绪后自动切换成云端的完整素材
    this.onToast('云端正在拉取这张壁纸，先用现有素材顶上，就绪后自动切换', 'ok');
    await this.applyLocalOrSteamBackground(item);
    const target = String(item.id);
    waitCloudReady(cloud, target, {
      interval: 4000,
      timeout: 300000,
      // 用户中途换了别的壁纸就别再动设置了
      shouldContinue: () => {
        const bg = ((this.app.getSettings() || {}).background) || {};
        return String(bg.weItemId || '') === target;
      },
    })
      .then(async (final) => {
        if (!final || final.state !== 'ready') return;
        const bg = ((this.app.getSettings() || {}).background) || {};
        if (String(bg.weItemId || '') !== target) return;
        await this.applyCloudSettings(item, final);
        this.onToast('云端原片已就绪，背景已切换为完整素材', 'ok');
      })
      .catch(() => {});
    return true;
  }

  /** 把云端素材写进背景设置（背景引擎会优先用云端直链，不占本地磁盘）。 */
  async applyCloudSettings(item, record) {
    // 应用动作立即进历史（背景引擎那侧也会记，去重逻辑保证只留一条）
    recordWeApply({ id: item.id, title: item.title, preview: item.preview || '' });
    await this.app.updateSettings({
      background: {
        type: 'we',
        weMode: 'fixed',
        weItemId: item.id,
        weTitle: item.title,
        // 云端就绪标记：背景引擎据此走直链；同时留一张 Steam 缩略图做兜底
        weCloudItemId: item.id,
        weCloudVideo: Boolean(record && record.video),
        // 网页壁纸：背景引擎会用沙箱 iframe 真实运行
        weCloudWeb: Boolean(record && record.web),
        weImage: item.preview || '',
        weVideo: '',
        weLocalMediaId: '',
      },
    });
    const media = describeCloudMedia(record);
    this.onToast(media ? `已设为起始页背景（${media}）` : '已设为起始页背景（云端原图）', 'ok');
  }

  /** 回落素材：本地 WE 原图 > Steam 预览。 */
  async applyLocalOrSteamBackground(item) {
    this.onToast('正在获取壁纸素材…', 'ok');
    // fetchPreviewAssets 内部已经走一次详情接口并带出 preview_url，不必再单独请求
    const assets = await fetchPreviewAssets(item.id);
    const image = (assets && assets.image) || item.preview || '';
    const video = (assets && assets.video) || '';
    // 本地库里有作者原图就记下来，背景引擎会优先用它（Steam 那份只有 1024）
    const local = await getLocalWallpaper(item.id);
    await this.app.updateSettings({
      background: {
        type: 'we',
        weMode: 'fixed',
        weItemId: item.id,
        weTitle: item.title,
        weImage: image,
        weVideo: video,
        weLocalMediaId: (local && local.mediaId) || '',
        weCloudItemId: '',
        weCloudVideo: false,
        weCloudWeb: false,
      },
    });
    if (local) {
      this.onToast(`已设为起始页背景（本地原图 ${local.width}×${local.height}）`, 'ok');
    } else {
      this.onToast(
        video ? '已设为起始页背景' : '已设为起始页背景（方形预览按完整显示 + 虚化铺底呈现）',
        'ok',
      );
    }
  }

  /**
   * 应用到桌面（免 Steam 静态）：把云端原图写进交接文件夹，
   * 配套的 aurora-desktop-wallpaper 小工具以 --watch 模式监视并自动应用。
   * 适合没有 Steam / Wallpaper Engine 的办公电脑。
   */
  async sendToDesktopTool(item) {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持选择文件夹（需要较新的 Chrome/Edge）');
    }
    let dir = await getHandoffDir();
    if (!dir) {
      dir = await window.showDirectoryPicker({ id: 'aurora-handoff', mode: 'readwrite' });
      await saveHandoffDir(dir);
      this.onToast('交接文件夹已记住，以后发送不再选择', 'ok');
    } else if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('文件夹权限被拒绝，请重新选择');
      }
    }

    this.onToast('正在获取云端原图…', 'ok');
    const [assets, details] = await Promise.all([
      fetchPreviewAssets(item.id).catch(() => null),
      fetchDetails([item.id]).catch(() => []),
    ]);
    const url = (assets && assets.image) || (details[0] && details[0].preview_url) || item.preview || '';
    if (!url) throw new Error('这张壁纸没有可用的静态原图');

    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) throw new Error(`原图下载失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('原图下载为空');

    const ext = String(blob.type).includes('png') ? 'png' : 'jpg';
    const name = `aurora-wallpaper-${item.id}-${Date.now()}.${ext}`;
    const sent = await writeHandoffFile(name, blob);
    if (!sent) throw new Error('写入交接文件夹失败（权限或磁盘问题）');
    this.onToast(
      `已发送「${item.title}」→ 交接文件夹，桌面工具监视模式会自动应用`,
      'ok',
    );
  }

  /**
   * 安装到 Lively Wallpaper（免费开源动态桌面，无需 Steam）：
   * 网页类 → 整包目录树（index.html 入口）；视频类 → 单个 mp4；
   * 其他 → 原图。写进 Lively 的库目录后，打开 Lively 就能看到并应用。
   */
  async installToLively(item) {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持选择文件夹（需要较新的 Chrome/Edge）');
    }
    let dir = await getLivelyDir();
    if (!dir) {
      dir = await window.showDirectoryPicker({
        id: 'aurora-lively',
        mode: 'readwrite',
        startIn: 'documents',
      });
      await saveLivelyDir(dir);
      this.onToast('Lively 库目录已记住（建议选 %USERPROFILE%\\LivelyProjects）', 'ok');
    } else if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error('文件夹权限被拒绝，请重新选择');
      }
    }

    const safeTitle =
      String(item.title || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .trim()
        .slice(0, 40) || `aurora-${item.id}`;
    const folderName = `aurora-${item.id}-${safeTitle}`;

    const cloud = this.cloudConfig();
    if (!cloud) throw new Error('Lively 联动需要云端服务：请先在设置里配置服务地址和 Token');
    const probe = await this.queryCloud(item.id, cloud).catch(() => null);
    const record = probe && probe.record;

    // 网页壁纸：整包目录树
    if (record && record.state === 'ready' && record.web) {
      const files = await fetchWebFileList(cloud, item.id);
      if (!files.length) throw new Error('云端未返回文件清单（需要 /web/files 端点）');
      this.onToast(`开始安装网页壁纸包（${files.length} 个文件）…`, 'ok');
      let done = 0;
      const queue = files.slice();
      const worker = async () => {
        while (queue.length) {
          const rel = queue.shift();
          try {
            const res = await fetch(webAssetUrl(cloud, item.id, rel), { credentials: 'omit' });
            if (res.ok) await writeDirFile(dir, `${folderName}/${rel}`, await res.blob());
          } catch (err) {
            /* 单文件失败跳过 */
          }
          done += 1;
          if (done % 25 === 0) this.onToast(`安装进度 ${done}/${files.length}…`, 'ok');
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      this.onToast(
        `已安装到 Lively（${done}/${files.length} 个文件）：打开 Lively 选择「${folderName}」即可`,
        'ok',
      );
      return;
    }

    // 视频壁纸：单个 mp4
    if (record && record.state === 'ready' && record.video) {
      const res = await fetch(cloudAssetUrl(cloud, item.id, 'video'), { credentials: 'omit' });
      if (!res.ok) throw new Error(`视频下载失败（HTTP ${res.status}）`);
      await writeDirFile(dir, `${folderName}/video.mp4`, await res.blob());
      this.onToast(`已安装到 Lively：打开 Lively 选择「${folderName}」即可`, 'ok');
      return;
    }

    // 其他：静态原图
    const [assets, details] = await Promise.all([
      fetchPreviewAssets(item.id).catch(() => null),
      fetchDetails([item.id]).catch(() => []),
    ]);
    const url = (assets && assets.image) || (details[0] && details[0].preview_url) || item.preview || '';
    if (!url) throw new Error('这张壁纸没有可用的静态原图');
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`原图下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const ext = String(blob.type).includes('png') ? 'png' : 'jpg';
    await writeDirFile(dir, `${folderName}/image.${ext}`, blob);
    this.onToast(`已安装到 Lively（静态）：打开 Lively 选择「${folderName}」即可`, 'ok');
  }

  /** 加入每日轮换收藏池（去重）。 */
  async addToLibrary(item) {
    const library = await loadWeLibrary();
    if (!library.some((entry) => entry.id === item.id)) {
      library.push({ id: item.id, title: item.title, preview: item.preview || '' });
      await saveWeLibrary(library);
      this.onToast('已加入每日轮换（重新打开标签页起参与轮换）', 'ok');
    } else {
      this.onToast('这张壁纸已在轮换池里', 'ok');
    }
  }

  /* ------------------------------ 开关 ------------------------------ */

  open() {
    this.mount();
    this.openState = true;
    this.root.hidden = false;
    void this.root.offsetHeight;
    this.root.classList.add('is-open');
    this.refreshLoginState();
    if (!this.loaded) this.load(true);
    const qInput = this.root.querySelector('[data-role="ws-q"]');
    if (qInput) qInput.focus();
  }

  close() {
    if (!this.openState) return false;
    this.openState = false;
    this.root.classList.remove('is-open');
    window.setTimeout(() => {
      if (!this.openState) this.root.hidden = true;
    }, 240);
    return true;
  }

  isOpen() {
    return this.openState;
  }
}
