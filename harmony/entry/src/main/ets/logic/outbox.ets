export type RetryPolicy = 'auto' | 'manual' | 'never';
export type OutboxStatus = 'pending' | 'sent' | 'failed';

export const ACK_TIMEOUT_MS: number = 15000;
export const MANUAL_WINDOW_MS: number = 120000;

export interface OutboxEntry {
  clientMsgId: string;
  chatKey: string;
  text: string;
  policy: RetryPolicy;
  status: OutboxStatus;
  /** When the user asked to send. Drives the manual policy's staleness window. */
  createdAt: number;
  /**
   * When the entry was last actually written to the socket; start of the ack
   * budget. Kept separate from createdAt on purpose: sharing one field would
   * let every retransmit push the staleness window forward, so a manual entry
   * would never age out.
   */
  transmittedAt: number;
}

/** Mirrors packages/web/src/lib/store/outbox.ts so both clients fail the same way. */
export class Outbox {
  private entries: OutboxEntry[] = [];

  enqueue(clientMsgId: string, chatKey: string, text: string, policy: RetryPolicy, now: number): void {
    for (const existing of this.entries) {
      if (existing.clientMsgId === clientMsgId) {
        return;
      }
    }
    this.entries.push({
      clientMsgId: clientMsgId,
      chatKey: chatKey,
      text: text,
      policy: policy,
      status: 'pending',
      createdAt: now,
      transmittedAt: 0,
    });
  }

  markSent(clientMsgId: string): void {
    const kept: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.clientMsgId !== clientMsgId) {
        kept.push(entry);
      }
    }
    this.entries = kept;
  }

  /**
   * Restart the ack budget for entries just written to the socket.
   *
   * Only entries still waiting for an ack are touched. A failed entry must not
   * be revived here — that decision belongs to reviveAuto() or to the user's
   * explicit resend(). Writing status unconditionally would reopen the very
   * hole those two methods exist to close.
   */
  markTransmitted(ids: string[], now: number): void {
    const wanted: Set<string> = new Set<string>(ids);
    for (const entry of this.entries) {
      if (entry.status === 'pending' && wanted.has(entry.clientMsgId)) {
        entry.transmittedAt = now;
      }
    }
  }

  /** Returns the ids that just failed, so the UI can mark those bubbles. */
  expireTimedOut(now: number): string[] {
    const expired: string[] = [];
    for (const entry of this.entries) {
      const waiting: boolean = entry.status === 'pending' && entry.transmittedAt > 0;
      if (waiting && now - entry.transmittedAt > ACK_TIMEOUT_MS) {
        entry.status = 'failed';
        expired.push(entry.clientMsgId);
      }
    }
    return expired;
  }

  takeSendable(now: number): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.policy === 'never') {
        continue;
      }
      // A manual entry that outlived its window fails here rather than being
      // silently skipped: the user needs to see it went nowhere.
      if (entry.policy === 'manual' && entry.status === 'pending'
          && now - entry.createdAt > MANUAL_WINDOW_MS) {
        entry.status = 'failed';
      }
      // Only pending entries go on the wire. A failed entry needs an explicit
      // decision first — reviveAuto() on reconnect, or resend() from the user.
      if (entry.status === 'pending') {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Reconnect path: bring failed auto entries back.
   *
   * Manual entries are deliberately skipped. The user sent those by hand, so
   * they get to decide again rather than having a two-minute-old message fire
   * on its own after the network returns.
   */
  reviveAuto(now: number): void {
    for (const entry of this.entries) {
      if (entry.status === 'failed' && entry.policy === 'auto') {
        entry.status = 'pending';
        // Reset createdAt too, matching the web store: a revived entry is a
        // fresh send attempt, and anything rendering "sent N ago" should agree
        // across the two clients.
        entry.createdAt = now;
        entry.transmittedAt = 0;
      }
    }
  }

  resend(clientMsgId: string, now: number): void {
    for (const entry of this.entries) {
      if (entry.clientMsgId === clientMsgId) {
        entry.status = 'pending';
        entry.createdAt = now;
        entry.transmittedAt = 0;
      }
    }
  }

  entriesOf(chatKey: string): OutboxEntry[] {
    const out: OutboxEntry[] = [];
    for (const entry of this.entries) {
      if (entry.chatKey === chatKey) {
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Logout path only (`ConnectionGateway.stop`). Everything still queued
   * belongs to the token that queued it: without this, a message typed by
   * account A while offline survives the logout, and `flushOutbox()` writes
   * it to the socket the moment account B connects — B's bridge, B's
   * session, A's text. Not a hypothetical: `stop()` is called on all three
   * logout paths and the gateway singleton (and this Outbox with it)
   * outlives every one of them.
   */
  clear(): void {
    this.entries = [];
  }

  size(): number {
    return this.entries.length;
  }
}
