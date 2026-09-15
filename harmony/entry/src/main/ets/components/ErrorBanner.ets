const BANNER_BACKGROUND: string = '#FFF3BF';
const BANNER_TEXT_COLOR: string = '#8A6D00';

/**
 * Generic top-of-content error banner with a manual retry button.
 *
 * Currently used for one thing — `MessageList`'s history-backfill failure
 * (Task 17 degradation-table row 5: "history backfill fails → top banner
 * with manual retry, must not block the current conversation") — but takes
 * no dependency on that caller: it owns no state, makes no network calls,
 * and does not decide when to show itself. The parent decides visibility
 * (an `if` around this component) and what "retry" means (`onRetry`).
 */
@ComponentV2
export struct ErrorBanner {
  @Require @Param text: string = '';
  /** Matches the `onSelect`/`onRetry`-style callback `@Param` convention
   * already used by `SessionSheet`/`MessageList` — a safe no-op default,
   * not `@Require`, so a caller that truly has nothing to do on retry
   * doesn't need to pass an empty arrow function explicitly. */
  @Param onRetry: () => void = (): void => {};

  build() {
    Row({ space: 12 }) {
      Text(this.text)
        .fontSize(13)
        .fontColor(BANNER_TEXT_COLOR)
        .layoutWeight(1)
        .maxLines(2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Button('重试')
        .fontSize(12)
        .height(28)
        .backgroundColor(Color.Transparent)
        .fontColor(BANNER_TEXT_COLOR)
        .border({ width: 1, color: BANNER_TEXT_COLOR })
        .onClick(() => { this.onRetry(); })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .backgroundColor(BANNER_BACKGROUND)
  }
}
