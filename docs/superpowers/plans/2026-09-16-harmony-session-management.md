# 鸿蒙客户端会话管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把鸿蒙客户端从「只有连接」补齐为 `connection × session` 两层模型，会话可列、可切、可建、可删，历史跟随真实 session key 加载，并补上 web 侧三块 UI 不可见的正确性机制。

**Architecture:** 纯逻辑（入站路由解析）放 `logic/`，可观察状态放 `SessionStore`（`AppStorageV2.connect()`），REST 调用放 `gateway/SessionApi`，两个壳子（`SessionSheet` / `SessionSidebar`）共用 `SessionRow.ets` 的行逻辑。服务端零改动。

**Tech Stack:** ArkTS / ArkUI V2 (HarmonyOS NEXT, API 26)、hypium 单测、DevEco 命令行工具链

**Spec:** `docs/superpowers/specs/2026-09-16-harmony-session-management-design.md`

## Global Constraints

以下为**首发版本（2026-09-15）血的教训沉淀**，全部继续生效，每个任务的要求都隐含包含本节：

- **服务端零改动。** `packages/` 下除 `packages/server/tests/harmony-protocol-alignment.test.ts` 外一律不得修改。`git diff origin/main HEAD -- . ':!harmony'` 必须只含：`.gitignore`、`.github/workflows/ci.yml`、`docs/superpowers/**`、那一个对齐测试。
- **Store 单例必须通过 `AppStorageV2.connect()` 获取**，禁止 `static readonly instance = new XxxStore()` 裸单例——裸单例不会把组件注册为 ArkUI V2 观察者，组件会静默不重渲染。此规则曾花三轮假修复才立住。Gateway（不可观察）反之用 `static readonly instance`。
- **ArkTS 严格模式禁止一切索引访问**：`obj['field']`（`arkts-no-props-by-index`）、`SomeInterface['field']` 作为类型（`arkts-no-aliases-by-index`）、`Record<string, Object>` 承接对象字面量。一律用显式声明字段的 interface + 属性访问。
- **WS 线格式是扁平的**：服务端发 `JSON.stringify({type, ...payload})`，不是 `{type, payload:{}}`。曾有 6 个单测带着相反假设全绿通过。
- **REST 路径不得硬编码**，全部从 `model/Endpoints.ets` 取。声明了的端点必须有调用者（对齐守卫会失败）。
- **分清「渲染依赖」和「副作用」**：读 `@Trace` 字段自动收集渲染依赖；`@Monitor` 只做副作用；**轮询是缺陷**，不是变通。Gateway 要通知 UI 时用 `ConnectionStore` 上的 `@Trace` 修订计数器。
- **构建 HAP 绝对不要加 `--no-daemon`**——会静默产出未签名、装不上的包。
- **`BUILD SUCCESSFUL` 不代表测试通过**，必须读 `entry/.test/default/intermediates/test/coverage_data/test_result.txt` 里的 `Pass: N`。
- **探针输入不要用 `uitest uiInput inputText`**——它会前置一个空格。用 `scripts/lib/common.sh` 的 `ui_type_at`（已改为 `uiInput text`）。
- **不得报告没有亲眼看过的验证。** 本项目曾因此损失两轮返工。
- 单测命令与构建/安装命令见 `harmony/README.md`。

---

### Task 1: 入站会话路由（纯函数 TDD）

镜像 `packages/web/src/lib/sessionRouting.ts`。这是本计划的正确性核心：决定一条不带 `sessionKey` 的回复落到哪个会话。鸿蒙端目前完全没有——`chatKeyOf()` 在 `sessionKey` 缺失时返回空串。

**Files:**
- Create: `harmony/entry/src/main/ets/logic/sessionRouting.ets`
- Create: `harmony/entry/src/test/SessionRouting.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type SessionRouteSource = 'payload' | 'reply_ctx' | 'active' | 'known' | 'fallback'`
  - `interface SessionRouteDecision { sessionKey: string; source: SessionRouteSource }`
  - `interface SessionRouteInput { payloadSessionKey?: string; replyCtx?: string; knownSessions: string[]; activeSessionKey?: string; fallbackSessionKey?: string }`
  - `sessionFromReplyCtx(replyCtx?: string): string | null`
  - `resolveIncomingSessionRouting(input: SessionRouteInput): SessionRouteDecision`

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/SessionRouting.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import {
  sessionFromReplyCtx, resolveIncomingSessionRouting,
  SessionRouteInput, SessionRouteDecision,
} from '../main/ets/logic/sessionRouting';

function input(
  payloadSessionKey?: string, replyCtx?: string,
  knownSessions: string[] = [], activeSessionKey?: string,
): SessionRouteInput {
  return {
    payloadSessionKey: payloadSessionKey,
    replyCtx: replyCtx,
    knownSessions: knownSessions,
    activeSessionKey: activeSessionKey,
  };
}

export default function sessionRoutingTest() {
  describe('sessionFromReplyCtx', () => {
    it('returns null for undefined or empty', 0, () => {
      expect(sessionFromReplyCtx(undefined)).assertNull();
      expect(sessionFromReplyCtx('')).assertNull();
    });

    it('requires the ccpet: prefix', 0, () => {
      expect(sessionFromReplyCtx('other:s1:123')).assertNull();
    });

    it('takes everything before the LAST colon', 0, () => {
      expect(sessionFromReplyCtx('ccpet:s1:123')).assertEqual('s1');
      // A session key containing a colon must survive — this is why the
      // parser uses lastIndexOf, not indexOf.
      expect(sessionFromReplyCtx('ccpet:a:b:123')).assertEqual('a:b');
    });

    it('returns null when there is no trailing colon segment', 0, () => {
      expect(sessionFromReplyCtx('ccpet:s1')).assertNull();
    });
  });

  describe('resolveIncomingSessionRouting', () => {
    it('prefers the payload session key', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input('s1', 'ccpet:s2:9', ['s1', 's2'], 's3'));
      expect(out.sessionKey).assertEqual('s1');
      expect(out.source).assertEqual('payload');
    });

    it('trims the payload key and ignores a blank one', 0, () => {
      expect(resolveIncomingSessionRouting(input('  s1  ')).sessionKey).assertEqual('s1');
      expect(resolveIncomingSessionRouting(input('   ', undefined, [], 'act')).source).assertEqual('active');
    });

    it('falls to replyCtx when the payload has no key', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:s2:9', ['s1', 's2'], 's3'));
      expect(out.sessionKey).assertEqual('s2');
      expect(out.source).assertEqual('reply_ctx');
    });

    it('accepts a replyCtx key when no sessions are known yet', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:s9:1', [], undefined));
      expect(out.sessionKey).assertEqual('s9');
      expect(out.source).assertEqual('reply_ctx');
    });

    it('rejects a replyCtx key that is not among known sessions', 0, () => {
      const out: SessionRouteDecision =
        resolveIncomingSessionRouting(input(undefined, 'ccpet:ghost:1', ['s1'], 's1'));
      expect(out.sessionKey).assertEqual('s1');
      expect(out.source).assertEqual('active');
    });

    it('uses the active session next', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input(undefined, undefined, ['s1'], 's1'));
      expect(out.source).assertEqual('active');
    });

    it('uses the first known session when nothing is active', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input(undefined, undefined, ['s7', 's8']));
      expect(out.sessionKey).assertEqual('s7');
      expect(out.source).assertEqual('known');
    });

    it('falls back to default last', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting(input());
      expect(out.sessionKey).assertEqual('default');
      expect(out.source).assertEqual('fallback');
    });

    it('honours an explicit fallback key', 0, () => {
      const out: SessionRouteDecision = resolveIncomingSessionRouting({
        knownSessions: [], fallbackSessionKey: 'custom',
      });
      expect(out.sessionKey).assertEqual('custom');
      expect(out.source).assertEqual('fallback');
    });
  });
}
```

在 `List.test.ets` 追加 `import sessionRoutingTest from './SessionRouting.test';` 与 `sessionRoutingTest();`。

- [ ] **Step 2: 跑测试确认失败**

Run: `harmony/README.md` 记录的单测命令
Expected: FAIL，找不到模块 `../main/ets/logic/sessionRouting`

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/sessionRouting.ets`：

```typescript
/**
 * Decides which session an inbound WS frame belongs to.
 *
 * Mirrors `packages/web/src/lib/sessionRouting.ts` branch for branch. The
 * priority order is load-bearing: a reply that arrives without a
 * `sessionKey` must land in the session that ASKED, not in whichever
 * session the user has since switched to. Get this wrong and a late reply
 * leaks into a freshly-created conversation, which reads to the user as
 * "my message went to the wrong chat".
 *
 * Pure: no store access, no clock. Every branch is unit-tested.
 */
export type SessionRouteSource = 'payload' | 'reply_ctx' | 'active' | 'known' | 'fallback';

export interface SessionRouteDecision {
  sessionKey: string;
  source: SessionRouteSource;
}

export interface SessionRouteInput {
  payloadSessionKey?: string;
  /** The server's opaque reply context, `ccpet:<sessionKey>:<turnId>`. */
  replyCtx?: string;
  knownSessions: string[];
  activeSessionKey?: string;
  fallbackSessionKey?: string;
}

/**
 * `ccpet:<sessionKey>:<turnId>` → `<sessionKey>`.
 *
 * Splits on the LAST colon, not the first: a session key may itself contain
 * a colon, and the trailing turn id never does.
 */
export function sessionFromReplyCtx(replyCtx?: string): string | null {
  if (replyCtx === undefined || replyCtx.length === 0) {
    return null;
  }
  const prefix: string = 'ccpet:';
  if (!replyCtx.startsWith(prefix)) {
    return null;
  }
  const body: string = replyCtx.substring(prefix.length);
  const idx: number = body.lastIndexOf(':');
  if (idx <= 0) {
    return null;
  }
  return body.substring(0, idx);
}

export function resolveIncomingSessionRouting(input: SessionRouteInput): SessionRouteDecision {
  const fallback: string = input.fallbackSessionKey ?? 'default';

  const fromPayload: string = (input.payloadSessionKey ?? '').trim();
  if (fromPayload.length > 0) {
    return { sessionKey: fromPayload, source: 'payload' };
  }

  const fromReplyCtx: string | null = sessionFromReplyCtx(input.replyCtx);
  if (fromReplyCtx !== null) {
    // An unknown key from replyCtx is not trusted once we know the real
    // session list — it would invent a chat that does not exist.
    if (input.knownSessions.length === 0 || input.knownSessions.includes(fromReplyCtx)) {
      return { sessionKey: fromReplyCtx, source: 'reply_ctx' };
    }
  }

  const active: string = input.activeSessionKey ?? '';
  if (active.length > 0) {
    return { sessionKey: active, source: 'active' };
  }

  if (input.knownSessions.length > 0) {
    return { sessionKey: input.knownSessions[0], source: 'known' };
  }

  return { sessionKey: fallback, source: 'fallback' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Expected: 全部 PASS（新增 12 个用例）

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/sessionRouting.ets harmony/entry/src/test
git commit -m "feat(harmony): resolve which session an inbound frame belongs to"
```

---

### Task 2: SessionStore 两层模型

`currentChatKey` 从写死 `${bridgeId}::default` 改为跟随 `activeSessionKey`。**这一处改动同时修掉真机上的两个症状**（会话列表无数据、历史拉不到）。

**Files:**
- Modify: `harmony/entry/src/main/ets/store/SessionStore.ets`
- Create: `harmony/entry/src/test/SessionStoreModel.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: `resolveIncomingSessionRouting`（Task 1）、`chatKeyOf` / `splitChatKey` / `DEFAULT_SESSION_KEY`（`logic/normalizeEvent.ets`，已存在）
- Produces（`SessionStore` 新增公开方法，后续任务全部依赖本块）：
  - `sessionsOf(connectionId: string): Session[]` —— 该连接下的会话，已按最后活跃倒序
  - `knownSessionKeysOf(connectionId: string): string[]`
  - `activeSessionKeyOf(connectionId: string): string`
  - `activeConnectionId(): string`
  - `setActiveSession(connectionId: string, sessionKey: string): void`
  - `setActiveConnection(connectionId: string): void`
  - `stickySessionOf(connectionId: string): string`
  - `noteStickySession(connectionId: string, sessionKey: string): void`
  - `clearStickySession(connectionId: string): void`
  - `residentSession(): Session | undefined` —— 跨连接找唯一常驻会话
  - `upsertSession(session: Session): void`
  - `removeSession(connectionId: string, sessionKey: string): void`

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/SessionStoreModel.test.ets`。**注意**：`SessionStore` 必须通过 `SessionStore.connect()` 获取；每个用例开头调用 `store.clearAll()` 保证隔离。

```typescript
import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { SessionStore } from '../main/ets/store/SessionStore';
import { Session } from '../main/ets/model/Protocol';

function session(connectionId: string, key: string, lastActiveAt: number, resident?: boolean): Session {
  return {
    key: key, connectionId: connectionId, createdAt: 1000,
    lastActiveAt: lastActiveAt, isResident: resident,
  };
}

export default function sessionStoreModelTest() {
  describe('SessionStore two-level model', () => {
    beforeEach(() => { SessionStore.connect().clearAll(); });

    it('lists a connection sessions newest-active first', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 300), session('c1', 'c', 200)]);
      const keys: string[] = store.sessionsOf('c1').map((s: Session) => s.key);
      expect(keys.join(',')).assertEqual('b,c,a');
    });

    it('keeps connections separate', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c2', 'z', 100)]);
      expect(store.sessionsOf('c1').length).assertEqual(1);
      expect(store.sessionsOf('c2').length).assertEqual(1);
      expect(store.sessionsOf('c3').length).assertEqual(0);
    });

    it('defaults the active session key to default', 0, () => {
      expect(SessionStore.connect().activeSessionKeyOf('c1')).assertEqual('default');
    });

    it('derives currentChatKey from the active connection and session', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 's1', 100)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 's1');
      expect(store.currentChatKey).assertEqual('c1::s1');
    });

    it('remembers a per-connection active session across connection switches', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 's1', 100), session('c2', 's2', 100)]);
      store.setActiveSession('c1', 's1');
      store.setActiveSession('c2', 's2');
      store.setActiveConnection('c1');
      expect(store.currentChatKey).assertEqual('c1::s1');
      store.setActiveConnection('c2');
      expect(store.currentChatKey).assertEqual('c2::s2');
    });

    it('exposes known session keys for routing', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 300)]);
      expect(store.knownSessionKeysOf('c1').join(',')).assertEqual('b,a');
    });

    it('tracks a sticky session per connection', 0, () => {
      const store: SessionStore = SessionStore.connect();
      expect(store.stickySessionOf('c1')).assertEqual('');
      store.noteStickySession('c1', 's1');
      expect(store.stickySessionOf('c1')).assertEqual('s1');
      store.clearStickySession('c1');
      expect(store.stickySessionOf('c1')).assertEqual('');
    });

    it('finds the resident session across connections', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c2', 'r', 100, true)]);
      const resident: Session | undefined = store.residentSession();
      expect(resident !== undefined).assertTrue();
      expect(`${resident?.connectionId}::${resident?.key}`).assertEqual('c2::r');
    });

    it('upserts a new session into its connection list', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100)]);
      store.upsertSession(session('c1', 'new', 999));
      expect(store.sessionsOf('c1').length).assertEqual(2);
      expect(store.sessionsOf('c1')[0].key).assertEqual('new');
    });

    it('removes a session and clears its sticky pointer', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 200)]);
      store.noteStickySession('c1', 'b');
      store.removeSession('c1', 'b');
      expect(store.sessionsOf('c1').length).assertEqual(1);
      expect(store.stickySessionOf('c1')).assertEqual('');
    });

    it('falls the active session back to default when the active one is removed', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 200)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 'b');
      store.removeSession('c1', 'b');
      expect(store.activeSessionKeyOf('c1')).assertEqual('a');
      expect(store.currentChatKey).assertEqual('c1::a');
    });
  });
}
```

在 `List.test.ets` 追加导入与调用。

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL，`sessionsOf` 等方法不存在

- [ ] **Step 3: 实现**

改造 `SessionStore.ets`。要点（**保留所有既有注释**，它们记录了付出过代价的事实）：

1. `@Trace private sessions: Map<string, Session>`（chatKey → Session）**保留**，`labelOf` / `applySessions` 继续依赖它。**新增** `@Trace private sessionsByConnection: Map<string, Session[]>`，在 `applySessions` / `upsertSession` / `removeSession` 里与前者同步维护。
2. 新增 `@Trace private activeSessionKeys: Map<string, string>`、`@Trace private stickySessions: Map<string, string>`、`@Trace private activeConnection: string = ''`。
3. `currentChatKey` 改为**方法推导 + 显式重算**：保留 `@Trace currentChatKey` 字段（大量组件已依赖它作为渲染依赖），但由 `setActiveConnection` / `setActiveSession` / `removeSession` 统一调用私有 `recomputeCurrentChatKey()` 写入。**不要**改成 getter——ArkUI V2 的渲染依赖收集依赖字段读取。
4. `setCurrent(chatKey)` 保留（既有调用方多），内部改为拆解 chatKey 后转调 `setActiveConnection` + `setActiveSession`，保证两条路径写入同一份状态。
5. `sessionsOf` 按 `lastActiveAt` 倒序；相同则按 `createdAt` 倒序，再相同保持插入序。
6. `removeSession`：从两个 Map 移除、清 unread、清 sticky（若指向被删会话）、若被删的是该连接的 active 则回退到列表首个会话（无则 `'default'`）。
7. `clearAll()` 必须一并清空三个新 Map 与 `activeConnection`。

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/store/SessionStore.ets harmony/entry/src/test
git commit -m "feat(harmony): model sessions per connection, not one chat per bridge"
```

---

### Task 3: activeSessionKey 与 sticky 的持久化

web 用 localStorage 持久化这两张表（重载后仍在）。鸿蒙端走首发版本已有的 preferences 通道（参考 `AuthStore.init/save` 的写法）。**不持久化的后果**：冷启动后一条迟到的无 key 回复会错投。

**Files:**
- Modify: `harmony/entry/src/main/ets/store/SessionStore.ets`
- Create: `harmony/entry/src/main/ets/logic/sessionMaps.ets`（序列化纯函数）
- Create: `harmony/entry/src/test/SessionMaps.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Produces: `serializeStringMap(map: Map<string,string>): string`、`deserializeStringMap(text: string): Map<string,string>`；`SessionStore.initPersistence(context)` / 内部 `persist()`

- [ ] **Step 1: 写失败测试**（序列化纯函数）

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { serializeStringMap, deserializeStringMap } from '../main/ets/logic/sessionMaps';

export default function sessionMapsTest() {
  describe('session map persistence', () => {
    it('round-trips a map', 0, () => {
      const m: Map<string, string> = new Map<string, string>();
      m.set('c1', 's1');
      m.set('c2', 's2');
      const back: Map<string, string> = deserializeStringMap(serializeStringMap(m));
      expect(back.get('c1')).assertEqual('s1');
      expect(back.get('c2')).assertEqual('s2');
      expect(back.size).assertEqual(2);
    });

    it('survives an empty map', 0, () => {
      expect(deserializeStringMap(serializeStringMap(new Map<string, string>())).size).assertEqual(0);
    });

    it('returns an empty map for garbage rather than throwing', 0, () => {
      expect(deserializeStringMap('not json').size).assertEqual(0);
      expect(deserializeStringMap('').size).assertEqual(0);
      expect(deserializeStringMap('[1,2,3]').size).assertEqual(0);
    });

    it('drops non-string values instead of importing them', 0, () => {
      expect(deserializeStringMap('{"c1":"s1","c2":5}').get('c1')).assertEqual('s1');
      expect(deserializeStringMap('{"c1":"s1","c2":5}').size).assertEqual(1);
    });
  });
}
```

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`logic/sessionMaps.ets`：用 `JSON.stringify` 写出普通对象，读回时**逐 key 校验值为 string 才纳入**。
注意 ArkTS 禁止索引访问——读回时用 `Object.keys(obj)` 配合 `obj[k]` **不可行**；改用 `JSON.parse` 后经由一次 `Map` 构造的安全写法：将解析结果先 `as object`，再用 `util` 或显式 interface。**若确认无合法索引写法，改用 `k=v` 的行分隔文本格式**（`key\tvalue\n`），同样满足往返与容错要求，测试不变。实现者自行探针验证后择一，并在注释里记录选择理由。

`SessionStore` 在 `applySessions` / `setActiveSession` / `noteStickySession` / `clearStickySession` / `removeSession` 后调用 `persist()`；`initPersistence(context)` 在启动时读回。**`clearAll()`（登出）必须同时清掉持久化内容**，否则账号 A 的会话指针会带进账号 B。

- [ ] **Step 4: 确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(harmony): persist the active and sticky session pointers"
```

---

### Task 4: 端点与 RestClient DELETE

**Files:**
- Modify: `harmony/entry/src/main/ets/model/Endpoints.ets`
- Modify: `harmony/entry/src/main/ets/gateway/RestClient.ets`
- Modify: `packages/server/tests/harmony-protocol-alignment.test.ts`（唯一允许改动的 `packages/` 文件）

**Interfaces:**
- Produces：`Endpoints.SESSION_CREATE` / `SESSION_DELETE` / `SESSION_READ`；`sessionDeleteUrl(connectionId, key)`、`sessionReadUrl(connectionId, key)`；`RestClient.deleteJson(path): Promise<string>`

- [ ] **Step 1: 加端点声明**

```typescript
  static readonly SESSION_CREATE: Endpoint = { method: 'POST', path: '/api/sessions' };
  static readonly SESSION_DELETE: Endpoint = { method: 'DELETE', path: '/api/sessions/:connectionId/:key' };
  static readonly SESSION_READ: Endpoint = { method: 'POST', path: '/api/sessions/:connectionId/:key/read' };
```

URL 构造器：

```typescript
export function sessionDeleteUrl(connectionId: string, key: string): string {
  return `/api/sessions/${encodeURIComponent(connectionId)}/${encodeURIComponent(key)}`;
}

export function sessionReadUrl(connectionId: string, key: string): string {
  return `${sessionDeleteUrl(connectionId, key)}/read`;
}
```

- [ ] **Step 2: RestClient 加 DELETE**

照 `postJson` 的写法加 `deleteJson(path)`，沿用同样的 `connectTimeout: 10000` / `readTimeout: 30000` 与 401 → `UnauthorizedError` 处理。

- [ ] **Step 3: 守卫必须认得 DELETE**

对齐测试里 `registeredRoutes()` 的正则已包含 `delete`，确认无需改动即可匹配 `app.delete<{...}>("/api/sessions/:connectionId/:key")`。**若不匹配则修正正则**。

- [ ] **Step 4: 观察守卫会响——两种错法都要试**

1. 把 `SESSION_DELETE` 的 method 改成 `'POST'` → **必须失败**
2. 改回，把 path 改成 `/api/sessions/:connectionId/:keyx` → **必须失败**
3. 全部改回 → 通过

**把两次失败的输出记进报告。没观察到失败的守卫等于没有守卫。**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(harmony): declare the session create/delete/read endpoints"
```

---

### Task 5: SessionApi 扩展

**Files:**
- Modify: `harmony/entry/src/main/ets/gateway/SessionApi.ets`

**Interfaces:**
- Consumes: Task 4 的端点与 `deleteJson`
- Produces：`create(connectionId: string, key: string): Promise<void>`、`remove(connectionId: string, key: string): Promise<void>`、`markRead(connectionId: string, key: string): Promise<void>`

- [ ] **Step 1: 实现三个方法**

`create` 的 body 为 `JSON.stringify({connectionId, key})`（服务端 `label` 可选，不传）。
`remove` 对 403 要单独处理：服务端对常驻会话返回 403，UI 不该显示删除入口，但**兜底必须把 403 当作「预期内拒绝」记日志，而不是当作网络错误弹横幅**。
沿用既有的 `UnauthorizedError` 401 处理姿势。

- [ ] **Step 2: 提交**

```bash
git commit -m "feat(harmony): create, delete and mark-read sessions over REST"
```

---

### Task 6: 把路由接进 dispatch

**Files:**
- Modify: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Modify: `harmony/entry/src/main/ets/logic/normalizeEvent.ets`（`WsFrame` 增加 `replyCtx?: string` 与 `reply_ctx?: string`）
- Modify: `harmony/entry/src/main/ets/model/Protocol.ets`（路由事件集合常量）
- Create: `harmony/entry/src/test/RoutingEventSet.test.ets`

**Interfaces:**
- Consumes: Task 1 的 `resolveIncomingSessionRouting`、Task 2 的 store 方法
- Produces: `ROUTED_EVENT_TYPES: string[]`（11 项）

- [ ] **Step 1: 声明路由事件集合**

在 `Protocol.ets` 中声明，**11 项，逐一对照 `packages/shared/src/constants/events.ts`**：

```
bridge:message, bridge:stream-delta, bridge:stream-done, bridge:buttons,
bridge:file-received, bridge:typing-start, bridge:typing-stop,
bridge:preview-start, bridge:preview-update, bridge:preview-delete, bridge:error
```

**注意：`bridge:audio` 与 `bridge:card` 同样携带内容，但不在 web 的集合内。照 web 现状执行，不擅自扩大**；在常量旁写注释记录这一差异与原因（见 spec §4.3）。

- [ ] **Step 2: 写测试锁住集合**

断言集合恰好 11 项、且不含 `bridge:audio` / `bridge:card`——这条断言的作用是：将来有人扩大集合时必须显式改测试，从而被迫思考是否该同步上报给 web。

- [ ] **Step 3: 在 dispatch 里应用路由**

在 `ConnectionGateway.dispatch` 解析出 `connectionId` 之后、计算 chatKey 之前插入：

- 若事件类型在 `ROUTED_EVENT_TYPES` 内且 `connectionId` 非空：调用 `resolveIncomingSessionRouting`，入参取自 frame 与 `SessionStore`（`knownSessionKeysOf`、`activeSessionKeyOf`）
- `source` 为 `'payload'` / `'reply_ctx'` → `noteStickySession`
- `source` 为 `'active'` / `'known'` / `'fallback'` → 若 sticky 非空则用 sticky 覆盖
- 用最终 sessionKey 构造 chatKey，替代现有的 `chatKeyOf(connectionId, frame.sessionKey ?? '')`

**注释必须写清楚为什么**：「迟到的无 key 回复属于发起它的会话，不属于用户当前停留的会话」。

- [ ] **Step 4: 跑全量测试**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(harmony): route keyless frames to the session that asked"
```

---

### Task 7: SessionRow 从「按 bridge」改为「按 session」

**Files:**
- Modify: `harmony/entry/src/main/ets/components/SessionRow.ets`
- Modify: `harmony/entry/src/test/SessionRow.test.ets`

**Interfaces:**
- Produces（供两个壳子共用）：
  - `chatKeyForSession(session: Session): string`
  - `labelForSession(store: SessionStore, session: Session): string`
  - `isCurrentSession(store: SessionStore, session: Session): boolean`
  - `unreadForSession(store: SessionStore, session: Session): number`
  - `selectSession(store: SessionStore, session: Session): void`
  - `RECENT_VISIBLE: number = 2`
  - `visibleSessions(all: Session[], activeKey: string, showAll: boolean): Session[]` —— 纯函数，剔除 active 与常驻、按序截断
- 既有的 `*ForBridge` 系列**保留**（连接切换那一段仍需要），不要删。

- [ ] **Step 1: 写失败测试**（覆盖 `visibleSessions` 的纯逻辑：剔除 active、剔除常驻、`showAll=false` 时截断到 2、`showAll=true` 时全出）

- [ ] **Step 2: 确认失败**

- [ ] **Step 3: 实现**

`labelForSession` 的优先级：`session.label` → 自动命名（Task 9 写入的也是 `label`）→ `session.key`。

- [ ] **Step 4: 确认通过**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(harmony): make a row a session, not a bridge"
```

---

### Task 8: 两个壳子的新结构

照 web `SessionDropdown` 的结构，**不重新设计**。

**Files:**
- Modify: `harmony/entry/src/main/ets/components/SessionSheet.ets`
- Modify: `harmony/entry/src/main/ets/components/SessionSidebar.ets`

**Interfaces:**
- Consumes: Task 7 的全部导出、Task 5 的 `SessionApi`

自上而下的结构：

1. **常驻会话**（若存在）单独置顶，跨连接可达；点击 → `setActiveConnection` + `setActiveSession` + `clearUnread` + `SessionApi.markRead`
2. **当前连接的会话列表**：先显示 active 行，再显示 `visibleSessions(...)`
3. 当 `inactive.length > RECENT_VISIBLE` 时显示「显示全部（N）」/「收起」
4. **新建会话**入口
5. **其他连接**列表，点击只 `setActiveConnection`
6. **删除**：两段式——`@Local confirmDeleteKey: string = ''`；第一次点击置为该 key 并把按钮文案改为「确认删除」，第二次执行删除；切换会话、关闭面板、切连接时一律重置为 `''`。常驻会话不渲染删除入口。

**两个壳子必须共用 Task 7 的行逻辑**，不得各写一份——首发版本 Task 16 就是因为两个壳子漂移才抽出 `SessionRow.ets` 的。

- [ ] **Step 1..N**：按上述结构实现，构建通过后提交

```bash
git commit -m "feat(harmony): list, create and delete sessions in both shells"
```

---

### Task 9: 切换加载、新建清残留、自动命名

**Files:**
- Modify: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Modify: `harmony/entry/src/main/ets/store/ChatStore.ets`（若缺 `purgeChat`）
- Modify: `harmony/entry/src/main/ets/store/SessionStore.ets`（自动命名）
- Modify: `harmony/entry/src/main/ets/components/MessageInput.ets`（发送时触发自动命名）

三件事，对应 spec §1.1 的后两块与 §7：

1. **切换会话触发历史回填。** 首发版本的 `HistoryBackfill` 已支持按 chatKey 回填，本任务只是把触发点从「manifest 时的单一 chatKey」扩展到「每次会话切换」。在 `selectSession` 之后由壳子调用 `ConnectionGateway.instance.ensureHistory(chatKey)`（新增公开方法，**必须写回 Interfaces 契约**）。
2. **新建会话前清残留。** 新增 `resetSessionResidue(connectionId, key)`：清该 chatKey 的消息（`ChatStore.purgeChat`）、任务状态（`TaskStore`）、未读。新 key 服务端无历史，**不要**触发回填。
3. **自动命名。** 镜像 web 的 `touchSessionAutoTitle`：当会话尚无 `label` 且用户发出第一条消息时，用该消息文本裁剪后作为 label（取首行、上限约 20 字）。仅本地生效，**不要**为此新增服务端调用。

- [ ] **Step 1: 为自动命名的裁剪逻辑写纯函数 + 测试**（`logic/autoTitle.ets`：多行取首行、超长截断、空白输入返回空串不覆盖既有 label）
- [ ] **Step 2..4**：实现三件事，跑全量测试
- [ ] **Step 5: 提交**

```bash
git commit -m "feat(harmony): load on switch, clear residue on create, auto-title on first send"
```

---

### Task 10: 真机/模拟器验证与探针

**Files:**
- Create: `harmony/scripts/device-session-probe.sh`
- Modify: `harmony/README.md`（探针清单、能力说明）

**Interfaces:** 无

- [ ] **Step 1: 写探针**

照既有 `device-*-probe.sh` 的结构（自起自停真实 `packages/server` + bridge fixture，**绝不使用用户真实地址或 token**，仅模拟器 `127.0.0.1:5555`）。断言链：

1. 打开会话面板，看到该连接的会话行
2. 新建会话 → 新行出现且被选中，聊天区为空
3. 在新会话发一条消息 → 收到回复，且**回复落在新会话里**
4. 切回原会话 → 原会话历史被加载回来（这一条同时验证 spec §7 的按需加载）
5. 删除新会话 → 两段式确认后消失

- [ ] **Step 2: 负向对照**

**故意破坏一处让探针失败并观察**（例如临时让 `selectSession` 不触发 `ensureHistory`，确认第 4 条断言报错）。记进报告。**没观察到失败的探针不算探针。**

- [ ] **Step 3: 无 key 回复的真实验证**

spec §10 要求：无 `sessionKey` 的回复落入正确会话，**不接受仅单测通过**。用 bridge fixture 构造一条不带 `sessionKey` 的回复，在「用户已切换到另一个会话」之后投递，断言它落在发起它的会话而非当前会话。

- [ ] **Step 4: 更新 README**

探针数量、会话管理能力、以及本轮相对 web 仍存在的差异。

- [ ] **Step 5: 提交**

```bash
git commit -m "test(harmony): probe multi-session switching, creation and keyless routing"
```

---

## 自查

**Spec 覆盖：** §3 数据模型→T2/T3；§4 路由→T1/T6；§5 UI→T7/T8；§6 端点→T4/T5；§7 启动与加载→T9；§8 未读→T2（`applySessions` 既有逻辑保留）+T8；§10 验收→T10。

**类型一致性：** `Session` 沿用 `model/Protocol.ets` 既有定义，未新增字段；`SessionRouteDecision` 仅 T1 产出、T6 消费；`RECENT_VISIBLE` 仅 T7 声明、T8 消费。

**已知的实现期风险：** Task 3 的序列化写法受 ArkTS 索引访问限制影响，计划中已给出两条路径与择一标准，实现者需探针验证后在注释中记录选择理由。
