/**
 * dialog.js — 通用对话框 / 确认框 / toast
 * 所有浮层统一从 modal-root 渲染，Esc 由 main.js 调用 closeTopModal() 关闭。
 */

import { icon } from './icons.js';

let modalRoot = null;
let toastRoot = null;
const stack = [];

/** 初始化（由 main.js 调用一次）。 */
export function initDialog({ modal, toast }) {
  modalRoot = modal;
  toastRoot = toast;
  if (!modalRoot) return;
  // 点击遮罩关闭最上层（仅一次绑定，避免每次开框重复注册）
  modalRoot.addEventListener('click', (event) => {
    if (event.target !== modalRoot) return;
    const entry = stack[stack.length - 1];
    if (entry && entry.dismissible) entry.close();
  });
}

/* -------------------------------------------------------------------------- */
/*                                   toast                                    */
/* -------------------------------------------------------------------------- */

/**
 * 轻提示。
 * @param {string} message
 * @param {'info'|'ok'|'error'} [type]
 * @param {number} [duration] 毫秒
 */
export function toast(message, type = 'info', duration = 2600) {
  if (!toastRoot) {
    console.warn('[toast]', message);
    return;
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.type = type;
  const iconName = type === 'error' ? 'alert' : type === 'ok' ? 'check' : 'info';
  el.innerHTML = `${icon(iconName)}<span></span>`;
  el.querySelector('span').textContent = String(message || '');
  toastRoot.appendChild(el);

  // 最多同时显示 3 条
  while (toastRoot.children.length > 3) {
    toastRoot.removeChild(toastRoot.firstElementChild);
  }

  const remove = () => {
    el.classList.add('is-out');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  };
  setTimeout(remove, Math.max(800, duration));
}

/* -------------------------------------------------------------------------- */
/*                                  对话框                                     */
/* -------------------------------------------------------------------------- */

/**
 * 打开通用对话框。
 * @param {object} options
 * @param {string} options.title 标题
 * @param {string|HTMLElement} [options.content] 主体内容
 * @param {Array<{label:string,kind?:string,onClick?:Function,closeOnClick?:boolean}>} [options.actions] 底部按钮
 * @param {number} [options.width] 最大宽度 px
 * @param {boolean} [options.dismissible] 是否允许点击遮罩/Esc 关闭，默认 true
 * @param {Function} [options.onClose] 关闭回调
 * @param {Function} [options.onMount] 挂载后回调 (bodyEl, handle) => void
 * @returns {{close:Function, el:HTMLElement, body:HTMLElement, setActions:Function}}
 */
export function openModal(options = {}) {
  if (!modalRoot) {
    throw new Error('dialog 尚未初始化');
  }
  const {
    title = '',
    content = '',
    actions = [],
    width = 460,
    dismissible = true,
    onClose = null,
    onMount = null,
  } = options;

  const el = document.createElement('div');
  el.className = 'modal';
  el.style.maxWidth = `${width}px`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'modal-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-btn';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.innerHTML = icon('close');
  head.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'modal-body scroll-thin';
  if (content instanceof HTMLElement) body.appendChild(content);
  else body.innerHTML = String(content || '');

  const foot = document.createElement('div');
  foot.className = 'modal-foot';

  const handle = {
    el,
    body,
    close: () => {},
    setActions: () => {},
  };

  const renderActions = (list) => {
    foot.textContent = '';
    if (!list || !list.length) {
      foot.hidden = true;
      return;
    }
    foot.hidden = false;
    list.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${action.kind || 'ghost'}`;
      btn.textContent = action.label;
      btn.addEventListener('click', async () => {
        if (typeof action.onClick === 'function') {
          const result = await action.onClick(handle);
          if (result === false) return;
        }
        if (action.closeOnClick !== false) handle.close();
      });
      foot.appendChild(btn);
    });
  };

  renderActions(actions);
  handle.setActions = renderActions;

  el.appendChild(head);
  el.appendChild(body);
  el.appendChild(foot);
  modalRoot.appendChild(el);

  const entry = { el, dismissible, onClose, close: null };
  const close = () => {
    const index = stack.indexOf(entry);
    if (index === -1) return;
    stack.splice(index, 1);
    el.classList.remove('is-open');
    if (el.parentNode) el.parentNode.removeChild(el);
    if (!stack.length && modalRoot) {
      modalRoot.classList.remove('is-open');
      modalRoot.setAttribute('aria-hidden', 'true');
    }
    if (typeof onClose === 'function') onClose();
  };
  handle.close = close;
  entry.close = close;
  stack.push(entry);

  closeBtn.addEventListener('click', close);

  modalRoot.hidden = false;
  modalRoot.setAttribute('aria-hidden', 'false');
  // 强制一次重排，保证过渡动画生效
  void modalRoot.offsetHeight;
  modalRoot.classList.add('is-open');
  el.classList.add('is-open');

  if (typeof onMount === 'function') onMount(body, handle);

  setTimeout(() => {
    const focusable = body.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  }, 60);

  return handle;
}

/** 关闭最上层对话框（Esc）。返回是否有关闭动作。 */
export function closeTopModal() {
  const entry = stack[stack.length - 1];
  if (!entry) return false;
  if (!entry.dismissible) return false;
  entry.close();
  return true;
}

/** 是否有对话框打开。 */
export function hasModal() {
  return stack.length > 0;
}

/**
 * 确认框。
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {string} [options.confirmText]
 * @param {string} [options.cancelText]
 * @param {boolean} [options.danger]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options = {}) {
  const {
    title = '确认操作',
    message = '',
    confirmText = '确定',
    cancelText = '取消',
    danger = false,
  } = options;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const handle = openModal({
      title,
      content: `<p></p>`,
      width: 420,
      actions: [
        { label: cancelText, kind: 'ghost', onClick: () => finish(false) },
        {
          label: confirmText,
          kind: danger ? 'danger' : 'primary',
          onClick: () => finish(true),
        },
      ],
      onClose: () => finish(false),
    });
    handle.body.querySelector('p').textContent = message;
  });
}

/**
 * 纯提示框。
 * @param {{title?:string, message?:string, okText?:string}} options
 * @returns {Promise<void>}
 */
export function alertDialog(options = {}) {
  const { title = '提示', message = '', okText = '知道了' } = options;
  return new Promise((resolve) => {
    const handle = openModal({
      title,
      content: '<p></p>',
      width: 420,
      actions: [{ label: okText, kind: 'primary', onClick: () => resolve() }],
      onClose: () => resolve(),
    });
    handle.body.querySelector('p').textContent = message;
  });
}
