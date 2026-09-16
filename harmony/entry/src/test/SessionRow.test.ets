import { describe, it, expect } from '@ohos/hypium';
import {
  chatKeyForBridge, visibleSessions, RECENT_VISIBLE,
  nonResidentSessions, activeSessionOf, hiddenSessionCount, newSessionKey, rowLabel,
} from '../main/ets/components/SessionRow';
import { BridgeInfo } from '../main/ets/logic/normalizeEvent';
import { Session } from '../main/ets/model/Protocol';

/**
 * `SessionRow.ets`'s other exports (`isCurrentSession`,
 * `unreadForSession`, `isActiveConnection`,
 * `unreadForConnection`, `selectSession`/`selectConnection`,
 * `openResidentSession`, `createAndSelectSession`, `deleteSession`,
 * `applyDeleteTap`) take a live `SessionStore` instance — most of them
 * mutate it, and three of them talk to the server — so they aren't pure and
 * are covered instead by on-device verification of
 * `SessionSidebar`/`SessionSheet` (both shells that call them). The
 * functions below are the genuinely pure ones (plain data in, plain data
 * out, no store), so they're the ones worth a unit test.
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

    it('nonResidentSessions strips the resident session', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('pinned', true),
      ];
      const listed: Session[] = nonResidentSessions(all);
      expect(listed.length).assertEqual(1);
      expect(listed[0].key).assertEqual('default');
    });

    it('activeSessionOf finds the listed session the active pointer names', 0, () => {
      const all: Session[] = [makeSession('default'), makeSession('s2')];
      const active: Session | undefined = activeSessionOf(all, 's2');
      expect(active !== undefined).assertTrue();
      expect(active === undefined ? '' : active.key).assertEqual('s2');
    });

    it('activeSessionOf answers undefined when the active session is the resident one', 0, () => {
      // Web looks its `currentSession` up in `listSessions` (resident
      // stripped) for exactly this reason: the resident session already has
      // its own pinned entry, and must not render a second time as
      // 「当前会话」.
      const all: Session[] = [makeSession('default'), makeSession('pinned', true)];
      expect(activeSessionOf(all, 'pinned') === undefined).assertTrue();
    });

    it('hiddenSessionCount counts what visibleSessions is holding back', 0, () => {
      const all: Session[] = [
        makeSession('default'),
        makeSession('s2'),
        makeSession('s3'),
        makeSession('s4'),
        makeSession('s5'),
      ];
      expect(hiddenSessionCount(all, 'default')).assertEqual(2);
    });

    it('hiddenSessionCount clamps at zero rather than going negative', 0, () => {
      const all: Session[] = [makeSession('default'), makeSession('s2')];
      expect(hiddenSessionCount(all, 'default')).assertEqual(0);
    });

    it('newSessionKey matches web\'s createSession key format', 0, () => {
      expect(newSessionKey(1737000000000)).assertEqual('session-1737000000000');
    });

    it('rowLabel prefers the server label, like web\'s sessionLabelText', 0, () => {
      const labelled: Session = makeSession('session-1737000000000');
      labelled.label = '  重构登录流程  ';
      expect(rowLabel(labelled)).assertEqual('重构登录流程');
    });

    it('rowLabel falls back to the session key, NOT the bridge name', 0, () => {
      // `SessionStore.labelOf` would answer the bridge name here, which is
      // right for a notification title and wrong for a list of one
      // connection's sessions — every row would read the same thing.
      expect(rowLabel(makeSession('session-1737000000000'))).assertEqual('session-1737000000000');
    });

    it('rowLabel shows the last segment of a namespaced key', 0, () => {
      expect(rowLabel(makeSession('wx:room:42'))).assertEqual('42');
    });

    it('rowLabel pins the resident session', 0, () => {
      expect(rowLabel(makeSession('standby', true))).assertEqual('📌 standby');
    });
  });
}
