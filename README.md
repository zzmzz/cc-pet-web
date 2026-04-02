# cc-pet-web

基于 Web 的「桌面宠物 + 对话」应用：浏览器或桌面壳（Tauri）中展示宠物状态与聊天界面，由 **Node 服务端** 统一托管静态前端、REST API、WebSocket，并与后端的 **Bridge**（如 cc-connect 类服务）建立长连接，完成会话与消息流转。

## 项目做什么

- **前端（`@cc-pet/web`）**：React + Vite + Tailwind，宠物动效、聊天窗口、会话与连接状态、登录门禁（按服务端下发的 Token 鉴权）。
- **服务端（`@cc-pet/server`）**：Fastify + `ws` + SQLite（`better-sqlite3`），负责配置与消息持久化、向 Bridge 出站连接、向浏览器提供 `/api` 与 WebSocket。
- **共享（`@cc-pet/shared`）**：类型与常量（配置结构、WS 事件等）。
- **桌面（`@cc-pet/desktop`）**：Tauri 壳，开发时依赖本仓库 web + server；镜像构建当前仅打包 **server + 已构建的 web 静态资源**。

典型数据流：浏览器持有 **Web 客户端 Token** → 连接服务端 → 服务端按配置使用 **Bridge 列表** 与各自 **Bridge Token** 连接上游 → 消息经服务端在中转与落库。

## 仓库结构

```
packages/
  shared/    # 共享类型与协议
  server/    # Fastify 服务、存储、Bridge、WS Hub
  web/       # React 前端
  desktop/   # Tauri（可选）
```

根目录还提供 **Docker / Podman** 构建与 `docker-compose` 示例。

## 环境要求

- **Node.js** ≥ 18（推荐与 CI / 镜像一致的 **22**）
- **pnpm**（推荐通过 Corepack 启用，与 `Dockerfile` 一致）
- 构建 `better-sqlite3` 需要本机具备 **node-gyp** 常用条件（Python、C++ 工具链等；多数 macOS/Linux 预装或一次性安装即可）

## 本地安装与运行

### 1. 克隆与安装依赖

```bash
git clone <你的仓库 URL> cc-pet-web
cd cc-pet-web
corepack enable
pnpm install
```

### 2. 准备数据目录与配置文件（必做）

服务端启动时会读取数据目录下的 **`cc-pet.config.json`**。根脚本 `pnpm dev:server` 已将 `CC_PET_DATA_DIR` 设为仓库根下的 **`.data`**，因此请创建：

**`.data/cc-pet.config.json`**

若该文件不存在，会回退到 SQLite 内配置；但 **`tokens` 不能为空**，否则进程会报错退出（需至少配置一条 Web 端使用的 Token）。

配置字段与共享类型一致，主要包含：

| 区块 | 说明 |
|------|------|
| `bridges` | 上游 Bridge 列表：`id`、`host`、`port`、连接 Bridge 用的 `token`、`enabled` |
| `tokens` | 浏览器 / 客户端访问本服务用的 Token；`bridgeIds` 声明该 Token 可使用哪些 Bridge |
| `pet` | 宠物展示相关，如 `opacity`、`size` |
| `server` | `port`、`dataDir`（与运行环境一致即可） |

**示例（请把占位符换成你自己的 Bridge 地址与密钥）：**

```json
{
  "bridges": [
    {
      "id": "my-bridge",
      "name": "my-bridge",
      "host": "127.0.0.1",
      "port": 9810,
      "token": "bridge-side-secret",
      "enabled": true
    }
  ],
  "tokens": [
    {
      "token": "your-browser-login-token",
      "name": "dev",
      "bridgeIds": ["my-bridge"]
    }
  ],
  "pet": { "opacity": 1, "size": 120 },
  "server": { "port": 3000, "dataDir": ".data" }
}
```

将 **`.data/`** 加入个人忽略或勿提交真实密钥（仓库 `.gitignore` 已包含 `.data/`）。

### 3. 启动开发

**只起服务端（默认读 `.data`）：**

```bash
pnpm dev:server
```

**只起前端（Vite，默认端口 1420，并将 `/api`、`/ws` 代理到 localhost:3000）：**

```bash
pnpm dev:web
```

**同时起服务端 + 前端（同一终端内并行）：**

```bash
pnpm dev
```

浏览器打开 Vite 提示的地址（一般为 `http://localhost:1420`），使用你在 `tokens` 里配置的字符串登录。

### 4. 构建与预览

全量构建各 package：

```bash
pnpm build
```

仅预览已构建的前端（需已执行过 web 的 build）：

```bash
pnpm --filter @cc-pet/web preview
```

生产形态下，服务端会从 `packages/web/dist` 挂载静态资源（若目录不存在则跳过静态托管，仅 API/WS 可用）。

### 5. 桌面端（可选）

```bash
pnpm --filter @cc-pet/desktop dev
```

需本机安装 Tauri 依赖（Rust 等），详见 [Tauri 官方文档](https://tauri.app/start/prerequisites/)。

## Docker / Podman

在仓库根目录：

```bash
docker compose build
docker compose up -d
# 或
podman compose build && podman compose up -d
```

- 默认将容器 **3000** 映射到宿主机 **3000**。
- 数据卷 **`cc-pet-data`** 挂载为容器内 `/data`（SQLite 等）。
- 根目录 **`cc-pet.docker.config.json`** 会挂载为容器内 **`/data/cc-pet.config.json`**，部署前请按环境修改其中的 `bridges`、`tokens`；Docker 场景下 Bridge 宿主机地址常用 `host.docker.internal`（见示例文件）。

镜像内 Node 为 22-slim；构建阶段会执行 `pnpm install` 与 `packages/web` 的生产构建。

## 环境变量（服务端）

| 变量 | 说明 | 默认 |
|------|------|------|
| `CC_PET_PORT` | HTTP 监听端口 | `3000` |
| `CC_PET_DATA_DIR` | 数据目录（其下 `cc-pet.config.json` 优先于库内配置） | `./data` |
| `CC_PET_LOG_PRETTY` | `1` 强制美化日志，`0` 强制 JSON；未设时非 production 下多为美化 | - |
| `NODE_ENV` | `production` 等 | - |
| `LOG_LEVEL` | Pino 级别 | `info` |

## 常用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` / `dev:server` / `dev:web` | 开发 |
| `pnpm build` | 各包 build |
| `pnpm test` | 各包单元测试 |
| `pnpm test:e2e` | 服务端连接回归 + Web 集成用例 |
| `pnpm lint` | 各包 lint（若已配置） |

## 宠物图片资源

`packages/web/src/assets/pet/` 下为各状态 PNG（idle / thinking / talking / happy / error）。仓库内可为占位小图；你可替换为自有素材，无需改代码路径。

## 协议与贡献

LICENSE 以仓库根目录文件为准。欢迎 Issue / PR。
