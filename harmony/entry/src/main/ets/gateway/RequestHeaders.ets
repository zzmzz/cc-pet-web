/**
 * Header shape `RestClient.request()` sends. `'Content-Type'` is optional
 * rather than always-present — see `buildRequestHeaders` for why.
 *
 * Kept in its own file, with zero imports, deliberately: `RestClient.ets`
 * itself imports `@kit.NetworkKit`/`@kit.PerformanceAnalysisKit`/
 * `@kit.BasicServicesKit`, none of which this logic needs.
 *
 * CORRECTION (Task 6): an earlier version of this comment claimed those kits
 * had no precedent of being importable from `hvigorw test`'s `localUnitTest`
 * target. That is FALSE — `DispatchRouting.test.ets` imports
 * `ConnectionGateway`, which pulls in `@kit.NetworkKit`, and the suite runs
 * it fine. Do not split a file merely because it touches a kit; that reason
 * does not exist. The split here still stands on its own merit: the header
 * rule is pure, and keeping it import-free — the same way `Endpoints.ets` is
 * import-free so `Endpoints.test.ets` can pin its URL builders — keeps the
 * test honest about what it exercises.
 */
export interface RequestHeaders {
  Authorization: string;
  'Content-Type'?: string;
}

/**
 * Never send `Content-Type: application/json` on a request with no entity
 * body. Confirmed empirically against a real Fastify instance
 * (packages/server, fastify 5.8.4): its default JSON body parser 400s
 * (`FST_ERR_CTP_EMPTY_JSON_BODY`) on exactly that combination, in
 * body-parsing middleware, before any route handler runs — which is what
 * silently broke `SessionApi.remove` (via `RestClient.deleteJson`, which
 * hardcodes an empty body) for as long as `RestClient.request()` set this
 * header unconditionally, and would have broken `SessionApi.markRead` the
 * same way had it not separately been fixed to send `'{}'` (see
 * `MessageInput.toggleBridge` for the established precedent for that half
 * of the fix). A Content-Type describing a body that doesn't exist is
 * simply wrong, so it's omitted entirely rather than sent alongside an
 * empty string.
 */
export function buildRequestHeaders(token: string, body: string): RequestHeaders {
  if (body.length > 0) {
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${token}` };
}
