/**
 * search.js — 搜索框 UI
 * 负责：引擎 chip + 下拉（键盘可达）、占位文案、URL 意图提示、bang 指令、输入法保护、提交分发。
 */

import { AI_ENGINES, BANGS, BANG_HINTS, WEB_ENGINES, findEngine } from './defaults.js';
import { icon } from './icons.js';
import { isValidUrl } from './utils.js';

/**
 * 判断输入是否具备「网址意图」，返回可打开的 URL（无意图返回空串）。
 * @param {string} value
 * @returns {string}
 */
export function detectUrlIntent(value) {
  const text = String(value || '').trim();
  if (!text || /\s/.test(text)) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return isValidUrl(text) ? text : '';
  }
  if (/^localhost(:\d+)?(\/.*)?$/i.test(text)) return `http://${text}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(text)) return `http://${text}`;
  const match = text.match(/^([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/.*)?$/i);
  if (match) {
    const tld = match[1].split('.').pop();
    if (/^[a-z]{2,}$/i.test(tld)) return `https://${text}`;
  }
  return '';
}

/**
 * 解析 bang 指令，例如「!b 天气」→ { engineId:'bing', query:'天气' }
 * @param {string} value
 */
export function parseBang(value) {
  const match = String(value || '').match(/^(![a-zA-Z]+)\s+([\s\S]+)$/);
  if (!match) return null;
  const engineId = BANGS[match[1].toLowerCase()];
  if (!engineId) return null;
  const query = match[2].trim();
  if (!query) return null;
  return { engineId, query };
}

export class SearchBar {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root .search
   * @param {HTMLElement} options.input
   * @param {HTMLElement} options.chip
   * @param {HTMLElement} options.chipIcon
   * @param {HTMLElement} options.chipLabel
   * @param {HTMLElement} options.chipCaret
   * @param {HTMLElement} options.submitBtn
   * @param {HTMLElement} options.menu
   * @param {HTMLElement} options.hint
   * @param {Function} options.getSettings
   * @param {Function} options.setEngine (engineId) => void
   * @param {Function} options.onAI ({query, providerId, engineId}) => void
   * @param {Function} [options.onToast]
   */
  constructor(options) {
    this.root = options.root;
    this.input = options.input;
    this.chip = options.chip;
    this.chipIcon = options.chipIcon;
    this.chipLabel = options.chipLabel;
    this.chipCaret = options.chipCaret;
    this.submitBtn = options.submitBtn;
    this.menu = options.menu;
    this.hint = options.hint;
    this.getSettings = options.getSettings;
    this.setEngine = options.setEngine;
    this.onAI = options.onAI;
    this.onToast = typeof options.onToast === 'function' ? options.onToast : () => {};

    this.menuOpen = false;
    this.menuMode = 'engine';
    this.activeIndex = -1;
    this.composing = false;
    this.hintUrl = '';
    this.items = [];
  }

  /* ------------------------------ 初始化 ------------------------------ */

  mount() {
    this.chipCaret.innerHTML = icon('chevronDown');
    this.submitBtn.innerHTML = icon('search');

    this.refresh();

    this.chip.addEventListener('click', () => {
      if (this.menuOpen && this.menuMode === 'engine') this.closeMenu();
      else this.openMenu('engine');
    });

    this.chip.addEventListener('keydown', (event) => this.onChipKeydown(event));

    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.updateHint();
    });
    this.input.addEventListener('input', () => this.updateHint());
    this.input.addEventListener('keydown', (event) => this.onInputKeydown(event));
    this.input.addEventListener('focus', () => {
      if (/^![a-z]*$/i.test(this.input.value.trim())) this.openMenu('bang');
    });

    this.submitBtn.addEventListener('click', () => this.submit());

    this.hint.addEventListener('click', () => {
      if (this.hintUrl) this.openUrl(this.hintUrl);
    });

    this.menu.addEventListener('click', (event) => {
      const item = event.target.closest('[data-engine], [data-bang]');
      if (!item) return;
      if (item.hasAttribute('data-bang')) {
        this.applyBang(item.getAttribute('data-bang'));
        return;
      }
      this.selectEngine(item.getAttribute('data-engine'));
    });

    document.addEventListener('click', (event) => {
      if (!this.menuOpen) return;
      if (this.root.contains(event.target)) return;
      this.closeMenu();
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.menuOpen) {
        this.closeMenu();
      }
    });
  }

  /* ------------------------------ 展示刷新 ------------------------------ */

  /** 依据最新设置刷新 chip 与占位文案。 */
  refresh() {
    const settings = this.getSettings();
    const engine = findEngine(settings.search.defaultEngine);
    const showIcon = settings.search.showEngineIcon !== false;

    if (showIcon) {
      this.chipIcon.hidden = false;
      this.chipIcon.innerHTML = icon(engine.icon || 'search');
    } else {
      this.chipIcon.hidden = true;
      this.chipIcon.innerHTML = '';
    }
    this.chipLabel.textContent = engine.name;
    this.input.placeholder =
      engine.group === 'ai' ? '问点什么…（AI 搜索）' : `在${engine.name}中搜索…`;
    this.updateHint();
  }

  /** 更新 URL 意图 / bang 提示。 */
  updateHint() {
    const value = this.input.value;
    const trimmed = value.trim();

    // bang 提示
    if (/^![a-z]*$/i.test(trimmed)) {
      this.hintUrl = '';
      this.hint.hidden = true;
      if (document.activeElement === this.input) this.openMenu('bang');
      return;
    }
    if (this.menuOpen && this.menuMode === 'bang') this.closeMenu();

    if (parseBang(trimmed)) {
      this.hintUrl = '';
      this.hint.hidden = true;
      return;
    }

    const url = detectUrlIntent(trimmed);
    if (url) {
      const display = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      this.hintUrl = url;
      this.hint.innerHTML = `${icon('external')}<span>打开</span><span class="u"></span><span class="kbd">Enter</span>`;
      this.hint.querySelector('.u').textContent = display;
      this.hint.hidden = false;
    } else {
      this.hintUrl = '';
      this.hint.hidden = true;
    }
  }

  /* ------------------------------ 下拉菜单 ------------------------------ */

  /** 打开下拉。 */
  openMenu(mode = 'engine') {
    this.menuMode = mode;
    this.renderMenu();
    this.menu.hidden = false;
    this.menu.classList.remove('is-above');
    this.menu.style.maxHeight = '';
    this.positionMenu();
    this.menuOpen = true;
    this.chip.setAttribute('aria-expanded', 'true');
    this.hint.hidden = true;
    document.body.classList.add('menu-open');
  }

  /**
   * 依据可用空间决定下拉高度与展开方向。
   * 规则：
   *   1. 默认在搜索框下方展开，并留出 Dock 的位置（不压住 Dock）；
   *   2. 高度上限 = min(440, Dock 顶部 - 菜单顶部 - 8)，绝不超过视口；
   *   3. 极端情况下（下方不足 180px）才考虑向上翻转。
   */
  positionMenu() {
    const rect = this.root.getBoundingClientRect();
    const margin = 16;
    const menuTop = rect.bottom + 10;
    const dockWrap = document.getElementById('dock-wrap');
    const dockTop = dockWrap ? dockWrap.getBoundingClientRect().top : window.innerHeight;
    const belowViewport = window.innerHeight - menuTop - margin;
    const belowDock = dockTop - menuTop - 8;
    const spaceAbove = rect.top - margin - 10;

    let flipped = false;
    let available = Math.min(440, belowDock);
    if (!Number.isFinite(available) || available < 180) {
      if (spaceAbove > belowViewport && spaceAbove >= 180) {
        flipped = true;
        available = spaceAbove;
      } else {
        available = belowViewport;
      }
    }
    available = Math.max(160, Math.min(440, Math.trunc(available)));

    this.menu.style.maxHeight = `${available}px`;
    this.menu.classList.toggle('is-above', flipped);
  }

  /** 关闭下拉。 */
  closeMenu() {
    if (!this.menuOpen) return false;
    this.menuOpen = false;
    this.menu.hidden = true;
    this.activeIndex = -1;
    this.chip.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
    this.updateHint();
    return true;
  }

  isMenuOpen() {
    return this.menuOpen;
  }

  /** 渲染下拉内容。 */
  renderMenu() {
    const selected = this.getSettings().search.defaultEngine;
    this.menu.textContent = '';
    this.items = [];

    const createItem = (options) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.setAttribute('role', 'option');
      if (options.engineId) button.setAttribute('data-engine', options.engineId);
      if (options.bang) button.setAttribute('data-bang', options.bang);
      if (options.engineId && options.engineId === selected) {
        button.setAttribute('data-selected', 'true');
      }
      button.setAttribute('data-active', 'false');
      button.innerHTML = `${icon(options.iconName || 'globe')}<span class="mi-name"></span>${
        options.badge ? `<span class="mi-badge">${options.badge}</span>` : ''
      }`;
      button.querySelector('.mi-name').textContent = options.name;
      this.menu.appendChild(button);
      this.items.push(button);
      return button;
    };

    const groupTitle = (text) => {
      const div = document.createElement('div');
      div.className = 'menu-group';
      div.textContent = text;
      this.menu.appendChild(div);
    };

    if (this.menuMode === 'bang') {
      groupTitle('指令');
      BANG_HINTS.forEach((item) => {
        createItem({
          bang: item.cmd,
          name: `${item.cmd} ${item.desc}`,
          iconName: 'bolt',
        });
      });
      this.activeIndex = 0;
      this.highlight();
    } else {
      groupTitle('AI 搜索');
      AI_ENGINES.forEach((engine) => {
        createItem({
          engineId: engine.id,
          name: engine.name,
          iconName: engine.icon,
          badge: engine.badge,
        });
      });
      groupTitle('网页搜索');
      WEB_ENGINES.forEach((engine) => {
        createItem({ engineId: engine.id, name: engine.name, iconName: engine.icon });
      });
      // 定位到当前引擎
      const index = this.items.findIndex((item) => item.getAttribute('data-engine') === selected);
      this.activeIndex = index >= 0 ? index : 0;
      this.highlight();
    }
  }

  /** 高亮当前项。 */
  highlight() {
    this.items.forEach((item, index) => {
      item.setAttribute('data-active', index === this.activeIndex ? 'true' : 'false');
    });
    const active = this.items[this.activeIndex];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 选择引擎。 */
  selectEngine(engineId) {
    this.closeMenu();
    this.setEngine(engineId);
    this.refresh();
    this.input.focus();
  }

  /** 应用 bang 指令。 */
  applyBang(bang) {
    this.closeMenu();
    this.input.value = `${bang} `;
    this.input.focus();
    this.updateHint();
  }

  /* ------------------------------ 键盘处理 ------------------------------ */

  /** chip 上的键盘操作。 */
  onChipKeydown(event) {
    // 菜单未展开时：↓ / Enter / 空格 打开
    if (!this.menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openMenu('engine');
      }
      return;
    }

    // 菜单已展开
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex = Math.min(this.items.length - 1, this.activeIndex + 1);
      this.highlight();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.highlight();
    } else if (event.key === 'Home') {
      event.preventDefault();
      this.activeIndex = 0;
      this.highlight();
    } else if (event.key === 'End') {
      event.preventDefault();
      this.activeIndex = this.items.length - 1;
      this.highlight();
    } else if (event.key === 'Enter' || event.key === ' ') {
      // 菜单展开时 Enter / 空格 = 确认当前项
      event.preventDefault();
      const item = this.items[this.activeIndex];
      if (item) {
        if (item.hasAttribute('data-bang')) this.applyBang(item.getAttribute('data-bang'));
        else this.selectEngine(item.getAttribute('data-engine'));
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeMenu();
    }
  }

  /** 输入框上的键盘操作。 */
  onInputKeydown(event) {
    // 中文输入法组合期间忽略回车
    if (event.isComposing || this.composing || event.keyCode === 229) return;

    if (event.key === 'Enter') {
      if (this.menuOpen && this.menuMode === 'bang') {
        event.preventDefault();
        const item = this.items[this.activeIndex];
        if (item && item.hasAttribute('data-bang')) {
          this.applyBang(item.getAttribute('data-bang'));
          return;
        }
      }
      event.preventDefault();
      this.submit();
      return;
    }

    if (this.menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.activeIndex = Math.min(this.items.length - 1, this.activeIndex + 1);
        this.highlight();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.activeIndex = Math.max(0, this.activeIndex - 1);
        this.highlight();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeMenu();
      }
    }
  }

  /* ------------------------------ 提交 ------------------------------ */

  /** 抖动提示。 */
  shake() {
    this.root.classList.remove('is-shaking');
    void this.root.offsetWidth;
    this.root.classList.add('is-shaking');
    window.setTimeout(() => this.root.classList.remove('is-shaking'), 420);
    this.input.focus();
  }

  /**
   * 打开网址。
   * 说明：不能用 window.open(url, '_blank', 'noopener') —— 带 noopener 时返回 null，
   * 会被误判为「被拦截」而退化成当前页跳转。这里改用临时 <a> 点击，
   * 既保留 noopener/noreferrer 安全属性，也不会影响当前标签页。
   */
  openUrl(url) {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(() => {
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 0);
  }

  /** 提交搜索。 */
  submit() {
    const raw = this.input.value;
    const trimmed = raw.trim();

    if (!trimmed) {
      this.shake();
      return;
    }

    const settings = this.getSettings();
    const bang = parseBang(trimmed);

    if (!bang) {
      const url = detectUrlIntent(trimmed);
      if (url) {
        this.openUrl(url);
        return;
      }
    }

    const engineId = bang ? bang.engineId : settings.search.defaultEngine;
    const query = bang ? bang.query : trimmed;
    const engine = findEngine(engineId);

    if (engine.group === 'ai') {
      this.input.value = '';
      this.updateHint();
      this.onAI({ query, providerId: engine.provider, engineId: engine.id });
      return;
    }

    const target = `${engine.url}${encodeURIComponent(query)}`;
    if (settings.search.newTab === false) {
      window.location.href = target;
    } else {
      this.openUrl(target);
    }
  }

  /** 聚焦并全选。 */
  focus() {
    this.input.focus();
    this.input.select();
  }
}
