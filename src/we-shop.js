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
  WE_SORTS,
  WE_TAGS,
  browseWorkshop,
  buildApplySteamUrl,
  fetchDetails,
  fetchPreviewAssets,
  getSteamSession,
  loadWeLibrary,
  saveWeLibrary,
  subscribeItem,
  unsubscribeItem,
} from './weworkshop.js';

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
      page: 1,
      hasPrev: false,
      hasNext: false,
      loading: false,
      excludeMature: true, // 默认排除成人内容（列表里那些打不开的占位卡）
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
          <div class="ws-sorts" data-role="ws-sorts">
            ${WE_SORTS.map((sort) => `<button class="ws-chip" type="button" data-sort="${sort.value}">${sort.label}</button>`).join('')}
          </div>
          <button class="icon-btn ws-close" type="button" data-role="ws-close" title="关闭（Esc）" aria-label="关闭壁纸工坊">${icon('close')}</button>
        </header>

        <nav class="ws-tags" data-role="ws-tags">
          ${WE_TAGS.map((tag) => `<button class="ws-chip" type="button" data-tag="${tag.value}">${tag.label}</button>`).join('')}
          <span class="ws-age-group">
            <span class="ws-age-label">内容分级</span>
            <button class="ws-chip" type="button" data-age="exclude">排除成人</button>
            <button class="ws-chip" type="button" data-age="all">全部</button>
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

    this.root.querySelector('[data-role="ws-tags"]').addEventListener('click', (event) => {
      const tagBtn = event.target.closest('[data-tag]');
      if (tagBtn) {
        this.state.tag = tagBtn.getAttribute('data-tag');
        this.syncChips();
        this.load(true);
        return;
      }
      const ageBtn = event.target.closest('[data-age]');
      if (ageBtn) {
        this.state.excludeMature = ageBtn.getAttribute('data-age') !== 'all';
        this.syncChips();
        this.load(true);
      }
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

  /** 高亮当前排序 / 分类 / 内容分级 chip。 */
  syncChips() {
    this.root.querySelectorAll('[data-sort]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-sort') === this.state.sort ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-tag]').forEach((button) => {
      button.setAttribute('data-active', button.getAttribute('data-tag') === this.state.tag ? 'true' : 'false');
    });
    this.root.querySelectorAll('[data-age]').forEach((button) => {
      const active =
        (this.state.excludeMature && button.getAttribute('data-age') === 'exclude') ||
        (!this.state.excludeMature && button.getAttribute('data-age') === 'all');
      button.setAttribute('data-active', active ? 'true' : 'false');
    });
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
      const result = await browseWorkshop({
        query: this.state.query,
        sort: this.state.sort,
        tag: this.state.tag,
        page: this.state.page,
        excludeMature: this.state.excludeMature,
      });
      this.state.hasPrev = result.hasPrev;
      this.state.hasNext = result.hasNext;
      grid.textContent = '';
      result.items.forEach((item) => grid.appendChild(this.buildCard(item)));
      if (result.items.length) {
        statusEl.hidden = true;
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
    } finally {
      this.state.loading = false;
    }
  }

  /** 构造单张壁纸卡片（大图 + 常显标题）。 */
  buildCard(item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'ws-card';
    card.title = `${item.title}（#${item.id}）`;
    card.innerHTML = `
      <img class="ws-img" loading="lazy" alt="" referrerpolicy="no-referrer" />
      <span class="ws-info"><span class="ws-title"></span><span class="ws-sub">#${item.id}</span></span>
    `;
    card.querySelector('.ws-img').src = item.preview;
    card.querySelector('.ws-title').textContent = item.title;
    card.addEventListener('click', () => this.openDetail(item));
    return card;
  }

  /* ------------------------------ 详情 ------------------------------ */

  /** 详情弹窗：动态视频预览 + 操作。 */
  openDetail(item) {
    const media = document.createElement('div');
    media.className = 'ws-detail';
    media.innerHTML = `
      <div class="ws-detail-media"><img alt="壁纸预览" referrerpolicy="no-referrer" /></div>
      <div class="ws-detail-meta">正在加载详情…</div>
    `;
    media.querySelector('img').src = item.preview;

    // 静帧缩略图先显示，异步升级：有动态视频换视频，没有则换全尺寸截图
    fetchPreviewAssets(item.id).then((assets) => {
      if (!assets || !document.body.contains(media)) return;
      const mediaBox = media.querySelector('.ws-detail-media');
      if (!mediaBox) return;
      if (assets.video) {
        const video = document.createElement('video');
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('muted', '');
        video.src = assets.video;
        const img = mediaBox.querySelector('img');
        if (img) img.replaceWith(video);
      } else if (assets.image) {
        const img = mediaBox.querySelector('img');
        if (img) img.src = assets.image;
      }
    });

    // 详情数据
    fetchDetails([item.id])
      .then(([detail]) => {
        if (!detail || !document.body.contains(media)) return;
        const subs = Number(detail.subscriptions) || 0;
        const favs = Number(detail.favorites) || 0;
        const sizeMb = detail.file_size ? (detail.file_size / 1024 / 1024).toFixed(1) : '?';
        const updated = detail.time_updated
          ? new Date(detail.time_updated * 1000).toLocaleDateString('zh-CN')
          : '?';
        media.querySelector('.ws-detail-meta').textContent =
          `${detail.title || item.title} · 订阅 ${subs.toLocaleString('zh-CN')} · 收藏 ${favs.toLocaleString('zh-CN')} · ${sizeMb} MB · 更新 ${updated}`;
      })
      .catch(() => {
        const metaEl = media.querySelector('.ws-detail-meta');
        if (metaEl && document.body.contains(media)) metaEl.textContent = item.title;
      });

    openModal({
      title: '壁纸详情',
      content: media,
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
    }).el.style.width = 'min(1100px, 96vw)';
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
    this.onToast(`将在 ${delay} 秒后自动应用到桌面（等 Steam 下载完成）`, 'ok');
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

  /** 设为起始页背景：记录全尺寸截图 + 动态视频，背景引擎会按屏幕分辨率自适应取舍。 */
  async applyBackground(item) {
    this.onToast('正在获取壁纸素材…', 'ok');
    const [assets, details] = await Promise.all([
      fetchPreviewAssets(item.id),
      fetchDetails([item.id]).catch(() => []),
    ]);
    const image =
      (assets && assets.image) || (details[0] && details[0].preview_url) || item.preview || '';
    const video = (assets && assets.video) || '';
    await this.app.updateSettings({
      background: {
        type: 'we',
        weMode: 'fixed',
        weItemId: item.id,
        weTitle: item.title,
        weImage: image,
        weVideo: video,
      },
    });
    this.onToast(
      video ? '已设为起始页背景' : '已设为起始页背景（方形预览按完整显示 + 虚化铺底呈现）',
      'ok',
    );
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
