import { SessionStore } from '../store/SessionStore';
import { BridgeInfo } from '../logic/normalizeEvent';
import { chatKeyForBridge, labelForBridge, isCurrentBridge, unreadForBridge, selectBridge } from './SessionRow';

const SIDEBAR_WIDTH: number = 280;

/**
 * Persistent left-column session switcher for MEDIUM/EXPANDED windows.
 * Renders the exact same `SessionStore` data (`bridges`, `currentChatKey`,
 * `unreadOf`) as `SessionSheet` — only the shell differs (always-visible
 * column vs. bottom half-modal). Row logic itself (key/label/current/unread/
 * select) is shared with `SessionSheet` via `SessionRow.ets` so the two
 * shells can't silently drift apart.
 */
@ComponentV2
export struct SessionSidebar {
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
  }

  build() {
    Column({ space: 0 }) {
      Text('会话')
        .fontSize(13)
        .fontColor('#8A8F98')
        .width('100%')
        .padding({ left: 16, right: 16, top: 16, bottom: 8 })
      List({ space: 2 }) {
        ForEach(this.session.bridges, (bridge: BridgeInfo) => {
          ListItem() { this.renderRow(bridge) }
        }, (bridge: BridgeInfo) => bridge.id)
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width(SIDEBAR_WIDTH)
    .height('100%')
    .backgroundColor('#F7F8FA')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  renderRow(bridge: BridgeInfo) {
    Row({ space: 8 }) {
      Text(this.labelFor(bridge))
        .fontSize(15)
        .fontColor(this.isCurrent(bridge) ? '#0A59F7' : '#1F2328')
        .fontWeight(this.isCurrent(bridge) ? FontWeight.Medium : FontWeight.Normal)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (this.unreadFor(bridge) > 0) {
        Text(this.unreadFor(bridge) > 99 ? '99+' : String(this.unreadFor(bridge)))
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor('#E03131')
          .borderRadius(9)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor(this.isCurrent(bridge) ? '#E9ECF3' : Color.Transparent)
    .onClick(() => { this.select(bridge); })
  }
}
