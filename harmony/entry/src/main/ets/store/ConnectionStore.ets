import { AppStorageV2 } from '@kit.ArkUI';

const APP_STORAGE_KEY: string = 'ConnectionStore';

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'backoff';

/**
 * Must be obtained through `AppStorageV2.connect()` — see Global Constraints
 * in docs/superpowers/plans/2026-09-15-harmony-client.md and
 * .superpowers/sdd/2026-09-15-harmony-client/reactivity-fix-report.md for
 * why a bare `static readonly instance` does not register consumers as V2
 * observers. A `private constructor()` was not attempted here — it is known
 * to fail ArkTS compilation (see AuthStore.ets for the exact error); the
 * single-access-point rule is enforced by convention/review only.
 */
@ObservedV2
export class ConnectionStore {
  static connect(): ConnectionStore {
    const instance: ConnectionStore | undefined =
      AppStorageV2.connect(ConnectionStore, APP_STORAGE_KEY, (): ConnectionStore => new ConnectionStore());
    if (instance === undefined) {
      throw new Error('ConnectionStore.connect(): AppStorageV2.connect returned undefined');
    }
    return instance;
  }

  @Trace phase: ConnectionPhase = 'disconnected';
  @Trace connectedAtMs: number = 0;
  @Trace bridgeConnected: boolean = false;

  /**
   * The sanctioned gateway→UI signal channel.
   *
   * Gateways deliberately hold no `@Trace` state (see `ConnectionGateway`'s
   * class doc — that rule is correct and stays), which left them with no way
   * to tell the UI anything. `MessageList` worked around it with a 1 Hz
   * `setInterval` that bumped a local counter purely so its
   * `outboxEntriesOf()`/`historyErrorFlag()` reads would be re-run: a full
   * re-render of the entire transcript, every second, forever, including a
   * `parseMarkdown()` per assistant bubble — against a list Task 17 raised
   * to 200 messages per page and up to 5000.
   *
   * This counter replaces that poll. `ConnectionGateway`'s ack sweep bumps
   * it only when `Outbox.expireTimedOut()` actually turns something
   * `failed`, so the transcript re-renders exactly when a bubble's send
   * status really changed and at no other time.
   */
  @Trace outboxRevision: number = 0;

  /**
   * History-backfill failure, PER chatKey — keyed exactly like
   * `HistoryBackfill`'s in-flight set, and for the same reason. This used to
   * be one global boolean on `ConnectionGateway`, so a failure in chat A
   * raised `MessageList`'s `ErrorBanner` in chat B as well; B's retry button
   * then retried B (which had never failed), cleared the shared flag, and
   * left A silently stale with no banner and no pending retry.
   */
  @Trace private historyErrors: Map<string, boolean> = new Map<string, boolean>();

  setPhase(phase: ConnectionPhase): void {
    this.phase = phase;
  }

  markConnectedAt(at: number): void {
    this.connectedAtMs = at;
  }

  setBridgeConnected(value: boolean): void {
    this.bridgeConnected = value;
  }

  /** Called by the ack sweep only when entries actually expired. */
  bumpOutboxRevision(): void {
    this.outboxRevision += 1;
  }

  historyErrorOf(chatKey: string): boolean {
    return this.historyErrors.get(chatKey) ?? false;
  }

  setHistoryError(chatKey: string, failed: boolean): void {
    if (failed) {
      this.historyErrors.set(chatKey, true);
    } else {
      this.historyErrors.delete(chatKey);
    }
  }

  /**
   * Logout path (`ConnectionGateway.stop`): a banner raised against the
   * previous account's chat must not survive into the next one's.
   */
  clearHistoryErrors(): void {
    this.historyErrors = new Map<string, boolean>();
  }
}
