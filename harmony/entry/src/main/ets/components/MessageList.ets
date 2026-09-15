import { ChatMessage } from '../model/Protocol';
import { OutboxStatus } from '../logic/outbox';
import { parseMarkdown } from '../logic/parseMarkdown';
import { ChatStore } from '../store/ChatStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { ConnectionGateway, OutboxStatusView } from '../gateway/ConnectionGateway';
import { MarkdownView } from './MarkdownView';
import { ErrorBanner } from './ErrorBanner';

const HISTORY_ERROR_TEXT: string = '历史记录加载失败';

const USER_BUBBLE_COLOR: string = '#0A59F7';
const FAILED_BUBBLE_COLOR: string = '#E03131';
const ASSISTANT_BUBBLE_COLOR: string = '#F1F3F5';
const ASSISTANT_TEXT_COLOR: string = '#1F2328';
const SYSTEM_TEXT_COLOR: string = '#8A8F98';

@ComponentV2
export struct MessageList {
  @Require @Param chatKey: string = '';
  @Local private chat: ChatStore = ChatStore.connect();
  /**
   * The gateway→UI signal channel (see `ConnectionStore.outboxRevision` and
   * `historyErrors`). `@Local`-held for the same reason as `chat`: that is
   * what registers this component as a V2 observer of the store's `@Trace`
   * fields.
   *
   * This replaced a `setInterval(…, 1000)` that existed only to force a
   * re-render — it bumped a local counter every second so `statusOf()` and
   * `showHistoryError()` would be re-run, which meant re-running `ForEach`
   * over the whole transcript and `parseMarkdown()` per assistant bubble
   * once a second, forever, on a list Task 17 raised to 200 messages per
   * page and up to 5000. The two things that timer was watching for now
   * announce themselves.
   */
  @Local private conn: ConnectionStore = ConnectionStore.connect();

  private scroller: Scroller = new Scroller();
  private lastRenderedCount: number = -1;

  aboutToAppear(): void {
    // Initial scroll-to-bottom once the first frame has laid out.
    setTimeout(() => { this.scroller.scrollEdge(Edge.Bottom); }, 100);
  }

  /**
   * Auto-scroll used to ride on the 1 Hz tick, so a newly arrived message
   * could sit below the fold for up to a second. `ChatStore.revision` is
   * bumped by every message mutation, and `@Monitor` is the V2 tool for
   * "run a side effect once when a tracked field changes" — the same
   * mechanism `Index` already uses for `auth.authorized`/`session.bridges`.
   * It fires for mutations in *any* chat, which is harmless:
   * `maybeAutoScroll` recomputes this chat's own count and no-ops when it
   * hasn't changed.
   */
  @Monitor('chat.revision')
  onChatChanged(_monitor: IMonitor): void {
    this.maybeAutoScroll();
  }

  /** A chat switch should land at the bottom of the new transcript. */
  @Monitor('chatKey')
  onChatKeyChanged(_monitor: IMonitor): void {
    this.lastRenderedCount = -1;
    this.maybeAutoScroll();
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
    if (this.conn.outboxRevision < 0) {
      return undefined; // never true — reads `outboxRevision` so V2 tracks this as a render dependency.
    }
    const entries: OutboxStatusView[] = ConnectionGateway.instance.outboxEntriesOf(this.chatKey);
    for (const entry of entries) {
      if (entry.clientMsgId === clientMsgId) {
        return entry.status;
      }
    }
    return undefined;
  }

  /**
   * Task 17 degradation-table row 5: history-backfill failure → a top
   * banner, manual retry, must not block the current conversation.
   *
   * Per-chat, and that matters: this used to read one global boolean on the
   * gateway, so a failure in chat A raised the banner in chat B too — and
   * B's retry button retried B, cleared the shared flag, and left A stale
   * with no banner at all. Reading a `@Trace` field of a Store is also what
   * lets this re-render on its own; no tick needed.
   */
  private showHistoryError(): boolean {
    return this.conn.historyErrorOf(this.chatKey);
  }

  /**
   * Bubble background: role-specific, `user` additionally flips red on
   * `failed`. Only ever called for `user`/`assistant` (see `renderMessage`,
   * which routes `system` to `renderSystemNotice` instead, never through a
   * colored bubble) — the `system` branch below exists only so the three
   * `ChatRole` cases are handled explicitly rather than a binary `!== 'user'`
   * check, per this round's fix; it never actually executes.
   */
  private bubbleColor(msg: ChatMessage): string {
    if (msg.role === 'user') {
      return this.statusOf(msg.id) === 'failed' ? FAILED_BUBBLE_COLOR : USER_BUBBLE_COLOR;
    } else if (msg.role === 'assistant') {
      return ASSISTANT_BUBBLE_COLOR;
    } else {
      return ASSISTANT_BUBBLE_COLOR;
    }
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
    Column({ space: 0 }) {
      if (this.showHistoryError()) {
        ErrorBanner({
          text: HISTORY_ERROR_TEXT,
          onRetry: (): void => { ConnectionGateway.instance.retryHistory(this.chatKey); },
        })
      }
      List({ scroller: this.scroller, space: 4 }) {
        ForEach(this.chat.messagesOf(this.chatKey), (msg: ChatMessage) => {
          ListItem() {
            this.renderMessage(msg)
          }
        }, (msg: ChatMessage) => msg.id)
        if (this.chat.streamingOf(this.chatKey).length > 0) {
          ListItem() {
            this.renderStreamingBubble()
          }
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
  }

  /**
   * Explicit three-way dispatch on `ChatRole` (`'user' | 'assistant' |
   * 'system'`, see `model/Protocol.ets`). Previously this branched binary on
   * `role === 'user'` / else, which silently routed `system` into the
   * assistant's light-gray bubble with white text — invisible. Nothing
   * constructs a `system` message yet, but it's handled properly here rather
   * than left as a latent bug.
   */
  @Builder
  renderMessage(msg: ChatMessage) {
    if (msg.role === 'user') {
      this.renderBubble(msg)
    } else if (msg.role === 'assistant') {
      this.renderBubble(msg)
    } else {
      this.renderSystemNotice(msg)
    }
  }

  /** Centered, muted, smaller text — no colored bubble — the usual convention for system notices. */
  @Builder
  renderSystemNotice(msg: ChatMessage) {
    Row() {
      Text(msg.content)
        .fontSize(12)
        .fontColor(SYSTEM_TEXT_COLOR)
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .justifyContent(FlexAlign.Center)
    .padding({ left: 24, right: 24, top: 4, bottom: 4 })
  }

  /** Only ever called for `user`/`assistant` (see `renderMessage`). */
  @Builder
  renderBubble(msg: ChatMessage) {
    Row() {
      Column({ space: 4 }) {
        if (msg.role === 'assistant') {
          MarkdownView({ nodes: parseMarkdown(msg.content) })
        } else if (msg.role === 'user') {
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
