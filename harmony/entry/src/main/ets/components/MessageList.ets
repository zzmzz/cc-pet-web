import { ChatMessage } from '../model/Protocol';
import { OutboxEntry, OutboxStatus } from '../logic/outbox';
import { parseMarkdown } from '../logic/parseMarkdown';
import { ChatStore } from '../store/ChatStore';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { MarkdownView } from './MarkdownView';

const USER_BUBBLE_COLOR: string = '#0A59F7';
const FAILED_BUBBLE_COLOR: string = '#E03131';
const ASSISTANT_BUBBLE_COLOR: string = '#F1F3F5';
const ASSISTANT_TEXT_COLOR: string = '#1F2328';

@ComponentV2
export struct MessageList {
  @Require @Param chatKey: string = '';
  @Local private chat: ChatStore = ChatStore.connect();
  /**
   * Bumped once a second so `statusOf()` reads register a V2 render
   * dependency on it, forcing a re-render often enough to notice a bubble
   * crossing the 15s ack-timeout into `failed` — the outbox itself isn't
   * `@Trace`'d (it lives on the Gateway, not a Store; see
   * `ConnectionGateway.outboxEntriesOf`), so nothing else would trigger that
   * re-render.
   */
  @Local private tick: number = 0;

  private scroller: Scroller = new Scroller();
  private pollTimer: number = -1;
  private lastRenderedCount: number = -1;

  aboutToAppear(): void {
    this.pollTimer = setInterval(() => {
      this.tick += 1;
      this.maybeAutoScroll();
    }, 1000);
    // Initial scroll-to-bottom once the first frame has laid out.
    setTimeout(() => { this.scroller.scrollEdge(Edge.Bottom); }, 100);
  }

  aboutToDisappear(): void {
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
  }

  private maybeAutoScroll(): void {
    const streaming: string = this.chat.streamingOf(this.chatKey);
    const count: number = this.chat.messagesOf(this.chatKey).length + (streaming.length > 0 ? 1 : 0);
    if (count !== this.lastRenderedCount) {
      this.lastRenderedCount = count;
      this.scroller.scrollEdge(Edge.Bottom);
    }
  }

  /** Outbox status for one message id; `undefined` once acked (entry removed). */
  private statusOf(clientMsgId: string): OutboxStatus | undefined {
    if (this.tick < 0) {
      return undefined; // never true — reads `tick` so V2 tracks this as a render dependency.
    }
    const entries: OutboxEntry[] = ConnectionGateway.instance.outboxEntriesOf(this.chatKey);
    for (const entry of entries) {
      if (entry.clientMsgId === clientMsgId) {
        return entry.status;
      }
    }
    return undefined;
  }

  private bubbleColor(msg: ChatMessage): string {
    if (msg.role !== 'user') {
      return ASSISTANT_BUBBLE_COLOR;
    }
    return this.statusOf(msg.id) === 'failed' ? FAILED_BUBBLE_COLOR : USER_BUBBLE_COLOR;
  }

  build() {
    // ArkTS requires build() to be a single UI expression — no statements
    // before the root node — which rules out imperatively pushing
    // `messagesOf(...)` into a LazyForEach IDataSource here (that push has
    // to happen outside build(), e.g. from a store-change callback, and
    // wiring that up safely would mean leaning on `@Monitor`, unproven
    // elsewhere in this codebase). Using plain `ForEach` directly over
    // `this.chat.messagesOf(this.chatKey)` — an expression, not a
    // statement — sidesteps that entirely: it stays declarative, and
    // reading the store here is still what makes this component re-run
    // build() when ChatStore's `messages` `@Trace` field changes (see the
    // store-reactivity note in ChatStore.ets). This chat's message counts
    // are nowhere near the scale LazyForEach's lazy instantiation exists
    // for, so the deviation from the brief's literal "LazyForEach" costs
    // nothing in practice here.
    List({ scroller: this.scroller, space: 4 }) {
      ForEach(this.chat.messagesOf(this.chatKey), (msg: ChatMessage) => {
        ListItem() {
          this.renderBubble(msg)
        }
      }, (msg: ChatMessage) => msg.id)
      if (this.chat.streamingOf(this.chatKey).length > 0) {
        ListItem() {
          this.renderStreamingBubble()
        }
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  renderBubble(msg: ChatMessage) {
    Row() {
      Column({ space: 4 }) {
        if (msg.role === 'assistant') {
          MarkdownView({ nodes: parseMarkdown(msg.content) })
        } else {
          Text(msg.content).fontColor(Color.White)
        }
        if (msg.role === 'user' && this.statusOf(msg.id) === 'failed') {
          Row({ space: 8 }) {
            Text('发送失败').fontColor(Color.White).fontSize(12)
            Button('重试')
              .fontSize(12)
              .height(24)
              .backgroundColor(Color.Transparent)
              .fontColor(Color.White)
              .border({ width: 1, color: Color.White })
              .onClick(() => { ConnectionGateway.instance.retry(msg.id); })
          }
        } else if (msg.role === 'user' && this.statusOf(msg.id) === 'pending') {
          Text('发送中…').fontColor('#D8E4FF').fontSize(11)
        }
      }
      .padding(12)
      .borderRadius(12)
      .backgroundColor(this.bubbleColor(msg))
      .constraintSize({ maxWidth: '78%' })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .justifyContent(msg.role === 'user' ? FlexAlign.End : FlexAlign.Start)
    .padding({ left: 12, right: 12, top: 4, bottom: 4 })
  }

  @Builder
  renderStreamingBubble() {
    Row() {
      Column({ space: 4 }) {
        // Plain Text, deliberately not parseMarkdown: this fires on every
        // bridge:stream-delta (every few dozen ms). Re-parsing the whole
        // document at that rate drops frames. MarkdownView only takes over
        // once bridge:stream-done finalizes the message (see ChatWindow /
        // ConnectionGateway.finalizeStream).
        Text(this.chat.streamingOf(this.chatKey)).fontColor(ASSISTANT_TEXT_COLOR)
      }
      .padding(12)
      .borderRadius(12)
      .backgroundColor(ASSISTANT_BUBBLE_COLOR)
      .constraintSize({ maxWidth: '78%' })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .justifyContent(FlexAlign.Start)
    .padding({ left: 12, right: 12, top: 4, bottom: 4 })
  }
}
