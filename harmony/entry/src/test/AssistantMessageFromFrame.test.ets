import { describe, it, expect } from '@ohos/hypium';
import { assistantMessageFromFrame } from '../main/ets/logic/assistantMessageFromFrame';
import { WsFrame } from '../main/ets/logic/normalizeEvent';
import { ChatMessage } from '../main/ets/model/Protocol';

export default function assistantMessageFromFrameTest() {
  describe('assistantMessageFromFrame', () => {
    it('carries the real msgId and seq through for bridge:message', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:message', connectionId: 'c1', sessionKey: 's1',
        content: 'hello', msgId: 'msg-42', seq: 7,
      };
      const message: ChatMessage = assistantMessageFromFrame(frame, 'c1::s1', 1000);
      expect(message.id).assertEqual('msg-42');
      expect(message.seq).assertEqual(7);
      expect(message.content).assertEqual('hello');
      expect(message.timestamp).assertEqual(1000);
      expect(message.connectionId).assertEqual('c1');
      expect(message.sessionKey).assertEqual('s1');
      expect(message.role).assertEqual('assistant');
    });

    it('carries the real msgId and seq through for bridge:stream-done', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:stream-done', connectionId: 'c1', sessionKey: 's1',
        fullText: 'streamed reply', msgId: 'msg-99', seq: 12,
      };
      const message: ChatMessage = assistantMessageFromFrame(frame, 'c1::s1', 2000);
      expect(message.id).assertEqual('msg-99');
      expect(message.seq).assertEqual(12);
      expect(message.content).assertEqual('streamed reply');
    });

    it('falls back to a synthesised id when msgId is missing', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:message', connectionId: 'c1', sessionKey: 's1', content: 'hi',
      };
      const message: ChatMessage = assistantMessageFromFrame(frame, 'c1::s1', 12345);
      expect(message.id).assertEqual('srv-12345');
    });

    it('falls back to seq 0 when seq is missing', 0, () => {
      const frame: WsFrame = {
        type: 'bridge:message', connectionId: 'c1', sessionKey: 's1', content: 'hi', msgId: 'msg-1',
      };
      const message: ChatMessage = assistantMessageFromFrame(frame, 'c1::s1', 500);
      expect(message.seq).assertEqual(0);
    });

    it('splits connectionId and sessionKey from the chat key', 0, () => {
      const frame: WsFrame = { type: 'bridge:message', content: 'x' };
      const message: ChatMessage = assistantMessageFromFrame(frame, 'connA::sessB', 1);
      expect(message.connectionId).assertEqual('connA');
      expect(message.sessionKey).assertEqual('sessB');
    });
  });
}
