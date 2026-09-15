import { describe, it, expect } from '@ohos/hypium';
import { parseMarkdown } from '../main/ets/logic/parseMarkdown';
import { MdNode } from '../main/ets/model/Markdown';

export default function parseMarkdownBlockTest() {
  describe('parseMarkdown blocks', () => {
    it('parses headings with level', 0, () => {
      const nodes: MdNode[] = parseMarkdown('### Title');
      expect(nodes.length).assertEqual(1);
      expect(nodes[0].kind).assertEqual('heading');
      expect(nodes[0].level).assertEqual(3);
      expect(nodes[0].text).assertEqual('Title');
    });

    it('parses a fenced code block with language', 0, () => {
      const nodes: MdNode[] = parseMarkdown('```ts\nconst a = 1;\n```');
      expect(nodes.length).assertEqual(1);
      expect(nodes[0].kind).assertEqual('code');
      expect(nodes[0].language).assertEqual('ts');
      expect(nodes[0].text).assertEqual('const a = 1;');
    });

    it('keeps markdown syntax literal inside code blocks', 0, () => {
      const nodes: MdNode[] = parseMarkdown('```\n# not a heading\n```');
      expect(nodes[0].kind).assertEqual('code');
      expect(nodes[0].text).assertEqual('# not a heading');
    });

    it('parses unordered and ordered lists', 0, () => {
      const un: MdNode[] = parseMarkdown('- a\n- b');
      expect(un[0].kind).assertEqual('list');
      expect(un[0].ordered).assertEqual(false);
      expect(un[0].items.length).assertEqual(2);
      expect(un[0].items[1]).assertEqual('b');

      const or: MdNode[] = parseMarkdown('1. first\n2. second');
      expect(or[0].ordered).assertEqual(true);
      expect(or[0].items[0]).assertEqual('first');
    });

    it('parses block quotes', 0, () => {
      const nodes: MdNode[] = parseMarkdown('> quoted');
      expect(nodes[0].kind).assertEqual('quote');
      expect(nodes[0].text).assertEqual('quoted');
    });

    it('parses a gfm table', 0, () => {
      const nodes: MdNode[] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(nodes[0].kind).assertEqual('table');
      expect(nodes[0].rows.length).assertEqual(2);
      expect(nodes[0].rows[0][1]).assertEqual('b');
      expect(nodes[0].rows[1][0]).assertEqual('1');
    });

    it('groups consecutive lines into one paragraph', 0, () => {
      const nodes: MdNode[] = parseMarkdown('line one\nline two\n\nsecond para');
      expect(nodes.length).assertEqual(2);
      expect(nodes[0].kind).assertEqual('paragraph');
      expect(nodes[0].text).assertEqual('line one line two');
      expect(nodes[1].text).assertEqual('second para');
    });

    it('returns nothing for empty input', 0, () => {
      expect(parseMarkdown('').length).assertEqual(0);
      expect(parseMarkdown('   \n  ').length).assertEqual(0);
    });
  });
}
