import { RestClient } from './RestClient';
import { historyUrl } from '../model/Endpoints';
import { ChatMessage } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';

/**
 * Server caps `limit` at 500 (see `getByChatKeyAfterSeq` in
 * `packages/server/src/api/history.ts`); 200 matches that endpoint's own
 * default when the client omits the query param.
 */
const HISTORY_LIMIT: number = 200;

interface HistoryResponsePayload {
  messages: ChatMessage[];
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
 * **Incremental, not a blanket refetch**: the caller is expected to read
 * `ChatStore.maxSeqOf(chatKey)` as its own cursor *before* calling `fetch`
 * (so it knows which branch — `replaceAll` vs. per-message `append` — to
 * apply to what comes back); `fetch` re-derives the same cursor internally
 * to build the request URL. Both reads happen synchronously before the
 * network `await`, so they can't observe different values — ArkTS/JS is
 * single-threaded and nothing mutates `ChatStore` between them.
 *
 * Deliberately does not touch `ChatStore` itself (only reads `maxSeqOf` to
 * shape the request) and does not catch `UnauthorizedError` — both stay
 * the caller's job (`ConnectionGateway`), which already owns "what do we
 * do with a fetched batch" and "what do we do on 401" for every other
 * inbound path in this app.
 */
export class HistoryApi {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /**
   * Fetches this chat's history gap (cursor > 0) or full known history
   * (cursor 0), server-ordered oldest-first. Never mutates `ChatStore` —
   * see class doc. Rejects with `UnauthorizedError` (from `RestClient`)
   * or any other network/parse error, unchanged, for the caller to handle.
   */
  async fetch(chatKey: string): Promise<ChatMessage[]> {
    const afterSeq: number = ChatStore.connect().maxSeqOf(chatKey);
    const url: string = historyUrl(chatKey, afterSeq, HISTORY_LIMIT);
    const raw: string = await new RestClient(this.baseUrl, this.token).getJson(url);
    const payload: HistoryResponsePayload = JSON.parse(raw) as HistoryResponsePayload;
    return payload.messages ?? [];
  }
}
