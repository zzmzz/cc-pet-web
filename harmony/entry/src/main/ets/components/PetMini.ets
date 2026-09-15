import { common } from '@kit.AbilityKit';
import { derivePetState, PetInputs } from '../logic/derivePetState';
import { PetState } from '../model/Protocol';
import { AuthStore } from '../store/AuthStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { PetImageCache } from '../gateway/PetImageCache';

/** How often `tick` bumps, purely to notice the "happy" window (see
 * `derivePetState`'s `msSinceConnected <= 3000ms`) expiring on its own —
 * nothing in the stores *changes* at that moment, `Date.now()` just moves
 * past the threshold, so no store `@Trace` write exists to react to. Same
 * idea as `MessageList`'s own poll-driven `tick` for its ack-timeout check.
 */
const TICK_MS: number = 300;
const FADE_MS: number = 200;

function builtinImageFor(state: PetState): Resource {
  if (state === 'thinking') {
    return $r('app.media.pet_thinking');
  } else if (state === 'talking') {
    return $r('app.media.pet_talking');
  } else if (state === 'happy') {
    return $r('app.media.pet_happy');
  } else if (state === 'error') {
    return $r('app.media.pet_error');
  } else {
    return $r('app.media.pet_idle');
  }
}

/**
 * The app's mascot. Pet state is *derived*, never set: every re-evaluation
 * (see `applyDerivedState` below) recomputes `derivePetState(...)` fresh
 * from the four stores' current values and compares the result to what's
 * currently displayed. There is no `setPetState`-shaped method anywhere in
 * this file, and no branch that assigns a literal `PetState` in response to
 * a specific event type — `displayedState`/`imageSrc`/`petOpacity` only ever
 * get written from that one comparison, as a cache of the derivation's own
 * output for rendering/animation purposes.
 */
@ComponentV2
export struct PetMini {
  @Local private connection: ConnectionStore = ConnectionStore.connect();
  @Local private task: TaskStore = TaskStore.connect();
  @Local private session: SessionStore = SessionStore.connect();
  @Local private auth: AuthStore = AuthStore.connect();

  @Local private tick: number = 0;
  @Local private imageSrc: ResourceStr = $r('app.media.pet_idle');
  @Local private petOpacity: number = 1;

  /** Not `@Trace` — bookkeeping for change-detection only, never rendered directly. */
  private displayedState: PetState = 'idle';
  private tickTimer: number = -1;
  private fadeTimer: number = -1;
  /** Guards against a slow `PetImageCache.uriFor()` from an earlier state
   * landing after a newer state has already taken over. */
  private requestSeq: number = 0;

  aboutToAppear(): void {
    PetImageCache.instance.init(getContext(this) as common.UIAbilityContext);
    this.tickTimer = setInterval(() => {
      this.tick += 1;
    }, TICK_MS);
    this.applyDerivedState();
  }

  aboutToDisappear(): void {
    if (this.tickTimer !== -1) {
      clearInterval(this.tickTimer);
      this.tickTimer = -1;
    }
    if (this.fadeTimer !== -1) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = -1;
    }
  }

  /**
   * Fires on every tick (see `TICK_MS` above) and on every change to the
   * three store fields that don't need a poll to be noticed promptly
   * (`bridgeConnected`/`connectedAtMs`/`currentChatKey`). `task.phaseOf(...)`
   * and `session.totalUnread()` changes are picked up by the next tick
   * instead of a dedicated Monitor path — both are backed by private `Map`
   * fields on their respective stores, and reaching into another module's
   * private field by name from a Monitor path string felt like the wrong
   * kind of coupling for a sub-300ms latency difference nobody will notice.
   */
  @Monitor('tick', 'connection.bridgeConnected', 'connection.connectedAtMs', 'session.currentChatKey')
  onInputsChanged(_monitor: IMonitor): void {
    this.applyDerivedState();
  }

  private currentInputs(): PetInputs {
    return {
      taskPhase: this.task.phaseOf(this.session.currentChatKey),
      hasUnread: this.session.totalUnread() > 0,
      bridgeConnected: this.connection.bridgeConnected,
      msSinceConnected: Date.now() - this.connection.connectedAtMs,
    };
  }

  private applyDerivedState(): void {
    const next: PetState = derivePetState(this.currentInputs());
    if (next === this.displayedState) {
      return;
    }
    this.displayedState = next;
    this.crossfadeTo(next);
  }

  /** One 200ms fade-out, image swap, 200ms fade-in — see the brief's Step 3. */
  private crossfadeTo(state: PetState): void {
    const seq: number = ++this.requestSeq;
    animateTo({ duration: FADE_MS }, () => {
      this.petOpacity = 0;
    });
    if (this.fadeTimer !== -1) {
      clearTimeout(this.fadeTimer);
    }
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = -1;
      if (seq !== this.requestSeq) {
        return;
      }
      this.imageSrc = builtinImageFor(state);
      this.loadCustomImage(state, seq);
      animateTo({ duration: FADE_MS }, () => {
        this.petOpacity = 1;
      });
    }, FADE_MS);
  }

  /** Best-effort upgrade from the bundled fallback to a per-token custom image. */
  private loadCustomImage(state: PetState, seq: number): void {
    PetImageCache.instance.uriFor(state, this.auth.baseUrl, this.auth.token)
      .then((uri: string | undefined) => {
        if (seq !== this.requestSeq || uri === undefined) {
          return;
        }
        this.imageSrc = uri;
      })
      .catch(() => {
        // uriFor itself never rejects (see PetImageCache) — this is just
        // defensive symmetry with the rest of the codebase's fire-and-forget
        // Promise handling (see MarkdownView.copyCode/openLink).
      });
  }

  build() {
    Image(this.imageSrc)
      .width(22)
      .height(22)
      .borderRadius(11)
      .clip(true)
      .objectFit(ImageFit.Cover)
      .opacity(this.petOpacity)
  }
}
