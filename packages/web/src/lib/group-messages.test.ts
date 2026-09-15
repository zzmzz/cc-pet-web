import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@cc-pet/shared";
import { groupMessages, type RenderItem } from "./group-messages.js";

function msg(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

function toolGroup(item: RenderItem) {
  if (item.kind !== "tool-group") throw new Error("expected tool-group");
  return item;
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

  it("ignores whitespace-only assistant between tool calls (keeps one tool-group)", () => {
    const msgs = [
      msg("1", "user", "run tools"),
      msg("2", "assistant", '🔧 **工具 #1: Read**\n---\n`a`'),
      msg("3", "assistant", "\n\n\n"),
      msg("4", "assistant", '🔧 **工具 #2: Bash**\n---\n`b`'),
      msg("5", "assistant", "完成"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ kind: "tool-group", done: true });
    expect(toolGroup(items[1]).steps).toHaveLength(2);
    expect(items[2]).toEqual({ kind: "message", message: msgs[4] });
  });

  it("drops whitespace-only assistant between user and text reply", () => {
    const msgs = [
      msg("1", "user", "hi"),
      msg("2", "assistant", "  \n  "),
      msg("3", "assistant", "hello"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "message", message: msgs[0] });
    expect(items[1]).toEqual({ kind: "message", message: msgs[2] });
  });

  it("groups consecutive tool call messages", () => {
    const msgs = [
      msg("1", "user", "shorten this link"),
      msg("2", "assistant", "💭\nthinking..."),
      msg("3", "assistant", '🔧 **工具 #1: Read**\n---\n`/path/skill.md`'),
      msg("4", "assistant", "💭\npreparing API call"),
      msg("5", "assistant", '🔧 **工具 #2: Bash**\n---\n```bash\ncurl ...\n```'),
      msg("6", "assistant", "短链已生成：https://ziiimo.cn/u/3849"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ kind: "message", message: msgs[0] });
    expect(items[1]).toMatchObject({ kind: "tool-group", done: true });
    expect(toolGroup(items[1]).steps).toHaveLength(4);
    expect(items[2]).toEqual({ kind: "message", message: msgs[5] });
  });

  it("pairs a 🧾 result with its preceding 🔧 call into one step", () => {
    const msgs = [
      msg("1", "user", "run it"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\n```bash\necho hi\n```'),
      msg("3", "assistant", "🧾\n🟢 状态: ok\n🔢 退出码: 0\n```text\nhi\n```"),
      msg("4", "assistant", "done"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(3);
    const group = toolGroup(items[1]);
    expect(group.steps).toHaveLength(1);
    expect(group.steps[0].call.id).toBe("2");
    expect(group.steps[0].result?.id).toBe("3");
    expect(items[2]).toEqual({ kind: "message", message: msgs[3] });
  });

  it("does not break the group when a 🧾 result appears mid-stream", () => {
    const msgs = [
      msg("1", "user", "run them"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\n`a`'),
      msg("3", "assistant", "🧾\n🟢 状态: ok\n```text\nout-a\n```"),
      msg("4", "assistant", '🔧 **工具 #2: Bash**\n---\n`b`'),
      msg("5", "assistant", "🧾\n🔴 状态: failed\n🔢 退出码: 1\n```text\nboom\n```"),
      msg("6", "assistant", "都跑完了"),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(3);
    const group = toolGroup(items[1]);
    expect(group.steps).toHaveLength(2);
    expect(group.steps[0].result?.id).toBe("3");
    expect(group.steps[1].result?.id).toBe("5");
    expect(items[2]).toEqual({ kind: "message", message: msgs[5] });
  });

  it("keeps a tool call with no result as a step with null result", () => {
    const msgs = [
      msg("1", "user", "do it"),
      msg("2", "assistant", '🔧 **工具 #1: Bash**\n---\n`a`'),
      msg("3", "assistant", "回复"),
    ];
    const items = groupMessages(msgs);
    const group = toolGroup(items[1]);
    expect(group.steps).toHaveLength(1);
    expect(group.steps[0].result).toBeNull();
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
