import { describe, it, expect } from '@ohos/hypium';
import {
  visibleSessions, RECENT_VISIBLE,
  nonResidentSessions, activeSessionOf, hiddenSessionCount, newSessionKey, rowLabel,
  formatUnread, formatSessionPhase, phaseDisplay, latestMessageTimestamp,
  fallbackActivityTimestamp, formatTime,
} from '../main/ets/components/SessionRow';
import { ChatMessage, Session, TaskPhase } from '../main/ets/model/Protocol';

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

function makeMessage(timestamp: number): ChatMessage {
  return { id: `m-${timestamp}`, role: 'user', content: 'hi', timestamp: timestamp };
}

export default function sessionRowTest() {
  describe('SessionRow', () => {
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

    // ---------------------------------------------------------------------
    // formatUnread — web's `formatUnread`, inlined six times across the two
    // shells before this task; the same boundary web tests implicitly via
    // its `>99` check.
    // ---------------------------------------------------------------------

    it('formatUnread shows the exact count below the cap', 0, () => {
      expect(formatUnread(0)).assertEqual('0');
      expect(formatUnread(1)).assertEqual('1');
      expect(formatUnread(99)).assertEqual('99');
    });

    it('formatUnread caps at 99+', 0, () => {
      expect(formatUnread(100)).assertEqual('99+');
      expect(formatUnread(250)).assertEqual('99+');
    });

    // ---------------------------------------------------------------------
    // formatSessionPhase / phaseDisplay — web's `formatSessionPhase` and
    // `isActivePhaseCss`, narrowed to the 7 real `TaskPhase` values this
    // client's `TaskStore` can hold (web's function also accepts legacy
    // bridge strings like 'processing'/'waiting_confirm' that never reach
    // this client's store, so they have no branch here).
    // ---------------------------------------------------------------------

    it('formatSessionPhase labels every TaskPhase', 0, () => {
      expect(formatSessionPhase('idle')).assertEqual('空闲');
      expect(formatSessionPhase('thinking')).assertEqual('思考中');
      expect(formatSessionPhase('working')).assertEqual('处理中');
      expect(formatSessionPhase('awaiting_confirmation')).assertEqual('待确认');
      expect(formatSessionPhase('completed')).assertEqual('已完成');
      expect(formatSessionPhase('failed')).assertEqual('失败');
      expect(formatSessionPhase('stalled')).assertEqual('可能卡住');
    });

    it('phaseDisplay gives idle a gray dot unless activeAccent is set', 0, () => {
      expect(phaseDisplay('idle', false).dotColor).assertEqual('#6B7280');
      expect(phaseDisplay('idle', true).dotColor).assertEqual('#0A59F7');
      // Text stays gray regardless of activeAccent — web's default branch
      // always answers "text-gray-600" no matter what `activeAccent` is.
      expect(phaseDisplay('idle', true).textColor).assertEqual('#4B5563');
    });

    it('phaseDisplay marks thinking/working with the accent spinner color', 0, () => {
      const thinking: TaskPhase = 'thinking';
      const working: TaskPhase = 'working';
      expect(phaseDisplay(thinking, false).dotColor).assertEqual('#0A59F7');
      expect(phaseDisplay(thinking, false).textColor).assertEqual('#0A59F7');
      expect(phaseDisplay(working, false).label).assertEqual('处理中');
    });

    it('phaseDisplay marks awaiting_confirmation and stalled amber', 0, () => {
      const waiting: TaskPhase = 'awaiting_confirmation';
      const stalled: TaskPhase = 'stalled';
      expect(phaseDisplay(waiting, false).dotColor).assertEqual('#F59E0B');
      expect(phaseDisplay(stalled, false).dotColor).assertEqual('#F59E0B');
    });

    it('phaseDisplay marks failed red', 0, () => {
      const failed: TaskPhase = 'failed';
      expect(phaseDisplay(failed, false).dotColor).assertEqual('#E03131');
      expect(phaseDisplay(failed, false).textColor).assertEqual('#E03131');
    });

    it('phaseDisplay falls completed through to the default gray branch, like web', 0, () => {
      // web's `isActivePhaseCss` has no branch for 'completed' — it falls
      // to the same default as 'idle', even though `formatSessionPhase`
      // gives it its own label ("已完成").
      const completed: TaskPhase = 'completed';
      expect(phaseDisplay(completed, false).dotColor).assertEqual('#6B7280');
      expect(phaseDisplay(completed, true).dotColor).assertEqual('#0A59F7');
      expect(phaseDisplay(completed, false).label).assertEqual('已完成');
    });

    // ---------------------------------------------------------------------
    // latestMessageTimestamp / fallbackActivityTimestamp — the two pure
    // halves of web's `lastMessageOrCreatedAt`.
    // ---------------------------------------------------------------------

    it('latestMessageTimestamp is undefined for an empty transcript', 0, () => {
      expect(latestMessageTimestamp([])).assertEqual(undefined);
    });

    it('latestMessageTimestamp finds the max timestamp regardless of order', 0, () => {
      const messages: ChatMessage[] = [makeMessage(200), makeMessage(500), makeMessage(100)];
      expect(latestMessageTimestamp(messages)).assertEqual(500);
    });

    it('fallbackActivityTimestamp prefers lastActiveAt when present', 0, () => {
      // Web's `session.lastActiveAt ?? session.createdAt` — presence, not
      // magnitude, decides the winner.
      expect(fallbackActivityTimestamp(50, 100)).assertEqual(50);
    });

    it('fallbackActivityTimestamp falls back to createdAt when lastActiveAt is absent', 0, () => {
      // For a session whose history hasn't been lazy-loaded yet.
      expect(fallbackActivityTimestamp(undefined, 100)).assertEqual(100);
    });

    // ---------------------------------------------------------------------
    // formatTime — web's `formatTime`, reimplemented without `Intl`/
    // `toLocaleString` (unverified on this runtime; see ArkTS gotchas) but
    // matching its exact output shapes: HH:MM for today, 昨天/N天前 for the
    // last week, M/D (no year, same as web) beyond that.
    // ---------------------------------------------------------------------

    const NOW: number = new Date(2026, 8, 16, 15, 30, 0).getTime(); // 2026-09-16 15:30, today's date

    it('formatTime shows HH:MM for a timestamp earlier today', 0, () => {
      const ts: number = new Date(2026, 8, 16, 9, 5, 0).getTime();
      expect(formatTime(ts, NOW)).assertEqual('09:05');
    });

    it('formatTime shows HH:MM for "now" itself', 0, () => {
      expect(formatTime(NOW, NOW)).assertEqual('15:30');
    });

    it('formatTime shows 昨天 for yesterday', 0, () => {
      const ts: number = new Date(2026, 8, 15, 23, 59, 0).getTime();
      expect(formatTime(ts, NOW)).assertEqual('昨天');
    });

    it('formatTime shows N天前 for 2 to 6 days ago', 0, () => {
      const twoDaysAgo: number = new Date(2026, 8, 14, 10, 0, 0).getTime();
      const sixDaysAgo: number = new Date(2026, 8, 10, 10, 0, 0).getTime();
      expect(formatTime(twoDaysAgo, NOW)).assertEqual('2天前');
      expect(formatTime(sixDaysAgo, NOW)).assertEqual('6天前');
    });

    it('formatTime falls back to M/D at exactly 7 days and beyond', 0, () => {
      const sevenDaysAgo: number = new Date(2026, 8, 9, 10, 0, 0).getTime();
      expect(formatTime(sevenDaysAgo, NOW)).assertEqual('9/9');
    });

    it('formatTime crosses a year boundary without printing the year, like web', 0, () => {
      const now: number = new Date(2026, 0, 3, 10, 0, 0).getTime(); // 2026-01-03
      const lastYear: number = new Date(2025, 11, 20, 8, 0, 0).getTime(); // 2025-12-20
      expect(formatTime(lastYear, now)).assertEqual('12/20');
    });
  });
}
