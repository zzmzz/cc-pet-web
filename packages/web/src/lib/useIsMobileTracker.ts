import { useEffect } from "react";
import { useUIStore } from "./store/ui.js";

/** Keeps `useUIStore.isMobile` in sync with the viewport (< 768px is mobile). */
export function useIsMobileTracker(): void {
  const setIsMobile = useUIStore((s) => s.setIsMobile);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();

    // Three signals for one question, deliberately. `window.resize` alone is
    // the usual way to do this and is fine in a browser, but this app also
    // runs inside a HarmonyOS WebView on a foldable, where the viewport can
    // change by ~1000px the instant the device unfolds. Whether ArkWeb fires
    // `resize` for that transition is not something we can test without the
    // hardware — and if it does not, the layout stays stuck in whichever form
    // it had before the fold, which is the single most likely way this screen
    // breaks on that device. matchMedia and visualViewport cost nothing and
    // each would catch it on their own.
    window.addEventListener("resize", check);
    // Optional-chained throughout: jsdom provides neither `matchMedia` nor
    // `visualViewport`, and an unguarded call here takes 70 unrelated tests
    // down with it.
    const mq = window.matchMedia?.("(max-width: 767px)");
    mq?.addEventListener?.("change", check);
    const vv = window.visualViewport;
    vv?.addEventListener?.("resize", check);

    return () => {
      window.removeEventListener("resize", check);
      mq?.removeEventListener?.("change", check);
      vv?.removeEventListener?.("resize", check);
    };
  }, [setIsMobile]);
}
