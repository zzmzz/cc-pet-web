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

const ENDPOINT_DECL_RE = /static readonly ([A-Z_]+): Endpoint = \{ method: '([A-Z]+)', path: '([^']+)' \}/g;

interface DeclaredEndpoint {
  name: string;
  method: string;
  path: string;
}

function declaredEndpoints(): DeclaredEndpoint[] {
  return Array.from(readFileSync(endpointsPath, "utf8").matchAll(ENDPOINT_DECL_RE)).map((m) => ({
    name: m[1],
    method: m[2],
    path: m[3],
  }));
}

const clientSrc = resolve(here, "../../../harmony/entry/src/main/ets");

/**
 * Strips `//` and block comments. Load-bearing: this codebase's comments are
 * dense field notes that name endpoints and helpers constantly (SessionApi's
 * own class doc explains why `Endpoints.SESSIONS` used to have no callers),
 * and without this the guard counts a mention in prose as a call — which is
 * exactly the false pass it exists to prevent. Caught by deliberately
 * breaking the guard; see the fix-wave report.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every client source file except the endpoint declarations themselves. */
function clientSources(): { file: string; src: string }[] {
  return globSync("**/*.ets", { cwd: clientSrc })
    .map((f) => resolve(clientSrc, f))
    .filter((f) => f !== endpointsPath)
    .map((file) => ({ file, src: stripComments(readFileSync(file, "utf8")) }));
}

/**
 * URL-builder helpers exported from Endpoints.ets, paired with the literal
 * path prefix each one builds (`historyUrl` → `/api/history/`). An endpoint
 * is reachable through a helper when the helper's body contains the
 * endpoint's own path prefix — the part before the first `:param`.
 */
function urlHelpers(): { name: string; body: string }[] {
  const src = readFileSync(endpointsPath, "utf8");
  return Array.from(src.matchAll(/export function (\w+)\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/g)).map((m) => ({
    name: m[1],
    body: m[2],
  }));
}

describe("harmony REST endpoint alignment", () => {
  it("declares only endpoints the server actually registers, with matching methods", () => {
    const declared = declaredEndpoints().map((e) => `${e.method} ${e.path}`);

    expect(declared.length).toBeGreaterThan(0);
    const routes = registeredRoutes();
    const missing = declared.filter((d) => !routes.has(d));
    expect(missing).toEqual([]);
  });

  /**
   * The guard above proves every declared endpoint EXISTS on the server. It
   * says nothing about whether the client ever calls it — and a declaration
   * with no caller is exactly how two scope gaps stayed invisible for this
   * whole project: `Endpoints.SESSIONS` had zero callers (so notification
   * titles rendered the raw `b1::default` chatKey and the resident-unread
   * invariant was never armed) and `Endpoints.FILE` had zero callers (so
   * "receive and preview images", listed as shipped in the design doc, did
   * not exist). Both passed the alignment guard every single run.
   *
   * A declared endpoint counts as called when the client either names the
   * constant (`Endpoints.SESSIONS`) or calls a URL-builder helper that
   * builds that endpoint's path.
   */
  /**
   * Harmony session-management Task 4 (2026-09-16) declares
   * SESSION_CREATE/SESSION_DELETE/SESSION_READ deliberately ahead of their
   * callers — Task 4 is scoped to the endpoint + RestClient.deleteJson
   * declarations only, Task 5 is the one that wires UI/store callers to
   * them. Rather than silently drop the "no endpoint the client never
   * calls" guard for the gap, this is an exact-match allowlist: if Task 5
   * adds a caller for one of these, this list stops matching `uncalled`
   * (see the assertion below) and the test fails until the now-satisfied
   * entry is deleted from here. It must never grow to cover an endpoint
   * that isn't actively mid-rollout like this.
   *
   * SESSION_CREATE ('POST /api/sessions') is deliberately NOT listed here:
   * the "uncalled" scan below matches by path *prefix* only, blind to HTTP
   * method, and SESSION_CREATE's prefix ('/api/sessions') is identical to
   * the pre-existing `Endpoints.SESSIONS` ('GET /api/sessions'), which
   * `sessionsUrl()` already calls. So the scan already (incorrectly, from a
   * strict reading) counts SESSION_CREATE as "called" today, ahead of any
   * real Task 5 caller — see the Task 4 report for why this was left
   * as-is rather than patched here.
   */
  const PENDING_CALLER_ENDPOINTS = new Set(["SESSION_DELETE", "SESSION_READ"]);

  it("declares no endpoint the client never calls (except endpoints named in PENDING_CALLER_ENDPOINTS)", () => {
    const endpoints = declaredEndpoints();
    const helpers = urlHelpers();
    const sources = clientSources();
    expect(sources.length).toBeGreaterThan(0);

    const uncalled = endpoints
      .filter((endpoint) => {
        // '/api/history/:chatKey' -> '/api/history/'; a path with no param
        // is its own prefix.
        const colon = endpoint.path.indexOf(":");
        const prefix = colon === -1 ? endpoint.path : endpoint.path.slice(0, colon);
        const builders = helpers.filter((h) => h.body.includes(prefix)).map((h) => h.name);
        const needles = [`Endpoints.${endpoint.name}`, ...builders.map((b) => `${b}(`)];
        return !sources.some(({ src }) => needles.some((needle) => src.includes(needle)));
      })
      .map((endpoint) => endpoint.name);

    // Exact match, not a subtraction: this fails the moment a
    // PENDING_CALLER_ENDPOINTS entry gets a caller (it drops out of
    // `uncalled`) or the moment any other endpoint goes uncalled (it's not
    // in the allowlist), so the allowlist can't silently absorb new gaps.
    expect(new Set(uncalled)).toEqual(PENDING_CALLER_ENDPOINTS);
  });
});
