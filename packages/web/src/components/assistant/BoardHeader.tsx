import { PetMini } from "../Pet.js";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const STALE_MS = 2 * 3600 * 1000;

function greeting(hour: number): string {
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function logout() {
  localStorage.removeItem("cc-pet-token");
  localStorage.removeItem("cc-pet-ui");
  window.location.reload();
}

export function BoardHeader({ now, todayCount, plannedAt }: { now: Date; todayCount: number; plannedAt: string | null }) {
  const planned = plannedAt ? new Date(plannedAt) : null;
  const plannedValid = planned !== null && !Number.isNaN(planned.getTime());
  const stale = !plannedValid || now.getTime() - planned.getTime() > STALE_MS;
  const updated = plannedValid ? `事项更新于 ${hhmm(planned)}` : "事项还没整理过";

  return (
    <header className="flex items-start gap-3">
      <div className="mt-1 shrink-0">
        <PetMini />
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-xs font-semibold tracking-wide text-primary">蟹哥</h1>
        <p className="mt-0.5 text-lg font-semibold text-text-primary">{greeting(now.getHours())}</p>
        <p className="mt-0.5 text-xs text-text-secondary">
          {now.getMonth() + 1} 月 {now.getDate()} 日 周{WEEKDAYS[now.getDay()]} · 今天 {todayCount} 件事
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={`text-xs ${stale ? "text-amber-600" : "text-text-secondary"}`}>{updated}</span>
        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-border px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-secondary"
        >
          退出
        </button>
      </div>
    </header>
  );
}
