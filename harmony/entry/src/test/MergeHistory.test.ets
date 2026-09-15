import { describe, it, expect } from '@ohos/hypium';
import { mergeHistoryMessages } from '../main/ets/logic/mergeHistory';
import { ChatMessage } from '../main/ets/model/Protocol';

function msg(id: string, seq?: number, timestamp: number = 0): ChatMessage {
  const message: ChatMessage = {
    id: id, role: 'user', content: id, timestamp: timestamp,
  };
  if (seq !== undefined) {
    message.seq = seq;
  }
  return message;
}

export default function mergeHistoryTest() {
  describe('mergeHistoryMessages', () => {
    it('an unacked local message (no seq) survives a cold-start merge', 0, () => {
      // Cold start: ChatStore held only a just-sent, not-yet-acked local
      // message (the exact Important-1 scenario — a bare `replaceAll` with
      // the fetched history would have wiped it).
      const existing: ChatMessage[] = [msg('local-1')];
      const backfilled: ChatMessage[] = [msg('srv-1', 1), msg('srv-2', 2)];
      const merged: ChatMessage[] = mergeHistoryMessages(existing, backfilled);
      const ids: string[] = merged.map((m: ChatMessage) => m.id);
      expect(ids.indexOf('local-1') >= 0).assertTrue();
      expect(merged.length).assertEqual(3);
    });

    it('a duplicate id arriving from both paths appears once', 0, () => {
      // Simulates Important-2: the live socket already appended this
      // message (with its real server id/seq) while the gap fetch was in
      // flight, so the backfill response contains it too.
      const existing: ChatMessage[] = [msg('srv-5', 5)];
      const backfilled: ChatMessage[] = [msg('srv-5', 5), msg('srv-6', 6)];
      const merged: ChatMessage[] = mergeHistoryMessages(existing, backfilled);
      let count: number = 0;
      for (const m of merged) {
        if (m.id === 'srv-5') {
          count += 1;
        }
      }
      expect(count).assertEqual(1);
      expect(merged.length).assertEqual(2);
    });

    it('preserves ascending seq order regardless of which array a message came from', 0, () => {
      // The incremental-append shape: `existing` already holds the earlier,
      // already-confirmed history; `backfilled` is only the gap after the
      // caller's cursor. The gap must land after the earlier history, not
      // before it, even though it's the second argument here too.
      const existing: ChatMessage[] = [msg('a', 1), msg('b', 2)];
      const backfilled: ChatMessage[] = [msg('c', 3), msg('d', 4)];
      const merged: ChatMessage[] = mergeHistoryMessages(existing, backfilled);
      const ids: string[] = merged.map((m: ChatMessage) => m.id);
      expect(ids.join(',')).assertEqual('a,b,c,d');
    });

    it('sorts out-of-order input by seq ascending', 0, () => {
      const existing: ChatMessage[] = [msg('c', 3), msg('a', 1)];
      const backfilled: ChatMessage[] = [msg('b', 2)];
      const merged: ChatMessage[] = mergeHistoryMessages(existing, backfilled);
      const ids: string[] = merged.map((m: ChatMessage) => m.id);
      expect(ids.join(',')).assertEqual('a,b,c');
    });

    it('places unacked (no-seq) messages after every seq\'d message, preserving their relative order', 0, () => {
      const existing: ChatMessage[] = [msg('local-1'), msg('confirmed-1', 1), msg('local-2')];
      const backfilled: ChatMessage[] = [];
      const merged: ChatMessage[] = mergeHistoryMessages(existing, backfilled);
      const ids: string[] = merged.map((m: ChatMessage) => m.id);
      expect(ids.join(',')).assertEqual('confirmed-1,local-1,local-2');
    });

    it('returns an empty list for two empty inputs', 0, () => {
      expect(mergeHistoryMessages([], []).length).assertEqual(0);
    });

    it('a cold-start fetch with no prior local activity just returns the backfilled history in order', 0, () => {
      const backfilled: ChatMessage[] = [msg('s1', 1), msg('s2', 2), msg('s3', 3)];
      const merged: ChatMessage[] = mergeHistoryMessages([], backfilled);
      const ids: string[] = merged.map((m: ChatMessage) => m.id);
      expect(ids.join(',')).assertEqual('s1,s2,s3');
    });
  });
}
