type ResolveIncomingSessionKeyInput = {
  payloadSessionKey?: string;
  replyCtx?: string;
  knownSessions: string[];
  activeSessionKey?: string;
  fallbackSessionKey?: string;
};

export type SessionRouteSource = "payload" | "reply_ctx" | "active" | "known" | "fallback";

export type SessionRouteDecision = {
  sessionKey: string;
  source: SessionRouteSource;
};

export function sessionFromReplyCtx(replyCtx?: string): string | null {
  if (!replyCtx) return null;
  if (!replyCtx.startsWith("ccpet:")) return null;
  const body = replyCtx.slice("ccpet:".length);
  const idx = body.lastIndexOf(":");
  if (idx <= 0) return null;
  return body.slice(0, idx);
}

export function resolveIncomingSessionKey({
  payloadSessionKey,
  replyCtx,
  knownSessions,
  activeSessionKey,
  fallbackSessionKey = "default",
}: ResolveIncomingSessionKeyInput): string {
  return resolveIncomingSessionRouting({
    payloadSessionKey,
    replyCtx,
    knownSessions,
    activeSessionKey,
    fallbackSessionKey,
  }).sessionKey;
}

export function resolveIncomingSessionRouting({
  payloadSessionKey,
  replyCtx,
  knownSessions,
  activeSessionKey,
  fallbackSessionKey = "default",
}: ResolveIncomingSessionKeyInput): SessionRouteDecision {
  const keyFromPayload = payloadSessionKey?.trim();
  if (keyFromPayload) return { sessionKey: keyFromPayload, source: "payload" };

  const keyFromReplyCtx = sessionFromReplyCtx(replyCtx);
  if (keyFromReplyCtx && (knownSessions.length === 0 || knownSessions.includes(keyFromReplyCtx))) {
    return { sessionKey: keyFromReplyCtx, source: "reply_ctx" };
  }

  if (activeSessionKey) return { sessionKey: activeSessionKey, source: "active" };
  if (knownSessions[0]) return { sessionKey: knownSessions[0], source: "known" };
  return { sessionKey: fallbackSessionKey, source: "fallback" };
}
