type ResolveIncomingSessionKeyInput = {
  payloadSessionKey?: string;
  replyCtx?: string;
  knownSessions: string[];
  activeSessionKey?: string;
  fallbackSessionKey?: string;
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
  const keyFromPayload = payloadSessionKey?.trim();
  if (keyFromPayload) return keyFromPayload;

  const keyFromReplyCtx = sessionFromReplyCtx(replyCtx);
  if (keyFromReplyCtx && (knownSessions.length === 0 || knownSessions.includes(keyFromReplyCtx))) {
    return keyFromReplyCtx;
  }

  if (activeSessionKey) return activeSessionKey;
  if (knownSessions[0]) return knownSessions[0];
  return fallbackSessionKey;
}
