import { ChatMessage } from '../model/Protocol';

/**
 * Pure merge/dedup decision behind `ConnectionGateway.backfillHistory` (Task
 * 17 fix round). Added as a new `logic/` file rather than folded into
 * `ConnectionGateway.ets` so the merge logic — the actual defect surface for
 * Important-1 and Important-2 — is unit-testable like the rest of `logic/`,
 * per precedent (`logic/assistantMessageFromFrame.ets`, added the same way
 * in Task 11's fix round).
 *
 * `existing` is whatever is currently in `ChatStore` for this chat, read
 * *after* the history fetch resolves (not the pre-fetch cursor snapshot) —
 * that is what lets a message the user sent, or a message the live
 * WebSocket delivered, *while the fetch was in flight* survive the merge
 * instead of being silently overwritten:
 *
 * - **Important-1** (cold-start `replaceAll` deleting a just-sent message):
 *   an unacked local message has no `seq` (only assigned on ack — see
 *   `ChatStore.applyAck`). It is never present in `backfilled` (the server
 *   has never seen it), so it always survives into the merged result.
 * - **Important-2** (the append branch duplicating a live message): a
 *   message delivered over the socket during the backfill round-trip is
 *   appended to `existing` by `ConnectionGateway.dispatch` with its real
 *   server `id`. If the same message also comes back in `backfilled` (the
 *   gap fetch caught it too), both copies share that `id`, so the dedup-by-
 *   `id` step below keeps exactly one.
 *
 * Ordering: every message with a real `seq` (> 0 — 0/absent means
 * "unacked", matching `ChatStore.maxSeqOf`'s own treatment of a missing
 * `seq`) is sorted ascending by `seq`, regardless of which array it came
 * from or what order the two arrays were concatenated in — this is what
 * makes the same function correct for both call sites: the cold-start
 * branch (`backfilled` is the whole known history) and the incremental
 * append branch (`backfilled` is only the gap after the caller's cursor,
 * which must land *after* `existing`'s own already-confirmed history, not
 * before it). Messages without a `seq` (always locally-originated, never-
 * yet-acked sends) have no server position to sort by, so they're placed
 * after every `seq`'d message, in their original relative order — the
 * newest, not-yet-confirmed tail of the conversation.
 *
 * Pure: no store access, no network, no clock. Deterministic in the input
 * arrays' contents only.
 */
export function mergeHistoryMessages(existing: ChatMessage[], backfilled: ChatMessage[]): ChatMessage[] {
  const byId: Map<string, ChatMessage> = new Map<string, ChatMessage>();
  const order: string[] = [];

  for (const message of existing) {
    if (!byId.has(message.id)) {
      order.push(message.id);
    }
    byId.set(message.id, message);
  }
  for (const message of backfilled) {
    if (!byId.has(message.id)) {
      order.push(message.id);
    }
    // Last write wins on a duplicate id: the backfilled copy (server truth)
    // replaces the locally-held one. In practice the two are identical
    // content — same id means same server message — so this only matters
    // for which object reference survives, not for what the user sees.
    byId.set(message.id, message);
  }

  const deduped: ChatMessage[] = [];
  for (const id of order) {
    const message: ChatMessage | undefined = byId.get(id);
    if (message !== undefined) {
      deduped.push(message);
    }
  }

  const withSeq: ChatMessage[] = [];
  const withoutSeq: ChatMessage[] = [];
  for (const message of deduped) {
    if ((message.seq ?? 0) > 0) {
      withSeq.push(message);
    } else {
      withoutSeq.push(message);
    }
  }
  withSeq.sort((a: ChatMessage, b: ChatMessage): number => (a.seq ?? 0) - (b.seq ?? 0));

  return withSeq.concat(withoutSeq);
}
