import { describe, it, expect } from '@ohos/hypium';
import { backoffDelayMs } from '../main/ets/logic/backoff';

export default function backoffTest() {
  describe('backoffDelayMs', () => {
    it('starts at one second', 0, () => {
      expect(backoffDelayMs(0)).assertEqual(1000);
    });
    it('doubles each attempt', 0, () => {
      expect(backoffDelayMs(1)).assertEqual(2000);
      expect(backoffDelayMs(2)).assertEqual(4000);
      expect(backoffDelayMs(4)).assertEqual(16000);
    });
    it('caps at thirty seconds', 0, () => {
      expect(backoffDelayMs(5)).assertEqual(30000);
      expect(backoffDelayMs(99)).assertEqual(30000);
    });
    it('treats negative attempts as the first attempt', 0, () => {
      expect(backoffDelayMs(-3)).assertEqual(1000);
    });
  });
}
