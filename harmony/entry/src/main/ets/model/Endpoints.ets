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
  static readonly FILE: Endpoint = { method: 'GET', path: '/api/files/:fileId' };
  static readonly BRIDGE_CONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/connect' };
  static readonly BRIDGE_DISCONNECT: Endpoint = { method: 'POST', path: '/api/bridges/:id/disconnect' };
}

/** `/api/history/:chatKey` → `/api/history/c1%3A%3As1` */
export function historyUrl(chatKey: string, afterSeq: number, limit: number): string {
  const base: string = `/api/history/${encodeURIComponent(chatKey)}`;
  return afterSeq > 0 ? `${base}?afterSeq=${afterSeq}&limit=${limit}` : `${base}?limit=${limit}`;
}

export function petImageUrl(state: string): string {
  return `/api/pet-images/${encodeURIComponent(state)}`;
}

export function fileUrl(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

export function bridgeConnectUrl(bridgeId: string, connect: boolean): string {
  const action: string = connect ? 'connect' : 'disconnect';
  return `/api/bridges/${encodeURIComponent(bridgeId)}/${action}`;
}
