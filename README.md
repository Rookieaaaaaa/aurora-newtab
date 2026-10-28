# Aurora New Tab · AI 起始页

一个**零构建、零依赖、零外链**的 Chrome Manifest V3 新标签页扩展：自定义背景 + 大时钟 + 玻璃态搜索框 + AI 搜索（元宝云 API / DeepSeek 联网 / DeepSeek / 自定义 OpenAI 兼容）+ 常用站点 Dock。

全部代码使用原生 HTML / CSS / ES Module，没有 npm、没有打包、没有 CDN 资源，下载后「加载已解压的扩展程序」即可使用。

---

## 一、功能清单

**背景**
- 五种背景：必应每日壁纸 / wallhaven 壁纸库 / 网络或本地图片 / 视频 / 动态渐变（4 套主题 + 可选漂浮粒子）
- wallhaven 壁纸库（免密钥）：每日精选、随机热门、关键词搜索三种模式，结果按天缓存在本机；设置里可打开画廊网格浏览、搜索、预览并一键应用
- 双层交叉淡入切换（400ms），不会白闪
- 背景模糊 0–20px、暗化 0–80% 实时生效，另有暗角保证白色文字可读
- 任一背景加载失败自动降级为动态渐变并 toast 提示（wallhaven 未开代理时同样自动回退）

**时钟**
- 96px / 字重 300 / 字距 -2px 的白色细体大时钟
- 24 或 12 小时制、可选秒、可选日期、可选问候语（凌晨好 / 早上好 / 上午好 / 中午好 / 下午好 / 晚上好）
- 对齐系统分钟边界刷新，不做 1s 轮询；页面恢复可见时立即刷新

**搜索**
- 4 个 AI 引擎 + 7 个传统引擎，胶囊 chip 下拉可键盘操作（↑↓ / Enter / Esc）
- 占位文案随引擎变化；网址意图直接回车打开（`github.com`、`https://x.com/a`、`127.0.0.1:8080`）
- bang 指令：`!b` 必应、`!g` 谷歌、`!d` DeepSeek、`!ds` DeepSeek 联网、`!y` 元宝、`!gh` GitHub
- 中文输入法保护（`isComposing` 期间回车不提交）

**AI 结果面板**
- 两个页签：**搜索结果**（默认）与 **AI 总结**；搜索类请求会先给出结果列表
- 结果卡片：序号、标题、摘要（2 行截断）、站点、发布日期、相关度；默认展示 5–6 条，可「展开全部 20 条」
- 排序：按相关度 / 按时间；编号与 AI 总结里的 `[1][2]` 引用一一对应，点击引用会滚动并高亮对应结果
- AI 总结：流式输出 + Markdown 渲染（先转义再解析，安全），正文宽度限制在 720px 内便于阅读
- 复制（总结 + 结果链接）、重新生成、停止、关闭；未配置密钥时自动进入本地演示模式（不联网，带 20 条示例结果）

**Dock**
- 12 个默认站点，favicon 三级降级（自定义地址 → Google favicon → 站点 favicon.ico → 首字母色块）
- 悬停放大上浮、右上角「⋯」菜单（编辑 / 复制链接 / 删除）、右键菜单
- 拖拽排序、新增 / 编辑 / 删除，全部持久化

**设置抽屉**
- 分组折叠：外观 / 时钟 / 搜索 / AI 搜索 / 常用网站 / 通用
- 密钥全部留空，带 placeholder 示例；password 输入可显示/隐藏
- 三个 provider 各自独立的「测试连接」（显示延迟或可读错误原因）
- 导出配置（不含密钥）/ 导入配置 / 恢复默认

**快捷键**
- `/` 或 `Ctrl/Cmd + K` 聚焦搜索框并全选
- `Esc` 依次关闭最上层浮层（对话框 → 设置 → Dock 菜单 → 引擎下拉 → AI 面板）

---

## 二、安装步骤

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本仓库目录 `ai-newtab`（包含 `manifest.json` 的那一层）
5. 新建标签页即可看到 Aurora 起始页

> 若新标签页没有变化，检查是否有其它扩展也覆盖了新标签页（同一时间只有一个生效）。

---

## 三、六种背景怎么用

| 类型 | 说明 | 需要填写 |
| --- | --- | --- |
| **必应每日** | 调用必应壁纸接口 `HPImageArchive.aspx` 取当日 `urlbase + _UHD.jpg`，按日期缓存到本机，当天只请求一次 | 只需选择壁纸地区 |
| **wallhaven 壁纸库** | 调用 wallhaven 公开接口（免密钥，锁定 SFW + 横屏 ≥1080p）。三种模式：每日精选（月度热门按「年内第几天」轮换）/ 随机热门（每个新标签随机）/ 关键词搜索（按天轮换）。列表当天缓存 | 选模式 / 分类；关键词模式填英文关键词 |
| **WE 工坊** | Steam 创意工坊（Wallpaper Engine）壁纸：起始页顶栏图片按钮打开全屏「壁纸工坊」，大搜索框 + 标签/排序筛选 + 大卡片网格翻页浏览；详情直接播放壁纸的**动态视频**，可设为起始页背景（视频优先）、加入收藏池每日轮换，也可**一键订阅并应用到桌面**（用浏览器 Steam 登录态订阅，Steam 客户端自动下载，延时后发送 `steam:// -control openWallpaper` 应用命令） | 应用到桌面需浏览器登录 steamcommunity.com；Steam 装在其它盘时改 Workshop 目录 |
| **图片** | 支持粘贴网络图片地址，或上传本地图片（存 IndexedDB，按 mediaId 引用） | 图片地址 或 上传 |
| **视频** | `<video autoplay muted loop playsinline>`，object-fit: cover；页面隐藏时暂停 | mp4 / webm 地址，或上传 |
| **动态渐变** | canvas 绘制 4–5 个缓慢流动的径向光斑，可选 60 个以内细粒子；30fps 上限，`prefers-reduced-motion` 时静止 | 选主题 + 粒子开关 |

**壁纸库画廊**：设置 → 外观 → 背景类型选「壁纸库」→「浏览壁纸库，手动挑一张」，支持关键词搜索、热门/最新/随机排序、分类筛选与翻页；点缩略图看大图预览，「设为背景」会以图片地址方式应用（复用图片类型，来源会标注）。

**壁纸库专用代理**：设置 → 壁纸库 →「专用代理」填本地代理端口（如 Clash 的 `127.0.0.1:7890`）。扩展会用 PAC 脚本**只把 wallhaven 域名的流量**指到该端口，其它网站一律直连——不需要常开系统代理，只要代理程序在跑壁纸就能更新。留空则完全不接管浏览器代理。

**公共中转与自定义中转**（开关默认开启）：直连与专用代理都失败时，自动尝试中转站拉取，**零本地代理也可能更新壁纸**。公共中转（allorigins / codetabs）是免费服务、可用性无保证；追求稳定可自建 Cloudflare Worker（免费额度足够，国内可达），在「自定义中转」填模板 `https://xxx.workers.dev/?url={url}`，会优先尝试。介意第三方看到壁纸地址可整体关闭。

**内置精选包**：扩展自带 10 张年度热门壁纸（1920px JPEG，共约 2.6MB，来源见 `assets/wallpapers/CREDITS.md`）。彻底断网时按天轮换展示，永不退回渐变。

**断网兜底顺序**：在线（直连 / 专用代理）→ 中转（自定义 → 公共）→ 本地缓存的上一张壁纸（IndexedDB）→ 内置精选包。

**降级顺序**：壁纸库四级兜底如上，全部失败才会 toast 提示并回退动态渐变（森林晨雾）；其它背景类型失败时同样回退渐变。
**wallhaven 注意**：壁纸库接口不返回跨域头，直连依赖扩展 host 权限免 CORS；普通浏览器预览（`python -m http.server`）会自动改走公共中转，画廊可用。
**视频建议**：优先用 URL 而不是上传，本地上传的大视频会占用较多浏览器存储空间。

---

## 四、密钥填写位置（逐项说明）

全部在 **右上角齿轮 → 设置 → AI 搜索** 中填写。密钥只写入 `chrome.storage.local`，不会进入导出文件，也不会发往除你所填服务之外的任何地址。

### 1. DeepSeek（最容易配置，推荐先用它）

| 字段 | 填什么 | 说明 |
| --- | --- | --- |
| API Key | `sk-xxxxxxxx` | 到 <https://platform.deepseek.com/api_keys> 注册并创建 API Key |
| Base URL | `https://api.deepseek.com/v1` | 默认值已填好，不要漏掉 `/v1` |
| 模型 | `deepseek-chat` | 也可填 `deepseek-reasoner` |

测试连接：调用 `GET {Base URL}/models`，返回 200 即成功（同时显示延迟）。

### 2. 元宝搜索（联网检索，推荐）

腾讯云元宝搜索（Tencent Yuanbao Search，产品代号 `wsa`）有三种接入方式：

| 接入方式 | 端点 | 鉴权 | 特点 |
| --- | --- | --- | --- |
| **云 API 签名**（推荐） | `https://wsa.tencentcloudapi.com/` | TC3-HMAC-SHA256（SecretId + SecretKey） | 官方标准接口，`Action=SearchPro`，返回字段最全 |
| HTTP 网关直连 | `https://api.wsa.cloud.tencent.com/SearchPro` | `Authorization: Bearer sk-...` | 一次 POST 拿结果，无需签名 |
| MCP | `https://api.wsa.cloud.tencent.com/Mcp` | `Authorization: Bearer sk-...` | JSON-RPC over Streamable HTTP，工具名 `SearchPro` |

> 选择「腾讯云云 API 签名」后，接入方式会被强制为 HTTP 直连（MCP 网关只支持 Bearer）。

字段含义：

| 字段 | 含义 | 示例 |
| --- | --- | --- |
| 鉴权方式 | 云 API 签名 / 网关 API Key | `腾讯云云 API 签名` |
| SecretId / SecretKey | 控制台「访问管理 → API 密钥管理」获取，仅存本机 | `AKID...` / `******` |
| 接口版本 Version | 云 API 版本号，固定 `2025-05-08` | `2025-05-08` |
| 服务地址 | Bearer 方式才需要 | `https://api.wsa.cloud.tencent.com/SearchPro` |
| API Key | 控制台「服务 API KEY」创建 | `sk-xxxx` |
| 搜索工具名 | MCP 方式固定 `SearchPro` | `SearchPro` |
| 结果类型 Mode | `0` 公开网页 / `1` 权威垂信源 / `2` 混合 | `2` |
| 每次检索条数 Cnt | 官方仅支持 10 / 20 / 30 / 40 / 50，代码会自动就近取档 | `20` |
| 时效范围 Freshness | `d7` 近 7 天、`m3` 近 3 月、`y1` 近 1 年，或 `2026-08-20,2026-08-30` | `d7` |
| 垂直领域 Industry | `gov` / `news` / `acad` / `finance`，可空 | `news` |
| 用于总结的模型 | 拿到检索结果后用哪个模型写摘要 | `DeepSeek` 或 `自定义模型` |
| 额外参数 JSON | 合并进检索入参，例如限定站点 | `{"Site":"docs.python.org"}` |

**返回结构（官方）**：`Response.Pages` 是**字符串数组**，每个元素要先 `JSON.parse` 一次。字段随账号版本变化：

| 字段 | 含义 | 版本 |
| --- | --- | --- |
| `title` / `url` / `date` / `site` | 标题、链接、发布时间、站点名 | 全部 |
| `passage` | 标准摘要（用于列表展示） | 全部 |
| `content` | 动态摘要，比 passage 长（用于总结） | 标准版及以上 |
| `score` | 相关度 0–1 | 全部 |
| `favicon` | 站点图标，腾讯自家 CDN（`cdn-yb.icon.qq.com`） | 全部 |
| `pics` | 配图列表（0–10 条） | 标准版及以上 |
| `authority_level` | 权威度 0–5 | **仅旗舰版** |
| `deeplinks` | 附件子链 | 仅旗舰版（需传 `Deeplinks: true`） |

`Response.Version` 会返回账号版本：`lite`（极速）/ `standard`（标准）/ `flagship`（旗舰）。标准版**不返回** `authority_level`，
因此结果卡片上的「权威」徽章在元宝源通常不出现（DeepSeek 源会返回 `authority`，那里才会亮）。

本扩展在 `yuanbao-mcp.js` 里做了完整兼容解析（`pagesFromPayload` + `normalizePage`），统一成
`{title, url, snippet, domain, site, date, score, authority, icon, content, pics}` 供结果列表渲染与总结使用。

**签名实现（TC3）**：`src/providers/tc3.js` 用 WebCrypto（`crypto.subtle`）实现 TC3-HMAC-SHA256，
无第三方依赖。要点：

- `CanonicalRequest` 只签 `content-type` 与 `host` 两个头（字典序，小写）
- `credentialScope = {UTC 日期}/wsa/tc3_request`
- 密钥派生链：`HMAC("TC3"+SecretKey, date)` → `HMAC(…, "wsa")` → `HMAC(…, "tc3_request")`
- `Action` / `Version` / `Timestamp` 走请求头（`X-TC-Action` / `X-TC-Version` / `X-TC-Timestamp`），
  **请求体只放业务参数**（`Query` / `Mode` / `Cnt` / `Freshness` / `Industry` / `Site`）

**调用流程（MCP 方式）**：

1. `POST endpoint` → `initialize`，`protocolVersion: "2025-06-18"`，从响应头读取 `mcp-session-id`
2. `POST` → `notifications/initialized`（无 id，带 session 头）
3. `POST` → `tools/call`，`params: { name: "SearchPro", arguments: { Query, Mode, Cnt, Freshness?, Industry? } }`
4. 解析 `result.content` 中的文本 → 取 `Response.Pages` → 逐条 JSON.parse → 结果列表
5. 有总结模型密钥 → 把结果作为上下文流式生成带 `[1][2]` 引用的中文总结；没有 → 只展示结果列表

**错误码（云 API 签名）**：`ResourceNotFound` = 账号未开通元宝搜索；`UnauthorizedOperation` = 无调用权限；
`AuthFailure` = 签名校验失败（检查 SecretId/SecretKey 与本机时间）；`RequestLimitExceeded` = 超频。
扩展会把这些 Code 翻成可操作的中文提示，而不是直接抛原始 Message。

**限制（重要）**

- 浏览器直连要求服务端允许 **CORS**（`Access-Control-Allow-Origin`，MCP 还需暴露 `mcp-session-id` 响应头）。
  云 API 签名方式在扩展页（有 `<all_urls>` host 权限）内可用；用 `python -m http.server` 预览时会被 CORS 拦住。
- 元宝官方接口按调用次数计费，`Cnt` 越大单次消耗不变但能拿到更多结果；测试连接在 HTTP 方式下会真实调用一次（消耗 1 次额度）。
- 请求超时 30 秒；`Mode=1` 对 query 很敏感，口语化长句容易返回 0 条，建议用 `2`（混合）。
- 本机时间偏差超过 5 分钟会导致 TC3 签名过期（`AuthFailure_SignatureExpire`）。

### 3. 自定义 OpenAI 兼容

| 字段 | 示例 |
| --- | --- |
| Base URL | `https://api.example.com/v1` |
| 模型 | `gpt-4o-mini` |
| API Key | `sk-xxxx` |
| 鉴权 Header 名 / 前缀 | `Authorization` / `Bearer `（部分网关用 `x-api-key` + 空前缀） |

测试连接同样走 `GET {Base URL}/models`。

### 4. 没有密钥会怎样？

默认会进入**演示模式**：本地生成一段固定的 Markdown 说明并按 30–60 字/秒流式输出，**不发起任何网络请求**，用于验证 UI 与渲染逻辑；面板顶部会有一条浅黄提示条与「去填写」按钮。

| 情况 | 表现 |
| --- | --- |
| 凭证为空 + 演示模式**开**（默认） | 演示回答，徽标「演示」，不联网 |
| 凭证为空 + 演示模式**关** | 错误态「尚未配置…」+「去填写密钥」按钮 |
| 凭证填了但**不完整**（如只填 MCP 地址没填 Key） | 走真实请求，报具体缺失项 +「去填写密钥」 |
| 凭证齐全 | 真实请求；401/403/429/网络错误照常显示错误态 |

设置里的「演示模式」开关是真实生效的：关掉之后就不会再看到演示回答。

---

## 五、安全说明

- 密钥只保存在本机 `chrome.storage.local`（普通浏览器预览时降级到 `localStorage`），不写入任何远端。
- **导出配置会剔除 secrets**，只导出 settings 与 sites。
- 所有 DOM 注入点都做了转义：AI 回答先 `escapeHtml` 再解析 Markdown；站点名称、来源标题一律用 `textContent` 写入。
- 无 `eval` / `new Function`，无内联 `<script>`，无内联事件属性，无 `javascript:` 链接；所有交互通过 `addEventListener` 绑定，符合 MV3 默认 CSP。
- 没有 background service worker、没有 content script，扩展不会读取你访问的任何网页内容。
- 外链统一 `target="_blank"` + `rel="noopener noreferrer"`；图标图片使用 `referrerpolicy="no-referrer"`。

---

## 六、目录结构

```
ai-newtab/
├── manifest.json            # MV3，chrome_url_overrides.newtab = newtab.html
├── newtab.html              # 页面骨架（唯一 HTML）
├── README.md
├── styles/
│   ├── base.css             # reset、设计变量、通用控件（按钮/开关/滑块/输入/对话框/toast）
│   ├── layout.css           # 背景层、时钟、搜索框、Dock、响应式
│   └── panels.css           # 设置抽屉、AI 结果面板、站点编辑表单
├── src/
│   ├── main.js              # 入口：初始化、快捷键、浮层层级、异常兜底
│   ├── defaults.js          # 默认配置 / 引擎 / 站点 / 渐变主题 / 常量
│   ├── storage.js           # chrome.storage.local + localStorage 降级 + IndexedDB + 导入导出
│   ├── background.js        # 背景引擎（bing/wallhaven/static/video/gradient）
│   ├── clock.js             # 时钟 / 日期 / 问候语
│   ├── search.js            # 搜索框 + 引擎下拉 + URL 意图 + bang
│   ├── ai-panel.js          # AI 面板 + Markdown 安全渲染
│   ├── dock.js              # Dock + 图标降级 + 拖拽 + 站点表单
│   ├── settings.js          # 设置抽屉（含 wallhaven 壁纸库画廊）
│   ├── wallhaven.js         # wallhaven 壁纸库源（列表拉取 / 模式选图 / 当日缓存 / 断网兜底）
│   ├── proxy.js             # 壁纸库专用代理（chrome.proxy + PAC，仅 wallhaven 域名）
│   ├── dialog.js            # 对话框 / 确认框 / toast
│   ├── icons.js             # 内联 SVG 图标集
│   ├── utils.js             # 工具函数与错误类型（uid/深合并/转义/防抖…）
│   └── providers/
│       ├── index.js         # 注册表 + 统一接口 + 演示模式
│       ├── deepseek.js      # OpenAI 兼容 SSE 流（同时导出通用 streamChat）
│       ├── deepseek-search.js # DeepSeek 原生联网（/v1/tools/search + /fetch）
│       ├── tc3.js           # 腾讯云 TC3-HMAC-SHA256 签名（WebCrypto）
│       ├── cache.js         # 检索结果内存缓存（TTL 10 分钟）
│       ├── yuanbao-mcp.js   # 元宝云 API / MCP Streamable HTTP 客户端
│       └── custom.js        # 任意 OpenAI 兼容端点
└── assets/
    └── wallpapers/          # 内置精选 10 张（断网兜底）+ CREDITS.md 来源署名
```

---

## 七、在普通浏览器中预览（无扩展环境）

```bash
cd ai-newtab
python -m http.server 8000
# 浏览器打开 http://localhost:8000/newtab.html
```

此时 `chrome.storage.local` 不存在，会自动降级到 `localStorage`（同一 JSON 结构），功能完全可用，只是没有「新标签页覆盖」效果。设置 → 通用 底部会显示当前实际使用的存储位置。

> 注意：直接双击 `newtab.html`（`file://`）时 ES Module 会被 CORS 策略拦截，请使用上面的本地服务器方式。

---

## 八、已知限制

1. **不能远程加载代码**：Chrome 应用商店不允许 MV3 扩展加载远程脚本，本扩展本身也不含任何远程脚本。所有 AI 请求都是 `fetch` 的数据交互，不执行远端代码。
2. **CORS**：所有 AI 服务、必应壁纸接口、favicon 服务都由浏览器直连，因此依赖对方允许跨域。DeepSeek 官方接口与必应壁纸接口均可用；自建 MCP 网关需要自行放行 CORS。wallhaven 接口**不返回跨域头**，依赖扩展的 `<all_urls>` host 权限免 CORS，只能在扩展内使用；境内访问需代理（可用壁纸库专用代理或系统代理）。
3. **图标抓取**：Google favicon 服务在国内可能不稳定，失败后会退回站点 `/favicon.ico`，再失败显示首字母色块。
4. **大视频**：上传的文件存在 IndexedDB 中，不建议超过几十 MB，优先用 URL。
5. **未内置 PNG 图标**：manifest 未声明 `icons` 字段，Chrome 会使用默认拼图图标，不影响功能。
6. **窄屏**：宽度 ≤560px 时 Dock 改为横向滚动，时钟缩到 42–46px，搜索框满宽。
7. **AI 面板与 Dock 的间距**：面板固定从底部 96px 处弹出，若 Dock 换成两行会略有重叠，属可接受的视觉取舍。

---

## 九、开发说明

- 新增引擎：在 `src/defaults.js` 的 `AI_ENGINES` / `WEB_ENGINES` 追加一项即可（`search.js` 与设置面板自动读取）。
- 新增 provider：在 `src/providers/` 下实现 `run({ query, settings, secrets, signal, onDelta, onSources, onStatus })`，并在 `PROVIDER_META` 注册。
- 修改默认站点：编辑 `DEFAULT_SITES`；已存在的用户数据不会被覆盖。
- 版本号：`manifest.json` 与 `src/defaults.js` 的 `APP_VERSION` 同步修改。
