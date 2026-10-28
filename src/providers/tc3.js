/**
 * providers/tc3.js — 腾讯云 API 3.0 签名（TC3-HMAC-SHA256）
 *
 * 纯 WebCrypto 实现，无依赖，浏览器与 Node 18+ 均可运行。
 * 生成的头可直接用于 wsa.tencentcloudapi.com 等云 API 接口。
 *
 * 参考：https://cloud.tencent.com/document/api/1806/121816
 */

const encoder = new TextEncoder();

/** 字节数组转小写 hex。 */
function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** SHA-256 → hex。 */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return toHex(digest);
}

/**
 * HMAC-SHA256。
 * @param {ArrayBuffer|Uint8Array} rawKey
 * @param {string} message
 * @returns {Promise<ArrayBuffer>}
 */
async function hmacSha256(rawKey, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(message));
}

/** 取 UTC 日期 yyyy-mm-dd（签名的 credential scope 要求 UTC）。 */
function utcDate(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * 计算 TC3 签名并返回可直接合并进 fetch headers 的对象。
 *
 * @param {object} options
 * @param {string} options.secretId      腾讯云 SecretId
 * @param {string} options.secretKey     腾讯云 SecretKey
 * @param {string} options.host          请求域名，如 wsa.tencentcloudapi.com
 * @param {string} [options.service]     产品名，元宝搜索固定 wsa
 * @param {string} options.action        X-TC-Action，如 SearchPro
 * @param {string} options.version       X-TC-Version，如 2025-05-08
 * @param {string} options.body          请求体原文（必须与实际发送的字符串完全一致）
 * @param {number} [options.timestamp]   Unix 秒，默认当前时间
 * @param {string} [options.path]        URI 路径，默认 '/'
 * @param {string} [options.region]      X-TC-Region，不需要时留空
 * @returns {Promise<{headers: object, timestamp: number, signature: string}>}
 */
export async function signTc3(options) {
  const {
    secretId,
    secretKey,
    host,
    service = 'wsa',
    action,
    version,
    body,
    timestamp = Math.floor(Date.now() / 1000),
    path = '/',
    region = '',
  } = options || {};

  if (!secretId) throw new Error('缺少 SecretId');
  if (!secretKey) throw new Error('缺少 SecretKey');
  if (!host) throw new Error('缺少请求域名');

  const payload = String(body === undefined || body === null ? '' : body);
  const date = utcDate(timestamp);
  const contentType = 'application/json';

  // 1) 拼接规范请求串 CanonicalRequest
  //    注意：HTTP 头 key 必须小写并按字典序排列，此处仅 content-type 与 host 参与签名
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    path,
    '', // CanonicalQueryString：无查询参数
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(payload),
  ].join('\n');

  // 2) 拼接待签字符串 StringToSign
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // 3) 派生签名密钥并计算签名
  const kDate = await hmacSha256(encoder.encode(`TC3${secretKey}`), date);
  const kService = await hmacSha256(kDate, service);
  const kSigning = await hmacSha256(kService, 'tc3_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  // 4) 组装请求头
  const headers = {
    Authorization:
      `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'Content-Type': contentType,
    'X-TC-Action': String(action),
    'X-TC-Version': String(version),
    'X-TC-Timestamp': String(timestamp),
  };
  if (region) headers['X-TC-Region'] = String(region);

  return { headers, timestamp, signature };
}
