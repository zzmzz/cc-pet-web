import { MdSpan } from '../model/Markdown';

/**
 * Image receive/preview is NOT in the first release (see `harmony/README.md`
 * and spec §2): nothing dispatches `bridge:file-received`, and there is no
 * token-authenticated fetch path wired into markdown rendering. What is left
 * is markdown that *contains* an image — a reply quoting `![图](/api/files/x)`
 * or any other href — and `ImageSpan` renders such a span as literally
 * nothing: no box, no text, no indication a line of the reply was dropped.
 *
 * These two pure helpers are the honest-degradation rule for that case, kept
 * out of `MarkdownView` so they are unit-testable like the rest of `logic/`.
 */

/**
 * Can `ImageSpan` plausibly resolve this href at all?
 *
 * Only an absolute `http(s)` URL can. A server-relative path (`/api/files/…`,
 * the only kind cc-pet actually emits) has no origin to resolve against, and
 * `/api/files/*` additionally requires the `Authorization: Bearer` header
 * `ImageSpan` cannot attach — so it would fail even if the origin were
 * prepended. Everything else (empty, `data:`-less relative paths, `file:`)
 * falls back to alt text rather than rendering blank.
 *
 * Deliberately a whitelist, not a blacklist: the failure mode being fixed is
 * "renders nothing at all", so anything not known-loadable is better shown
 * as text.
 */
export function isRenderableImageHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

/**
 * What to show in place of an image that cannot be rendered. The markdown
 * alt text when the author wrote one (`![流程图](…)` → `[图片: 流程图]`),
 * otherwise a bare marker so the user still sees that something was there.
 */
export function imageFallbackText(span: MdSpan): string {
  const alt: string = span.text.trim();
  return alt.length > 0 ? `[图片: ${alt}]` : '[图片]';
}
