import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { ConnectionGateway, OutboxStatusView } from '../main/ets/gateway/ConnectionGateway';
import { applyCreatedSession, selectSession } from '../main/ets/components/SessionRow';
import { SessionStore } from '../main/ets/store/SessionStore';
import { ChatStore } from '../main/ets/store/ChatStore';
import { TaskStore } from '../main/ets/store/TaskStore';
import { chatKeyOf } from '../main/ets/logic/normalizeEvent';
import { Session } from '../main/ets/model/Protocol';

function session(connectionId: string, key: string, lastActiveAt: number): Session {
  return { key: key, connectionId: connectionId, createdAt: 1000, lastActiveAt: lastActiveAt };
}

function seedResidue(chatKey: string): void {
  ChatStore.connect().append(chatKey, {
    id: 'leaked', role: 'assistant', content: 'from another conversation', timestamp: 1,
  });
  ChatStore.connect().appendDelta(chatKey, 'half-revealed reply');
  TaskStore.connect().setPhase(chatKey, 'working');
  SessionStore.connect().setUnread(chatKey, 4);
}

/**
 * The create flow's local half — `ConnectionGateway.resetSessionResidue` and
 * `SessionRow.applyCreatedSession`. `ConnectionGateway.instance.stop()` in
 * `beforeEach` (the pattern `DispatchTypingRouting`/`DispatchSendSticky` use)
 * wipes `ChatStore`/`SessionStore`/the outbox between tests; `TaskStore` has
 * no clearAll, so every test here uses its own chatKeys.
 */
export default function sessionCreateFlowTest() {
  describe('ConnectionGateway.resetSessionResidue', () => {
    beforeEach(() => { ConnectionGateway.instance.stop(); });

    it('drops messages, streaming text, task phase and unread for that chat', 0, () => {
      const chatKey: string = chatKeyOf('c1', 'residue-a');
      seedResidue(chatKey);

      ConnectionGateway.instance.resetSessionResidue('c1', 'residue-a');

      expect(ChatStore.connect().messagesOf(chatKey).length).assertEqual(0);
      expect(ChatStore.connect().streamingOf(chatKey)).assertEqual('');
      expect(TaskStore.connect().phaseOf(chatKey)).assertEqual('idle');
      expect(SessionStore.connect().unreadOf(chatKey)).assertEqual(0);
    });

    it('touches no other chat', 0, () => {
      const target: string = chatKeyOf('c1', 'residue-b');
      const bystander: string = chatKeyOf('c1', 'residue-c');
      seedResidue(target);
      seedResidue(bystander);

      ConnectionGateway.instance.resetSessionResidue('c1', 'residue-b');

      expect(ChatStore.connect().messagesOf(bystander).length).assertEqual(1);
      expect(TaskStore.connect().phaseOf(bystander)).assertEqual('working');
      expect(SessionStore.connect().unreadOf(bystander)).assertEqual(4);
    });

    it('never drops a queued message the server has not acked', 0, () => {
      // The data-loss shape this method is most exposed to: an unacked
      // outbox entry exists NOWHERE else — the server has not seen it, so no
      // history backfill can bring it back. Clearing the transcript must not
      // take the queue with it. (The key this is really called with is
      // brand-new and can never have a queue; this pins the rule anyway, so a
      // future caller pointing it at a live chat still cannot lose typed text.)
      const chatKey: string = chatKeyOf('c1', 'residue-d');
      const clientMsgId: string = ConnectionGateway.instance.sendMessage(chatKey, 'not acked yet');
      expect(ConnectionGateway.instance.outboxEntriesOf(chatKey).length).assertEqual(1);

      ConnectionGateway.instance.resetSessionResidue('c1', 'residue-d');

      const remaining: OutboxStatusView[] = ConnectionGateway.instance.outboxEntriesOf(chatKey);
      expect(remaining.length).assertEqual(1);
      expect(remaining[0].clientMsgId).assertEqual(clientMsgId);
    });

    it('ignores a malformed key instead of clearing something else', 0, () => {
      const chatKey: string = chatKeyOf('c1', 'residue-e');
      seedResidue(chatKey);
      ConnectionGateway.instance.resetSessionResidue('', 'residue-e');
      ConnectionGateway.instance.resetSessionResidue('c1', '');
      expect(ChatStore.connect().messagesOf(chatKey).length).assertEqual(1);
    });
  });

  describe('SessionRow.applyCreatedSession', () => {
    beforeEach(() => { ConnectionGateway.instance.stop(); });

    it('pins the session being left when nothing is pinned yet', 0, () => {
      // Web's `createSession` comment: a reply still in flight belongs to the
      // session the user is leaving, and sticky can legitimately be empty
      // (nothing keyed has happened since a cold start). Without this pin the
      // reply would follow the ACTIVE pointer into the brand-new session.
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'old', 100)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 'old');

      applyCreatedSession(store, 'c1', 'new-1', 5000);

      expect(store.stickySessionOf('c1')).assertEqual('old');
      expect(store.currentChatKey).assertEqual(chatKeyOf('c1', 'new-1'));
    });

    it('leaves an existing pin alone', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.applySessions([session('c1', 'old', 100), session('c1', 'pinned', 100)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 'old');
      store.noteStickySession('c1', 'pinned');

      applyCreatedSession(store, 'c1', 'new-2', 5000);

      expect(store.stickySessionOf('c1')).assertEqual('pinned');
    });

    it('pins nothing on a connection whose session was never picked', 0, () => {
      // `activeSessionKeyRawOf`, not `activeSessionKeyOf`: web reads the raw
      // map, so an untouched connection pins nothing rather than 'default'.
      const store: SessionStore = SessionStore.connect();
      store.setActiveConnection('c9');

      applyCreatedSession(store, 'c9', 'new-3', 5000);

      expect(store.stickySessionOf('c9')).assertEqual('');
    });

    it('clears the new key residue before making it current', 0, () => {
      const store: SessionStore = SessionStore.connect();
      const chatKey: string = chatKeyOf('c1', 'new-4');
      store.applySessions([session('c1', 'old', 100)]);
      store.setActiveConnection('c1');
      store.setActiveSession('c1', 'old');
      seedResidue(chatKey);

      applyCreatedSession(store, 'c1', 'new-4', 5000);

      expect(ChatStore.connect().messagesOf(chatKey).length).assertEqual(0);
      expect(ChatStore.connect().streamingOf(chatKey)).assertEqual('');
      expect(TaskStore.connect().phaseOf(chatKey)).assertEqual('idle');
      expect(store.unreadOf(chatKey)).assertEqual(0);
    });

    it('seeds the session record locally and selects it', 0, () => {
      const store: SessionStore = SessionStore.connect();
      store.setActiveConnection('c1');

      applyCreatedSession(store, 'c1', 'new-5', 5000);

      const listed: Session[] = store.sessionsOf('c1');
      expect(listed.length).assertEqual(1);
      expect(listed[0].key).assertEqual('new-5');
      expect(listed[0].createdAt).assertEqual(5000);
      expect(listed[0].lastActiveAt).assertEqual(5000);
      expect(store.activeSessionKeyOf('c1')).assertEqual('new-5');
    });
  });

  describe('SessionRow.selectSession', () => {
    beforeEach(() => { ConnectionGateway.instance.stop(); });

    it('switches the pointer and marks the session read', 0, () => {
      const store: SessionStore = SessionStore.connect();
      const target: Session = session('c1', 's2', 200);
      store.applySessions([session('c1', 's1', 100), target]);
      store.setActiveConnection('c1');
      store.setUnread(chatKeyOf('c1', 's2'), 3);

      selectSession(store, target);

      expect(store.currentChatKey).assertEqual(chatKeyOf('c1', 's2'));
      expect(store.unreadOf(chatKeyOf('c1', 's2'))).assertEqual(0);
    });
  });
}
