import { RestClient } from './RestClient';
import { sessionsUrl } from '../model/Endpoints';
import { Session } from '../model/Protocol';

interface SessionsResponsePayload {
  sessions: Session[];
}

/**
 * One REST call — `GET /api/sessions?connectionId=…` — built like
 * `HistoryApi`: thin, per-call construction, no `@Trace` state, no store
 * access, no 401 handling (all three stay `ConnectionGateway`'s job).
 *
 * Why this exists at all: `SessionStore.applySessions` and
 * `Endpoints.SESSIONS` shipped with zero callers for the whole project, and
 * two user-visible behaviours depended on them. Notification titles fell
 * back to the raw chatKey, so a lock screen read `b1::default`; and
 * `residentKeys` was never populated, so spec §6.3's "resident sessions
 * ignore all local unread increments; the server is the sole truth"
 * invariant — fully implemented in `SessionStore` — was never armed, and a
 * resident session's badge could be bumped locally by the notification path
 * on top of the count the server had already sent.
 *
 * `/api/sessions` is per-connection (it answers `{ sessions: [] }` with no
 * `connectionId`), so a full picture means one request per advertised
 * bridge. `fetchAll` issues them together and returns the flattened list —
 * a bridge whose request fails is logged by the caller and simply
 * contributes nothing, rather than voiding the sessions that did come back.
 */
export class SessionApi {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  async fetch(connectionId: string): Promise<Session[]> {
    const raw: string = await new RestClient(this.baseUrl, this.token).getJson(sessionsUrl(connectionId));
    const payload: SessionsResponsePayload = JSON.parse(raw) as SessionsResponsePayload;
    return payload.sessions ?? [];
  }

  /**
   * Rejects only if EVERY request rejected — `Promise.all` would instead
   * discard a successful bridge's sessions because a different bridge 500'd.
   * Uses `allSettled` and keeps whatever arrived; the caller decides what to
   * log. A rejection that is a 401 is re-thrown as-is (see `firstError`) so
   * the gateway's existing "a dead token logs out, it never retries"
   * handling still fires.
   */
  async fetchAll(connectionIds: string[]): Promise<Session[]> {
    if (connectionIds.length === 0) {
      return [];
    }
    const results: PromiseSettledResult<Session[]>[] =
      await Promise.allSettled(connectionIds.map((id: string): Promise<Session[]> => this.fetch(id)));
    const collected: Session[] = [];
    let succeeded: boolean = false;
    let firstError: Error | undefined = undefined;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        succeeded = true;
        for (const session of result.value) {
          collected.push(session);
        }
      } else if (firstError === undefined) {
        firstError = result.reason as Error;
      }
    }
    if (!succeeded && firstError !== undefined) {
      throw firstError;
    }
    return collected;
  }
}
