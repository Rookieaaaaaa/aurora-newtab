/**
 * e2e_yuanbao_live.mjs — 元宝云 API 真实链路验证（手动执行，不纳入 run_all）
 *
 * ⚠️ 会消耗真实调用额度（每次 1 次 SearchPro），且需要外网。
 * 依赖 src/defaults.js 里配置的凭证（TC3 签名）。
 *
 * 用法：node tests/e2e_yuanbao_live.mjs [查询词]
 * 退出码：0 全部断言通过；1 有失败。
 */

import { DEFAULT_SETTINGS, DEFAULT_SECRETS } from '../src/defaults.js';
import * as yuanbao from '../src/providers/yuanbao-mcp.js';

const query = process.argv[2] || '腾讯云云开发是什么';
const started = Date.now();
let sources = null;
let meta = null;
let text = '';

await yuanbao.run({
  query,
  settings: DEFAULT_SETTINGS,
  secrets: DEFAULT_SECRETS,
  onStatus: (s) => console.log('[status]', JSON.stringify(s)),
  onSources: (list, m) => {
    sources = list;
    meta = m;
  },
  onDelta: (delta) => {
    text += delta;
  },
});

console.log('\n=== 结果 ===');
console.log('查询:', query);
console.log('用时:', Date.now() - started, 'ms');
console.log('meta:', JSON.stringify(meta));
console.log('来源条数:', (sources || []).length);
console.log('总结前 120 字:', text.slice(0, 120).replace(/\n/g, ' '));

console.log('\n前 3 条来源:');
(sources || []).slice(0, 3).forEach((item, i) => {
  console.log(`  [${i + 1}] ${item.title.slice(0, 40)}`);
  console.log(`      site=${item.site} date=${item.date} score=${item.score}`);
  console.log(`      icon=${item.icon || '(空)'}`);
  console.log(`      snippet=${item.snippet.slice(0, 50)}...`);
});

const checks = [
  ['返回结果非空', (sources || []).length > 0],
  ['transport 为 TC3', meta && meta.transport === 'TC3'],
  ['每条都有 icon', (sources || []).every((s) => Boolean(s.icon))],
  ['score 落在 0~1', (sources || []).every((s) => typeof s.score === 'number' && s.score >= 0 && s.score <= 1)],
  ['date 归一为 YYYY-MM-DD', (sources || []).every((s) => !s.date || /^\d{4}-\d{2}-\d{2}$/.test(s.date))],
  ['有摘要文本', text.length > 10],
];

console.log('\n=== 断言 ===');
let failed = 0;
checks.forEach(([name, ok]) => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
});
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
