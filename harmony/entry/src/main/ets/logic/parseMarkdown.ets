import { MdNode, emptyNode } from '../model/Markdown';

function isTableDivider(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function splitRow(line: string): string[] {
  const trimmed: string = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  for (const cell of trimmed.split('|')) {
    cells.push(cell.trim());
  }
  return cells;
}

/**
 * Block-level markdown parser for the controlled subset the chat needs.
 * Pure: no ArkUI imports, so it stays unit-testable.
 */
export function parseMarkdown(src: string): MdNode[] {
  const lines: string[] = src.split('\n');
  const nodes: MdNode[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      const node: MdNode = emptyNode('paragraph');
      node.text = paragraph.join(' ');
      nodes.push(node);
      paragraph = [];
    }
  };

  let i: number = 0;
  while (i < lines.length) {
    const line: string = lines[i];
    const trimmed: string = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      const node: MdNode = emptyNode('code');
      node.language = trimmed.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      node.text = body.join('\n');
      nodes.push(node);
      i++;
      continue;
    }

    if (trimmed.length === 0) {
      flushParagraph();
      i++;
      continue;
    }

    const heading: RegExpMatchArray | null = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      flushParagraph();
      const node: MdNode = emptyNode('heading');
      node.level = heading[1].length;
      node.text = heading[2].trim();
      nodes.push(node);
      i++;
      continue;
    }

    if (trimmed.startsWith('> ') || trimmed === '>') {
      flushParagraph();
      const node: MdNode = emptyNode('quote');
      node.text = trimmed.replace(/^>\s?/, '');
      nodes.push(node);
      i++;
      continue;
    }

    const unordered: boolean = /^[-*+]\s+/.test(trimmed);
    const ordered: boolean = /^\d+\.\s+/.test(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const node: MdNode = emptyNode('list');
      node.ordered = ordered;
      while (i < lines.length) {
        const item: string = lines[i].trim();
        const matchesSame: boolean = node.ordered ? /^\d+\.\s+/.test(item) : /^[-*+]\s+/.test(item);
        if (!matchesSame) {
          break;
        }
        node.items.push(item.replace(/^([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      nodes.push(node);
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      flushParagraph();
      const node: MdNode = emptyNode('table');
      node.rows.push(splitRow(trimmed));
      i += 2;
      while (i < lines.length && lines[i].trim().includes('|')) {
        node.rows.push(splitRow(lines[i]));
        i++;
      }
      nodes.push(node);
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }

  flushParagraph();
  return nodes;
}
