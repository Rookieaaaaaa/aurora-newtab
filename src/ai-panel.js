/**
 * ai-panel.js — AI 结果面板
 * 功能：流式渲染、Markdown 安全渲染（先转义再解析）、来源列表、复制/重试/停止/关闭、
 *       加载态 / 错误态 / 演示态，以及「用户上滚暂停自动滚动」。
 */

import { getProvider } from './providers/index.js';
import { icon } from './icons.js';
import { NeedsConfigError, describeError, deepMerge, escapeHtml, hostOf, sanitizeUrl } from './utils.js';

/** 流式渲染节流间隔（毫秒）：放宽后长回答更省电、输入更跟手。 */
const RENDER_INTERVAL = 80;

/** 新鲜度徽章的判定窗口（天）。 */
const FRESH_DAYS = 7;

/* -------------------------------------------------------------------------- */
/*                              Markdown 安全渲染                              */
/* -------------------------------------------------------------------------- */

/**
 * 行内解析：先转义，再处理行内代码、链接、粗体、斜体。
 * @param {string} raw 原始（未转义）文本
 * @returns {string} 安全 HTML
 */
function inlineText(raw) {
  let text = escapeHtml(raw);
  const codes = [];

  // 行内代码（先占位，避免内部内容被后续规则破坏）
  text = text.replace(/`([^`\n]+)`/g, (match, code) => {
    codes.push(code);
    return `\u0001IC${codes.length - 1}\u0001`;
  });

  // 链接 [label](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safe = sanitizeUrl(url.replace(/&amp;/g, '&'));
    if (!safe) return label;
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 裸链接
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (match, prefix, url) => {
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // 粗体
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

  // 引用角标 [1] [2]（在链接转换之后执行，不会破坏 [label](url)）
  text = text.replace(/\[(\d{1,2})\]/g, (match, num) => {
    return `<a class="cite" href="#res-${num}" data-cite="${num}" title="查看第 ${num} 条结果">${num}</a>`;
  });

  // 恢复行内代码
  text = text.replace(/\u0001IC(\d+)\u0001/g, (match, index) => {
    const code = codes[Number(index)];
    return `<code>${code}</code>`;
  });

  return text;
}

/**
 * 把 Markdown 渲染为安全 HTML。
 * 支持：标题、段落、粗体、斜体、行内代码、代码块、有序/无序列表、引用、链接、分隔线；
 * 表格降级为等宽纯文本。
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
  const raw = String(source || '').replace(/\r\n?/g, '\n');
  const codeBlocks = [];

  // 1) 抽出围栏代码块（未闭合的围栏也按代码块处理，便于流式渲染）
  const tokenized = raw.replace(/```([\w+#.-]*)\n?([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const token = `\u0000CB${codeBlocks.length}\u0000`;
    codeBlocks.push({ lang: String(lang || ''), code: String(code).replace(/\n$/, '') });
    return token;
  });

  const lines = tokenized.split('\n');
  const html = [];
  let listType = null;
  let i = 0;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      i += 1;
      continue;
    }

    // 代码块占位符
    const codeMatch = trimmed.match(/^\u0000CB(\d+)\u0000$/);
    if (codeMatch) {
      closeList();
      const block = codeBlocks[Number(codeMatch[1])] || { lang: '', code: '' };
      const langAttr = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : '';
      html.push(`<pre${langAttr}><code>${escapeHtml(block.code)}</code></pre>`);
      i += 1;
      continue;
    }

    // 标题
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      html.push(`<h${level}>${inlineText(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      html.push('<hr />');
      i += 1;
      continue;
    }

    // 引用
    if (/^>\s?/.test(trimmed)) {
      closeList();
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote>${quoteLines.map((item) => inlineText(item)).join('<br />')}</blockquote>`);
      continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(trimmed)) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${inlineText(trimmed.replace(/^[-*+]\s+/, ''))}</li>`);
      i += 1;
      continue;
    }

    // 有序列表
    if (/^\d{1,3}[.)]\s+/.test(trimmed)) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${inlineText(trimmed.replace(/^\d{1,3}[.)]\s+/, ''))}</li>`);
      i += 1;
      continue;
    }

    // 表格：降级为等宽纯文本
    if (trimmed.includes('|') && trimmed.split('|').length >= 3) {
      closeList();
      const tableLines = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        tableLines.push(lines[i].trim());
        i += 1;
      }
      html.push(`<pre class="md-plain">${escapeHtml(tableLines.join('\n'))}</pre>`);
      continue;
    }

    // 段落
    closeList();
    const paragraph = [trimmed];
    i += 1;
    while (i < lines.length) {
      const next = lines[i].trim();
      if (!next) break;
      if (/^(#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>\s?|\u0000CB)/.test(next)) break;
      if (next.includes('|') && next.split('|').length >= 3) break;
      paragraph.push(next);
      i += 1;
    }
    html.push(`<p>${paragraph.map((item) => inlineText(item)).join('<br />')}</p>`);
  }

  closeList();
  return html.join('\n');
}

/* -------------------------------------------------------------------------- */
/*                              结果归一化与去重                                */
/* -------------------------------------------------------------------------- */

/** 取相关度（非有限值当 -1，便于排序时排在最后）。 */
function scoreOf(source) {
  const value = Number(source && source.score);
  return Number.isFinite(value) ? value : -1;
}

/** 取域名（缺失时从 url 推导）。 */
function domainOf(source) {
  if (!source) return '';
  const domain = String(source.domain || '').trim();
  return (domain || hostOf(source.url)).toLowerCase();
}

/** URL 去重键（忽略 hash 与末尾斜杠）。 */
function urlKeyOf(source) {
  return String((source && source.url) || '')
    .trim()
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** 标题去重键：去掉所有空白后取前 12 字。 */
function titleKeyOf(source) {
  const title = String((source && source.title) || '').replace(/\s+/g, '');
  return Array.from(title).slice(0, 12).join('');
}

/**
 * 结果去重：
 *   1) 同 URL 只保留 score 更高的一条；
 *   2) 再按「同域名 + 标题前 12 字相同」判重，同样保留 score 更高的一条。
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
function dedupeSources(list) {
  const items = Array.isArray(list) ? list.filter((item) => item && item.url) : [];

  const byUrl = new Map();
  const firstPass = [];
  items.forEach((item) => {
    const key = urlKeyOf(item);
    if (!key) return;
    const index = byUrl.get(key);
    if (index === undefined) {
      byUrl.set(key, firstPass.length);
      firstPass.push(item);
      return;
    }
    if (scoreOf(item) > scoreOf(firstPass[index])) firstPass[index] = item;
  });

  const byTitle = new Map();
  const secondPass = [];
  firstPass.forEach((item) => {
    const title = titleKeyOf(item);
    if (!title) {
      secondPass.push(item);
      return;
    }
    const key = `${domainOf(item)}::${title}`;
    const index = byTitle.get(key);
    if (index === undefined) {
      byTitle.set(key, secondPass.length);
      secondPass.push(item);
      return;
    }
    if (scoreOf(item) > scoreOf(secondPass[index])) secondPass[index] = item;
  });

  return secondPass;
}

/**
 * 日期是否在最近 days 天内（容忍 1 天时区偏差，解析失败返回 false）。
 * @param {string} value YYYY-MM-DD 或可解析日期
 * @param {number} [days]
 * @returns {boolean}
 */
function isFreshDate(value, days = FRESH_DAYS) {
  const text = String(value || '').trim();
  if (!text) return false;
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return false;
  const stamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(stamp)) return false;
  // 按「自然日」比较，窗口包含第 days 天；容错 1 天以适配时区差
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((today - stamp) / 86400000);
  if (!Number.isFinite(diffDays)) return false;
  return diffDays >= -1 && diffDays <= days;
}

/**
 * 结果头部的来源简称（元宝 / DeepSeek / 自定义）。
 * @param {{id?:string, name?:string}} meta provider 元信息
 * @returns {string}
 */
function shortProviderName(meta) {
  const id = String((meta && meta.id) || '');
  const name = String((meta && meta.name) || '');
  if (id.indexOf('yuanbao') === 0) return '元宝';
  if (id.indexOf('deepseek') === 0) return 'DeepSeek';
  if (id === 'custom') return '自定义';
  return name;
}

/* -------------------------------------------------------------------------- */
/*                                 面板实现                                    */
/* -------------------------------------------------------------------------- */

export class AIPanel {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root #ai-panel
   * @param {Function} options.getSettings () => settings
   * @param {Function} options.getSecrets () => secrets
   * @param {Function} [options.onNeedsConfig] 点击「去填写密钥」时回调
   * @param {Function} [options.onToast] (msg, type) => void
   */
  constructor({ root, getSettings, getSecrets, onNeedsConfig, onToast }) {
    this.root = root;
    this.getSettings = getSettings;
    this.getSecrets = getSecrets;
    this.onNeedsConfig = typeof onNeedsConfig === 'function' ? onNeedsConfig : () => {};
    this.onToast = typeof onToast === 'function' ? onToast : () => {};

    this.mounted = false;
    this.open = false;
    this.raw = '';
    this.query = '';
    this.providerId = '';
    this.sources = [];
    this.results = [];
    this.resultMeta = null;
    this.sortMode = 'score';
    this.showAll = false;
    this.initialVisible = 6;
    this.isSearch = false;
    this.activePane = 'results';
    this.controller = null;
    this.autoScroll = true;
    this.renderQueued = false;
    this.renderPending = false;
    this.lastRender = 0;
    this.state = 'idle';
    this.demoActive = false;
    this.stopped = false;
    this.sourceLabel = '';
    this.els = {};
  }

  /* ------------------------------ DOM 构建 ------------------------------ */

  mount() {
    if (this.mounted) return;
    this.mounted = true;

    this.root.innerHTML = `
      <div class="ai-head">
        <div class="ai-title">
          <span class="ai-mark">${icon('sparkles')}</span>
          <span class="ai-name">AI 搜索</span>
        </div>
        <span class="badge" data-tone="live" data-role="status">准备中</span>
        <div class="ai-actions">
          <button class="icon-btn" type="button" data-act="copy" title="复制全文">${icon('copy')}</button>
          <button class="icon-btn" type="button" data-act="retry" title="重新生成">${icon('refresh')}</button>
          <button class="icon-btn" type="button" data-act="stop" title="停止生成">${icon('stop')}</button>
          <button class="icon-btn" type="button" data-act="close" title="关闭（Esc）">${icon('close')}</button>
        </div>
      </div>
      <div class="ai-demo-bar" data-role="demo" hidden>
        ${icon('info')}
        <span data-role="demo-text">当前为演示模式，请在 设置 → AI 搜索 中填入密钥。</span>
        <button type="button" data-act="config">去填写</button>
      </div>
      <div class="ai-query" data-role="query" hidden><div class="bubble"></div></div>
      <div class="ai-tabs" data-role="tabs" role="tablist" hidden>
        <button type="button" role="tab" data-tab="results" data-active="true" aria-selected="true">
          搜索结果<em data-role="tab-count"></em>
        </button>
        <button type="button" role="tab" data-tab="answer" aria-selected="false">AI 总结</button>
      </div>
      <div class="ai-body" data-role="body">
        <div class="ai-pane ai-pane-answer" data-pane="answer">
          <div class="ai-loading" data-role="loading" hidden>
            <span class="dots"><i></i><i></i><i></i></span>
            <span data-role="loading-text">正在搜索…</span>
          </div>
          <div class="ai-answer md" data-role="answer"></div>
          <div class="ai-error" data-role="error" hidden>
            <div class="err-title">${icon('alert')}<span>生成失败</span></div>
            <div class="err-msg" data-role="err-msg"></div>
            <div class="err-actions">
              <button class="btn primary sm" type="button" data-act="config">去填写密钥</button>
              <button class="btn ghost sm" type="button" data-act="retry">重试</button>
            </div>
          </div>
        </div>
        <section class="ai-pane ai-pane-results" data-role="results" hidden>
          <div class="res-head">
            <span class="res-count" data-role="res-count"></span>
            <span class="res-badge" data-role="res-source" data-tone="source" hidden></span>
            <span class="res-badge" data-role="res-cached" data-tone="cache" hidden>缓存</span>
            <span class="res-elapsed" data-role="res-elapsed"></span>
            <button class="res-expand" type="button" data-act="toggle-more" hidden>
              <span data-role="more-text"></span>
            </button>
            <div class="res-sort" data-role="res-sort" role="group" aria-label="排序方式">
              <button type="button" data-sort="score" data-active="true">相关度</button>
              <button type="button" data-sort="date">最新</button>
            </div>
          </div>
          <div class="ai-skeleton" data-role="skeleton" hidden aria-hidden="true">
            <div class="sk-row"><span class="sk-num"></span><div class="sk-body"><span class="sk-line"></span><span class="sk-line short"></span></div></div>
            <div class="sk-row"><span class="sk-num"></span><div class="sk-body"><span class="sk-line"></span><span class="sk-line short"></span></div></div>
            <div class="sk-row"><span class="sk-num"></span><div class="sk-body"><span class="sk-line"></span><span class="sk-line short"></span></div></div>
            <div class="sk-row"><span class="sk-num"></span><div class="sk-body"><span class="sk-line"></span><span class="sk-line short"></span></div></div>
          </div>
          <div class="ai-empty" data-role="empty" hidden>
            <span class="empty-icon">${icon('search')}</span>
            <span class="empty-title">没找到相关结果</span>
            <span class="empty-desc">换个说法、放宽时效，或换个搜索源试试</span>
          </div>
          <ol class="res-list" data-role="res-list"></ol>
        </section>
      </div>
      <button class="ai-jump" type="button" data-role="jump" hidden>${icon('arrowDown')}回到最新</button>
    `;

    const pick = (role) => this.root.querySelector(`[data-role="${role}"]`);
    this.els = {
      status: pick('status'),
      name: this.root.querySelector('.ai-name'),
      demo: pick('demo'),
      demoText: pick('demo-text'),
      body: pick('body'),
      query: pick('query'),
      queryBubble: this.root.querySelector('[data-role="query"] .bubble'),
      tabs: pick('tabs'),
      tabCount: pick('tab-count'),
      paneAnswer: this.root.querySelector('[data-pane="answer"]'),
      paneResults: pick('results'),
      loading: pick('loading'),
      loadingText: pick('loading-text'),
      answer: pick('answer'),
      error: pick('error'),
      errMsg: pick('err-msg'),
      skeleton: pick('skeleton'),
      empty: pick('empty'),
      results: pick('results'),
      resCount: pick('res-count'),
      resSource: pick('res-source'),
      resCached: pick('res-cached'),
      resElapsed: pick('res-elapsed'),
      resList: pick('res-list'),
      resSort: pick('res-sort'),
      resMore: this.root.querySelector('[data-act="toggle-more"]'),
      moreText: pick('more-text'),
      jump: pick('jump'),
      copyBtn: this.root.querySelector('[data-act="copy"]'),
      retryBtn: this.root.querySelector('[data-act="retry"]'),
      stopBtn: this.root.querySelector('[data-act="stop"]'),
    };

    this.root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-act]');
      if (target) {
        const act = target.getAttribute('data-act');
        if (act === 'close') this.close();
        else if (act === 'copy') this.copy();
        else if (act === 'retry') this.retry();
        else if (act === 'stop') this.stop();
        else if (act === 'config') this.onNeedsConfig();
        else if (act === 'toggle-more') this.toggleMore();
        return;
      }

      const sortBtn = event.target.closest('[data-sort]');
      if (sortBtn) {
        this.setSort(sortBtn.getAttribute('data-sort'));
        return;
      }

      const tabBtn = event.target.closest('[data-tab]');
      if (tabBtn) {
        this.setPane(tabBtn.getAttribute('data-tab'));
        return;
      }

      const cite = event.target.closest('[data-cite]');
      if (cite) {
        event.preventDefault();
        this.focusResult(Number(cite.getAttribute('data-cite')));
      }
    });

    this.els.paneAnswer.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.els.resList.addEventListener('scroll', () => this.updateListFade(), { passive: true });
    this.els.jump.addEventListener('click', () => {
      this.autoScroll = true;
      this.scrollToBottom();
      this.els.jump.hidden = true;
    });

    // 页面不可见时跳过渲染（长回答反复重排很耗电），恢复可见后补一次
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !this.renderPending) return;
      this.renderPending = false;
      this.renderAnswer();
    });
  }

  /* ------------------------------ 状态与交互 ------------------------------ */

  isOpen() {
    return this.open;
  }

  /** 设置状态徽标。 */
  setBadge(text, tone) {
    if (!this.els.status) return;
    this.els.status.textContent = text;
    this.els.status.dataset.tone = tone;
  }

  /** 设置头部标题。 */
  setTitle(providerName, model) {
    if (!this.els.name) return;
    this.els.name.textContent = model ? `${providerName} · ${model}` : providerName;
  }

  /** 显示演示模式提示条。 */
  showDemoBar(reason) {
    if (!this.els.demo || !this.els.demoText) return;
    this.demoActive = true;
    const missingCredentials = reason !== 'forced';
    this.els.demoText.textContent = missingCredentials
      ? '当前为演示模式，请在 设置 → AI 搜索 中填入密钥。'
      : '已开启强制演示模式，回答由本地生成，不会联网。';
    const cta = this.els.demo.querySelector('[data-act="config"]');
    if (cta) cta.hidden = !missingCredentials;
    this.els.demo.hidden = false;
  }

  toggleMore() {
    this.showAll = !this.showAll;
    this.renderResultList();
  }

  /** 切换排序方式（编号保持与 AI 引用一致，不受排序影响）。 */
  setSort(mode) {
    this.sortMode = mode === 'date' ? 'date' : 'score';
    if (this.els.resSort) {
      this.els.resSort.querySelectorAll('[data-sort]').forEach((btn) => {
        btn.setAttribute('data-active', btn.getAttribute('data-sort') === this.sortMode ? 'true' : 'false');
      });
    }
    this.renderResultList();
  }

  /** 当前排序后的结果副本。 */
  sortedResults() {
    const list = this.results.slice();
    if (this.sortMode === 'date') {
      list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    } else {
      list.sort((a, b) => {
        const sa = Number.isFinite(a.score) ? a.score : -1;
        const sb = Number.isFinite(b.score) ? b.score : -1;
        return sb - sa;
      });
    }
    return list;
  }

  /** 渲染当前可见的结果条目（默认 6 条，可展开全部）。 */
  renderResultList() {
    if (!this.els.resList) return;
    const list = this.sortedResults();
    if (!list.length) {
      if (this.els.resMore) this.els.resMore.hidden = true;
      // 空结果态自己控制显隐，避免刚显示就被隐藏
      if (!this.els.empty || this.els.empty.hidden) this.els.results.hidden = true;
      return;
    }
    const visible = this.showAll ? list : list.slice(0, this.initialVisible);
    this.els.resList.textContent = '';
    visible.forEach((item) => {
      this.els.resList.appendChild(this.buildResultItem(item));
    });

    if (this.els.resMore) {
      const needMore = list.length > this.initialVisible;
      this.els.resMore.hidden = !needMore;
      this.els.resMore.setAttribute('data-expanded', this.showAll ? 'true' : 'false');
      if (this.els.moreText) {
        this.els.moreText.textContent = this.showAll ? '收起' : `展开全部 ${list.length} 条`;
      }
    }
    this.els.resList.scrollTop = 0;
    window.requestAnimationFrame(() => this.updateListFade());
  }

  /** 列表可滚动且未到底时，给底部加渐隐，提示还有更多。 */
  updateListFade() {
    const list = this.els.resList;
    if (!list) return;
    const more = list.scrollHeight - list.clientHeight - list.scrollTop > 8;
    list.classList.toggle('is-fade', more);
  }

  /**
   * 构造一条结果卡片（全部用 textContent，避免注入）。
   * 信息层级：编号 / 标题 / 摘要 / [favicon·站点·日期·权威·新·相关度]
   */
  buildResultItem(source) {
    const li = document.createElement('li');
    li.className = 'res-item';
    li.setAttribute('data-index', String(source.index));

    const link = document.createElement('a');
    link.className = 'res-link';
    link.href = sanitizeUrl(source.url) || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';

    const num = document.createElement('span');
    num.className = 'res-num';
    num.textContent = String(source.index);

    const main = document.createElement('span');
    main.className = 'res-main';

    const title = document.createElement('span');
    title.className = 'res-title';
    title.textContent = source.title || source.url;

    const snippet = document.createElement('span');
    snippet.className = 'res-snippet';
    snippet.textContent = source.snippet || '';

    const meta = document.createElement('span');
    meta.className = 'res-meta';

    const domain = domainOf(source);
    const favicon = this.buildFavicon(source, domain);
    if (favicon) meta.appendChild(favicon);

    const site = document.createElement('span');
    site.className = 'res-site';
    site.textContent = source.site || domain;
    meta.appendChild(site);

    if (source.date) {
      const dot = document.createElement('span');
      dot.className = 'res-dot';
      dot.textContent = '·';
      const date = document.createElement('span');
      date.className = 'res-date';
      date.textContent = source.date;
      meta.appendChild(dot);
      meta.appendChild(date);
    }

    // 权威度徽章：authority >= 3 视为极权威；-1 / null / 非数字一律不显示
    const authority = Number(source.authority);
    if (Number.isFinite(authority) && authority >= 3) {
      meta.appendChild(this.buildBadge('权威', 'auth'));
    }

    // 新鲜度徽章：7 天内的内容标记为「新」
    if (isFreshDate(source.date)) {
      meta.appendChild(this.buildBadge('新', 'new'));
    }

    if (Number.isFinite(source.score)) {
      const score = document.createElement('span');
      score.className = 'res-score';
      score.textContent = `相关度 ${Math.round(Number(source.score) * 100)}%`;
      meta.appendChild(score);
    }

    main.appendChild(title);
    if (source.snippet) main.appendChild(snippet);
    main.appendChild(meta);
    link.appendChild(num);
    link.appendChild(main);
    li.appendChild(link);
    return li;
  }

  /** 构造结果徽章（权威 / 新）。 */
  buildBadge(text, tone) {
    const badge = document.createElement('span');
    badge.className = 'res-badge';
    badge.dataset.tone = tone;
    badge.textContent = text;
    return badge;
  }

  /**
   * favicon：优先接口返回的 site_icon，其次 favicon.im，最后 Google s2；
   * 全部失败时直接移除节点，避免留下破图。
   * @param {object} source
   * @param {string} domain
   * @returns {HTMLImageElement|null}
   */
  buildFavicon(source, domain) {
    const candidates = [];
    const iconUrl = sanitizeUrl(String((source && source.icon) || '').trim());
    if (iconUrl) candidates.push(iconUrl);
    if (domain) {
      candidates.push(`https://favicon.im/${encodeURIComponent(domain)}?larger=true`);
      candidates.push(
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`,
      );
    }
    if (!candidates.length) return null;

    const img = document.createElement('img');
    img.className = 'res-fav';
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';

    let cursor = 0;
    const next = () => {
      if (cursor >= candidates.length) {
        img.remove();
        return;
      }
      const url = candidates[cursor];
      cursor += 1;
      img.src = url;
    };
    img.addEventListener('error', next);
    next();
    return img;
  }

  /** 点击正文里的 [n] 引用，滚动并高亮对应结果。 */
  focusResult(num) {
    if (!num || !this.results.length) return;

    // 必修：用户在「AI 总结」页签点引用时，先切回结果页签，否则完全看不到反馈
    if (this.activePane !== 'results') {
      this.showTabs(true, this.results.length);
      this.setPane('results');
    }

    const visible = this.showAll ? this.sortedResults() : this.sortedResults().slice(0, this.initialVisible);
    if (!visible.some((item) => item.index === num)) {
      this.showAll = true;
      this.renderResultList();
    }
    const el = this.els.resList.querySelector(`[data-index="${num}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el.classList.add('is-flash');
    window.setTimeout(() => el.classList.remove('is-flash'), 1400);
  }

  /**
   * 渲染搜索结果列表。
   * @param {Array<object>} sources
   * @param {{resultCount?:number, elapsedMs?:number, tool?:string, transport?:string, requested?:number, cached?:boolean}} [meta]
   */
  renderResults(sources, meta) {
    this.resultMeta = meta || null;
    // 统一去重后再编号，保证 [1][2] 引用与列表一一对应
    const list = dedupeSources(Array.isArray(sources) ? sources : []);
    this.results = list.map((item, index) => ({ ...item, index: index + 1 }));

    this.renderHeadBadges(meta);

    if (!this.results.length) {
      this.els.results.hidden = true;
      this.els.skeleton.hidden = true;
      this.showEmptyState(false);
      return;
    }

    this.showEmptyState(false);
    this.els.results.hidden = false;
    this.els.skeleton.hidden = true;
    this.showAll = false;

    const count = this.results.length;
    const requested = meta && Number.isFinite(meta.requested) ? meta.requested : 0;
    this.els.resCount.textContent =
      requested && requested !== count ? `${count} / ${requested} 条` : `${count} 条结果`;

    const elapsed = meta && Number.isFinite(meta.elapsedMs) ? meta.elapsedMs : null;
    this.els.resElapsed.textContent =
      elapsed === null ? '' : elapsed < 1000 ? `用时 ${elapsed} ms` : `用时 ${(elapsed / 1000).toFixed(1)} s`;

    this.renderResultList();
  }

  /**
   * 结果头部的来源标识（元宝 / DeepSeek）与缓存标识。
   * @param {{cached?:boolean}} [meta]
   */
  renderHeadBadges(meta) {
    if (this.els.resSource) {
      const label = this.sourceLabel || '';
      this.els.resSource.textContent = label;
      this.els.resSource.hidden = !label;
    }
    if (this.els.resCached) {
      this.els.resCached.hidden = !(meta && meta.cached);
    }
  }

  /**
   * 空结果态（只在搜索类 provider 结束时展示，避免检索中途误报）。
   * @param {boolean} show
   */
  showEmptyState(show) {
    if (!this.els.empty) return;
    this.els.empty.hidden = !show;
    if (!show) return;
    this.els.results.hidden = false;
    this.els.skeleton.hidden = true;
    this.els.resList.textContent = '';
    if (this.els.resCount) this.els.resCount.textContent = '0 条结果';
    if (this.els.resElapsed) this.els.resElapsed.textContent = '';
    if (this.els.resMore) this.els.resMore.hidden = true;
  }

  onScroll() {
    const body = this.els.paneAnswer;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distance > 48) {
      this.autoScroll = false;
      if (this.state === 'streaming' || this.state === 'loading') this.els.jump.hidden = false;
    } else {
      this.autoScroll = true;
      this.els.jump.hidden = true;
    }
  }

  scrollToBottom() {
    const body = this.els.paneAnswer;
    body.scrollTop = body.scrollHeight;
  }

  /** 切换「搜索结果 / AI 总结」面板。 */
  setPane(name) {
    const pane = name === 'answer' ? 'answer' : 'results';
    this.activePane = pane;
    if (this.els.paneAnswer) this.els.paneAnswer.hidden = pane !== 'answer';
    if (this.els.paneResults) this.els.paneResults.hidden = pane !== 'results';
    if (this.els.tabs) {
      this.els.tabs.querySelectorAll('[data-tab]').forEach((btn) => {
        const active = btn.getAttribute('data-tab') === pane;
        btn.setAttribute('data-active', active ? 'true' : 'false');
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }
  }

  /** 是否显示「搜索结果 / AI 总结」标签栏。 */
  showTabs(show, count) {
    if (!this.els.tabs) return;
    this.els.tabs.hidden = !show;
    if (this.els.tabCount) this.els.tabCount.textContent = count ? String(count) : '';
  }

  /** 渲染答案（按 ~80ms 节流，页面不可见时跳过）。 */
  queueRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    const run = () => {
      this.renderQueued = false;
      // 页面不可见时先攒着，等 visibilitychange 回来再补一次渲染
      if (document.hidden) {
        this.renderPending = true;
        return;
      }
      const now = performance.now();
      if (now - this.lastRender < RENDER_INTERVAL) {
        window.setTimeout(run, RENDER_INTERVAL);
        return;
      }
      this.lastRender = now;
      this.renderAnswer();
    };
    window.requestAnimationFrame(run);
  }

  /** 真正写入一次答案 HTML。 */
  renderAnswer() {
    if (!this.els.answer) return;
    this.els.answer.innerHTML = renderMarkdown(this.raw);
    if (this.autoScroll) this.scrollToBottom();
  }

  /** 渲染来源（兼容旧调用：等同 renderResults）。 */
  renderSources(sources, meta) {
    this.renderResults(sources, meta);
  }

  /* ------------------------------ 主流程 ------------------------------ */

  /**
   * 打开面板并开始一次问答。
   * @param {{query:string, providerId?:string}} params
   */
  async ask({ query, providerId = '' }) {
    this.mount();
    const question = String(query || '').trim();
    if (!question) return;

    // 中止上一次请求
    this.abort();

    this.query = question;
    this.providerId = providerId || '';
    this.raw = '';
    this.sources = [];
    this.results = [];
    this.resultMeta = null;
    this.sortMode = 'score';
    this.showAll = false;
    this.autoScroll = true;
    this.state = 'loading';
    this.demoActive = false;
    this.stopped = false;
    this.renderPending = false;
    this.sourceLabel = '';

    this.els.queryBubble.textContent = question;
    this.els.query.hidden = false;
    this.els.answer.innerHTML = '';
    this.els.answer.classList.remove('is-streaming');
    this.els.error.hidden = true;
    this.els.results.hidden = true;
    this.els.resList.textContent = '';
    this.els.skeleton.hidden = true;
    this.showEmptyState(false);
    this.renderHeadBadges(null);
    this.showTabs(false, 0);
    this.setPane('answer');
    this.isSearch = false;
    this.els.jump.hidden = true;
    this.els.loading.hidden = false;
    this.els.loadingText.textContent = '正在搜索…';
    this.els.demo.hidden = true;
    this.els.stopBtn.hidden = false;
    this.els.copyBtn.disabled = true;
    this.els.paneAnswer.scrollTop = 0;

    if (this.els.resSort) {
      this.els.resSort.querySelectorAll('[data-sort]').forEach((btn) => {
        btn.setAttribute('data-active', btn.getAttribute('data-sort') === 'score' ? 'true' : 'false');
      });
    }

    this.setBadge('流式', 'live');
    this.setTitle('AI 搜索', '');

    this.setOpen(true);

    const settings = this.getSettings();
    const secrets = this.getSecrets();
    const effective = this.providerId
      ? deepMerge(settings, { ai: { provider: this.providerId } })
      : settings;

    let provider;
    try {
      provider = getProvider(effective, secrets);
    } catch (err) {
      this.showError(err);
      return;
    }

    this.setTitle(provider.meta.name, provider.meta.model || '');
    if (provider.meta.demo) {
      this.showDemoBar(provider.meta.demoReason);
      this.setBadge('演示', 'demo');
    }

    // 搜索类 provider（元宝 / DeepSeek 联网）：默认展示结果列表，摘要放在第二个标签页。
    // 判断依据是 provider 能力（meta.kind），不再写死 provider id；旧数据缺 kind 时对 yuanbao 兼容兜底。
    const kind = provider.meta.kind || (provider.meta.id === 'yuanbao' ? 'search' : 'chat');
    this.isSearch = kind === 'search';
    this.sourceLabel = this.isSearch ? shortProviderName(provider.meta) : '';
    if (this.isSearch) {
      this.showTabs(true, 0);
      this.els.results.hidden = false;
      this.els.skeleton.hidden = false;
      this.setPane('results');
    } else {
      this.showTabs(false, 0);
      this.setPane('answer');
    }
    const controller = new AbortController();
    this.controller = controller;

    const onDelta = (delta) => {
      if (!delta) return;
      if (this.state === 'loading') {
        this.state = 'streaming';
        if (this.demoActive) this.setBadge('演示', 'demo');
        else this.setBadge('流式', 'live');
        this.els.loading.hidden = true;
        this.els.answer.classList.add('is-streaming');
      }
      this.raw += delta;
      this.queueRender();
    };

    const onSources = (sources, meta) => {
      this.renderResults(sources, meta);
      this.sources = this.results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
      }));
      // 结果列表出现后切到「搜索结果」页签，摘要仍可在第二个页签查看
      if (this.results.length) {
        this.showEmptyState(false);
        this.showTabs(true, this.results.length);
        this.setPane('results');
        this.autoScroll = false;
        this.els.paneAnswer.scrollTop = 0;
        this.els.jump.hidden = true;
      } else {
        this.els.skeleton.hidden = true;
        this.showTabs(false, 0);
        this.setPane('answer');
      }
    };

    const onStatus = (status) => {
      if (!status) return;
      if (status.demo) {
        this.showDemoBar(status.demoReason || 'missing-credentials');
        this.setBadge('演示', 'demo');
      }
      if (status.providerName) this.setTitle(status.providerName, status.model || '');
      if (status.phase === 'connecting') {
        this.els.loadingText.textContent = '正在连接 MCP 服务…';
      } else if (status.phase === 'searching') {
        this.els.loadingText.textContent = status.cached ? '正在读取缓存结果…' : '正在检索网页…';
      } else if (status.phase === 'reading') {
        this.els.loadingText.textContent = '正在精读前几篇正文…';
      } else if (status.phase === 'answering') {
        this.els.loadingText.textContent = '正在生成回答…';
      }
    };

    try {
      const result = await provider.run({
        query: question,
        settings: effective,
        secrets,
        signal: controller.signal,
        onDelta,
        onSources,
        onStatus,
      });

      if (controller.signal.aborted) return;

      if (!this.raw && result && result.text) {
        this.raw = result.text;
        this.queueRender();
      }
      if (result && Array.isArray(result.sources) && !this.results.length) {
        this.renderResults(result.sources, result.meta);
        this.sources = this.results.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
        }));
      }
      this.renderPending = false;
      this.renderAnswer();
      this.els.answer.classList.remove('is-streaming');
      this.els.loading.hidden = true;
      this.els.skeleton.hidden = true;
      this.els.stopBtn.hidden = true;
      this.els.copyBtn.disabled = false;
      this.state = 'done';
      if (this.isSearch) {
        // 搜索结果页签始终保留；0 条时展示空结果态，而不是留一片空白
        this.showTabs(true, this.results.length);
        if (!this.results.length) {
          this.showEmptyState(true);
          this.setPane('results');
        }
      } else {
        this.showTabs(false, 0);
        this.setPane('answer');
      }
      if (this.els.demo.hidden) this.setBadge('已完成', 'ok');
      else this.setBadge('演示', 'demo');
      if (this.autoScroll) this.scrollToBottom();
      this.els.jump.hidden = true;
    } catch (err) {
      if (controller.signal.aborted || (err && err.name === 'AbortError')) {
        this.els.answer.classList.remove('is-streaming');
        this.els.loading.hidden = true;
        this.els.skeleton.hidden = true;
        this.els.stopBtn.hidden = true;
        this.state = 'done';
        // 用户主动停止时保留「已停止」徽标；已被新请求接管时不要回写状态
        if (!this.stopped && this.controller === controller) this.setBadge('已完成', 'ok');
        if (this.isSearch && this.results.length) this.showTabs(true, this.results.length);
        return;
      }
      this.showError(err);
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** 显示错误态。 */
  showError(err) {
    const message = describeError(err);
    this.state = 'error';
    this.stopped = false;
    this.els.loading.hidden = true;
    this.els.skeleton.hidden = true;
    this.showEmptyState(false);
    this.els.answer.classList.remove('is-streaming');
    this.els.stopBtn.hidden = true;
    this.els.error.hidden = false;
    this.els.errMsg.textContent = message;
    this.showTabs(false, 0);
    this.setPane('answer');
    this.setBadge('出错', 'err');

    const needsConfig = err && (err.name === 'NeedsConfigError' || err instanceof NeedsConfigError);
    const configBtn = this.els.error.querySelector('[data-act="config"]');
    if (configBtn) configBtn.hidden = !needsConfig;

    if (!needsConfig && this.onToast) this.onToast(message, 'error');
  }

  /** 重新生成。 */
  retry() {
    if (!this.query) return;
    this.ask({ query: this.query, providerId: this.providerId });
  }

  /** 停止生成。 */
  stop() {
    if (!this.controller) return;
    this.stopped = true;
    this.abort();
    this.els.answer.classList.remove('is-streaming');
    this.els.loading.hidden = true;
    this.els.skeleton.hidden = true;
    this.els.stopBtn.hidden = true;
    this.state = 'done';
    // 已检索到的结果仍然可以查看，不要因为停止就把结果页签收起来
    if (this.isSearch && this.results.length) this.showTabs(true, this.results.length);
    this.setBadge('已停止', 'stop');
    if (this.raw) this.els.copyBtn.disabled = false;
    this.onToast('已停止生成', 'info');
  }

  /** 中止请求。 */
  abort() {
    if (this.controller) {
      try {
        this.controller.abort();
      } catch (err) {
        /* ignore */
      }
      this.controller = null;
    }
  }

  /** 复制全文（AI 总结 + 结果清单）。 */
  async copy() {
    const parts = [];
    if (this.raw.trim()) parts.push(this.raw.trim());
    if (this.results.length) {
      parts.push('', `参考结果（${this.results.length} 条）：`);
      this.results.forEach((item) => {
        parts.push(`${item.index}. ${item.title}${item.url ? ` — ${item.url}` : ''}`);
      });
    }
    const text = parts.join('\n').trim();
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        this.onToast('已复制到剪贴板', 'ok');
        return;
      }
      throw new Error('clipboard unavailable');
    } catch (err) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        this.onToast('已复制到剪贴板', 'ok');
      } catch (fallbackErr) {
        this.onToast('复制失败，请手动选择文本', 'error');
      }
    }
  }

  /** 打开 / 关闭面板。 */
  setOpen(open) {
    this.open = Boolean(open);
    this.root.classList.toggle('is-open', this.open);
    this.root.setAttribute('aria-hidden', this.open ? 'false' : 'true');
    // 让时钟与搜索框在面板打开时上移，保持可见可点
    document.body.classList.toggle('ai-open', this.open);
    if (!this.open) this.abort();
  }

  /** 关闭面板（Esc / 关闭按钮）。 */
  close() {
    if (!this.open) return false;
    this.setOpen(false);
    return true;
  }

  /** 重置面板内容（设置变更时可用）。 */
  reset() {
    this.abort();
    this.raw = '';
    this.query = '';
    this.sources = [];
    this.results = [];
    this.resultMeta = null;
    this.renderPending = false;
    this.stopped = false;
    this.sourceLabel = '';
    if (!this.mounted) return;
    this.els.answer.innerHTML = '';
    this.els.query.hidden = true;
    this.els.error.hidden = true;
    this.els.results.hidden = true;
    this.els.resList.textContent = '';
    this.els.skeleton.hidden = true;
    this.els.loading.hidden = true;
    this.els.demo.hidden = true;
    this.els.jump.hidden = true;
    this.els.copyBtn.disabled = true;
    this.showEmptyState(false);
    this.renderHeadBadges(null);
    this.showTabs(false, 0);
    this.setPane('answer');
    this.state = 'idle';
    this.demoActive = false;
    this.setBadge('准备中', 'live');
  }
}
