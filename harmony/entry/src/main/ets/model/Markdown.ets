export type MdNodeKind = 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table';

export interface MdNode {
  kind: MdNodeKind;
  text: string;
  level: number;
  ordered: boolean;
  items: string[];
  language: string;
  rows: string[][];
}

export function emptyNode(kind: MdNodeKind): MdNode {
  return { kind: kind, text: '', level: 0, ordered: false, items: [], language: '', rows: [] };
}

export type MdSpanKind = 'text' | 'bold' | 'italic' | 'code' | 'link' | 'image';

export interface MdSpan {
  kind: MdSpanKind;
  text: string;
  href: string;
}

export function textSpan(text: string): MdSpan {
  return { kind: 'text', text: text, href: '' };
}
