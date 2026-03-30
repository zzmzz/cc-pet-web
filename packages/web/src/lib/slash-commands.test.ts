import { describe, expect, it } from "vitest";
import {
  getFilteredCommands,
  normalizeBridgeSlashCommands,
} from "./slash-commands.js";

describe("normalizeBridgeSlashCommands", () => {
  it("maps command field to name and strips leading slash", () => {
    expect(
      normalizeBridgeSlashCommands([
        { command: "/foo", description: "bar", category: "skill", type: "send" },
      ]),
    ).toEqual([
      { name: "foo", description: "bar", category: "skill", type: "send" },
    ]);
  });

  it("accepts name field", () => {
    expect(
      normalizeBridgeSlashCommands([{ name: "help", description: "h" }]),
    ).toEqual([{ name: "help", description: "h", category: undefined, type: undefined }]);
  });
});

describe("getFilteredCommands", () => {
  it("filters by command prefix", () => {
    const r = getFilteredCommands("cle", []);
    expect(r.some((c) => c.command === "/clear")).toBe(true);
    expect(r.some((c) => c.command === "/list")).toBe(false);
  });

  it("merges extra bridge commands", () => {
    const r = getFilteredCommands("custom", [
      { name: "custom", description: "x", category: "skill", type: "send" },
    ]);
    expect(r.some((c) => c.command === "/custom")).toBe(true);
  });
});
