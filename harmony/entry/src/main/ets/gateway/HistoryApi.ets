import { RestClient } from './RestClient';
import { historyUrl } from '../model/Endpoints';
import { ChatMessage } from '../model/Protocol';

/**
 * Server caps `limit` at 500 (see `getByChatKeyAfterSeq` in
 * `packages/server/src/api/history.ts`); 200 matches that endpoint's own
 * default when the client omits the query param.
 */
const HISTORY_LIMIT: number = 200;

/**
 * Bounds the `hasMore`-drain loop in `fetch()` below. A gap this large
 * (25 * 200 = 5000 messages) has never been produced by any real session in
 * this app's testing; the cap exists only so a server that always reports
 * `hasMore: true` can't spin this loop forever (Task 17 fix round,
 * Important-4).
 */
const MAX_DRAIN_ITERATIONS: number = 25;

interface HistoryResponsePayload {
  messages: ChatMessage[];
  /**
   * Task 17 fix round, Important-4: previously undeclared here and never
   * read, so a gap wider than `HISTORY_LIMIT` came back truncated but was
   * treated as a complete backfill — no banner, no further fetch, the chat
   * looked caught up while messages were still missing. Now drained by the
   * loop in `fetch()`.
   */
  hasMore?: boolean;
}

/**
 * One REST call — `GET /api/history/:chatKey` — kept as thin as
 * `RestClient` itself: build the URL, fetch, parse, return. No `@Trace`
 * state, nothing observes it reactively, so — like `RestClient`/
 * `PetImageCache` — it's a plain class constructed per call (mirrors how
 * `PetImageCache.uriFor` builds a fresh `RestClient`), not a
 * `static readonly instance` singleton; unlike those two it has no
 * standing resource to share across calls (no socket, no on-disk cache),
 * so there is nothing an `instance` would actually save.
 *
 * **Incremental, not a blanket refetch**: the caller reads
 * `ChatStore.maxSeqOf(chatKey)` as its own cursor *before* calling `fetch`
 * (so it knows which merge to apply to what comes back) and now passes that
 * exact number in as `cursor` (Task 17 fix round, Minor) — `fetch` no
 * longer independently re-reads `ChatStore` to derive the same value. That
 * closes a gap that previously held only by comment ("both reads happen
 * synchronously before the network `await`, so they can't disagree"): if a
 * future change ever put an `await` between the caller's read and this
 * call, the two reads could desync. Passing the value once removes the
 * possibility outright instead of relying on an invariant nothing enforces.
 *
 * Deliberately does not touch `ChatStore` itself and does not catch
 * `UnauthorizedError` — both stay the caller's job (`ConnectionGateway`),
 * which already owns "what do we do with a fetched batch" and "what do we
 * do on 401" for every other inbound path in this app.
 */
export class HistoryApi {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * Fetches this chat's full history gap starting after `cursor` (0 means
   * "everything known"), server-ordered oldest-first. Drains the response
   * in a bounded loop while the server reports `hasMore: true`, advancing
   * the request cursor to the last message's own `seq` each time — so a gap
   * wider than `HISTORY_LIMIT` still comes back complete instead of
   * silently truncated (Task 17 fix round, Important-4). Never mutates
   * `ChatStore` — see class doc. Rejects with `UnauthorizedError` (from
   * `RestClient`) or any other network/parse error, unchanged, for the
   * caller to handle.
   */
  async fetch(chatKey: string, cursor: number): Promise<ChatMessage[]> {
    const collected: ChatMessage[] = [];
    let afterSeq: number = cursor;
    for (let iterations: number = 0; iterations < MAX_DRAIN_ITERATIONS; iterations++) {
      const url: string = historyUrl(chatKey, afterSeq, HISTORY_LIMIT);
      const raw: string = await new RestClient(this.baseUrl, this.token).getJson(url);
      const payload: HistoryResponsePayload = JSON.parse(raw) as HistoryResponsePayload;
      const messages: ChatMessage[] = payload.messages ?? [];
      for (const message of messages) {
        collected.push(message);
      }
      let nextSeq: number = afterSeq;
      if (messages.length > 0) {
        const last: ChatMessage = messages[messages.length - 1];
        nextSeq = last.seq ?? afterSeq;
      }
      const madeProgress: boolean = nextSeq > afterSeq;
      const hasMore: boolean = payload.hasMore ?? false;
      if (!hasMore || !madeProgress) {
        break;
      }
      afterSeq = nextSeq;
    }
    return collected;
  }
}
