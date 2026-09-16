/**
 * Decides which session an inbound WS frame belongs to.
 *
 * Mirrors `packages/web/src/lib/sessionRouting.ts` branch for branch. The
 * priority order is load-bearing: a reply that arrives without a
 * `sessionKey` must land in the session that ASKED, not in whichever
 * session the user has since switched to. Get this wrong and a late reply
 * leaks into a freshly-created conversation, which reads to the user as
 * "my message went to the wrong chat".
 *
 * Pure: no store access, no clock. Every branch is unit-tested.
 */
export type SessionRouteSource = 'payload' | 'reply_ctx' | 'active' | 'known' | 'fallback';

export interface SessionRouteDecision {
  sessionKey: string;
  source: SessionRouteSource;
}

export interface SessionRouteInput {
  payloadSessionKey?: string;
  /** The server's opaque reply context, `ccpet:<sessionKey>:<turnId>`. */
  replyCtx?: string;
  knownSessions: string[];
  activeSessionKey?: string;
  fallbackSessionKey?: string;
}

/**
 * `ccpet:<sessionKey>:<turnId>` → `<sessionKey>`.
 *
 * Splits on the LAST colon, not the first: a session key may itself contain
 * a colon, and the trailing turn id never does.
 */
export function sessionFromReplyCtx(replyCtx?: string): string | null {
  if (replyCtx === undefined || replyCtx.length === 0) {
    return null;
  }
  const prefix: string = 'ccpet:';
  if (!replyCtx.startsWith(prefix)) {
    return null;
  }
  const body: string = replyCtx.substring(prefix.length);
  const idx: number = body.lastIndexOf(':');
  if (idx <= 0) {
    return null;
  }
  return body.substring(0, idx);
}

export function resolveIncomingSessionRouting(input: SessionRouteInput): SessionRouteDecision {
  const fallback: string = input.fallbackSessionKey ?? 'default';

  const fromPayload: string = (input.payloadSessionKey ?? '').trim();
  if (fromPayload.length > 0) {
    return { sessionKey: fromPayload, source: 'payload' };
  }

  const fromReplyCtx: string | null = sessionFromReplyCtx(input.replyCtx);
  if (fromReplyCtx !== null) {
    // An unknown key from replyCtx is not trusted once we know the real
    // session list — it would invent a chat that does not exist.
    if (input.knownSessions.length === 0 || input.knownSessions.includes(fromReplyCtx)) {
      return { sessionKey: fromReplyCtx, source: 'reply_ctx' };
    }
  }

  const active: string = input.activeSessionKey ?? '';
  if (active.length > 0) {
    return { sessionKey: active, source: 'active' };
  }

  if (input.knownSessions.length > 0) {
    return { sessionKey: input.knownSessions[0], source: 'known' };
  }

  return { sessionKey: fallback, source: 'fallback' };
}
