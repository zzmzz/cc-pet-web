import { SessionStore } from '../store/SessionStore';
import { ChatStore } from '../store/ChatStore';
import { TaskStore } from '../store/TaskStore';
import { BridgeInfo } from '../logic/normalizeEvent';
import { Session } from '../model/Protocol';
import {
  chatKeyForSession, rowLabel, isCurrentSession, unreadForSession, selectSession,
  isActiveConnection, unreadForConnection, selectConnection,
  nonResidentSessions, activeSessionOf, visibleSessions, hiddenSessionCount,
  openResidentSession, createAndSelectSession, applyDeleteTap,
  formatUnread, phaseDisplayForSession, lastActivityOf, formatTime,
  ROW_MUTED_TEXT_COLOR,
} from './SessionRow';

const SIDEBAR_WIDTH: number = 280;
const TEXT_COLOR: string = '#1F2328';
const ACCENT_COLOR: string = '#0A59F7';
const MUTED_COLOR: string = '#8A8F98';
const DANGER_COLOR: string = '#E03131';
const SELECTED_COLOR: string = '#E9ECF3';
const DIVIDER_COLOR: string = '#DDE1E8';
const PHASE_DOT_SIZE: number = 7;

/**
 * Persistent left-column session switcher for MEDIUM/EXPANDED windows.
 * Renders the exact same `SessionStore` data as `SessionSheet`, through the
 * same `SessionRow.ets` helpers, in the same top-to-bottom order web's
 * `SessionDropdown` uses (resident → connections → current session → recent
 * sessions → new session); only the shell differs — this one is an
 * always-visible column, so nothing here closes after a pick.
 *
 * Every rule about WHICH rows exist and WHAT a tap does lives in
 * `SessionRow.ets`, shared with `SessionSheet`: the first release let the two
 * shells answer those questions separately and they drifted apart, which is
 * why that file exists at all. What stays here is layout and the panel's own
 * two pieces of UI state (`showAll`, `confirmDeleteKey`).
 */
@ComponentV2
export struct SessionSidebar {
  @Local private session: SessionStore = SessionStore.connect();
  @Local private task: TaskStore = TaskStore.connect();
  @Local private chat: ChatStore = ChatStore.connect();
  /** Expands「最近会话」past `RECENT_VISIBLE`; collapses again on any switch. */
  @Local private showAll: boolean = false;
  /**
   * The session key whose delete control is armed — `''` for none. Two-tap
   * delete: the first tap arms, a second tap on the SAME row deletes (the
   * rule itself is `SessionRow.applyDeleteTap`).
   *
   * It must go back to `''` whenever the row it refers to could stop being
   * the row under the user's finger: switching session, switching connection,
   * and creating a session. This column is never closed (that reset is
   * `SessionSheet`'s, which is a modal), so those three are the complete set
   * here. Miss one and a stray second tap deletes a session the user never
   * armed.
   */
  @Local private confirmDeleteKey: string = '';

  private resetPanelState(): void {
    this.confirmDeleteKey = '';
    this.showAll = false;
  }

  // -------------------------------------------------------------------
  // Data accessors. Each one reads `@Trace` store state (or `@Local` panel
  // state) and is called from `build()`, which is what registers this
  // component as a render-dependency observer — no `@Monitor`, no polling.
  // They stay one-line forwards to `SessionRow.ets`; the rules they forward
  // to are shared with `SessionSheet`.
  // -------------------------------------------------------------------

  private connectionId(): string {
    return this.session.activeConnectionId();
  }

  private activeKey(): string {
    return this.session.activeSessionKeyOf(this.connectionId());
  }

  private allSessions(): Session[] {
    return this.session.sessionsOf(this.connectionId());
  }

  private listSessions(): Session[] {
    return nonResidentSessions(this.allSessions());
  }

  private recentSessions(): Session[] {
    return visibleSessions(this.allSessions(), this.activeKey(), this.showAll);
  }

  private inactiveCount(): number {
    return visibleSessions(this.allSessions(), this.activeKey(), true).length;
  }

  private hiddenCount(): number {
    return hiddenSessionCount(this.allSessions(), this.activeKey());
  }

  /**
   * 0-or-1 element lists, fed to `ForEach`: `build()` cannot declare the
   * local variable a `Session | undefined` check would need (ArkUI forbids
   * statements before/inside the UI expression), so "render this row only if
   * it exists" is expressed as iterating an empty or single-element list.
   */
  private residentList(): Session[] {
    const resident: Session | undefined = this.session.residentSession();
    return resident === undefined ? [] : [resident];
  }

  private activeList(): Session[] {
    const active: Session | undefined = activeSessionOf(this.allSessions(), this.activeKey());
    return active === undefined ? [] : [active];
  }

  // -------------------------------------------------------------------
  // Tap handlers.
  // -------------------------------------------------------------------

  private select(session: Session): void {
    selectSession(this.session, session);
    this.resetPanelState();
  }

  private openResident(resident: Session): void {
    openResidentSession(this.session, resident);
    this.resetPanelState();
  }

  private switchConnection(bridge: BridgeInfo): void {
    if (isActiveConnection(this.session, bridge)) {
      return;
    }
    selectConnection(this.session, bridge);
    this.resetPanelState();
  }

  private onDeleteTap(sessionKey: string): void {
    this.confirmDeleteKey =
      applyDeleteTap(this.session, this.connectionId(), sessionKey, this.confirmDeleteKey);
  }

  private create(): void {
    this.resetPanelState();
    createAndSelectSession(this.session, this.connectionId());
  }

  build() {
    Column({ space: 0 }) {
      Text('会话')
        .fontSize(13)
        .fontColor(MUTED_COLOR)
        .width('100%')
        .padding({ left: 16, right: 16, top: 16, bottom: 4 })
      Scroll() {
        Column({ space: 0 }) {
          if (this.residentList().length > 0) {
            this.SectionTitle('常驻')
            ForEach(this.residentList(), (resident: Session) => {
              this.ResidentRow(resident)
            }, (resident: Session) => chatKeyForSession(resident))
            Divider().color(DIVIDER_COLOR).margin({ left: 16, right: 16, top: 4, bottom: 4 })
          }
          if (this.session.bridges.length > 1) {
            this.SectionTitle('连接')
            ForEach(this.session.bridges, (bridge: BridgeInfo) => {
              this.ConnectionRow(bridge)
            }, (bridge: BridgeInfo) => bridge.id)
            Divider().color(DIVIDER_COLOR).margin({ left: 16, right: 16, top: 4, bottom: 4 })
          }
          if (this.listSessions().length > 0) {
            if (this.activeList().length > 0) {
              this.SectionTitle('当前会话')
              ForEach(this.activeList(), (active: Session) => {
                this.ActiveRow(active)
              }, (active: Session) => chatKeyForSession(active))
            }
            if (this.inactiveCount() > 0) {
              this.SectionTitle('最近会话')
              ForEach(this.recentSessions(), (session: Session) => {
                this.RecentRow(session)
              }, (session: Session) => chatKeyForSession(session))
              if (this.hiddenCount() > 0) {
                this.MoreToggle()
              }
            }
          }
          if (this.connectionId().length > 0) {
            Divider().color(DIVIDER_COLOR).margin({ left: 16, right: 16, top: 4, bottom: 4 })
            this.CreateRow()
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width(SIDEBAR_WIDTH)
    .height('100%')
    .backgroundColor('#F7F8FA')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  SectionTitle(text: string) {
    Text(text)
      .fontSize(12)
      .fontColor(MUTED_COLOR)
      .width('100%')
      .padding({ left: 16, right: 16, top: 6, bottom: 2 })
  }

  /**
   * The resident session, pinned above everything and reachable from any
   * connection — tapping it can switch connection as well as session (see
   * `SessionRow.openResidentSession`). It gets no delete control: the server
   * refuses with 403, and offering a control that can only fail is worse than
   * not offering it.
   */
  @Builder
  ResidentRow(resident: Session) {
    Row({ space: 8 }) {
      // Phase dot only — web's resident row calls `isActivePhaseCss` with no
      // `activeAccent` argument (defaults `false`, unlike the「当前会话」row),
      // and renders neither `phaseForSession` text nor a timestamp (see
      // `SessionDropdown.tsx`'s resident block), so those two stay out here.
      Circle().width(PHASE_DOT_SIZE).height(PHASE_DOT_SIZE)
        .fill(phaseDisplayForSession(this.task, resident, false).dotColor)
      Text(rowLabel(resident))
        .fontSize(15)
        .fontColor(isCurrentSession(this.session, resident) ? ACCENT_COLOR : TEXT_COLOR)
        .fontWeight(isCurrentSession(this.session, resident) ? FontWeight.Medium : FontWeight.Normal)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (unreadForSession(this.session, resident) > 0) {
        Text(formatUnread(unreadForSession(this.session, resident)))
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor(DANGER_COLOR)
          .borderRadius(9)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor(isCurrentSession(this.session, resident) ? SELECTED_COLOR : Color.Transparent)
    .onClick(() => { this.openResident(resident); })
  }

  @Builder
  ConnectionRow(bridge: BridgeInfo) {
    Row({ space: 8 }) {
      Text(bridge.name)
        .fontSize(15)
        .fontColor(isActiveConnection(this.session, bridge) ? ACCENT_COLOR : TEXT_COLOR)
        .fontWeight(isActiveConnection(this.session, bridge) ? FontWeight.Medium : FontWeight.Normal)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      if (unreadForConnection(this.session, bridge) > 0) {
        Text(formatUnread(unreadForConnection(this.session, bridge)))
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor(DANGER_COLOR)
          .borderRadius(9)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor(isActiveConnection(this.session, bridge) ? SELECTED_COLOR : Color.Transparent)
    .onClick(() => { this.switchConnection(bridge); })
  }

  /**
   * The session already on screen: no tap target on the label (web's active
   * row isn't clickable either), and a delete control only when there is
   * another session to fall back to — matching web's
   * `listSessions.length > 1` guard.
   */
  @Builder
  ActiveRow(active: Session) {
    Row({ space: 8 }) {
      // `true`: web's active row passes `activeAccent = true` to
      // `isActivePhaseCss`, so an idle/completed phase still reads accent-blue
      // here even though the same phase would read gray on a recent row.
      Circle().width(PHASE_DOT_SIZE).height(PHASE_DOT_SIZE)
        .fill(phaseDisplayForSession(this.task, active, true).dotColor)
      Text(rowLabel(active))
        .fontSize(15)
        .fontColor(ACCENT_COLOR)
        .fontWeight(FontWeight.Medium)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      // Web hardcodes this span's color to accent (`text-accent/90`), NOT
      // `phaseCss.text` — the active row is always styled as "this is the
      // chat you're in", so its status text never turns amber/red even when
      // a recent row showing the same phase would.
      Text(phaseDisplayForSession(this.task, active, true).label)
        .fontSize(11)
        .fontColor(ACCENT_COLOR)
      if (unreadForSession(this.session, active) > 0) {
        Text(formatUnread(unreadForSession(this.session, active)))
          .fontSize(11)
          .fontColor(Color.White)
          .backgroundColor(DANGER_COLOR)
          .borderRadius(9)
          .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      }
      // Hidden only while THIS row's delete is armed — this column has no
      // hover state to hide it under, so an armed row's timestamp yields
      // instead, the same substitution `SessionSheet` makes.
      if (this.confirmDeleteKey !== active.key) {
        Text(formatTime(lastActivityOf(this.chat, active), Date.now()))
          .fontSize(11)
          .fontColor(ROW_MUTED_TEXT_COLOR)
      }
      if (this.listSessions().length > 1) {
        this.DeleteControl(active.key)
      }
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
    .backgroundColor(SELECTED_COLOR)
  }

  /**
   * An inactive session. The delete control is a SIBLING of the tappable
   * area, not a child of it: a nested tap target would leave it ambiguous
   * whether a tap on ✕ also selects the row (ArkUI click events reach the
   * parent unless hit-testing is blocked), and "arm delete" silently
   * switching session is exactly the kind of surprise two-tap delete exists
   * to avoid.
   */
  @Builder
  RecentRow(session: Session) {
    Row({ space: 8 }) {
      Row({ space: 8 }) {
        Circle().width(PHASE_DOT_SIZE).height(PHASE_DOT_SIZE)
          .fill(phaseDisplayForSession(this.task, session, false).dotColor)
        Text(rowLabel(session))
          .fontSize(15)
          .fontColor(TEXT_COLOR)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(phaseDisplayForSession(this.task, session, false).label)
          .fontSize(11)
          .fontColor(phaseDisplayForSession(this.task, session, false).textColor)
        if (unreadForSession(this.session, session) > 0) {
          Text(formatUnread(unreadForSession(this.session, session)))
            .fontSize(11)
            .fontColor(Color.White)
            .backgroundColor(DANGER_COLOR)
            .borderRadius(9)
            .padding({ left: 6, right: 6, top: 2, bottom: 2 })
        }
        // Armed rows hide the timestamp so the「确认删除」control has room —
        // this row's touch equivalent of web's hover-only reveal.
        if (this.confirmDeleteKey !== session.key) {
          Text(formatTime(lastActivityOf(this.chat, session), Date.now()))
            .fontSize(11)
            .fontColor(ROW_MUTED_TEXT_COLOR)
        }
      }
      .layoutWeight(1)
      .onClick(() => { this.select(session); })
      this.DeleteControl(session.key)
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 10, bottom: 10 })
  }

  @Builder
  DeleteControl(sessionKey: string) {
    Text(this.confirmDeleteKey === sessionKey ? '确认删除' : '✕')
      .fontSize(this.confirmDeleteKey === sessionKey ? 12 : 14)
      .fontColor(this.confirmDeleteKey === sessionKey ? Color.White : MUTED_COLOR)
      .backgroundColor(this.confirmDeleteKey === sessionKey ? DANGER_COLOR : Color.Transparent)
      .borderRadius(6)
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .onClick(() => { this.onDeleteTap(sessionKey); })
  }

  @Builder
  MoreToggle() {
    Text(this.showAll ? '收起' : `显示全部（${this.hiddenCount()}）`)
      .fontSize(13)
      .fontColor(ACCENT_COLOR)
      .width('100%')
      .padding({ left: 16, right: 16, top: 8, bottom: 8 })
      .onClick(() => { this.showAll = !this.showAll; })
  }

  @Builder
  CreateRow() {
    Text('＋ 新建会话')
      .fontSize(15)
      .fontColor(ACCENT_COLOR)
      .width('100%')
      .padding({ left: 16, right: 16, top: 10, bottom: 10 })
      .onClick(() => { this.create(); })
  }
}
