import { globSync, readFileSync } from "node:fs";
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

const endpointsPath = resolve(here, "../../../harmony/entry/src/main/ets/model/Endpoints.ets");
const serverSrc = resolve(here, "../src");

/** Routes fastify actually registers, including the generic-typed multi-line form. */
function registeredRoutes(): Set<string> {
  // Node's built-in fs.globSync has no `absolute` option (unlike the npm
  // `glob` package) — it silently ignores unknown options and returns paths
  // relative to `cwd`, so they must be resolved against serverSrc by hand.
  const files = globSync("**/*.ts", { cwd: serverSrc })
    .filter((f) => !f.endsWith(".test.ts"))
    .map((f) => resolve(serverSrc, f));
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
