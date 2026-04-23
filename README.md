# CC Pet Web

[中文](#中文) | [English](#english)

---

## 中文

Web 端「桌面宠物 + 聊天」应用。浏览器中展示宠物状态与聊天界面，由 Node 服务端统一托管静态前端、REST API 和 WebSocket，与上游 Bridge（如 cc-connect）建立长连接完成会话与消息流转。支持 PWA 安装到桌面/移动端。

### 功能特性

- 宠物动效展示（idle / thinking / talking / happy / error）
- 多会话管理，会话状态实时指示
- 全文消息搜索（基于 SQLite FTS5）
- 图片链接内联预览
- AI 用量监控面板
- PWA 支持，可安装到移动设备主屏幕
- Token 鉴权登录
- 响应式布局，移动端 / 桌面端自适应

### 项目结构

```
packages/
  shared/   # 共享类型与协议定义
  server/   # Fastify 服务、SQLite 存储、Bridge 连接、WebSocket Hub
  web/      # React + Vite + Tailwind 前端
```

### 数据流

```
浏览器 (Token 鉴权) → 服务端 (REST + WS) → Bridge (长连接) → 上游服务
```

### 环境要求

- **Node.js** >= 18（推荐 22）
- **pnpm**（推荐通过 Corepack 启用）
- 构建 `better-sqlite3` 需要 node-gyp 环境（Python、C++ 工具链）

### 快速开始

```bash
git clone <repo-url> cc-pet-web
cd cc-pet-web
corepack enable
pnpm install
```

#### 配置

在 `.data/` 下创建 `cc-pet.config.json`（该目录已加入 `.gitignore`）：

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

| 区块 | 说明 |
|------|------|
| `bridges` | 上游 Bridge 列表：`id`、`host`、`port`、`token`、`enabled` |
| `tokens` | 浏览器访问 Token，`bridgeIds` 声明可使用的 Bridge |
| `pet` | 宠物展示参数（`opacity`、`size`） |
| `server` | 服务端口与数据目录 |

#### 开发

```bash
pnpm dev           # 同时启动服务端 + 前端
pnpm dev:server    # 仅服务端
pnpm dev:web       # 仅前端（Vite，默认 1420 端口，代理 /api 和 /ws 到 localhost:3000）
```

浏览器访问 `http://localhost:1420`，使用配置的 Token 登录。

#### 构建

```bash
pnpm build
```

生产模式下服务端从 `packages/web/dist` 托管静态资源。

### Docker 部署

```bash
docker compose build
docker compose up -d
```

- 容器端口 3000 映射到宿主机 3000
- 数据卷 `cc-pet-data` 挂载为容器内 `/data`
- `cc-pet.docker.config.json` 挂载为容器内 `/data/cc-pet.config.json`，部署前按环境修改 `bridges` 和 `tokens`
- Docker 环境下 Bridge 地址常用 `host.docker.internal`

### 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `CC_PET_PORT` | HTTP 监听端口 | `3000` |
| `CC_PET_DATA_DIR` | 数据目录 | `./data` |
| `CC_PET_LOG_PRETTY` | `1` 美化日志 / `0` JSON 日志 | 自动 |
| `NODE_ENV` | 运行环境 | - |
| `LOG_LEVEL` | Pino 日志级别 | `info` |

### 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发模式 |
| `pnpm build` | 构建所有包 |
| `pnpm test` | 单元测试 |
| `pnpm test:e2e` | 端到端测试 |
| `pnpm lint` | 代码检查 |

### 宠物素材

`packages/web/src/assets/pet/` 下为各状态 PNG，可替换为自有素材，无需改代码。

---

## English

A web-based "desktop pet + chat" application. Displays pet animations and a chat interface in the browser, powered by a Node.js server that hosts the static frontend, REST API, and WebSocket connections. Connects to upstream Bridges (e.g., cc-connect) for session and message routing. Supports PWA installation on desktop and mobile.

### Features

- Pet animations (idle / thinking / talking / happy / error)
- Multi-session management with real-time status indicators
- Full-text message search (SQLite FTS5)
- Inline image link previews
- AI usage monitoring dashboard
- PWA support for mobile home screen installation
- Token-based authentication
- Responsive layout for mobile and desktop

### Project Structure

```
packages/
  shared/   # Shared types and protocol definitions
  server/   # Fastify server, SQLite storage, Bridge connections, WebSocket hub
  web/      # React + Vite + Tailwind frontend
```

### Data Flow

```
Browser (Token auth) → Server (REST + WS) → Bridge (persistent connection) → Upstream service
```

### Prerequisites

- **Node.js** >= 18 (22 recommended)
- **pnpm** (enable via Corepack)
- node-gyp build environment for `better-sqlite3` (Python, C++ toolchain)

### Quick Start

```bash
git clone <repo-url> cc-pet-web
cd cc-pet-web
corepack enable
pnpm install
```

#### Configuration

Create `.data/cc-pet.config.json` (`.data/` is gitignored):

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

| Section | Description |
|---------|-------------|
| `bridges` | Upstream Bridge list: `id`, `host`, `port`, `token`, `enabled` |
| `tokens` | Browser access tokens; `bridgeIds` specifies allowed Bridges |
| `pet` | Pet display settings (`opacity`, `size`) |
| `server` | Server port and data directory |

#### Development

```bash
pnpm dev           # Start server + frontend together
pnpm dev:server    # Server only
pnpm dev:web       # Frontend only (Vite on port 1420, proxies /api and /ws to localhost:3000)
```

Open `http://localhost:1420` and log in with your configured token.

#### Build

```bash
pnpm build
```

In production, the server serves static assets from `packages/web/dist`.

### Docker Deployment

```bash
docker compose build
docker compose up -d
```

- Container port 3000 mapped to host port 3000
- `cc-pet-data` volume mounted as `/data` in the container
- `cc-pet.docker.config.json` mounted as `/data/cc-pet.config.json` — edit `bridges` and `tokens` for your environment
- Use `host.docker.internal` for Bridge addresses in Docker

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CC_PET_PORT` | HTTP listen port | `3000` |
| `CC_PET_DATA_DIR` | Data directory | `./data` |
| `CC_PET_LOG_PRETTY` | `1` for pretty logs / `0` for JSON | auto |
| `NODE_ENV` | Runtime environment | - |
| `LOG_LEVEL` | Pino log level | `info` |

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Development mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | End-to-end tests |
| `pnpm lint` | Linting |

### Pet Assets

PNG files for each state are in `packages/web/src/assets/pet/`. Replace with your own assets — no code changes needed.

### License

See LICENSE file in the repository root.
