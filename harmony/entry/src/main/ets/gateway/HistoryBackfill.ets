import { hilog } from '@kit.PerformanceAnalysisKit';
import { mergeHistoryMessages } from '../logic/mergeHistory';
import { firstUserText } from '../logic/autoTitle';
import { splitChatKey, ChatKeyParts } from '../logic/normalizeEvent';
import { ChatMessage } from '../model/Protocol';
import { ChatStore } from '../store/ChatStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { SessionStore } from '../store/SessionStore';
import { HistoryApi, HistoryBatch } from './HistoryApi';
import { UnauthorizedError } from './RestClient';

const DOMAIN = 0x0000;
const TAG = 'HistoryBackfill';

/**
 * Incremental history backfill, extracted from `ConnectionGateway` (which
 * was 537 lines carrying five responsibilities). This is the one with a
 * clean boundary: it needs a chatKey, `ChatStore`, `HistoryApi`, and a
 * "the token is dead" callback — no socket, no outbox, no manifest, none of
 * the state the gateway's other four responsibilities are genuinely coupled
 * through. The gateway now owns one field (`backfill`) and forwards two
 * calls instead of carrying ~90 lines of this.
 *
 * Gateway, not a Store: it holds no `@Trace` state of its own and nothing
 * observes it reactively, so it is plain-field like `ConnectionGateway`/
 * `HistoryApi`. Its one UI-visible output, the per-chat error flag, goes
 * through `ConnectionStore` — the sanctioned gateway→UI channel (see that
 * store's `historyErrors` doc) — instead of a field the UI has to poll.
 *
 * Constructed per `ConnectionGateway.start()` (baseUrl/token are only known
 * from then on), so a re-login after a 401 logout gets a fresh instance with
 * the new token and an empty in-flight set, rather than a stale one holding
 * the dead token — the same class of bug as the gateway's own
 * `gatewayStarted` latch.
 */
export class HistoryBackfill {
  private baseUrl: string;
  private token: string;
  private onUnauthorized: () => void;

  /**
   * Task 17 fix round, Important-3: `retryHistory` (the `ErrorBanner`'s
   * manual retry) and the reconnect-scheduled call from the
   * `bridge:manifest` dispatch branch can both target the same `chatKey`
   * concurrently — each would otherwise snapshot its own cursor and apply
   * its own result independently, and whichever resolves later could stomp
   * the other (including leaving the error flag on a stale value). A plain
   * `Set`, not `@Trace` — nothing renders off it directly, only `run()`
   * reads/writes it.
   */
  private inFlight: Set<string> = new Set<string>();

  constructor(baseUrl: string, token: string, onUnauthorized: () => void) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.onUnauthorized = onUnauthorized;
  }

  /**
   * Runs after every successful connection's `bridge:manifest` (see the
   * gateway's dispatch handler for why there, not directly in `open()`), not
   * just the first connect, so a long-disconnected client's transcript
   * catches up on reconnect too. Also the `ErrorBanner`'s manual retry.
   *
   * `ChatStore.maxSeqOf(chatKey)` is read once, *before* the async `fetch`
   * call, and passed straight into `HistoryApi.fetch(chatKey, cursor)`
   * (Task 17 fix round, Minor) — `fetch` no longer independently re-derives
   * the same value, so the branch decision here and the request URL it
   * builds can never desync even if an `await` is ever introduced between
   * them.
   *
   * There is no `cursor === 0` branch (Task 17 fix round,
   * Important-1/Important-2): both the cold-start case and the incremental
   * case go through the same `mergeHistoryMessages(current, messages)` call,
   * reading `current` fresh from `ChatStore` *after* the fetch resolves
   * rather than reusing the pre-fetch snapshot. That fresh read is what lets
   * a message the user sent — or one the live socket delivered — while this
   * fetch was in flight survive instead of being wiped by a bare
   * `replaceAll`, and lets `mergeHistoryMessages`'s id-based dedup collapse
   * a message that arrived by both paths into one. See that function's doc
   * for the full merge/ordering rationale.
   *
   * Failure handling is exactly the Step 2 + Step 4 contract: a
   * `UnauthorizedError` from `RestClient` (thrown by any REST call,
   * `HistoryApi.fetch` included) means the token is dead, so this calls
   * `onUnauthorized` — no silent retry, a dead token never succeeds on
   * retry. Any other failure (network blip, server 5xx) sets this chat's
   * history error instead, which `MessageList` surfaces as a top banner with
   * a manual retry — it must not interrupt the current conversation, so
   * nothing here blocks sending/receiving on this path.
   */
  run(chatKey: string): void {
    if (chatKey.length === 0) {
      // No session selected yet — nothing to backfill. Can still happen
      // here (not just at the very first `open()`): a manifest with zero
      // bridges, or one that arrives before the user has ever picked a
      // session and the deferred default-pick (see the caller) hasn't run
      // yet either.
      return;
    }
    if (this.inFlight.has(chatKey)) {
      hilog.info(DOMAIN, TAG, 'history backfill already in flight for %{public}s, skipping', chatKey);
      return;
    }
    this.inFlight.add(chatKey);
    const cursor: number = ChatStore.connect().maxSeqOf(chatKey);
    const historyApi: HistoryApi = new HistoryApi(this.baseUrl, this.token);
    historyApi.fetch(chatKey, cursor).then((batch: HistoryBatch) => {
      const current: ChatMessage[] = ChatStore.connect().messagesOf(chatKey);
      const merged: ChatMessage[] = mergeHistoryMessages(current, batch.messages);
      ChatStore.connect().replaceAll(chatKey, merged);
      // Re-derive the session's auto-title from the transcript, mirroring
      // web's lazy loader (`fetchAndStoreHistory` ->
      // `syncAutoTitleFromHistoryMessages`). It closes the window between a
      // chat's history arriving and `/api/sessions` arriving, in which a
      // session record carries no label at all.
      //
      // Measured on the emulator while writing this task's probe, so nobody
      // has to guess: THIS SERVER ALREADY AUTO-TITLES, with the identical
      // rule (`packages/server/src/storage/messages.ts`, `AUTO_TITLE_MAX_LEN
      // = 15`, set-if-missing on insert), so `/api/sessions` does come back
      // with the same label rather than none — `GET /api/sessions` returned
      // `"label":"probe-beta-mess…"` for a session this client never sent a
      // label for. That makes this line belt-and-braces against a server
      // whose record has no label, not the sole source of the name. It is
      // kept for web parity and because `touchSessionAutoTitle` refuses to
      // overwrite a real label, so it can never clobber a server-side or
      // user-set one.
      const parts: ChatKeyParts = splitChatKey(chatKey);
      SessionStore.connect().touchSessionAutoTitle(
        parts.connectionId, parts.sessionKey, firstUserText(merged));
      if (batch.truncated) {
        // The drain loop ran out of iterations with the server still
        // reporting `hasMore`. The messages above are real and are kept, but
        // the transcript is NOT caught up — say so through the same banner +
        // retry path a network failure uses, instead of the silent
        // "looks complete, isn't" this cap used to produce.
        hilog.warn(DOMAIN, TAG,
          'history backfill hit the drain cap for %{public}s — transcript is still incomplete', chatKey);
        ConnectionStore.connect().setHistoryError(chatKey, true);
        return;
      }
      ConnectionStore.connect().setHistoryError(chatKey, false);
    }).catch((err: Error) => {
      if (err instanceof UnauthorizedError) {
        hilog.warn(DOMAIN, TAG, 'history backfill got 401, logging out (no retry)');
        this.onUnauthorized();
        return;
      }
      hilog.error(DOMAIN, TAG, 'history backfill failed: %{public}s', err.message);
      ConnectionStore.connect().setHistoryError(chatKey, true);
    }).finally(() => {
      this.inFlight.delete(chatKey);
    });
  }
}
