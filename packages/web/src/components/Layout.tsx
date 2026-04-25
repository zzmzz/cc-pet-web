import { Fragment, useEffect, useRef, useState, useCallback } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { useSearchStore } from "../lib/store/search.js";
import { PetFull, PetMini } from "./Pet.js";
import { SessionDropdown } from "./SessionDropdown.js";
import { SearchPanel } from "./SearchPanel.js";

const TOP_BAR_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]";

function useIOSViewport() {
  const [style, setStyle] = useState<React.CSSProperties>({ height: "100dvh" });
  const rootRef = useRef<HTMLDivElement>(null);

  const update = useCallback(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    setStyle({
      height: `${vv.height}px`,
      transform: `translateY(${vv.offsetTop}px)`,
    });
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [update]);

  return { rootRef, style };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useUIStore((s) => s.isMobile);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setIsMobile]);

  const searchOpen = useSearchStore((s) => s.isOpen);
  const setSearchOpen = useSearchStore((s) => s.setOpen);

  const { rootRef, style: viewportStyle } = useIOSViewport();

  if (isMobile) {
    return (
      <div ref={rootRef} className="fixed inset-0 flex flex-col bg-surface" style={viewportStyle}>
        <header className={`${TOP_BAR_CLASS} shrink-0 z-20 shadow-sm`}>
          <PetMini />
          <div className="flex-1 min-w-0">
            <SessionDropdown />
          </div>
          <button
            type="button"
            onClick={() => setSearchOpen(!searchOpen)}
            className="shrink-0 rounded-md border border-border px-1.5 py-1 text-gray-500 hover:bg-surface hover:text-gray-300"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </header>
        {searchOpen && <SearchPanel variant="mobile" />}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    );
  }

  return (
    <Fragment>
      <div className="flex h-screen flex-col bg-surface">
        <header className={TOP_BAR_CLASS}>
          <PetMini />
          <div className="flex-1" />
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
            onClick={() => setSettingsOpen(true)}
          >
            设置
          </button>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
          <aside className="flex w-72 shrink-0 flex-col gap-4 border-r border-border bg-surface-secondary p-3">
            <SearchPanel />
            <SessionDropdown variant="panel" />
            <div className="flex-1 overflow-y-auto" />
          </aside>
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
      <div className="fixed left-4 bottom-4 z-30 pointer-events-auto">
        <PetFull />
      </div>
    </Fragment>
  );
}
