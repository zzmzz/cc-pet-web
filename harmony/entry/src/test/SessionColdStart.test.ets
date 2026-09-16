import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { SessionStore } from '../main/ets/store/SessionStore';
import { BridgeInfo, WsFrame } from '../main/ets/logic/normalizeEvent';
import { Session } from '../main/ets/model/Protocol';

/**
 * Cold start: what a relaunch does with the pointers `initPersistence()`
 * read back off disk.
 *
 * `preferences` itself is unreachable under `hvigorw test` (there is no
 * `UIAbilityContext` — the same permanently-accepted gap as
 * `AuthStore.init`/`save`), so these drive `restoreFromSnapshot()`, the
 * in-memory half of `initPersistence()`, with the exact bytes the
 * preferences read would have produced. The real I/O is covered on device by
 * `scripts/device-session-switch-probe.sh`, which force-stops the app and
 * asserts the relaunch lands where it left.
 *
 * The bug these exist for (Task 9b) was NOT "the pointer isn't restored". It
 * was restored and then overwritten: the landing pick called
 * `setCurrent(`${bridges[0].id}::default`)`, which wrote `default` into
 * `activeSessionKeys` AND persisted it — so every launch destroyed the
 * pointer on disk. That is why the assertions below always check
 * `persistedSnapshot()` as well as `currentChatKey`: a fix that lands on the
 * right chat but writes `default` back to disk would pass on the first
 * relaunch and fail on the second.
 */

function manifest(bridges: BridgeInfo[]): WsFrame {
  return { type: 'bridge:manifest', bridges: bridges };
}

function bridge(id: string): BridgeInfo {
  return { id: id, name: `工作台-${id}` };
}

function session(connectionId: string, key: string, lastActiveAt: number): Session {
  return { key: key, connectionId: connectionId, createdAt: 1000, lastActiveAt: lastActiveAt };
}

/** The snapshot a previous run of this app would have left on disk. */
function persisted(activeSessionKeysJson: string, activeConnection: string): void {
  SessionStore.connect().restoreFromSnapshot({
    activeSessionKeysJson: activeSessionKeysJson,
    stickySessionsJson: '{}',
    activeConnection: activeConnection,
  });
}

export default function sessionColdStartTest() {
  describe('SessionStore cold-start focus', () => {
    beforeEach(() => { SessionStore.connect().clearAll(); });

    it('lands on the session it left, not on default', 0, () => {
      const store: SessionStore = SessionStore.connect();
      persisted('{"b1":"s1"}', 'b1');
      // Restoring alone is enough: `currentChatKey` is right before the
      // manifest arrives, which is what lets `ConnectionGateway`'s backfill
      // fetch the correct transcript.
      expect(store.currentChatKey).assertEqual('b1::s1');

      store.applyManifest(manifest([bridge('b1')]));
      store.applyDefaultFocus();

      expect(store.currentChatKey).assertEqual('b1::s1');
      expect(store.activeConnectionId()).assertEqual('b1');
    });

    it('does not write default back over the restored pointer', 0, () => {
      const store: SessionStore = SessionStore.connect();
      persisted('{"b1":"s1"}', 'b1');

      store.applyManifest(manifest([bridge('b1')]));
      store.applyDefaultFocus();

      // The half of the bug that survived a restart: the old landing pick
      // persisted `default` for this connection, so the NEXT launch had
      // nothing better to restore.
      expect(store.persistedSnapshot().activeSessionKeysJson).assertEqual('{"b1":"s1"}');
      expect(store.persistedSnapshot().activeConnection).assertEqual('b1');
    });

    it('keeps the first launch landing on the first bridge default', 0, () => {
      const store: SessionStore = SessionStore.connect();
      persisted('{}', '');
      expect(store.currentChatKey).assertEqual('');

      store.applyManifest(manifest([bridge('b1'), bridge('b2')]));
      store.applyDefaultFocus();

      expect(store.currentChatKey).assertEqual('b1::default');
      expect(store.activeConnectionId()).assertEqual('b1');
      // 'default' is SUBSTITUTED by `activeSessionKeyOf`, never stored: the
      // "never picked" sentinel has to survive, or inbound session routing
      // loses its `'known'`/`'fallback'` branches (see
      // `activeSessionKeyRawOf`).
      expect(store.activeSessionKeyRawOf('b1')).assertEqual('');
      expect(store.persistedSnapshot().activeSessionKeysJson).assertEqual('{}');
    });

    it('falls back when the restored connection is not in this manifest', 0, () => {
      const store: SessionStore = SessionStore.connect();
      // b9 was removed (or this is a different account's bridge list).
      persisted('{"b9":"s9","b1":"s1"}', 'b9');
      expect(store.currentChatKey).assertEqual('b9::s9');

      store.applyManifest(manifest([bridge('b1'), bridge('b2')]));
      store.applyDefaultFocus();

      // Web's `applyDefaultFocusAfterHydrate` reassigns to a connection the
      // manifest actually lists; the first one is its own final fallback.
      expect(store.activeConnectionId()).assertEqual('b1');
      // And it lands on b1's OWN remembered session, not b1's 'default'.
      expect(store.currentChatKey).assertEqual('b1::s1');
    });

    it('survives a restored session key no session record backs', 0, () => {
      const store: SessionStore = SessionStore.connect();
      persisted('{"b1":"ghost"}', 'b1');
      store.applyManifest(manifest([bridge('b1')]));
      store.applyDefaultFocus();
      // `/api/sessions` has not answered yet at this point on a real cold
      // start, so EVERY restored key looks like this for a moment. Nothing
      // may throw, the key stays intact, and `labelOf` degrades to the
      // manifest's bridge name rather than showing a raw chatKey.
      expect(store.currentChatKey).assertEqual('b1::ghost');
      expect(store.labelOf(store.currentChatKey)).assertEqual('工作台-b1');

      // The list arriving without it does not yank the user out of it
      // either — `applySessions` leaves the pointer maps alone by design.
      store.applySessions([session('b1', 's1', 100)]);
      expect(store.currentChatKey).assertEqual('b1::ghost');
    });

    it('is a no-op before any manifest has arrived', 0, () => {
      const store: SessionStore = SessionStore.connect();
      persisted('{"b1":"s1"}', 'b1');
      // `Index.startGatewayOnce` calls this synchronously at launch, with
      // `bridges` still empty. Clearing focus there (web's empty-list
      // branch) would wipe the pointer `initPersistence()` just restored.
      store.applyDefaultFocus();
      expect(store.currentChatKey).assertEqual('b1::s1');
      expect(store.activeConnectionId()).assertEqual('b1');
    });

    it('restores nothing from a corrupted preferences value', 0, () => {
      const store: SessionStore = SessionStore.connect();
      SessionStore.connect().restoreFromSnapshot({
        activeSessionKeysJson: 'not json at all',
        stickySessionsJson: 'null',
        activeConnection: '',
      });
      expect(store.currentChatKey).assertEqual('');
      expect(store.activeSessionKeyRawOf('b1')).assertEqual('');
      store.applyManifest(manifest([bridge('b1')]));
      store.applyDefaultFocus();
      expect(store.currentChatKey).assertEqual('b1::default');
    });

    it('persists the active connection on every switch', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.setActiveSession('b1', 's1');
      store.setActiveSession('b2', 's2');
      store.setActiveConnection('b2');
      // A connection switch is a user action that must survive a kill, and
      // it changes no session pointer — so `setActiveSession`'s write
      // cannot cover it.
      expect(store.persistedSnapshot().activeConnection).assertEqual('b2');
    });

    it('takes the active connection across the logout boundary', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.setActiveSession('b1', 's1');
      store.setActiveConnection('b1');

      store.clearAll();

      // Same contract as the two pointer maps: account A's connection must
      // not be sitting on disk for account B's `initPersistence()` to read.
      expect(store.persistedSnapshot().activeConnection).assertEqual('');
      expect(store.persistedSnapshot().activeSessionKeysJson).assertEqual('{}');
      expect(store.activeConnectionId()).assertEqual('');
    });
  });
}
