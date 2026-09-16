import { describe, it, expect } from '@ohos/hypium';
import { ROUTED_EVENT_TYPES, isRoutedEventType, WsEvents } from '../main/ets/model/Protocol';

/**
 * Pins WHICH events get session-routed, and — just as deliberately — which
 * two do not.
 *
 * The count assertion is not padding. `bridge:card` and `bridge:audio` carry
 * session content exactly like `bridge:message` does, and the only reason
 * they are excluded is that web excludes them
 * (`INCOMING_SESSION_ROUTING_TYPES` in `packages/web/src/lib/web-adapter.ts`);
 * the design spec records that as a possible web-side oversight to report as
 * a web bug rather than silently fork here (section 4.3 of
 * docs/superpowers/specs/2026-09-16-harmony-session-management-design.md).
 * So this test exists to make widening the set impossible to do casually:
 * anyone adding a 12th type has to come here, delete an assertion that says
 * why the set is 11, and decide consciously whether web is being fixed too.
 */
export default function routingEventSetTest() {
  describe('ROUTED_EVENT_TYPES', () => {
    it('is exactly the 11 types web routes, in web order', 0, () => {
      // Spelled out as literals rather than built from `WsEvents`: every one
      // of these was read off `packages/shared/src/constants/events.ts`, and a
      // test that reuses the same constants the implementation reuses would
      // still pass if a constant's VALUE drifted from the shared package.
      // (The server-side guard in
      // `packages/server/tests/harmony-protocol-alignment.test.ts` is what
      // catches drift against web's own list.)
      expect(ROUTED_EVENT_TYPES.join(',')).assertEqual([
        'bridge:message',
        'bridge:stream-delta',
        'bridge:stream-done',
        'bridge:buttons',
        'bridge:file-received',
        'bridge:typing-start',
        'bridge:typing-stop',
        'bridge:preview-start',
        'bridge:preview-update',
        'bridge:preview-delete',
        'bridge:error',
      ].join(','));
    });

    it('holds exactly 11 entries', 0, () => {
      expect(ROUTED_EVENT_TYPES.length).assertEqual(11);
    });

    it('deliberately omits bridge:audio and bridge:card', 0, () => {
      // Both carry session content. Both are absent from web's set. Parity
      // beats a unilateral fix: two clients disagreeing about where a frame
      // belongs is worse than both being wrong the same way, and the
      // disagreement would be invisible until a user reported a lost reply.
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.BRIDGE_AUDIO)).assertFalse();
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.BRIDGE_CARD)).assertFalse();
    });

    it('omits the events that carry no session at all', 0, () => {
      // `message-ack` is addressed by clientMsgId, `bridge:manifest` and
      // `bridge:skills-updated` are connection-wide, and `resident:unread` is
      // server-authoritative for one named chatKey. Routing any of them would
      // invent a session target the frame never had.
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.MESSAGE_ACK)).assertFalse();
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.BRIDGE_MANIFEST)).assertFalse();
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.BRIDGE_SKILLS_UPDATED)).assertFalse();
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.RESIDENT_UNREAD)).assertFalse();
      expect(ROUTED_EVENT_TYPES.includes(WsEvents.BRIDGE_CONNECTED)).assertFalse();
    });
  });

  describe('isRoutedEventType', () => {
    it('answers for members and non-members', 0, () => {
      expect(isRoutedEventType(WsEvents.BRIDGE_STREAM_DELTA)).assertTrue();
      expect(isRoutedEventType(WsEvents.BRIDGE_ERROR)).assertTrue();
      expect(isRoutedEventType(WsEvents.BRIDGE_AUDIO)).assertFalse();
      expect(isRoutedEventType('')).assertFalse();
      expect(isRoutedEventType('bridge:message ')).assertFalse();
    });
  });
}
