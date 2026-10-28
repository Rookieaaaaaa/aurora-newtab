/**
 * icons.js — 内联 SVG 图标集合（全部手写 path/几何图形，无外部依赖）
 * 用法：setIcon(el, 'search') / const html = icon('gear')
 */

const PATHS = {
  search:
    '<circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21"/>',
  gear:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.34a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.64 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.66 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.64h.09A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.36 9v.09A1.7 1.7 0 0 0 20.9 10.1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  upload:
    '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download:
    '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  grip:
    '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  copy:
    '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  refresh:
    '<path d="M4.5 12a7.5 7.5 0 0 1 12.9-5.2L20 9.5"/><path d="M20 5v4.5h-4.5"/><path d="M19.5 12a7.5 7.5 0 0 1-12.9 5.2L4 14.5"/><path d="M4 19v-4.5h4.5"/>',
  external:
    '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.4"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronUp: '<path d="M6 14.5l6-6 6 6"/>',
  arrowRight: '<path d="M4.5 12h15"/><path d="M13 5.5l6.5 6.5-6.5 6.5"/>',
  arrowDown: '<path d="M12 4.5v15"/><path d="M5.5 13l6.5 6.5 6.5-6.5"/>',
  eye:
    '<path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="2.7"/>',
  eyeOff:
    '<path d="M3.5 3.5l17 17"/><path d="M10.4 6.1A10.6 10.6 0 0 1 12 6c6.2 0 9.8 6 9.8 6a17.6 17.6 0 0 1-3.4 4.1"/><path d="M6.4 7.7A17.2 17.2 0 0 0 2.2 12s3.6 6.4 9.8 6.4a10.8 10.8 0 0 0 4.2-.83"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  check: '<path d="M4.5 12.5l5 5L20 6.8"/>',
  alert:
    '<path d="M12 8.4v5"/><circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none"/><path d="M10.4 4 2.7 17.3A2 2 0 0 0 4.4 20.3h15.2a2 2 0 0 0 1.7-3L13.6 4a2 2 0 0 0-3.2 0Z"/>',
  info:
    '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5"/><circle cx="12" cy="8" r="1" fill="currentColor" stroke="none"/>',
  trash:
    '<path d="M4 7h16"/><path d="M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.3 7l.9 12.2A1.8 1.8 0 0 0 9 21h6a1.8 1.8 0 0 0 1.8-1.8L17.7 7"/><path d="M10.4 11v6"/><path d="M13.6 11v6"/>',
  edit:
    '<path d="M4 20h4l10.2-10.2a2.7 2.7 0 0 0-3.8-3.8L4.2 16.2 4 20Z"/><path d="M13.6 6.8l3.6 3.6"/>',
  link:
    '<path d="M10.1 13.9a4.6 4.6 0 0 0 6.5 0l2.2-2.2a4.6 4.6 0 0 0-6.5-6.5l-1 1"/><path d="M13.9 10.1a4.6 4.6 0 0 0-6.5 0l-2.2 2.2a4.6 4.6 0 0 0 6.5 6.5l1-1"/>',
  sparkles:
    '<path d="M11.4 3.6 13 8.1l4.5 1.6L13 11.3l-1.6 4.5-1.6-4.5L5.3 9.7 9.8 8.1l1.6-4.5Z"/><path d="M18 14.4l.85 2.1 2.1.85-2.1.85-.85 2.1-.85-2.1-2.1-.85 2.1-.85.85-2.1Z"/>',
  more:
    '<circle cx="5.2" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.8" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  globe:
    '<circle cx="12" cy="12" r="8.6"/><path d="M3.6 12h16.8"/><path d="M12 3.4a14 14 0 0 1 0 17.2 14 14 0 0 1 0-17.2Z"/>',
  image:
    '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4"/><circle cx="8.6" cy="9.6" r="1.6"/><path d="M20.6 16.4 15.4 12 6 20"/>',
  video:
    '<rect x="3.2" y="6" width="12.6" height="12" rx="2.4"/><path d="M15.8 10.6 20.8 8v8l-5-2.6v-2.8Z"/>',
  palette:
    '<path d="M12 3.2a8.8 8.8 0 0 0 0 17.6c1.4 0 2-1 2-1.9 0-1.6-1.5-1.7-1.5-3 0-1 .8-1.7 1.9-1.7h1.8a4.6 4.6 0 0 0 4.6-4.6c0-3.6-3.9-6.4-8.8-6.4Z"/><circle cx="8" cy="10" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.6" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none"/>',
  clock:
    '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4v5.1l3.4 2"/>',
  shield:
    '<path d="M12 3.2 19 6v6.1c0 4.2-2.9 7.7-7 8.9-4.1-1.2-7-4.7-7-8.9V6l7-2.8Z"/><path d="M9 12l2.1 2.1L15.2 10"/>',
  database:
    '<ellipse cx="12" cy="6.4" rx="7.8" ry="2.9"/><path d="M4.2 6.4v11.2c0 1.6 3.5 2.9 7.8 2.9s7.8-1.3 7.8-2.9V6.4"/><path d="M4.2 12c0 1.6 3.5 2.9 7.8 2.9s7.8-1.3 7.8-2.9"/>',
  reset:
    '<path d="M4 4.6v5.2h5.2"/><path d="M4.7 13.6A7.6 7.6 0 1 0 6.6 5.9L4 9.8"/>',
  bolt: '<path d="M13.4 2.6 5.8 13.4h5l-1.2 8 7.6-10.8h-5l1.2-8Z"/>',
  key:
    '<circle cx="8" cy="15.6" r="3.6"/><path d="M10.6 13 20 3.6"/><path d="M16.4 7.2 19 9.8"/><path d="M14 9.6 16.4 12"/>',
};

/**
 * 返回内联 SVG 字符串。
 * @param {string} name 图标名
 * @param {{size?:number, stroke?:number, cls?:string}} [options]
 */
export function icon(name, options = {}) {
  const body = PATHS[name] || PATHS.info;
  const size = options.size ? ` width="${options.size}" height="${options.size}"` : '';
  const stroke = options.stroke || 1.7;
  const cls = options.cls ? ` class="${options.cls}"` : '';
  return (
    `<svg${cls}${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
  );
}

/** 把图标写入指定元素。 */
export function setIcon(el, name, options = {}) {
  if (!el) return;
  el.innerHTML = icon(name, options);
}
