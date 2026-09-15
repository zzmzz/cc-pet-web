import { webSocket, connection } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { backoffDelayMs } from '../logic/backoff';
import { normalizeEvent, RawWsEnvelope, NormalizedEvent, WsPayload } from '../logic/normalizeEvent';
import { Outbox, OutboxEntry, RetryPolicy } from '../logic/outbox';
import { WsEvents, ChatMessage } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { NotificationGateway } from './NotificationGateway';

// ConnectionPhase itself lives in store/ConnectionStore.ets — the field it
// types belongs to that store, and Store must not import from Gateway
// (dependency direction is Gateway -> Store, per Global Constraints).

const ACK_SWEEP_MS: number = 5000;

interface OutgoingEnvelope {
  type: string;
  connectionId: string;
  sessionKey: string;
  content: string;
  clientMsgId: string;
}

/**
 * Shape of what actually arrives on the wire.
 *
 * `RawWsEnvelope` (logic/normalizeEvent.ets, owned by an earlier task) models
 * `{ type, payload: {...} }` — a nested envelope. The server does not send
 * that: `ClientHub.broadcast()`/`onClientConnected`'s `send()`
 * (packages/server/src/ws/hub.ts) both do
 * `ws.send(JSON.stringify({ type: event, ...payload }))`, which spreads the
 * payload fields onto the top-level object instead of nesting them. Parsing
 * a real frame directly as `RawWsEnvelope` and reading `raw.payload.x`
 * therefore reads `undefined.x` and throws — reproduced live on the emulator
 * against a real server (see Task 11 report). `WireMessage` models the
 * actual flat shape (every field `WsPayload` declares, since those are
 * exactly the fields the server spreads); `toEnvelope()` re-nests it into
 * what `normalizeEvent()` (unmodified, per Task 11's constraints) expects.
 */
interface WireMessage {
  type: string;
  connectionId?: string;
  sessionKey?: string;
  content?: string;
  delta?: string;
  fullText?: string;
  clientMsgId?: string;
  id?: string;
  seq?: number;
  unreadCount?: number;
  connected?: boolean;
}

function toEnvelope(msg: WireMessage): RawWsEnvelope {
  const payload: WsPayload = {
    connectionId: msg.connectionId,
    sessionKey: msg.sessionKey,
    content: msg.content,
    delta: msg.delta,
    fullText: msg.fullText,
    clientMsgId: msg.clientMsgId,
    id: msg.id,
    seq: msg.seq,
    unreadCount: msg.unreadCount,
    connected: msg.connected,
  };
  return { type: msg.type, payload: payload };
}

/**
 * Gateway, not a Store: it holds no `@Trace` state of its own and nothing
 * observes it reactively, so — unlike ChatStore/SessionStore/TaskStore/
 * ConnectionStore — it stays a plain `static readonly instance` per Global
 * Constraints (that rule is scoped to Store singletons).
 */
export class ConnectionGateway {
  static readonly instance: ConnectionGateway = new ConnectionGateway();

  private socket: webSocket.WebSocket | undefined = undefined;
  private netConn: connection.NetConnection | undefined = undefined;
  private attempt: number = 0;
  private timer: number = -1;
  private sweepTimer: number = -1;
  private baseUrl: string = '';
  private token: string = '';
  private outbox: Outbox = new Outbox();
  private stopped: boolean = true;
  private foreground: boolean = true;

  start(baseUrl: string, token: string): void {
    this.baseUrl = baseUrl;
    this.token = token;
    this.stopped = false;
    this.attempt = 0;
    this.observeNetwork();
    this.startAckSweep();
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.sweepTimer !== -1) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = -1;
    }
    if (this.socket !== undefined) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.netConn !== undefined) {
      this.netConn.unregister(() => {});
      this.netConn = undefined;
    }
    ConnectionStore.connect().setPhase('disconnected');
  }

  setForeground(value: boolean): void {
    this.foreground = value;
  }

  private clearTimer(): void {
    if (this.timer !== -1) {
      clearTimeout(this.timer);
      this.timer = -1;
    }
  }

  private wsUrl(): string {
    const scheme: string = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
    const host: string = this.baseUrl.replace(/^https?/, '');
    return `${scheme}${host}/ws?token=${encodeURIComponent(this.token)}`;
  }

  private open(): void {
    if (this.stopped) {
      return;
    }
    this.clearTimer();
    ConnectionStore.connect().setPhase('connecting');

    if (this.socket !== undefined) {
      this.socket.close();
    }
    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    this.socket = socket;

    // Every handler below is registered on this exact `socket` instance, but
    // `this.socket.close()` above does not synchronously unregister them —
    // the old socket's 'close'/'error' still fire asynchronously afterward.
    // Without the `this.socket !== socket` guard, that stale event calls
    // scheduleReconnect() against the *current* gateway state even once a
    // newer socket has already connected successfully, producing a
    // self-inflicted reconnect loop with a period of exactly
    // backoffDelayMs(0) (1000ms) — reproduced live on the emulator against a
    // real server (see Task 11 report) before this guard was added.
    socket.on('open', () => {
      if (this.socket !== socket) {
        return;
      }
      this.attempt = 0;
      ConnectionStore.connect().setPhase('connected');
      ConnectionStore.connect().markConnectedAt(Date.now());
      this.flushOutbox();
    });

    socket.on('message', (err: Error | undefined, data: string | ArrayBuffer) => {
      if (this.socket !== socket || err !== undefined || typeof data !== 'string') {
        return;
      }
      this.dispatch(normalizeEvent(toEnvelope(JSON.parse(data as string) as WireMessage)));
    });

    socket.on('close', () => {
      if (this.socket !== socket) {
        return;
      }
      this.scheduleReconnect();
    });
    socket.on('error', () => {
      if (this.socket !== socket) {
        return;
      }
      this.scheduleReconnect();
    });

    socket.connect(this.wsUrl(), (err: Error | undefined) => {
      if (this.socket !== socket) {
        return;
      }
      if (err !== undefined) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== -1) {
      return;
    }
    ConnectionStore.connect().setPhase('backoff');
    const delay: number = backoffDelayMs(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = -1;
      this.open();
    }, delay);
  }

  /** Network came back: retry immediately instead of waiting out the backoff. */
  private observeNetwork(): void {
    if (this.netConn !== undefined) {
      return;
    }
    const netConn: connection.NetConnection = connection.createNetConnection();
    this.netConn = netConn;
    netConn.on('netAvailable', () => {
      this.attempt = 0;
      this.clearTimer();
      this.open();
    });
    netConn.register(() => {});
  }

  /** Entries whose ack never arrived turn failed, so their bubbles can go red. */
  private startAckSweep(): void {
    if (this.sweepTimer !== -1) {
      return;
    }
    this.sweepTimer = setInterval(() => {
      this.outbox.expireTimedOut(Date.now());
    }, ACK_SWEEP_MS);
  }

  sendMessage(chatKey: string, text: string): string {
    const clientMsgId: string = util.generateRandomUUID(true);
    const parts: string[] = chatKey.split('::');
    const connectionId: string = parts[0] ?? '';
    const sessionKey: string = parts[1] ?? '';
    const now: number = Date.now();

    ChatStore.connect().append(chatKey, {
      id: clientMsgId, role: 'user', content: text, timestamp: now,
      connectionId: connectionId, sessionKey: sessionKey,
    });

    const policy: RetryPolicy = 'auto';
    this.outbox.enqueue(clientMsgId, chatKey, text, policy, now);
    if (ConnectionStore.connect().phase === 'connected') {
      this.transmit([clientMsgId]);
    }
    return clientMsgId;
  }

  /** User tapped retry on one failed bubble. */
  retry(clientMsgId: string): void {
    this.outbox.resend(clientMsgId, Date.now());
    if (ConnectionStore.connect().phase === 'connected') {
      this.transmit([clientMsgId]);
    }
  }

  private transmit(ids: string[]): void {
    if (this.socket === undefined) {
      return;
    }
    const sent: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      let wanted: boolean = false;
      for (const id of ids) {
        if (entry.clientMsgId === id) {
          wanted = true;
        }
      }
      if (!wanted) {
        continue;
      }
      const parts: string[] = entry.chatKey.split('::');
      const envelope: OutgoingEnvelope = {
        type: WsEvents.SEND_MESSAGE,
        connectionId: parts[0] ?? '',
        sessionKey: parts[1] ?? '',
        content: entry.text,
        clientMsgId: entry.clientMsgId,
      };
      this.socket.send(JSON.stringify(envelope));
      sent.push(entry.clientMsgId);
    }
    this.outbox.markTransmitted(sent, Date.now());
  }

  /** Reconnect path: everything still sendable goes back out, oldest first. */
  private flushOutbox(): void {
    this.outbox.reviveAuto(Date.now());
    const ids: string[] = [];
    for (const entry of this.outbox.takeSendable(Date.now())) {
      ids.push(entry.clientMsgId);
    }
    this.transmit(ids);
  }

  /**
   * Notification predicate: is the user not looking at this chat right now?
   * Deliberately separate from unread counting — resident sessions take their
   * unread from the server, but "should I buzz" is always a local question.
   */
  private isAway(chatKey: string): boolean {
    return chatKey !== SessionStore.connect().currentChatKey || !this.foreground;
  }

  private dispatch(event: NormalizedEvent): void {
    if (event.type === WsEvents.MESSAGE_ACK) {
      const clientMsgId: string = event.payload.clientMsgId ?? '';
      if (clientMsgId.length === 0) {
        return;
      }
      this.outbox.markSent(clientMsgId);
      ChatStore.connect().applyAck(clientMsgId, event.payload.id ?? clientMsgId, event.payload.seq ?? 0);
      return;
    }
    if (event.type === WsEvents.RESIDENT_UNREAD) {
      SessionStore.connect().setUnread(event.chatKey, event.payload.unreadCount ?? 0);
      return;
    }
    if (event.type === WsEvents.BRIDGE_CONNECTED) {
      ConnectionStore.connect().setBridgeConnected(true);
      ConnectionStore.connect().markConnectedAt(Date.now());
      return;
    }
    if (event.type === WsEvents.BRIDGE_ERROR) {
      ConnectionStore.connect().setBridgeConnected(false);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MANIFEST) {
      SessionStore.connect().applyManifest(event.payload);
      return;
    }
    if (event.type === WsEvents.BRIDGE_SKILLS_UPDATED) {
      SessionStore.connect().applySkills(event.payload);
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_START) {
      TaskStore.connect().setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_TYPING_STOP) {
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DELTA) {
      ChatStore.connect().appendDelta(event.chatKey, event.payload.delta ?? '');
      TaskStore.connect().setPhase(event.chatKey, 'working');
      return;
    }
    if (event.type === WsEvents.BRIDGE_STREAM_DONE) {
      const text: string = event.payload.fullText ?? '';
      ChatStore.connect().finalizeStream(event.chatKey, text, `srv-${Date.now()}`, Date.now());
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, text);
      return;
    }
    if (event.type === WsEvents.BRIDGE_MESSAGE) {
      const text: string = event.payload.content ?? '';
      const message: ChatMessage = {
        id: `srv-${Date.now()}`, role: 'assistant', content: text, timestamp: Date.now(),
        connectionId: event.connectionId, sessionKey: event.sessionKey,
      };
      ChatStore.connect().append(event.chatKey, message);
      TaskStore.connect().setPhase(event.chatKey, 'completed');
      this.afterAssistantReply(event.chatKey, text);
    }
  }

  private afterAssistantReply(chatKey: string, text: string): void {
    if (!this.isAway(chatKey)) {
      return;
    }
    // Resident sessions get their unread from resident:unread; incrementUnread
    // is a no-op for them by design (see SessionStore).
    SessionStore.connect().incrementUnread(chatKey);
    NotificationGateway.instance.notifyReply(
      SessionStore.connect().labelOf(chatKey),
      text.length > 80 ? `${text.slice(0, 80)}…` : text,
    );
  }
}
