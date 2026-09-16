import { describe, it, expect } from '@ohos/hypium';
import { buildRequestHeaders, RequestHeaders } from '../main/ets/gateway/RequestHeaders';

/**
 * Task 5 fix round 1: `RestClient.request()` used to set
 * `Content-Type: application/json` unconditionally, including on a
 * body-less `DELETE`/`POST`. Confirmed empirically against a real Fastify
 * instance that this 400s (`FST_ERR_CTP_EMPTY_JSON_BODY`) before any route
 * handler runs — which is why `SessionApi.remove` never actually worked.
 *
 * This is the closest thing to a wire-format regression test this harness
 * can run: `hvigorw test`'s `localUnitTest` target has no precedent, and no
 * ability context, for making a real HTTP call, so the fix is pinned here
 * as a pure function instead of via an end-to-end request. The live proof
 * against a real server is in the Task 5 fix round 1 report, not here.
 */
export default function requestHeadersTest() {
  describe('buildRequestHeaders', () => {
    it('omits Content-Type entirely when the body is empty', 0, () => {
      // `headers['Content-Type']` would be indexed access on an interface,
      // which ArkTS strict mode forbids (see Endpoints.ets/CLAUDE notes) —
      // `JSON.stringify` is used instead to assert the field is genuinely
      // absent, not just `undefined`-valued.
      const headers: RequestHeaders = buildRequestHeaders('tok', '');
      expect(headers.Authorization).assertEqual('Bearer tok');
      expect(JSON.stringify(headers)).assertEqual('{"Authorization":"Bearer tok"}');
    });

    it('sets Content-Type: application/json when there is a body', 0, () => {
      const headers: RequestHeaders = buildRequestHeaders('tok', '{"a":1}');
      expect(headers.Authorization).assertEqual('Bearer tok');
      expect(JSON.stringify(headers)).assertEqual('{"Authorization":"Bearer tok","Content-Type":"application/json"}');
    });
  });
}
