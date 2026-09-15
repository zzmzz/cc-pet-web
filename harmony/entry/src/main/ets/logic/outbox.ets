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

  markTransmitted(ids: string[], now: number): void {
    for (const entry of this.entries) {
      for (const id of ids) {
        if (entry.clientMsgId === id) {
          entry.transmittedAt = now;
          entry.status = 'pending';
        }
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
      if (entry.policy === 'manual' && now - entry.createdAt > MANUAL_WINDOW_MS) {
        continue;
      }
      out.push(entry);
    }
    return out;
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

  size(): number {
    return this.entries.length;
  }
}
