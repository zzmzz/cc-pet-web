import { describe, it, expect } from '@ohos/hypium';
import { chatKeyForBridge, visibleSessions, RECENT_VISIBLE } from '../main/ets/components/SessionRow';
import { BridgeInfo } from '../main/ets/logic/normalizeEvent';
import { Session } from '../main/ets/model/Protocol';

/**
 * `SessionRow.ets`'s other exports (`labelForBridge`/`labelForSession`,
 * `isCurrentBridge`/`isCurrentSession`, `unreadForBridge`/`unreadForSession`,
 * `selectBridge`/`selectSession`) take a live `SessionStore` instance —
 * the `select*` pair mutates it — so they aren't pure and are covered
 * instead by on-device verification of `SessionSidebar`/`SessionSheet`
 * (both shells that call them). `chatKeyForBridge` and `visibleSessions`
 * are the genuinely pure functions here (plain data in, plain data out, no
 * store), so they're the ones worth a unit test.
 */

function makeSession(key: string, isResident?: boolean): Session {
  const base: Session = {
    key: key,
    connectionId: 'b1',
    createdAt: 0,
    lastActiveAt: 0,
  };
  if (isResident !== undefined) {
    base.isResident = isResident;
  }
  return base;
}

export default function sessionRowTest() {
  describe('SessionRow', () => {
    it('derives the default chatKey from a bridge id', 0, () => {
      const bridge: BridgeInfo = { id: 'b1', name: '工作台A' };
      expect(chatKeyForBridge(bridge)).assertEqual('b1::default');
    });

    it('RECENT_VISIBLE matches web\'s SessionDropdown constant', 0, () => {
      expect(RECENT_VISIBLE).assertEqual(2);
    });

    it('visibleSessions strips the active session out of the list', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('s2'),
      ];
      const visible: Session[] = visibleSessions(all, 'default', false);
      expect(visible.length).assertEqual(1);
      expect(visible[0].key).assertEqual('s2');
    });

    it('visibleSessions strips the resident session out of the list', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('pinned', true),
        makeSession('s2'),
      ];
      const visible: Session[] = visibleSessions(all, 'default', false);
      expect(visible.length).assertEqual(1);
      expect(visible[0].key).assertEqual('s2');
    });

    it('visibleSessions truncates to RECENT_VISIBLE when showAll is false', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('s2'),
        makeSession('s3'),
        makeSession('s4'),
      ];
      const visible: Session[] = visibleSessions(all, 'default', false);
      expect(visible.length).assertEqual(2);
      expect(visible[0].key).assertEqual('s2');
      expect(visible[1].key).assertEqual('s3');
    });

    it('visibleSessions returns every remaining session when showAll is true', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('s2'),
        makeSession('s3'),
        makeSession('s4'),
      ];
      const visible: Session[] = visibleSessions(all, 'default', true);
      expect(visible.length).assertEqual(3);
      expect(visible[2].key).assertEqual('s4');
    });
  });
}
