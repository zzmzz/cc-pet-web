import { Fragment, useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { PetFull, PetMini } from "./Pet.js";
import { SessionDropdown } from "./SessionDropdown.js";

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

  if (isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col bg-surface">
        <header className={`${TOP_BAR_CLASS} sticky top-0 z-20`}>
          <PetMini />
          <div className="flex-1 min-w-0">
            <SessionDropdown />
          </div>
        </header>
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
