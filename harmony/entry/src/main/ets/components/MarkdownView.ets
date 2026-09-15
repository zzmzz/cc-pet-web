import { MdNode, MdSpan } from '../model/Markdown';
import { parseInline } from '../logic/parseInline';
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

/**
 * Renders a block-level `MdNode[]` (from `parseMarkdown`). Does not parse
 * markdown itself — callers own when/whether to call `parseMarkdown`, which
 * matters for the streaming path (see MessageList: a streaming bubble is
 * plain `Text`, never routed through here until `bridge:stream-done`).
 */
@ComponentV2
export struct MarkdownView {
  @Require @Param nodes: MdNode[] = [];

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

  @Builder
  renderSpan(span: MdSpan) {
    if (span.kind === 'image') {
      ImageSpan(span.href)
        .objectFit(ImageFit.Contain)
        .verticalAlign(ImageSpanAlignment.CENTER)
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
    Column() {
      ForEach(node.rows, (row: string[], r: number) => {
        Row() {
          ForEach(row, (cell: string, c: number) => {
            Text(cell)
              .fontSize(14)
              .fontWeight(r === 0 ? FontWeight.Bold : FontWeight.Normal)
              .padding(6)
              .layoutWeight(1)
              .border({ width: 1, color: TABLE_BORDER_COLOR })
          }, (cell: string, c: number) => `${r}-${c}`);
        }
        .width('100%')
      }, (row: string[], r: number) => `${r}`);
    }
    .width('100%')
    .border({ width: 1, color: TABLE_BORDER_COLOR })
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
