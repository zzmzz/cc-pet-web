import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { SessionStore } from '../main/ets/store/SessionStore';
import { Session } from '../main/ets/model/Protocol';

function session(connectionId: string, key: string, lastActiveAt: number, resident?: boolean): Session {
  return {
    key: key, connectionId: connectionId, createdAt: 1000,
    lastActiveAt: lastActiveAt, isResident: resident,
  };
}

export default function sessionStoreModelTest() {
  describe('SessionStore two-level model', () => {
    beforeEach(() => { SessionStore.connect().clearAll(); });

    it('lists a connection sessions newest-active first', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 300), session('c1', 'c', 200)]);
      const keys: string[] = store.sessionsOf('c1').map((s: Session) => s.key);
      expect(keys.join(',')).assertEqual('b,c,a');
    });

    it('keeps connections separate', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c2', 'z', 100)]);
      expect(store.sessionsOf('c1').length).assertEqual(1);
      expect(store.sessionsOf('c2').length).assertEqual(1);
      expect(store.sessionsOf('c3').length).assertEqual(0);
    });

    it('defaults the active session key to default', 0, () => {
      expect(SessionStore.connect().activeSessionKeyOf('c1')).assertEqual('default');
    });

    it('derives currentChatKey from the active connection and session', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 's1', 100)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 's1');
      expect(store.currentChatKey).assertEqual('c1::s1');
    });

    it('remembers a per-connection active session across connection switches', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 's1', 100), session('c2', 's2', 100)]);
      store.setActiveSession('c1', 's1');
      store.setActiveSession('c2', 's2');
      store.setActiveConnection('c1');
      expect(store.currentChatKey).assertEqual('c1::s1');
      store.setActiveConnection('c2');
      expect(store.currentChatKey).assertEqual('c2::s2');
    });

    it('exposes known session keys for routing', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 300)]);
      expect(store.knownSessionKeysOf('c1').join(',')).assertEqual('b,a');
    });

    it('tracks a sticky session per connection', 0, () => {
      const store: SessionStore = SessionStore.connect();
      expect(store.stickySessionOf('c1')).assertEqual('');
      store.noteStickySession('c1', 's1');
      expect(store.stickySessionOf('c1')).assertEqual('s1');
      store.clearStickySession('c1');
      expect(store.stickySessionOf('c1')).assertEqual('');
    });

    it('finds the resident session across connections', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c2', 'r', 100, true)]);
      const resident: Session | undefined = store.residentSession();
      expect(resident !== undefined).assertTrue();
      expect(`${resident?.connectionId}::${resident?.key}`).assertEqual('c2::r');
    });

    it('upserts a new session into its connection list', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100)]);
      store.upsertSession(session('c1', 'new', 999));
      expect(store.sessionsOf('c1').length).assertEqual(2);
      expect(store.sessionsOf('c1')[0].key).assertEqual('new');
    });

    it('removes a session and clears its sticky pointer', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 200)]);
      store.noteStickySession('c1', 'b');
      store.removeSession('c1', 'b');
      expect(store.sessionsOf('c1').length).assertEqual(1);
      expect(store.stickySessionOf('c1')).assertEqual('');
    });

    it('falls the active session back to default when the active one is removed', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'a', 100), session('c1', 'b', 200)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 'b');
      store.removeSession('c1', 'b');
      expect(store.activeSessionKeyOf('c1')).assertEqual('a');
      expect(store.currentChatKey).assertEqual('c1::a');
    });
  });
}
