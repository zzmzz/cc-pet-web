# CC Pet B/S 重构设计文档

## 概述

将现有 CC Pet（Tauri v2 桌面应用）重构为 B/S 架构的新项目，支持手机和桌面浏览器访问，同时保留 Tauri 桌面宠物形态。

## 设计决策摘要

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 架构模式 | Monorepo 统一架构 | 类型共享、部署简单、关注点清晰 |
| 后端技术栈 | TypeScript (Fastify + ws) | 前后端同语言、类型共享、开发效率高 |
| 前端框架 | React + Vite + Zustand | 保持与现有项目一致，降低迁移成本 |
| 桌面宠物 | Tauri v2 薄壳 | 保留原生体验（透明窗口、置顶、托盘） |
| 部署方式 | 用户自部署 (Docker) | 保持隐私和自主控制 |
| 数据库 | SQLite (better-sqlite3) | 单文件、自部署友好、与现有兼容 |

## MVP 功能范围

**包含：**
- 核心聊天（Bridge WebSocket、流式响应、Markdown 渲染）
- 桌面宠物（状态贴图、拖拽、托盘菜单）
- 多连接多会话
- 按钮确认交互
- 文件收发
- 历史持久化
- 链接预览
- 自动更新检查
- 斜杠命令
- 响应式移动端适配

**不包含（后续版本）：**
- LLM 直连（OpenAI 兼容 API）
- SSH 隧道

---

## §1 Monorepo 结构与包划分

### 目录结构

```
cc-pet-web/                          # monorepo root
├── package.json                     # pnpm workspace 根配置
├── pnpm-workspace.yaml
├── docker-compose.yml               # 一键部署
├── Dockerfile
│
├── packages/shared/                 # 共享层
│   ├── src/types/
│   │   ├── message.ts               # ChatMessage, StreamDelta...
│   │   ├── session.ts               # Session, SessionTask...
│   │   ├── config.ts                # AppConfig, BridgeConfig...
│   │   └── bridge.ts                # Bridge 协议消息类型
│   ├── src/constants/               # 协议常量、事件名
│   └── src/utils/                   # 纯函数工具（格式化、校验等）
│
├── packages/server/                 # 后端服务
│   ├── src/
│   │   ├── index.ts                 # 入口：启动 HTTP + WS
│   │   ├── bridge/                  # cc-connect 代理层
│   │   │   ├── client.ts            # WebSocket 连接 cc-connect
│   │   │   ├── protocol.ts          # 消息解析/分发
│   │   │   └── manager.ts           # 多连接管理
│   │   ├── api/                     # REST 路由
│   │   │   ├── sessions.ts
│   │   │   ├── history.ts
│   │   │   ├── config.ts
│   │   │   └── files.ts
│   │   ├── ws/                      # 面向前端的 WebSocket
│   │   │   └── handler.ts           # 客户端连接管理 + 事件转发
│   │   ├── storage/                 # 持久化
│   │   │   ├── db.ts                # SQLite 初始化
│   │   │   ├── messages.ts          # 消息 CRUD
│   │   │   └── sessions.ts          # 会话 CRUD
│   │   └── services/                # 业务逻辑
│   │       ├── link-preview.ts
│   │       └── update-check.ts
│   └── package.json
│
├── packages/web/                    # 前端 SPA
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/              # Pet, ChatWindow, Settings...
│   │   ├── hooks/                   # useWebSocket, useApi...
│   │   ├── lib/                     # store (zustand), api client, platform
│   │   ├── styles/
│   │   └── assets/pet/              # 宠物素材
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
└── packages/desktop/                # Tauri 桌面壳
    ├── src-tauri/
    │   ├── src/main.rs              # 最小入口
    │   ├── src/lib.rs               # 原生能力：托盘、快捷键、窗口控制
    │   ├── Cargo.toml
    │   └── tauri.conf.json
    ├── src/
    │   └── platform.ts              # Tauri 特有 API 封装
    └── package.json                 # 依赖 @cc-pet/web
```

### 包依赖关系

- `shared` → 无外部包依赖（最底层）
- `server` → 依赖 `shared`
- `web` → 依赖 `shared`
- `desktop` → 依赖 `shared` + `web`（复用 UI）

### 构建策略

- `web` 构建输出 `dist/`
- `server` 在生产模式下 serve `web/dist/` 静态文件
- `desktop` 开发时连 Vite dev server，构建时使用 `web/dist/`

---

## §2 后端架构

### 双 WebSocket 代理模式

Server 是"中间人"：上游连 cc-connect，下游连浏览器/Tauri 前端。

```
浏览器/Tauri ←[WebSocket]→ Server ←[WebSocket]→ cc-connect
浏览器/Tauri ←[REST API]→  Server（历史/配置/文件）
```

上下游通过 EventEmitter 事件总线解耦。

### 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| HTTP 框架 | Fastify | 比 Express 快 ~3x，TypeScript 原生，Schema 验证内置 |
| WebSocket | ws | 轻量零依赖，与 Fastify 共享端口，不需要 Socket.IO 开销 |
| 数据库 | better-sqlite3 | 同步 API，单文件，自部署友好 |
| 文件上传 | @fastify/multipart | Fastify 官方插件 |
| 静态文件 | @fastify/static | 生产模式 serve web/dist/ |

### REST API

```
# 配置管理
GET    /api/config                # 获取应用配置
PUT    /api/config                # 更新配置

# Bridge 连接
POST   /api/bridges/:id/connect   # 连接指定 Bridge
POST   /api/bridges/:id/disconnect# 断开连接
GET    /api/bridges/:id/status    # 连接状态

# 会话管理
GET    /api/sessions              # 列出所有会话
POST   /api/sessions              # 创建会话
DELETE /api/sessions/:id          # 删除会话
POST   /api/sessions/:id/switch   # 切换活跃会话

# 历史记录
GET    /api/history/:chatKey      # 获取聊天历史
DELETE /api/history/:chatKey      # 清除历史

# 文件
POST   /api/files/upload          # 上传文件
GET    /api/files/:id             # 下载文件

# 其他
GET    /api/link-preview?url=     # 链接预览
GET    /api/update-check          # 检查新版本
```

### WebSocket 协议（Server ↔ 前端）

所有消息统一 JSON 格式，`type` 字段路由。

**下行（Server → 前端）**——与现有 Tauri emit 事件一一对应：

```typescript
{ type: "bridge:connected", connectionId, connected }
{ type: "bridge:message", connectionId, sessionKey, content }
{ type: "bridge:stream-delta", connectionId, sessionKey, delta }
{ type: "bridge:stream-done", connectionId, sessionKey, fullText }
{ type: "bridge:buttons", connectionId, sessionKey, content, buttons }
{ type: "bridge:typing-start" | "bridge:typing-stop", connectionId, sessionKey }
{ type: "bridge:file-received", connectionId, name, url }
{ type: "bridge:skills-updated", connectionId, commands }
```

**上行（前端 → Server）**：

```typescript
{ type: "send-message", connectionId, sessionKey, content }
{ type: "send-button", connectionId, sessionKey, buttonId }
{ type: "send-file", connectionId, sessionKey, fileId }
```

迁移策略：前端将现有 `listen("bridge-xxx")` 替换为 WebSocket `onmessage` 分发，改动量最小。

---

## §3 前端架构

### 平台适配层

核心设计：所有组件通过 `usePlatform()` hook 获取适配器，永远不直接调用 Tauri API 或 fetch。

```typescript
interface PlatformAPI {
  connectWs(url: string): WebSocket
  sendMessage(msg: SendMessagePayload): void
  onEvent(type: string, handler: EventHandler): Unsubscribe
  uploadFile(file: File): Promise<FileInfo>
  downloadFile(id: string): Promise<Blob>
  getConfig(): Promise<AppConfig>
  saveConfig(config: AppConfig): Promise<void>
  // 窗口控制（仅 Tauri 有实现，Web 侧为空操作）
  setWindowMode?(mode: 'pet' | 'chat' | 'settings'): void
  setAlwaysOnTop?(value: boolean): void
  startDrag?(): void
}
```

运行时检测：
- `window.__TAURI__` 存在 → `TauriAdapter`：invoke() + Tauri events + WebSocket
- 否则 → `WebAdapter`：WebSocket + fetch REST API

### 组件架构

**保留 & 增强：**
- `Pet.tsx` → 增加 Web 模式支持（非透明背景、点击展开聊天面板）
- `ChatWindow.tsx` → 拆分为 MessageList / MessageInput / ButtonCard
- `Settings.tsx` → 基本保留，去掉 Tauri 特有选项（Web 模式下隐藏）
- `SessionDropdown.tsx` → 保留
- `SlashCommandMenu.tsx` → 保留

**新增：**
- `Layout.tsx` — 响应式主布局（移动端/桌面端自适应）
- `MobileNav.tsx` — 移动端底部 sheet / 汉堡菜单
- `ConnectionStatus.tsx` — 连接状态指示器
- `FilePreview.tsx` — 文件预览（从 ChatWindow 拆出）
- `LinkPreview.tsx` — 链接预览（从 ChatWindow 拆出）

### 状态管理

从单一大 store 拆分为 5 个 slice：

| Slice | 职责 |
|-------|------|
| `connectionStore` | connections, activeId, status |
| `sessionStore` | sessions, activeSession, labels, unread |
| `messageStore` | messagesByChat, streaming state |
| `configStore` | appConfig, save/load |
| `uiStore` | chatOpen, settingsOpen, petState, isMobile |

各 slice 独立文件，通过 zustand combine 合并。好处：更容易测试、更清晰的职责边界、按需订阅减少渲染。

### 响应式布局

**移动端 (< 768px)：**
- 单列布局
- 宠物为左上角 32px 小圆圈（边框颜色 = 状态：灰=空闲、黄+脉冲=思考、蓝+呼吸=说话、绿+弹跳=开心、红+抖动=错误）
- 顶栏：左=宠物圆圈 | 中=Bridge 名+会话名（点击切换） | 右=会话列表+设置
- 聊天区占满剩余空间
- 底部固定输入框，键盘弹出时自动上推
- 点击宠物圆圈可弹出宠物大图面板

**桌面端 (≥ 768px)：**
- 左侧边栏：宠物 + 连接列表 + 会话列表
- 右侧主区：聊天窗口
- 快捷键支持（与 Tauri 版一致）
- 宽屏可展开侧边详情面板

### 宠物在不同平台的行为差异

| 行为 | Web (浏览器) | Desktop (Tauri) |
|------|-------------|-----------------|
| 位置 | 页面内嵌入（侧栏或顶栏圆圈） | 桌面浮动，可拖拽到任意位置 |
| 状态贴图 | 相同素材 | 相同素材 |
| 点击交互 | 点击展开/收起聊天面板 | 双击打开/关闭聊天窗口 |
| 右键菜单 | 自定义 context menu | 原生系统托盘菜单 |
| 始终置顶 | 不支持 | 原生置顶 |
| 透明窗口 | 不支持 | 原生透明 |
| 全局快捷键 | 页面内快捷键 | 系统级快捷键 |
| 动画效果 | Framer Motion | Framer Motion |

---

## §4 Tauri 桌面壳

### 极简原则

Tauri 壳只做浏览器做不到的事。现有 ~40 个 invoke 命令精简为 ~6 个纯窗口控制命令：

```rust
// Tauri Rust 侧暴露的命令
set_window_mode(mode: "pet" | "chat" | "settings")
set_always_on_top(value: bool)
set_opacity(value: f64)
start_drag()
show_tray_menu()
register_shortcut(key: String, action: String)
```

所有业务逻辑（Bridge 通信、会话、历史、文件）全部走 Server。

### 工作模式

Tauri WebView 加载 `http://localhost:3000`（本地 Server）或远程 Server URL。Web 包检测到 `__TAURI__` 后，使用 `TauriAdapter`：
- 原生窗口能力 → `invoke()`
- 业务通信 → WebSocket 连接 Server

### 两种桌面部署模式

**本地模式：** Server 和 Tauri 在同一台机器
```bash
docker compose up -d    # 启动 Server
open "CC Pet.app"       # 启动桌面宠物，自动连 localhost:3000
```

**远程模式：** Server 在远程机器
```
Tauri 设置中填写 Server URL: https://my-server:3000
```

---

## §5 部署方案

### Docker 单容器部署

```yaml
# docker-compose.yml
services:
  cc-pet:
    image: cc-pet-server:latest
    ports: ["3000:3000"]
    volumes:
      - ./data:/app/data       # SQLite + 文件持久化
    environment:
      - CC_PET_SECRET=your-secret
      - CC_PET_PORT=3000
```

### 配置管理

- **运维参数**：环境变量控制（端口、密钥）
- **业务配置**：Web UI 设置页管理（Bridge 连接、宠物外观等）
- **持久化**：配置存储在 SQLite 中（data volume）
- **备选**：支持 `config.toml` 文件作为配置源
- **首次启动**：进入引导页配置 Bridge 连接信息

### 认证机制

Server 对外暴露的 WebSocket 和 REST API 需要认证：

- 环境变量 `CC_PET_SECRET` 定义访问密钥
- 前端通过 WebSocket 握手时的 `?token=` 查询参数或 REST 请求的 `Authorization: Bearer` 头传递密钥
- Tauri 桌面壳在设置页保存 Server URL + token，连接时自动携带
- 浏览器首次访问时弹出登录页输入 token，存入 localStorage

### Tauri Server URL 配置

- 首次启动 Tauri 桌面宠物时，弹出引导页输入 Server URL（默认 `http://localhost:3000`）和访问 token
- 配置保存在 Tauri 本地存储（`localStorage` 或 Tauri store plugin）
- 设置页可随时修改 Server URL

### 端口规划

| 端口 | 用途 |
|------|------|
| 3000 (可配置) | HTTP API + 静态文件 + WebSocket (upgrade) |

单端口，HTTP 和 WebSocket 共享，简化部署和防火墙配置。

---

## 技术栈总览

| 层 | 技术 |
|----|------|
| 包管理 | pnpm workspace |
| 共享类型 | TypeScript |
| 后端 | Fastify + ws + better-sqlite3 |
| 前端 | React 19 + Vite + Zustand + Tailwind CSS + Framer Motion |
| 桌面壳 | Tauri v2 (Rust，仅窗口控制) |
| Markdown | react-markdown + remark-gfm + rehype-raw |
| 代码高亮 | react-syntax-highlighter |
| 部署 | Docker / docker-compose |
| 测试 | Vitest（前端） + Vitest/Node test runner（后端） |

---

## 迁移策略概要

1. **新建仓库**，搭建 monorepo 脚手架
2. **shared 包**：从现有 `src/lib/types.ts` 提取类型定义
3. **server 包**：参照现有 `src-tauri/src/bridge.rs` 实现 WebSocket 代理，参照 `history.rs` 实现 SQLite 存储
4. **web 包**：迁移现有 React 组件，用 PlatformAdapter 替换 Tauri invoke 调用
5. **desktop 包**：从现有 Tauri 配置精简，只保留窗口控制
6. **逐步验证**：每个模块独立可测试

---

## 后续版本规划

- **v1.1**：LLM 直连（OpenAI 兼容 API，不走 cc-connect）
- **v1.2**：SSH 隧道支持
- **v1.3**：PWA 离线支持
- **v2.0**：多用户 / 多租户（SaaS 预备）
