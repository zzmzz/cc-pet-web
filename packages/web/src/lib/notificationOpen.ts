/**
 * Opening a chat from a push notification. The service worker either tells an open
 * page which session to show (a message) or opens a new page with the session in
 * the query string; the assistant page takes it from either.
 */

export interface OpenSessionRequest {
  connectionId: string;
  sessionKey: string;
}

/** `type` of the message the service worker posts to an open page. */
export const OPEN_SESSION_MESSAGE = "cc-pet-open-session";
const CONNECTION_PARAM = "openConnection";
const SESSION_PARAM = "openSession";

export function parseOpenRequest(data: unknown): OpenSessionRequest | null {
  if (!data || typeof data !== "object") return null;
  const { connectionId, sessionKey } = data as Record<string, unknown>;
  if (typeof connectionId !== "string" || !connectionId) return null;
  if (typeof sessionKey !== "string" || !sessionKey) return null;
  return { connectionId, sessionKey };
}

/** Where a click on a notification lands when no page is open. */
export function notificationUrl(req: OpenSessionRequest | null): string {
  if (!req) return "/";
  const q = new URLSearchParams({ [CONNECTION_PARAM]: req.connectionId, [SESSION_PARAM]: req.sessionKey });
  return `/?${q.toString()}`;
}

/** Reads the request a notification put in the URL, then drops it so a reload does not repeat it. */
export function takeOpenFromUrl(
  loc: Pick<Location, "search" | "pathname" | "hash"> = window.location,
  hist: Pick<History, "replaceState" | "state"> = window.history,
): OpenSessionRequest | null {
  const params = new URLSearchParams(loc.search);
  if (!params.has(CONNECTION_PARAM) && !params.has(SESSION_PARAM)) return null;
  const req = parseOpenRequest({ connectionId: params.get(CONNECTION_PARAM), sessionKey: params.get(SESSION_PARAM) });
  params.delete(CONNECTION_PARAM);
  params.delete(SESSION_PARAM);
  const rest = params.toString();
  hist.replaceState(hist.state, "", `${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}`);
  return req;
}

function serviceWorkerTarget(): EventTarget | null {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
}

/** Listens for the service worker's open-session messages; returns the unsubscribe function. */
export function onOpenSessionRequest(
  listener: (req: OpenSessionRequest) => void,
  target: EventTarget | null = serviceWorkerTarget(),
): () => void {
  if (!target) return () => {};
  const handler = (e: Event) => {
    const data = (e as MessageEvent).data as { type?: unknown } | null;
    if (!data || data.type !== OPEN_SESSION_MESSAGE) return;
    const req = parseOpenRequest(data);
    if (req) listener(req);
  };
  target.addEventListener("message", handler);
  return () => target.removeEventListener("message", handler);
}
