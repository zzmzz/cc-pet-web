import { SessionStore } from '../store/SessionStore';
import { BridgeInfo, chatKeyOf } from '../logic/normalizeEvent';

/**
 * Every bridge advertised by `bridge:manifest` exposes exactly one
 * switchable chat at this stage of the protocol — its 'default' session
 * key (the same convention `Index.ets`'s old bootstrap scaffolding used).
 * `SessionStore.sessions` (richer, server-labelled `Session` records) has
 * no public iteration accessor — only per-key lookups (`labelOf`,
 * `unreadOf`, `isResident`) — so `bridges` is the enumerable list this
 * component switches between; `labelFor` below upgrades to the
 * server-provided label once one exists for a key.
 */
const DEFAULT_SESSION_KEY: string = 'default';
const SIDEBAR_WIDTH: number = 280;

/**
 * Persistent left-column session switcher for MEDIUM/EXPANDED windows.
 * Renders the exact same `SessionStore` data (`bridges`, `currentChatKey`,
 * `unreadOf`) as `SessionSheet` — only the shell differs (always-visible
 * column vs. bottom half-modal).
 */
@ComponentV2
export struct SessionSidebar {
  @Local private session: SessionStore = SessionStore.connect();

  private chatKeyFor(bridge: BridgeInfo): string {
    return chatKeyOf(bridge.id, DEFAULT_SESSION_KEY);
  }

  private labelFor(bridge: BridgeInfo): string {
    const key: string = this.chatKeyFor(bridge);
    const label: string = this.session.labelOf(key);
    return label === key ? bridge.name : label;
  }

  private isCurrent(bridge: BridgeInfo): boolean {
    return this.chatKeyFor(bridge) === this.session.currentChatKey;
  }

  private unreadFor(bridge: BridgeInfo): number {
    return this.session.unreadOf(this.chatKeyFor(bridge));
  }

  private select(bridge: BridgeInfo): void {
    const key: string = this.chatKeyFor(bridge);
    this.session.setCurrent(key);
    // Switching to a session is how the user acknowledges it — mark it
    // read. `clearUnread` already no-ops for resident sessions (their true
    // count only ever comes from the server via `resident:unread`), so this
    // is safe to call unconditionally.
    this.session.clearUnread(key);
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
