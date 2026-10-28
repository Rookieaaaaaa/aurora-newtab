/**
 * main.js — 应用入口
 * 负责：读取配置、实例化各模块、全局快捷键、浮层层级管理、错误兜底。
 */

import { AIPanel } from './ai-panel.js';
import { BackgroundController } from './background.js';
import { Clock } from './clock.js';
import { DEFAULT_SECRETS, DEFAULT_SETTINGS, DEFAULT_SITES } from './defaults.js';
import { closeTopModal, initDialog, toast } from './dialog.js';
import { Dock } from './dock.js';
import { setIcon } from './icons.js';
import { SearchBar } from './search.js';
import { SettingsDrawer } from './settings.js';
import { syncWallhavenProxy } from './proxy.js';
import * as storage from './storage.js';
import { WorkshopShop } from './we-shop.js';

/** 当前运行状态。 */
const state = {
  settings: null,
  secrets: null,
  sites: [],
};

/** 模块实例。 */
let bgController = null;
let clock = null;
let searchBar = null;
let aiPanel = null;
let dock = null;
let settingsDrawer = null;
let weShop = null;

let lastToastAt = 0;

/** 限流的异常提示。 */
function safeToast(message, type = 'error') {
  const now = Date.now();
  if (type === 'error') {
    if (now - lastToastAt < 2500) return;
    lastToastAt = now;
  }
  toast(message, type);
}

/** 应用上下文（供设置面板等模块调用）。 */
const app = {
  getSettings: () => state.settings,
  getSecrets: () => state.secrets,
  getSites: () => state.sites,

  async updateSettings(patch) {
    state.settings = await storage.patchSettings(patch);
    applyAll();
    return state.settings;
  },

  async updateSecrets(patch) {
    state.secrets = await storage.setSecrets(patch);
    return state.secrets;
  },

  async updateSites(sites) {
    state.sites = await storage.setSites(sites);
    if (dock) dock.render();
    return state.sites;
  },

  async resetAll() {
    const result = await storage.resetAll();
    state.settings = result.settings;
    state.sites = result.sites;
    applyAll();
    return result;
  },

  async reload() {
    const [settings, secrets, sites] = await Promise.all([
      storage.getSettings(),
      storage.getSecrets(),
      storage.getSites(),
    ]);
    state.settings = settings;
    state.secrets = secrets;
    state.sites = sites;
    applyAll();
    return { settings, secrets, sites };
  },
};

/** 把最新设置应用到各模块。 */
function applyAll() {
  if (!state.settings) return;
  syncWallhavenProxy(state.settings.background && state.settings.background.wallhavenProxy);
  if (bgController) bgController.update(state.settings);
  if (clock) clock.update(state.settings.clock);
  if (searchBar) searchBar.refresh();
  if (dock) dock.render();
  applyDockOpacity();
}

/** 应用 Dock 透明度（来自 ui.dockOpacity）。 */
function applyDockOpacity() {
  const dockEl = document.getElementById('dock');
  if (!dockEl || !state.settings) return;
  const opacity = Number(state.settings.ui && state.settings.ui.dockOpacity);
  dockEl.style.opacity = Number.isFinite(opacity) ? String(Math.min(1, Math.max(0.4, opacity))) : '1';
}

/** Esc 依次关闭最上层浮层。 */
function closeTopLayer() {
  if (closeTopModal()) return true;
  if (weShop && weShop.isOpen()) {
    weShop.close();
    return true;
  }
  if (settingsDrawer && settingsDrawer.isOpen()) {
    settingsDrawer.close();
    return true;
  }
  if (dock && dock.isMenuOpen()) {
    dock.closeMenu();
    return true;
  }
  if (searchBar && searchBar.isMenuOpen()) {
    return searchBar.closeMenu();
  }
  if (aiPanel && aiPanel.isOpen()) {
    return aiPanel.close();
  }
  return false;
}

/** 全局快捷键。 */
function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    const key = event.key;

    if ((event.metaKey || event.ctrlKey) && (key === 'k' || key === 'K')) {
      event.preventDefault();
      if (searchBar) searchBar.focus();
      return;
    }

    if (key === 'Escape') {
      if (closeTopLayer()) event.preventDefault();
      return;
    }

    if (key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const active = document.activeElement;
      const isTyping =
        active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable);
      if (isTyping) return;
      event.preventDefault();
      if (searchBar) searchBar.focus();
    }
  });
}

/** 全局异常兜底：不阻断背景与时钟。 */
function bindErrorGuards() {
  window.addEventListener('error', (event) => {
    console.error('[aurora] 未捕获异常：', event.error || event.message);
    safeToast('出现异常，请刷新页面', 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[aurora] 未处理的 Promise 拒绝：', event.reason);
    safeToast('出现异常，请刷新页面', 'error');
  });
}

/** 启动。 */
async function bootstrap() {
  const modalRoot = document.getElementById('modal-root');
  const toastRoot = document.getElementById('toast-stack');
  initDialog({ modal: modalRoot, toast: toastRoot });

  try {
    const [settings, secrets, sites] = await Promise.all([
      storage.getSettings(),
      storage.getSecrets(),
      storage.getSites(),
    ]);
    state.settings = settings;
    state.secrets = secrets;
    state.sites = sites;
  } catch (err) {
    console.error('[aurora] 读取配置失败：', err);
    safeToast('读取本地配置失败，已使用默认配置', 'error');
    // 兜底：即使存储不可用也让页面可用
    state.settings = DEFAULT_SETTINGS;
    state.secrets = DEFAULT_SECRETS;
    state.sites = DEFAULT_SITES;
  }

  // 背景
  const bgRoot = document.getElementById('bg');
  bgController = new BackgroundController({
    root: bgRoot,
    layers: [document.getElementById('bg-layer-a'), document.getElementById('bg-layer-b')],
    onToast: (message, type) => safeToast(message, type),
  });

  // 时钟
  clock = new Clock({
    timeEl: document.getElementById('clock-time'),
    dateEl: document.getElementById('clock-date'),
    greetingEl: document.getElementById('clock-greeting'),
  });

  // AI 面板
  aiPanel = new AIPanel({
    root: document.getElementById('ai-panel'),
    getSettings: () => state.settings,
    getSecrets: () => state.secrets,
    onNeedsConfig: () => {
      if (settingsDrawer) settingsDrawer.open('ai');
    },
    onToast: (message, type) => safeToast(message, type),
  });

  // 搜索框
  searchBar = new SearchBar({
    root: document.getElementById('search'),
    input: document.getElementById('search-input'),
    chip: document.getElementById('engine-chip'),
    chipIcon: document.getElementById('chip-icon'),
    chipLabel: document.getElementById('chip-label'),
    chipCaret: document.getElementById('chip-caret'),
    submitBtn: document.getElementById('search-submit'),
    menu: document.getElementById('engine-menu'),
    hint: document.getElementById('url-hint'),
    getSettings: () => state.settings,
    setEngine: (engineId) => {
      app.updateSettings({ search: { defaultEngine: engineId } });
    },
    onAI: ({ query, providerId }) => {
      aiPanel.ask({ query, providerId });
    },
    onToast: (message, type) => safeToast(message, type),
  });

  // Dock
  dock = new Dock({
    root: document.getElementById('dock'),
    getSites: () => state.sites,
    setSites: (sites) => app.updateSites(sites),
    getSettings: () => state.settings,
    onChanged: () => {
      if (settingsDrawer) settingsDrawer.renderSiteList();
    },
    onToast: (message, type) => safeToast(message, type),
  });

  // 设置抽屉
  settingsDrawer = new SettingsDrawer({
    root: document.getElementById('settings-drawer'),
    backdrop: document.getElementById('settings-backdrop'),
    app,
    siteEditor: {
      open: (site) => {
        if (dock) dock.openForm(site);
      },
    },
    weShop: {
      open: () => {
        if (settingsDrawer && settingsDrawer.isOpen()) settingsDrawer.close();
        if (weShop) weShop.open();
      },
    },
    onSitesChanged: () => {
      applyAll();
    },
  });

  // 壁纸工坊（全屏浏览页）
  weShop = new WorkshopShop({
    root: document.getElementById('we-shop'),
    app,
    onToast: (message, type) => safeToast(message, type),
  });
  const weShopBtn = document.getElementById('btn-weshop');
  setIcon(weShopBtn, 'image');
  weShopBtn.addEventListener('click', () => weShop.open());

  // 设置按钮
  const settingsBtn = document.getElementById('btn-settings');
  setIcon(settingsBtn, 'gear');
  settingsBtn.addEventListener('click', () => {
    if (settingsDrawer) settingsDrawer.open();
  });

  // 启动各模块（代理同步放在最前，首屏壁纸请求能赶上 PAC 生效）
  syncWallhavenProxy(state.settings.background && state.settings.background.wallhavenProxy);
  bgController.init(state.settings);
  clock.start();
  clock.update(state.settings.clock);
  searchBar.mount();
  dock.render();
  applyDockOpacity();

  bindShortcuts();
  bindErrorGuards();

  // 页面恢复可见时刷新时间（兜底，Clock 内部也有处理）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && clock) clock.render();
  });

  console.info('[aurora] 新标签页已就绪');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bootstrap().catch((err) => {
      console.error('[aurora] 启动失败：', err);
      safeToast('页面启动失败，请刷新重试', 'error');
    });
  });
} else {
  bootstrap().catch((err) => {
    console.error('[aurora] 启动失败：', err);
    safeToast('页面启动失败，请刷新重试', 'error');
  });
}

// 便于调试（不影响功能）
window.__aurora = {
  get settings() {
    return state.settings;
  },
  get sites() {
    return state.sites;
  },
  app,
};
