import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { ChatWindow } from '../components/ChatWindow';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { SessionStore } from '../store/SessionStore';
import { chatKeyOf } from '../logic/normalizeEvent';
import { common } from '@kit.AbilityKit';

const DEFAULT_SESSION_KEY: string = 'default';

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

  async aboutToAppear(): Promise<void> {
    await this.auth.init(getContext(this) as common.UIAbilityContext);
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
    this.maybeBootstrapSession();
  }

  /**
   * Task 16 owns real session selection (SessionSidebar/SessionSheet over
   * SessionStore's session list). Until that lands, default to the first
   * manifest-advertised bridge's "default" session as soon as one is known,
   * so the chat window has something to show — otherwise `currentChatKey`
   * stays '' forever (nothing else in the app sets it yet) and the chat
   * looks permanently empty. A no-op once `currentChatKey` is already set,
   * so calling this more than once (see both call sites below) is safe.
   */
  private maybeBootstrapSession(): void {
    if (this.session.currentChatKey.length > 0) {
      return;
    }
    if (this.session.bridges.length === 0) {
      return;
    }
    this.session.setCurrent(chatKeyOf(this.session.bridges[0].id, DEFAULT_SESSION_KEY));
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
    this.maybeBootstrapSession();
  }

  build() {
    Column() {
      if (!this.ready) {
        Text('加载中…')
      } else if (!this.auth.authorized) {
        LoginGate()
      } else {
        ChatWindow()
      }
    }
    .width('100%')
    .height('100%')
  }
}
