/**
 * Union of every payload field the first release consumes.
 *
 * ArkTS strict mode forbids indexed access on interfaces
 * (arkts-no-props-by-index), so payload fields must be declared, not read
 * dynamically. That is a feature here: when the server adds a field, this
 * interface is the one place that has to acknowledge it.
 */
export interface WsPayload {
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
  /** message-ack: server sequence number */
  seq?: number;
  /** resident:unread */
  unreadCount?: number;
  /** bridge:connected */
  connected?: boolean;
}

export interface RawWsEnvelope {
  type: string;
  payload: WsPayload;
}

export interface NormalizedEvent {
  type: string;
  connectionId: string;
  sessionKey: string;
  chatKey: string;
  payload: WsPayload;
}

/** Chat key format mirrors the server: `${connectionId}::${sessionKey}`. */
export function chatKeyOf(connectionId: string, sessionKey: string): string {
  if (connectionId.length === 0 || sessionKey.length === 0) {
    return '';
  }
  return `${connectionId}::${sessionKey}`;
}

/** Parses ids once so downstream stores never re-derive them. */
export function normalizeEvent(raw: RawWsEnvelope): NormalizedEvent {
  const connectionId: string = raw.payload.connectionId ?? '';
  const sessionKey: string = raw.payload.sessionKey ?? '';
  return {
    type: raw.type,
    connectionId: connectionId,
    sessionKey: sessionKey,
    chatKey: chatKeyOf(connectionId, sessionKey),
    payload: raw.payload,
  };
}
