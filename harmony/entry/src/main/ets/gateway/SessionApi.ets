import { hilog } from '@kit.PerformanceAnalysisKit';
import { RestClient, NetworkError } from './RestClient';
import { Endpoints, sessionsUrl, sessionDeleteUrl, sessionReadUrl } from '../model/Endpoints';
import { Session } from '../model/Protocol';

const DOMAIN = 0x0000;
const TAG = 'SessionApi';

interface SessionsResponsePayload {
  sessions: Session[];
}

/** POST /api/sessions body — `label` is omitted, the server treats it as optional. */
interface SessionCreateBody {
  connectionId: string;
  key: string;
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

  /**
   * `POST /api/sessions` — `Endpoints.SESSION_CREATE`. No URL helper: the
   * path has no `:param`, so `Endpoints.SESSION_CREATE.path` (== the same
   * literal `sessionsUrl` builds a query onto) is used directly. `label` is
   * left out of the body; the server (`registerSessionRoutes`) treats it as
   * optional and the client has no per-session label input yet.
   *
   * No 401 handling here, same posture as `fetch`/`fetchAll`: a dead token
   * surfaces as `UnauthorizedError` straight out of `RestClient`, and it
   * stays `ConnectionGateway`'s job to catch it and log out.
   */
  async create(connectionId: string, key: string): Promise<void> {
    const body: SessionCreateBody = { connectionId, key };
    await new RestClient(this.baseUrl, this.token).postJson(Endpoints.SESSION_CREATE.path, JSON.stringify(body));
  }

  /**
   * `DELETE /api/sessions/:connectionId/:key` — `Endpoints.SESSION_DELETE`.
   *
   * The server refuses with 403 for a resident session
   * (`registerSessionRoutes`'s `store.isResident` check) — the UI never
   * offers a delete control for one, so reaching this with a resident key
   * means something upstream already went wrong. It is still a well-defined,
   * expected refusal rather than a network failure, so it is logged as a
   * warning here and re-thrown as-is (not swallowed, not wrapped) rather
   * than left for a caller to mistake for a generic `NetworkError` and put
   * in an error banner.
   */
  async remove(connectionId: string, key: string): Promise<void> {
    try {
      await new RestClient(this.baseUrl, this.token).deleteJson(sessionDeleteUrl(connectionId, key));
    } catch (err) {
      // `throw err` directly trips ArkTS's arkts-limited-throw rule (a
      // caught value's static type isn't narrowed to a throwable class) —
      // assign it to an `Error`-typed local first, same fix as
      // `PetImageCache.ensureDir`.
      const error: Error = err as Error;
      if (error instanceof NetworkError && error.code === 403) {
        hilog.warn(DOMAIN, TAG,
          'delete refused for resident session (expected, not a network failure): connectionId=%{public}s key=%{public}s',
          connectionId, key);
      }
      throw error;
    }
  }

  /**
   * `POST /api/sessions/:connectionId/:key/read` — `Endpoints.SESSION_READ`.
   * Clears a resident session's server-side unread count; no body needed.
   * Same "no 401 handling here" posture as `create`/`fetch`/`fetchAll`.
   */
  async markRead(connectionId: string, key: string): Promise<void> {
    await new RestClient(this.baseUrl, this.token).postJson(sessionReadUrl(connectionId, key), '');
  }
}
