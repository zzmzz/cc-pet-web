import { MdSpan, MdSpanKind, textSpan } from '../model/Markdown';

interface InlineRule {
  kind: MdSpanKind;
  pattern: RegExp;
}

/**
 * Ordered by precedence: code wins over emphasis so `a * b` stays literal,
 * images win over links so ![x](y) is not read as a link.
 */
const RULES: InlineRule[] = [
  { kind: 'code', pattern: /`([^`]+)`/ },
  { kind: 'image', pattern: /!\[([^\]]*)\]\(([^)]+)\)/ },
  { kind: 'link', pattern: /\[([^\]]+)\]\(([^)]+)\)/ },
  { kind: 'bold', pattern: /\*\*([^*]+)\*\*/ },
  { kind: 'italic', pattern: /\*([^*\s][^*]*)\*/ },
];

export function parseInline(src: string): MdSpan[] {
  if (src.length === 0) {
    return [];
  }

  let earliestIndex: number = -1;
  let matched: RegExpMatchArray | null = null;
  let matchedKind: MdSpanKind = 'text';

  for (const rule of RULES) {
    const found: RegExpMatchArray | null = src.match(rule.pattern);
    if (found !== null && found.index !== undefined) {
      if (earliestIndex === -1 || found.index < earliestIndex) {
        earliestIndex = found.index;
        matched = found;
        matchedKind = rule.kind;
      }
    }
  }

  if (matched === null || earliestIndex === -1) {
    return [textSpan(src)];
  }

  const spans: MdSpan[] = [];
  const before: string = src.slice(0, earliestIndex);
  if (before.length > 0) {
    spans.push(textSpan(before));
  }

  const isLinkLike: boolean = matchedKind === 'link' || matchedKind === 'image';
  spans.push({
    kind: matchedKind,
    text: matched[1],
    href: isLinkLike ? matched[2] : '',
  });

  const after: string = src.slice(earliestIndex + matched[0].length);
  for (const span of parseInline(after)) {
    spans.push(span);
  }
  return spans;
}
