import { describe, it, expect } from '@ohos/hypium';
import { normalizeEvent, chatKeyOf, WsFrame, NormalizedEvent } from '../main/ets/logic/normalizeEvent';

export default function normalizeEventTest() {
  describe('normalizeEvent', () => {
    it('builds the chat key from connection and session', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:message', connectionId: 'c1', sessionKey: 's1', content: 'hi',
      };
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.connectionId).assertEqual('c1');
      expect(out.sessionKey).assertEqual('s1');
      expect(out.chatKey).assertEqual('c1::s1');
    });

    it('falls back to empty strings when ids are absent', 0, () => {
      const out: NormalizedEvent = normalizeEvent({ type: 'bridge:manifest' });
      expect(out.connectionId).assertEqual('');
      expect(out.sessionKey).assertEqual('');
      expect(out.chatKey).assertEqual('');
    });

    it('keeps the frame intact for consumers', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:stream-delta', connectionId: 'c1', sessionKey: 's1', delta: 'abc',
      };
      expect(normalizeEvent(frame).frame.delta).assertEqual('abc');
    });

    it('carries ack fields through untouched', 0, () => {
      const frame: WsFrame = {
        type: 'message-ack', connectionId: 'c1', sessionKey: 's1',
        clientMsgId: 'local-1', id: 'srv-9', seq: 42,
      };
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.frame.clientMsgId).assertEqual('local-1');
      expect(out.frame.id).assertEqual('srv-9');
      expect(out.frame.seq).assertEqual(42);
    });

    it('parses a real flat json frame off the wire', 0, () => {
      // Exactly what the server sends: JSON.stringify({ type: event, ...payload })
      const frame: WsFrame =
        JSON.parse('{"type":"resident:unread","connectionId":"c1","sessionKey":"s1","unreadCount":3}') as WsFrame;
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.chatKey).assertEqual('c1::s1');
      expect(out.frame.unreadCount).assertEqual(3);
    });

    it('reads the manifest bridge list', 0, () => {
      const frame: WsFrame =
        JSON.parse('{"type":"bridge:manifest","bridges":[{"id":"cs","name":"cc"}]}') as WsFrame;
      const out: NormalizedEvent = normalizeEvent(frame);
      expect(out.frame.bridges?.length).assertEqual(1);
      expect(out.frame.bridges?.[0].id).assertEqual('cs');
    });
  });

  describe('chatKeyOf', () => {
    it('returns empty when either part is missing', 0, () => {
      expect(chatKeyOf('', 's1')).assertEqual('');
      expect(chatKeyOf('c1', '')).assertEqual('');
    });
  });
}
