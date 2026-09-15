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

/** Chat key format mirrors the server: `${connectionId}::${sessionKey}`. */
export function chatKeyOf(connectionId: string, sessionKey: string): string {
  if (connectionId.length === 0 || sessionKey.length === 0) {
    return '';
  }
  return `${connectionId}::${sessionKey}`;
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
