import { useEffect } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { PetFull, PetMini } from "./Pet.js";
import { ConnectionStatus } from "./ConnectionStatus.js";

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
      <div className="flex flex-col h-screen bg-surface">
        <header className="flex items-center px-3 py-2 bg-surface-secondary border-b border-border gap-2">
          <PetMini />
          <div className="flex-1 min-w-0">
            <ConnectionStatus />
            <div className="text-xs text-gray-500 truncate">默认会话</div>
          </div>
          <button className="text-gray-400 text-lg" onClick={() => setSettingsOpen(true)}>⚙️</button>
        </header>
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-surface">
      <aside className="w-52 bg-surface-secondary border-r border-border flex flex-col p-3 gap-4">
        <PetFull />
        <ConnectionStatus />
        <div className="flex-1 overflow-y-auto" />
        <button className="text-gray-400 hover:text-gray-200 text-sm" onClick={() => setSettingsOpen(true)}>
          ⚙️ 设置
        </button>
      </aside>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
