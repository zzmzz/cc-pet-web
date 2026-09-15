import { describe, it, expect } from '@ohos/hypium';
import { normalizeEvent, chatKeyOf, RawWsEnvelope, NormalizedEvent } from '../main/ets/logic/normalizeEvent';

export default function normalizeEventTest() {
  describe('normalizeEvent', () => {
    it('builds the chat key from connection and session', 0, () => {
      const raw: RawWsEnvelope = {
        type: 'bridge:message',
        payload: { connectionId: 'c1', sessionKey: 's1', content: 'hi' },
      };
      const out: NormalizedEvent = normalizeEvent(raw);
      expect(out.connectionId).assertEqual('c1');
      expect(out.sessionKey).assertEqual('s1');
      expect(out.chatKey).assertEqual('c1::s1');
    });

    it('falls back to empty strings when ids are absent', 0, () => {
      const raw: RawWsEnvelope = { type: 'bridge:manifest', payload: {} };
      const out: NormalizedEvent = normalizeEvent(raw);
      expect(out.connectionId).assertEqual('');
      expect(out.sessionKey).assertEqual('');
      expect(out.chatKey).assertEqual('');
    });

    it('keeps the payload intact for consumers', 0, () => {
      const raw: RawWsEnvelope = {
        type: 'bridge:stream-delta',
        payload: { connectionId: 'c1', sessionKey: 's1', delta: 'abc' },
      };
      const out: NormalizedEvent = normalizeEvent(raw);
      expect(out.payload.delta).assertEqual('abc');
    });

    it('carries ack fields through untouched', 0, () => {
      const raw: RawWsEnvelope = {
        type: 'message-ack',
        payload: { connectionId: 'c1', sessionKey: 's1', clientMsgId: 'local-1', id: 'srv-9', seq: 42 },
      };
      const out: NormalizedEvent = normalizeEvent(raw);
      expect(out.payload.clientMsgId).assertEqual('local-1');
      expect(out.payload.id).assertEqual('srv-9');
      expect(out.payload.seq).assertEqual(42);
    });

    it('parses a real json frame off the wire', 0, () => {
      const raw: RawWsEnvelope =
        JSON.parse('{"type":"resident:unread","payload":{"connectionId":"c1","sessionKey":"s1","unreadCount":3}}') as RawWsEnvelope;
      const out: NormalizedEvent = normalizeEvent(raw);
      expect(out.chatKey).assertEqual('c1::s1');
      expect(out.payload.unreadCount).assertEqual(3);
    });
  });

  describe('chatKeyOf', () => {
    it('returns empty when either part is missing', 0, () => {
      expect(chatKeyOf('', 's1')).assertEqual('');
      expect(chatKeyOf('c1', '')).assertEqual('');
    });
  });
}
