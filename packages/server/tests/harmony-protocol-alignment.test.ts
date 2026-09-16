import { readdirSync, readFileSync } from "node:fs";
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

const webAdapterPath = resolve(here, "../../web/src/lib/web-adapter.ts");

/**
 * The inbound events each client resolves a session for, read out of the two
 * declarations themselves.
 *
 * This guard exists because the two lists have no shared source: web builds a
 * `Set` from `WS_EVENTS`, harmony builds a `string[]` from its own `WsEvents`
 * class, and nothing links them. The design (section 4.3 of
 * docs/superpowers/specs/2026-09-16-harmony-session-management-design.md)
 * makes the sets being IDENTICAL the whole contract — including the two
 * content-bearing events (`bridge:card`, `bridge:audio`) both clients
 * deliberately leave out — so that a keyless frame lands in the same chat on
 * both. Drift here is invisible at runtime and only surfaces as a user saying
 * a reply went to the wrong conversation on one client and not the other.
 */
function routedEventNames(source: string, declaration: RegExp): string[] {
  const block = source.match(declaration);
  if (!block) return [];
  return Array.from(block[1].matchAll(/WS_EVENTS\.([A-Z_]+)|WsEvents\.([A-Z_]+)/g)).map(
    (m) => m[1] ?? m[2],
  );
}

describe("harmony inbound session-routing set alignment", () => {
  it("routes exactly the events web routes, by shared-constant name", () => {
    const harmony = routedEventNames(
      readFileSync(protocolPath, "utf8"),
      /export const ROUTED_EVENT_TYPES: string\[\] = \[([\s\S]*?)\];/,
    );
    const web = routedEventNames(
      readFileSync(webAdapterPath, "utf8"),
      /const INCOMING_SESSION_ROUTING_TYPES = new Set<string>\(\[([\s\S]*?)\]\);/,
    );

    expect(web.length).toBe(11);
    expect(harmony.length).toBe(11);
    // Sorted: the two files are free to list them in a different order, but
    // not to disagree about the membership.
    expect([...harmony].sort()).toEqual([...web].sort());
  });

  it("keeps both clients agreeing that bridge:card and bridge:audio are not routed", () => {
    // Not redundant with the set comparison above: that one only proves the
    // two clients match. This one proves WHICH way they match, so "web widened
    // its set and harmony silently followed" still fails, and whoever widens
    // it has to state that the web-side bug from section 4.3 was actually
    // resolved rather than copied.
    const harmony = routedEventNames(
      readFileSync(protocolPath, "utf8"),
      /export const ROUTED_EVENT_TYPES: string\[\] = \[([\s\S]*?)\];/,
    );
    expect(harmony).not.toContain("BRIDGE_CARD");
    expect(harmony).not.toContain("BRIDGE_AUDIO");
    expect(WS_EVENTS.BRIDGE_CARD).toBe("bridge:card");
    expect(WS_EVENTS.BRIDGE_AUDIO).toBe("bridge:audio");
  });
});

const endpointsPath = resolve(here, "../../../harmony/entry/src/main/ets/model/Endpoints.ets");
const serverSrc = resolve(here, "../src");

/**
 * Files under `root` with the given extension, as paths relative to `root`.
 *
 * Deliberately hand-rolled rather than `fs.globSync`: that API landed in
 * Node 22, and CI runs Node 20 (`engines` says >=18), so the guard threw
 * `globSync is not a function` on every CI run -- a drift guard that never
 * reaches its assertions is exactly the silent failure it exists to prevent.
 */
function findFiles(root: string, ext: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(dir, entry.name), rel);
      else if (entry.name.endsWith(ext)) out.push(rel);
    }
  };
  walk(root, "");
  return out;
}

/** Routes fastify actually registers, including the generic-typed multi-line form. */
function registeredRoutes(): Set<string> {
  // findFiles returns paths relative to its root, so resolve them by hand.
  const files = findFiles(serverSrc, ".ts")
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
  return findFiles(clientSrc, ".ets")
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
   * SESSION_CREATE is listed too, and its presence here is itself the proof
   * that the caller scan got fixed: under the old path-prefix match it was
   * silently counted as called by `sessionsUrl()`, which serves a different
   * HTTP method on the same path. Task 5 wires all three.
   */
  const PENDING_CALLER_ENDPOINTS = new Set<string>();

  it("declares no endpoint the client never calls (except endpoints named in PENDING_CALLER_ENDPOINTS)", () => {
    const endpoints = declaredEndpoints();
    const helpers = urlHelpers();
    const sources = clientSources();
    expect(sources.length).toBeGreaterThan(0);

    const uncalled = endpoints
      .filter((endpoint) => {
        // '/api/history/:chatKey' -> '/api/history/'; a path with no param
        // is its own prefix.
        // A helper belongs to an endpoint when its BODY NAMES that endpoint
        // constant -- not when their paths happen to share a prefix. The old
        // prefix match was blind to the HTTP method and had started returning
        // wrong answers: `sessionsUrl()` (GET /api/sessions) counted as a
        // caller for SESSION_CREATE (POST /api/sessions), and wiring a caller
        // for SESSION_DELETE silently cleared SESSION_READ too, because the
        // two share `/api/sessions/`. Every helper in Endpoints.ets now
        // builds its URL from its own constant, which is what makes this
        // exact.
        const builders = helpers
          .filter((h) => h.body.includes(`Endpoints.${endpoint.name}`))
          .map((h) => h.name);
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
