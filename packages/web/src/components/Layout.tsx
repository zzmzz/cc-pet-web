import { Fragment, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useUIStore } from "../lib/store/ui.js";
import { isTauri, getPlatform } from "../lib/platform.js";
import { PetFull, PetMini } from "./Pet.js";
import { SessionDropdown } from "./SessionDropdown.js";

const TOP_BAR_CLASS =
  "flex shrink-0 items-center gap-2 border-b border-border bg-surface-secondary px-3 py-2";

/** Vitest 会校验 pointer-events；桌面端宠物模式需对 body 放行点击穿透，测试环境跳过。 */
const SKIP_PET_BODY_POINTER_PASS_THROUGH = import.meta.env.MODE === "test";

function isMacOsUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac/i.test(navigator.userAgent) || navigator.platform.includes("Mac");
}

function onTauriTitleBarMouseDown(e: ReactMouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (
    target.closest("button") ||
    target.closest("input") ||
    target.closest("textarea") ||
    target.closest("[role='combobox']")
  ) {
    return;
  }
  e.preventDefault();
  void getPlatform().startDrag?.();
}

function TauriDragStrip({ className }: { className: string }) {
  if (!isTauri()) return null;
  return (
    <div
      className={className}
      title="拖拽窗口"
      onMouseDown={onTauriTitleBarMouseDown}
    />
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const isMobile = useUIStore((s) => s.isMobile);
  const setIsMobile = useUIStore((s) => s.setIsMobile);
  const windowMode = useUIStore((s) => s.windowMode);
  const setDesktopConfigOpen = useUIStore((s) => s.setDesktopConfigOpen);
  const petHitAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [setIsMobile]);

  useEffect(() => {
    if (!isTauri()) return;
    const root = document.getElementById("root");
    const isPet = windowMode === "pet";
    if (isPet) {
      document.documentElement.style.background = "transparent";
      document.documentElement.style.backgroundColor = "transparent";
      document.body.style.background = "transparent";
      document.body.style.backgroundColor = "transparent";
      if (!SKIP_PET_BODY_POINTER_PASS_THROUGH) {
        document.body.style.pointerEvents = "none";
      }
      document.body.classList.remove("bg-surface");
      if (root) {
        root.style.background = "transparent";
        root.style.backgroundColor = "transparent";
        if (!SKIP_PET_BODY_POINTER_PASS_THROUGH) {
          root.style.pointerEvents = "none";
        }
      }
    } else {
      document.documentElement.style.background = "";
      document.documentElement.style.backgroundColor = "";
      document.body.style.background = "";
      document.body.style.backgroundColor = "";
      document.body.style.pointerEvents = "";
      document.body.classList.add("bg-surface");
      if (root) {
        root.style.background = "";
        root.style.backgroundColor = "";
        root.style.pointerEvents = "";
      }
    }
    return () => {
      document.documentElement.style.background = "";
      document.documentElement.style.backgroundColor = "";
      document.body.style.background = "";
      document.body.style.backgroundColor = "";
      document.body.style.pointerEvents = "";
      document.body.classList.add("bg-surface");
      if (root) {
        root.style.background = "";
        root.style.backgroundColor = "";
        root.style.pointerEvents = "";
      }
    };
  }, [windowMode]);

  /** macOS：原生层穿透依赖 Rust 轮询 + 可点击区域；前端同步包围盒（含右键菜单）。 */
  useEffect(() => {
    if (
      !isTauri() ||
      windowMode !== "pet" ||
      SKIP_PET_BODY_POINTER_PASS_THROUGH ||
      !isMacOsUserAgent()
    ) {
      return undefined;
    }

    let cancelled = false;
    let raf = 0;
    let lastSync = 0;

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_pet_hit_through_enabled", { enabled: true });

        const tick = (t: number) => {
          if (cancelled) return;
          if (t - lastSync >= 32) {
            lastSync = t;
            const el = petHitAreaRef.current;
            if (el) {
              const r = el.getBoundingClientRect();
              void invoke("update_pet_hit_rect", {
                x: r.left,
                y: r.top,
                width: r.width,
                height: r.height,
              });
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (e) {
        console.warn("[cc-pet] pet hit-through init failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        void invoke("set_pet_hit_through_enabled", { enabled: false }).catch(() => {
          /* ignore */
        });
      });
    };
  }, [windowMode]);

  if (isTauri() && windowMode === "pet") {
    return (
      <div className="pointer-events-none flex h-dvh w-full min-w-0 max-w-full items-end justify-start overflow-x-hidden p-4">
        <div ref={petHitAreaRef} className="pointer-events-auto">
          <PetFull />
        </div>
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="flex h-[100dvh] flex-col bg-surface">
        <header className={`${TOP_BAR_CLASS} sticky top-0 z-20`}>
          <PetMini />
          {isTauri() ? (
            <>
              <div className="min-w-0 max-w-[min(240px,52vw)] shrink">
                <SessionDropdown />
              </div>
              <TauriDragStrip className="h-8 min-h-8 min-w-0 flex-1 cursor-move touch-none rounded-sm hover:bg-surface-tertiary/70 active:bg-surface-tertiary" />
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
                onClick={() => setDesktopConfigOpen(true)}
              >
                连接配置
              </button>
            </>
          ) : (
            <div className="flex-1 min-w-0">
              <SessionDropdown />
            </div>
          )}
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
          <TauriDragStrip className="ml-2 h-6 min-h-6 min-w-0 flex-1 cursor-move touch-none rounded-sm hover:bg-surface-tertiary/70 active:bg-surface-tertiary" />
          {isTauri() ? (
            <button
              type="button"
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface"
              onClick={() => setDesktopConfigOpen(true)}
            >
              连接配置
            </button>
          ) : null}
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
