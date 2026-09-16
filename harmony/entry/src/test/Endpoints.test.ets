import { describe, it, expect } from '@ohos/hypium';
import {
  historyUrl, sessionsUrl, petImageUrl, bridgeConnectUrl,
  sessionDeleteUrl, sessionReadUrl,
} from '../main/ets/model/Endpoints';

/**
 * Pins the URLs the helpers produce.
 *
 * Added when the helpers were changed to build from their `Endpoint`
 * constants via `fillPath` instead of repeating the path as a literal.
 * That refactor had no coverage at all, so the only thing standing between
 * a `:param` substitution bug and a 404 on device was reading it carefully.
 */
export default function endpointsTest() {
  describe('endpoint url builders', () => {
    it('encodes the chat key and carries paging', 0, () => {
      expect(historyUrl('c1::s1', 0, 200)).assertEqual('/api/history/c1%3A%3As1?limit=200');
      expect(historyUrl('c1::s1', 42, 200)).assertEqual('/api/history/c1%3A%3As1?afterSeq=42&limit=200');
    });

    it('builds the session list query', 0, () => {
      expect(sessionsUrl('b 1')).assertEqual('/api/sessions?connectionId=b%201');
    });

    it('builds the pet image path', 0, () => {
      expect(petImageUrl('happy')).assertEqual('/api/pet-images/happy');
    });

    it('picks connect or disconnect from the flag', 0, () => {
      expect(bridgeConnectUrl('b1', true)).assertEqual('/api/bridges/b1/connect');
      expect(bridgeConnectUrl('b1', false)).assertEqual('/api/bridges/b1/disconnect');
    });

    it('substitutes both session params left to right', 0, () => {
      expect(sessionDeleteUrl('c1', 's1')).assertEqual('/api/sessions/c1/s1');
      expect(sessionReadUrl('c1', 's1')).assertEqual('/api/sessions/c1/s1/read');
    });

    it('encodes params that would otherwise break the path', 0, () => {
      expect(sessionDeleteUrl('c/1', 's 1')).assertEqual('/api/sessions/c%2F1/s%201');
      // A value containing a colon must not be mistaken for the next
      // `:param` placeholder -- encodeURIComponent is what prevents that.
      expect(sessionDeleteUrl('c:x', 'k')).assertEqual('/api/sessions/c%3Ax/k');
    });
  });
}
