import { describe, it, expect } from '@ohos/hypium';

export default function localUnitTest() {
  describe('localUnitTest', () => {
    it('hypium_is_wired', 0, () => {
      expect(1 + 1).assertEqual(2);
    });
  });
}
