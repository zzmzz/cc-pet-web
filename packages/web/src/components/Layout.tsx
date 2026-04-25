import { Fragment, useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { useSearchStore } from "../lib/store/search.js";
import { PetFull, PetMini } from "./Pet.js";
import { SessionDropdown } from "./SessionDropdown.js";
import { SearchPanel } from "./SearchPanel.js";

const TOP_BAR_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]";

function useLockDocumentScroll() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    html.style.overflow = "hidden";
    html.style.position = "fixed";
    html.style.width = "100%";
    html.style.height = "100%";
    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.width = "100%";
    body.style.height = "100%";

    const preventScroll = (e: Event) => {
      if (e.target === html || e.target === body) e.preventDefault();
    };
    document.addEventListener("touchmove", preventScroll, { passive: false });

    return () => {
      html.style.overflow = "";
      html.style.position = "";
      html.style.width = "";
      html.style.height = "";
      body.style.overflow = "";
      body.style.position = "";
      body.style.width = "";
      body.style.height = "";
      document.removeEventListener("touchmove", preventScroll);
    };
  }, []);
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

  useLockDocumentScroll();

  if (isMobile) {
    return (
      <div className="flex h-dvh flex-col bg-surface overflow-hidden">
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
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="shrink-0 rounded-md border border-border px-1.5 py-1 text-gray-500 hover:bg-surface hover:text-gray-300"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8.34 1.804A1 1 0 019.32 1h1.36a1 1 0 01.98.804l.295 1.473c.497.191.964.44 1.39.738l1.38-.553a1 1 0 011.187.326l.68 1.18a1 1 0 01-.208 1.283l-1.086.92c.056.329.086.666.086 1.009s-.03.68-.086 1.01l1.086.919a1 1 0 01.208 1.283l-.68 1.18a1 1 0 01-1.187.326l-1.38-.553a5.98 5.98 0 01-1.39.738l-.295 1.473a1 1 0 01-.98.804H9.32a1 1 0 01-.98-.804l-.295-1.473a5.98 5.98 0 01-1.39-.738l-1.38.553a1 1 0 01-1.187-.326l-.68-1.18a1 1 0 01.208-1.283l1.086-.92A6.07 6.07 0 014.616 10c0-.343.03-.68.086-1.01l-1.086-.919a1 1 0 01-.208-1.283l.68-1.18a1 1 0 011.187-.326l1.38.553a5.98 5.98 0 011.39-.738l.295-1.473zM10 13a3 3 0 100-6 3 3 0 000 6z"
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
