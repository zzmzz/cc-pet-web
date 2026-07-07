/**
 * Full-text-search helpers.
 *
 * The FTS5 `unicode61` tokenizer treats a maximal run of CJK characters as a
 * SINGLE token, so a substring search inside Chinese text (the common case for
 * this app) never matches — e.g. searching "搜索" in "全文搜索功能" returns
 * nothing. We work around this by segmenting CJK characters into individual
 * tokens both when indexing content and when building the MATCH query, so a
 * phrase query of adjacent single-character tokens behaves like a substring
 * match. ASCII words keep their normal whole-word tokenization.
 */

/** Characters we split into individual FTS tokens: CJK ideographs (incl. ext.
 *  A + compatibility), Japanese kana, and Hangul syllables. */
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/** Insert spaces around each CJK/kana/Hangul character so `unicode61` emits one
 *  token per character. ASCII and other scripts are left untouched. */
export function segmentForFts(text: string): string {
  let out = "";
  for (const ch of text) {
    out += CJK_CHAR.test(ch) ? ` ${ch} ` : ch;
  }
  return out;
}

/**
 * Build an FTS5 MATCH expression from a raw user query. Returns `null` when the
 * query has no searchable tokens (e.g. only whitespace/punctuation), in which
 * case the caller should return an empty result set.
 *
 * The segmented query is wrapped in a single double-quoted phrase so the
 * segmented CJK characters must appear adjacently (= substring semantics) and
 * so FTS5 operators the user typed are treated literally.
 */
export function buildMatchQuery(rawQuery: string): string | null {
  const normalized = segmentForFts(rawQuery).replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return `"${normalized.replace(/"/g, '""')}"`;
}

const SNIPPET_RADIUS = 32;
const HL_START = "<<hl>>";
const HL_END = "<</hl>>";

/**
 * Produce a highlighted snippet from the ORIGINAL message content (the FTS
 * column stores segmented text, unsuitable for display). Wraps the first
 * case-insensitive occurrence of `rawQuery` with `<<hl>>…<</hl>>` markers and
 * trims surrounding context, adding ellipses when truncated. Falls back to the
 * head of the content when no literal occurrence is found.
 */
export function makeSnippet(content: string, rawQuery: string): string {
  const query = rawQuery.trim();
  const idx = query ? content.toLowerCase().indexOf(query.toLowerCase()) : -1;

  if (idx < 0) {
    const head = content.slice(0, SNIPPET_RADIUS * 2);
    return head.length < content.length ? `${head}...` : head;
  }

  const matchEnd = idx + query.length;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchEnd + SNIPPET_RADIUS);

  const before = content.slice(start, idx);
  const match = content.slice(idx, matchEnd);
  const after = content.slice(matchEnd, end);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";

  return `${prefix}${before}${HL_START}${match}${HL_END}${after}${suffix}`;
}
