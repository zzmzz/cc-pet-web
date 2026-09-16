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

/**
 * The routing half of `ConnectionGateway.dispatch`, driven against a real
 * `SessionStore`.
 *
 * This is deliberately NOT a test of the pure router — `SessionRouting.test.ets`
 * already covers every branch of that. What it covers is the part a pure test
 * structurally cannot: WHICH store values the gateway feeds in. The first case
 * below fails if `activeSessionKeyOf` is passed where `activeSessionKeyRawOf`
 * belongs, which is the single mistake that makes the router's `'known'` and
 * `'fallback'` branches unreachable and silently diverges this client from web.
 *
 * Importing `ConnectionGateway` into the `localUnitTest` target works even
 * though the class imports `@kit.NetworkKit` / `@kit.PerformanceAnalysisKit`
 * (verified by running this file; `RequestHeaders.ets`'s doc comment says
 * there was no precedent for it, and now there is). Nothing here opens a
 * socket: `routeIncoming` reads and writes `SessionStore` and touches nothing
 * else, which is the property that makes it testable at all.
 */
export default function dispatchRoutingTest() {
  describe('ConnectionGateway inbound session routing', () => {
    beforeEach(() => { SessionStore.connect().clearAll(); });

    it('sends a keyless frame to the first known session on a never-picked connection', 0, () => {
      // No `setActiveSession` for c1 — the user has never opened it. The raw
      // pointer is '' here, so the router falls through to `knownSessions[0]`
      // exactly as web does. Feeding it `activeSessionKeyOf` instead would
      // substitute 'default' and land this frame in `c1::default`, a chat that
      // does not exist in this list.
      SessionStore.connect().applySessions([session('c1', 's9', 300), session('c1', 's8', 100)]);
      const event: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1' });
      expect(event.sessionKey).assertEqual('s9');
      expect(event.chatKey).assertEqual('c1::s9');
    });

    it('falls back to default only when the connection has no sessions at all', 0, () => {
      const event: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1' });
      expect(event.chatKey).assertEqual('c1::default');
    });

    it('keeps the payload session key and pins it as sticky', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      const event: NormalizedEvent = route({
        type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1',
      });
      expect(event.chatKey).assertEqual('c1::s1');
      // The server told us whose turn this is, so it is worth remembering for
      // the frames of this turn that arrive without a key.
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');
    });

    it('routes by replyCtx when the frame carries no session key', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      const event: NormalizedEvent = route({
        type: WsEvents.BRIDGE_STREAM_DELTA, connectionId: 'c1', replyCtx: 'ccpet:s1:42',
      });
      expect(event.chatKey).assertEqual('c1::s1');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');
    });

    it('accepts the snake_case reply_ctx spelling too', 0, () => {
      // Web reads `replyCtx ?? reply_ctx`; the upstream bridge picks which one
      // it sends and nothing in this repo produces either.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      const event: NormalizedEvent = route({
        type: WsEvents.BRIDGE_STREAM_DONE, connectionId: 'c1', reply_ctx: 'ccpet:s2:77',
      });
      expect(event.chatKey).assertEqual('c1::s2');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s2');
    });

    it('sends a late keyless reply to the session that asked, not the one on screen', 0, () => {
      // The whole point of this task. The user sends into s1, switches to s2
      // while the model is still thinking, and the reply arrives with no key.
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      SessionStore.connect().setActiveSession('c1', 's2');

      const late: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1' });
      expect(late.chatKey).assertEqual('c1::s1');
      // Sticky is a read here, not a write: a guess must never overwrite the
      // pin it just consulted, or one keyless frame would re-pin the turn onto
      // whatever it guessed.
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s1');
    });

    it('lets a later payload key move the pin', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c1', 's2', 200)]);
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      const next: NormalizedEvent = route({
        type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's2',
      });
      expect(next.chatKey).assertEqual('c1::s2');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('s2');
    });

    it('pins per connection, so one bridge cannot answer for another', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's1', 100), session('c2', 'z1', 100)]);
      route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', sessionKey: 's1' });
      const other: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c2' });
      expect(other.chatKey).assertEqual('c2::z1');
    });

    it('leaves unrouted event types exactly as they arrived', 0, () => {
      SessionStore.connect().applySessions([session('c1', 's9', 300)]);
      // bridge:audio carries content but is outside the set on purpose (see
      // RoutingEventSet.test.ets): it must come through untouched, keyless
      // chatKey and all, rather than being quietly routed here.
      const audio: NormalizedEvent = route({ type: WsEvents.BRIDGE_AUDIO, connectionId: 'c1' });
      expect(audio.sessionKey).assertEqual('');
      expect(audio.chatKey).assertEqual('');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('');

      // resident:unread names its own chatKey and is server-authoritative.
      const unread: NormalizedEvent = route({
        type: WsEvents.RESIDENT_UNREAD, connectionId: 'c1', sessionKey: 'sX',
      });
      expect(unread.chatKey).assertEqual('c1::sX');
      expect(SessionStore.connect().stickySessionOf('c1')).assertEqual('');
    });

    it('leaves a frame with no connectionId alone', 0, () => {
      const event: NormalizedEvent = route({ type: WsEvents.BRIDGE_MESSAGE });
      expect(event.chatKey).assertEqual('');
      expect(event.sessionKey).assertEqual('');
    });

    it('does not lose the frame when it reroutes', 0, () => {
      // `assistantMessageFromFrame` reads `content`/`msgId`/`seq` off the
      // frame after routing, so a rerouted event must carry the same frame
      // object, not a rebuilt one.
      SessionStore.connect().applySessions([session('c1', 's9', 300)]);
      const frame: WsFrame = { type: WsEvents.BRIDGE_MESSAGE, connectionId: 'c1', content: 'hi', seq: 7 };
      const event: NormalizedEvent = route(frame);
      expect(event.chatKey).assertEqual('c1::s9');
      expect(event.frame.content).assertEqual('hi');
      expect(event.frame.seq).assertEqual(7);
      expect(event.type).assertEqual(WsEvents.BRIDGE_MESSAGE);
    });
  });
}
