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
