import { describe, it, expect, beforeEach } from '@ohos/hypium';
import { ConnectionGateway } from '../main/ets/gateway/ConnectionGateway';
import { SessionStore } from '../main/ets/store/SessionStore';
import { normalizeEvent, NormalizedEvent, WsFrame } from '../main/ets/logic/normalizeEvent';
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

function typingStop(connectionId: string, sessionKey?: string): NormalizedEvent {
  return route({ type: WsEvents.BRIDGE_TYPING_STOP, connectionId: connectionId, sessionKey: sessionKey });
}

/** A keyless content frame — the kind this whole phase exists for. */
function keyless(connectionId: string): NormalizedEvent {
  return route({ type: WsEvents.BRIDGE_STREAM_DELTA, connectionId: connectionId });
}

/**
 * The typing layer of `ConnectionGateway.routeIncoming`.
 *
 * Why this exists on top of `DispatchRouting.test.ets`: sticky alone cannot
 * fix the scenario this phase was opened for — not even after Task 6c gave
 * `sendMessage` its own sticky write (`DispatchSendSticky.test.ets`), because
 * sticky is ONE slot per connection: a second send or a second turn's keyed
 * reply, on a different session, overwrites it while an earlier turn is
 * still in flight. None of the tests below call `sendMessage`, so within
 * THIS file sticky is written only by a frame that named its own session
 * (`'payload'` / `'reply_ctx'`) — that is a fact about these fixtures, not a
 * general property of sticky (see `ConnectionGateway.sendMessage`'s doc and
 * the Task 6c report for where that general claim turned out to be false).
 * In a turn where the bridge never sends `session_key` at all — the exact
 * case `packages/server/src/index.ts` warns about with "Bridge content frame
 * carries no session_key" — and no send or keyed frame from another turn
 * has since moved the pin, sticky stays empty (or stale) for the whole turn
 * and routing degrades to "whichever chat the user is looking at right now".
 *
 * What survives that turn is the memory of where the turn's `typing-start`
 * was delivered. `packages/web/src/App.tsx` keeps it in
 * `typingActiveByChatKey`; this client keeps it in the gateway. These tests
 * pin the three properties that are easy to get wrong:
 *   - the typing layer runs AFTER sticky and overrides it unconditionally
 *     (web L210 tests `guessedFromActiveSession`, a `const` that the sticky
 *     block never reassigns — NOT the refined `sessionIsGuess`);
 *   - it is consulted only when we are guessing, never against a frame that
 *     named its own session;
 *   - with two turns in flight it picks the INSERTION-ORDER-FIRST typing
 *     session, which is what `Object.entries` gives web.
 */
export default function dispatchTypingRoutingTest() {
  describe('ConnectionGateway typing-pinned session routing', () => {
    // `stop()` is the gateway's own "forget the previous session" path and the
    // only public way to drop the typing map — which is itself the parity
    // point with web, where the map is a local of the `[authToken]` effect and
    // dies with it.
    beforeEach(() => { ConnectionGateway.instance.stop(); });

    it('pins a keyless turn to the session that was typing when sticky never got written', 0, () => {
      // THE broken scenario. Cold start, the bridge sends no `session_key` on
      // any frame of the turn, so nothing ever writes sticky. The user asks in
      // s1, switches to s2 while the model thinks, and the delta arrives.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      SessionStore.connect().setActiveSession('c1', 's1');
      expect(typingStart('c1').chatKey).assertEqual('c1::s1');
      // Nothing named a session, so there is no pin to fall back on.
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('');

      SessionStore.connect().setActiveSession('c1', 's2');
      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });

    it('lets typing override a sticky pin that points somewhere else', 0, () => {
      // The one that is easiest to write backwards. Web's typing block is not
      // an `else` of the sticky block: it runs after it and wins.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      typingStart('c1', 's1');
      // A later frame names s2, which moves the pin — but s1's turn is still
      // in flight.
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's2' });
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s2');

      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });

    it('falls back to sticky when nobody is typing', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      SessionStore.connect().setActiveSession('c1', 's2');
      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });

    it('never second-guesses a frame that named its own session', 0, () => {
      // The typing layer is part of the GUESS path. A frame carrying its own
      // key, or a parseable replyCtx, has already told us the answer.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      typingStart('c1', 's1');

      const named: NormalizedEvent = route({
        type: WsEvents.BRIDGE_STREAM_DELTA, connectionId: 'c1', sessionKey: 's2',
      });
      expect(named.chatKey).assertEqual('c1::s2');

      const viaCtx: NormalizedEvent = route({
        type: WsEvents.BRIDGE_STREAM_DONE, connectionId: 'c1', replyCtx: 'ccpet:s2:7',
      });
      expect(viaCtx.chatKey).assertEqual('c1::s2');
    });

    it('stops steering once the turn reports typing-stop', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      typingStart('c1', 's1');
      typingStop('c1', 's1');
      // Move the pin so the assertion can tell "typing still wins" from
      // "typing is gone" — with sticky still on s1 both answers look alike.
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's2' });

      expect(keyless('c1').chatKey).assertEqual('c1::s2');
    });

    it('picks the first session that started typing when two turns overlap', 0, () => {
      // Web walks `Object.entries(typingActiveByChatKey)` and returns the
      // first still-typing chatKey, i.e. insertion order, NOT the most recent
      // one and NOT sticky's newer key. Copied deliberately; see the report's
      // note about raising it as a web-side question.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      typingStart('c1', 's1');
      typingStart('c1', 's2');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s2');

      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });

    it('re-entering typing keeps a session in its original queue position', 0, () => {
      // Assigning to an existing JS object key does not move it to the end of
      // `Object.entries`, and neither does `Map.set` on an existing key. s1
      // therefore still precedes s2 after its stop/start cycle.
      SessionStore.connect().applySessions([
        session('c1', 's1', 100), session('c1', 's2', 200), session('c1', 's3', 300),
      ]);
      typingStart('c1', 's1');
      typingStop('c1', 's1');
      typingStart('c1', 's2');
      typingStart('c1', 's1');
      // Park the pin on a third session so neither sticky nor "most recent
      // typing" can produce the expected answer by accident.
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's3' });

      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });

    it('keeps one connection\'s typing out of another connection\'s routing', 0, () => {
      SessionStore.connect().applySessions([
        session('c1', 's1', 100), session('c1', 's2', 200), session('c2', 'z1', 100),
      ]);
      typingStart('c2', 'z1');
      SessionStore.connect().setActiveSession('c1', 's2');

      // c1 has nothing typing and no pin, so it routes by its own active
      // pointer. A prefix-less scan of the map would hand it 'z1' — a session
      // that does not even exist on c1.
      expect(keyless('c1').chatKey).assertEqual('c1::s2');
    });

    it('forgets every turn when the gateway stops', 0, () => {
      // Logout and account switch both land in `stop()`. Web's map is scoped
      // to the `[authToken]` effect, so account A's in-flight turn must not
      // steer account B's first keyless frame.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      typingStart('c1', 's1');

      ConnectionGateway.instance.stop();

      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      SessionStore.connect().setActiveSession('c1', 's2');
      expect(keyless('c1').chatKey).assertEqual('c1::s2');
    });

    it('routes typing frames themselves through sticky before recording them', 0, () => {
      // The map is keyed by where the typing frame LANDED, not by what it
      // said. A keyless typing-start on a connection with a pin belongs to the
      // pinned session, and that is the key the later keyless delta has to
      // find.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      SessionStore.connect().setActiveSession('c1', 's2');
      expect(typingStart('c1').chatKey).assertEqual('c1::s1');

      SessionStore.connect().clearStickySession('c1');
      expect(keyless('c1').chatKey).assertEqual('c1::s1');
    });
  });
}
