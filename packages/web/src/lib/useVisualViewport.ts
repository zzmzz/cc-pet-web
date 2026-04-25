import { useEffect } from "react";

const KEYBOARD_THRESHOLD = 100;

function update(viewport: VisualViewport, win: Window, doc: Document) {
  const offsetTop = Math.max(0, viewport.offsetTop || 0);
  const keyboardHeight = win.innerHeight - (viewport.height + offsetTop);
  const clamped = Math.max(0, keyboardHeight);
  const vpHeight = Math.max(0, viewport.height || 0);

  const s = doc.documentElement.style;
  s.setProperty("--keyboard-inset", `${clamped}px`);
  s.setProperty("--viewport-offset-top", `${offsetTop}px`);
  s.setProperty("--visual-viewport-height", `${vpHeight}px`);

  if (clamped > KEYBOARD_THRESHOLD) {
    doc.documentElement.classList.add("keyboard-visible");
  } else {
    doc.documentElement.classList.remove("keyboard-visible");
  }
}

function clear(doc: Document) {
  const s = doc.documentElement.style;
  s.removeProperty("--keyboard-inset");
  s.removeProperty("--viewport-offset-top");
  s.removeProperty("--visual-viewport-height");
  doc.documentElement.classList.remove("keyboard-visible");
}

export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let rafId: number | null = null;
    let pollTimer: number | null = null;

    const isTextInput = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName?.toLowerCase();
      return tag === "input" || tag === "textarea" || !!el.isContentEditable;
    };

    const sync = () => update(viewport, window, document);

    const rafBurst = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      const start = performance.now();
      const tick = () => {
        sync();
        if (performance.now() - start < 1500) {
          rafId = requestAnimationFrame(tick);
        } else {
          rafId = null;
        }
      };
      rafId = requestAnimationFrame(tick);
    };

    const startPoll = () => {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => {
        if (!isTextInput()) {
          stopPoll();
          return;
        }
        sync();
      }, 250);
      sync();
    };

    const stopPoll = () => {
      if (pollTimer === null) return;
      clearInterval(pollTimer);
      pollTimer = null;
    };

    const onFocus = () => {
      if (isTextInput()) {
        rafBurst();
        startPoll();
        sync();
      } else {
        stopPoll();
      }
    };

    sync();
    onFocus();

    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", rafBurst);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);

    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", rafBurst);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
      if (rafId !== null) cancelAnimationFrame(rafId);
      stopPoll();
      clear(document);
    };
  }, []);
}
