# Token 认证与多 Bridge 授权 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以预共享 token 实现全局认证，并基于 token 将用户访问范围限制到指定 bridge。

**Architecture:** 在 server 侧新增统一 token 校验与请求身份上下文，HTTP 与 WebSocket 共用同一份鉴权结果；在 web 侧增加登录闸门并将 token 注入 HTTP/WS 通道。桥接事件与用户上行消息按 `connectionId` 做授权过滤。

**Tech Stack:** Fastify, ws, React, Zustand, Vitest

---

### Task 1: Shared 配置类型扩展

**Files:**
- Modify: `packages/shared/src/types/config.ts`

- [ ] 新增 `TokenConfig` 与 `CorsConfig`，并扩展 `AppConfig`
- [ ] 保持向后兼容默认值（tokens/corsOrigins 可选或有默认）

### Task 2: Server 鉴权基础设施

**Files:**
- Create: `packages/server/src/auth/token-auth.ts`
- Create: `packages/server/src/middleware/auth.ts`
- Modify: `packages/server/src/storage/config.ts`

- [ ] 实现 token 常量时间比较与 header/query 抽取
- [ ] 为 `ConfigStore` 增加 tokens/corsOrigins 读取、环境变量覆盖与校验
- [ ] 新增 HTTP 鉴权中间件并对白名单路径放行（`/api/auth/verify` 与静态资源）

### Task 3: WebSocket 客户端授权与桥接过滤

**Files:**
- Modify: `packages/server/src/ws/hub.ts`
- Modify: `packages/server/src/index.ts`

- [ ] WS 握手阶段校验 query token，绑定客户端可访问 bridge 集合
- [ ] `broadcast` 按 `connectionId` 做下行过滤
- [ ] dashboard 上行消息转发前做 bridge 权限校验并记录越权日志

### Task 4: 登录验证接口与安全加固

**Files:**
- Modify: `packages/server/src/index.ts`

- [ ] 新增 `POST /api/auth/verify` 验证接口（不泄漏原始 token）
- [ ] 增加简单认证失败限流（按 IP 计数、窗口与锁定）
- [ ] 启动时在无 token 配置下拒绝启动

### Task 5: Web 登录闸门与 token 注入

**Files:**
- Create: `packages/web/src/components/LoginGate.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/lib/web-adapter.ts`

- [ ] 实现登录闸门：输入 token、校验、持久化、错误提示
- [ ] App 启动时恢复 token 并校验；未认证时仅渲染闸门
- [ ] WebAdapter 为 fetch 注入 `Authorization`，WS URL 追加 `token`

### Task 6: 测试更新

**Files:**
- Modify: `packages/server/tests/e2e-connect-regression.test.ts`
- Modify: `packages/web/src/App.integration.test.tsx`

- [ ] server e2e 全链路请求加认证头，WS 使用 token query
- [ ] web integration 增加登录流程断言并适配新 adapter 参数

### Task 7: 验证

**Files:**
- N/A

- [ ] 运行 `pnpm --filter @cc-pet/server test -- tests/e2e-connect-regression.test.ts`
- [ ] 运行 `pnpm --filter @cc-pet/web test -- src/App.integration.test.tsx`
- [ ] 运行 `pnpm test:e2e`
