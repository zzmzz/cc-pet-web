import { promptAction } from '@kit.ArkUI';
import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { ChatWindow } from '../components/ChatWindow';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { PetMini } from '../components/PetMini';
import { SessionSidebar } from '../components/SessionSidebar';
import { SessionSheet } from '../components/SessionSheet';
import { ResponsiveLayout } from '../components/ResponsiveLayout';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { SessionStore } from '../store/SessionStore';
import { chatKeyForBridge } from '../components/SessionRow';
import { common } from '@kit.AbilityKit';

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;
  // `AuthStore.connect()` (AppStorageV2-backed) is required here, not a
  // bare static singleton — see AuthStore.ets for why. Holding the result
  // via @Local is what lets ArkUI V2 track this component as an observer
  // of AuthStore's @Trace fields, which in turn is what makes the
  // `@Monitor('auth.authorized')` below able to watch it.
  @Local auth: AuthStore = AuthStore.connect();
  // `@Local`, not a bare `private` field, for the same reason as `auth`
  // above — this is what lets `@Monitor('session.bridges')` below observe
  // `SessionStore`'s `@Trace bridges` field.
  @Local session: SessionStore = SessionStore.connect();
  private gatewayStarted: boolean = false;

  /** Live window width in vp, from `onAreaChange` on the root container
   * below. Drives every breakpoint decision (`ResponsiveLayout.*`) — kept
   * as plain window width, not a device-type check, so a foldable
   * unfolding mid-session or a resized PC window re-renders exactly like
   * an ordinary width change. */
  @Local windowWidth: number = 0;
  /** Two-way bound to the COMPACT band's `.bindSheet()` below. */
  @Local sessionSheetVisible: boolean = false;

  async aboutToAppear(): Promise<void> {
    const context: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
    // Read back `activeSessionKeys`/`stickySessions` before anything can
    // route an inbound frame or restore the on-screen chat — a late reply
    // arriving before this resolves is exactly the "cold start, no
    // sessionKey" misroute task-3-brief.md exists to close.
    await this.session.initPersistence(context);
    await this.auth.init(context);
    this.ready = true;
    // No poll needed here (see onAuthorizedChanged below): `auth.init()`
    // assigning `this.auth.authorized = true` above (the "already logged in
    // at launch" case) is itself a `@Trace` write the Monitor is already
    // registered to observe by this point, so it fires the same as a login
    // arriving later via LoginGate.
  }

  /**
   * Replaces a 300ms `setInterval` poll on `auth.authorized` (fix round,
   * Important-3). `auth` is `@Local`-held/`@Trace`-backed and already drives
   * `build()` reactively — polling a value the framework already tracks was
   * dead work, and cost up to 300ms of extra latency between login and the
   * gateway actually connecting. `@Monitor` is the idiomatic ArkUI V2 tool
   * for "run a side effect once when a tracked field changes": it fires
   * synchronously off the same `@Trace` write, for both routes into this
   * state (already-authorized at launch, or logging in later via
   * LoginGate) — see `aboutToAppear` above for why no separate check is
   * needed there anymore.
   */
  @Monitor('auth.authorized')
  onAuthorizedChanged(_monitor: IMonitor): void {
    if (!this.auth.authorized) {
      // Logging out has to un-latch `gatewayStarted`, or logging back in
      // never reconnects. This struct is `@Entry` — loaded once in
      // `EntryAbility.onWindowStageCreate` and NOT remounted when
      // `authorized` flips, because `LoginGate` is only a branch inside
      // this component's own `build()`. So the latch survives the logout,
      // `startGatewayOnce()` returns early on the next login, and the user
      // gets a fully-rendered chat screen over a socket that was closed by
      // `ConnectionGateway.stop()` and will never reopen. Only killing the
      // process recovered from that.
      this.gatewayStarted = false;
      return;
    }
    this.startGatewayOnce();
  }

  /**
   * Same fix, second poll: `session.bridges` used to be watched with its own
   * `setInterval`. `session.bridges` is `@Trace` too, so this is the same
   * `@Monitor` pattern as `auth.authorized` above rather than a second,
   * inconsistent mechanism in the same file.
   */
  @Monitor('session.bridges')
  onBridgesChanged(_monitor: IMonitor): void {
    this.defaultToFirstBridgeIfNoneSelected();
  }

  /**
   * Product default: as soon as the manifest lists at least one bridge and
   * nothing is selected yet, preselect that first advertised bridge's
   * 'default' session, so the chat surface isn't blank on first launch.
   * `SessionSidebar`/`SessionSheet` (Task 16) are the always-available way
   * to switch away from it afterwards. A no-op once `currentChatKey` is
   * already set, so calling this more than once (see both call sites
   * below) is safe.
   */
  private defaultToFirstBridgeIfNoneSelected(): void {
    if (this.session.currentChatKey.length > 0) {
      return;
    }
    if (this.session.bridges.length === 0) {
      return;
    }
    this.session.setCurrent(chatKeyForBridge(this.session.bridges[0]));
  }

  private startGatewayOnce(): void {
    if (this.gatewayStarted) {
      return;
    }
    this.gatewayStarted = true;
    ConnectionGateway.instance.start(this.auth.baseUrl, this.auth.token);
    // `@Monitor('session.bridges')` above only fires on a *change* it
    // observes after being registered — it cannot fire for a manifest that
    // arrived (and was already applied to `session.bridges`) before the
    // Monitor was set up. That is possible here in principle (the gateway
    // could already be running from an earlier `startGatewayOnce()` call in
    // a scenario this guard's `gatewayStarted` flag doesn't cover, or the
    // Monitor's "already watching" window could start slightly after this
    // component's own construction), so this checks synchronously,
    // immediately after kicking off the connection, instead of relying on
    // the Monitor alone to catch a change that may already have happened.
    this.defaultToFirstBridgeIfNoneSelected();
  }

  private onAreaChanged(newArea: Area): void {
    const width: number = Number(newArea.width);
    this.windowWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  }

  private openSettings(): void {
    // No settings screen exists yet — same honest-degradation toast
    // `MessageInput`'s `/settings` local command already uses.
    promptAction.showToast({ message: '设置面板尚未实现' });
  }

  build() {
    Column() {
      if (!this.ready) {
        Text('加载中…')
      } else if (!this.auth.authorized) {
        LoginGate()
      } else if (ResponsiveLayout.usesSideSessions(this.windowWidth)) {
        this.SideSessionShell()
      } else {
        this.CompactShell()
      }
    }
    .width('100%')
    .height('100%')
    .onAreaChange((_oldValue: Area, newValue: Area) => { this.onAreaChanged(newValue); })
  }

  /** MEDIUM/EXPANDED: persistent left `SessionSidebar` + chat. EXPANDED
   * additionally caps chat content at `ResponsiveLayout.contentMaxWidth`
   * (a no-op below that band) with `pageMargin` side breathing room, so a
   * wide window doesn't stretch bubbles to unreadable line lengths. */
  @Builder
  SideSessionShell() {
    Row({ space: 0 }) {
      SessionSidebar()
      Column({ space: 0 }) {
        this.TopBar(false)
        ChatWindow()
          .layoutWeight(1)
          .constraintSize({ maxWidth: ResponsiveLayout.contentMaxWidth(this.windowWidth) })
      }
      .layoutWeight(1)
      .height('100%')
      .padding({ left: ResponsiveLayout.pageMargin(this.windowWidth), right: ResponsiveLayout.pageMargin(this.windowWidth) })
    }
    .width('100%')
    .height('100%')
  }

  /** COMPACT: top bar + chat, session switcher lives behind a thumb-reachable
   * bottom sheet opened from the top bar's "会话" button. */
  @Builder
  CompactShell() {
    Column({ space: 0 }) {
      this.TopBar(true)
      ChatWindow().layoutWeight(1).width('100%')
    }
    .width('100%')
    .height('100%')
    .bindSheet($$this.sessionSheetVisible, this.SessionSheetContent(), {
      height: '50%',
      dragBar: true,
      showClose: true,
      onDisappear: () => { this.sessionSheetVisible = false; }
    })
  }

  @Builder
  SessionSheetContent() {
    SessionSheet({ onSelect: () => { this.sessionSheetVisible = false; } })
  }

  /** Shared top bar across all three bands: pet mascot, current session
   * label, connection status, settings. `showSwitcher` adds a "会话" button
   * that opens the bottom sheet — only needed in COMPACT, where the
   * session list isn't otherwise visible. */
  @Builder
  TopBar(showSwitcher: boolean) {
    Row({ space: 8 }) {
      PetMini()
      // `labelOf` owns the whole naming rule now, bridge-name fallback
      // included — this file used to carry a third copy of it alongside
      // `SessionRow.labelForBridge` and the store's own lookup.
      Text(this.session.labelOf(this.session.currentChatKey))
        .fontSize(16)
        .fontWeight(FontWeight.Medium)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .layoutWeight(1)
      ConnectionBadge()
      if (showSwitcher) {
        Button('会话')
          .fontSize(13)
          .height(28)
          .backgroundColor(Color.Transparent)
          .fontColor('#0A59F7')
          .border({ width: 1, color: '#0A59F7' })
          .onClick(() => { this.sessionSheetVisible = true; })
      }
      Button('设置')
        .fontSize(13)
        .height(28)
        .backgroundColor(Color.Transparent)
        .fontColor('#5A5F66')
        .onClick(() => { this.openSettings(); })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
  }
}
