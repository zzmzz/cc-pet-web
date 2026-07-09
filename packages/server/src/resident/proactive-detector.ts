const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export class ProactiveDetector {
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastUserSendAt = new Map<string, number>();

  constructor(opts?: { windowMs?: number; now?: () => number }) {
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts?.now ?? (() => Date.now());
  }

  markUserSend(connectionId: string, sessionKey: string): void {
    this.lastUserSendAt.set(`${connectionId}::${sessionKey}`, this.now());
  }

  /** True when the latest turn was not preceded by a recent local user send (e.g. cron). */
  isProactive(connectionId: string, sessionKey: string): boolean {
    const last = this.lastUserSendAt.get(`${connectionId}::${sessionKey}`);
    if (last === undefined) return true;
    return this.now() - last > this.windowMs;
  }
}
