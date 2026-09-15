import { SessionStore } from '../store/SessionStore';
import { BridgeInfo } from '../logic/normalizeEvent';
import { chatKeyForBridge, labelForBridge, isCurrentBridge, unreadForBridge, selectBridge } from './SessionRow';

/**
 * Bottom half-modal session switcher for COMPACT windows — thumb-reachable,
 * mounted via `.bindSheet()` on the shell in `Index.ets`. Renders the exact
 * same `SessionStore` data (`bridges`, `currentChatKey`, `unreadOf`) as
 * `SessionSidebar`; only the shell differs. Row logic itself (key/label/
 * current/unread/select) is shared with `SessionSidebar` via
 * `SessionRow.ets` so the two shells can't silently drift apart.
 */
@ComponentV2
export struct SessionSheet {
  /**
   * Fired after a row is tapped, so `Index.ets` can close the sheet
   * (`this.sessionSheetVisible = false`). Selection itself is applied
   * directly to `SessionStore` below — the same "read/write the store
   * directly instead of threading state through @Param" pattern
   * `ChatWindow` already uses for `currentChatKey`.
   */
  @Param onSelect: () => void = (): void => {};
  @Local private session: SessionStore = SessionStore.connect();

  private chatKeyFor(bridge: BridgeInfo): string {
    return chatKeyForBridge(bridge);
  }

  private labelFor(bridge: BridgeInfo): string {
    return labelForBridge(this.session, bridge);
  }

  private isCurrent(bridge: BridgeInfo): boolean {
    return isCurrentBridge(this.session, bridge);
  }

  private unreadFor(bridge: BridgeInfo): number {
    return unreadForBridge(this.session, bridge);
  }

  private select(bridge: BridgeInfo): void {
    selectBridge(this.session, bridge);
    this.onSelect();
  }

  build() {
    Column({ space: 0 }) {
      Text('切换会话')
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .width('100%')
        .padding({ left: 16, right: 16, top: 4, bottom: 12 })
      List({ space: 2 }) {
        ForEach(this.session.bridges, (bridge: BridgeInfo) => {
          ListItem() { this.renderRow(bridge) }
        }, (bridge: BridgeInfo) => bridge.id)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  renderRow(bridge: BridgeInfo) {
    Row({ space: 8 }) {
      Text(this.labelFor(bridge))
        .fontSize(16)
        .fontColor(this.isCurrent(bridge) ? '#0A59F7' : '#1F2328')
        .fontWeight(this.isCurrent(bridge) ? FontWeight.Medium : FontWeight.Normal)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.unreadFor(bridge) > 0) {
        Text(this.unreadFor(bridge) > 99 ? '99+' : String(this.unreadFor(bridge)))
          .fontSize(12)
          .fontColor(Color.White)
          .backgroundColor('#E03131')
          .borderRadius(10)
          .padding({ left: 7, right: 7, top: 2, bottom: 2 })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 14, bottom: 14 })
    .backgroundColor(this.isCurrent(bridge) ? '#F1F3F5' : Color.Transparent)
    .onClick(() => { this.select(bridge); })
  }
}
