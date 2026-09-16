import { describe, it, expect } from '@ohos/hypium';
import { chatKeyOf, splitChatKey, ChatKeyParts, DEFAULT_SESSION_KEY } from '../main/ets/logic/normalizeEvent';

/**
 * `splitChatKey` replaced four hand-rolled `chatKey.split('::')` reads with
 * `?? ''` fallbacks. These cases are the ones those reads got wrong or were
 * never asked about.
 */
export default function splitChatKeyTest() {
  describe('splitChatKey', () => {
    it('is the inverse of chatKeyOf', 0, () => {
      const parts: ChatKeyParts = splitChatKey(chatKeyOf('b1', 'default'));
      expect(parts.connectionId).assertEqual('b1');
      expect(parts.sessionKey).assertEqual('default');
    });

    it('returns two empty strings for an empty key', 0, () => {
      const parts: ChatKeyParts = splitChatKey('');
      expect(parts.connectionId).assertEqual('');
      expect(parts.sessionKey).assertEqual('');
    });

    it('returns two empty strings when there is no separator at all', 0, () => {
      // The old `split('::')[0] ?? ''` handed back 'justanid' here, so
      // MessageInput.toggleBridge would have POSTed to a bridge id derived
      // from a string that was never a chat key.
      const parts: ChatKeyParts = splitChatKey('justanid');
      expect(parts.connectionId).assertEqual('');
      expect(parts.sessionKey).assertEqual('');
    });

    it('splits on the FIRST separator, like the server parseChatKey', 0, () => {
      // `split('::')[1]` returned 'weird' here and dropped '::key'.
      const parts: ChatKeyParts = splitChatKey('b1::weird::key');
      expect(parts.connectionId).assertEqual('b1');
      expect(parts.sessionKey).assertEqual('weird::key');
    });

    it('keeps an empty half empty rather than undefined', 0, () => {
      const trailing: ChatKeyParts = splitChatKey('b1::');
      expect(trailing.connectionId).assertEqual('b1');
      expect(trailing.sessionKey).assertEqual('');
      const leading: ChatKeyParts = splitChatKey('::s1');
      expect(leading.connectionId).assertEqual('');
      expect(leading.sessionKey).assertEqual('s1');
    });
  });

  describe('DEFAULT_SESSION_KEY', () => {
    it('is declared once and is the key every unpicked connection falls back to', 0, () => {
      expect(DEFAULT_SESSION_KEY).assertEqual('default');
      expect(chatKeyOf('b1', DEFAULT_SESSION_KEY)).assertEqual('b1::default');
    });
  });
}
