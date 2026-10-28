/**
 * providers/custom.js — 任意 OpenAI 兼容端点
 * 与 deepseek.js 同构，仅 Base URL / 模型 / 鉴权头可完全自定义。
 */

import { buildMessages, streamChat } from './deepseek.js';
import { NeedsConfigError } from '../utils.js';

/**
 * 统一 provider 接口。
 */
export async function run(context) {
  const { query, settings, secrets, signal, onDelta, onSources, onStatus } = context;
  const cfg = (secrets && secrets.custom) || {};

  if (!cfg.baseUrl) throw new NeedsConfigError('尚未配置自定义服务的 Base URL');
  if (!cfg.apiKey) throw new NeedsConfigError('尚未配置自定义服务的 API Key');
  if (!cfg.model) throw new NeedsConfigError('尚未配置自定义服务的模型名称');

  if (typeof onStatus === 'function') {
    onStatus({
      demo: false,
      phase: 'answering',
      providerName: '自定义模型',
      model: cfg.model,
    });
  }

  const text = await streamChat({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    messages: buildMessages(settings, query),
    temperature: settings.ai ? settings.ai.temperature : 0.6,
    stream: settings.ai ? settings.ai.stream !== false : true,
    authHeader: cfg.authHeader || 'Authorization',
    authPrefix: cfg.authPrefix === undefined ? 'Bearer ' : cfg.authPrefix,
    signal,
    onDelta,
  });

  if (typeof onSources === 'function') onSources([]);
  return { text, sources: [], model: cfg.model };
}
