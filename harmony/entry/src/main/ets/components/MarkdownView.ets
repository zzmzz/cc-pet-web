import { MdNode, MdSpan } from '../model/Markdown';
import { parseInline } from '../logic/parseInline';
import { isRenderableImageHref, imageFallbackText } from '../logic/markdownImage';
import { pasteboard } from '@kit.BasicServicesKit';
import { common, Want } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';

const LINK_COLOR: string = '#0A59F7';
const INLINE_CODE_COLOR: string = '#C7254E';
const CODE_BG: string = '#F1F3F5';
const CODE_TEXT: string = '#1F2328';
const QUOTE_BAR_COLOR: string = '#D0D5DB';
const TABLE_BORDER_COLOR: string = '#E1E4E8';
const HEADING_SIZES: number[] = [24, 22, 20, 18, 16, 15];
/** Rough per-character width estimate (px) for sizing table columns — see `columnWidth()`. */
const TABLE_CHAR_WIDTH_PX: number = 16;
const TABLE_CELL_PADDING_PX: number = 12;
const TABLE_MIN_CELL_WIDTH_PX: number = 96;
const IMAGE_FALLBACK_COLOR: string = '#8A8F98';

/**
 * Renders a block-level `MdNode[]` (from `parseMarkdown`). Does not parse
 * markdown itself — callers own when/whether to call `parseMarkdown`, which
 * matters for the streaming path (see MessageList: a streaming bubble is
 * plain `Text`, never routed through here until `bridge:stream-done`).
 */
@ComponentV2
export struct MarkdownView {
  @Require @Param nodes: MdNode[] = [];

  /**
   * Hrefs whose `ImageSpan` reported `onError`. Reassigned (never mutated in
   * place) so the V2 observer actually fires and the failed span re-renders
   * as its alt text — see `renderSpan`. `@Local` because this is per-view
   * render state, not anything another component or a gateway observes.
   */
  @Local private failedImages: Set<string> = new Set<string>();

  private markImageFailed(href: string): void {
    if (this.failedImages.has(href)) {
      return;
    }
    const next: Set<string> = new Set<string>(this.failedImages);
    next.add(href);
    this.failedImages = next;
  }

  private openLink(href: string): void {
    if (href.length === 0) {
      return;
    }
    // `@kit.BasicServicesKit` has no URL-open API (only pasteboard etc.) —
    // opening the system browser is an AbilityKit concern. A generic
    // "view data" implicit want lets the system pick a browser without
    // requiring domain verification (unlike UIAbilityContext.openLink,
    // which is for verified App Linking domains only).
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: href,
    };
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    context.startAbility(want).catch(() => {
      // No matching ability (e.g. no browser on this device/emulator) —
      // nothing sensible to surface to the user for a single tapped link.
    });
  }

  private copyCode(text: string): void {
    const data: pasteboard.PasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
    pasteboard.getSystemPasteboard().setData(data)
      .then(() => {
        promptAction.showToast({ message: '已复制' });
      })
      .catch(() => {});
  }

  private headingSize(level: number): number {
    const index: number = level >= 1 && level <= 6 ? level - 1 : 5;
    return HEADING_SIZES[index];
  }

  build() {
    Column({ space: 10 }) {
      ForEach(this.nodes, (node: MdNode, index: number) => {
        this.renderNode(node);
      }, (node: MdNode, index: number) => `${index}-${node.kind}`);
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  renderNode(node: MdNode) {
    if (node.kind === 'heading') {
      Text(node.text)
        .fontSize(this.headingSize(node.level))
        .fontWeight(FontWeight.Bold)
        .width('100%')
    } else if (node.kind === 'code') {
      this.renderCode(node)
    } else if (node.kind === 'list') {
      this.renderList(node)
    } else if (node.kind === 'table') {
      this.renderTable(node)
    } else if (node.kind === 'quote') {
      // A left border on the content itself, not a separate vertical
      // Divider sibling: an unsized `Divider().vertical(true)` defaults to
      // filling all available cross-axis space, which inflated the whole
      // bubble to the List's height when tried here.
      Column() {
        this.renderInline(node.text)
      }
      .width('100%')
      .padding({ left: 10 })
      .border({ width: { left: 3 }, color: QUOTE_BAR_COLOR })
    } else {
      this.renderInline(node.text)
    }
  }

  @Builder
  renderInline(text: string) {
    Text() {
      ForEach(parseInline(text), (span: MdSpan, i: number) => {
        this.renderSpan(span);
      }, (span: MdSpan, i: number) => `${i}-${span.kind}-${span.text}`);
    }
    .width('100%')
  }

  /**
   * Image spans degrade to alt text instead of to nothing.
   *
   * Image receive/preview is not in the first release (see `harmony/README.md`
   * and spec §2) and `ImageSpan` renders a failed load as literally zero
   * pixels — no box, no text — so a reply containing `![流程图](/api/files/x)`
   * lost that line silently, with nothing on screen to say a line existed.
   * Two guards, because one isn't enough: `isRenderableImageHref` rejects
   * up front everything `ImageSpan` provably cannot resolve (any
   * server-relative path, which is the only kind cc-pet emits, and which
   * would additionally need the bearer header `ImageSpan` cannot attach),
   * and `onError` catches an absolute URL that looked fine and then failed
   * on the wire.
   */
  @Builder
  renderSpan(span: MdSpan) {
    if (span.kind === 'image') {
      if (isRenderableImageHref(span.href) && !this.failedImages.has(span.href)) {
        ImageSpan(span.href)
          .objectFit(ImageFit.Contain)
          .verticalAlign(ImageSpanAlignment.CENTER)
          .onError(() => { this.markImageFailed(span.href); })
      } else {
        Span(imageFallbackText(span))
          .fontColor(IMAGE_FALLBACK_COLOR)
          .fontStyle(FontStyle.Italic)
      }
    } else if (span.kind === 'link') {
      Span(span.text)
        .fontColor(LINK_COLOR)
        .onClick(() => { this.openLink(span.href); })
    } else if (span.kind === 'code') {
      Span(span.text)
        .fontFamily('monospace')
        .fontColor(INLINE_CODE_COLOR)
    } else if (span.kind === 'bold') {
      Span(span.text).fontWeight(FontWeight.Bold)
    } else if (span.kind === 'italic') {
      Span(span.text).fontStyle(FontStyle.Italic)
    } else {
      Span(span.text)
    }
  }

  @Builder
  renderList(node: MdNode) {
    Column({ space: 4 }) {
      ForEach(node.items, (item: string, i: number) => {
        Row({ space: 6 }) {
          Text(node.ordered ? `${i + 1}.` : '•').fontSize(15)
          Text() {
            ForEach(parseInline(item), (span: MdSpan, j: number) => {
              this.renderSpan(span);
            }, (span: MdSpan, j: number) => `${j}-${span.kind}-${span.text}`);
          }
          .layoutWeight(1)
        }
        .alignItems(VerticalAlign.Top)
        .width('100%')
      }, (item: string, i: number) => `${i}-${item}`);
    }
    .width('100%')
  }

  @Builder
  renderTable(node: MdNode) {
    // Cells used to share equal layoutWeight(1) inside each Row, which only
    // bounds width to the Row's own (bubble) width — with no escape, a table
    // wider than the bubble (many columns, or long cell text) got
    // crushed/clipped instead of scrolling. Wrapping in a horizontal Scroll
    // (same pattern as the code block above) fixes the overflow, but each
    // Row sizing its own cells to natural content width independently would
    // break column alignment across rows (row 2's "name" column landing at a
    // different x than row 3's). `columnWidth()` gives every cell in a given
    // column index the same explicit width — the column's widest cell across
    // all rows — so the table still reads as a grid while scrolling
    // sideways as a whole.
    Scroll() {
      Column() {
        ForEach(node.rows, (row: string[], r: number) => {
          Row() {
            ForEach(row, (cell: string, c: number) => {
              Text(cell)
                .fontSize(14)
                .fontWeight(r === 0 ? FontWeight.Bold : FontWeight.Normal)
                .padding(6)
                .width(this.columnWidth(node.rows, c))
                .border({ width: 1, color: TABLE_BORDER_COLOR })
            }, (cell: string, c: number) => `${r}-${c}`);
          }
        }, (row: string[], r: number) => `${r}`);
      }
      .border({ width: 1, color: TABLE_BORDER_COLOR })
    }
    .scrollable(ScrollDirection.Horizontal)
    .width('100%')
  }

  /**
   * Widest cell (rough char-count estimate, not real text measurement) in
   * column `columnIndex` across every row of `rows` — including the header
   * row, so a short header over a long value column still gets the value's
   * width. Rows are short (chat-sized tables), so recomputing this per cell
   * instead of caching a computed array is cheap and keeps this a plain
   * expression callable from inside the @Builder body above.
   */
  private columnWidth(rows: string[][], columnIndex: number): number {
    let widest: number = TABLE_MIN_CELL_WIDTH_PX;
    for (const row of rows) {
      if (columnIndex >= row.length) {
        continue;
      }
      const estimated: number = row[columnIndex].length * TABLE_CHAR_WIDTH_PX + TABLE_CELL_PADDING_PX;
      if (estimated > widest) {
        widest = estimated;
      }
    }
    return widest;
  }

  @Builder
  renderCode(node: MdNode) {
    Column({ space: 4 }) {
      Row() {
        Text(node.language.length > 0 ? node.language : 'code')
          .fontSize(12)
          .fontColor('#8A8F98')
          .layoutWeight(1)
        Button('复制')
          .fontSize(12)
          .height(28)
          .backgroundColor(Color.Transparent)
          .fontColor(LINK_COLOR)
          .onClick(() => { this.copyCode(node.text); })
      }
      .width('100%')
      Scroll() {
        Text(node.text)
          .fontFamily('monospace')
          .fontSize(13)
          .fontColor(CODE_TEXT)
      }
      .scrollable(ScrollDirection.Horizontal)
      .width('100%')
      .backgroundColor(CODE_BG)
      .padding(8)
      .borderRadius(6)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
