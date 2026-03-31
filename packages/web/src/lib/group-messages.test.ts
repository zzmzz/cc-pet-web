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
