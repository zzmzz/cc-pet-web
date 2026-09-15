import { AuthStore } from '../store/AuthStore';
import { LoginGate } from '../components/LoginGate';
import { ChatWindow } from '../components/ChatWindow';
import { ConnectionGateway } from '../gateway/ConnectionGateway';
import { SessionStore } from '../store/SessionStore';
import { chatKeyOf } from '../logic/normalizeEvent';
import { common } from '@kit.AbilityKit';

const DEFAULT_SESSION_KEY: string = 'default';
const BOOTSTRAP_POLL_MS: number = 300;

@Entry
@ComponentV2
struct Index {
  @Local ready: boolean = false;
  // `AuthStore.connect()` (AppStorageV2-backed) is required here, not a
  // bare static singleton — see AuthStore.ets for why. Holding the result
  // via @Local is what lets ArkUI V2 track this component as an observer
  // of AuthStore's @Trace fields.
  @Local auth: AuthStore = AuthStore.connect();
  private session: SessionStore = SessionStore.connect();
  private gatewayStarted: boolean = false;
  private authWatchTimer: number = -1;
  private sessionBootstrapTimer: number = -1;

  async aboutToAppear(): Promise<void> {
    await this.auth.init(getContext(this) as common.UIAbilityContext);
    this.ready = true;
    // Polls rather than reacting synchronously here: this covers both
    // "already logged in at launch" (authorized is already true) and
    // "logs in a moment later via LoginGate" (authorized flips true off
    // LoginGate's own state, asynchronously) with a single code path,
    // without relying on this component's build() re-running as a place to
    // trigger a one-time side effect.
    this.authWatchTimer = setInterval(() => {
      if (!this.auth.authorized) {
        return;
      }
      clearInterval(this.authWatchTimer);
      this.authWatchTimer = -1;
      this.startGatewayOnce();
    }, BOOTSTRAP_POLL_MS);
  }

  aboutToDisappear(): void {
    if (this.authWatchTimer !== -1) {
      clearInterval(this.authWatchTimer);
      this.authWatchTimer = -1;
    }
    if (this.sessionBootstrapTimer !== -1) {
      clearInterval(this.sessionBootstrapTimer);
      this.sessionBootstrapTimer = -1;
    }
  }

  private startGatewayOnce(): void {
    if (this.gatewayStarted) {
      return;
    }
    this.gatewayStarted = true;
    ConnectionGateway.instance.start(this.auth.baseUrl, this.auth.token);
    // Task 16 owns real session selection (SessionSidebar/SessionSheet over
    // SessionStore's session list). Until that lands, default to the first
    // manifest-advertised bridge's "default" session as soon as one is
    // known, so the chat window has something to show — otherwise
    // currentChatKey stays '' forever (nothing else in the app sets it yet)
    // and the chat looks permanently empty.
    this.sessionBootstrapTimer = setInterval(() => {
      const session: SessionStore = this.session;
      if (session.currentChatKey.length > 0) {
        clearInterval(this.sessionBootstrapTimer);
        this.sessionBootstrapTimer = -1;
        return;
      }
      if (session.bridges.length > 0) {
        session.setCurrent(chatKeyOf(session.bridges[0].id, DEFAULT_SESSION_KEY));
        clearInterval(this.sessionBootstrapTimer);
        this.sessionBootstrapTimer = -1;
      }
    }, BOOTSTRAP_POLL_MS);
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
