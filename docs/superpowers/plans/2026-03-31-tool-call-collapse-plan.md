# Tool Call Message Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse consecutive tool call messages (`🔧`/`💭`) into a foldable ActivityBlock to eliminate chat flooding.

**Architecture:** Pure frontend approach — a `groupMessages` function converts the flat message array into render items (normal messages + tool-groups), and a new `ActivityBlock` component renders tool-groups with in-progress/done states. No server or shared type changes.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Vitest + Testing Library

---

### Task 1: Tool Call Detection Utilities

**Files:**
- Create: `packages/web/src/lib/tool-call.ts`
- Test: `packages/web/src/lib/tool-call.test.ts`

- [ ] **Step 1: Write failing tests for detection functions**

Create `packages/web/src/lib/tool-call.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isToolCallContent, getToolCallLabel, getToolCallDetail } from "./tool-call.js";

describe("isToolCallContent", () => {
  it("detects wrench emoji tool call", () => {
    expect(isToolCallContent('🔧 **工具 #1: Bash**\n---\ncurl ...')).toBe(true);
  });

  it("detects thought bubble thinking message", () => {
    expect(isToolCallContent('💭\nThe user wants...')).toBe(true);
  });

  it("detects with leading whitespace", () => {
    expect(isToolCallContent('  🔧 **工具 #2: Read**')).toBe(true);
    expect(isToolCallContent(' 💭 \nthinking...')).toBe(true);
  });

  it("rejects normal assistant messages", () => {
    expect(isToolCallContent('短链已生成：https://ziiimo.cn/u/3849')).toBe(false);
    expect(isToolCallContent('你好！有什么需要帮忙的吗？')).toBe(false);
    expect(isToolCallContent('')).toBe(false);
  });

  it("rejects messages that mention tools in the middle", () => {
    expect(isToolCallContent('我使用了 🔧 工具')).toBe(false);
  });
});

describe("getToolCallLabel", () => {
  it("extracts tool name from wrench message", () => {
    expect(getToolCallLabel('🔧 **工具 #1: Bash**\n---\ncurl ...')).toBe("🔧 Bash");
  });

  it("extracts tool name with higher number", () => {
    expect(getToolCallLabel('🔧 **工具 #12: Read**\n---\n/path')).toBe("🔧 Read");
  });

  it("returns thinking label for thought bubble", () => {
    expect(getToolCallLabel('💭\nThe user wants...')).toBe("💭 思考");
    expect(getToolCallLabel('💭 \nreasoning...')).toBe("💭 思考");
  });

  it("returns fallback for unrecognized tool format", () => {
    expect(getToolCallLabel('🔧 something else')).toBe("🔧 工具调用");
  });
});

describe("getToolCallDetail", () => {
  it("extracts first line after --- separator for tool calls", () => {
    expect(getToolCallDetail('🔧 **工具 #1: Read**\n---\n`/home/hy/.claude/skills/shorten-url/SKILL.md`'))
      .toBe("/home/hy/.claude/skills/shorten-url/SKILL.md");
  });

  it("extracts command from bash code block", () => {
    const detail = getToolCallDetail('🔧 **工具 #1: Bash**\n---\n```bash\ncurl -sG "https://ziiimo.cn/api/v2/action/shorten"\n```');
    expect(detail).toMatch(/^curl -sG/);
    expect(detail.length).toBeLessThanOrEqual(41);
  });

  it("truncates long details to 40 chars", () => {
    const long = '🔧 **工具 #1: Read**\n---\n`/very/long/path/that/exceeds/forty/characters/and/should/be/truncated.md`';
    const result = getToolCallDetail(long);
    expect(result.length).toBeLessThanOrEqual(41); // 40 + ellipsis
  });

  it("returns empty string for thinking messages", () => {
    expect(getToolCallDetail('💭\nThe user wants...')).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cc-pet/web test -- src/lib/tool-call.test.ts`
Expected: FAIL — module `./tool-call.js` not found

- [ ] **Step 3: Implement detection functions**

Create `packages/web/src/lib/tool-call.ts`:

```typescript
export function isToolCallContent(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("🔧") || trimmed.startsWith("💭");
}

export function getToolCallLabel(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("💭")) return "💭 思考";
  const match = trimmed.match(/🔧\s*\*\*工具\s*#\d+:\s*(.+?)\*\*/);
  if (match) return `🔧 ${match[1]}`;
  return "🔧 工具调用";
}

export function getToolCallDetail(content: string): string {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("💭")) return "";

  const sepIdx = trimmed.indexOf("\n---\n");
  if (sepIdx < 0) return "";

  const afterSep = trimmed.slice(sepIdx + 5).trimStart();
  let firstLine = afterSep.split("\n")[0] ?? "";

  // Strip markdown code fence
  if (firstLine.startsWith("```")) {
    const secondLine = afterSep.split("\n")[1] ?? "";
    firstLine = secondLine;
  }

  // Strip backtick wrapping
  firstLine = firstLine.replace(/^`+|`+$/g, "").trim();

  if (firstLine.length <= 40) return firstLine;
  return firstLine.slice(0, 40) + "…";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cc-pet/web test -- src/lib/tool-call.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/tool-call.ts packages/web/src/lib/tool-call.test.ts
git commit -m "feat(web): add tool call detection utilities"
```

---

### Task 2: Message Grouping Logic

**Files:**
- Create: `packages/web/src/lib/group-messages.ts`
- Test: `packages/web/src/lib/group-messages.test.ts`

- [ ] **Step 1: Write failing tests for groupMessages**

Create `packages/web/src/lib/group-messages.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@cc-pet/shared";
import { groupMessages, type RenderItem } from "./group-messages.js";

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe("groupMessages", () => {
  it("returns all messages as-is when no tool calls", () => {
    const msgs = [msg("1", "user", "hello"), msg("2", "assistant", "hi there")];
    const items = groupMessages(msgs);
    expect(items).toEqual([
      { kind: "message", message: msgs[0] },
      { kind: "message", message: msgs[1] },
    ]);
  });

  it("groups consecutive tool call messages", () => {
    const msgs = [
      msg("1", "user", "shorten this link"),
      msg("2", "assistant", "💭\nthinking...'),
      msg("3", "assistant", '🔧 **工具 #1: Read**\n---\n`/path/skill.md`'),
      msg("4", "assistant", '💭\npreparing API call'),
      msg("5", "assistant", '🔧 **工具 #2: Bash**\n---\n```bash\ncurl ...\n```'),
      msg("6", "assistant", "短链已生成：https://ziiimo.cn/u/3849"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ kind: "message", message: msgs[0] });
    expect(items[1]).toMatchObject({ kind: "tool-group", done: true });
    expect((items[1] as Extract<RenderItem, { kind: "tool-group" }>).messages).toHaveLength(4);
    expect(items[2]).toEqual({ kind: "message", message: msgs[5] });
  });

  it("marks trailing tool group as not done (no streaming)", () => {
    const msgs = [
      msg("1", "user", "do something"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\necho hi'),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "tool-group", done: false });
  });

  it("marks trailing tool group as done when streaming non-tool content", () => {
    const msgs = [
      msg("1", "user", "do something"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\necho hi'),
    ];
    const items = groupMessages(msgs, "结果是...");
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "tool-group", done: true });
  });

  it("marks trailing tool group as not done when streaming tool content", () => {
    const msgs = [
      msg("1", "user", "do something"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\necho hi'),
    ];
    const items = groupMessages(msgs, "💭\nstill thinking");
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ kind: "tool-group", done: false });
  });

  it("handles multiple separate tool groups", () => {
    const msgs = [
      msg("1", "user", "first request"),
      msg("2", "assistant", '🔧 **工具 #1: Read**\n---\nfile.md'),
      msg("3", "assistant", "here is the result"),
      msg("4", "user", "second request"),
      msg("5", "assistant", '🔧 **工具 #1: Bash**\n---\ncurl ...'),
      msg("6", "assistant", "done"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(6);
    expect(items[1]).toMatchObject({ kind: "tool-group", done: true });
    expect(items[4]).toMatchObject({ kind: "tool-group", done: true });
  });

  it("does not group user messages", () => {
    const msgs = [msg("1", "user", "🔧 fake tool")];
    const items = groupMessages(msgs);
    expect(items).toEqual([{ kind: "message", message: msgs[0] }]);
  });

  it("returns empty array for empty input", () => {
    expect(groupMessages([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cc-pet/web test -- src/lib/group-messages.test.ts`
Expected: FAIL — module `./group-messages.js` not found

- [ ] **Step 3: Implement groupMessages**

Create `packages/web/src/lib/group-messages.ts`:

```typescript
import type { ChatMessage } from "@cc-pet/shared";
import { isToolCallContent } from "./tool-call.js";

export type RenderItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool-group"; messages: ChatMessage[]; done: boolean };

export function groupMessages(messages: ChatMessage[], streamingContent?: string): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ChatMessage[] = [];

  const flushToolGroup = (done: boolean): void => {
    if (toolBuf.length === 0) return;
    items.push({ kind: "tool-group", messages: [...toolBuf], done });
    toolBuf = [];
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && isToolCallContent(msg.content)) {
      toolBuf.push(msg);
    } else {
      const done = msg.role === "assistant" || toolBuf.length > 0;
      flushToolGroup(done);
      items.push({ kind: "message", message: msg });
    }
  }

  if (toolBuf.length > 0) {
    const done = streamingContent != null
      && streamingContent.length > 0
      && !isToolCallContent(streamingContent);
    flushToolGroup(done);
  }

  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cc-pet/web test -- src/lib/group-messages.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/group-messages.ts packages/web/src/lib/group-messages.test.ts
git commit -m "feat(web): add message grouping logic for tool call collapsing"
```

---

### Task 3: ActivityBlock Component

**Files:**
- Create: `packages/web/src/components/ActivityBlock.tsx`
- Test: `packages/web/src/components/ActivityBlock.test.tsx`

- [ ] **Step 1: Write failing tests for ActivityBlock**

Create `packages/web/src/components/ActivityBlock.test.tsx`:

```typescript
import { describe, expect, it, beforeEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatMessage } from "@cc-pet/shared";
import { ActivityBlock } from "./ActivityBlock.js";

function toolMsg(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, timestamp: Date.now() };
}

const TOOL_MSGS: ChatMessage[] = [
  toolMsg("t1", "💭\nAnalyzing request..."),
  toolMsg("t2", '🔧 **工具 #1: Read**\n---\n`/path/to/skill.md`'),
  toolMsg("t3", "💭\nPreparing API call..."),
  toolMsg("t4", '🔧 **工具 #2: Bash**\n---\n```bash\ncurl -sG "https://ziiimo.cn/api/..."\n```'),
];

describe("ActivityBlock", () => {
  beforeEach(() => cleanup());

  it("renders in-progress state with spinner on last item", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={false} />);

    expect(screen.getByText(/💭 思考/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });

  it("renders collapsed done state by default", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    expect(screen.getByText(/已执行 4 个操作/)).toBeInTheDocument();
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("expands on click to show all items", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));

    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();
    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText(/💭 思考/)).toBeInTheDocument();
  });

  it("collapses again on second click", () => {
    render(<ActivityBlock messages={TOOL_MSGS} done={true} />);

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.getByText(/🔧 Read/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/已执行 4 个操作/));
    expect(screen.queryByText(/🔧 Read/)).not.toBeInTheDocument();
  });

  it("shows single item without count text in progress", () => {
    render(<ActivityBlock messages={[TOOL_MSGS[0]]} done={false} />);
    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cc-pet/web test -- src/components/ActivityBlock.test.tsx`
Expected: FAIL — module `./ActivityBlock.js` not found

- [ ] **Step 3: Implement ActivityBlock component**

Create `packages/web/src/components/ActivityBlock.tsx`:

```tsx
import { useState } from "react";
import type { ChatMessage } from "@cc-pet/shared";
import { getToolCallLabel, getToolCallDetail } from "../lib/tool-call.js";

interface ActivityBlockProps {
  messages: ChatMessage[];
  done: boolean;
}

export function ActivityBlock({ messages, done }: ActivityBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const count = messages.length;

  if (!done) {
    return (
      <div className="flex justify-start px-3 py-1">
        <div className="max-w-[85%] w-full rounded-2xl rounded-bl-md border border-purple-200 bg-purple-50 px-4 py-2.5 text-[13px]">
          <div className="flex items-center gap-1.5 text-purple-600 text-xs font-medium mb-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <span>工具调用中…</span>
          </div>
          <div className="space-y-0.5">
            {messages.map((msg, i) => {
              const label = getToolCallLabel(msg.content);
              const detail = getToolCallDetail(msg.content);
              const isLast = i === count - 1;
              return (
                <div
                  key={msg.id}
                  className={`flex items-center gap-1.5 text-xs py-0.5 ${
                    isLast ? "text-purple-700 font-medium" : "text-gray-400"
                  }`}
                >
                  <span className="w-4 text-center shrink-0">
                    {isLast ? "" : "✓"}
                  </span>
                  <span>{label}</span>
                  {detail && (
                    <span className={`truncate ${isLast ? "text-purple-500" : "text-gray-300"}`}>
                      — <code className="text-[11px]">{detail}</code>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start px-3 py-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="max-w-[85%] w-full text-left rounded-2xl rounded-bl-md border border-green-200 bg-green-50 px-4 py-2 text-[13px] transition-colors hover:bg-green-100"
      >
        <div className="flex items-center gap-1.5 text-green-700 text-xs">
          <span>✅</span>
          <span>已执行 {count} 个操作</span>
          <span className="text-green-400 text-[11px] ml-1">
            {expanded ? "▼ 收起" : "▶ 展开"}
          </span>
        </div>
        {expanded && (
          <div className="mt-1.5 pt-1.5 border-t border-green-100 space-y-0.5">
            {messages.map((msg) => {
              const label = getToolCallLabel(msg.content);
              const detail = getToolCallDetail(msg.content);
              return (
                <div key={msg.id} className="flex items-center gap-1.5 text-xs text-gray-500 py-0.5">
                  <span className="w-4 text-center shrink-0 text-gray-300">✓</span>
                  <span>{label}</span>
                  {detail && (
                    <span className="truncate text-gray-300">
                      — <code className="text-[11px]">{detail}</code>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cc-pet/web test -- src/components/ActivityBlock.test.tsx`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/ActivityBlock.tsx packages/web/src/components/ActivityBlock.test.tsx
git commit -m "feat(web): add ActivityBlock component for collapsed tool calls"
```

---

### Task 4: MessageList Integration

**Files:**
- Modify: `packages/web/src/components/MessageList.tsx` (lines 291-361, the `MessageList` function)
- Test: `packages/web/src/components/MessageList.test.tsx` (add new tests)

- [ ] **Step 1: Add integration tests for tool call grouping in MessageList**

Append to `packages/web/src/components/MessageList.test.tsx` (inside the existing `describe("MessageList", ...)` block):

```typescript
  it("collapses consecutive tool call messages into an ActivityBlock", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "shorten this link", timestamp: 1 },
      { id: "t1", role: "assistant", content: "💭\nthinking...", timestamp: 2 },
      { id: "t2", role: "assistant", content: '🔧 **工具 #1: Bash**\n---\ncurl ...', timestamp: 3 },
      { id: "a1", role: "assistant", content: "短链已生成：https://ziiimo.cn/u/3849", timestamp: 4 },
    ];

    render(<MessageList messages={messages} />);

    expect(screen.getByText(/已执行 2 个操作/)).toBeInTheDocument();
    expect(screen.getByText(/短链已生成/)).toBeInTheDocument();
    expect(screen.queryByText("💭")).not.toBeInTheDocument();
  });

  it("shows in-progress ActivityBlock when tool calls are at the end", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "do something", timestamp: 1 },
      { id: "t1", role: "assistant", content: '🔧 **工具 #1: Read**\n---\n`file.md`', timestamp: 2 },
    ];

    render(<MessageList messages={messages} />);

    expect(screen.getByText("工具调用中…")).toBeInTheDocument();
  });

  it("expands collapsed ActivityBlock on click", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "hello", timestamp: 1 },
      { id: "t1", role: "assistant", content: "💭\nthinking...", timestamp: 2 },
      { id: "t2", role: "assistant", content: '🔧 **工具 #1: Bash**\n---\ncurl ...', timestamp: 3 },
      { id: "a1", role: "assistant", content: "done!", timestamp: 4 },
    ];

    render(<MessageList messages={messages} />);

    const summary = screen.getByText(/已执行 2 个操作/);
    fireEvent.click(summary);

    expect(screen.getByText(/🔧 Bash/)).toBeInTheDocument();
    expect(screen.getByText(/💭 思考/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cc-pet/web test -- src/components/MessageList.test.tsx`
Expected: FAIL — ActivityBlock not rendered, tool call messages still shown individually

- [ ] **Step 3: Integrate groupMessages into MessageList**

Modify `packages/web/src/components/MessageList.tsx`:

Add imports at the top:

```typescript
import { useMemo } from "react";
import { groupMessages } from "../lib/group-messages.js";
import { ActivityBlock } from "./ActivityBlock.js";
```

Update the existing `useRef, useEffect, useCallback, useState` import to include `useMemo`:

```typescript
import { useRef, useEffect, useCallback, useState, useMemo } from "react";
```

Replace the render body of the `MessageList` function. The current code (lines 338-348):

```tsx
{messages.map((msg) => (
  <MessageBubble key={msg.id} message={msg} />
))}
{streamingContent && (
  <MessageBubble
    message={{ id: "streaming", role: "assistant", content: streamingContent, timestamp: Date.now() }}
  />
)}
```

Replace with:

```tsx
{renderItems.map((item) =>
  item.kind === "tool-group" ? (
    <ActivityBlock key={item.messages[0].id} messages={item.messages} done={item.done} />
  ) : (
    <MessageBubble key={item.message.id} message={item.message} />
  ),
)}
{streamingContent && (
  <MessageBubble
    message={{ id: "streaming", role: "assistant", content: streamingContent, timestamp: Date.now() }}
  />
)}
```

Add the `useMemo` hook inside the `MessageList` function, before the return statement:

```typescript
const renderItems = useMemo(
  () => groupMessages(messages, streamingContent),
  [messages, streamingContent],
);
```

- [ ] **Step 4: Run MessageList tests**

Run: `pnpm --filter @cc-pet/web test -- src/components/MessageList.test.tsx`
Expected: all PASS (both existing and new tests)

- [ ] **Step 5: Run all web package tests**

Run: `pnpm --filter @cc-pet/web test`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/MessageList.tsx packages/web/src/components/MessageList.test.tsx
git commit -m "feat(web): integrate ActivityBlock into MessageList for tool call collapsing"
```

---

### Task 5: E2E Verification

**Files:**
- No file changes — verification only

- [ ] **Step 1: Run full e2e test suite**

Run: `pnpm test:e2e`
Expected: all PASS

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: all PASS

- [ ] **Step 3: Final commit (if any linter/test fixes needed)**

Only if the previous steps required small fixes. Otherwise skip.
