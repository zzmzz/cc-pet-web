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

  setPhase(phase: ConnectionPhase): void {
    this.phase = phase;
  }

  markConnectedAt(at: number): void {
    this.connectedAtMs = at;
  }

  setBridgeConnected(value: boolean): void {
    this.bridgeConnected = value;
  }
}
