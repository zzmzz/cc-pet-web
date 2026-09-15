import { SlashCommandSpec } from '../model/Protocol';

/**
 * One frame exactly as it arrives on the wire.
 *
 * The server sends `JSON.stringify({ type: event, ...payload })`
 * (packages/server/src/ws/hub.ts) — the payload fields are spread onto the
 * TOP LEVEL, there is no nested `payload` object. An earlier version of this
 * plan assumed a nested envelope (`RawWsEnvelope { type, payload }`); it
 * crashed on the first real message and the unit tests passed anyway,
 * because they encoded the same wrong assumption by hand-constructing
 * nested objects that never saw a real frame.
 *
 * ArkTS strict mode forbids indexed access on interfaces
 * (arkts-no-props-by-index), so fields must be declared, not read
 * dynamically. That is a feature here: when the server adds a field, this
 * interface is the one place that has to acknowledge it.
 */
export interface WsFrame {
  type: string;
  connectionId?: string;
  sessionKey?: string;
  /** bridge:message */
  content?: string;
  /** bridge:stream-delta */
  delta?: string;
  /** bridge:stream-done */
  fullText?: string;
  /** message-ack: the id this client generated */
  clientMsgId?: string;
  /** message-ack: the id the server assigned */
  id?: string;
  /** message-ack / bridge:message / bridge:stream-done: server sequence number */
  seq?: number;
  /** bridge:message / bridge:stream-done: the server-assigned message id */
  msgId?: string;
  /** resident:unread */
  unreadCount?: number;
  /** bridge:connected */
  connected?: boolean;
  /** bridge:manifest */
  bridges?: BridgeInfo[];
  /** bridge:skills-updated */
  commands?: SlashCommandSpec[];
}

export interface BridgeInfo {
  id: string;
  name: string;
  attachmentStaging?: boolean;
}

export interface NormalizedEvent {
  type: string;
  connectionId: string;
  sessionKey: string;
  chatKey: string;
  frame: WsFrame;
}

/**
 * The one session key every bridge advertised by `bridge:manifest` exposes
 * at this stage of the protocol. Declared here, next to `chatKeyOf`/
 * `splitChatKey`, because it used to be spelled out independently in both
 * `components/SessionRow.ets` and `pages/Index.ets` — the same duplication
 * Task 16 extracted `SessionRow.ets` to kill, just one file wider than that
 * extraction reached.
 */
export const DEFAULT_SESSION_KEY: string = 'default';

/** Chat key format mirrors the server: `${connectionId}::${sessionKey}`. */
export function chatKeyOf(connectionId: string, sessionKey: string): string {
  if (connectionId.length === 0 || sessionKey.length === 0) {
    return '';
  }
  return `${connectionId}::${sessionKey}`;
}

export interface ChatKeyParts {
  connectionId: string;
  sessionKey: string;
}

/**
 * Inverse of `chatKeyOf`. Splits on the FIRST `::` exactly like the server's
 * own `parseChatKey` (`packages/shared/src/utils/chat-key.ts`), so a
 * sessionKey that itself contains `::` survives the round trip instead of
 * being truncated — which a `split('::')` + `parts[1]` read silently does.
 *
 * Four call sites used to parse chat keys by hand with `?? ''` fallbacks
 * (the gateway's send/transmit paths, `assistantMessageFromFrame`, and
 * `MessageInput.toggleBridge`); all four now route through here.
 *
 * Unlike the server's version this does not throw on a malformed key — the
 * client's callers all want a value they can guard on, not an exception in
 * the middle of a socket dispatch — so a key with no separator yields two
 * empty strings. That is stricter than the old hand-rolled reads, which
 * would have handed `'abc'` back as a connectionId with an empty
 * sessionKey: an id without a session is not a chat key, and treating it as
 * one is how `MessageInput.toggleBridge` could have POSTed to a bridge id
 * derived from a string that was never a chat key at all.
 */
export function splitChatKey(chatKey: string): ChatKeyParts {
  const separator: number = chatKey.indexOf('::');
  if (separator === -1) {
    return { connectionId: '', sessionKey: '' };
  }
  return {
    connectionId: chatKey.slice(0, separator),
    sessionKey: chatKey.slice(separator + 2),
  };
}

/** Parses ids once so downstream stores never re-derive them. */
export function normalizeEvent(frame: WsFrame): NormalizedEvent {
  const connectionId: string = frame.connectionId ?? '';
  const sessionKey: string = frame.sessionKey ?? '';
  return {
    type: frame.type,
    connectionId: connectionId,
    sessionKey: sessionKey,
    chatKey: chatKeyOf(connectionId, sessionKey),
    frame: frame,
  };
}
