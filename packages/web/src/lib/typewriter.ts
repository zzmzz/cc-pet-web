// Presentational typewriter reveal for assistant replies.
//
// cc-connect delivers claudecode replies as one whole block (it does not pass
// `--include-partial-messages` to the Claude CLI, so there is no token-level
// stream to forward — see cc-connect issues #1113 / #1482). To still give the
// chat a "typing" feel, we take the already-complete reply text and reveal it
// progressively into the live streaming bubble, then commit the full message.
//
// The reveal is purely visual: the final committed content is byte-for-byte the
// original text, so persistence, history, and tests observe the same result.

export interface TypewriterCallbacks {
  /** Called with the progressively-revealed prefix on each frame. */
  onFrame: (text: string) => void;
  /** Called once with the full text when the reveal finishes (or is flushed). */
  onDone: () => void;
}

export interface TypewriterOptions {
  /** Master switch; when false the text is committed instantly. */
  enabled?: boolean;
  /** Wall-clock ms per animation tick. */
  frameMs?: number;
  /** Rough ms spent revealing each character (before clamping to min/max). */
  perCharMs?: number;
  /** Lower/upper bounds on total reveal duration. */
  minTotalMs?: number;
  maxTotalMs?: number;
}

const DEFAULTS: Required<Omit<TypewriterOptions, "enabled">> = {
  frameMs: 16,
  perCharMs: 7,
  minTotalMs: 120,
  maxTotalMs: 480,
};

interface Controller {
  fullText: string;
  onFrame: (text: string) => void;
  onDone: () => void;
  timer: ReturnType<typeof setInterval> | null;
  finished: boolean;
}

const controllers = new Map<string, Controller>();

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

function finish(key: string, ctrl: Controller): void {
  if (ctrl.finished) return;
  ctrl.finished = true;
  if (ctrl.timer) {
    clearInterval(ctrl.timer);
    ctrl.timer = null;
  }
  controllers.delete(key);
  ctrl.onDone();
}

/**
 * Immediately finish any in-flight reveal for `key`, showing the full text and
 * committing it. Safe to call when nothing is animating.
 */
export function flushTypewriter(key: string): void {
  const ctrl = controllers.get(key);
  if (!ctrl) return;
  ctrl.onFrame(ctrl.fullText);
  finish(key, ctrl);
}

/**
 * Reveal `fullText` progressively via `onFrame`, then `onDone`. If an animation
 * is already running for `key`, it is flushed first so replies never overlap.
 */
export function revealTypewriter(
  key: string,
  fullText: string,
  cbs: TypewriterCallbacks,
  opts: TypewriterOptions = {},
): void {
  // A newer reply supersedes any in-flight one for the same chat.
  flushTypewriter(key);

  const enabled = opts.enabled ?? true;
  const len = fullText.length;

  if (!enabled || len === 0 || prefersReducedMotion()) {
    cbs.onDone();
    return;
  }

  const { frameMs, perCharMs, minTotalMs, maxTotalMs } = { ...DEFAULTS, ...opts };
  const totalMs = Math.min(maxTotalMs, Math.max(minTotalMs, len * perCharMs));
  const frames = Math.max(1, Math.round(totalMs / frameMs));
  const stepChars = Math.max(1, Math.ceil(len / frames));

  const ctrl: Controller = {
    fullText,
    onFrame: cbs.onFrame,
    onDone: cbs.onDone,
    timer: null,
    finished: false,
  };
  controllers.set(key, ctrl);

  let shown = 0;
  ctrl.timer = setInterval(() => {
    shown = Math.min(len, shown + stepChars);
    ctrl.onFrame(fullText.slice(0, shown));
    if (shown >= len) finish(key, ctrl);
  }, frameMs);
}

/** Test helper: cancel all in-flight animations without committing. */
export function __resetTypewriter(): void {
  for (const ctrl of controllers.values()) {
    if (ctrl.timer) clearInterval(ctrl.timer);
  }
  controllers.clear();
}
