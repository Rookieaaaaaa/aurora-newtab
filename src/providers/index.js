/**
 * providers/index.js — provider 注册表 + 统一接口 + 演示模式
 */

import { sleep } from '../utils.js';
import * as customProvider from './custom.js';
import * as deepseekProvider from './deepseek.js';
import * as deepseekSearchProvider from './deepseek-search.js';
import * as yuanbaoProvider from './yuanbao-mcp.js';

/**
 * provider 元信息。
 * kind 表示能力类型，UI 依赖它决定布局（不要再按 provider id 写死判断）：
 *   - search：先出结果列表，再出带引用的总结
 *   - chat：纯模型问答
 */
export const PROVIDER_META = {
  yuanbao: {
    id: 'yuanbao',
    name: '元宝 AI 搜索',
    desc: '腾讯云云 API · 联网检索 + 模型总结',
    kind: 'search',
    module: yuanbaoProvider,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: 'OpenAI 兼容接口 · 纯模型问答',
    kind: 'chat',
    module: deepseekProvider,
  },
  'deepseek-search': {
    id: 'deepseek-search',
    name: 'DeepSeek 联网',
    desc: 'DeepSeek 原生搜索 + 抓取 · 带引用总结',
    kind: 'search',
    module: deepseekSearchProvider,
  },
  custom: {
    id: 'custom',
    name: '自定义模型',
    desc: '任意 OpenAI 兼容端点',
    kind: 'chat',
    module: customProvider,
  },
};

/** 全部 provider id（保持声明顺序，供设置页等 UI 派生使用）。 */
export const PROVIDER_IDS = Object.keys(PROVIDER_META);

/** 按 id 取元信息。 */
export function metaOf(providerId) {
  return PROVIDER_META[providerId] || PROVIDER_META.yuanbao;
}

/**
 * 取 provider 能力类型（'search' | 'chat'），未知 id 回落 'chat'。
 * @param {string} providerId
 * @returns {'search'|'chat'}
 */
export function kindOf(providerId) {
  const meta = PROVIDER_META[providerId];
  if (!meta) return 'chat';
  return meta.kind === 'search' ? 'search' : 'chat';
}

/**
 * 判断某个 provider 是否已配置必要凭证。
 * @param {string} providerId
 * @param {object} secrets
 */
export function hasCredentials(providerId, secrets) {
  return configState(providerId, secrets) === 'ready';
}

/**
 * 凭证完整度（用于给面板/设置提示更精确的原因）：
 *  - missing：所需字段**全部为空**
 *  - partial：填了但没填全（例如只填了 MCP 地址没填 Key）
 *  - ready：已配齐
 * @param {string} providerId
 * @param {object} secrets
 * @returns {'missing'|'partial'|'ready'}
 */
export function configState(providerId, secrets) {
  const s = secrets || {};
  let fields = [];
  if (providerId === 'deepseek' || providerId === 'deepseek-search') {
    // 两者同源：只用同一个 DeepSeek API Key
    fields = [(s.deepseek && s.deepseek.apiKey) || ''];
  } else if (providerId === 'custom') {
    const cfg = s.custom || {};
    fields = [cfg.baseUrl || '', cfg.apiKey || '', cfg.model || ''];
  } else {
    const cfg = s.yuanbao || {};
    // 鉴权方式分流：TC3 只要密钥对（endpoint 有云 API 默认值），Bearer 才需要地址 + API Key
    const mode = String(cfg.authMode || '').toLowerCase();
    const tc3 = mode === 'tc3' || (mode !== 'bearer' && Boolean(cfg.secretId && cfg.secretKey));
    fields = tc3
      ? [cfg.secretId || '', cfg.secretKey || '']
      : [cfg.endpoint || '', cfg.apiKey || ''];
  }
  const filled = fields.filter((value) => String(value).trim()).length;
  if (filled === 0) return 'missing';
  if (filled < fields.length) return 'partial';
  return 'ready';
}

/* -------------------------------------------------------------------------- */
/*                                 演示模式                                    */
/* -------------------------------------------------------------------------- */

const DEMO_TEXT = [
  '### 演示模式',
  '',
  '下面是**本地生成的示例结果**（不联网），用来展示 20 条搜索结果的列表排版。',
  '',
  '配置密钥后，这里会变成真实的元宝搜索结果，并可按需生成带 `[1][2]` 引用的 AI 总结。',
  '',
  '> 在 设置 → AI 搜索 中填入服务地址与 API Key，点击「测试连接」出现绿点即生效。',
].join('\n');

/** 演示用的站点池（域名真实，链接指向站内搜索，保证可点开）。 */
const DEMO_SITES = [
  ['腾讯云开发者社区', 'cloud.tencent.com'],
  ['知乎', 'zhihu.com'],
  ['掘金', 'juejin.cn'],
  ['CSDN', 'blog.csdn.net'],
  ['少数派', 'sspai.com'],
  ['36氪', '36kr.com'],
  ['InfoQ', 'infoq.cn'],
  ['GitHub', 'github.com'],
  ['博客园', 'cnblogs.com'],
  ['简书', 'jianshu.com'],
  ['机器之心', 'jiqizhixin.com'],
  ['量子位', 'qbitai.com'],
  ['腾讯新闻', 'news.qq.com'],
  ['新浪科技', 'tech.sina.com.cn'],
  ['虎嗅', 'huxiu.com'],
  ['爱范儿', 'ifanr.com'],
  ['开源中国', 'oschina.net'],
  ['V2EX', 'v2ex.com'],
  ['哔哩哔哩', 'bilibili.com'],
  ['微博', 'weibo.com'],
];

const DEMO_TITLES = [
  (q) => `${q} 是什么？一篇讲清核心原理与适用场景`,
  (q) => `${q} 实践笔记：从 0 到 1 的落地过程`,
  (q) => `深入理解 ${q}：常见误区与避坑清单`,
  (q) => `${q} 最新进展与趋势梳理`,
  (q) => `如何评价 ${q}？一线开发者的真实体验`,
  (q) => `${q} 官方文档速查与版本变更记录`,
  (q) => `${q} 性能优化：我们踩过的 8 个坑`,
  (q) => `${q} 与同类方案对比，到底该怎么选`,
  (q) => `${q} 高频问题整理（附答案）`,
  (q) => `用 ${q} 做一个能上线的 Demo：完整步骤`,
  (q) => `${q} 源码阅读笔记：关键设计拆解`,
  (q) => `${q} 成本与选型：一份可落地的决策表`,
  (q) => `${q} 在团队协作中的落地经验`,
  (q) => `${q} 常见报错与排查手册`,
  (q) => `${q} 学习路线：从入门到进阶`,
  (q) => `${q} 的安全与合规注意事项`,
  (q) => `${q} 生态盘点：值得关注的 12 个项目`,
  (q) => `${q} 实测数据与基准对比`,
  (q) => `${q} 最佳实践：来自一线工程师的 15 条建议`,
  (q) => `${q} 接下来会怎么发展？三个判断`,
];

const DEMO_SNIPPETS = [
  (q) => `从基本概念出发，梳理 ${q} 的定义、边界与典型使用场景，并给出最小可用示例，适合第一次接触的读者快速建立整体认知。`,
  (q) => `记录了团队在真实业务中引入 ${q} 的完整过程：选型对比、改造范围、灰度策略与最终收益，含关键代码片段。`,
  (q) => `整理了使用 ${q} 时最容易踩的坑，包括配置项含义、常见误用方式与对应修复方法，附排查清单。`,
  (q) => `汇总近期与 ${q} 相关的版本更新、社区讨论与生产案例，帮助你判断当前是否适合投入。`,
  (q) => `从开发体验、稳定性、成本三个维度讨论 ${q} 的实际表现，并对比了另外两种常见做法。`,
  (q) => `${q} 的官方说明与示例索引，包含参数解释、限制条件与常见问题，可作为日常查阅手册。`,
  (q) => `在高并发场景下对 ${q} 做了压测与调优，记录了瓶颈定位过程与优化后的指标变化。`,
  (q) => `把 ${q} 与相近方案放在同一组指标下对比，给出不同团队规模下的选型建议。`,
  (q) => `面试中经常被问到的 ${q} 相关问题，按原理、实践、故障排查三类整理，附参考答案。`,
  (q) => `从环境准备到部署上线，完整演示如何用 ${q} 搭建一个可运行的小项目。`,
];

/** 简易字符串哈希，用于让演示结果在同一个 query 下保持稳定。 */
function hashOf(text) {
  let hash = 0;
  const str = String(text || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) % 1000000007;
  }
  return hash;
}

/** 生成 20 条演示结果，字段与真实检索保持一致。 */
function buildDemoSources(query, limit) {
  const text = String(query || '').trim() || '示例问题';
  const total = Math.max(10, Math.min(20, Number(limit) || 20));
  const seed = hashOf(text);
  const list = [];
  const today = new Date();

  for (let i = 0; i < total; i += 1) {
    const site = DEMO_SITES[(seed + i * 3) % DEMO_SITES.length];
    const titleFn = DEMO_TITLES[i % DEMO_TITLES.length];
    const snippetFn = DEMO_SNIPPETS[(seed + i) % DEMO_SNIPPETS.length];
    const day = new Date(today.getTime() - (i * 3 + (seed % 5)) * 86400000);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(
      day.getDate(),
    ).padStart(2, '0')}`;
    const score = Math.max(0.42, 0.96 - i * 0.028 - ((seed + i) % 7) * 0.004);

    list.push({
      title: titleFn(text),
      url: `https://www.bing.com/search?q=${encodeURIComponent(`${text} site:${site[1]}`)}`,
      snippet: snippetFn(text),
      domain: site[1],
      site: site[0],
      date,
      score: Number(score.toFixed(3)),
      authority: null,
    });
  }
  return list;
}

/**
 * 演示 provider：完全本地生成，不发起任何网络请求。
 * @param {string} providerId
 * @param {'missing-credentials'|'forced'} reason
 * @returns {{meta:object, run:Function}}
 */
export function createDemoProvider(providerId, reason = 'missing-credentials') {
  const base = metaOf(providerId);
  return {
    meta: {
      id: providerId || 'demo',
      name: base.name,
      model: 'aurora-demo',
      kind: base.kind === 'search' ? 'search' : 'chat',
      configured: false,
      demo: true,
      demoReason: reason,
    },
    async run(context) {
      const { query, settings, signal, onDelta, onSources, onStatus } = context;
      const limit = settings && settings.ai && settings.ai.maxSources ? settings.ai.maxSources : 20;
      const sources = buildDemoSources(query, limit);

      if (typeof onStatus === 'function') {
        onStatus({
          demo: true,
          demoReason: reason,
          phase: 'searching',
          providerName: base.name,
          model: 'aurora-demo',
        });
      }
      if (typeof onSources === 'function') {
        onSources(sources, {
          resultCount: sources.length,
          elapsedMs: 46,
          tool: 'demo',
          transport: 'LOCAL',
          requested: sources.length,
        });
      }
      const text = DEMO_TEXT;
      const size = 4;
      for (let i = 0; i < text.length; i += size) {
        if (signal && signal.aborted) {
          throw new DOMException('已取消', 'AbortError');
        }
        const delta = text.slice(i, i + size);
        if (typeof onDelta === 'function') onDelta(delta);
        await sleep(28);
      }
      return {
        text,
        sources,
        model: 'aurora-demo',
        meta: { resultCount: sources.length, elapsedMs: 46, tool: 'demo', transport: 'LOCAL' },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  工厂                                       */
/* -------------------------------------------------------------------------- */

/**
 * 根据设置与密钥返回可用的 provider。
 *
 * 判定顺序：
 *   1. 该 provider 所需凭证为空 + 未关闭「演示模式」→ 演示 provider（本地流式，不联网）
 *   2. 用户主动关闭「演示模式」且凭证为空 → 真实 provider，由它抛出 NeedsConfigError（提示去填写密钥）
 *   3. 凭证填了但不完整 / 已配齐 → 真实 provider（缺失项或密钥错误由它抛出可读错误）
 *
 * 开关必须真实有效：用户关掉「演示模式」后不应再看到演示回答。
 * @param {object} settings
 * @param {object} secrets
 */
export function getProvider(settings, secrets) {
  const aiSettings = (settings && settings.ai) || {};
  const providerId = PROVIDER_META[aiSettings.provider] ? aiSettings.provider : 'yuanbao';
  const state = configState(providerId, secrets);
  const demoAllowed = aiSettings.demoMode !== false;

  if (state === 'missing' && demoAllowed) {
    return createDemoProvider(providerId, 'missing-credentials');
  }

  const meta = metaOf(providerId);
  return {
    meta: {
      id: providerId,
      name: meta.name,
      model: '',
      kind: meta.kind === 'search' ? 'search' : 'chat',
      configured: state === 'ready',
      demo: false,
      configState: state,
    },
    run: meta.module.run,
  };
}
