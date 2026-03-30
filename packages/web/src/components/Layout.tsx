import { useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { PetFull, PetMini } from "./Pet.js";
import { ConnectionStatus } from "./ConnectionStatus.js";
import { SessionDropdown } from "./SessionDropdown.js";

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
        <header className="flex items-center px-3 py-2 bg-surface-secondary border-b border-border gap-2">
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
    <div className="flex h-screen bg-surface">
      <aside className="w-52 bg-surface-secondary border-r border-border flex flex-col p-3 gap-4">
        <PetFull />
        {connectionCount > 1 ? <SessionDropdown /> : <ConnectionStatus />}
        <div className="flex-1 overflow-y-auto" />
      </aside>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
