import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { ConnectionGateway } from '../main/ets/gateway/ConnectionGateway';
import { SessionStore } from '../main/ets/store/SessionStore';
import { normalizeEvent, NormalizedEvent, WsFrame, chatKeyOf } from '../main/ets/logic/normalizeEvent';
import { Session, WsEvents } from '../main/ets/model/Protocol';

function session(connectionId: string, key: string, lastActiveAt: number): Session {
  return { key: key, connectionId: connectionId, createdAt: 1000, lastActiveAt: lastActiveAt };
}

/** One inbound frame, run through exactly what `dispatch` runs it through. */
function route(frame: WsFrame): NormalizedEvent {
  return ConnectionGateway.instance.routeIncoming(normalizeEvent(frame));
}

function typingStart(connectionId: string, sessionKey?: string): NormalizedEvent {
  return route({ type: WsEvents.BRIDGE_TYPING_START, connectionId: connectionId, sessionKey: sessionKey });
}

/**
 * The send half of the parity gap Task 6b's review found: web pins sticky
 * from SIX places (`ChatWindow.tsx:245/293/318` on every outgoing send,
 * plus three read/keyed-frame sites), this gateway from one
 * (`routeIncoming` on an inbound keyed frame). A bridge that streams a
 * keyless reply and never sends `bridge:typing-start` routed correctly on
 * web — the user's own send had already pinned sticky — and wrong here.
 * `ConnectionGateway.sendMessage` closes that gap the same way web's three
 * send sites do: pin the session the text was actually typed into,
 * unconditionally, at send time.
 *
 * Uses `ConnectionGateway.instance.stop()` in `beforeEach`, exactly like
 * `DispatchTypingRouting.test.ets`, so the outbox/typing-map/ChatStore left
 * over from one test's `sendMessage` call cannot leak into the next.
 */
export default function dispatchSendStickyTest() {
  describe('ConnectionGateway.sendMessage pins sticky', () => {
    beforeEach(() => { ConnectionGateway.instance.stop(); });

    it('pins sticky to the session the message was sent into', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      ConnectionGateway.instance.sendMessage(chatKeyOf('c1', 's1'), 'hello');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');
    });

    it('sends a late keyless, typing-less reply home to the session that sent it', 0, () => {
      // THE scenario Task 6c exists for: no inbound keyed frame ever arrives
      // (so routeIncoming's own sticky write never fires) and the bridge
      // never sends bridge:typing-start (so the 6b typing layer has nothing
      // to consult either). Only the send-time pin can save this reply.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      ConnectionGateway.instance.sendMessage(chatKeyOf('c1', 's1'), 'hello');
      SessionStore.connect().setActiveSession('c1', 's2');

      const late: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1' });
      expect(late.chatKey).assertEqual('c1::s1');
    });

    it('lets a later keyed frame move the pin the send set', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      ConnectionGateway.instance.sendMessage(chatKeyOf('c1', 's1'), 'hello');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');

      const next: NormalizedEvent = route({
        type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's2',
      });
      expect(next.chatKey).assertEqual('c1::s2');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s2');
    });

    it('pins each connection independently', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c2', 'z1', 100)]);
      ConnectionGateway.instance.sendMessage(chatKeyOf('c1', 's1'), 'hello');
      ConnectionGateway.instance.sendMessage(chatKeyOf('c2', 'z1'), 'hi');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');
      expect(SessionStore.connect().stickySessionOf('c2')).assertEqual('z1');

      // Sending on c2 must not disturb c1's pin, and vice versa.
      SessionStore.connect().applySessions([
        session('c1', 's1', 100), session('c1', 's9', 300), session('c2', 'z1', 100),
      ]);
      const c1Reply: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1' });
      expect(c1Reply.chatKey).assertEqual('c1::s1');
    });

    it('still lets typing outrank a send-time pin, per the 6b layering', 0, () => {
      // Send into s1 (pins sticky=s1 with s1 not typing), then a second turn
      // on s2 starts typing and later a keyed frame drags the pin back onto
      // s1 while s2's turn is still in flight. Typing runs after sticky and
      // wins unconditionally (see routeIncoming's doc) — that ordering must
      // survive this task untouched, whichever write put s1 on the pin.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      ConnectionGateway.instance.sendMessage(chatKeyOf('c1', 's1'), 'hello');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');

      typingStart('c1', 's2');
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');

      const keyless: NormalizedEvent = route({ type: WsEvents.BRIDGE_STREAM_DELTA, connectionId: 'c1' });
      expect(keyless.chatKey).assertEqual('c1::s2');
    });
  });
}
