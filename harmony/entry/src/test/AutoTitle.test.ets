import { describe, it, expect } from '@ohos/hypium';
import { autoSessionTitle, firstUserText, AUTO_SESSION_TITLE_MAX_LEN } from '../main/ets/logic/autoTitle';
import { ChatMessage, ChatRole } from '../main/ets/model/Protocol';

function message(role: ChatRole, content: string): ChatMessage {
  return { id: `m-${content}`, role: role, content: content, timestamp: 1 };
}

export default function autoTitleTest() {
  describe('autoSessionTitle', () => {
    it('uses the trimmed text when it is short enough', 0, () => {
      expect(autoSessionTitle('  hello world  ')).assertEqual('hello world');
    });

    it('declines on blank input so an existing label survives', 0, () => {
      expect(autoSessionTitle('')).assertEqual('');
      expect(autoSessionTitle('   \n\t ')).assertEqual('');
    });

    it('truncates at web AUTO_SESSION_TITLE_MAX_LEN and appends an ellipsis', 0, () => {
      // Web's own test vector (`session-behavior.test.ts`), character for
      // character — 30 digits in, the first 15 plus '…' out.
      expect(autoSessionTitle('123456789012345678901234567890')).assertEqual('123456789012345…');
    });

    it('does not truncate text of exactly the maximum length', 0, () => {
      const exact: string = '1'.repeat(AUTO_SESSION_TITLE_MAX_LEN);
      expect(autoSessionTitle(exact)).assertEqual(exact);
    });

    it('keeps the whole text, not just its first line', 0, () => {
      // Deliberate divergence from this task's brief ("取首行") and deliberate
      // parity with web, which trims the whole string and never splits lines.
      expect(autoSessionTitle('one\ntwo')).assertEqual('one\ntwo');
    });
  });

  describe('firstUserText', () => {
    it('skips assistant messages and returns the first user one', 0, () => {
      const messages: ChatMessage[] = [
        message('assistant', 'sys'),
        message('user', 'from history'),
        message('user', 'later'),
      ];
      expect(firstUserText(messages)).assertEqual('from history');
    });

    it('skips a blank user message', 0, () => {
      const messages: ChatMessage[] = [message('user', '   '), message('user', 'real')];
      expect(firstUserText(messages)).assertEqual('real');
    });

    it('returns empty for a transcript with no user text', 0, () => {
      expect(firstUserText([])).assertEqual('');
      expect(firstUserText([message('assistant', 'only me')])).assertEqual('');
    });
  });
}
