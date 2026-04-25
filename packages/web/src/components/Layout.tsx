import { Fragment, useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { useSearchStore } from "../lib/store/search.js";
import { PetFull, PetMini } from "./Pet.js";
import { SessionDropdown } from "./SessionDropdown.js";
import { SearchPanel } from "./SearchPanel.js";

const TOP_BAR_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]";

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

  if (isMobile) {
    return (
      <div className="h-[100dvh] flex flex-col bg-surface">
        <header className={`${TOP_BAR_CLASS} fixed top-0 left-0 right-0 z-20 shadow-sm backdrop-blur-md bg-surface-secondary/90`}>
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
        <div className={`${TOP_BAR_CLASS} invisible shrink-0`} aria-hidden="true">
          <div className="h-5 w-5" />
          <div className="flex-1">&nbsp;</div>
          <div className="h-5 w-8" />
        </div>
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
