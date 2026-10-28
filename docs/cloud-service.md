# Aurora New Tab — 壁纸云端服务 开发需求

> 交给云端 AI 执行的完整需求。按本文档实现即可，不需要再猜 Steam 的数据结构——第七节是实测结果。

---

## 一、背景

「Aurora New Tab」是一个 Chrome 起始页扩展，可以把 Wallpaper Engine（Steam AppID `431960`）的创意工坊壁纸设为浏览器背景。

**当前瓶颈**：Steam 只对外提供两级预览素材——静态件 1024×1024 JPEG、视频件约 192×192 GIF。这是 Steam 侧的硬上限，与账号、登录状态无关。而壁纸的**真实素材**（作者原图、完整视频）只存在于工坊文件里，获取它需要走 Steam 的 depot 协议（CM 握手 + manifest + 分块 AES 解密），浏览器无法实现。

**因此**：在一台云服务器上跑一个服务，由它用 `steamcmd` 下载工坊文件、解析出原图与视频，再通过 HTTP 提供给扩展。扩展只做展示，不在本地存放大文件。

---

## 二、目标

1. 扩展发一个壁纸 ID，服务能在若干秒内返回该壁纸的**原图**与**元数据**；
2. 若该壁纸含视频，能通过 HTTP **流式播放**（支持 Range，不整文件读进内存）；
3. 网页类壁纸能把整包文件按清单 serve 出来，让 `<iframe>` 真实运行；
4. 列表缩略图能由云端代拉 Steam 图并缩放返回（治国内 CDN 慢）；
5. 磁盘缓存可控：设上限，超了按 LRU 自动清理；
6. 接口简单、鉴权轻量、可一键部署（Docker Compose）。

**非目标**：不做壁纸搜索/推荐（搜索仍由扩展直接访问 Steam）；不做视频转码（图片缩略图缩放除外）；不做多用户体系。

---

## 三、总体架构

```
Chrome 扩展  ──HTTP──▶  云端服务 (FastAPI)  ──spawn──▶  steamcmd
                              │                            │
                              │◀──── 下载到磁盘 ───────────┘
                              ▼
                    /data/workshop/431960/<id>/
                        preview.jpg        → /api/wallpaper/<id>/preview.jpg
                        project.json       → /api/wallpaper/<id>
                        <视频>.mp4         → /api/wallpaper/<id>/video.mp4
                        index.html + 资源  → /api/wallpaper/<id>/web/<path>
                                             /api/wallpaper/<id>/web/files

                 另有两条不落工坊目录的辅助路由：
                   /api/thumb?u=&w=   → 代拉 Steam 图片并缩放（不写盘，仅内存+CDN 缓存）
                   /api/library       → 已缓存清单
```

- 服务收到某 ID 的首次请求 → 触发下载 → 就绪后返回素材
- 已下载过的直接读磁盘，秒回
- `<id>/` 里有什么就 serve 什么：静态看 `preview.jpg`，视频看 `*.mp4`，网页壁纸整包交给 iframe

---

## 四、功能需求

### 4.1 拉取壁纸（核心）

对给定 `id`：

1. 若 `/data/workshop/431960/<id>/` 已存在且含 `preview.jpg` → 直接可用；
2. 否则调用 steamcmd 下载：

```bash
steamcmd \
  +force_install_dir /data/steamcmd \
  +login anonymous \
  +workshop_download_item 431960 <ID> \
  +quit
```

3. 下载产物在 `/data/steamcmd/steamapps/workshop/content/431960/<ID>/`；
4. 下载完成后把该目录**移动或硬链接**到 `/data/workshop/431960/<ID>/`，避免重复占用；
5. 无论成功失败，都要记录状态，供轮询查询。

**实现要求**

- steamcmd 同一时刻只允许一个进程（文件锁），并发请求排队；
- 下载超时默认 300 秒，可配置；超时杀进程并标记失败；
- steamcmd 首次运行会自更新，容器启动时应预热一次（`+quit`）；
- 匿名下载对 Wallpaper Engine 有效（已确认该 App 在可匿名下载名单内）。若返回 `Failure`，标记为 `need_auth`，并在文档中说明可通过环境变量提供 Steam 账号增强兼容性（可选实现）。

### 4.2 解析元数据

从 `<id>/project.json` 读取（实测字段）：

| 字段 | 说明 |
|---|---|
| `title` | 壁纸标题 |
| `type` | 类型，值可能是 `scene` / `video` / `web`，**大小写不统一，必须 `toLowerCase()`** |
| `tags` | 字符串数组或 `{tag}` 对象数组，需兼容两种 |
| `file` | 视频壁纸的成片文件名，如 `xxx.mp4`（可能缺失，需按扩展名兜底扫描） |

再补充：

- `preview.jpg` 的像素尺寸（用 Pillow 或 `imagesize` 读取）；
- 视频分辨率（用 `ffprobe`；**ffprobe 缺失时不得导致接口失败**，可返回 null）；
- 视频大小、总时长（可选）。

### 4.3 HTTP API

统一前缀 `/api`，除 `/api/health` 外都需要鉴权（见 4.5）。

#### `GET /api/health`
```json
{ "ok": true, "steamcmd": true, "cached": 12, "diskUsedMB": 2048 }
```

#### `GET /api/wallpaper/{id}`
查询状态，**不阻塞**。首次请求会顺带触发后台下载。

已就绪（200）：
```json
{
  "id": "1994794519",
  "state": "ready",
  "title": "Rainy Day",
  "type": "scene",
  "preview": { "width": 1431, "height": 1431, "bytes": 236672 },
  "video": null,
  "tags": ["Anime", "2560 x 1440"],
  "fetchedAt": 1793159106
}
```

含视频时 `video`：
```json
{ "file": "xxx.mp4", "bytes": 146800640, "width": 1920, "height": 1080, "duration": 42.5 }
```

处理中（202）：
```json
{ "id": "1994794519", "state": "downloading", "message": "正在从 Steam 拉取" }
```

失败（仍返回 200，state 表明原因）：
```json
{ "id": "...", "state": "failed", "message": "steamcmd 返回 Failure" }
```

> `state` 取值：`ready` | `downloading` | `queued` | `failed` | `need_auth` | `not_found`

#### `GET /api/wallpaper/{id}/preview.jpg`
- 返回作者原图（`image/jpeg`）
- 必须设置 `Cache-Control: public, max-age=604800, immutable`
- 支持 `ETag`/`Last-Modified`（可选）

#### `GET /api/wallpaper/{id}/video.mp4`
- **必须支持 HTTP Range（206 Partial Content）**，这是视频播放与拖动进度的前提
- 返回 `Accept-Ranges: bytes`、`Content-Range`、`Content-Length`
- 用流式响应（`StreamingResponse` / `sendfile`），**禁止把整个文件读进内存**
- 无视频时返回 404 + JSON 错误

#### `GET /api/wallpaper/{id}/web/files`
网页壁纸（`type: "web"`）的文件清单。扩展拿到后把整包拉进浏览器 HTTP 缓存，之后 iframe 的子资源请求全部命中本地磁盘、不再产生服务器流量。

```json
{ "id": "3824243049", "files": ["index.html", "app.js", "css/style.css", "media/bg.webm"], "total": 4 }
```

**要求**

- 递归遍历 `<CACHE_DIR>/431960/<id>/` 下的真实文件，**排除** `preview.jpg`、`project.json`、`scene.pkg`、`*.mp4`（这些各有专门端点）
- 返回**包内相对路径**，统一用 `/` 分隔，不要带前导 `/`
- 入口固定是根目录的 `index.html`（扩展按 `web/index.html` 直接引用）
- 非网页壁纸（scene / video）返回 `files: []` 或 404 都行，扩展会记成 unsupported 不再重试

#### `GET /api/wallpaper/{id}/web/<path>`
网页壁纸包内的任意文件，直接 serve。

| 项 | 要求 |
|---|---|
| Content-Type | **按扩展名正确推断**。`index.html` 必须是 `text/html`——扩展靠这个判断入口能不能跑（拿到别的类型会放弃 iframe，回落到图片） |
| 缓存 | `Cache-Control: public, max-age=604800, immutable`——扩展就是靠它做到「第二次打开零流量」 |
| 路径安全 | 拒绝 `..`、绝对路径、符号链接逃逸，只允许 `<id>` 目录内的文件 |
| 鉴权 | 见下方「子资源问题」 |

**子资源问题（必须处理，否则首次打开是白屏）**

`<iframe src=".../web/index.html?token=XXX">` 只会给**入口文档**带上 token。`index.html` 里的 `<script src="app.js">`、`<img src="media/a.png">` 解析成 `.../web/app.js`——**不带 token**。

扩展的对策是：入口探测通过后立刻后台预取整包（预取请求带 token，响应进浏览器缓存），之后子资源命中缓存就不再发请求。但**首帧**仍可能抢在预取完成之前，表现为缺资源或白屏。

所以服务端二选一：

1. **推荐**：对 `GET /api/wallpaper/{id}/web/*` **放宽为不需要 token**。这些是创作者上传的静态资源，本身不是敏感数据；`/api/wallpaper/{id}` 这类 JSON 接口照旧鉴权即可。
2. 或者：serve 入口 HTML 时把相对路径改写成带 token 的绝对路径（改动面大，不推荐）。

> `<iframe sandbox="allow-scripts allow-same-origin">` 会让网页壁纸与云服务**同源**，它因此能读到自己的 URL（含 token）。这是网页壁纸读写 localStorage 的必要妥协——所以这个服务只该放你自己订阅的壁纸，不要做成公开多租户。

#### `POST /api/wallpaper/{id}/prepare`
显式触发下载（扩展在用户点「设为背景」时调用），返回 202 与状态。

#### `GET /api/library?page=1&size=50`
已缓存壁纸列表，用于扩展在工坊卡片上标「云端」角标。返回结构固定为：

```json
{
  "items": [
    { "id": "1994794519", "title": "Rainy Day", "type": "scene",
      "preview": { "width": 1431, "height": 1431, "bytes": 236672 },
      "video": null, "fetchedAt": 1793159106 }
  ],
  "total": 12,
  "page": 1,
  "size": 50
}
```

> 至少返回 `items[].id`，其余字段缺失不影响扩展使用。

#### `GET /api/thumb?u=<urlencoded>&w=<width>`
Steam 图片中转。`images.steamusercontent.com` 在国内路由极差（单张十几秒），而工坊浏览页给的是约 900KB 的全尺寸原图。云端代拉一次、缩放后返回，列表就能秒开。

```
GET /api/thumb?u=https%3A%2F%2Fimages.steamusercontent.com%2Fugc%2F...&w=512&token=XXX
```

**要求**

- 只允许 `https://`，且 host 命中白名单：
  - `images.steamusercontent.com`
  - `*.steamstatic.com`
  - `*.steamuserimages-a.akamaihd.net`

  > 扩展侧已按同一套白名单过滤，**服务端必须再校验一次**——这是防 SSRF 的唯一屏障。
- 按宽等比缩到 `w`（默认 512），输出 `image/webp`（浏览器都吃）
- 禁止跟随重定向到白名单之外；限制响应体积（如 20MB）与上游超时（如 20 秒）
- 缓存：`Cache-Control: public, max-age=604800, immutable`
- `127.0.0.1`、`10.*`、`172.16-31.*`、`192.168.*`、`169.254.*`（云元数据）一律拒绝

#### `DELETE /api/wallpaper/{id}`
删除该壁纸的磁盘缓存。

#### 错误格式统一
```json
{ "error": "need_auth", "message": "该壁纸需要登录 Steam 账号才能下载" }
```

### 4.4 缓存与清理

- 缓存根目录 `CACHE_DIR`（默认 `/data/workshop`），结构 `<CACHE_DIR>/431960/<id>/`
- 上限 `MAX_CACHE_GB`（默认 50）
- 后台任务每 10 分钟检查一次：超限时按 **最后访问时间（atime/mtime）LRU** 删除整个 `<id>/` 目录，直到低于上限的 90%
- 提供一个 `GET /api/cache` 返回当前占用与条目数
- 网页壁纸整包可能很大（几十 MB 到几百 MB 的 webm 素材），LRU 要按**目录总大小**算，不能只数条目

### 4.5 鉴权

- 环境变量 `API_TOKEN`，请求头 `Authorization: Bearer <API_TOKEN>`
- **同时必须接受 `?token=<API_TOKEN>` 查询参数**（同一个值，与 Bearer 等价）
  > 这一条是硬要求，不是可选项：`<img src>` 和 `<video src>` 无法携带自定义请求头，
  > 扩展端的资源直链只能通过查询参数鉴权。推荐实现成 FastAPI 依赖：
  > 先读 `Authorization` 头，取不到再读 `request.query_params.get("token")`，
  > 两者都没有或都不匹配才返回 401。
- **例外**：`GET /api/wallpaper/{id}/web/*` 建议整条前缀放行（原因见 4.3 的「子资源问题」）
- 未配置时**拒绝启动**（避免裸奔）
- `/api/health` 可选开放，其余一律校验
- 不需要用户体系、不需要 JWT
- 访问日志里把 `token` 参数打码（`token=***`），避免令牌进日志

### 4.6 CORS

允许扩展与本地预览页调用：
```python
allow_origins=["*"]          # 仅对 GET 资源
allow_methods=["GET","POST","DELETE","OPTIONS"]
allow_headers=["Authorization","Content-Type"]
expose_headers=["Content-Range","Accept-Ranges","Content-Length"]
```
（因为靠 Bearer Token 鉴权、不带 Cookie，`*` 在此场景可接受）

---

## 五、非功能需求

| 项 | 要求 |
|---|---|
| 语言 | Python 3.11+ / FastAPI + uvicorn（若无偏好按这个来） |
| 并发 | 至少同时处理 8 个元数据请求；steamcmd 下载串行 |
| 启动 | `docker compose up -d` 一条命令拉起 |
| 日志 | 输出到 stdout，含每次下载的 id、耗时、结果 |
| 健康检查 | 容器 `HEALTHCHECK` 打 `/api/health` |
| 磁盘 | 镜像内不含缓存；缓存挂 volume |

### Docker 要点

- 基础镜像需含 `steamcmd` 依赖（`lib32gcc-s1`、`ca-certificates`、`curl`）
- `ENTRYPOINT` 先跑一次 `steamcmd +quit` 完成自更新，再启动 uvicorn
- `volumes: ./data:/data`
- 端口 `8000:8000`

---

## 六、部署

提供：

1. `Dockerfile`
2. `docker-compose.yml`
3. `.env.example`（`API_TOKEN` / `MAX_CACHE_GB` / `CACHE_DIR` / `DOWNLOAD_TIMEOUT`）
4. `README.md`：三步启动、反代提示（建议 Caddy 自动 HTTPS）、如何验证

**注意**：服务器需能访问 `steamcommunity.com`、`steampowered.com` 与 Steam CDN。国内服务器通常需要配置出站代理，请把代理方式写进 README（`HTTPS_PROXY` 环境变量对 steamcmd 不一定生效，需说明可用方案）。

---

## 七、附录：实测数据结构（不用再摸索）

以下是在真实环境中确认过的事实：

**工坊条目目录结构**
```
<id>/
  preview.jpg              必存，作者上传的原图，无压缩/无黑边
  project.json             必存，元数据
  scene.pkg                场景类壁纸的打包文件（浏览器无法渲染，只用 preview）
  <任意名称>.mp4           视频类壁纸的完整成片，文件名不固定
  index.html + 资源目录    网页类壁纸（type=web）的完整站点，入口固定 index.html，
                           常见 app.js / css/ / media/ / *.webm，文件数量和体积都不定
```

> 区分类型靠 `project.json` 的 `type`，不要靠文件名猜。`type=web` 才走 `/web/*` 与 `/web/files`；
> 其余类型 `web/files` 返回空数组即可。
>
> 遍历 `/web/files` 时记得**跳过** `preview.jpg` / `project.json` / `scene.pkg` / `*.mp4`，
> 否则扩展会把它们也当包内资源预取一遍，白耗流量。

**preview.jpg 实测尺寸分布**（64 个样本）：524 / 768 / 945 / 1079 / 1080 / **1431** px 见方。
即：Steam 接口下发的 1024 是被压缩过的，本地原图最高达 1431×1431。

**视频文件实测**：7MB ~ 355MB 不等，标准 H.264 MP4。

**类型分布**（64 个样本）：scene 49、video 13、web 1。`project.json` 中 `type` 字段大小写混用（`Scene` / `scene`、`Video` / `video`）。

**已验证不可行的途径**（不要浪费时间重试）：

| 途径 | 结果 |
|---|---|
| `GetPublishedFileDetails` 的 `file_url` | 抽查 20 个热门条目全为空，`filename` 也为空 |
| `ISteamRemoteStorage/GetUGCFileDetails` | 403，需要 API key |
| `sharedfiles/downloadfile/?id=` | `{"success":15,"message":"No user"}`，需登录且无公开返回格式 |
| 图片 CDN 加 `imw=2560` 参数 | 只是把 1024 放大再补黑边，文件反而更小 |

**结论**：唯一可靠获取原始文件的途径就是 `steamcmd +login anonymous +workshop_download_item 431960 <id>`。

---

## 八、验收标准

1. `curl -H "Authorization: Bearer $TOKEN" https://<host>/api/wallpaper/1994794519` 首次返回 202，数十秒后返回 `state: "ready"`，且 `preview.width` 为 1431；
2. `curl -I .../preview.jpg` 返回 `200` + `Content-Type: image/jpeg`；
3. `curl -H "Range: bytes=0-1023" -I .../video.mp4` 返回 `206` + 正确的 `Content-Range`；
4. 直接用浏览器打开 `.../video.mp4` 能播放并能拖动进度条；
5. 把 `MAX_CACHE_GB` 设为 `1` 并下载多张后，缓存目录能自动回落到 900MB 以内；
6. 不带 Token 请求返回 `401`；
7. `docker compose up -d` 后 `docker ps` 显示容器 healthy；
8. **`curl -I ".../preview.jpg?token=$TOKEN"`（不带任何请求头）返回 200** —— 这是 `<img>` 直链能用的前提；
9. `curl -I ".../video.mp4?token=$TOKEN"` 同样返回 200 且带 `Accept-Ranges: bytes`；
10. `curl ".../api/wallpaper/<网页壁纸ID>/web/files?token=$TOKEN"` 返回 `files` 数组，且第一项是 `index.html`；
11. `curl -I ".../api/wallpaper/<网页壁纸ID>/web/index.html"`（**故意不带 token**）返回 `200` + `Content-Type: text/html` —— 子资源放行是否生效就看这条；
12. 用浏览器直接打开 `.../web/index.html?token=$TOKEN`，页面里的脚本、图片、字体**全部加载成功**（F12 Network 无 401），且控制台无报错；
13. `curl -I ".../api/thumb?u=<任一张steamusercontent图片，urlencoded>&w=512&token=$TOKEN"` 返回 `200`，且 `Content-Type` 是浏览器能直接显示的图片格式（`image/webp` 或 `image/jpeg`）；
14. `curl ".../api/thumb?u=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F&token=$TOKEN"` 返回 `400`，**绝不能把内网内容读出来**（SSRF 底线）。

---

## 九、扩展端如何对接（**已实现**，按此对齐即可）

扩展侧已经写好客户端（`src/we-cloud.js` + `src/we-cache.js`），设置 → WE 工坊 → 云端原图与完整视频里填**服务地址 + API Token**，勾上开关即生效。实际调用时序如下，服务端按此保证即可：

| 时机 | 请求 | 期望 |
|---|---|---|
| 点「测试连接」 | `GET /api/health`（Bearer + `?token=`） | 200 + JSON；随后还会用 `<img>` 无头拉一次 `preview.jpg` 验证 `?token=` |
| 打开某张壁纸的详情 | `GET /api/wallpaper/{id}` | `state=ready` 时用 `preview.width/height`、`video` 字段渲染规格 |
| 列表加载完 | `GET /api/library?page=1&size=200` | 一次请求，命中则给卡片打「云端」角标；失败静默 |
| 列表里的每张缩略图 | `GET /api/thumb?u=<Steam图>&w=512`（仅 `?token=`） | 云端代拉 + 缩放，webp 返回；不支持时扩展直接用 Steam 原地址 |
| 点「设为起始页背景」 | `POST /api/wallpaper/{id}/prepare` | `ready` 立即生效；`downloading/queued` 时扩展先用手上素材顶上，每 4 秒轮询一次（最长 5 分钟），就绪后自动切换 |
| 渲染预览图 / 视频 | `GET .../preview.jpg`、`GET .../video.mp4`（仅 `?token=`） | 图片可长期直引；视频必须 206 流式 |
| 网页壁纸入口探测 | `GET .../web/index.html`（仅 `?token=`） | 必须 200 + `text/html`，否则扩展放弃 iframe 回落图片 |
| 网页壁纸预取 | 先 `GET .../web/files`，再按清单逐个 `GET .../web/<path>` | **靠响应的 Cache-Control 进浏览器磁盘缓存**，之后 iframe 子资源零请求 |
| 设为背景 | 上述 URL 直接给 `<img>` / `<video>` / `<iframe>` | **不下载、不落盘**（网页壁纸的整包预取除外，那是浏览器 HTTP 缓存） |

服务端需要保证：**接口稳定、`?token=` 能鉴权、Range 正确、URL 可长期直接引用、`/web/*` 子资源放行**。

> 两个容易踩的坑：
> 1. `/api/wallpaper/{id}` 在 `downloading` 阶段**必须秒回 202/200**（不能阻塞等下载），否则扩展的轮询会一直卡在超时上。
> 2. `/web/*` 如果严格要求 token，网页壁纸**首次打开必然缺资源**（子请求不带 token），表现为黑屏或排版错乱——这是最容易被当成「扩展坏了」的问题。
