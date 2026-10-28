# Aurora New Tab · QA 验证报告（Round 2 · 修复验证）

> **更新（2026-10-23 晚 · AI 搜索打磨回归）**：本轮针对「DeepSeek 原生联网搜索 + 结果/交互打磨」重新做了独立验证，
> 新增 2 个套件（`test_ai_search.py` 102 项、`deepseek_web_test.py` 52 项），全量 **364 / 364 通过，失败 0**。
> 最新结论与逐项证据见文末 **「八、AI 搜索打磨回归（Round 2）」**；下面第一～七节是上一轮（v2 落地）的历史记录，数字已不再是最新基线。

- 被测版本：`manifest.json` v0.1.0（MV3，代码约 6238 行 / 16 个 ES Module）
- 验证时间：2026-10-23 · **Round 2（v2 落地后回归）**
- 验证人：QA（Edward / 严过关）
- 测试资产：`tests/` 下 8 个套件 + 一键回归 `run_all.py`，截图 30 张（`tests/screenshots/`）
- 说明：全程**未修改任何产品代码**（`src/`、`styles/`、`newtab.html`、`manifest.json`、`README.md` 均未改动），只维护 `tests/`。

---

## 一、结论

**结论：PASS。209 / 209 全部通过，失败 0，无阻断、无 Major、无 Minor。**

| 套件 | 通过 | 失败 | 覆盖内容 |
| --- | --- | --- | --- |
| 静态审计 `static_audit.py` | 29 | 0 | manifest 合法性 / 资源引用 / CSP / 90 个具名 import / 语法 / 密钥不入导出 |
| 单元测试 `unit_browser.py` | 54 | 0 | utils / defaults / search / Markdown / storage / dock 图标 / providers 凭证三态 |
| 渲染冒烟 `smoke_playwright.py` | 61 | 0 | 1440×900 全链路 / 480px / 空数据 / 非法导入 / XSS / 凭证三态 |
| 定向探针 `focused_probe.py` | 27 | 0 | IME / Esc 层级 / 拖拽落库 / favicon 降级 / 秒针 / **真实扩展上下文** |
| Provider 联调 `mock_provider_test.py` | 20 | 0 | SSE 分片解析 / 401 映射 / AbortSignal / MCP 三步握手 / sources |
| 布局探针 `layout_probe.py` | 4 | 0 | 4 个视口的引擎下拉定位与末项可达性 |
| v2 专项 `v2_regression.py` | 13 | 0 | team-lead 指定的 V1–V5 |
| 键盘探针 `keyboard_probe.py` | 1 | 0 | chip 的 Enter 确认选中 |
| **合计** | **209** | **0** | —— |

**智能路由判定：`NoOne`（全绿，无需工程师再改）**

一键复跑：`<playwright-python> tests/run_all.py`（8 套件全量，输出合计失败数）。

---

## 二、Round 1 问题的修复验证

### 已修复（逐一实测确认）

| 编号 | 问题 | 修复位置 | 验证证据 |
| --- | --- | --- | --- |
| **B1**（原 Major） | 引擎下拉溢出视口，1366×768 下末 3 项不可用 | `src/search.js:212-226` `positionMenu()` 按可用空间写 `max-height` 并在空间不足时 `is-above` 向上翻转；`styles/layout.css:354-366` 兜底 `overflow-y:auto` + `overscroll-behavior:contain` | `layout_probe` 4/4 通过：1440×900 菜单 505→799（视口内、不翻转）、1366×768 菜单 7→365（**翻转成功**）、1440×760 翻转、480×900 内；四者「滚动到底后末项完整可见 + `elementFromPoint` 命中项本身」全为 true |
| **B2**（原 Minor） | chip 上 Enter/Space 不确认选中 | `src/search.js` 键盘分支拆开 | `keyboard_probe`：Enter 前高亮 `DeepSeek` → Enter 后**菜单关闭、chip 文案变为 `DeepSeek`** |
| **B3**（原 Minor） | 演示徽标被「流式」覆盖 | `src/ai-panel.js:498-502` 引入 `demoActive` 判断 | `focused_probe A`：徽标序列全程只有 `演示`（不再出现 `流式`） |
| **B4**（原 Minor） | `maxSources=0` 被 `||` 短路成 6 | `src/storage.js:137-141` 改用 `Number.isFinite` + `Math.trunc` 夹取 | `unit_browser`：`{maxSources:0}` → `1`（越界夹取正确） |
| **B5**（原 Trivial） | 预览模式默认必应壁纸被 CORS 拦截、每次弹红色 toast | `src/storage.js:149-155`：无 `chrome.storage` 且首次加载时默认改 `gradient` | 预览页首屏无降级 toast，默认背景为动态渐变（`unit_browser` 断言 `background.type === 'gradient'` 且 `chrome.storage` 不存在）；**扩展上下文仍默认必应**（`focused_probe G`：`<IMG>` 3840px、接口 200、无 toast） |
| **B7**（原 Trivial） | MCP SSE 末帧缺空行时丢弃结果 | `src/providers/yuanbao-mcp.js:213` 补 `parseSseEvent(buffer)` 兜底 | 代码复核 + `mock_provider` T4 仍通过（MCP 结果解析 3 条 sources） |
| **B9**（原 Trivial） | favicon 无超时兜底，弱网下字母块迟迟不出现 | `src/dock.js:29-90` 图标改为 `<span class="dock-icon">` **始终先放字母块**，图片加载成功才 `has-img`；并加 3.5s `giveUp` 定时器 | `v2_regression V2`：离线（`route.abort` 掉 favicons/favicon.ico）后 **1s 内 12/12 站点显示字母块**（`G G 哔 知 微 淘 京 豆 网 Y 小 C`） |

### 未修复（均为 Trivial，无功能影响，可选）

| 编号 | 现状 | 影响 |
| --- | --- | --- |
| B6 | `src/storage.js:130` 注释仍写「补齐默认值 + 版本迁移」，但无版本迁移分支（只写 `version` 字段） | 纯注释误导，当前 `SETTINGS_VERSION=1` 无实际后果；建议改注释或后续补迁移骨架 |
| B8 | `src/dialog.js:177` 打开时 `modalRoot.hidden = false`，`close()` 未复位 | 无功能影响：`.modal-root` 靠 `pointer-events:none`（`base.css:542/548`）不拦截点击；仅与 `settings-backdrop` 的复位写法不一致 |

---

## 三、team-lead 指定的 v2 专项断言（V1–V5）

| 编号 | 断言 | 结果 | 实测数据 |
| --- | --- | --- | --- |
| V1 | 1440×900 / 1366×768 引擎菜单末项可命中 | **PASS** | 1440×900：菜单 `505→799`（`insideViewport=true`），滚到底末项 `754→790`，`elementFromPoint` 命中 `.mi-name`；1366×768：`is-above` 翻转，菜单 `7→365`（与搜索框 374 不重叠），末项 `320→356` 命中 |
| V2 | 离线 1s 内 12 站点显示字母块 | **PASS** | `items=12, letters=12`，耗时 ≤1000ms |
| V3 | AI 面板打开时时钟/搜索框完全可见且可点击 | **PASS** | 面板打开后：时钟 `92→248`、搜索框 `278→334`、面板 `499→792`（底部锚定，互不重叠）；两者 `fullyVisible=true` 且中心点命中自身；额外 `click` + `keyboard.type` 实测可输入「还能输入」 |
| V4 | 仅 2 站点时 Dock 宽度 < 300px | **PASS** | `#dock=178px`、`#dock-wrap=178px` |
| V5 | 480×900 无横向溢出 | **PASS** | `scrollWidth-clientWidth=0`，搜索框右边界 466 < 480，时钟字号 42px，Dock 横向可滚动 |

截图：`v2-engine-menu-1440x900.png`、`v2-engine-menu-1366x768.png`、`v2-favicon-offline.png`、`v2-ai-panel-overlap.png`、`v2-dock-2-sites.png`、`v2-480px.png`。

---

## 四、本轮「QA 自身断言修正」（非源码问题，按 QA 自查处理）

Round 2 过程中有 4 处失败经判定为**测试断言不成立**，已修正测试、未要求改源码：

1. **可滚动菜单的末项可达性**：初版 V1 直接取末项 `getBoundingClientRect` 与视口比较，未考虑 `.engine-menu` 是 `overflow-y:auto` 滚动容器（未滚动时末项被自身裁剪属正常）。改为「菜单整体在视口内 + 滚动到底后末项完整可见且命中」后通过。
2. **12 小时制徽标**：v2 设计为「问候语已表达上午/下午时不再重复加后缀，仅在关闭问候语时才显示 `.clock-meridiem`」（`src/clock.js:83-95`）。断言改为分别验证两条分支。
3. **`getProvider` 语义**：一度存在「missing 永远演示」与「`demoMode` 开关必须真实生效」两种口径。team-lead 裁定为后者（`providers/index.js` 已于 14:56 落地），测试已固化该语义并保留 `DEMO_WHEN_MISSING` 开关常量，便于将来切换。
4. **图标 DOM 结构**：v2 改为 `.dock-icon` 外壳 + 内部 `.dock-letter` / `.dock-icon-img`（加载成功才 `has-img`），原断言耦合旧结构，改为结构无关的行为断言（含字符块 / 图片地址正确 / `referrerpolicy=no-referrer`）。

---

## 五、本轮已实测通过的关键链路（摘要）

- **可加载性**：manifest MV3 合法、`newtab` 文件存在、permissions 合法、无非法字段；HTML 4 个本地引用齐全；22 个 `getElementById` id 全存在；90 个具名 import 全部匹配；16 文件 ESM 语法通过；`manifest.version` 与 `APP_VERSION` 一致。
- **真实扩展上下文**（`--load-extension`，ID `mcooekgchicmffjjkmopgibmkgapmjao`）：`chrome-extension://<id>/newtab.html` 正常渲染、`chrome.storage.local` 读写通、`getBackend()==='chrome'`、`chrome.runtime.id` 匹配、无未捕获异常、**MV3 CSP 拦截内联 `<script>`**、内联 `style` 未被误拦、演示问答在扩展页内流式正常、必应壁纸 200 且渲染 3840px。
- **CSP / XSS**：全仓无 `eval` / `new Function` / `document.write` / `javascript:` / 内联事件属性；23 处 `innerHTML` 逐个人工复核；7 组恶意 payload 实测 `renderMarkdown`：注入元素 0、`on*` 属性 0、`javascript:` href 0。
- **存储 / 密钥**：预览降级 `localStorage`（键前缀 `aurora:`）；扩展走 `chrome.storage.local`；导出不含 `apiKey`；导入无法覆盖 secrets；`resetAll` 保留密钥；`configState` 三态（missing/partial/ready）与纯空白判定正确。
- **AI 适配层（本地 mock，无外网）**：SSE 心跳帧、被切成两半的 `data:` 行、`[DONE]` 拼接无损；`stream:true` + `Authorization: Bearer` 正确；401 → 「密钥无效或已过期（401）… · Invalid API key provided」；停止生成立即止损 + toast；**MCP `initialize → notifications/initialized → tools/call`**、`mcp-session-id` 透传、SSE 形态结果解析出 3 条 sources；无总结模型密钥时降级为结果列表；凭证三态行为符合裁定语义（missing+演示开 → 演示且零请求；partial → NeedsConfig 且零请求）。
- **交互**：`/` 与 Ctrl/Cmd+K 聚焦、URL 意图提示、`!b 天气` 新标签打开必应（中文已编码）、IME 组合期回车不提交、Esc 层级（对话框 → 设置 → Dock 菜单 → 引擎下拉 → AI 面板）、拖拽排序后 `localStorage` 顺序与内存/DOM 一致、秒针每秒刷新、空 sites 只剩新增按钮、超长标题不横向溢出、480px 无横向溢出。

---

## 六、未验证项与原因（与 Round 1 一致）

| 项 | 原因 |
| --- | --- |
| 真实元宝 MCP / DeepSeek / 自定义网关联调 | 无可用密钥与外网；已用本地 mock 覆盖协议层（握手、SSE、错误映射、sources 提取） |
| MCP 30s 超时路径（`RPC_TIMEOUT`） | 需真实挂起 30s，性价比低；仅代码走查 |
| `chrome.runtime.lastError` 分支 | 无法在正常环境触发 chrome.storage 失败 |
| IndexedDB 本地图片/视频上传 | headless 下文件选择与 blob 渲染不稳定；仅静态复核事务与 objectURL 回收 |
| 真实鼠标拖拽手势 | 用合成 `DragEvent` 验证数据流与落库，未验证手感/动画 |
| Google favicon 真实可达性 | 无外网；用 `route.abort()` 验证降级分支与 1s 内字母块 |
| 12h + 秒针长时间走字稳定性 | 已测秒针每秒刷新与徽标分支；未做 10 分钟长跑 |

---

## 七、复跑方式

```bash
cd ai-newtab
python -m http.server 8765                     # 静态服务（当前已在后台运行）

# 一键全量（8 套件，输出合计失败数）
<playwright-python> tests/run_all.py

# 或单独跑
python tests/static_audit.py
<playwright-python> tests/unit_browser.py
<playwright-python> tests/smoke_playwright.py
<playwright-python> tests/focused_probe.py
<playwright-python> tests/mock_provider_test.py
<playwright-python> tests/layout_probe.py
<playwright-python> tests/v2_regression.py
<playwright-python> tests/keyboard_probe.py
```

> Playwright 解释器：`python`（pyenv 3.12.2）
> （本机 playwright 1.62 与已装 Chromium build 号不一致，脚本内已用 `executable_path` 指向 `chromium_headless_shell-1243`。）
> `tests/_invalid.json`、`tests/_valid.json` 为导入用例夹具，可安全删除后自动重建。

---

## 八、AI 搜索打磨回归（Round 2）

- 验证时间：2026-10-23 · 针对「DeepSeek 原生联网搜索（`deepseek-search`）+ 结果卡片/交互打磨」的独立回归
- 验证人：QA（Edward / 严过关）
- 前提：**未采信工程师的 IS_PASS 自报**，全部结论均来自可复跑的脚本输出
- 改动范围：**只新增 / 修正 `tests/` 下的测试资产，未改动 `src/`、`styles/`**

### 8.1 结论：PASS（364 / 364，失败 0，跳过 0）

| 套件 | 通过 | 失败 | 本轮变化 |
| --- | --- | --- | --- |
| 静态审计 `static_audit.py` | 29 | 0 | 未改 |
| **搜索逻辑 `test_ai_search.py`（新）** | 102 | 0 | **新增**（Node 探针 + 语法 + CSS + 接线核查） |
| 单元测试 `unit_browser.py` | 54 | 0 | 修正 1 处过期断言（引擎数量 3+7→4+7） |
| 渲染冒烟 `smoke_playwright.py` | 61 | 0 | 修正 3 处过期断言（R6 / R10 / R13） |
| 定向探针 `focused_probe.py` | 27 | 0 | 修正 1 处阈值（G，演示文案长度） |
| Provider 联调 `mock_provider_test.py` | 21 | 0 | 修正 4 处失效断言（T3 徽标、T4 选择器、T4 文案） |
| **联网搜索 DOM `deepseek_web_test.py`（新）** | 52 | 0 | **新增**（真实 Chromium + 本地 mock，10 组场景） |
| 布局探针 `layout_probe.py` | 4 | 0 | 未改 |
| v2 专项 `v2_regression.py` | 13 | 0 | 未改 |
| 键盘探针 `keyboard_probe.py` | 1 | 0 | 未改 |
| **合计** | **364** | **0** | 上一轮基线 209 |

一键复跑：`<playwright-python> tests/run_all.py`（10 套件，输出合计失败数）。

### 8.2 新增套件覆盖了什么

**`tests/test_ai_search.py` + `tests/logic_probe.mjs`（102 项，无浏览器 / 无外网）**
用 Node 直接 `import` 真实源码 + `fetch` 桩，覆盖：

- `cache.js`：key 归一化（首尾空白、连续空格折叠）、`provider::query::count` 结构、命中/未命中、
  **TTL 10 分钟**（用 `Date.now` 桩验证过期与顺手清理）、**上限 50 条 FIFO**（第 51 条淘汰 k0）、
  重复写入同一 key 会刷新淘汰顺序、空 key / 空 value 不写入。
- `deepseek-search.js` 归一化：`rerank_score 2.4 → score 0.8`（浮点容差断言）、夹取 0~1、
  `authority:-1 → null`、`authority:0` 合法、`site_name:null → host`、`site_icon` 非 http(s) 丢弃、
  `snippet` 空用 `summary`、`title` 空回退 host、非 http(s) URL 过滤、同 URL 去重（忽略 hash / 尾斜杠 / 大小写）、limit 截断。
- `resolveApiBase()`：裸域名→补 `/v1`、带 `/v1`（含尾斜杠）原样、误填 `/v1/chat/completions` 与
  `/chat/completions` 均剥到 `/v1`、空值回落官方默认、自定义代理带路径原样。
- 请求层：`POST {base}/v1/tools/search` 的 `body{query,count,ori_question}`、`need_content` 仅在显式 true 时携带、
  `Authorization: Bearer` 头、query 归一化。
- 错误映射：**402 余额不足 / 429 限速 / 401 Key 无效 / fetch 403·404「目标网页无法抓取」/ search 404 提示检查 Base URL /
  网络异常转中文 / 未配 Key → NeedsConfigError 且零请求**；
  **外部 `AbortSignal` 中止时原样抛 `AbortError`**（不被映射成中文文案）。
- 深度模式：前 3 条**并发**抓取（3×100ms 实测 <280ms，串行应 ≥300ms）、单条 403 / 网络失败**静默降级**、
  正文截断 4000、`limit` 生效、外部取消向上抛 `AbortError`。
- `run()` 主流程：检索→`onSources`→带引用总结；**空结果不请求 LLM**（请求数=1）；
  总结 500 且未吐字→**降级「结果列表 + 本地概述」**；deep 抓取全失败→结果与总结不受影响；
  **缓存命中不重复检索但总结重新生成**（search 次数不变、chat +1、`meta.cached=true`）；
  时效筛选改变检索词（`after:`）与缓存 key；`webSearch=false` 明确报错且零请求；老数据缺
  `webSearch/searchDepth` 按「开启 + 标准」处理。
- `providers/index.js`：`kindOf()` 四态 + 未知回落 chat、`PROVIDER_META` 全部声明 `kind`、
  `configState('deepseek-search')` 复用 `deepseek.apiKey`（missing/ready）、未知 provider 回落 yuanbao、
  demo provider 输出 20 条结构完整结果且**零网络请求**。
- `defaults.js`：`AI_ENGINES 4 / WEB 7 / 合计 11`、第 3 个 AI 引擎为 `ai-deepseek-web→deepseek-search`、
  引擎 id 唯一、`BANGS['!ds']→ai-deepseek-web` + `BANG_HINTS` 同步 + 所有 bang 指向存在的引擎、
  `DEFAULT_SECRETS.deepseek.webSearch/searchDepth`、`DEFAULT_SETTINGS.ai.searchFreshness`。
- `storage.js`：`searchFreshness` 只接受 `any|d7|m1|y1`（脏数据回落 any）、`maxSources 0→1 / 999→50`、
  `temperature` 夹取、**老 secrets 缺 `webSearch/searchDepth` 时深合并补默认**、坏 JSON 不抛错。
- `ai-panel.js` 纯逻辑（非导出函数通过「剥离 import 后附加 export」加载，不引入 jsdom）：
  `dedupeSources` 同 URL 保留高分 / 同域名 + 标题前 12 字（忽略空白）判重 / 不同标题不去重 /
  无 url 过滤 / score 缺失按 -1 不崩；`isFreshDate` **6 天=新、7 天=新、8 天=非新**、非法值 false；
  `shortProviderName` 映射；源码约束（`RENDER_INTERVAL=80`、`visibilitychange`、`setBadge('已停止','stop')`、
  **去重发生在编号之前**）。
- 另有 16 处「接线核查」，防止「函数写了却没被调用」（dedupe 调用点、favicon 三级降级、settings 三个新控件、
  `configState` 复用分支等）；8 处 CSS 断言（`.res-badge` 各 tone、`.ai-empty`、`.badge[data-tone="stop"]`、`.res-meta` flex-wrap）。

**`tests/deepseek_web_test.py`（52 项，真实 Chromium + 本地 mock 服务 `127.0.0.1:8800`）**

| 场景 | 断言要点 |
| --- | --- |
| D1 正常检索 | 3 条结果、编号 1/2/3、标题与站点来自接口、`2.4/3 → 相关度 80%`、snippet 空回落 summary、头部「DeepSeek」来源徽章、`3 / 20 条`+用时、页签计数 3、总结含 `[1][2]` 可点引用、请求体 `query`/`count` 正确、1 检索 + 1 总结 |
| D2 徽章 | authority=4 且 1 天内 → `auth+new`；authority=2 且 30 天前 → 均不显示；authority=-1 → 不显示权威；无 `rerank_score` → 不显示相关度（`["相关度 100%","相关度 50%",""]`） |
| D3 favicon | `site_icon` 非法 → 走 `favicon.im` → 失败降级 Google s2（实测 src 变化）→ 两个源都失败 → **img 被移除（无破图）**；用不同域名规避图片缓存假象 |
| D4 去重 | 4 条（2 同 URL 不同分、2 同域名近似标题）→ 渲染 2 条，编号重排 1/2，保留高分（90% / 70%），引用编号不出现 3/4 |
| D5 空结果 | `.ai-empty` 可见、停在结果页签、`0 条结果`、**chat 请求数不变**、概述文案可读 |
| D6 缓存 | 「缓存」徽章出现、search 次数不变、chat +1、结果条数不变 |
| D7 引用跳转 | 在「AI 总结」页签点 `[2]` → 自动切回结果页签 + 目标项 `is-flash` 高亮 |
| D7b 停止 | 徽标「已停止」+ `data-tone=stop`、结果列表仍可看、停止后正文长度不再增长（4→4） |
| D8 纯对话 provider | 无结果页签、无空结果态、停在总结页、正常出总结（`isSearch` 改造未误伤 chat 类） |
| D9 设置页 | provider 卡片由注册表派生 4 张、`deepseek-search` 复用 deepseek 密钥面板、**联网开关取消勾选持久化为布尔 `false`**、重开抽屉后 checkbox 仍为 false（`syncValues` 布尔回填）、重新勾选 → `true`、深度模式下拉持久化 `deep`、时效下拉持久化 `d7` 且真实拼进检索词（`… after:2026-10-16`） |

### 8.3 本轮修正的过期断言（均为「产品有意变更」或「早已失效」，非源码缺陷）

| # | 文件:行 | 原断言 | 现断言 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `unit_browser.py:133` | `ENGINES = [3,7,10]` | `[4,7,11]` | 新增第 4 个 AI 引擎 `ai-deepseek-web` |
| 2 | `smoke_playwright.py:163` | 引擎项 10 个 | 11 个（4 AI + 7 网页） | 同上 |
| 3 | `smoke_playwright.py:222` | bang 菜单 5 项 | 6 项 | 新增 `!ds` |
| 4 | `smoke_playwright.py:348` | 演示正文必须出现 `li`/`pre` | 拆成「演示正文渲染 strong+h3」+「渲染器直接渲染标题/有序无序列表/代码块」 | 渲染器能力不该绑死演示文案措辞 |
| 5 | `focused_probe.py:403` | 演示流式 `chars > 200` | `chars > 100`（当前文案 136 字符） | 阈值只为证明「流式在跑」 |
| 6 | `mock_provider_test.py:325` | 停止后徽标「已完成」 | 「已停止」且 `data-tone=stop` | 本轮产品口径：保留「已停止」 |
| 7 | `mock_provider_test.py:361-378` | `.ai-source-list/.src-title/.src-host/[data-role=sources]` | `.res-list .res-item/.res-title/.res-site/.res-link/.ai-pane-results` | 旧选择器在改动前就已失效（文档结构早已改为结果卡片） |
| 8 | `mock_provider_test.py:376` | 降级文案「已检索到以下结果」 | 含「检索到」+「3 条」 | 元宝降级文案已改为「已通过 web_search 检索到 3 条结果…」 |

### 8.4 需产品/工程师确认的 1 处观察（不阻断）

- **演示模式文案疑似被精简**：当前 `DEMO_TEXT` 为 136 字符，只含一个 h3 + 一处粗体 + 一段引用，
  **不含列表与代码块**；而 `README.md:148` 称演示模式用于「验证 UI 与渲染逻辑」。
  历史报告记录的演示正文长度 >200 字符，与现状不符。因项目无 VCS，QA **无法确认这是否为有意精简**，
  故未把它判为源码缺陷：已把断言改为「渲染器能力单独验证」，不再依赖文案措辞。
  若希望演示页继续展示列表 / 代码块排版，建议由工程师补回一段示例（改动仅限 `providers/index.js` 的 `DEMO_TEXT`）。

### 8.5 环境限制 / 未验证项

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实 `api.deepseek.com/v1/tools/search|fetch` | **未验证** | 无外网、无真实密钥；全部用本地 mock 响应（结构与文档一致） |
| 真实元宝 MCP / SearchPro | **未验证** | 同上（沿用上一轮 mock 结论） |
| 真实 `deep` 模式抓取质量 | **未验证** | 仅验证并发度、截断、失败降级、正文进入 context 的代码路径 |
| CORS / 真实限速（100 QPS / 25 QPS） | **未验证** | mock 服务放开了 CORS，无真实限流环境 |
| 扩展侧载上下文（`--load-extension`） | 沿用上一轮 | 本轮未重跑侧载；`focused_probe G` 仍覆盖扩展内演示流式 |
| 设置抽屉 checkbox 真实鼠标点击 | 部分 | 元素位于抽屉滚动可视区外，`uncheck(force=True)` 报「outside viewport」，改为 `checked=false` + `dispatchEvent('change')` 走同一事件处理器；CSS 已确认 `.switch input` 覆盖整块 `inset:0`（真实用户可点） |

### 8.6 智能路由判定

**路由：`NoOne`** —— 未发现源码功能缺陷（无 Major / 无 Minor / 无已知失败用例）。
唯一待确认项是 8.4 的演示文案观察，属「可选优化」，不阻断发布。

本轮新增 / 修改的测试资产：
`tests/logic_probe.mjs`（新）、`tests/test_ai_search.py`（新）、`tests/deepseek_web_test.py`（新）；
修正 `tests/unit_browser.py`、`tests/smoke_playwright.py`、`tests/focused_probe.py`、`tests/mock_provider_test.py`、`tests/run_all.py`（套件清单 8→10）。
截图：`tests/screenshots/20~28-ds-*.png`。

