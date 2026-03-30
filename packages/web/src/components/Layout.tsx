import { Fragment, useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { PetFull, PetMini } from "./Pet.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { SessionDropdown } from "./SessionDropdown.js";

const TOP_BAR_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-3 py-2";

export function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useUIStore((s) => s.isMobile);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const connectionCount = useConnectionStore((s) => s.connections.length);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setIsMobile]);

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen bg-surface">
        <header className={TOP_BAR_CLASS}>
          <PetMini />
          <div className="flex-1 min-w-0">
            {connectionCount > 1 ? <SessionDropdown /> : <ConnectionStatus />}
          </div>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    );
  }

  return (
    <Fragment>
      <div className="flex h-screen flex-col bg-surface">
        <header className={TOP_BAR_CLASS}>
          <PetMini />
        </header>
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-72 flex-col gap-4 border-r border-border bg-surface-secondary p-3">
            {connectionCount > 1 ? <SessionDropdown variant="panel" /> : <ConnectionStatus />}
            <div className="flex-1 overflow-y-auto" />
          </aside>
          <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        </div>
      </div>
      <div className="fixed left-4 bottom-4 z-30 pointer-events-auto">
        <PetFull />
      </div>
    </Fragment>
  );
}
