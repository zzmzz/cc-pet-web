export class WsEvents {
  static readonly BRIDGE_MANIFEST: string = 'bridge:manifest';
  static readonly BRIDGE_CONNECTED: string = 'bridge:connected';
  static readonly BRIDGE_ERROR: string = 'bridge:error';
  static readonly BRIDGE_MESSAGE: string = 'bridge:message';
  static readonly BRIDGE_STREAM_DELTA: string = 'bridge:stream-delta';
  static readonly BRIDGE_STREAM_DONE: string = 'bridge:stream-done';
  static readonly BRIDGE_BUTTONS: string = 'bridge:buttons';
  static readonly BRIDGE_TYPING_START: string = 'bridge:typing-start';
  static readonly BRIDGE_TYPING_STOP: string = 'bridge:typing-stop';
  static readonly BRIDGE_FILE_RECEIVED: string = 'bridge:file-received';
  static readonly BRIDGE_SKILLS_UPDATED: string = 'bridge:skills-updated';
  static readonly BRIDGE_PREVIEW_START: string = 'bridge:preview-start';
  static readonly BRIDGE_PREVIEW_UPDATE: string = 'bridge:preview-update';
  static readonly BRIDGE_PREVIEW_DELETE: string = 'bridge:preview-delete';
  static readonly BRIDGE_CARD: string = 'bridge:card';
  static readonly BRIDGE_AUDIO: string = 'bridge:audio';
  static readonly RESIDENT_UNREAD: string = 'resident:unread';
  static readonly SEND_MESSAGE: string = 'send-message';
  static readonly SEND_BUTTON: string = 'send-button';
  static readonly SEND_FILE: string = 'send-file';
  static readonly MESSAGE_ACK: string = 'message-ack';
}

/**
 * The inbound events whose target session is resolved by
 * `resolveIncomingSessionRouting` (logic/sessionRouting.ets) before they
 * reach any store. Everything else keeps the `sessionKey` the server put on
 * the wire.
 *
 * Exactly the 11 types web routes -- `INCOMING_SESSION_ROUTING_TYPES` in
 * `packages/web/src/lib/web-adapter.ts` -- and every one of them was read
 * back off `packages/shared/src/constants/events.ts`, which is the only
 * source of truth for these spellings (a name copied from a design doc is a
 * name nothing verifies).
 *
 * This client does not consume all 11 yet: `bridge:buttons`,
 * `bridge:file-received` and the three `bridge:preview-*` have no branch in
 * `ConnectionGateway.dispatch`. They are listed anyway, because the failure
 * mode of adding them later is silent -- a rich-message branch wired up
 * against an unrouted event type would put keyless frames in the wrong chat
 * and nothing would report it.
 *
 * `bridge:card` and `bridge:audio` carry session content too and are
 * deliberately NOT here. Web does not route them; this client mirrors web
 * rather than forking silently (spec section 4.3 of
 * docs/superpowers/specs/2026-09-16-harmony-session-management-design.md).
 * That may well be a web-side oversight, in which case it gets reported as a
 * web bug and fixed on both sides at once -- what it must not become is a
 * one-sided fix that makes two clients disagree about where a frame belongs.
 * `RoutingEventSet.test.ets` pins the count at 11 and pins those two out, so
 * widening this list means editing a test that explains the decision.
 */
export const ROUTED_EVENT_TYPES: string[] = [
  WsEvents.BRIDGE_MESSAGE,
  WsEvents.BRIDGE_STREAM_DELTA,
  WsEvents.BRIDGE_STREAM_DONE,
  WsEvents.BRIDGE_BUTTONS,
  WsEvents.BRIDGE_FILE_RECEIVED,
  WsEvents.BRIDGE_TYPING_START,
  WsEvents.BRIDGE_TYPING_STOP,
  WsEvents.BRIDGE_PREVIEW_START,
  WsEvents.BRIDGE_PREVIEW_UPDATE,
  WsEvents.BRIDGE_PREVIEW_DELETE,
  WsEvents.BRIDGE_ERROR,
];

/** True when this event type's target session must be resolved before dispatch. */
export function isRoutedEventType(type: string): boolean {
  return ROUTED_EVENT_TYPES.includes(type);
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  connectionId?: string;
  sessionKey?: string;
  /** Server-assigned sequence number, present once acked. Drives history backfill. */
  seq?: number;
}

export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
  /** True when this session is a config-declared resident session. */
  isResident?: boolean;
  /** Server-persisted unread count (resident sessions only). */
  unreadCount?: number;
}

export type TaskPhase =
  | 'idle' | 'thinking' | 'working' | 'awaiting_confirmation'
  | 'completed' | 'failed' | 'stalled';

export type PetState = 'idle' | 'thinking' | 'talking' | 'happy' | 'error';

export type SlashCommandType = 'local' | 'send';
export type SlashCommandCategory = 'builtin' | 'session' | 'agent' | 'skill';

export interface SlashCommandSpec {
  command: string;
  description: string;
  category: SlashCommandCategory;
  type: SlashCommandType;
}
