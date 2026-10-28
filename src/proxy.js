/**
 * proxy.js — 壁纸库专用代理（chrome.proxy + PAC）
 *
 * 作用：把 wallhaven.cc 及其子域名的流量指到用户填写的本地代理（如 Clash 的 127.0.0.1:7890），
 * 其它所有网站保持直连。这样即使没开「系统代理」，只要代理程序在跑，壁纸库就能用。
 *
 * 注意：
 * - chrome.proxy 是浏览器级配置，扩展设置后优先于系统代理；
 *   因此默认关闭（设置里留空），只在用户显式填写地址后接管，清空即恢复系统行为。
 * - 普通浏览器预览环境（无 chrome.proxy）自动跳过，不报错。
 */

import { buildWallhavenPac, normalizeProxyAddr } from './defaults.js';

/** 记录当前已应用的代理地址，避免重复 set/clear。 */
let appliedAddr = null;

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

  if (addr === appliedAddr) return; // 无变化

  if (!addr) {
    if (appliedAddr !== null) {
      appliedAddr = null;
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
    appliedAddr = addr;
    console.info('[proxy] 壁纸库已走专用代理：', addr);
  } catch (err) {
    console.warn('[proxy] 代理配置应用失败', err);
  }
}

/** 仅供测试：重置内部状态。 */
export function resetProxyStateForTest() {
  appliedAddr = null;
}
