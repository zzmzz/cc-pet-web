import localUnitTest from './LocalUnit.test';
import backoffTest from './Backoff.test';
import normalizeEventTest from './NormalizeEvent.test';
import derivePetStateTest from './DerivePetState.test';
import parseMarkdownBlockTest from './ParseMarkdownBlock.test';
import parseInlineTest from './ParseInline.test';
import slashCommandsTest from './SlashCommands.test';
import outboxTest from './Outbox.test';

export default function testsuite() {
  localUnitTest();
  backoffTest();
  normalizeEventTest();
  derivePetStateTest();
  parseMarkdownBlockTest();
  parseInlineTest();
  slashCommandsTest();
  outboxTest();
}
