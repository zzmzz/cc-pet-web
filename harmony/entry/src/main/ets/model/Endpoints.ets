export interface Endpoint {
  method: string;
  path: string;
}

/**
 * Every REST endpoint the client calls, declared once.
 *
 * Paths use the server's own parameter syntax (`:chatKey`) so the alignment
 * guard can match them against the routes fastify actually registers. Build
 * concrete URLs with the helpers below rather than concatenating by hand.
 */
export class Endpoints {
  static readonly AUTH_VERIFY: Endpoint = { method: 'POST', path: '/api/auth/verify' };
  static readonly SESSIONS: Endpoint = { method: 'GET', path: '/api/sessions' };
  static readonly HISTORY: Endpoint = { method: 'GET', path: '/api/history/:chatKey' };
  static readonly PET_IMAGE: Endpoint = { method: 'GET', path: '/api/pet-images/:state' };
  // No `FILE` entry: image receive/preview is not in the first release (see
  // harmony/README.md and spec §2). `/api/files/:fileId` and its `fileUrl()`
  // helper were declared here with zero callers for the whole project and
  // were removed rather than left standing as a promise the client does not
  // keep — the caller assertion in
  // packages/server/tests/harmony-protocol-alignment.test.ts now fails the
  // build on any endpoint declared and never called, so this cannot come
  // back silently.
  static readonly BRIDGE_CONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/connect' };
  static readonly BRIDGE_DISCONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/disconnect' };
  static readonly SESSION_CREATE: Endpoint = { method: 'POST', path: '/api/sessions' };
  static readonly SESSION_DELETE: Endpoint = { method: 'DELETE', path: '/api/sessions/:connectionId/:key' };
  static readonly SESSION_READ: Endpoint = { method: 'POST', path: '/api/sessions/:connectionId/:key/read' };
}

/**
 * Substitutes `:param` placeholders in a declared path, left to right.
 *
 * Every helper below builds its URL from its own `Endpoint` constant rather
 * than repeating the path as a literal. Two reasons, both learned the hard
 * way: the path is then declared exactly once, and — because the alignment
 * guard in packages/server/tests/harmony-protocol-alignment.test.ts decides
 * "does this endpoint have a caller?" by looking for `Endpoints.<NAME>` — a
 * helper now proves which endpoint it serves instead of being matched to one
 * by path prefix. That prefix matching was blind to the HTTP method and had
 * started returning wrong answers: `sessionsUrl()` (GET /api/sessions) was
 * being counted as a caller for SESSION_CREATE (POST /api/sessions), and a
 * caller for SESSION_DELETE silently also cleared SESSION_READ because the
 * two share a prefix.
 */
function fillPath(path: string, values: string[]): string {
  let out: string = path;
  for (const value of values) {
    out = out.replace(/:[A-Za-z]+/, encodeURIComponent(value));
  }
  return out;
}

/** `/api/history/:chatKey` → `/api/history/c1%3A%3As1` */
export function historyUrl(chatKey: string, afterSeq: number, limit: number): string {
  const base: string = fillPath(Endpoints.HISTORY.path, [chatKey]);
  return afterSeq > 0 ? `${base}?afterSeq=${afterSeq}&limit=${limit}` : `${base}?limit=${limit}`;
}

/**
 * `/api/sessions` returns `{ sessions: [] }` unless `connectionId` is
 * supplied (see `registerSessionRoutes` in packages/server) — the query
 * param is not optional in practice, it is the difference between data and
 * an empty list. `packages/web` calls it the same way, once per connection.
 */
export function sessionsUrl(connectionId: string): string {
  return `${Endpoints.SESSIONS.path}?connectionId=${encodeURIComponent(connectionId)}`;
}

export function petImageUrl(state: string): string {
  return fillPath(Endpoints.PET_IMAGE.path, [state]);
}

export function bridgeConnectUrl(bridgeId: string, connect: boolean): string {
  const endpoint: Endpoint = connect ? Endpoints.BRIDGE_CONNECT : Endpoints.BRIDGE_DISCONNECT;
  return fillPath(endpoint.path, [bridgeId]);
}

export function sessionDeleteUrl(connectionId: string, key: string): string {
  return fillPath(Endpoints.SESSION_DELETE.path, [connectionId, key]);
}

export function sessionReadUrl(connectionId: string, key: string): string {
  return fillPath(Endpoints.SESSION_READ.path, [connectionId, key]);
}
