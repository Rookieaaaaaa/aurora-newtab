/**
 * clock.js — 时钟 / 日期 / 问候语
 * 采用「对齐分钟边界」的调度方式，避免 1s 轮询造成漂移与额外唤醒。
 */

import { greetingAt } from './defaults.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

export class Clock {
  /**
   * @param {{timeEl:HTMLElement, dateEl:HTMLElement, greetingEl:HTMLElement}} refs
   */
  constructor({ timeEl, dateEl, greetingEl }) {
    this.timeEl = timeEl;
    this.dateEl = dateEl;
    this.greetingEl = greetingEl;
    this.options = {
      hour12: false,
      showSeconds: false,
      showDate: true,
      showGreeting: true,
    };
    this.timer = 0;
    this.onVisibility = this.onVisibility.bind(this);
  }

  /** 更新显示选项并立即重绘。 */
  update(clockOptions) {
    this.options = {
      hour12: Boolean(clockOptions && clockOptions.hour12),
      showSeconds: Boolean(clockOptions && clockOptions.showSeconds),
      showDate: clockOptions ? clockOptions.showDate !== false : true,
      showGreeting: clockOptions ? clockOptions.showGreeting !== false : true,
    };
    this.render();
    this.schedule();
  }

  /** 启动（首次渲染 + 调度）。 */
  start() {
    this.render();
    this.schedule();
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** 停止。 */
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  onVisibility() {
    if (!document.hidden) {
      this.render();
      this.schedule();
    }
  }

  /** 渲染当前时间。 */
  render() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const meridiem = hours < 12 ? '上午' : '下午';

    if (this.options.hour12) {
      hours %= 12;
      if (hours === 0) hours = 12;
    }

    let text = this.options.hour12
      ? `${hours}:${pad2(minutes)}`
      : `${pad2(hours)}:${pad2(minutes)}`;
    if (this.options.showSeconds) text += `:${pad2(seconds)}`;

    // 12 小时制下：问候语已表达"上午/下午"，时间不再重复加后缀；
    // 只有在关闭问候语时才补上后缀，避免信息缺失。
    const showMeridiem = this.options.hour12 && !this.options.showGreeting;

    if (this.timeEl) {
      this.timeEl.textContent = text;
      if (showMeridiem) {
        const badge = document.createElement('span');
        badge.className = 'clock-meridiem';
        badge.textContent = meridiem;
        this.timeEl.appendChild(badge);
      }
    }

    if (this.dateEl) {
      if (this.options.showDate) {
        this.dateEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 星期${WEEKDAYS[now.getDay()]}`;
      } else {
        this.dateEl.textContent = '';
      }
    }

    if (this.greetingEl) {
      this.greetingEl.textContent = this.options.showGreeting ? greetingAt(now.getHours()) : '';
    }
  }

  /** 调度下一次刷新（对齐到秒/分钟边界）。 */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const now = new Date();
    const ms = this.options.showSeconds
      ? 1000 - now.getMilliseconds()
      : 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
    this.timer = setTimeout(() => {
      this.render();
      this.schedule();
    }, Math.max(120, ms + 20));
  }
}
