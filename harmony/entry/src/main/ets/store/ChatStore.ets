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
  }

  appendDelta(chatKey: string, delta: string): void {
    this.streaming.set(chatKey, this.streamingOf(chatKey) + delta);
  }

  finalizeStream(chatKey: string, fullText: string, id: string, at: number): void {
    this.streaming.delete(chatKey);
    this.append(chatKey, { id: id, role: 'assistant', content: fullText, timestamp: at });
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
  }

  clear(chatKey: string): void {
    this.messages.delete(chatKey);
    this.streaming.delete(chatKey);
  }
}
