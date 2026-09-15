import type { SessionStore } from "../storage/sessions.js";
import type { ResidentRegistry } from "./registry.js";

export interface ResidentInboundDeps {
  registry: ResidentRegistry;
  sessionStore: SessionStore;
}

export interface ResidentInboundResult {
  unreadCount: number;
  ownerToken?: string;
}

/**
 * Called for every assistant-side bridge message. If the (connectionId,
 * sessionKey) is a resident session, bumps its persisted unread counter and
 * returns the new count + owning token. Returns null for non-resident sessions.
 */
export function onResidentAssistantMessage(
  deps: ResidentInboundDeps,
  connectionId: string,
  sessionKey: string,
): ResidentInboundResult | null {
  if (!deps.registry.isResident(connectionId, sessionKey)) return null;
  const unreadCount = deps.sessionStore.incrementUnread(connectionId, sessionKey);
  return { unreadCount, ownerToken: deps.registry.ownerToken(connectionId, sessionKey) };
}
