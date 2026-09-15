# cc-pet 鸿蒙原生客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 cc-pet 构建一个 HarmonyOS NEXT 原生 ArkTS 客户端，覆盖登录、会话、消息收发与流式渲染、markdown、宠物状态、断线重连、本地通知与 slash command。

**Architecture:** 三层单向依赖——Gateway（唯一碰网络）→ Store（状态）→ Components（只读 Store）。所有可测逻辑抽进 `logic/` 的纯函数，UI 层只做渲染。服务端零改动，复用现有 `/ws` 与 `/api/*`。

**Tech Stack:** ArkTS / ArkUI（HarmonyOS API 26）、`@kit.NetworkKit`（WebSocket + 网络状态）、`@kit.NotificationKit`、`@ohos/hypium`（单测）、hvigor（构建）。协议对齐测试跑在 Node 侧 vitest。

**Spec:** `docs/superpowers/specs/2026-09-15-harmony-client-design.md`

## Global Constraints

- 目标平台 HarmonyOS NEXT，`compatibleSdkVersion` / `targetSdkVersion` 均为 `26.0.0`，`runtimeOS: "HarmonyOS"`。
- bundleName：`com.ccpet.client`。`deviceTypes`: `["phone", "tablet", "2in1"]`。
- **服务端零改动。** 不修改 `packages/server` 与 `packages/web` 的任何运行时代码；唯一允许新增的 Node 侧文件是 Task 2 的协议对齐测试。
- **依赖规则（违反即不合入）**：Gateway 不引用任何 ArkUI 组件；Store 不发起网络请求；Components 不直接调用 Gateway 的网络方法，只读 Store 并调用 Store 暴露的意图方法。
- **ArkTS 严格模式禁止对 interface 做索引访问**（`arkts-no-props-by-index`），也不接受 `Record<string, Object>` 承接对象字面量。所有动态形状的数据必须声明为显式可选字段的 interface，用属性访问读取。同样地，**索引访问类型**（`SomeInterface['field']`）也被拒绝（`arkts-no-aliases-by-index`）——直接引用具名类型。已在本工程实测确认：`JSON.parse(text) as T`、`obj.field`、`field ?? ''`、`field === undefined` 均合法。
- ArkTS 严格类型：不使用 `any`，所有变量、参数、返回值显式标注类型，对象字面量必须有对应 `interface`（参照 `Tailscale-OHOS/entry/src/main/ets/services/NetworkSettingsGateway.ets` 的风格）。
- 鉴权：REST 用 `Authorization: Bearer <token>`，WS 用 `/ws?token=<token>` query。
- 重连退避：`min(30000, 1000 × 2ⁿ)` 毫秒。
- 发送可靠性常量：`ACK_TIMEOUT_MS = 15000`、`MANUAL_WINDOW_MS = 120000`，与 `packages/web/src/lib/store/outbox.ts` 保持一致。
- 代码基线：`origin/main` 的 `e525167`。协议含 `resident:unread` 与 `message-ack`；常驻会话未读以服务端为唯一真相。
- EXPANDED 断点下聊天内容最大宽度 1240vp；断点阈值 600 / 840 vp。
- `harmony/build-profile.json5` 含签名材料，必须 gitignore，仓库内只保留 `harmony/build-profile.example.json5`。
- 每个任务结束必须提交，提交信息使用仓库既有的 conventional commits 风格（`feat(harmony): ...` / `test(harmony): ...` / `chore(harmony): ...`）。
- **REST 路径不得硬编码**：Task 10B 之后，所有 gateway 从 `model/Endpoints.ets` 取端点与 URL 构造函数。服务端改了方法或路径，`pnpm test` 会红。
- **Store 单例必须通过 `AppStorageV2.connect()` 获取，禁止 `static readonly instance = new XxxStore()` 裸单例。** 这条规则替换了本文档更早版本里的「`@Local` 持有 `static readonly instance` 即可」的说法——那个说法**已被真机 + 模拟器实测证伪**：`@Local auth: AuthStore = AuthStore.instance` 编译通过、跑得起来，`save()` 也确实同步把 `authorized` 置为 `true` 并落盘，但同一个 `Index` 组件的 `build()` 就是不会因此重新渲染；用 `@Monitor('auth.authorized')` 挂了一个探针，登录成功后探针**从未触发**，实锤了这个持有方式根本没有把 `Index` 注册成 `AuthStore` 的 V2 观察者。这是本任务（reactivity-fix）第二次返工才发现的，前两次「修复」都是在真机上被打断验证、没跑完整个登录时序就报了完成。

  **正确写法**——store 类内部提供 `static connect()`，用 `AppStorageV2`（`@kit.ArkUI`）按 key 惰性创建/取回共享实例；所有消费方（包括发起 mutation 的组件）都必须经由 `connect()` 拿引用，不能有任何地方保留一份裸的 `static instance`：

  ```typescript
  // store/AuthStore.ets
  import { AppStorageV2 } from '@kit.ArkUI';

  @ObservedV2
  export class AuthStore {
    static connect(): AuthStore {
      const instance = AppStorageV2.connect(AuthStore, 'AuthStore', (): AuthStore => new AuthStore());
      if (instance === undefined) {
        throw new Error('AuthStore.connect(): AppStorageV2.connect returned undefined');
      }
      return instance;
    }
    @Trace authorized: boolean = false;
    // ...
  }

  // pages/Index.ets
  @ComponentV2
  struct SomePage {
    @Local auth: AuthStore = AuthStore.connect();   // 惰性 connect，V2 才能追踪
    build() {
      if (this.auth.authorized) { /* ... */ }       // 通过 this.auth 访问
    }
  }

  // components/LoginGate.ets — mutation 也要走 connect()，不能各写各的静态引用
  await AuthStore.connect().save(url, token);
  ```

  同理，组件间传递 store 用 `@Param`，不要各自去取静态实例。

  **⚠️ 适用范围说明**：上述证据只在 `AuthStore` + 单个消费组件（`Index`/`LoginGate`）这一对上
  实测过，`@Monitor` 探针从未失败到失败的机制也没有对照 ArkUI V2 官方内部实现做交叉验证——目前
  只是"换成 `AppStorageV2.connect()` 之后行为符合预期"这一层面的经验证据。**Task 11（第一个新
  store）的实现者必须在自己的 store 上重新跑一遍同样的 `@Monitor` 探针验证**，确认这个模式能
  迁移过去，而不是直接按类比假设成立；跑通后可以在后续任务里省略重复验证。

  详细复现证据、两次失败的修复尝试记录、以及排查过程见
  `.superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md`。
- **分清「渲染依赖」和「副作用」，不要用轮询代替任何一个。** ArkUI V2 里这是两套机制：

  - **渲染依赖是自动收集的**：组件在 `build()` 里读到的 `@Trace` 字段（含 `@Trace` 的 `Map`/`Set`/数组），变化时自动重渲染。**不需要 `@Monitor`，字段是 `private` 也不妨碍**——组件调的是 store 的公开方法（如 `phaseOf(chatKey)`、`unreadOf(chatKey)`），依赖由读取行为本身建立。`MessageList` 就是这样实时刷新消息的，全程没有 `@Monitor`。
  - **`@Monitor('store.field')` 是给副作用用的**：字段变化时要执行一段非渲染逻辑（启动网关、初始化会话）才用它。

  因此：**想让界面跟着 store 变，直接在 `build()` 里读，不要加定时器**。本工程唯一正当的轮询是 `MessageList` 对 Outbox 状态的轮询——`Outbox` 是 `logic/` 里的纯类、不是 `@Trace` 对象，UI 确实没有响应式渠道；除此之外出现 `setInterval` 都应视为缺陷。
- 工作分支：`harmony-client`。
- **真机构建与安装（已验证可用）**：

  ```bash
  export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
  export PATH="/Applications/DevEco-Studio.app/Contents/tools/node/bin:/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin:$PATH"
  cd /Users/StevenZhu/code/cc-pet-web/harmony
  node /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js assembleHap -p module=entry@default -p product=default
  export PATH="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains:$PATH"
  hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
  hdc shell aa start -a EntryAbility -b com.ccpet.client
  ```

  **构建 HAP 时绝对不要加 `--no-daemon`。** 签名密码在 `build-profile.json5` 里是 DevEco 加密存储的，只有 hvigor 的 daemon 进程能解密；加了 `--no-daemon` 会报 `Init keystore failed ... please input the correct plaintext password`，产物退化为 `entry-default-unsigned.hap`，装不上真机。跑单测则不受影响（单测不签名），可以加。
- `build-profile.json5` 的 `products[0]` 必须有 `"signingConfig": "default"` 引用，否则即使有 daemon 也只产出 unsigned 包。DevEco 自动生成签名时只写 `signingConfigs` 数组，不会补这个引用。

---

## File Structure

**鸿蒙工程（全部新建于 `harmony/`）**

| 文件 | 职责 |
|---|---|
| `harmony/AppScope/app.json5` | bundleName、应用名与图标 |
| `harmony/build-profile.json5` | 签名与产物配置（gitignore） |
| `harmony/build-profile.example.json5` | 供他人填写的签名模板 |
| `harmony/entry/src/main/module.json5` | 模块、Ability、权限声明 |
| `harmony/entry/src/main/ets/entryability/EntryAbility.ets` | 生命周期 → `gateway.setForeground()` |
| `harmony/entry/src/main/ets/model/Protocol.ets` | WS 事件名与消息类型，对齐 `packages/shared` |
| `harmony/entry/src/main/ets/model/Markdown.ets` | `MdNode` 类型定义 |
| `harmony/entry/src/main/ets/model/Endpoints.ets` | REST 端点集中声明，受契约守卫保护 |
| `harmony/entry/src/main/ets/logic/backoff.ets` | 重连退避计算 |
| `harmony/entry/src/main/ets/logic/normalizeEvent.ets` | WS 事件归一化 |
| `harmony/entry/src/main/ets/logic/derivePetState.ets` | 宠物状态派生 |
| `harmony/entry/src/main/ets/logic/parseMarkdown.ets` | markdown → `MdNode[]` |
| `harmony/entry/src/main/ets/logic/slashCommands.ets` | 命令合并 / 匹配 / 排序 |
| `harmony/entry/src/main/ets/logic/outbox.ets` | 发送可靠性：clientMsgId / ack 超时 / 重试策略 |
| `harmony/entry/src/main/ets/gateway/RestClient.ets` | Bearer 封装 + 401 统一处理 |
| `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets` | WS 单例、状态机、事件分发 |
| `harmony/entry/src/main/ets/gateway/NotificationGateway.ets` | 本地通知（接口化） |
| `harmony/entry/src/main/ets/gateway/PetImageCache.ets` | 宠物图拉取与沙箱缓存 |
| `harmony/entry/src/main/ets/store/*.ets` | `ConnectionStore` `SessionStore` `ChatStore` `TaskStore` |
| `harmony/entry/src/main/ets/components/*.ets` | UI 组件 |
| `harmony/entry/src/main/ets/pages/Index.ets` | 页面装配 |
| `harmony/entry/src/test/*.test.ets` | hypium 本地单测 |
| `harmony/scripts/*.sh` | 构建与真机探针（bash） |
| `harmony/README.md` | 环境变量、实际可用的单测/构建命令、签名配置步骤 |

**Node 侧（唯一新增）**

| 文件 | 职责 |
|---|---|
| `packages/server/tests/harmony-protocol-alignment.test.ts` | 比对 `Protocol.ets` 与 `packages/shared`，漂移即失败 |

---

### Task 1: 工程骨架与单测基础设施（命令行建工程）

打通「能构建」和「能跑单测」这两条命脉。后续所有任务都依赖本任务产出的命令。

**不用 DevEco GUI。** DevEco 自带的命令行工具链已验证可独立工作：node v24.14.1、ohpm 26.0.0.630、hvigor 6.26.4。工程骨架就是一组配置文件，`/Users/StevenZhu/code/Tailscale-OHOS` 是同 SDK 版本（API 26 / HarmonyOS）下的可用样本，照它的结构写即可。

**签名不在本任务范围**：它需要华为开发者账号登录，由人工在 DevEco 中补。本任务交付一个「能跑单测、结构正确、打开即可用」的工程，并把签名位置留成模板。

**Files:**
- Create: `harmony/AppScope/app.json5`、`harmony/AppScope/resources/base/element/string.json`、`harmony/AppScope/resources/base/media/app_icon.png`
- Create: `harmony/hvigorfile.ts`、`harmony/oh-package.json5`、`harmony/hvigor/hvigor-config.json5`
- Create: `harmony/build-profile.json5`、`harmony/build-profile.example.json5`
- Create: `harmony/entry/hvigorfile.ts`、`harmony/entry/oh-package.json5`、`harmony/entry/build-profile.json5`
- Create: `harmony/entry/src/main/module.json5`
- Create: `harmony/entry/src/main/ets/entryability/EntryAbility.ets`、`harmony/entry/src/main/ets/pages/Index.ets`
- Create: `harmony/entry/src/main/resources/`（base/element/string.json、base/element/color.json、base/media/、base/profile/main_pages.json、dark/element/、zh_CN/element/）
- Create: `harmony/entry/src/test/LocalUnit.test.ets`、`harmony/entry/src/test/List.test.ets`
- Create: `harmony/README.md`
- Modify: `.gitignore`（仓库根）

**Interfaces:**
- Consumes: 无
- Produces: 可复用的单测命令，记录在 `harmony/README.md`；后续任务一律引用此处命令。`Protocol.ets` 已由 Task 2 创建在 `harmony/entry/src/main/ets/model/`，不要覆盖它。

- [ ] **Step 1: 环境变量**

所有 hvigor / ohpm 命令都需要：

```bash
export DEVECO_SDK_HOME=/Applications/DevEco-Studio.app/Contents/sdk
export PATH="/Applications/DevEco-Studio.app/Contents/tools/node/bin:/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin:$PATH"
HVIGORW="node /Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw.js"
```

- [ ] **Step 2: 写工程级配置**

`harmony/AppScope/app.json5`：

```json5
{
  "app": {
    "bundleName": "com.ccpet.client",
    "vendor": "cc-pet",
    "versionCode": 1000000,
    "versionName": "0.1.0",
    "icon": "$media:app_icon",
    "label": "$string:app_name"
  }
}
```

`harmony/AppScope/resources/base/element/string.json` 提供 `app_name`，值为 `cc-pet`。
`harmony/AppScope/resources/base/media/app_icon.png`：从 `packages/web/src/assets/pet/idle.png` 复制（用产品自己的宠物形象，不要挪用 Tailscale 的图标）。

`harmony/hvigorfile.ts`：

```typescript
import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks,
  plugins: []
}
```

`harmony/hvigor/hvigor-config.json5`：

```json5
{
  "modelVersion": "5.0.0",
  "dependencies": {
    "@ohos/hvigor-ohos-plugin": "6.26.4"
  },
  "execution": {},
  "logging": {},
  "debugging": {},
  "nodeOptions": {}
}
```

`harmony/oh-package.json5`：

```json5
{
  "modelVersion": "5.0.0",
  "name": "cc-pet-harmony",
  "version": "0.1.0",
  "description": "Native HarmonyOS client for cc-pet",
  "main": "",
  "author": "cc-pet",
  "license": "MIT",
  "dependencies": {}
}
```

`harmony/build-profile.json5`（**不含签名**，签名由人工补）：

```json5
{
  "app": {
    "signingConfigs": [],
    "products": [
      {
        "name": "default",
        "compatibleSdkVersion": "26.0.0",
        "targetSdkVersion": "26.0.0",
        "runtimeOS": "HarmonyOS",
        "buildOption": {
          "strictMode": {
            "caseSensitiveCheck": true,
            "useNormalizedOHMUrl": true
          }
        }
      }
    ],
    "buildModeSet": [
      { "name": "debug" },
      { "name": "release" }
    ]
  },
  "modules": [
    {
      "name": "entry",
      "srcPath": "./entry"
    }
  ]
}
```

`harmony/build-profile.example.json5`：同上，但 `signingConfigs` 填一个 `material` 各字段为 `"<fill-me>"` 的 `default` 条目，并在文件顶部注释说明由 DevEco 的 `Project Structure → Signing Configs` 自动生成后替换。

- [ ] **Step 3: 写模块级配置**

`harmony/entry/hvigorfile.ts` 用 `hapTasks`（结构同工程级，把 `appTasks` 换成 `hapTasks`）。

`harmony/entry/oh-package.json5` 需要声明 hypium 测试依赖：

```json5
{
  "name": "entry",
  "version": "0.1.0",
  "description": "cc-pet HarmonyOS entry module",
  "main": "",
  "author": "cc-pet",
  "license": "MIT",
  "dependencies": {},
  "devDependencies": {
    "@ohos/hypium": "1.0.21"
  }
}
```

若 `ohpm install` 报该版本不存在，改用 ohpm 仓库中可用的最新 1.0.x，并在报告中写明你实际用的版本。

`harmony/entry/build-profile.json5`：

```json5
{
  "apiType": "stageMode",
  "buildOption": {},
  "buildOptionSet": [
    {
      "name": "release",
      "arkOptions": {
        "obfuscation": {
          "ruleOptions": { "enable": false }
        }
      }
    }
  ],
  "targets": [
    { "name": "default", "runtimeOS": "HarmonyOS" }
  ]
}
```

`harmony/entry/src/main/module.json5`：`name: "entry"`、`type: "entry"`、`mainElement: "EntryAbility"`、`deviceTypes: ["phone", "tablet", "2in1"]`、`pages: "$profile:main_pages"`，一个 `EntryAbility`（`srcEntry: "./ets/entryability/EntryAbility.ets"`，含 `entity.system.home` / `ohos.want.action.home` skill）。**本任务不声明任何权限**——网络权限由 Task 10 加，通知权限由 Task 14 加。

- [ ] **Step 4: 写最小可运行的 Ability 与页面**

`EntryAbility.ets` 继承 `UIAbility`，在 `onWindowStageCreate` 里 `windowStage.loadContent('pages/Index')`。`pages/Index.ets` 用 `@Entry @Component struct Index`，显示一行文本即可（Task 10 会重写它）。

`resources/base/profile/main_pages.json`：

```json
{
  "src": [
    "pages/Index"
  ]
}
```

`resources/base/element/string.json` 提供 `module_desc`、`EntryAbility_desc`、`EntryAbility_label`；`color.json` 提供 `start_window_background`。`dark/element/` 与 `zh_CN/element/` 各放一份同名 `string.json` / `color.json`，为后续双语与深色做好目录（值先与 base 一致，中文资源填中文）。

- [ ] **Step 5: 写 sanity 单测**

`harmony/entry/src/test/LocalUnit.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    it('hypium_is_wired', 0, () => {
      expect(1 + 1).assertEqual(2);
    });
  });
}
```

`harmony/entry/src/test/List.test.ets`：

```typescript
import localUnitTest from './LocalUnit.test';

export default function testsuite() {
  localUnitTest();
}
```

- [ ] **Step 6: 安装依赖**

```bash
cd /Users/StevenZhu/code/cc-pet-web/harmony
ohpm install --all
```

Expected: `oh_modules/` 生成，退出码 0。

- [ ] **Step 7: 跑通单测并记录实际命令**

用 `$HVIGORW` 跑 `entry` 模块的本地单测。先列出可用任务（`$HVIGORW --help` 或 `$HVIGORW tasks`）找到测试任务名，再执行。候选形式：

```bash
$HVIGORW test -p module=entry@default -p product=default --no-daemon
```

参数组合随 hvigor 版本而变——**以实际跑通的为准**，不要照抄本行。必须看到 `hypium_is_wired` 通过。

把实际可用的命令写进 `harmony/README.md`：

```markdown
## 命令

- 本地单测：`<实际跑通的命令>`
- 构建 HAP：`<实际命令，需先配置签名>`
```

README 还要写明：环境变量（Step 1 那三行）、签名配置步骤（指向 `build-profile.example.json5`，说明需在 DevEco 中登录华为账号自动生成）、以及「服务端零改动」这一约束。

- [ ] **Step 8: 忽略构建产物**

在仓库根 `.gitignore` 追加：

```
/harmony/build-profile.json5
/harmony/oh_modules/
/harmony/entry/oh_modules/
/harmony/.hvigor/
/harmony/.idea/
/harmony/entry/build/
/harmony/entry/.preview/
```

注意 `harmony/build-profile.json5` 被忽略后，克隆者需从 example 复制——README 里要写清这一步。

- [ ] **Step 9: 提交**

```bash
cd /Users/StevenZhu/code/cc-pet-web
git add harmony .gitignore
git commit -m "chore(harmony): scaffold ArkTS project with hypium local tests"
```

---

### Task 2: 协议类型与漂移守卫

这是选择「同仓」而非独立仓库的全部意义。先建守卫，后面所有协议相关任务都在它的保护下进行。

**Files:**
- Create: `harmony/entry/src/main/ets/model/Protocol.ets`
- Create: `packages/server/tests/harmony-protocol-alignment.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `WS_EVENTS`（含全部 21 个事件名的常量对象，与 `packages/shared` 逐字一致）、`ChatMessage`、`Session`、`TaskPhase`、`PetState`、`SlashCommandSpec` 等 ArkTS 类型，供后续所有任务 import。

- [ ] **Step 1: 写 Protocol.ets**

`harmony/entry/src/main/ets/model/Protocol.ets`，事件名必须与 `packages/shared/src/constants/events.ts` 逐字一致：

```typescript
export class WsEvents {
  static readonly BRIDGE_MANIFEST: string = 'bridge:manifest';
  static readonly BRIDGE_CONNECTED: string = 'bridge:connected';
  static readonly BRIDGE_ERROR: string = 'bridge:error';
  static readonly BRIDGE_MESSAGE: string = 'bridge:message';
  static readonly BRIDGE_STREAM_DELTA: string = 'bridge:stream-delta';
  static readonly BRIDGE_STREAM_DONE: string = 'bridge:stream-done';
  static readonly BRIDGE_BUTTONS: string = 'bridge:buttons';
  static readonly BRIDGE_TYPING_START: string = 'bridge:typing-start';
  static readonly BRIDGE_TYPING_STOP: string = 'bridge:typing-stop';
  static readonly BRIDGE_FILE_RECEIVED: string = 'bridge:file-received';
  static readonly BRIDGE_SKILLS_UPDATED: string = 'bridge:skills-updated';
  static readonly BRIDGE_PREVIEW_START: string = 'bridge:preview-start';
  static readonly BRIDGE_PREVIEW_UPDATE: string = 'bridge:preview-update';
  static readonly BRIDGE_PREVIEW_DELETE: string = 'bridge:preview-delete';
  static readonly BRIDGE_CARD: string = 'bridge:card';
  static readonly BRIDGE_AUDIO: string = 'bridge:audio';
  static readonly RESIDENT_UNREAD: string = 'resident:unread';
  static readonly SEND_MESSAGE: string = 'send-message';
  static readonly SEND_BUTTON: string = 'send-button';
  static readonly SEND_FILE: string = 'send-file';
  static readonly MESSAGE_ACK: string = 'message-ack';
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  connectionId?: string;
  sessionKey?: string;
  /** Server-assigned sequence number, present once acked. Drives history backfill. */
  seq?: number;
}

export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
  /** True when this session is a config-declared resident session. */
  isResident?: boolean;
  /** Server-persisted unread count (resident sessions only). */
  unreadCount?: number;
}

export type TaskPhase =
  | 'idle' | 'thinking' | 'working' | 'awaiting_confirmation'
  | 'completed' | 'failed' | 'stalled';

export type PetState = 'idle' | 'thinking' | 'talking' | 'happy' | 'error';

export type SlashCommandType = 'local' | 'send';
export type SlashCommandCategory = 'builtin' | 'session' | 'agent' | 'skill';

export interface SlashCommandSpec {
  command: string;
  description: string;
  category: SlashCommandCategory;
  type: SlashCommandType;
}
```

- [ ] **Step 2: 写漂移守卫测试**

`packages/server/tests/harmony-protocol-alignment.test.ts`：

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WS_EVENTS } from "@cc-pet/shared";

const here = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(here, "../../../harmony/entry/src/main/ets/model/Protocol.ets");

describe("harmony protocol alignment", () => {
  it("declares every WS event the shared package defines", () => {
    const source = readFileSync(protocolPath, "utf8");
    const declared = new Set(
      Array.from(source.matchAll(/static readonly [A-Z_]+: string = '([^']+)'/g)).map((m) => m[1]),
    );
    const expected = Object.values(WS_EVENTS);
    const missing = expected.filter((name) => !declared.has(name));
    expect(missing).toEqual([]);
  });

  it("declares no WS event the shared package does not define", () => {
    const source = readFileSync(protocolPath, "utf8");
    const declared = Array.from(
      source.matchAll(/static readonly [A-Z_]+: string = '([^']+)'/g),
    ).map((m) => m[1]);
    const expected = new Set<string>(Object.values(WS_EVENTS));
    const extra = declared.filter((name) => !expected.has(name));
    expect(extra).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试，确认通过**

```bash
cd /Users/StevenZhu/code/cc-pet-web
pnpm --filter @cc-pet/server exec vitest run tests/harmony-protocol-alignment.test.ts
```

Expected: 2 passed

- [ ] **Step 4: 验证守卫真的会响**

临时把 `Protocol.ets` 里 `BRIDGE_CARD` 的值改成 `'bridge:card-x'`，重跑上面的命令。

Expected: 两个用例都 FAIL——一个报缺 `bridge:card`，一个报多出 `bridge:card-x`。

确认后改回。**守卫没验证过会响，就等于没有守卫。**

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/model/Protocol.ets packages/server/tests/harmony-protocol-alignment.test.ts
git commit -m "feat(harmony): add protocol types with shared-package drift guard"
```

---

### Task 3: 重连退避（纯函数 TDD）

**Files:**
- Create: `harmony/entry/src/main/ets/logic/backoff.ets`
- Create: `harmony/entry/src/test/Backoff.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces: `backoffDelayMs(attempt: number): number` —— attempt 从 0 起算，返回毫秒。

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/Backoff.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { backoffDelayMs } from '../main/ets/logic/backoff';

export default function backoffTest() {
  describe('backoffDelayMs', () => {
    it('starts at one second', 0, () => {
      expect(backoffDelayMs(0)).assertEqual(1000);
    });
    it('doubles each attempt', 0, () => {
      expect(backoffDelayMs(1)).assertEqual(2000);
      expect(backoffDelayMs(2)).assertEqual(4000);
      expect(backoffDelayMs(4)).assertEqual(16000);
    });
    it('caps at thirty seconds', 0, () => {
      expect(backoffDelayMs(5)).assertEqual(30000);
      expect(backoffDelayMs(99)).assertEqual(30000);
    });
    it('treats negative attempts as the first attempt', 0, () => {
      expect(backoffDelayMs(-3)).assertEqual(1000);
    });
  });
}
```

在 `List.test.ets` 中注册：

```typescript
import localUnitTest from './LocalUnit.test';
import backoffTest from './Backoff.test';

export default function testsuite() {
  localUnitTest();
  backoffTest();
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，报找不到模块 `../main/ets/logic/backoff`

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/backoff.ets`：

```typescript
const INITIAL_DELAY_MS: number = 1000;
const MAX_DELAY_MS: number = 30000;

/** Exponential backoff matching the web client: min(30s, 1s * 2^attempt). */
export function backoffDelayMs(attempt: number): number {
  const safeAttempt: number = attempt < 0 ? 0 : attempt;
  const delay: number = INITIAL_DELAY_MS * Math.pow(2, safeAttempt);
  return delay > MAX_DELAY_MS ? MAX_DELAY_MS : delay;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/backoff.ets harmony/entry/src/test
git commit -m "feat(harmony): add reconnect backoff with capped exponential delay"
```

---

### Task 4: WS 事件归一化（纯函数 TDD）

web 端在十几个 case 里各解一遍 `connectionId / sessionKey`，这里一次解完。

**ArkTS 约束（本任务的关键）**：严格模式禁止对 interface 做索引访问（`arkts-no-props-by-index`），也不接受 `Record<string, Object>` 承接对象字面量。因此 payload **必须是显式声明字段的 interface，用属性访问读取**。这一点已用探针在本工程内实测确认：`JSON.parse(text) as SomeInterface` 合法、`obj.field` 合法、`field ?? ''` 与 `field === undefined` 合法；`obj['field']` 不合法。

这个限制其实是好事：payload 的字段从此是显式声明的，服务端加字段时鸿蒙端不会静默读到 `undefined`。

**Files:**
- Create: `harmony/entry/src/main/ets/logic/normalizeEvent.ets`
- Create: `harmony/entry/src/test/NormalizeEvent.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface WsFrame` —— 一帧的扁平结构，首版全部事件的字段并集，除 `type` 外全部可选
  - `interface BridgeInfo { id: string; name: string; attachmentStaging?: boolean }`
  - `interface NormalizedEvent { type: string; connectionId: string; sessionKey: string; chatKey: string; frame: WsFrame }`
  - `normalizeEvent(frame: WsFrame): NormalizedEvent`
  - `normalizeEvent(frame: WsFrame): NormalizedEvent`
  - `chatKeyOf(connectionId: string, sessionKey: string): string`

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/NormalizeEvent.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { normalizeEvent, chatKeyOf, WsFrame, NormalizedEvent } from '../main/ets/logic/normalizeEvent';

export default function normalizeEventTest() {
  describe('normalizeEvent', () => {
    it('builds the chat key from connection and session', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:message', connectionId: 'c1', sessionKey: 's1', content: 'hi',
      };
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.connectionId).assertEqual('c1');
      expect(out.sessionKey).assertEqual('s1');
      expect(out.chatKey).assertEqual('c1::s1');
    });

    it('falls back to empty strings when ids are absent', 0, () => {
      const out: NormalizedEvent = normalizeEvent({ type: 'bridge:manifest' });
      expect(out.connectionId).assertEqual('');
      expect(out.sessionKey).assertEqual('');
      expect(out.chatKey).assertEqual('');
    });

    it('keeps the frame intact for consumers', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:stream-delta', connectionId: 'c1', sessionKey: 's1', delta: 'abc',
      };
      expect(normalizeEvent(frame).frame.delta).assertEqual('abc');
    });

    it('carries ack fields through untouched', 0, () => {
      const frame: WsFrame = {
        type: 'message-ack', connectionId: 'c1', sessionKey: 's1',
        clientMsgId: 'local-1', id: 'srv-9', seq: 42,
      };
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.frame.clientMsgId).assertEqual('local-1');
      expect(out.frame.id).assertEqual('srv-9');
      expect(out.frame.seq).assertEqual(42);
    });

    it('parses a real flat json frame off the wire', 0, () => {
      // Exactly what the server sends: JSON.stringify({ type: event, ...payload })
      const frame: WsFrame =
        JSON.parse('{"type":"resident:unread","connectionId":"c1","sessionKey":"s1","unreadCount":3}') as WsFrame;
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.chatKey).assertEqual('c1::s1');
      expect(out.frame.unreadCount).assertEqual(3);
    });

    it('reads the manifest bridge list', 0, () => {
      const frame: WsFrame =
        JSON.parse('{"type":"bridge:manifest","bridges":[{"id":"cs","name":"cc"}]}') as WsFrame;
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.frame.bridges?.length).assertEqual(1);
      expect(out.frame.bridges?.[0].id).assertEqual('cs');
    });
  });

  describe('chatKeyOf', () => {
    it('returns empty when either part is missing', 0, () => {
      expect(chatKeyOf('', 's1')).assertEqual('');
      expect(chatKeyOf('c1', '')).assertEqual('');
    });
  });
}
```

在 `List.test.ets` 追加 `import normalizeEventTest from './NormalizeEvent.test';` 与 `normalizeEventTest();`。

- [ ] **Step 2: 跑测试确认失败**

Run: `harmony/README.md` 记录的单测命令
Expected: FAIL，找不到模块 `../main/ets/logic/normalizeEvent`

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/normalizeEvent.ets`：

```typescript

  connectionId?: string;
  sessionKey?: string;
  /** bridge:message */
  content?: string;
  /** bridge:stream-delta */
  delta?: string;
  /** bridge:stream-done */
  fullText?: string;
  /** message-ack: the id this client generated */
  clientMsgId?: string;
  /** message-ack: the id the server assigned */
  id?: string;
  /** bridge:message / bridge:stream-done: the server's id for an assistant reply */
  msgId?: string;
  /** message-ack: server sequence number */
  seq?: number;
  /** resident:unread */
  unreadCount?: number;
  /** bridge:connected */
  connected?: boolean;
}

/**
 * One frame exactly as it arrives on the wire.
 *
 * The server sends `JSON.stringify({ type: event, ...payload })`
 * (packages/server/src/ws/hub.ts) — the payload fields are spread onto the
 * TOP LEVEL, there is no nested `payload` object. An earlier version of this
 * plan assumed a nested envelope; it crashed on the first real message and the
 * unit tests passed anyway, because they encoded the same wrong assumption.
 */
export interface WsFrame {
  type: string;
  connectionId?: string;
  sessionKey?: string;
  /** bridge:message */
  content?: string;
  /** bridge:stream-delta */
  delta?: string;
  /** bridge:stream-done */
  fullText?: string;
  /** message-ack: the id this client generated */
  clientMsgId?: string;
  /** message-ack: the id the server assigned */
  id?: string;
  /** message-ack: server sequence number */
  seq?: number;
  /** resident:unread */
  unreadCount?: number;
  /** bridge:connected */
  connected?: boolean;
  /** bridge:manifest */
  bridges?: BridgeInfo[];
  /** bridge:skills-updated */
  commands?: SlashCommandSpec[];
}

export interface BridgeInfo {
  id: string;
  name: string;
  attachmentStaging?: boolean;
}

export interface NormalizedEvent {
  type: string;
  connectionId: string;
  sessionKey: string;
  chatKey: string;
  frame: WsFrame;
}

/** Chat key format mirrors the server: `${connectionId}::${sessionKey}`. */
export function chatKeyOf(connectionId: string, sessionKey: string): string {
  if (connectionId.length === 0 || sessionKey.length === 0) {
    return '';
  }
  return `${connectionId}::${sessionKey}`;
}

/** Parses ids once so downstream stores never re-derive them. */
export function normalizeEvent(frame: WsFrame): NormalizedEvent {
  const connectionId: string = frame.connectionId ?? '';
  const sessionKey: string = frame.sessionKey ?? '';
  return {
    type: frame.type,
    connectionId: connectionId,
    sessionKey: sessionKey,
    chatKey: chatKeyOf(connectionId, sessionKey),
    frame: frame,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `harmony/README.md` 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/normalizeEvent.ets harmony/entry/src/test
git commit -m "feat(harmony): normalize ws events once before fan-out"
```

---

### Task 5: 宠物状态派生（纯函数 TDD）

替换 web 端 12 处命令式 `setPetState` 与 `shouldForceThinking` 补丁。

**Files:**
- Create: `harmony/entry/src/main/ets/logic/derivePetState.ets`
- Create: `harmony/entry/src/test/DerivePetState.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: `PetState`, `TaskPhase` from `model/Protocol`
- Produces:
  - `interface PetInputs { taskPhase: TaskPhase; hasUnread: boolean; bridgeConnected: boolean; msSinceConnected: number }`
  - `derivePetState(inputs: PetInputs): PetState`
  - `HAPPY_WINDOW_MS: number`（值 3000）

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/DerivePetState.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { derivePetState, PetInputs } from '../main/ets/logic/derivePetState';
import { TaskPhase } from '../main/ets/model/Protocol';

function inputs(phase: string, unread: boolean, connected: boolean, since: number): PetInputs {
  return {
    // NOT PetInputs['taskPhase'] — ArkTS rejects indexed access types
    // (arkts-no-aliases-by-index), the type-level sibling of the property rule.
    taskPhase: phase as TaskPhase,
    hasUnread: unread,
    bridgeConnected: connected,
    msSinceConnected: since,
  };
}

export default function derivePetStateTest() {
  describe('derivePetState', () => {
    it('shows error when the bridge is down', 0, () => {
      expect(derivePetState(inputs('idle', false, false, 99999))).assertEqual('error');
    });

    it('error outranks a fresh connection', 0, () => {
      expect(derivePetState(inputs('idle', false, false, 10))).assertEqual('error');
    });

    it('is happy right after connecting', 0, () => {
      expect(derivePetState(inputs('idle', false, true, 500))).assertEqual('happy');
    });

    it('stops being happy after the window closes', 0, () => {
      expect(derivePetState(inputs('idle', false, true, 3001))).assertEqual('idle');
    });

    it('thinks while a task is working', 0, () => {
      expect(derivePetState(inputs('working', false, true, 99999))).assertEqual('thinking');
      expect(derivePetState(inputs('thinking', false, true, 99999))).assertEqual('thinking');
    });

    it('working outranks the happy window', 0, () => {
      expect(derivePetState(inputs('working', false, true, 100))).assertEqual('thinking');
    });

    it('talks when unread messages are waiting', 0, () => {
      expect(derivePetState(inputs('completed', true, true, 99999))).assertEqual('talking');
    });

    it('falls back to idle', 0, () => {
      expect(derivePetState(inputs('completed', false, true, 99999))).assertEqual('idle');
    });
  });
}
```

在 `List.test.ets` 追加导入与调用。

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，找不到模块

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/derivePetState.ets`：

```typescript
import { PetState, TaskPhase } from '../model/Protocol';

export const HAPPY_WINDOW_MS: number = 3000;

export interface PetInputs {
  taskPhase: TaskPhase;
  hasUnread: boolean;
  bridgeConnected: boolean;
  msSinceConnected: number;
}

/**
 * Pet state is derived, never set imperatively. Priority is fixed and total:
 * error > working/thinking > fresh-connection > unread > idle.
 */
export function derivePetState(inputs: PetInputs): PetState {
  if (!inputs.bridgeConnected) {
    return 'error';
  }
  if (inputs.taskPhase === 'working' || inputs.taskPhase === 'thinking') {
    return 'thinking';
  }
  if (inputs.msSinceConnected <= HAPPY_WINDOW_MS) {
    return 'happy';
  }
  if (inputs.hasUnread) {
    return 'talking';
  }
  return 'idle';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/derivePetState.ets harmony/entry/src/test
git commit -m "feat(harmony): derive pet state from task phase and connection"
```

---

### Task 6: markdown 块级解析（纯函数 TDD）

**Files:**
- Create: `harmony/entry/src/main/ets/model/Markdown.ets`
- Create: `harmony/entry/src/main/ets/logic/parseMarkdown.ets`
- Create: `harmony/entry/src/test/ParseMarkdownBlock.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type MdNodeKind = 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table'`
  - `interface MdNode { kind: MdNodeKind; text: string; level: number; ordered: boolean; items: string[]; language: string; rows: string[][] }`
  - `parseMarkdown(src: string): MdNode[]`

所有字段均非可选：ArkTS 下统一形状比可选字段更省事，未用到的字段填零值。

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/ParseMarkdownBlock.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { parseMarkdown } from '../main/ets/logic/parseMarkdown';
import { MdNode } from '../main/ets/model/Markdown';

export default function parseMarkdownBlockTest() {
  describe('parseMarkdown blocks', () => {
    it('parses headings with level', 0, () => {
      const nodes: MdNode[] = parseMarkdown('### Title');
      expect(nodes.length).assertEqual(1);
      expect(nodes[0].kind).assertEqual('heading');
      expect(nodes[0].level).assertEqual(3);
      expect(nodes[0].text).assertEqual('Title');
    });

    it('parses a fenced code block with language', 0, () => {
      const nodes: MdNode[] = parseMarkdown('```ts\nconst a = 1;\n```');
      expect(nodes.length).assertEqual(1);
      expect(nodes[0].kind).assertEqual('code');
      expect(nodes[0].language).assertEqual('ts');
      expect(nodes[0].text).assertEqual('const a = 1;');
    });

    it('keeps markdown syntax literal inside code blocks', 0, () => {
      const nodes: MdNode[] = parseMarkdown('```\n# not a heading\n```');
      expect(nodes[0].kind).assertEqual('code');
      expect(nodes[0].text).assertEqual('# not a heading');
    });

    it('parses unordered and ordered lists', 0, () => {
      const un: MdNode[] = parseMarkdown('- a\n- b');
      expect(un[0].kind).assertEqual('list');
      expect(un[0].ordered).assertEqual(false);
      expect(un[0].items.length).assertEqual(2);
      expect(un[0].items[1]).assertEqual('b');

      const or: MdNode[] = parseMarkdown('1. first\n2. second');
      expect(or[0].ordered).assertEqual(true);
      expect(or[0].items[0]).assertEqual('first');
    });

    it('parses block quotes', 0, () => {
      const nodes: MdNode[] = parseMarkdown('> quoted');
      expect(nodes[0].kind).assertEqual('quote');
      expect(nodes[0].text).assertEqual('quoted');
    });

    it('parses a gfm table', 0, () => {
      const nodes: MdNode[] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(nodes[0].kind).assertEqual('table');
      expect(nodes[0].rows.length).assertEqual(2);
      expect(nodes[0].rows[0][1]).assertEqual('b');
      expect(nodes[0].rows[1][0]).assertEqual('1');
    });

    it('groups consecutive lines into one paragraph', 0, () => {
      const nodes: MdNode[] = parseMarkdown('line one\nline two\n\nsecond para');
      expect(nodes.length).assertEqual(2);
      expect(nodes[0].kind).assertEqual('paragraph');
      expect(nodes[0].text).assertEqual('line one line two');
      expect(nodes[1].text).assertEqual('second para');
    });

    it('returns nothing for empty input', 0, () => {
      expect(parseMarkdown('').length).assertEqual(0);
      expect(parseMarkdown('   \n  ').length).assertEqual(0);
    });
  });
}
```

在 `List.test.ets` 追加导入与调用。

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，找不到模块

- [ ] **Step 3: 定义 MdNode**

`harmony/entry/src/main/ets/model/Markdown.ets`：

```typescript
export type MdNodeKind = 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table';

export interface MdNode {
  kind: MdNodeKind;
  text: string;
  level: number;
  ordered: boolean;
  items: string[];
  language: string;
  rows: string[][];
}

export function emptyNode(kind: MdNodeKind): MdNode {
  return { kind: kind, text: '', level: 0, ordered: false, items: [], language: '', rows: [] };
}
```

- [ ] **Step 4: 实现块级解析**

`harmony/entry/src/main/ets/logic/parseMarkdown.ets`：

```typescript
import { MdNode, emptyNode } from '../model/Markdown';

function isTableDivider(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function splitRow(line: string): string[] {
  const trimmed: string = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  for (const cell of trimmed.split('|')) {
    cells.push(cell.trim());
  }
  return cells;
}

/**
 * Block-level markdown parser for the controlled subset the chat needs.
 * Pure: no ArkUI imports, so it stays unit-testable.
 */
export function parseMarkdown(src: string): MdNode[] {
  const lines: string[] = src.split('\n');
  const nodes: MdNode[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const node: MdNode = emptyNode('paragraph');
      node.text = paragraph.join(' ');
      nodes.push(node);
      paragraph = [];
    }
  };

  let i: number = 0;
  while (i < lines.length) {
    const line: string = lines[i];
    const trimmed: string = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      const node: MdNode = emptyNode('code');
      node.language = trimmed.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      node.text = body.join('\n');
      nodes.push(node);
      i++;
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      i++;
      continue;
    }

    const heading: RegExpMatchArray | null = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      flushParagraph();
      const node: MdNode = emptyNode('heading');
      node.level = heading[1].length;
      node.text = heading[2].trim();
      nodes.push(node);
      i++;
      continue;
    }

    if (trimmed.startsWith('> ') || trimmed === '>') {
      flushParagraph();
      const node: MdNode = emptyNode('quote');
      node.text = trimmed.replace(/^>\s?/, '');
      nodes.push(node);
      i++;
      continue;
    }

    const unordered: boolean = /^[-*+]\s+/.test(trimmed);
    const ordered: boolean = /^\d+\.\s+/.test(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const node: MdNode = emptyNode('list');
      node.ordered = ordered;
      while (i < lines.length) {
        const item: string = lines[i].trim();
        const matchesSame: boolean = node.ordered ? /^\d+\.\s+/.test(item) : /^[-*+]\s+/.test(item);
        if (!matchesSame) {
          break;
        }
        node.items.push(item.replace(/^([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      nodes.push(node);
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph();
      const node: MdNode = emptyNode('table');
      node.rows.push(splitRow(trimmed));
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|')) {
        node.rows.push(splitRow(lines[i]));
        i++;
      }
      nodes.push(node);
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  return nodes;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/model/Markdown.ets harmony/entry/src/main/ets/logic/parseMarkdown.ets harmony/entry/src/test
git commit -m "feat(harmony): parse block-level markdown into MdNode tree"
```

---

### Task 7: markdown 行内解析（纯函数 TDD）

块级节点的 `text` 还是原始串，行内样式要再拆一层，否则 `**粗体**` 会原样显示给用户。

**Files:**
- Modify: `harmony/entry/src/main/ets/model/Markdown.ets`
- Create: `harmony/entry/src/main/ets/logic/parseInline.ets`
- Create: `harmony/entry/src/test/ParseInline.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type MdSpanKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'image'`
  - `interface MdSpan { kind: MdSpanKind; text: string; href: string }`
  - `parseInline(src: string): MdSpan[]`

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/ParseInline.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { parseInline } from '../main/ets/logic/parseInline';
import { MdSpan } from '../main/ets/model/Markdown';

export default function parseInlineTest() {
  describe('parseInline', () => {
    it('returns a single text span for plain input', 0, () => {
      const spans: MdSpan[] = parseInline('hello world');
      expect(spans.length).assertEqual(1);
      expect(spans[0].kind).assertEqual('text');
      expect(spans[0].text).assertEqual('hello world');
    });

    it('splits bold segments', 0, () => {
      const spans: MdSpan[] = parseInline('a **b** c');
      expect(spans.length).assertEqual(3);
      expect(spans[1].kind).assertEqual('bold');
      expect(spans[1].text).assertEqual('b');
    });

    it('parses inline code before emphasis', 0, () => {
      const spans: MdSpan[] = parseInline('use `a * b` here');
      expect(spans[1].kind).assertEqual('code');
      expect(spans[1].text).assertEqual('a * b');
    });

    it('parses links with href', 0, () => {
      const spans: MdSpan[] = parseInline('see [docs](https://x.dev)');
      expect(spans[1].kind).assertEqual('link');
      expect(spans[1].text).assertEqual('docs');
      expect(spans[1].href).assertEqual('https://x.dev');
    });

    it('parses images distinctly from links', 0, () => {
      const spans: MdSpan[] = parseInline('![alt](https://x.dev/a.png)');
      expect(spans[0].kind).assertEqual('image');
      expect(spans[0].href).assertEqual('https://x.dev/a.png');
      expect(spans[0].text).assertEqual('alt');
    });

    it('parses italic', 0, () => {
      const spans: MdSpan[] = parseInline('a *b* c');
      expect(spans[1].kind).assertEqual('italic');
      expect(spans[1].text).assertEqual('b');
    });

    it('leaves unmatched markers as literal text', 0, () => {
      const spans: MdSpan[] = parseInline('2 * 3 = 6');
      expect(spans.length).assertEqual(1);
      expect(spans[0].text).assertEqual('2 * 3 = 6');
    });
  });
}
```

在 `List.test.ets` 追加导入与调用。

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，找不到模块

- [ ] **Step 3: 扩展 Markdown 模型**

在 `harmony/entry/src/main/ets/model/Markdown.ets` 末尾追加：

```typescript
export type MdSpanKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'image';

export interface MdSpan {
  kind: MdSpanKind;
  text: string;
  href: string;
}

export function textSpan(text: string): MdSpan {
  return { kind: 'text', text: text, href: '' };
}
```

- [ ] **Step 4: 实现行内解析**

`harmony/entry/src/main/ets/logic/parseInline.ets`：

```typescript
import { MdSpan, MdSpanKind, textSpan } from '../model/Markdown';

interface InlineRule {
  kind: MdSpanKind;
  pattern: RegExp;
}

/**
 * Ordered by precedence: code wins over emphasis so `a * b` stays literal,
 * images win over links so ![x](y) is not read as a link.
 */
const RULES: InlineRule[] = [
  { kind: 'code', pattern: /`([^`]+)`/ },
  { kind: 'image', pattern: /!\[([^\]]*)\]\(([^)]+)\)/ },
  { kind: 'link', pattern: /\[([^\]]+)\]\(([^)]+)\)/ },
  { kind: 'bold', pattern: /\*\*([^*]+)\*\*/ },
  { kind: 'italic', pattern: /\*([^*\s][^*]*)\*/ },
];

export function parseInline(src: string): MdSpan[] {
  if (src.length === 0) {
    return [];
  }

  let earliestIndex: number = -1;
  let matched: RegExpMatchArray | null = null;
  let matchedKind: MdSpanKind = 'text';

  for (const rule of RULES) {
    const found: RegExpMatchArray | null = src.match(rule.pattern);
    if (found !== null && found.index !== undefined) {
      if (earliestIndex === -1 || found.index < earliestIndex) {
        earliestIndex = found.index;
        matched = found;
        matchedKind = rule.kind;
      }
    }
  }

  if (matched === null || earliestIndex === -1) {
    return [textSpan(src)];
  }

  const spans: MdSpan[] = [];
  const before: string = src.slice(0, earliestIndex);
  if (before.length > 0) {
    spans.push(textSpan(before));
  }

  const isLinkLike: boolean = matchedKind === 'link' || matchedKind === 'image';
  spans.push({
    kind: matchedKind,
    text: matched[1],
    href: isLinkLike ? matched[2] : '',
  });

  const after: string = src.slice(earliestIndex + matched[0].length);
  for (const span of parseInline(after)) {
    spans.push(span);
  }
  return spans;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/model/Markdown.ets harmony/entry/src/main/ets/logic/parseInline.ets harmony/entry/src/test
git commit -m "feat(harmony): parse inline markdown spans with code precedence"
```

---

### Task 8: slash command 合并与匹配（纯函数 TDD）

**Files:**
- Create: `harmony/entry/src/main/ets/logic/slashCommands.ets`
- Create: `harmony/entry/src/test/SlashCommands.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: `SlashCommandSpec`, `SlashCommandCategory` from `model/Protocol`
- Produces:
  - `BUILTIN_COMMANDS: SlashCommandSpec[]`
  - `CC_CONNECT_COMMANDS: SlashCommandSpec[]`
  - `mergeCommands(skills: SlashCommandSpec[]): SlashCommandSpec[]`
  - `matchCommands(all: SlashCommandSpec[], input: string): SlashCommandSpec[]`
  - `isSlashInput(input: string): boolean`

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/SlashCommands.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import {
  BUILTIN_COMMANDS, CC_CONNECT_COMMANDS, mergeCommands, matchCommands, isSlashInput,
} from '../main/ets/logic/slashCommands';
import { SlashCommandSpec } from '../main/ets/model/Protocol';

function skill(command: string): SlashCommandSpec {
  return { command: command, description: 'from skills', category: 'skill', type: 'send' };
}

export default function slashCommandsTest() {
  describe('isSlashInput', () => {
    it('is true only for a leading slash', 0, () => {
      expect(isSlashInput('/mo')).assertEqual(true);
      expect(isSlashInput(' /mo')).assertEqual(false);
      expect(isSlashInput('hello /mo')).assertEqual(false);
      expect(isSlashInput('')).assertEqual(false);
    });
  });

  describe('mergeCommands', () => {
    it('includes builtins, cc-connect commands and skills', 0, () => {
      const merged: SlashCommandSpec[] = mergeCommands([skill('/deploy')]);
      expect(merged.length).assertEqual(BUILTIN_COMMANDS.length + CC_CONNECT_COMMANDS.length + 1);
    });

    it('drops skills that collide with a builtin', 0, () => {
      const merged: SlashCommandSpec[] = mergeCommands([skill('/clear')]);
      expect(merged.length).assertEqual(BUILTIN_COMMANDS.length + CC_CONNECT_COMMANDS.length);
    });
  });

  describe('matchCommands', () => {
    it('filters by prefix', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      const hits: SlashCommandSpec[] = matchCommands(all, '/cl');
      expect(hits.length).assertEqual(1);
      expect(hits[0].command).assertEqual('/clear');
    });

    it('returns everything for a bare slash', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/').length).assertEqual(all.length);
    });

    it('ignores anything after the first space', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/model switch x').length).assertEqual(1);
    });

    it('is case insensitive', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/CL')[0].command).assertEqual('/clear');
    });

    it('returns empty when nothing matches', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([]);
      expect(matchCommands(all, '/zzz').length).assertEqual(0);
    });

    it('orders builtin before session before agent before skill', 0, () => {
      const all: SlashCommandSpec[] = mergeCommands([skill('/aaa')]);
      const hits: SlashCommandSpec[] = matchCommands(all, '/');
      expect(hits[0].category).assertEqual('builtin');
      expect(hits[hits.length - 1].category).assertEqual('skill');
    });
  });
}
```

在 `List.test.ets` 追加导入与调用。

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，找不到模块

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/slashCommands.ets`：

```typescript
import { SlashCommandSpec, SlashCommandCategory } from '../model/Protocol';

export const BUILTIN_COMMANDS: SlashCommandSpec[] = [
  { command: '/clear', description: '清空聊天记录', category: 'builtin', type: 'local' },
  { command: '/settings', description: '打开设置面板', category: 'builtin', type: 'local' },
  { command: '/connect', description: '连接 cc-connect Bridge', category: 'builtin', type: 'local' },
  { command: '/disconnect', description: '断开 cc-connect Bridge', category: 'builtin', type: 'local' },
];

export const CC_CONNECT_COMMANDS: SlashCommandSpec[] = [
  { command: '/new', description: '开始新会话 /new [name]', category: 'session', type: 'send' },
  { command: '/list', description: '列出所有会话', category: 'session', type: 'send' },
  { command: '/switch', description: '切换会话 /switch <id>', category: 'session', type: 'send' },
  { command: '/current', description: '当前会话信息', category: 'session', type: 'send' },
  { command: '/history', description: '查看最近消息 /history [n]', category: 'session', type: 'send' },
  { command: '/stop', description: '停止当前执行', category: 'session', type: 'send' },
  { command: '/model', description: '查看/切换模型 /model [switch <alias>]', category: 'agent', type: 'send' },
  { command: '/mode', description: '查看/切换权限模式 /mode [yolo|default|plan]', category: 'agent', type: 'send' },
  { command: '/reasoning', description: '调整推理级别 /reasoning [level]', category: 'agent', type: 'send' },
];

const CATEGORY_ORDER: SlashCommandCategory[] = ['builtin', 'session', 'agent', 'skill'];

export function isSlashInput(input: string): boolean {
  return input.startsWith('/');
}

/** Builtins win on collision so a skill cannot shadow /clear. */
export function mergeCommands(skills: SlashCommandSpec[]): SlashCommandSpec[] {
  const merged: SlashCommandSpec[] = [];
  const seen: Set<string> = new Set<string>();
  const staticCommands: SlashCommandSpec[] = BUILTIN_COMMANDS.concat(CC_CONNECT_COMMANDS);
  for (const spec of staticCommands) {
    merged.push(spec);
    seen.add(spec.command);
  }
  for (const spec of skills) {
    if (!seen.has(spec.command)) {
      merged.push(spec);
      seen.add(spec.command);
    }
  }
  return merged;
}

export function matchCommands(all: SlashCommandSpec[], input: string): SlashCommandSpec[] {
  if (!isSlashInput(input)) {
    return [];
  }
  const token: string = (input.split(' ')[0] ?? input).toLowerCase();
  const hits: SlashCommandSpec[] = [];
  for (const spec of all) {
    if (spec.command.toLowerCase().startsWith(token)) {
      hits.push(spec);
    }
  }
  hits.sort((a: SlashCommandSpec, b: SlashCommandSpec): number => {
    const byCategory: number = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    return byCategory !== 0 ? byCategory : a.command.localeCompare(b.command);
  });
  return hits;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/slashCommands.ets harmony/entry/src/test
git commit -m "feat(harmony): merge and match slash commands with builtin precedence"
```

---

### Task 9: Outbox 发送可靠性（纯函数 TDD）

**不要自创发送队列。** 这个任务移植 `packages/web/src/lib/store/outbox.ts` 的语义，服务端已有配套的 `message-ack` 回执。

**Files:**
- Create: `harmony/entry/src/main/ets/logic/outbox.ets`
- Create: `harmony/entry/src/test/Outbox.test.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type RetryPolicy = 'auto' | 'manual' | 'never'`
  - `type OutboxStatus = 'pending' | 'sent' | 'failed'`
  - `interface OutboxEntry { clientMsgId: string; chatKey: string; text: string; policy: RetryPolicy; status: OutboxStatus; createdAt: number; transmittedAt: number }`
  - `class Outbox`：`enqueue(clientMsgId: string, chatKey: string, text: string, policy: RetryPolicy, now: number): void`、`markSent(clientMsgId: string): void`、`markTransmitted(ids: string[], now: number): void`、`expireTimedOut(now: number): string[]`、`takeSendable(now: number): OutboxEntry[]`、`reviveAuto(now: number): void`、`resend(clientMsgId: string, now: number): void`、`entriesOf(chatKey: string): OutboxEntry[]`、`size(): number`
  - `ACK_TIMEOUT_MS: number`（15000）、`MANUAL_WINDOW_MS: number`（120000）

`clientMsgId` 由调用方（`ConnectionGateway`，用 `@kit.ArkTS` 的 `util.generateRandomUUID`）生成后传入，`now` 也由调用方传入——这样 `Outbox` 保持纯粹，测试不需要冻结时钟或打桩 UUID。

- [ ] **Step 1: 写失败测试**

`harmony/entry/src/test/Outbox.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { Outbox, OutboxEntry, ACK_TIMEOUT_MS, MANUAL_WINDOW_MS } from '../main/ets/logic/outbox';

export default function outboxTest() {
  describe('Outbox', () => {
    it('enqueues as pending and reports size', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.size()).assertEqual(1);
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
    });

    it('drops an entry once acked', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markSent('id-a');
      expect(box.size()).assertEqual(0);
    });

    it('fails entries whose ack budget expired', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      const expired: string[] = box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      expect(expired.length).assertEqual(1);
      expect(expired[0]).assertEqual('id-a');
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('does not expire an entry that was never transmitted', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1).length).assertEqual(0);
    });

    it('restarts the ack budget on retransmit', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.markTransmitted(['id-a'], 50000);
      expect(box.expireTimedOut(50000 + ACK_TIMEOUT_MS - 1).length).assertEqual(0);
      expect(box.expireTimedOut(50000 + ACK_TIMEOUT_MS + 1).length).assertEqual(1);
    });

    it('keeps createdAt fixed across retransmits so manual entries still age out', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.markTransmitted(['id-a'], 1000 + MANUAL_WINDOW_MS - 1);
      expect(box.entriesOf('c::s')[0].createdAt).assertEqual(1000);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS + 1).length).assertEqual(0);
    });

    it('offers manual entries only inside the window', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS - 1).length).assertEqual(1);
      expect(box.takeSendable(1000 + MANUAL_WINDOW_MS + 1).length).assertEqual(0);
    });

    it('never offers never-policy entries for auto resend', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'never', 1000);
      expect(box.takeSendable(1001).length).assertEqual(0);
    });

    it('offers auto entries regardless of age', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('returns entries in enqueue order', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'first', 'auto', 1000);
      box.enqueue('id-b', 'c::s', 'second', 'auto', 1001);
      const sendable: OutboxEntry[] = box.takeSendable(2000);
      expect(sendable[0].clientMsgId).assertEqual('id-a');
      expect(sendable[1].clientMsgId).assertEqual('id-b');
    });

    it('revives one failed entry on explicit resend', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.resend('id-a', 99999999);
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('does not offer a failed entry until something revives it', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      expect(box.takeSendable(99999999).length).assertEqual(0);
    });

    it('fails a manual entry that outlived its window', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.takeSendable(1000 + MANUAL_WINDOW_MS + 1);
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('revives failed auto entries on reconnect', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.reviveAuto(99999999);
      expect(box.entriesOf('c::s')[0].status).assertEqual('pending');
      expect(box.takeSendable(99999999).length).assertEqual(1);
    });

    it('leaves failed manual entries for the user to retry', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.reviveAuto(99999999);
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('does not revive a failed entry when retransmitting', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'manual', 1000);
      box.markTransmitted(['id-a'], 1000);
      box.expireTimedOut(1000 + ACK_TIMEOUT_MS + 1);
      box.markTransmitted(['id-a'], 99999999);
      expect(box.entriesOf('c::s')[0].status).assertEqual('failed');
    });

    it('ignores duplicate client message ids', 0, () => {
      const box: Outbox = new Outbox();
      box.enqueue('id-a', 'c::s', 'hello', 'auto', 1000);
      box.enqueue('id-a', 'c::s', 'hello again', 'auto', 2000);
      expect(box.size()).assertEqual(1);
    });
  });
}
```

在 `List.test.ets` 追加 `import outboxTest from './Outbox.test';` 与 `outboxTest();`。

- [ ] **Step 2: 跑测试确认失败**

Run: Task 1 记录的单测命令
Expected: FAIL，找不到模块 `../main/ets/logic/outbox`

- [ ] **Step 3: 最小实现**

`harmony/entry/src/main/ets/logic/outbox.ets`：

```typescript
export type RetryPolicy = 'auto' | 'manual' | 'never';
export type OutboxStatus = 'pending' | 'sent' | 'failed';

export const ACK_TIMEOUT_MS: number = 15000;
export const MANUAL_WINDOW_MS: number = 120000;

export interface OutboxEntry {
  clientMsgId: string;
  chatKey: string;
  text: string;
  policy: RetryPolicy;
  status: OutboxStatus;
  /** When the user asked to send. Drives the manual policy's staleness window. */
  createdAt: number;
  /**
   * When the entry was last actually written to the socket; start of the ack
   * budget. Kept separate from createdAt on purpose: sharing one field would
   * let every retransmit push the staleness window forward, so a manual entry
   * would never age out.
   */
  transmittedAt: number;
}

/** Mirrors packages/web/src/lib/store/outbox.ts so both clients fail the same way. */
export class Outbox {
  private entries: OutboxEntry[] = [];

  enqueue(clientMsgId: string, chatKey: string, text: string, policy: RetryPolicy, now: number): void {
    for (const existing of this.entries) {
      if (existing.clientMsgId === clientMsgId) {
        return;
      }
    }
    this.entries.push({
      clientMsgId: clientMsgId,
      chatKey: chatKey,
      text: text,
      policy: policy,
      status: 'pending',
      createdAt: now,
      transmittedAt: 0,
    });
  }

  markSent(clientMsgId: string): void {
    const kept: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.clientMsgId !== clientMsgId) {
        kept.push(entry);
      }
    }
    this.entries = kept;
  }

  /**
   * Restart the ack budget for entries just written to the socket.
   *
   * Only entries still waiting for an ack are touched. A failed entry must not
   * be revived here — that decision belongs to reviveAuto() or to the user's
   * explicit resend(). Writing status unconditionally would reopen the very
   * hole those two methods exist to close.
   */
  markTransmitted(ids: string[], now: number): void {
    const wanted: Set<string> = new Set<string>(ids);
    for (const entry of this.entries) {
      if (entry.status === 'pending' && wanted.has(entry.clientMsgId)) {
        entry.transmittedAt = now;
      }
    }
  }

  /** Returns the ids that just failed, so the UI can mark those bubbles. */
  expireTimedOut(now: number): string[] {
    const expired: string[] = [];
    for (const entry of this.entries) {
      const waiting: boolean = entry.status === 'pending' && entry.transmittedAt > 0;
      if (waiting && now - entry.transmittedAt > ACK_TIMEOUT_MS) {
        entry.status = 'failed';
        expired.push(entry.clientMsgId);
      }
    }
    return expired;
  }

  takeSendable(now: number): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.policy === 'never') {
        continue;
      }
      // A manual entry that outlived its window fails here rather than being
      // silently skipped: the user needs to see it went nowhere.
      if (entry.policy === 'manual' && entry.status === 'pending'
          && now - entry.createdAt > MANUAL_WINDOW_MS) {
        entry.status = 'failed';
      }
      // Only pending entries go on the wire. A failed entry needs an explicit
      // decision first — reviveAuto() on reconnect, or resend() from the user.
      if (entry.status === 'pending') {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Reconnect path: bring failed auto entries back.
   *
   * Manual entries are deliberately skipped. The user sent those by hand, so
   * they get to decide again rather than having a two-minute-old message fire
   * on its own after the network returns.
   */
  reviveAuto(now: number): void {
    for (const entry of this.entries) {
      if (entry.status === 'failed' && entry.policy === 'auto') {
        entry.status = 'pending';
        // Reset createdAt too, matching the web store: a revived entry is a
        // fresh send attempt, and anything rendering "sent N ago" should agree
        // across the two clients.
        entry.createdAt = now;
        entry.transmittedAt = 0;
      }
    }
  }

  resend(clientMsgId: string, now: number): void {
    for (const entry of this.entries) {
      if (entry.clientMsgId === clientMsgId) {
        entry.status = 'pending';
        entry.createdAt = now;
        entry.transmittedAt = 0;
      }
    }
  }

  entriesOf(chatKey: string): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.chatKey === chatKey) {
        out.push(entry);
      }
    }
    return out;
  }

  size(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: Task 1 记录的单测命令
Expected: 全部 PASS（12 个用例）

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/logic/outbox.ets harmony/entry/src/test
git commit -m "feat(harmony): add outbox with ack timeout and retry policies"
```

---

### Task 10: RestClient、token 存储与登录页

第一个能在真机上看见的东西：输入 token 能登录进去。

**Files:**
- Create: `harmony/entry/src/main/ets/gateway/RestClient.ets`
- Create: `harmony/entry/src/main/ets/store/AuthStore.ets`
- Create: `harmony/entry/src/main/ets/components/LoginGate.ets`
- Modify: `harmony/entry/src/main/ets/pages/Index.ets`
- Modify: `harmony/entry/src/main/module.json5`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class RestClient`，构造参数 `(baseUrl: string, token: string)`，方法 `getJson(path: string): Promise<string>`、`postJson(path: string, body: string): Promise<string>`；401 时抛出 `UnauthorizedError`
  - `class UnauthorizedError extends Error`
  - `AuthStore`：`@ObservedV2` 单例，属性 `token: string`、`baseUrl: string`、`authorized: boolean`，方法 `load(): Promise<void>`、`save(baseUrl: string, token: string): Promise<void>`、`clear(): Promise<void>`

- [ ] **Step 1: 声明网络权限**

在 `harmony/entry/src/main/module.json5` 的 `module` 下追加：

```json5
"requestPermissions": [
  { "name": "ohos.permission.INTERNET" },
  { "name": "ohos.permission.GET_NETWORK_INFO" }
]
```

- [ ] **Step 2: 实现 RestClient**

`harmony/entry/src/main/ets/gateway/RestClient.ets`：

```typescript
import { http } from '@kit.NetworkKit';

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
  }
}

/** Only layer that talks HTTP. UI never imports this directly. */
export class RestClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request(path: string, method: http.RequestMethod, body: string): Promise<string> {
    const request: http.HttpRequest = http.createHttp();
    try {
      const response: http.HttpResponse = await request.request(`${this.baseUrl}${path}`, {
        method: method,
        header: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        extraData: body.length > 0 ? body : undefined,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 10000,
        readTimeout: 30000,
      });
      if (response.responseCode === 401) {
        throw new UnauthorizedError();
      }
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`http ${response.responseCode}`);
      }
      return response.result as string;
    } finally {
      request.destroy();
    }
  }

  getJson(path: string): Promise<string> {
    return this.request(path, http.RequestMethod.GET, '');
  }

  postJson(path: string, body: string): Promise<string> {
    return this.request(path, http.RequestMethod.POST, body);
  }
}
```

- [ ] **Step 3: 实现 AuthStore**

`harmony/entry/src/main/ets/store/AuthStore.ets`，用 `@kit.ArkData` 的 preferences 持久化：

```typescript
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';

const STORE_NAME: string = 'cc_pet_auth';
const KEY_TOKEN: string = 'token';
const KEY_BASE_URL: string = 'baseUrl';

@ObservedV2
export class AuthStore {
  static readonly instance: AuthStore = new AuthStore();

  @Trace token: string = '';
  @Trace baseUrl: string = '';
  @Trace authorized: boolean = false;

  private store: preferences.Preferences | undefined = undefined;

  async init(context: common.UIAbilityContext): Promise<void> {
    this.store = await preferences.getPreferences(context, STORE_NAME);
    this.token = await this.store.get(KEY_TOKEN, '') as string;
    this.baseUrl = await this.store.get(KEY_BASE_URL, '') as string;
    this.authorized = this.token.length > 0 && this.baseUrl.length > 0;
  }

  async save(baseUrl: string, token: string): Promise<void> {
    this.baseUrl = baseUrl;
    this.token = token;
    this.authorized = true;
    if (this.store !== undefined) {
      await this.store.put(KEY_BASE_URL, baseUrl);
      await this.store.put(KEY_TOKEN, token);
      await this.store.flush();
    }
  }

  async clear(): Promise<void> {
    this.token = '';
    this.authorized = false;
    if (this.store !== undefined) {
      await this.store.delete(KEY_TOKEN);
      await this.store.flush();
    }
  }
}
```

- [ ] **Step 4: 实现 LoginGate**

`harmony/entry/src/main/ets/components/LoginGate.ets`：

```typescript
import { AuthStore } from '../store/AuthStore';
import { RestClient, UnauthorizedError } from '../gateway/RestClient';

interface VerifyRequest {
  token: string;
}

@ComponentV2
export struct LoginGate {
  @Local serverUrl: string = '';
  @Local token: string = '';
  @Local error: string = '';
  @Local busy: boolean = false;

  async verify(): Promise<void> {
    this.busy = true;
    this.error = '';
    try {
      const client: RestClient = new RestClient(this.serverUrl.trim(), this.token.trim());
      // POST with the token in the BODY — not GET with a Bearer header.
      // This endpoint is registered before the auth guard, so it is the one
      // route that authenticates by payload rather than by header.
      const payload: VerifyRequest = { token: this.token.trim() };
      await client.postJson('/api/auth/verify', JSON.stringify(payload));
      await AuthStore.instance.save(this.serverUrl.trim(), this.token.trim());
    } catch (err) {
      this.error = err instanceof UnauthorizedError ? 'Token 无效' : '无法连接服务器';
    } finally {
      this.busy = false;
    }
  }

  build() {
    Column({ space: 16 }) {
      Text('cc-pet').fontSize(28).fontWeight(FontWeight.Bold)
      TextInput({ placeholder: 'https://your-server', text: this.serverUrl })
        .onChange((value: string) => { this.serverUrl = value; })
        .width('100%')
      TextInput({ placeholder: 'Token', text: this.token })
        .type(InputType.Password)
        .onChange((value: string) => { this.token = value; })
        .width('100%')
      if (this.error.length > 0) {
        Text(this.error).fontColor(Color.Red).fontSize(13)
      }
      Button(this.busy ? '验证中…' : '登录')
        .enabled(!this.busy && this.serverUrl.length > 0 && this.token.length > 0)
        .onClick(() => { this.verify(); })
        .width('100%')
    }
    .padding(24)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
```

- [ ] **Step 5: 在 Index 页面装配**

`harmony/entry/src/main/ets/pages/Index.ets` 改为：

```typescript
import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { common } from '@kit.AbilityKit';

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;

  async aboutToAppear(): Promise<void> {
    await AuthStore.instance.init(getContext(this) as common.UIAbilityContext);
    this.ready = true;
  }

  build() {
    Column() {
      if (!this.ready) {
        Text('加载中…')
      } else if (!AuthStore.instance.authorized) {
        LoginGate()
      } else {
        Text(`已登录：${AuthStore.instance.baseUrl}`).fontSize(16)
      }
    }
    .width('100%')
    .height('100%')
  }
}
```

- [ ] **Step 6: 真机验证**

装到真机，用你的公网地址与真实 token 登录。

Expected：输错 token 显示「Token 无效」；输对后界面变为「已登录：<地址>」；**杀掉应用重开仍显示已登录**（验证持久化生效）。

- [ ] **Step 7: 提交**

```bash
git add harmony/entry/src/main/ets/gateway/RestClient.ets harmony/entry/src/main/ets/store/AuthStore.ets harmony/entry/src/main/ets/components/LoginGate.ets harmony/entry/src/main/ets/pages/Index.ets harmony/entry/src/main/module.json5
git commit -m "feat(harmony): add rest client, token storage and login gate"
```

---

### Task 10B: REST 端点契约守卫

Task 2 的漂移守卫只比对 WS 事件名。REST 一侧完全没有守卫，结果是 `/api/auth/verify` 的方法写错（GET+Bearer 头，实际是 POST+body）一路走到真机才暴露——而服务端自己的 27 个测试也没有一个覆盖鉴权路径。本任务把守卫补到 REST 一侧。

**Files:**
- Create: `harmony/entry/src/main/ets/model/Endpoints.ets`
- Modify: `packages/server/tests/harmony-protocol-alignment.test.ts`
- Modify: `harmony/entry/src/main/ets/components/LoginGate.ets`（改为引用 `Endpoints`，不再硬编码路径）

**Interfaces:**
- Consumes: 无
- Produces: `interface Endpoint { method: string; path: string }` 与 `Endpoints` 常量类，供 Task 11 / 13 / 15 / 17 的所有 gateway 引用。**此后任何 gateway 不得再硬编码 REST 路径。**

- [ ] **Step 1: 集中声明端点**

`harmony/entry/src/main/ets/model/Endpoints.ets`：

```typescript
export interface Endpoint {
  method: string;
  path: string;
}

/**
 * Every REST endpoint the client calls, declared once.
 *
 * Paths use the server's own parameter syntax (`:chatKey`) so the alignment
 * guard can match them against the routes fastify actually registers. Build
 * concrete URLs with the helpers below rather than concatenating by hand.
 */
export class Endpoints {
  static readonly AUTH_VERIFY: Endpoint = { method: 'POST', path: '/api/auth/verify' };
  static readonly SESSIONS: Endpoint = { method: 'GET', path: '/api/sessions' };
  static readonly HISTORY: Endpoint = { method: 'GET', path: '/api/history/:chatKey' };
  static readonly PET_IMAGE: Endpoint = { method: 'GET', path: '/api/pet-images/:state' };
  static readonly FILE: Endpoint = { method: 'GET', path: '/api/files/:fileId' };
  static readonly BRIDGE_CONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/connect' };
  static readonly BRIDGE_DISCONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/disconnect' };
}

/** `/api/history/:chatKey` → `/api/history/c1%3A%3As1` */
export function historyUrl(chatKey: string, afterSeq: number, limit: number): string {
  const base: string = `/api/history/${encodeURIComponent(chatKey)}`;
  return afterSeq > 0 ? `${base}?afterSeq=${afterSeq}&limit=${limit}` : `${base}?limit=${limit}`;
}

export function petImageUrl(state: string): string {
  return `/api/pet-images/${encodeURIComponent(state)}`;
}

export function fileUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

export function bridgeConnectUrl(bridgeId: string, connect: boolean): string {
  const action: string = connect ? 'connect' : 'disconnect';
  return `/api/bridges/${encodeURIComponent(bridgeId)}/${action}`;
}
```

- [ ] **Step 2: 写失败的契约测试**

在 `packages/server/tests/harmony-protocol-alignment.test.ts` 末尾追加：

```typescript
const endpointsPath = resolve(here, "../../../harmony/entry/src/main/ets/model/Endpoints.ets");
const serverSrc = resolve(here, "../src");

/** Routes fastify actually registers, including the generic-typed multi-line form. */
function registeredRoutes(): Set<string> {
  const files = globSync("**/*.ts", { cwd: serverSrc, absolute: true }).filter(
    (f) => !f.endsWith(".test.ts"),
  );
  const routes = new Set<string>();
  const re = /\bapp\.(get|post|put|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*"([^"]+)"/g;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(re)) {
      routes.add(`${m[1].toUpperCase()} ${m[2]}`);
    }
  }
  return routes;
}

describe("harmony REST endpoint alignment", () => {
  it("declares only endpoints the server actually registers, with matching methods", () => {
    const declared = Array.from(
      readFileSync(endpointsPath, "utf8").matchAll(
        /static readonly [A-Z_]+: Endpoint = \{ method: '([A-Z]+)', path: '([^']+)' \}/g,
      ),
    ).map((m) => `${m[1]} ${m[2]}`);

    expect(declared.length).toBeGreaterThan(0);
    const routes = registeredRoutes();
    const missing = declared.filter((d) => !routes.has(d));
    expect(missing).toEqual([]);
  });
});
```

`globSync` 从 `node:fs` 导入（Node 22+）；若该版本不可用，改用 `readdirSync` 递归，逻辑不变。

- [ ] **Step 3: 跑测试确认通过**

```bash
cd /Users/StevenZhu/code/cc-pet-web
pnpm --filter @cc-pet/server exec vitest run tests/harmony-protocol-alignment.test.ts
```

Expected: 3 passed（2 个 WS 用例 + 1 个 REST 用例）

- [ ] **Step 4: 验证守卫真的会响 —— 两种错法都要试**

这一步是本任务存在的理由，不可跳过：

1. 把 `AUTH_VERIFY` 的 `method` 改成 `'GET'`，重跑 → **必须失败**，报缺 `GET /api/auth/verify`。这正是真机上踩到的那个 bug，守卫此前抓不到它。
2. 改回 POST，把 `path` 改成 `'/api/auth/verifyx'`，重跑 → **必须失败**。
3. 全部改回，确认 3 passed。

把两次失败的输出记进报告。**没观察到失败的守卫等于没有守卫。**

- [ ] **Step 5: LoginGate 改为引用 Endpoints**

把 `LoginGate.ets` 里硬编码的 `'/api/auth/verify'` 换成 `Endpoints.AUTH_VERIFY.path`。行为不变，但从此路径只有一处定义。

重新构建安装到真机，确认登录仍然可用（命令见 Global Constraints）。

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/model/Endpoints.ets packages/server/tests/harmony-protocol-alignment.test.ts harmony/entry/src/main/ets/components/LoginGate.ets
git commit -m "feat(harmony): guard REST endpoint methods against the server routes"
```

---

### Task 11: ConnectionGateway 与状态存储

**Files:**
- Create: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Create: `harmony/entry/src/main/ets/gateway/NotificationGateway.ets`（本任务只建打日志的占位实现，Task 14 替换内部逻辑）
- Create: `harmony/entry/src/main/ets/store/ChatStore.ets`
- Create: `harmony/entry/src/main/ets/store/SessionStore.ets`
- Create: `harmony/entry/src/main/ets/store/TaskStore.ets`
- Create: `harmony/entry/src/main/ets/store/ConnectionStore.ets`
- Modify: `harmony/entry/src/main/ets/entryability/EntryAbility.ets`

**Interfaces:**
- Consumes: `backoffDelayMs`、`normalizeEvent`、`Outbox`、`WsEvents`、`AuthStore`
- Produces:
  - `type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'backoff'`
> **契约现状（最终修复轮回写）**：下面这份清单已按 HEAD 实际暴露的接口更新过一次。两点必须先说清楚：
>
> 1. **四个 store 一律通过 `XxxStore.connect()` 获取，不是 `XxxStore.instance`。** 本文原稿写的是 `static readonly instance`，那个写法不会把消费者注册成 ArkUI V2 的观察者，组件静默不刷新——见 `.superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md`。Gateway 侧相反：它们不持有 `@Trace` 状态、没人反应式地观察它们，所以保持 `static readonly instance`。这条 store/gateway 分界是本分支最重要的约定，每个 store 和 gateway 的类注释里都写明了自己在哪一边。
> 2. Gateway 没有 `@Trace` 状态，也就没有"gateway 通知 UI"的通道。最终修复轮补上了这个缺口：`ConnectionStore` 上的 `outboxRevision` 与 `historyErrorOf/setHistoryError` 就是那条被批准的通道（`MessageList` 因此删掉了它那个 1Hz 的 `setInterval`）。gateway 要往 UI 送信号，走这里，不要往 gateway 上加 `@Trace`。

  - `ConnectionGateway.instance`：`start(baseUrl: string, token: string): void`、`stop(): void`、`setForeground(value: boolean): void`、`sendMessage(chatKey: string, text: string): string`（返回 clientMsgId）、`retry(clientMsgId: string): void`、`outboxEntriesOf(chatKey: string): OutboxStatusView[]`（UI 读发送态用；发送状态只此一份，不要在消息上另设状态字段。`OutboxStatusView { clientMsgId: string; status: OutboxStatus }` 是 Task 12 修复轮收窄后的只读快照类型，定义在 `ConnectionGateway.ets`——只暴露 UI 需要的两个字段，不再把完整的 `OutboxEntry`（含 `text`/`policy`/`createdAt`/`transmittedAt`）交给 UI）、`retryHistory(chatKey: string): void`（`ErrorBanner` 的"重试"按钮；Task 17 新增，此前漏记，这是本文档记录的第三次契约变更）
    - `stop()` 不只是断开连接：它同时清空 Outbox、`ChatStore.clearAll()` 和 `ConnectionStore.clearHistoryErrors()`。三条登出路径都汇到这里，而 gateway 与各 store 都是进程级单例，不清的话上一个账号排队未发的消息会在下一个账号连上时被 `flushOutbox()` 发出去，整段历史也会留在界面上。
    - Task 17 的 `historyErrorFlag(): boolean` **已删除**：该标志改为按 chatKey 存在 `ConnectionStore` 上（见下），UI 直接读 store，不再需要 gateway 转发一个自己观察不到的值。
    - 历史补齐的实现已抽到 `HistoryBackfill`（见下），gateway 只留一个转发。
  - `HistoryBackfill`（`gateway/HistoryBackfill.ets`，非单例，每次 `ConnectionGateway.start()` 新建一个）：`constructor(baseUrl: string, token: string, onUnauthorized: () => void)`、`run(chatKey: string): void`。从 `ConnectionGateway` 抽出的唯一一块边界干净的职责（原 `backfillInFlight`/`historyError`/`backfillHistory`/`retryHistory`/`historyErrorFlag`，约 90 行）。失败时写 `ConnectionStore.setHistoryError(chatKey, true)`；401 时调 `onUnauthorized`。
  - `HistoryApi`：`fetch(chatKey: string, cursor: number): Promise<HistoryBatch>`。返回类型由 `ChatMessage[]` 改为 `HistoryBatch { messages: ChatMessage[]; truncated: boolean }`——drain 循环撞上 `MAX_DRAIN_ITERATIONS` 时不再静默返回半截数据，`truncated: true` 让调用方把它接到既有的"横幅 + 重试"路径上。
  - `SessionApi`（`gateway/SessionApi.ets`，非单例，每次调用新建）：`fetch(connectionId: string): Promise<Session[]>`、`fetchAll(connectionIds: string[]): Promise<Session[]>`。`/api/sessions` 必须带 `?connectionId=`，否则服务端返回空列表，所以按 manifest 里的每个 bridge 各发一次，用 `allSettled` 合并。
  - `ConnectionStore.connect()`：`phase: ConnectionPhase`、`connectedAtMs: number`、`bridgeConnected: boolean`、`outboxRevision: number`、`setPhase(phase: ConnectionPhase): void`、`markConnectedAt(at: number): void`、`setBridgeConnected(value: boolean): void`、`bumpOutboxRevision(): void`（ack sweep 在 `expireTimedOut()` 真的让条目超时时才调）、`historyErrorOf(chatKey: string): boolean`、`setHistoryError(chatKey: string, failed: boolean): void`、`clearHistoryErrors(): void`
  - `ChatStore.connect()`：`revision: number`（每次改动自增，供 `@Monitor` 挂副作用——`MessageList` 的滚到底就靠它，两个 map 是 private，`@Monitor` 路径点不到）、`messagesOf(chatKey: string): ChatMessage[]`、`streamingOf(chatKey: string): string`、`append(chatKey: string, message: ChatMessage): void`、`appendDelta(chatKey: string, delta: string): void`、`finalizeStream(chatKey: string, fullText: string, id: string, at: number, seq: number): void`、`replaceAll(chatKey: string, history: ChatMessage[]): void`、`applyAck(clientMsgId: string, serverId: string, seq: number): void`、`maxSeqOf(chatKey: string): number`、`clear(chatKey: string): void`、`clearAll(): void`（仅登出路径）
  - `SessionStore.connect()`：`currentChatKey: string`、`skillCommands: SlashCommandSpec[]`、`bridges: BridgeInfo[]`、`unreadOf(chatKey: string): number`、`totalUnread(): number`、`labelOf(chatKey: string): string`（会话名的**唯一**判定处：server label → manifest 里的 bridge 名 → session key → 原始 chatKey。此前 `SessionRow.labelForBridge` 与 `Index.currentSessionLabel()` 各写了一份 bridge 名兜底，而这里没有，于是通知标题上真的显示成 `b1::default`）、`isResident(chatKey: string): boolean`、`setCurrent(chatKey: string): void`、`incrementUnread(chatKey: string): void`、`setUnread(chatKey: string, count: number): void`、`clearUnread(chatKey: string): void`、`applyManifest(frame: WsFrame): void`、`applySessions(sessions: Session[]): void`（由 `ConnectionGateway.fetchSessions` 在每次 `bridge:manifest` 后调用；此前全程无人调用）、`applySkills(frame: WsFrame): void`
  - `TaskStore.connect()`：`phaseOf(chatKey: string): TaskPhase`、`setPhase(chatKey: string, phase: TaskPhase): void`
  - `NotificationGateway.instance`：`notifyReply(chatKey: string, title: string, body: string): Promise<void>`（Task 14 把原始占位签名 `notifyReply(title, body)` 加宽为带 `chatKey` 的三参版本——发布通知时要把 `chatKey` 哈希成通知 `id`，让同一会话的重复通知互相覆盖而不是堆叠；`title`/`body` 本身无法提供这个稳定的按会话 id，因为两个会话可能共享同一个 label。这是继 Task 12 收窄 `outboxEntriesOf` 之后本文档记录的第二次契约变更）

这份清单是 Task 12–17 的唯一契约来源——后续任务只许调用此处列出的方法。需要新方法时，先回到本任务补齐 store 再用。

- [ ] **Step 1: 写 stores**

四个 store 均为 `@ObservedV2` 单例，只存状态、不发网络请求。`ChatStore`：

```typescript
import { ChatMessage } from '../model/Protocol';

@ObservedV2
export class ChatStore {
  static readonly instance: ChatStore = new ChatStore();

  @Trace private messages: Map<string, ChatMessage[]> = new Map<string, ChatMessage[]>();
  @Trace private streaming: Map<string, string> = new Map<string, string>();

  messagesOf(chatKey: string): ChatMessage[] {
    return this.messages.get(chatKey) ?? [];
  }

  streamingOf(chatKey: string): string {
    return this.streaming.get(chatKey) ?? '';
  }

  append(chatKey: string, message: ChatMessage): void {
    const list: ChatMessage[] = this.messagesOf(chatKey).slice();
    list.push(message);
    this.messages.set(chatKey, list);
  }

  appendDelta(chatKey: string, delta: string): void {
    this.streaming.set(chatKey, this.streamingOf(chatKey) + delta);
  }

  finalizeStream(chatKey: string, fullText: string, id: string, at: number): void {
    this.streaming.delete(chatKey);
    this.append(chatKey, { id: id, role: 'assistant', content: fullText, timestamp: at });
  }

  /** message-ack arrived: swap the local id for the server's and record its seq. */
  applyAck(clientMsgId: string, serverId: string, seq: number): void {
    this.messages.forEach((list: ChatMessage[], key: string) => {
      let changed: boolean = false;
      const next: ChatMessage[] = [];
      for (const msg of list) {
        if (msg.id === clientMsgId) {
          next.push({
            id: serverId, role: msg.role, content: msg.content, timestamp: msg.timestamp,
            connectionId: msg.connectionId, sessionKey: msg.sessionKey, seq: seq,
          });
          changed = true;
        } else {
          next.push(msg);
        }
      }
      if (changed) {
        this.messages.set(key, next);
      }
    });
  }

  /** Highest server seq seen in this chat; 0 when none. Drives history backfill. */
  maxSeqOf(chatKey: string): number {
    let max: number = 0;
    for (const msg of this.messagesOf(chatKey)) {
      const seq: number = msg.seq ?? 0;
      if (seq > max) {
        max = seq;
      }
    }
    return max;
  }

  replaceAll(chatKey: string, history: ChatMessage[]): void {
    this.messages.set(chatKey, history);
  }

  clear(chatKey: string): void {
    this.messages.delete(chatKey);
    this.streaming.delete(chatKey);
  }
}
```

`SessionStore` 持有会话列表、`currentChatKey`、未读计数、`skillCommands`，以及一个 `residentKeys: Set<string>`。**未读有两个来源**（spec 6.3）：`incrementUnread` 对 `residentKeys` 内的 chatKey 直接 return，只有 `setUnread` 能改它们——服务端是常驻会话未读的唯一真相。`applySessions` 根据 `Session.isResident` 重建 `residentKeys`，并用 `Session.unreadCount` 初始化未读。

`TaskStore` 持有每个 chatKey 的 `TaskPhase`；`ConnectionStore` 持有 `phase`、`connectedAtMs`、`bridgeConnected`。

`NotificationGateway` 本任务只写占位实现，让 `ConnectionGateway` 能编译：

```typescript
/** Placeholder until Task 14 wires real notifications. Signature is final. */
export class NotificationGateway {
  static readonly instance: NotificationGateway = new NotificationGateway();

  async notifyReply(title: string, body: string): Promise<void> {
    console.info(`[cc-pet] would notify: ${title} / ${body}`);
  }
}
```

- [ ] **Step 2: 实现 ConnectionGateway**

`harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`：

```typescript
import { webSocket, connection } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { backoffDelayMs } from '../logic/backoff';
import { normalizeEvent, WsFrame, NormalizedEvent } from '../logic/normalizeEvent';
import { Outbox, OutboxEntry, RetryPolicy } from '../logic/outbox';
import { WsEvents, ChatMessage } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { NotificationGateway } from './NotificationGateway';

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'backoff';

const ACK_SWEEP_MS: number = 5000;

interface OutgoingEnvelope {
  type: string;
  connectionId: string;
  sessionKey: string;
  content: string;
  clientMsgId: string;
}

export class ConnectionGateway {
  static readonly instance: ConnectionGateway = new ConnectionGateway();

  private socket: webSocket.WebSocket | undefined = undefined;
  private netConn: connection.NetConnection | undefined = undefined;
  private attempt: number = 0;
  private timer: number = -1;
  private sweepTimer: number = -1;
  private baseUrl: string = '';
  private token: string = '';
  private outbox: Outbox = new Outbox();
  private stopped: boolean = true;
  private foreground: boolean = true;

  start(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
    this.stopped = false;
    this.attempt = 0;
    this.observeNetwork();
    this.startAckSweep();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.sweepTimer !== -1) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = -1;
    }
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.netConn !== undefined) {
      this.netConn.unregister(() => {});
      this.netConn = undefined;
    }
    ConnectionStore.instance.setPhase('disconnected');
  }

  setForeground(value: boolean): void {
    this.foreground = value;
  }

  private clearTimer(): void {
    if (this.timer !== -1) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }

  private wsUrl(): string {
    const scheme: string = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host: string = this.baseUrl.replace(/^https?/, '');
    return `${scheme}${host}/ws?token=${encodeURIComponent(this.token)}`;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }
    this.clearTimer();
    ConnectionStore.instance.setPhase('connecting');

    if (this.socket !== undefined) {
      this.socket.close();
    }
    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    this.socket = socket;

    socket.on('open', () => {
      this.attempt = 0;
      ConnectionStore.instance.setPhase('connected');
      ConnectionStore.instance.markConnectedAt(Date.now());
      this.flushOutbox();
    });

    socket.on('message', (err: Error | undefined, data: string | ArrayBuffer) => {
      if (err !== undefined || typeof data !== 'string') {
        return;
      }
      // The server spreads payload fields onto the top level, so the frame
      // parses directly — no envelope unwrapping, no shim.
      this.dispatch(normalizeEvent(JSON.parse(data as string) as WsFrame));
    });

    socket.on('close', () => { this.scheduleReconnect(); });
    socket.on('error', () => { this.scheduleReconnect(); });

    socket.connect(this.wsUrl(), (err: Error | undefined) => {
      if (err !== undefined) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== -1) {
      return;
    }
    ConnectionStore.instance.setPhase('backoff');
    const delay: number = backoffDelayMs(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = -1;
      this.open();
    }, delay);
  }

  /** Network came back: retry immediately instead of waiting out the backoff. */
  private observeNetwork(): void {
    if (this.netConn !== undefined) {
      return;
    }
    const netConn: connection.NetConnection = connection.createNetConnection();
    this.netConn = netConn;
    netConn.on('netAvailable', () => {
      // Only reconnect if we are actually down. netAvailable also fires on
      // Wi-Fi/cellular handoff and DHCP renewal; tearing down a healthy socket
      // there would re-run flushOutbox and re-send messages already awaiting ack.
      const phase: ConnectionPhase = ConnectionStore.connect().phase;
      if (phase === 'connected' || phase === 'connecting') {
        return;
      }
      this.attempt = 0;
      this.clearTimer();
      this.open();
    });
    netConn.register(() => {});
  }

  /** Entries whose ack never arrived turn failed, so their bubbles can go red. */
  private startAckSweep(): void {
    if (this.sweepTimer !== -1) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.outbox.expireTimedOut(Date.now());
    }, ACK_SWEEP_MS);
  }

  sendMessage(chatKey: string, text: string): string {
    const clientMsgId: string = util.generateRandomUUID(true);
    const parts: string[] = chatKey.split('::');
    const connectionId: string = parts[0] ?? '';
    const sessionKey: string = parts[1] ?? '';
    const now: number = Date.now();

    ChatStore.instance.append(chatKey, {
      id: clientMsgId, role: 'user', content: text, timestamp: now,
      connectionId: connectionId, sessionKey: sessionKey,
    });

    const policy: RetryPolicy = 'auto';
    this.outbox.enqueue(clientMsgId, chatKey, text, policy, now);
    if (ConnectionStore.instance.phase === 'connected') {
      this.transmit([clientMsgId]);
    }
    return clientMsgId;
  }

  /** User tapped retry on one failed bubble. */
  retry(clientMsgId: string): void {
    this.outbox.resend(clientMsgId, Date.now());
    if (ConnectionStore.instance.phase === 'connected') {
      this.transmit([clientMsgId]);
    }
  }

  private transmit(ids: string[]): void {
    if (this.socket === undefined) {
      return;
    }
    const sent: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      let wanted: boolean = false;
      for (const id of ids) {
        if (entry.clientMsgId === id) {
          wanted = true;
        }
      }
      if (!wanted) {
        continue;
      }
      const parts: string[] = entry.chatKey.split('::');
      const envelope: OutgoingEnvelope = {
        type: WsEvents.SEND_MESSAGE,
        connectionId: parts[0] ?? '',
        sessionKey: parts[1] ?? '',
        content: entry.text,
        clientMsgId: entry.clientMsgId,
      };
      this.socket.send(JSON.stringify(envelope));
      sent.push(entry.clientMsgId);
    }
    this.outbox.markTransmitted(sent, Date.now());
  }

  /** Reconnect path: everything still sendable goes back out, oldest first. */
  private flushOutbox(): void {
    this.outbox.reviveAuto(Date.now());
    const ids: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      ids.push(entry.clientMsgId);
    }
    this.transmit(ids);
  }

  /**
   * Notification predicate: is the user not looking at this chat right now?
   * Deliberately separate from unread counting — resident sessions take their
   * unread from the server, but "should I buzz" is always a local question.
   */
  private isAway(chatKey: string): boolean {
    return chatKey !== SessionStore.instance.currentChatKey || !this.foreground;
  }

  private dispatch(event: NormalizedEvent): void {
    if (event.type === WsEvents.MESSAGE_ACK) {
      const clientMsgId: string = event.frame.clientMsgId ?? '';
      if (clientMsgId.length === 0) {
        return;
      }
      this.outbox.markSent(clientMsgId);
      ChatStore.instance.applyAck(clientMsgId, event.frame.id ?? clientMsgId, event.frame.seq ?? 0);
      return;
    }
    if (event.type === WsEvents.RESIDENT_UNREAD) {
      SessionStore.instance.setUnread(event.chatKey, event.frame.unreadCount ?? 0);
      return;
    }
    if (event.type === WsEvents.BRIDGE_CONNECTED) {
      ConnectionStore.instance.setBridgeConnected(true);
      ConnectionStore.instance.markConnectedAt(Date.now());
      return;
    }
    if (event.type === WsEvents.BRIDGE_ERROR) {
      ConnectionStore.instance.setBridgeConnected(false);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MANIFEST) {
      SessionStore.instance.applyManifest(event.frame);
      return;
    }
    if (event.type === WsEvents.BRIDGE_SKILLS_UPDATED) {
      SessionStore.instance.applySkills(event.frame);
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_START) {
      TaskStore.instance.setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_STOP) {
      TaskStore.instance.setPhase(event.chatKey, 'completed');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DELTA) {
      ChatStore.instance.appendDelta(event.chatKey, event.frame.delta ?? '');
      TaskStore.instance.setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DONE) {
      const text: string = event.frame.fullText ?? '';
      // Use the server's own id and seq. Synthesising them breaks maxSeqOf(),
      // which Task 17's incremental history backfill reads as its cursor.
      ChatStore.instance.finalizeStream(
        event.chatKey, text,
        event.frame.msgId ?? `srv-${Date.now()}`,
        Date.now(), event.frame.seq ?? 0,
      );
      TaskStore.instance.setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, text);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MESSAGE) {
      const text: string = event.frame.content ?? '';
      const message: ChatMessage = {
        id: event.frame.msgId ?? `srv-${Date.now()}`,
        role: 'assistant', content: text, timestamp: Date.now(),
        connectionId: event.connectionId, sessionKey: event.sessionKey,
        seq: event.frame.seq,
      };
      ChatStore.instance.append(event.chatKey, message);
      TaskStore.instance.setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, text);
    }
  }

  private afterAssistantReply(chatKey: string, text: string): void {
    if (!this.isAway(chatKey)) {
      return;
    }
    // Resident sessions get their unread from resident:unread; incrementUnread
    // is a no-op for them by design (see SessionStore).
    SessionStore.instance.incrementUnread(chatKey);
    NotificationGateway.instance.notifyReply(
      SessionStore.instance.labelOf(chatKey),
      text.length > 80 ? `${text.slice(0, 80)}…` : text,
    );
  }
}
```

- [ ] **Step 3: 在 EntryAbility 里接前后台**

`harmony/entry/src/main/ets/entryability/EntryAbility.ets` 的 `onForeground` / `onBackground` 各调一行 `ConnectionGateway.instance.setForeground(true/false)`，不做别的。

- [ ] **Step 4: 真机验证连接与 ack**

装到真机，登录后在日志里确认：`phase` 依次为 `connecting → connected`；从 web 端发一条消息，鸿蒙端日志打印出归一化后的 `chatKey`。

发一条消息，确认日志里出现 `message-ack`，且该消息的 id 被替换为服务端 id。

然后开飞行模式 10 秒再关闭，确认日志出现退避重连、最终回到 `connected`，且断网期间输入的消息在重连后被补发。

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/gateway harmony/entry/src/main/ets/store harmony/entry/src/main/ets/entryability/EntryAbility.ets
git commit -m "feat(harmony): add ws gateway with ack-tracked outbox and stores"
```

---

### Task 12: 聊天界面（消息列表、markdown 渲染、输入发送）

**Files:**
- Create: `harmony/entry/src/main/ets/components/MarkdownView.ets`
- Create: `harmony/entry/src/main/ets/components/MessageList.ets`
- Create: `harmony/entry/src/main/ets/components/MessageInput.ets`
- Create: `harmony/entry/src/main/ets/components/ChatWindow.ets`
- Modify: `harmony/entry/src/main/ets/pages/Index.ets`

**Interfaces:**
- Consumes: `ChatStore`、`SessionStore`、`ConnectionGateway`、`parseMarkdown`、`parseInline`
- Produces: `ChatWindow()` 组件，供 `Index` 与后续断点布局复用。

- [ ] **Step 1: 实现 MarkdownView**

按 `MdNode.kind` 分支渲染：`heading` 用递增字号；`paragraph`/`quote` 用 `Text` 承载 `parseInline` 得到的 `MdSpan[]`（`bold` → `FontWeight.Bold`，`italic` → `FontStyle.Italic`，`code` → 等宽 + 浅底，`link` → 主题色 + 点击调 `@kit.BasicServicesKit` 打开浏览器，`image` → `Image` 组件）；`list` 用 `ForEach` 加前缀（有序为 `${i + 1}.`，无序为 `•`）；`table` 用嵌套 `Row`/`Column` + 边框；`code` 用 `Scroll({ scrollable: ScrollDirection.Horizontal })` 包一个等宽 `Text`，右上角放复制按钮，点击调用 `pasteboard` 写入。

- [ ] **Step 2: 实现 MessageList**

**已知限制（Task 12 实测）**：消息列表用的是 `ForEach` 而非 `LazyForEach`。`LazyForEach` 需要在 `build()` 之前准备数据源，而 ArkTS 不允许 `build()` 内出现前置命令式语句；正确接法还需引入 `@Monitor`，与本工程其余部分的写法不一致。当前消息规模下无影响，**但 Task 17 的历史增量回填会推高单会话消息数，届时需重新评估**。

用 `List` + `LazyForEach` 渲染 `ChatStore.instance.messagesOf(currentChatKey)`；user 气泡右对齐、assistant 左对齐。

**回复有两条到达路径，都要处理**：
1. 真流式（部分 bridge）：`streamingOf(chatKey)` 非空时在列表末尾追加气泡，内容用纯 `Text` 直接显示，**不调 `parseMarkdown`**——每几十毫秒重解析整段会掉帧。`bridge:stream-done` 后该气泡被正式消息取代，此时才走 `MarkdownView`。
2. 整块到达（cc-connect 的 claudecode 回复没有 token 级流）：`bridge:message` 直接携带完整文本，正常走 `MarkdownView`。首版不实现 web 端那个纯视觉的本地打字机。

**发送态**：气泡的发送状态来自 `Outbox`，不在 `ChatStore` 里另存一份。`failed` 的气泡标红并显示重试按钮，点击调 `ConnectionGateway.instance.retry(clientMsgId)`。

- [ ] **Step 3: 实现 MessageInput**

多行 `TextArea` + 发送按钮（**首版无附件上传**，见 spec 第 2 节）。点击发送时调 `ConnectionGateway.instance.sendMessage(chatKey, text)` 并清空输入框。socket 未连接时按钮保持可用——消息进 Outbox，重连后自动补发。

- [ ] **Step 4: 组装 ChatWindow 并接入 Index**

`ChatWindow` 自上而下为 `MessageList`（`layoutWeight(1)`）+ `MessageInput`。`Index` 在已登录分支渲染 `ChatWindow()`，并在 `aboutToAppear` 里调 `ConnectionGateway.instance.start(...)`。

- [ ] **Step 5: 真机验证一轮完整对话**

发一条消息 → 看到流式文字逐步出现 → 结束后排版落定（标题、列表、代码块正确渲染）→ 代码块能横向滚动、复制按钮可用。

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/components harmony/entry/src/main/ets/pages/Index.ets
git commit -m "feat(harmony): render chat with markdown and streaming input"
```

---

### Task 13: 宠物与图片缓存

**Files:**
- Create: `harmony/entry/src/main/ets/gateway/PetImageCache.ets`
- Create: `harmony/entry/src/main/ets/components/PetMini.ets`
- Create: `harmony/entry/src/main/resources/base/media/pet_idle.png` 等 5 张
- Modify: `harmony/entry/src/main/ets/components/ChatWindow.ets`

**Interfaces:**
- Consumes: `derivePetState`、`ConnectionStore`、`TaskStore`、`SessionStore`、`RestClient`
- Produces: `PetMini()` 组件；`PetImageCache.instance.uriFor(state: PetState): Promise<string>`

- [ ] **Step 1: 放入内置宠物图**

把 `packages/web/src/assets/pet/{idle,thinking,talking,happy,error}-256.webp` 复制到 `harmony/entry/src/main/resources/base/media/`，重命名为 `pet_idle.webp` 等（HarmonyOS 资源名不允许连字符，且必须小写）。

**用 256px 的 webp，不要用原始 PNG。** 宠物在界面上只有 22vp（约 66px），而源 PNG 每张 670–800 KB、五张合计 3.6 MB——会占掉整个安装包的 88%。同目录下的 `-256.webp` 变体五张合计 64 KB，小 57 倍，在 22vp 的显示尺寸下肉眼无差别。ArkUI 的 `Image` 原生支持 webp。

- [ ] **Step 2: 实现 PetImageCache**

按 token 拉取 `/api/pet-images/:state`，写入应用沙箱 `context.filesDir/pet/<tokenHash>/<state>.png`；命中缓存直接返回 `file://` URI；网络失败或 404 返回 `$r('app.media.pet_idle')` 一类的内置资源标识。**缓存键必须含 token**，否则换 token 后会显示上一个用户的宠物图。

- [ ] **Step 3: 实现 PetMini**

22vp 圆形 `Image`，图源为 `PetImageCache` 的结果。状态由 `derivePetState` 派生，输入来自三个 store：

```typescript
const state: PetState = derivePetState({
  taskPhase: TaskStore.instance.phaseOf(SessionStore.instance.currentChatKey),
  hasUnread: SessionStore.instance.totalUnread() > 0,
  bridgeConnected: ConnectionStore.instance.bridgeConnected,
  msSinceConnected: Date.now() - ConnectionStore.instance.connectedAtMs,
});
```

切换时用 `animateTo({ duration: 200 })` 做一次透明度过渡。**组件内不得出现任何 `if (event.type === ...) setPetState(...)` 式的命令写法。**

- [ ] **Step 4: 真机验证五态**

发消息时变 thinking；回复完且停留在当前会话时回 idle；切到别的会话让消息到达，变 talking；断网变 error；恢复连接 3 秒内为 happy。

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/gateway/PetImageCache.ets harmony/entry/src/main/ets/components/PetMini.ets harmony/entry/src/main/resources/base/media harmony/entry/src/main/ets/components/ChatWindow.ets
git commit -m "feat(harmony): add derived pet avatar with per-token image cache"
```

---

### Task 14: 本地通知

**Files:**
- Create: `harmony/entry/src/main/ets/gateway/NotificationGateway.ets`
- Modify: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Modify: `harmony/entry/src/main/module.json5`

**Interfaces:**
- Consumes: `@kit.NotificationKit`, `@kit.AbilityKit`, `@kit.BasicServicesKit`
- Produces: `interface Notifier { notifyReply(chatKey: string, title: string, body: string): Promise<void> }`；`NotificationGateway.instance` 实现该接口。

接口化是刻意的：将来换 Push Kit 只替换实现，`ConnectionGateway` 不动。

**实测契约变更**：签名比 Task 11 占位版多了一个前置 `chatKey` 参数。通知 `id` 要按 chatKey 哈希（本任务要求，见下），同一会话的重复通知才能互相覆盖而不是堆叠；`title`/`body` 单独提供不了这个稳定的按会话 id。`ConnectionGateway.afterAssistantReply` 的调用点已同步改为 `notifyReply(chatKey, title, body)`。

- [ ] **Step 1: 声明通知权限并申请**

**不要声明 `ohos.permission.NOTIFICATION_CONTROLLER`。** 该权限在本 SDK 下是 `system_core` 级，普通应用声明它会导致 **HAP 安装直接失败**（Task 14 实测撞到 `hdc install` 报错；同机的 Tailscale-OHOS 参考工程也未声明它）。发布本地通知**不需要任何权限声明**，`module.json5` 在本任务中保持不变。

首次进入聊天页时调用 `notificationManager.requestEnableNotification()` 请求用户开启通知开关（这是运行时开关，不是权限声明）。用户拒绝时必须优雅降级：聊天照常可用，只是不弹通知，不得反复弹窗或阻塞界面。

- [ ] **Step 2: 实现 NotificationGateway**

用 `notificationManager.publish` 发基础文本通知，`id` 用 chatKey 的哈希，使同一会话的通知互相覆盖而不是堆叠。

- [ ] **Step 3: 在 dispatch 里接入**

仅当 `event.chatKey !== SessionStore.instance.currentChatKey || !this.foreground` 时发通知——**与未读判定用同一个条件表达式**，不要各写一套（spec 6.3 已写死此规则）。

触发时机：`bridge:message` 到达，或 `bridge:stream-done` 且该会话 typing 已停止。

- [ ] **Step 4: 真机验证**

打开应用 → 按 Home 键退到后台 → 从 web 端发消息触发回复 → 确认收到通知；点击通知能拉起应用。

再验证反例：应用在前台且停留在该会话时，**不应**收到通知。

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/gateway/NotificationGateway.ets harmony/entry/src/main/ets/gateway/ConnectionGateway.ets harmony/entry/src/main/module.json5
git commit -m "feat(harmony): notify on background replies via local notifications"
```

---

### Task 15: slash command 浮层

**Files:**
- Create: `harmony/entry/src/main/ets/components/SlashCommandMenu.ets`
- Modify: `harmony/entry/src/main/ets/components/MessageInput.ets`
- Modify: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Modify: `harmony/entry/src/main/ets/store/SessionStore.ets`

**Interfaces:**
- Consumes: `mergeCommands`、`matchCommands`、`isSlashInput`
- Produces: `SlashCommandMenu({ input: string, onPick: (spec: SlashCommandSpec) => void })`

- [ ] **Step 1: 接收 skills 事件**

在 `ConnectionGateway.dispatch` 中处理 `WsEvents.BRIDGE_SKILLS_UPDATED`，把 payload 里的命令数组存进 `SessionStore.instance.skillCommands`。

- [ ] **Step 2: 实现浮层组件**

输入以 `/` 开头时显示，数据为 `matchCommands(mergeCommands(skills), input)`，按 `category` 分组显示小标题。**浮层锚定在输入框上方**（`Stack` + `.align(Alignment.Bottom)` 或 `offset` 向上）——手机上输入框紧贴键盘，向下弹必被遮挡。

- [ ] **Step 3: 接入 MessageInput 并执行命令**

选中后：`type === 'send'` 的命令填入输入框（保留参数位，让用户接着打）；`type === 'local'` 的命令本地执行——`/clear` 调 `ChatStore.instance.clear(chatKey)`，`/settings` 打开设置，`/connect` 与 `/disconnect` 调 `RestClient` 的 `/api/bridges/:id/connect` 与 `/api/bridges/:id/disconnect`。

- [ ] **Step 4: 真机验证**

输入 `/` 看到完整列表且 builtin 在最前；输入 `/mo` 只剩 `/model`；选 `/clear` 后消息清空；选 `/model` 后输入框变成 `/model ` 等待参数。

- [ ] **Step 5: 提交**

```bash
git add harmony/entry/src/main/ets/components/SlashCommandMenu.ets harmony/entry/src/main/ets/components/MessageInput.ets harmony/entry/src/main/ets/gateway/ConnectionGateway.ets harmony/entry/src/main/ets/store/SessionStore.ets
git commit -m "feat(harmony): add slash command palette above the input"
```

---

### Task 16: 会话切换与三档断点

**Files:**
- Create: `harmony/entry/src/main/ets/components/ResponsiveLayout.ets`
- Create: `harmony/entry/src/main/ets/components/SessionSheet.ets`
- Create: `harmony/entry/src/main/ets/components/SessionSidebar.ets`
- Create: `harmony/entry/src/main/ets/components/ConnectionBadge.ets`
- Create: `harmony/entry/src/test/ResponsiveLayout.test.ets`
- Modify: `harmony/entry/src/main/ets/pages/Index.ets`
- Modify: `harmony/entry/src/test/List.test.ets`

**Interfaces:**
- Consumes: `SessionStore`、`ConnectionStore`
- Produces: `ResponsiveLayout.widthClass(width: number): ResponsiveWidthClass`、`ResponsiveLayout.usesSideSessions(width: number): boolean`、`ResponsiveLayout.contentMaxWidth(width: number): number`

- [ ] **Step 1: 移植断点纯函数并写测试**

从 `/Users/StevenZhu/code/Tailscale-OHOS/entry/src/main/ets/components/ResponsiveLayout.ets` 复制 `ResponsiveWidthClass` 枚举与 `widthClass` / `pageMargin`，删去 cc-pet 用不到的部分（`TransferContentLayout`、`SettingsContentLayout` 等），追加两个方法：

```typescript
static usesSideSessions(width: number): boolean {
  return width >= ResponsiveLayout.MEDIUM_MIN_WIDTH;
}

static contentMaxWidth(width: number): number {
  return width >= ResponsiveLayout.EXPANDED_MIN_WIDTH
    ? ResponsiveLayout.EXPANDED_CONTENT_MAX_WIDTH
    : width;
}
```

测试 `harmony/entry/src/test/ResponsiveLayout.test.ets`：

```typescript
import { describe, it, expect } from '@ohos/hypium';
import { ResponsiveLayout, ResponsiveWidthClass } from '../main/ets/components/ResponsiveLayout';

export default function responsiveLayoutTest() {
  describe('ResponsiveLayout', () => {
    it('classifies the three width bands', 0, () => {
      expect(ResponsiveLayout.widthClass(599)).assertEqual(ResponsiveWidthClass.COMPACT);
      expect(ResponsiveLayout.widthClass(600)).assertEqual(ResponsiveWidthClass.MEDIUM);
      expect(ResponsiveLayout.widthClass(839)).assertEqual(ResponsiveWidthClass.MEDIUM);
      expect(ResponsiveLayout.widthClass(840)).assertEqual(ResponsiveWidthClass.EXPANDED);
    });

    it('uses side sessions from medium up', 0, () => {
      expect(ResponsiveLayout.usesSideSessions(599)).assertEqual(false);
      expect(ResponsiveLayout.usesSideSessions(600)).assertEqual(true);
    });

    it('caps content width only when expanded', 0, () => {
      expect(ResponsiveLayout.contentMaxWidth(500)).assertEqual(500);
      expect(ResponsiveLayout.contentMaxWidth(2000)).assertEqual(1240);
    });
  });
}
```

在 `List.test.ets` 追加导入与调用，跑测试确认先失败后通过。

- [ ] **Step 2: 实现会话两种壳**

`SessionSheet` 为底部半模态（`bindSheet`），`SessionSidebar` 为常驻左栏；两者渲染同一份 `SessionStore` 数据，含未读红点。

- [ ] **Step 3: 实现 ConnectionBadge**

按 `ConnectionStore.instance.phase` 显示「已连接 / 重连中 / 未登录」，常驻顶栏。

- [ ] **Step 4: 按断点装配 Index**

**关于首次进入时的默认会话**：Task 16 评审指出原脚手架 `maybeBootstrapSession` 只是被改名保留。裁决：**该行为保留**——没有默认选中会话时用户进来看到的是一片空白，这是产品缺陷而非纯净状态。原 brief 里「必须替换脚手架」的本意是「不要留下硬编码的临时逻辑」，不是「不许有默认选择」。但注释不得暗示这是在满足「替换脚手架」的要求；它就是一个产品默认值，如实写即可。

用 `GridRow`/`onAreaChange` 拿到窗口宽度，`usesSideSessions` 为真时渲染 `SessionSidebar` + `ChatWindow`，否则渲染顶栏（PetMini + 会话名 + ConnectionBadge + 设置）+ `ChatWindow` + `SessionSheet`。EXPANDED 下给 `ChatWindow` 套 `.constraintSize({ maxWidth: ResponsiveLayout.contentMaxWidth(width) })`。

- [ ] **Step 5: 真机验证三档**

手机竖屏（COMPACT）→ 横屏（MEDIUM，会话列表出现在左侧）→ 若有平板或 2in1 设备再验 EXPANDED 的内容封顶。折叠屏需验证展开瞬间布局平滑切换、不丢当前会话。

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/components harmony/entry/src/main/ets/pages/Index.ets harmony/entry/src/test
git commit -m "feat(harmony): adapt sessions and chat width across three breakpoints"
```

---

### Task 17: 历史补齐与错误降级

把 spec 第 8 节的降级表逐行落地。

**Files:**
- Create: `harmony/entry/src/main/ets/gateway/HistoryApi.ets`
- Create: `harmony/entry/src/main/ets/components/ErrorBanner.ets`
- Modify: `harmony/entry/src/main/ets/gateway/ConnectionGateway.ets`
- Modify: `harmony/entry/src/main/ets/components/MessageList.ets`
- Modify: `harmony/entry/src/main/ets/store/AuthStore.ets`

**Interfaces:**
- Consumes: `RestClient`、`UnauthorizedError`
- Produces: `HistoryApi.fetch(chatKey: string): Promise<ChatMessage[]>`；`ErrorBanner({ text: string, onRetry: () => void })`

- [ ] **Step 1: 重连后补齐历史**

`ConnectionGateway` 在 `open()` 成功回调里，对当前 chatKey 调 `HistoryApi.fetch`。

**按 `seq` 增量拉取，不要全量覆盖。** 服务端的 `GET /api/history/:chatKey` 支持 `afterSeq` 与 `limit`（上限 500，见 `packages/server/src/api/history.ts` 的 `getByChatKeyAfterSeq`）。用 `ChatStore.maxSeqOf(chatKey)` 作为已知水位构造请求（URL 用 `Endpoints` 的 `historyUrl(chatKey, afterSeq, limit)` 生成）：

- `maxSeqOf` 为 0（本地无历史）→ 不带 `afterSeq`，拉最近一批，`ChatStore.replaceAll`
- `maxSeqOf` 大于 0 → 带 `afterSeq`，只取断档部分，逐条 `append`

每次重连都拖全量历史，在长会话上既慢又浪费流量。失败时不抛给用户中断，而是置一个 `historyError` 标志。

- [ ] **Step 2: 401 统一登出**

任何 `RestClient` 调用抛出 `UnauthorizedError` 时，调 `AuthStore.instance.clear()`，UI 自动回到 `LoginGate`。**不做静默重试**——token 失效重试多少次都是失败。

- [ ] **Step 3: 发送失败可重试**

发送后 15 秒内未收到 `message-ack`，`Outbox.expireTimedOut` 将条目转 `failed`，气泡标红并显示重试按钮，点击调 `ConnectionGateway.instance.retry(clientMsgId)`。原文不得丢失。

- [ ] **Step 4: 历史失败提示条**

`ErrorBanner` 置于 `MessageList` 顶部，仅 `historyError` 为真时显示，带「重试」按钮。不阻塞当前会话的收发。

- [ ] **Step 5: 逐条验证降级表**

对照 spec 第 8 节五行逐条验证：故意填错 token 验 401；飞行模式验断线与发送队列；把服务端 `/api/history` 临时改成 500 验提示条（**验证完立即改回，服务端不得留下改动**）；断网状态下验宠物图回落内置资源。

- [ ] **Step 6: 提交**

```bash
git add harmony/entry/src/main/ets/gateway/HistoryApi.ets harmony/entry/src/main/ets/components/ErrorBanner.ets harmony/entry/src/main/ets/gateway/ConnectionGateway.ets harmony/entry/src/main/ets/components/MessageList.ets harmony/entry/src/main/ets/store/AuthStore.ets
git commit -m "feat(harmony): backfill history and degrade gracefully on errors"
```

---

### Task 18: 真机探针脚本与文档收尾

**Files:**
- Create: `harmony/scripts/build.sh`
- Create: `harmony/scripts/device-login-probe.sh`
- Create: `harmony/scripts/device-chat-probe.sh`
- Create: `harmony/scripts/device-reconnect-probe.sh`
- Create: `harmony/scripts/device-notification-probe.sh`
- Modify: `harmony/README.md`

**Interfaces:**
- Consumes: Task 1 记录的构建命令
- Produces: 四条可重复执行的真机验证脚本

- [ ] **Step 1: 写 build.sh**

封装 Task 1 记录的 HAP 构建命令，`set -euo pipefail`，产物路径打印到 stdout。用 bash 而非 PowerShell——Tailscale-OHOS 的 `.ps1` 探针在 macOS 上跑不了。

- [ ] **Step 2: 写四条探针脚本**

每条脚本用 `hdc shell` 抓日志并断言关键行，退出码非零即失败：

- `device-login-probe.sh`：安装 HAP、拉起应用、断言日志出现 `auth verified`
- `device-chat-probe.sh`：断言一轮收发中出现 `stream-delta` 与 `stream-done`
- `device-reconnect-probe.sh`：`hdc shell` 切飞行模式、等待、恢复，断言日志出现退避重连且最终 `connected`
- `device-notification-probe.sh`：把应用退到后台，断言 `notifyReply` 被调用

脚本必须打印明确的 PASS / FAIL 行，不要只靠退出码。

- [ ] **Step 3: 补全 README**

`harmony/README.md` 写明：环境要求（DevEco Studio 版本、API 26）、签名配置步骤（指向 `build-profile.example.json5`）、构建与单测命令、四条探针的用法、以及「服务端零改动」这一约束。

- [ ] **Step 4: 跑一遍全量验证**

```bash
cd /Users/StevenZhu/code/cc-pet-web
pnpm --filter @cc-pet/server exec vitest run tests/harmony-protocol-alignment.test.ts
```

外加 Task 1 的单测命令（全部 hypium 用例）与四条探针。全绿才算完成。

- [ ] **Step 5: 提交**

```bash
git add harmony/scripts harmony/README.md
git commit -m "chore(harmony): add device probes and build docs"
```

---

## 附：自查结论

写完后按 spec 逐节核对的结果：

- spec 2（范围）→ Task 10–16 覆盖全部「做」的条目；「不做」的条目未出现在任何任务中。
- spec 4.1（分层）→ 目录结构见本计划 File Structure，与 spec 一致；依赖规则写入 Global Constraints。
- spec 4.2（移植资产）→ `ResponsiveLayout` 在 Task 16 移植；`AppShell`/`MotionTokens` 首版未用到，故未列入任务（首版无底部导航，见 spec 7.2）。
- spec 5（协议与漂移守卫）→ Task 2，且 Step 4 强制验证守卫会响。
- spec 6.1/6.2/6.3/6.4 → 分别对应 Task 3/11、Task 11、Task 4 + 11、Task 5 + 13。
- spec 7.1/7.2/7.3/7.4 → 分别对应 Task 16、Task 10 + 16、Task 6 + 7 + 12、Task 8 + 15。
- spec 8（降级表）→ Task 17，逐行验证。
- spec 9（测试）→ 单测散在 Task 3–9 与 16，协议对齐在 Task 2，探针在 Task 18。
- spec 10（风险）→ 签名风险在 Task 1 Step 3 前置；markdown 风险通过 Task 6/7 拆分与纯函数化降低。
