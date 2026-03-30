# Token 认证与多 Bridge 访问控制

## 概述

为 cc-pet-web 引入基于预共享 token 的认证机制，实现：
- 强制认证：系统必须配置至少一个 token 才能使用
- 多 Bridge 授权：每个 token 关联一组 bridge，用户只能访问其 token 对应的 bridge
- 全局拦截：所有 HTTP API 和 WebSocket 连接都需要有效 token

## 方案选型

**Token 直传方案**：前端每次请求通过 HTTP Header 或 WebSocket query 直接传递原始 token，服务端查找匹配的配置项确定权限。无状态，实现简单，与现有架构一脉相承。配合 HTTPS 部署保障传输安全。

## 配置模型

### config.json 结构

在 `cc-pet.config.json` 中新增 `tokens` 字段：

```json
{
  "bridges": [
    { "id": "bridge-a", "name": "生产环境", "host": "10.0.1.1", "port": 9810, "token": "xxx", "enabled": true },
    { "id": "bridge-b", "name": "测试环境", "host": "10.0.1.2", "port": 9810, "token": "yyy", "enabled": true }
  ],
  "tokens": [
    {
      "token": "sk-alice-xxxxxx",
      "name": "Alice",
      "bridgeIds": ["bridge-a", "bridge-b"]
    },
    {
      "token": "sk-bob-yyyyyy",
      "name": "Bob",
      "bridgeIds": ["bridge-a"]
    }
  ]
}
```

### 类型定义（shared 包）

```typescript
interface TokenConfig {
  token: string;
  name: string;
  bridgeIds: string[];
}
```

`AppConfig` 新增 `tokens: TokenConfig[]` 字段。

### 环境变量支持

新增 `CC_PET_TOKENS` 环境变量，格式：`token1:bridge-a,bridge-b;token2:bridge-c`。用于 Docker 部署场景，优先级高于配置文件中的 `tokens`。

### 启动校验

- `tokens` 数组不能为空，否则服务端拒绝启动并打印错误日志
- `bridgeIds` 中引用的 bridge ID 必须在 `bridges` 中存在，不存在的打印警告日志（不阻止启动）

### 与 CC_PET_SECRET 的关系

`CC_PET_SECRET` 废弃，由 `tokens` 机制完全替代。迁移期间如果只设了 `CC_PET_SECRET` 没设 `tokens`，启动时打印迁移提示日志并拒绝启动。

## 服务端认证

### HTTP 认证中间件

文件：`packages/server/src/middleware/auth.ts`

Fastify 全局 `onRequest` 钩子：
1. 豁免静态资源路径（`/`、`/assets/*`、`/favicon.ico`）和认证接口（`/api/auth/verify`）
2. 从 `Authorization: Bearer <token>` 头中提取 token
3. 在 `tokens` 配置中查找匹配项
4. 匹配成功：将 `tokenConfig`（name、bridgeIds）挂到 `request` 对象上
5. 匹配失败：返回 `401 Unauthorized`

### WebSocket 认证

Dashboard WebSocket（`/ws`）认证：
1. 从 URL query `?token=xxx` 提取 token
2. 在 `tokens` 配置中查找
3. 匹配成功：记录该连接关联的 `bridgeIds`
4. 匹配失败：`close(4001, "Unauthorized")`

### Bridge 消息过滤

`ClientHub` 为每个 WebSocket 连接维护 `bridgeIds`：
- **下行过滤**：`broadcast` 时只推送给有权限的客户端（消息中的 `bridgeId` 与客户端 `bridgeIds` 做交集）
- **上行过滤**：客户端发消息指定目标 bridge 时，校验是否在其 `bridgeIds` 中，不在则忽略并返回错误事件
- **BRIDGE_MANIFEST 过滤**：只下发该 token 有权限的 bridge 信息

### 认证验证接口

`POST /api/auth/verify`（豁免认证中间件）：
- 请求体：`{ "token": "sk-xxx" }`
- 成功：`200 { valid: true, name: "Alice", bridgeIds: ["bridge-a", "bridge-b"] }`
- 失败：`401 { valid: false, error: "Invalid token" }`

## 前端改动

### 登录闸门页

文件：`packages/web/src/components/LoginGate.tsx`

- 全屏居中的 token 输入界面，输入框 + "进入"按钮
- 输入 token 后调用 `POST /api/auth/verify` 验证
- 验证通过：token 存入 `localStorage`（key: `cc-pet-token`），进入主界面
- 验证失败：显示错误提示

### Auth Store

文件：`packages/web/src/stores/auth.ts`（Zustand）

状态：
- `token: string | null`
- `name: string | null`
- `bridgeIds: string[]`

方法：
- `login(token: string)` — 调 verify 接口，成功后更新状态并存 localStorage
- `logout()` — 清除 localStorage、断开 WebSocket、重置状态
- `isAuthenticated()` — 返回是否已认证

### App 入口改造

`App.tsx` 启动流程：
1. 检查 localStorage 中是否有 `cc-pet-token`
2. 有 → 调 `/api/auth/verify` 验证 → 有效则渲染主界面，无效则清除 token 显示 LoginGate
3. 无 → 显示 LoginGate

### WebAdapter 改造

`createWebAdapter` 接受 token 参数：
- HTTP 请求：所有 `fetch` 调用自动加 `Authorization: Bearer <token>` 头
- WebSocket：连接 URL 变为 `${wsBase}/ws?token=${token}`

## 安全加固

### Token 比较安全

所有 token 比较使用 `crypto.timingSafeEqual` 进行常量时间比较，防止时序攻击。

### 防暴力破解

文件：`packages/server/src/middleware/rate-limit.ts`

- 同一 IP 在 1 分钟内认证失败超过 5 次，锁定该 IP 5 分钟
- 内存 `Map<ip, { count, lastAttempt }>` 实现，不依赖外部存储
- 作用于 `/api/auth/verify` 接口和所有认证失败的请求

### 日志审计

- 认证成功/失败都记录日志（包含 IP、token name，不记录 token 原文）
- Bridge 消息的上行越权尝试记录警告日志

### CORS 收紧

将 `cors({ origin: true })` 改为可配置白名单。`cc-pet.config.json` 新增：

```json
{
  "corsOrigins": ["http://localhost:1420"]
}
```

不配置时默认只允许同源请求。

## 改动文件总览

| 包 | 文件 | 改动类型 |
|---|---|---|
| shared | `types/config.ts` | 新增 `TokenConfig` 类型，`AppConfig` 加 `tokens` 字段 |
| server | `middleware/auth.ts` | 新建，HTTP 认证中间件 |
| server | `middleware/rate-limit.ts` | 新建，速率限制 |
| server | `storage/config.ts` | 解析 `tokens` 配置 + `CC_PET_TOKENS` 环境变量 |
| server | `ws/hub.ts` | token 校验 + 按 bridgeIds 过滤消息 |
| server | `index.ts` | 注册中间件、移除旧 `CC_PET_SECRET`、新增 `/api/auth/verify` |
| server | `api/config.ts` | CORS 配置项支持 |
| web | `components/LoginGate.tsx` | 新建，登录闸门页 |
| web | `stores/auth.ts` | 新建，认证状态管理 |
| web | `lib/web-adapter.ts` | 接受 token 参数，请求自动带 Authorization |
| web | `App.tsx` | 入口增加认证判断 |

## 测试

### 现有测试更新

- `e2e-connect-regression.test.ts`：所有用例配置 token，请求/连接时携带 token
- `App.integration.test.tsx`：新增 LoginGate 渲染、token 验证流程、无 token 拦截测试

### 新增测试

- `packages/server/tests/auth.test.ts`：认证中间件（有效/无效/无 token、速率限制）
- `packages/server/tests/bridge-filter.test.ts`：消息过滤（只收到有权限的 bridge 消息、越权发送被拒绝）
