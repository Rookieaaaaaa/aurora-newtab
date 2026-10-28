/**
 * dock.js — 底部常用站点 Dock
 * 功能：渲染、favicon 三级降级、字母色块、拖拽排序、右键/更多菜单、新增/编辑/删除。
 */

import { confirmDialog, openModal, toast as globalToast } from './dialog.js';
import { icon } from './icons.js';
import { firstChar, hostOf, isValidUrl, normalizeUrl, softGradient, uid } from './utils.js';

const MAX_ICON_BYTES = 200 * 1024;
const ICON_SIZE = 128;

/** 生成字母色块。 */
export function createLetterBlock(title) {
  const span = document.createElement('span');
  span.className = 'dock-letter';
  span.style.background = softGradient(title);
  span.textContent = firstChar(title);
  return span;
}

/**
 * 生成站点图标元素。
 * 结构：底层永远先渲染字母色块，img 绝对定位叠在上面，onload 成功后才淡入并隐藏字母块；
 * onerror 直接移除 img（字母块因此始终可见，离线状态也不会出现空白方块）。
 * @param {{title:string,url:string,icon?:{type:string,value:string}}} site
 * @returns {HTMLElement}
 */
export function createSiteIcon(site) {
  const iconConf = (site && site.icon) || { type: 'auto', value: '' };
  const type = iconConf.type || 'auto';
  const value = iconConf.value || '';

  const wrap = document.createElement('span');
  wrap.className = 'dock-icon';
  wrap.appendChild(createLetterBlock(site ? site.title : ''));

  let primary = '';
  let secondary = '';

  if ((type === 'url' || type === 'upload') && value) {
    primary = value;
  } else {
    const host = hostOf(site && site.url);
    if (host) {
      primary = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
      try {
        const origin = new URL(normalizeUrl(site.url)).origin;
        secondary = `${origin}/favicon.ico`;
      } catch (err) {
        secondary = '';
      }
    }
  }

  if (!primary) return wrap;

  const img = document.createElement('img');
  img.className = 'dock-icon-img';
  img.referrerPolicy = 'no-referrer';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = '';

  let stage = 0;
  let settled = false;

  /** 放弃这张图，露出底层字母块。 */
  const giveUp = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    wrap.classList.remove('has-img');
    if (img.parentNode) img.parentNode.removeChild(img);
  };

  // 网络挂起（离线 / favicon 服务无响应）时不能无限等待，超时直接显示字母块
  const timer = window.setTimeout(giveUp, 3500);

  img.addEventListener('load', () => {
    // 只有真正解码出尺寸才算成功
    if (!img.naturalWidth) return;
    settled = true;
    window.clearTimeout(timer);
    wrap.classList.add('has-img');
  });
  img.addEventListener('error', () => {
    stage += 1;
    if (stage === 1 && secondary && !settled) {
      img.src = secondary;
      return;
    }
    giveUp();
  });

  img.src = primary;
  wrap.appendChild(img);
  return wrap;
}

/**
 * 使用 canvas 压缩图片到 ≤128px 的 PNG dataURL。
 * @param {File} file
 * @returns {Promise<string>}
 */
export function compressImage(file, maxSize = ICON_SIZE) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('未选择文件'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('图片解析失败，请换一张'));
      image.onload = () => {
        const ratio = Math.min(1, maxSize / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * ratio));
        const height = Math.max(1, Math.round(image.height * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('当前环境不支持 canvas'));
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(image, 0, 0, width, height);
        try {
          resolve(canvas.toDataURL('image/png'));
        } catch (err) {
          reject(new Error('图片转换失败'));
        }
      };
      image.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

export class Dock {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root #dock
   * @param {Function} options.getSites
   * @param {Function} options.setSites async (sites) => void
   * @param {Function} options.getSettings
   * @param {Function} [options.onChanged] 站点变化后的回调（如刷新设置面板）
   * @param {Function} [options.onToast]
   */
  constructor({ root, getSites, setSites, getSettings, onChanged, onToast }) {
    this.root = root;
    this.getSites = getSites;
    this.setSites = setSites;
    this.getSettings = getSettings;
    this.onChanged = typeof onChanged === 'function' ? onChanged : () => {};
    this.onToast = typeof onToast === 'function' ? onToast : globalToast;

    this.dragIndex = -1;
    this.menuEl = null;
    this.menuCleanup = null;
    this.onDocumentClick = this.onDocumentClick.bind(this);
    this.onDocumentKeydown = this.onDocumentKeydown.bind(this);
  }

  /* ------------------------------ 渲染 ------------------------------ */

  render() {
    const sites = this.getSites();
    const settings = this.getSettings();
    const showLabels = Boolean(settings.clock && settings.clock.showDockLabels);

    this.root.classList.toggle('has-labels', showLabels);
    this.root.textContent = '';

    sites.forEach((site, index) => {
      this.root.appendChild(this.buildItem(site, index, showLabels));
    });
    this.root.appendChild(this.buildAddButton());
  }

  buildItem(site, index, showLabels) {
    const item = document.createElement('div');
    item.className = 'dock-item';
    item.dataset.index = String(index);
    item.dataset.id = site.id;
    item.draggable = true;

    const link = document.createElement('a');
    link.className = 'dock-link';
    link.href = site.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.draggable = false; // 交给外层 .dock-item 处理拖拽
    link.title = `${site.title}\n${site.url}`;
    link.setAttribute('aria-label', site.title);
    link.appendChild(createSiteIcon(site));
    item.appendChild(link);

    if (showLabels) {
      const label = document.createElement('span');
      label.className = 'dock-label';
      label.textContent = site.title;
      item.appendChild(label);
    }

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'dock-more';
    more.title = '更多操作';
    more.setAttribute('aria-label', `${site.title} 更多操作`);
    more.innerHTML = icon('more');
    more.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openMenu(site, more);
    });
    item.appendChild(more);

    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openMenu(site, more);
    });

    item.addEventListener('dragstart', (event) => this.onDragStart(event, index, item));
    item.addEventListener('dragend', () => this.onDragEnd());
    item.addEventListener('dragover', (event) => this.onDragOver(event, index, item));
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (event) => this.onDrop(event, index));

    return item;
  }

  buildAddButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock-add';
    button.title = '添加网站';
    button.setAttribute('aria-label', '添加网站');
    button.innerHTML = icon('plus');
    button.addEventListener('click', () => this.openForm(null));
    return button;
  }

  /* ------------------------------ 拖拽排序 ------------------------------ */

  onDragStart(event, index, item) {
    this.dragIndex = index;
    item.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', String(index));
      } catch (err) {
        /* ignore */
      }
    }
  }

  onDragOver(event, index, item) {
    if (this.dragIndex < 0) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (this.dragIndex !== index) item.classList.add('drag-over');
  }

  onDragEnd() {
    this.dragIndex = -1;
    const items = this.root.querySelectorAll('.dock-item');
    items.forEach((item) => {
      item.classList.remove('dragging');
      item.classList.remove('drag-over');
    });
  }

  async onDrop(event, index) {
    event.preventDefault();
    const from = this.dragIndex;
    this.dragIndex = -1;
    this.onDragEnd();
    if (from < 0 || from === index) return;

    const sites = this.getSites().slice();
    if (from >= sites.length) return;
    const moved = sites.splice(from, 1)[0];
    sites.splice(index, 0, moved);
    await this.setSites(sites);
    this.render();
    this.onChanged();
  }

  /* ------------------------------ 操作菜单 ------------------------------ */

  closeMenu() {
    if (this.menuCleanup) {
      this.menuCleanup();
      this.menuCleanup = null;
    }
    if (this.menuEl && this.menuEl.parentNode) this.menuEl.parentNode.removeChild(this.menuEl);
    this.menuEl = null;
  }

  isMenuOpen() {
    return Boolean(this.menuEl);
  }

  openMenu(site, anchor) {
    this.closeMenu();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.innerHTML = `
      <button type="button" data-act="edit">${icon('edit')}<span>编辑</span></button>
      <button type="button" data-act="copy">${icon('copy')}<span>复制链接</span></button>
      <div class="sep"></div>
      <button type="button" data-act="delete" class="danger">${icon('trash')}<span>删除</span></button>
    `;
    document.body.appendChild(menu);

    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(
      Math.max(8, window.innerWidth - width - 8),
      Math.max(8, rect.left + rect.width / 2 - width / 2),
    );
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this.menuEl = menu;

    menu.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-act]');
      if (!target) return;
      const act = target.getAttribute('data-act');
      this.closeMenu();
      if (act === 'edit') this.openForm(site);
      else if (act === 'delete') await this.removeSite(site);
      else if (act === 'copy') await this.copyLink(site);
    });

    const timer = window.setTimeout(() => {
      document.addEventListener('click', this.onDocumentClick);
      document.addEventListener('keydown', this.onDocumentKeydown);
    }, 0);

    this.menuCleanup = () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', this.onDocumentClick);
      document.removeEventListener('keydown', this.onDocumentKeydown);
    };
  }

  onDocumentClick(event) {
    if (!this.menuEl) return;
    if (this.menuEl.contains(event.target)) return;
    this.closeMenu();
  }

  onDocumentKeydown(event) {
    if (event.key === 'Escape') this.closeMenu();
  }

  async copyLink(site) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(site.url);
      } else {
        throw new Error('clipboard unavailable');
      }
      this.onToast('链接已复制', 'ok');
    } catch (err) {
      this.onToast('复制失败，请手动复制地址', 'error');
    }
  }

  async removeSite(site) {
    const ok = await confirmDialog({
      title: '删除网站',
      message: `确定要从 Dock 中移除「${site.title}」吗？`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    const sites = this.getSites().filter((item) => item.id !== site.id);
    await this.setSites(sites);
    this.render();
    this.onChanged();
    this.onToast('已删除', 'ok');
  }

  /* ------------------------------ 新增 / 编辑表单 ------------------------------ */

  openForm(site) {
    const isEdit = Boolean(site);
    const draft = {
      id: site ? site.id : uid('site'),
      title: site ? site.title : '',
      url: site ? site.url : '',
      icon: {
        type: site && site.icon ? site.icon.type : 'auto',
        value: site && site.icon ? site.icon.value : '',
      },
    };

    const content = document.createElement('div');
    content.className = 'form-grid';
    content.innerHTML = `
      <div class="field">
        <label for="site-form-title">名称</label>
        <input id="site-form-title" class="input" type="text" maxlength="24" placeholder="例如：GitHub" />
      </div>
      <div class="field">
        <label for="site-form-url">网址</label>
        <input id="site-form-url" class="input" type="text" placeholder="github.com 或 https://github.com" />
        <div class="hint">未填写协议时自动补全 https://</div>
      </div>
      <div class="field">
        <span class="field-label">图标方式</span>
        <div class="icon-mode-row">
          <button type="button" data-mode="auto">自动</button>
          <button type="button" data-mode="url">图片地址</button>
          <button type="button" data-mode="upload">上传图片</button>
        </div>
        <div class="icon-preview">
          <div class="ip-box" data-role="preview"></div>
          <div class="ip-tip" data-role="tip"></div>
        </div>
        <input class="input" type="text" data-role="icon-url" placeholder="https://example.com/icon.png" hidden />
        <div class="upload-row" data-role="upload-row" hidden>
          <button class="btn ghost sm" type="button" data-role="pick">选择图片</button>
          <span class="file-name" data-role="file-name">未选择文件</span>
          <input type="file" accept="image/*" data-role="file" hidden />
        </div>
      </div>
    `;

    const titleInput = content.querySelector('#site-form-title');
    const urlInput = content.querySelector('#site-form-url');
    const modeRow = content.querySelector('.icon-mode-row');
    const preview = content.querySelector('[data-role="preview"]');
    const tip = content.querySelector('[data-role="tip"]');
    const iconUrlInput = content.querySelector('[data-role="icon-url"]');
    const uploadRow = content.querySelector('[data-role="upload-row"]');
    const fileInput = content.querySelector('[data-role="file"]');
    const fileName = content.querySelector('[data-role="file-name"]');
    const pickBtn = content.querySelector('[data-role="pick"]');

    titleInput.value = draft.title;
    urlInput.value = draft.url;
    iconUrlInput.value = draft.icon.type === 'url' ? draft.icon.value : '';

    const refreshModeUi = () => {
      Array.prototype.forEach.call(modeRow.children, (button) => {
        button.setAttribute('data-active', button.getAttribute('data-mode') === draft.icon.type ? 'true' : 'false');
      });
      iconUrlInput.hidden = draft.icon.type !== 'url';
      uploadRow.hidden = draft.icon.type !== 'upload';
      this.updatePreview(preview, tip, draft);
    };

    modeRow.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      draft.icon.type = button.getAttribute('data-mode');
      if (draft.icon.type === 'auto') draft.icon.value = '';
      if (draft.icon.type === 'url') draft.icon.value = iconUrlInput.value.trim();
      refreshModeUi();
    });

    iconUrlInput.addEventListener('input', () => {
      draft.icon.value = iconUrlInput.value.trim();
      this.updatePreview(preview, tip, draft);
    });

    urlInput.addEventListener('input', () => {
      draft.url = urlInput.value.trim();
      this.updatePreview(preview, tip, draft);
    });

    titleInput.addEventListener('input', () => {
      draft.title = titleInput.value.trim();
      this.updatePreview(preview, tip, draft);
    });

    pickBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      fileName.textContent = file.name;
      try {
        const dataUrl = await compressImage(file, ICON_SIZE);
        const bytes = Math.round((dataUrl.length * 3) / 4);
        if (bytes > MAX_ICON_BYTES) {
          this.onToast('图片压缩后仍超过 200KB，请换一张更小的图片', 'error');
          return;
        }
        draft.icon.type = 'upload';
        draft.icon.value = dataUrl;
        refreshModeUi();
      } catch (err) {
        this.onToast(err.message || '图片处理失败', 'error');
      }
    });

    refreshModeUi();

    openModal({
      title: isEdit ? '编辑网站' : '添加网站',
      content,
      width: 460,
      actions: [
        { label: '取消', kind: 'ghost' },
        {
          label: '保存',
          kind: 'primary',
          onClick: async () => {
            const title = titleInput.value.trim();
            const url = normalizeUrl(urlInput.value.trim());
            if (!title) {
              this.onToast('请填写网站名称', 'error');
              titleInput.focus();
              return false;
            }
            if (!isValidUrl(url)) {
              this.onToast('网址格式不正确，请检查后重试', 'error');
              urlInput.focus();
              return false;
            }
            const next = {
              id: draft.id,
              title,
              url,
              icon: {
                type: draft.icon.type,
                value: draft.icon.type === 'auto' ? '' : draft.icon.value || '',
              },
            };
            const sites = this.getSites().slice();
            const index = sites.findIndex((item) => item.id === next.id);
            if (index >= 0) sites[index] = next;
            else sites.push(next);
            await this.setSites(sites);
            this.render();
            this.onChanged();
            this.onToast(isEdit ? '已保存修改' : '已添加网站', 'ok');
            return true;
          },
        },
      ],
    });
  }

  /** 更新表单中的图标预览。 */
  updatePreview(preview, tip, draft) {
    preview.textContent = '';
    const previewSite = {
      title: draft.title || 'A',
      url: isValidUrl(draft.url) ? normalizeUrl(draft.url) : draft.url,
      icon: { type: draft.icon.type, value: draft.icon.value },
    };
    preview.appendChild(createSiteIcon(previewSite));

    if (draft.icon.type === 'auto') {
      tip.textContent = '自动抓取站点图标（favicon），失败时显示首字母色块';
    } else if (draft.icon.type === 'url') {
      tip.textContent = '填写一个可公开访问的图片地址';
    } else {
      tip.textContent = '上传的图片会被压缩到 128px 以内，仅保存在本机';
    }
  }
}
