import { describe, it, expect } from '@ohos/hypium';
import { parseInline } from '../main/ets/logic/parseInline';
import { MdSpan } from '../main/ets/model/Markdown';

export default function parseInlineTest() {
  describe('parseInline', () => {
    it('returns a single text span for plain input', 0, () => {
      const spans: MdSpan[] = parseInline('hello world');
      expect(spans.length).assertEqual(1);
      expect(spans[0].kind).assertEqual('text');
      expect(spans[0].text).assertEqual('hello world');
    });

    it('splits bold segments', 0, () => {
      const spans: MdSpan[] = parseInline('a **b** c');
      expect(spans.length).assertEqual(3);
      expect(spans[1].kind).assertEqual('bold');
      expect(spans[1].text).assertEqual('b');
    });

    it('parses inline code before emphasis', 0, () => {
      const spans: MdSpan[] = parseInline('use `a * b` here');
      expect(spans[1].kind).assertEqual('code');
      expect(spans[1].text).assertEqual('a * b');
    });

    it('parses links with href', 0, () => {
      const spans: MdSpan[] = parseInline('see [docs](https://x.dev)');
      expect(spans[1].kind).assertEqual('link');
      expect(spans[1].text).assertEqual('docs');
      expect(spans[1].href).assertEqual('https://x.dev');
    });

    it('parses images distinctly from links', 0, () => {
      const spans: MdSpan[] = parseInline('![alt](https://x.dev/a.png)');
      expect(spans[0].kind).assertEqual('image');
      expect(spans[0].href).assertEqual('https://x.dev/a.png');
      expect(spans[0].text).assertEqual('alt');
    });

    it('parses italic', 0, () => {
      const spans: MdSpan[] = parseInline('a *b* c');
      expect(spans[1].kind).assertEqual('italic');
      expect(spans[1].text).assertEqual('b');
    });

    it('leaves unmatched markers as literal text', 0, () => {
      const spans: MdSpan[] = parseInline('2 * 3 = 6');
      expect(spans.length).assertEqual(1);
      expect(spans[0].text).assertEqual('2 * 3 = 6');
    });
  });
}
