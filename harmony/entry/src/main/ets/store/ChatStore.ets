import { AppStorageV2 } from '@kit.ArkUI';
import { ChatMessage } from '../model/Protocol';

const APP_STORAGE_KEY: string = 'ChatStore';

/**
 * Must be obtained through `AppStorageV2.connect()` — see Global Constraints
 * in docs/superpowers/plans/2026-09-15-harmony-client.md and
 * .superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md for
 * why a bare `static readonly instance` does not register consumers as V2
 * observers. A `private constructor()` was not attempted here — it is known
 * to fail ArkTS compilation (see AuthStore.ets for the exact error); the
 * single-access-point rule is enforced by convention/review only.
 */
@ObservedV2
export class ChatStore {
  static connect(): ChatStore {
    const instance: ChatStore | undefined =
      AppStorageV2.connect(ChatStore, APP_STORAGE_KEY, (): ChatStore => new ChatStore());
    if (instance === undefined) {
      throw new Error('ChatStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  @Trace private messages: Map<string, ChatMessage[]> = new Map<string, ChatMessage[]>();
  @Trace private streaming: Map<string, string> = new Map<string, string>();

  /**
   * Bumped by every mutation below. `build()` already re-runs on its own
   * when `messages`/`streaming` change (that is what `@Trace` is for), but a
   * side effect that must run *after* such a change — `MessageList`'s
   * scroll-to-bottom — has no `build()` to hang off. `@Monitor` is the V2
   * tool for that, and `@Monitor` needs a named field to watch: the two maps
   * above are `private`, so a consumer cannot name them in a monitor path.
   * This counter is that name. It also removes the last reason
   * `MessageList` kept a 1 Hz timer: auto-scroll used to fire only off that
   * tick, so a new message could sit below the fold for up to a second.
   */
  @Trace revision: number = 0;

  messagesOf(chatKey: string): ChatMessage[] {
    return this.messages.get(chatKey) ?? [];
  }

  streamingOf(chatKey: string): string {
    return this.streaming.get(chatKey) ?? '';
  }

  append(chatKey: string, message: ChatMessage): void {
    const list: ChatMessage[] = this.messagesOf(chatKey).slice();
    list.push(message);
    this.messages.set(chatKey, list);
    this.revision += 1;
  }

  appendDelta(chatKey: string, delta: string): void {
    this.streaming.set(chatKey, this.streamingOf(chatKey) + delta);
    this.revision += 1;
  }

  finalizeStream(chatKey: string, fullText: string, id: string, at: number, seq: number): void {
    this.streaming.delete(chatKey);
    // `append` bumps `revision` for us.
    this.append(chatKey, { id: id, role: 'assistant', content: fullText, timestamp: at, seq: seq });
  }

  /** message-ack arrived: swap the local id for the server's and record its seq. */
  applyAck(clientMsgId: string, serverId: string, seq: number): void {
    this.messages.forEach((list: ChatMessage[], key: string) => {
      let changed: boolean = false;
      const next: ChatMessage[] = [];
      for (const msg of list) {
        if (msg.id === clientMsgId) {
          next.push({
            id: serverId, role: msg.role, content: msg.content, timestamp: msg.timestamp,
            connectionId: msg.connectionId, sessionKey: msg.sessionKey, seq: seq,
          });
          changed = true;
        } else {
          next.push(msg);
        }
      }
      if (changed) {
        this.messages.set(key, next);
        this.revision += 1;
      }
    });
  }

  /** Highest server seq seen in this chat; 0 when none. Drives history backfill. */
  maxSeqOf(chatKey: string): number {
    let max: number = 0;
    for (const msg of this.messagesOf(chatKey)) {
      const seq: number = msg.seq ?? 0;
      if (seq > max) {
        max = seq;
      }
    }
    return max;
  }

  replaceAll(chatKey: string, history: ChatMessage[]): void {
    this.messages.set(chatKey, history);
    this.revision += 1;
  }

  clear(chatKey: string): void {
    this.messages.delete(chatKey);
    this.streaming.delete(chatKey);
    this.revision += 1;
  }

  /**
   * Logout path only (`ConnectionGateway.stop`). `clear(chatKey)` drops one
   * chat; this drops every chat, because the transcripts belong to the token
   * that fetched them. Without it the next account to log in on this device
   * opens straight into the previous account's messages — the store is an
   * `AppStorageV2` singleton that outlives any one session, and `Index` is
   * the `@Entry` struct, never remounted on logout.
   */
  clearAll(): void {
    this.messages = new Map<string, ChatMessage[]>();
    this.streaming = new Map<string, string>();
    this.revision += 1;
  }
}
