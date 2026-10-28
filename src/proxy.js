/**
 * proxy.js — 壁纸素材专用代理（chrome.proxy + PAC）
 *
 * 作用：把 wallhaven.cc 与 Steam（创意工坊 / 图片 CDN）的流量指到用户填写的本地代理
 * （如 Clash 的 127.0.0.1:7890），其它网站保持直连。这样即使没开「系统代理」，
 * 只要代理程序在跑，壁纸库和工坊就都能用。
 *
 * 注意：
 * - chrome.proxy 是浏览器级配置，扩展设置后优先于系统代理；
 *   因此默认关闭（设置里留空），只在用户显式填写地址后接管，清空即恢复系统行为。
 * - 普通浏览器预览环境（无 chrome.proxy）自动跳过，不报错。
 */

import { buildWallhavenPac, normalizeProxyAddr } from './defaults.js';

/** PAC 内容版本：脚本规则变更时 +1，保证老用户重载后也能拿到新规则。 */
const PAC_VERSION = 2;

/** 记录当前已应用的「地址 + 规则版本」，避免重复 set/clear。 */
let appliedKey = null;

/** chrome.proxy 是否可用。 */
function proxyApi() {
  try {
    if (typeof chrome !== 'undefined' && chrome && chrome.proxy && chrome.proxy.settings) {
      return chrome.proxy;
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/**
 * 同步代理配置（设置加载与变更时调用）。
 * @param {string} rawAddr 用户填写的代理地址；空 = 清除接管
 */
export function syncWallhavenProxy(rawAddr) {
  const api = proxyApi();
  if (!api) return; // 预览环境：不动
  const addr = normalizeProxyAddr(rawAddr);

  // 地址非法但非空：提示性警告并按关闭处理
  if (!addr && String(rawAddr || '').trim()) {
    console.warn('[proxy] 壁纸库代理地址格式不正确，已忽略：', rawAddr);
  }

  const key = `${addr}|${PAC_VERSION}`;
  if (key === appliedKey) return; // 无变化

  if (!addr) {
    if (appliedKey !== null) {
      appliedKey = null;
      try {
        api.settings.clear({ scope: 'regular' }, () => void chrome.runtime.lastError);
      } catch (err) {
        console.warn('[proxy] 清除代理配置失败', err);
      }
    }
    return;
  }

  const pac = buildWallhavenPac(addr);
  if (!pac) return;
  try {
    api.settings.set(
      {
        value: { mode: 'pac_script', pacScript: { data: pac } },
        scope: 'regular',
      },
      () => void chrome.runtime.lastError,
    );
    appliedKey = key;
    console.info('[proxy] 壁纸库 / 工坊已走专用代理：', addr);
  } catch (err) {
    console.warn('[proxy] 代理配置应用失败', err);
  }
}

/** 仅供测试：重置内部状态。 */
export function resetProxyStateForTest() {
  appliedKey = null;
}
