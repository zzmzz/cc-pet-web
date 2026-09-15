import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { learnFromRun, parseHassCall, extractName } from "./fast-path-learn.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function learned(): Record<string, string> {
  const f = path.join(dir, "learned-aliases.json");
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, "utf8")).entities;
}

function bash(command: string) {
  return [{ name: "Bash", input: { command } }];
}

describe("parseHassCall", () => {
  it("pulls service and entity_id out of a bin/hass call", () => {
    expect(parseHassCall(`bin/hass call switch.turn_on '{"entity_id":"switch.x"}'`))
      .toEqual({ service: "switch.turn_on", entityId: "switch.x" });
  });

  it("handles a single-element entity_id array", () => {
    expect(parseHassCall(`bin/hass call light.turn_off '{"entity_id":["light.y"]}'`))
      .toEqual({ service: "light.turn_off", entityId: "light.y" });
  });

  it("rejects a multi-entity call — can't attribute it to one name", () => {
    expect(parseHassCall(`bin/hass call switch.turn_on '{"entity_id":["a.b","c.d"]}'`)).toBeNull();
  });

  it("ignores non-call commands and unparseable args", () => {
    expect(parseHassCall("bin/hass get switch.x")).toBeNull();
    expect(parseHassCall("bin/hass call switch.turn_on {broken")).toBeNull();
  });
});

describe("extractName", () => {
  it("strips action and filler words", () => {
    expect(extractName("帮我把书房灯打开")).toBe("书房灯");
    expect(extractName("关闭阳台灯")).toBe("阳台灯");
    expect(extractName("请打开新风一下")).toBe("新风");
  });

  it("declines names that are too short, too long, or not Chinese words", () => {
    expect(extractName("开灯")).toBeNull();           // 「灯」指向不明
    expect(extractName("打开 switch.abc")).toBeNull(); // 带英文/数字的是内部标识
    expect(extractName("打开" + "很".repeat(20))).toBeNull();
  });
});

describe("learnFromRun", () => {
  it("learns a rule from a single successful call", () => {
    const r = learnFromRun("打开书房灯", bash(`bin/hass call switch.turn_on '{"entity_id":"switch.study"}'`), dir, new Set());
    expect(r).toMatchObject({ learned: true, name: "书房灯", entityId: "switch.study" });
    expect(learned()).toEqual({ "书房灯": "switch.study" });
  });

  it("does not learn when the model called bin/hass more than once", () => {
    const calls = [
      ...bash(`bin/hass call switch.turn_on '{"entity_id":"switch.a"}'`),
      ...bash(`bin/hass call switch.turn_on '{"entity_id":"switch.b"}'`),
    ];
    const r = learnFromRun("打开两个灯", calls, dir, new Set());
    expect(r.learned).toBe(false);
    expect(learned()).toEqual({});
  });

  it("does not learn from a query (no call at all)", () => {
    const r = learnFromRun("客厅灯开着吗", bash("bin/hass get switch.living"), dir, new Set());
    expect(r.learned).toBe(false);
    expect(learned()).toEqual({});
  });

  it("does not learn non-idempotent services", () => {
    const r = learnFromRun(
      "把空调调到二十四度",
      bash(`bin/hass call climate.set_temperature '{"entity_id":"climate.a","temperature":24}'`),
      dir, new Set(),
    );
    expect(r.learned).toBe(false);
    expect(r.reason).toMatch(/幂等/);
  });

  it("does not relearn a name the fast path already covers", () => {
    const r = learnFromRun(
      "打开客厅灯",
      bash(`bin/hass call switch.turn_on '{"entity_id":"switch.living"}'`),
      dir, new Set(["客厅灯"]),
    );
    expect(r.learned).toBe(false);
    expect(learned()).toEqual({});
  });

  it("accumulates across runs and keeps entries sorted", () => {
    learnFromRun("打开书房灯", bash(`bin/hass call switch.turn_on '{"entity_id":"switch.study"}'`), dir, new Set());
    learnFromRun("打开地灯", bash(`bin/hass call switch.turn_on '{"entity_id":"switch.floor"}'`), dir, new Set());
    expect(Object.keys(learned())).toEqual(["书房灯", "地灯"]);
  });

  it("is idempotent for the same rule", () => {
    const call = bash(`bin/hass call switch.turn_on '{"entity_id":"switch.study"}'`);
    expect(learnFromRun("打开书房灯", call, dir, new Set()).learned).toBe(true);
    expect(learnFromRun("打开书房灯", call, dir, new Set()).learned).toBe(false);
  });

  it("rebuilds a corrupt learned file instead of throwing", () => {
    fs.writeFileSync(path.join(dir, "learned-aliases.json"), "{{{ broken");
    const r = learnFromRun("打开书房灯", bash(`bin/hass call switch.turn_on '{"entity_id":"switch.study"}'`), dir, new Set());
    expect(r.learned).toBe(true);
    expect(learned()).toEqual({ "书房灯": "switch.study" });
  });
});
