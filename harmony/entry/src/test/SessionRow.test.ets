import { describe, it, expect } from '@ohos/hypium';
import { chatKeyForBridge } from '../main/ets/components/SessionRow';
import { BridgeInfo } from '../main/ets/logic/normalizeEvent';

/**
 * `SessionRow.ets`'s other exports (`labelForBridge`, `isCurrentBridge`,
 * `unreadForBridge`, `selectBridge`) take a live `SessionStore` instance —
 * `selectBridge` mutates it — so they aren't pure and are covered instead
 * by on-device verification of `SessionSidebar`/`SessionSheet` (both shells
 * that call them). `chatKeyForBridge` is the one genuinely pure function
 * (`BridgeInfo` in, `string` out), so it's the one worth a unit test here.
 */
export default function sessionRowTest() {
  describe('SessionRow', () => {
    it('derives the default chatKey from a bridge id', 0, () => {
      const bridge: BridgeInfo = { id: 'b1', name: '工作台A' };
      expect(chatKeyForBridge(bridge)).assertEqual('b1::default');
    });
  });
}
