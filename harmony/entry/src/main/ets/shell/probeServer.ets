import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

/** The `<title>` `packages/web/index.html` ships. Served verbatim at `/`. */
const PAGE_MARKER: string = 'CC Pet';

export class ProbeResult {
  ok: boolean = false;
  /** User-facing Chinese message, empty when `ok`. */
  error: string = '';
}

/**
 * Validates a typed server address before it is saved.
 *
 * §4 of the design says to use `GET /api/health` "服务端已有该路由，无需鉴权".
 * **That is wrong, measured against the real server**, and the shell must not
 * do it: `packages/server/src/index.ts:155` installs `authGuard` as a global
 * `onRequest` hook, which runs for every route regardless of the order routes
 * were registered in. Its exempt list
 * (`packages/server/src/middleware/auth.ts:23`) is exactly `/`,
 * `/favicon.ico`, `/assets/*` and `/api/auth/verify` — `/api/health` is not on
 * it. `curl http://<server>/api/health` with no token returns
 * `401 {"error":"Unauthorized"}`.
 *
 * Worse than merely failing: the same guard counts unauthenticated attempts
 * per client IP and answers 429 for five minutes after five failures inside a
 * minute. A shell that pinged `/api/health` on every "连接" tap would lock the
 * device out of its own server after five typos, and the user would have no
 * way to tell that apart from the server being down.
 *
 * So the probe hits `/` — the exact URL the `Web` component is about to load,
 * which is exempt by design because it is the page itself — and looks for the
 * web app's own `<title>`. A bare 200 would accept any web server on the
 * network; the marker is what makes "连接" mean "this is a cc-pet server".
 *
 * Deliberately NOT `POST /api/auth/verify`: that route is exempt from the
 * guard but still feeds the same failure counter, so probing it is the
 * lockout hazard above with extra steps. And the shell has no token to send.
 */
export async function probeServer(baseUrl: string): Promise<ProbeResult> {
  const result: ProbeResult = new ProbeResult();
  const request: http.HttpRequest = http.createHttp();
  try {
    let response: http.HttpResponse;
    try {
      response = await request.request(`${baseUrl}/`, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 8000,
        readTimeout: 8000,
      });
    } catch (err) {
      // No `throw err` here: `arkts-limited-throw` rejects rethrowing the
      // caught value, and the caller wants a message rather than an exception
      // anyway.
      const businessError: BusinessError = err as BusinessError;
      result.error = `无法连接服务器（错误码 ${businessError.code}）`;
      return result;
    }
    if (response.responseCode === 429) {
      result.error = '服务器暂时拒绝了请求（HTTP 429），请稍后再试';
      return result;
    }
    if (response.responseCode !== 200) {
      result.error = `服务器返回 HTTP ${response.responseCode}`;
      return result;
    }
    const body: string = `${response.result}`;
    if (!body.includes(PAGE_MARKER)) {
      result.error = '该地址能访问，但没有提供 cc-pet 页面';
      return result;
    }
    result.ok = true;
    return result;
  } finally {
    request.destroy();
  }
}
