import { ChatMessage } from '../model/Protocol';

/**
 * Web's `AUTO_SESSION_TITLE_MAX_LEN` (`packages/web/src/lib/store/session.ts`),
 * kept as the same literal so the two clients can't drift into naming the same
 * session differently.
 *
 * The brief for this task said "取首行、上限约 20 字". Web does neither: it
 * trims the WHOLE text (newlines included) and cuts at 15. Parity governs this
 * phase, so this file is web's rule, not the brief's — a first-line rule would
 * give a multi-line first message a different title on each client, and 15 vs
 * 20 would truncate differently for every message in between.
 */
export const AUTO_SESSION_TITLE_MAX_LEN: number = 15;

/**
 * The title a session should take from one user message, or `''` for
 * "decline — leave the existing label alone".
 *
 * Returning a sentinel rather than throwing/defaulting is what lets the one
 * caller that matters (`SessionStore.touchSessionAutoTitle`) express web's
 * two separate refusals — blank input, and an already-customised label — as
 * two guards instead of one tangled condition.
 */
export function autoSessionTitle(userText: string): string {
  const trimmed: string = userText.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.length > AUTO_SESSION_TITLE_MAX_LEN) {
    return `${trimmed.slice(0, AUTO_SESSION_TITLE_MAX_LEN)}…`;
  }
  return trimmed;
}

/**
 * Web's `syncAutoTitleFromHistoryMessages` predicate, extracted pure: the
 * first user message with non-blank content, or `''`.
 *
 * Used by `HistoryBackfill` to re-derive a session's title when its history
 * lands, which is what web's lazy loader does. It covers the window between
 * a chat's transcript arriving and `/api/sessions` arriving — and a server
 * that (unlike this project's own, which auto-titles identically; see
 * `HistoryBackfill.run`) stores no label at all.
 */
export function firstUserText(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') {
      continue;
    }
    const trimmed: string = message.content.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return '';
}
