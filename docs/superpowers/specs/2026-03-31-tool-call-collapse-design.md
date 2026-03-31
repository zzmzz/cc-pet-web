# Tool Call Message Collapse — Design Spec

## Problem

cc-connect 在处理用户请求时会发送大量工具调用消息（`🔧 工具 #N: ...`）和思考消息（`💭 ...`），每条都作为独立气泡显示，导致聊天窗口刷屏。一次简单操作可能产生 5-6 条中间消息，淹没最终回复。

## Solution

纯前端方案：在 `MessageList` 渲染层将连续的 tool call 消息自动分组为**可折叠的活动块（ActivityBlock）**。

- **执行中**：展开列表显示已完成步骤 + 当前正在执行的操作
- **完成后**：自动折叠为一行摘要（`✅ 已执行 N 个操作`），点击可展开查看详情

## Detection Rules

通过消息 `content` 前缀判断是否为 tool call 消息：

| 前缀 | 含义 | 提取标签示例 |
|---|---|---|
| `🔧` | 工具调用 | `🔧 Read — SKILL.md` |
| `💭` | AI 思考过程 | `💭 思考` |

```typescript
function isToolCallContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith('🔧') || trimmed.startsWith('💭');
}

function getToolCallLabel(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('💭')) return '💭 思考';
  const match = trimmed.match(/🔧\s*\*\*工具\s*#\d+:\s*(.+?)\*\*/);
  if (match) return `🔧 ${match[1]}`;
  return '🔧 工具调用';
}
```

工具调用消息还会提取关键参数作为摘要，规则：

- `🔧` 类型：取 `---` 分隔线之后的首行非空文本（如文件路径、命令片段），截断到 40 字符
- `💭` 类型：不展示内容，固定显示 `💭 思考`

## Grouping Logic

纯函数 `groupMessages` 将 `ChatMessage[]` 转换为 `RenderItem[]`：

```typescript
type RenderItem =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'tool-group'; messages: ChatMessage[]; done: boolean };
```

算法：

1. 遍历消息数组
2. 连续的 `isToolCallContent` assistant 消息归入同一 `tool-group`
3. 遇到非 tool call 消息时切断当前 group

`done` 判断：

- tool-group 后面紧跟非 tool-call 的 assistant 消息 → `done: true`（折叠）
- tool-group 在消息列表末尾，无 streaming → `done: false`（展开，显示执行中）
- tool-group 在消息列表末尾，streaming 内容非 tool call → `done: true`（最终回复正在流式输出，折叠活动块）

分组在 `MessageList` 内用 `useMemo` 计算，不改动 message store。

## ActivityBlock Component

新增 `packages/web/src/components/ActivityBlock.tsx`。

### Props

```typescript
interface ActivityBlockProps {
  messages: ChatMessage[];
  done: boolean;
}
```

### 执行中状态 (`done: false`)

- 紫色系容器（`bg-purple-50 border-purple-200`）
- 已到达的 tool call：灰色 `✓` + 摘要标签
- 最后一条：旋转 spinner + 紫色高亮文字
- 新消息到达时自动追加

### 完成状态 (`done: true`)

- 绿色系容器（`bg-green-50 border-green-200`）
- 默认收起：`✅ 已执行 N 个操作` + `▶ 展开`
- 点击展开：完整列表 + `▼ 收起`
- 内部 `useState<boolean>(false)` 控制展开/收起

## MessageList Integration

渲染流程变更：

```
messages[]
  → groupMessages(messages, streamingContent)   // useMemo
  → RenderItem[]
  → renderItems.map(item =>
      item.kind === 'tool-group'
        ? <ActivityBlock />
        : <MessageBubble />
    )
```

## Files Changed

| 文件 | 变更类型 |
|---|---|
| `packages/web/src/components/ActivityBlock.tsx` | 新增 |
| `packages/web/src/components/MessageList.tsx` | 修改 — 引入分组逻辑 + 渲染两种 item 类型 |

## Files NOT Changed

- `packages/web/src/lib/store/message.ts` — 消息存取逻辑不变
- `packages/web/src/App.tsx` — WS 事件处理不变
- `packages/shared/src/types/message.ts` — ChatMessage 类型不新增字段
- Server 端 — 完全不动

## Compatibility

- **历史消息**：回放时走同样的 `groupMessages` 分组，自动折叠显示
- **普通对话**（无 tool call）：`groupMessages` 返回全部 `kind: 'message'`，渲染完全等价于现有行为
- **Streaming**：tool call 消息通过 `BRIDGE_MESSAGE` 以完整消息到达（非流式），streaming 通常是最终回复文本。若消息列表末尾是未完成的 tool-group 且 streaming 内容开始到达（非 tool call），则标记 `done: true` 折叠活动块，streaming 正常显示为 `MessageBubble`
- **React key**：`tool-group` 的 key 取组内第一条消息的 `id`，确保分组稳定

## Out of Scope

- Server 端消息标记或 schema 变更
- cc-connect bridge 协议修改
- 工具调用消息的持久化分组（分组仅在渲染时计算）
- 工具调用内容的 markdown 渲染（活动块内只显示摘要标签，不渲染完整 markdown）
