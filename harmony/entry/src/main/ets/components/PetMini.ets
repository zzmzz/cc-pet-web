import { common } from '@kit.AbilityKit';
import { derivePetState, HAPPY_WINDOW_MS, PetInputs } from '../logic/derivePetState';
import { PetState } from '../model/Protocol';
import { AuthStore } from '../store/AuthStore';
import { ConnectionStore } from '../store/ConnectionStore';
import { SessionStore } from '../store/SessionStore';
import { TaskStore } from '../store/TaskStore';
import { PetImageCache } from '../gateway/PetImageCache';

const FADE_MS: number = 200;
/** Slack added on top of the exact `HAPPY_WINDOW_MS` remainder before the
 * happy-window-expiry recheck fires (see `scheduleHappyExpiryIfNeeded`), so
 * `Date.now()` has unambiguously crossed the threshold by the time it runs. */
const HAPPY_EXPIRY_SLACK_MS: number = 50;

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
 *
 * No poll. `TaskStore.phaseOf(...)`/`SessionStore.totalUnread()` read
 * `@Trace private Map` fields through each store's own public method —
 * exactly how `MessageList` depends on `ChatStore`'s private `@Trace
 * messages` Map via `chat.messagesOf(...)`, with no `@Monitor` anywhere.
 * ArkUI V2 collects render dependencies automatically from whatever
 * `@Trace` state a component reads during `build()`; `private` on the
 * backing field is irrelevant since the component never touches the field
 * itself, only the store's public accessor. `@Monitor` (see `Index.ets`)
 * is the right tool for *side effects* (starting the gateway, bootstrapping
 * a session) — not for render triggers, which don't need it at all.
 */
@ComponentV2
export struct PetMini {
  @Local private connection: ConnectionStore = ConnectionStore.connect();
  @Local private task: TaskStore = TaskStore.connect();
  @Local private session: SessionStore = SessionStore.connect();
  @Local private auth: AuthStore = AuthStore.connect();

  @Local private imageSrc: ResourceStr = $r('app.media.pet_idle');
  @Local private petOpacity: number = 1;

  /** Not `@Trace` — bookkeeping for change-detection only, never rendered directly.
   * Starts `undefined`, *not* a real `PetState` literal (was `'idle'`) — `'idle'` is
   * itself a legitimate derived outcome, so seeding this field with it made the
   * first-ever `applyDerivedState()` comparison (`next === this.displayedState`)
   * spuriously succeed whenever the very first derivation happened to land on
   * `'idle'`, silently skipping `crossfadeTo`/`loadCustomImage` — the bundled
   * fallback would then stick until some *later* state change happened to pass
   * through 'idle' again. `undefined` can never equal a real `PetState`, so the
   * first comparison always mismatches and always runs the full load, regardless
   * of what the first derived state is. */
  private displayedState: PetState | undefined = undefined;
  private fadeTimer: number = -1;
  /** Guards against a slow `PetImageCache.uriFor()` from an earlier state
   * landing after a newer state has already taken over. */
  private requestSeq: number = 0;
  /** Non-`-1` while a deferred `applyDerivedState()` commit (see
   * `trackDerivedState`) is pending — at most one is ever scheduled. */
  private commitTimer: number = -1;
  /** One-shot recheck for the clock-driven "happy" window closing on its
   * own (see `scheduleHappyExpiryIfNeeded`). */
  private happyExpiryTimer: number = -1;
  /** `connection.connectedAtMs` value the pending `happyExpiryTimer`
   * targets, so re-entering `build()` during the crossfade's own animation
   * frames doesn't rearm it repeatedly. `-1` means "none pending". */
  private happyExpiryFor: number = -1;

  aboutToAppear(): void {
    PetImageCache.instance.init(getContext(this) as common.UIAbilityContext);
    this.applyDerivedState();
  }

  aboutToDisappear(): void {
    if (this.fadeTimer !== -1) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = -1;
    }
    if (this.commitTimer !== -1) {
      clearTimeout(this.commitTimer);
      this.commitTimer = -1;
    }
    if (this.happyExpiryTimer !== -1) {
      clearTimeout(this.happyExpiryTimer);
      this.happyExpiryTimer = -1;
    }
  }

  private currentInputs(): PetInputs {
    return {
      taskPhase: this.task.phaseOf(this.session.currentChatKey),
      hasUnread: this.session.totalUnread() > 0,
      bridgeConnected: this.connection.bridgeConnected,
      msSinceConnected: Date.now() - this.connection.connectedAtMs,
    };
  }

  /**
   * Called every `build()` (see `imageArg` below). Reading the four store
   * inputs via `currentInputs()` is what registers this component as a V2
   * render-dependency observer of `TaskStore.phases`/`SessionStore.unread`/
   * `ConnectionStore.bridgeConnected`/`ConnectionStore.connectedAtMs` — see
   * the class doc. This method is now a pure read-plus-decision: it reads
   * `currentInputs()` and this instance's own bookkeeping fields
   * (`displayedState`, `happyExpiryTimer`, `happyExpiryFor`, `commitTimer`)
   * and, if either is stale, arms `commitTimer` — the *only* mutation it
   * performs. Previously this also called `scheduleHappyExpiryIfNeeded`
   * directly and unconditionally, which synchronously mutated
   * `happyExpiryFor`/`happyExpiryTimer` and armed a real (non-zero-delay)
   * timer as a side effect of what should have been a pure render-dependency
   * read — moved into the deferred callback below instead, so nothing but
   * `commitTimer` itself is ever mutated while `build()` is on the call
   * stack.
   *
   * Mutating `@Local`/`@Trace` state (`displayedState`, `imageSrc`,
   * `petOpacity`) while a render is in progress is the one thing every
   * other component in this codebase (`MessageList`, `Index`) takes care to
   * avoid — mutations always happen from a callback (timer, event handler,
   * Promise) outside the render call stack. So a detected change (state
   * change, or a due happy-expiry recheck) is committed via a single
   * deferred `setTimeout(..., 0)` (`commitTimer`, deduped so at most one is
   * ever pending) rather than applied inline — a one-shot callback per
   * change, not a poll. If a commit is already pending, this returns
   * immediately without re-checking: the pending callback re-reads fresh
   * state (via a fresh `currentInputs()`/`scheduleHappyExpiryIfNeeded` call)
   * when it fires, so nothing is missed by not scheduling a second one.
   */
  private trackDerivedState(): void {
    if (this.commitTimer !== -1) {
      return;
    }
    const inputs: PetInputs = this.currentInputs();
    const next: PetState = derivePetState(inputs);
    const stateChanged: boolean = next !== this.displayedState;
    const happyExpiryDue: boolean =
      this.happyExpiryTimer === -1 || this.happyExpiryFor !== this.connection.connectedAtMs;
    if (!stateChanged && !happyExpiryDue) {
      return;
    }
    this.commitTimer = setTimeout(() => {
      this.commitTimer = -1;
      this.scheduleHappyExpiryIfNeeded(this.currentInputs().msSinceConnected);
      this.applyDerivedState();
    }, 0);
  }

  /**
   * The one `derivePetState` input that can flip purely from the clock:
   * `msSinceConnected <= HAPPY_WINDOW_MS` (the "happy" window) can expire
   * with no store `@Trace` write to react to — `Date.now()` just moves past
   * the threshold. Arms a single one-shot `setTimeout` per connection event
   * (deduped by `happyExpiryFor` against `connection.connectedAtMs`) that
   * fires once, right after the window closes, and forces a fresh
   * `applyDerivedState()` check. Not a repeating poll: at most one timer is
   * ever alive, and it disarms itself after firing.
   *
   * Only ever called from `trackDerivedState`'s deferred `commitTimer`
   * callback (a real `setTimeout` callback, i.e. off the `build()` call
   * stack) — never synchronously from `build()`/`imageArg()` itself. See
   * `trackDerivedState`'s doc for why.
   */
  private scheduleHappyExpiryIfNeeded(msSinceConnected: number): void {
    if (msSinceConnected > HAPPY_WINDOW_MS) {
      return;
    }
    if (this.happyExpiryTimer !== -1 && this.happyExpiryFor === this.connection.connectedAtMs) {
      return;
    }
    if (this.happyExpiryTimer !== -1) {
      clearTimeout(this.happyExpiryTimer);
    }
    this.happyExpiryFor = this.connection.connectedAtMs;
    const remaining: number = Math.max(0, HAPPY_WINDOW_MS - msSinceConnected) + HAPPY_EXPIRY_SLACK_MS;
    this.happyExpiryTimer = setTimeout(() => {
      this.happyExpiryTimer = -1;
      this.applyDerivedState();
    }, remaining);
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

  /** Expression form of `trackDerivedState()` so it runs as part of
   * evaluating `build()`'s root node's argument, not as a bare statement
   * before it (ArkTS's `build()` wants a single UI expression — see
   * `MessageList`'s note on the same constraint). Reading `this.imageSrc`
   * here is also itself a render-dependency read, same as before. */
  private imageArg(): ResourceStr {
    this.trackDerivedState();
    return this.imageSrc;
  }

  build() {
    Image(this.imageArg())
      .width(22)
      .height(22)
      .borderRadius(11)
      .clip(true)
      .objectFit(ImageFit.Cover)
      .opacity(this.petOpacity)
  }
}
