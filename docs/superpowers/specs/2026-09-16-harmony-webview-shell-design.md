# 鸿蒙 WebView 壳子设计

**日期：** 2026-09-16
**状态：** 待实现
**取代：** `2026-09-15-harmony-client-design.md` 与 `2026-09-16-harmony-session-management-design.md` 所描述的原生移植路线
**决策依据：** `docs/harmony-direction-decision.md`

---

## 1. 目标与非目标

**目标**：把 `packages/web` 原样装进一个鸿蒙应用，使其在手机上可用。

**非目标（明确不做）**：
- 不重写任何界面。所有 UI 来自 web，鸿蒙侧不得出现第二套实现。
- 不做后台通知。应用切后台即挂起，WS 断开——**已确认可接受**。
- 不做原生会话/连接/消息逻辑。已完成的原生代码保留在 `harmony/entry/src/main/ets/` 但不再是入口，供后续可能的混合方案参考。

**这条边界是本设计的核心。** 壳子每多承担一项 web 已经在做的事，就多一处会漂移的地方——而消除漂移正是选择本方案的唯一理由。

---

## 2. 架构

```
EntryAbility
  └── pages/Shell.ets          ← 唯一入口
        ├── 服务器地址未配置 → ServerSetup（原生，见 §4）
        └── 已配置          → Web(src: `${baseUrl}`)
```

`packages/web` 由 `packages/server` 在 `/` 上托管（`packages/server/src/index.ts:138`），因此**壳子只需要一个服务器地址**；token 由 web 自己的登录页处理并存进 `localStorage`，壳子不碰。

**服务端零改动的约束继续生效。**

---

## 3. 壳子必须承担的事（web 无法自己做的）

以下每一项都附「为什么 web 做不到」，作为它出现在原生侧的理由。缺少该理由的功能不得加入。

| 能力 | 为什么 web 做不到 |
|---|---|
| 服务器地址录入与持久化 | 页面本身要从该地址加载，是先有鸡的问题 |
| 返回键 | 系统按键不经过 WebView，不处理会直接退出应用 |
| 安全区 / 状态栏 / 刘海 | CSS `env(safe-area-inset-*)` 在 ArkWeb 下是否生效需实测（见 §7） |
| 软键盘避让 | 同上，需实测 |
| 文件选择（附件上传） | `<input type="file">` 需要壳子实现 `onShowFileSelector` 才能唤起系统选择器 |
| 文件下载 | 需要 `onDownloadStart` 落盘 |
| 加载失败的重试入口 | 白屏时用户在 WebView 里无处可点 |

---

## 4. 服务器地址

首次启动显示一个原生极简页：一个输入框 + 一个「连接」按钮。

- 存入 preferences（复用已有的 `AuthStore` 持久化写法，但**只存 baseUrl，不存 token**）
- 校验方式：`GET ${baseUrl}/api/health`（服务端已有该路由，无需鉴权），返回 200 才保存
- 提供「更换服务器」入口——放在壳子的错误页里，避免占用正常界面
- **绝不在壳子里保存或显示 token**。token 是 web 的事，进了 `localStorage` 就与壳子无关

## 5. 返回键

`onBackPress()` 中：能后退则 `controller.backward()`，否则交还系统（退出）。

---

## 6. WebView 配置

```
.domStorageAccess(true)     // web 的 token 存在 localStorage
.databaseAccess(true)
.fileAccess(true)
.geolocationAccess(false)   // 不需要
.mixedMode(MixedMode.None)  // 生产强制 https；spike 用过 All，不得带入
```

`mixedMode` 必须收紧：spike 为连本地 http 夹具放开过，那是测试便利，不是产品行为。

---

## 7. 需要实测、不得假设的事项

本方案的风险集中在「web 的假设在 ArkWeb 下是否成立」。以下每项都必须在模拟器上验证并留下截图，**不接受推断**：

1. `env(safe-area-inset-*)` 是否生效——不生效则内容会被状态栏和手势条压住
2. 软键盘弹出时输入框是否被遮挡——聊天应用的核心交互
3. 长列表滚动与惯性是否可接受
4. `<input type="file">` 经 `onShowFileSelector` 能否选到文件并完成上传
5. 那个 spike 中出现的 `http 404` 子资源是什么，是否影响功能
6. 折叠屏展开/折叠时的重排（真机可测，模拟器不可——宽屏模拟器起不来是既有已知限制）

---

## 8. 验证手段的变化（必须正视）

**WebView 内容对 `uitest` 不可见**（spike 实测：布局树 0 个文本节点），且**坐标点击无法聚焦 web 输入框**。因此：

- 现有 7 个设备探针在本方案下全部失效
- 壳子自身的行为（返回键、错误页、地址录入）**仍可用 uitest 断言**，因为那是原生组件
- web 内部的行为由 `packages/web` 自己的 339 个测试覆盖
- 两者之间的缝隙——「壳子有没有把 web 弄坏」——只能靠人眼看截图

**结论**：本方案下的设备验证清单必须是**显式的、人工执行的**，写进 README，而不是假装有自动化。

---

## 9. 验收

- 冷启动 → 录入服务器地址 → 加载 web → 登录 → 收发一条消息
- 杀进程重启 → 不需重新录入地址、不需重新登录（localStorage 存活）
- 返回键行为正确，不会一按就退出
- 输入框不被键盘遮挡，内容不被状态栏遮挡
- 附件选择能唤起系统文件选择器
- 加载失败时有可见的重试与换地址入口
- `packages/` 零改动
