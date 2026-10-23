// Board sections for the assistant page. Dates are local YYYY-MM-DD strings;
// day arithmetic goes through local Date construction, never UTC conversion.

export interface AssistantItem {
  id: number; kind: "todo" | "event" | "waiting"; title: string; detail: string;
  date: string | null; time: string | null; deadline: boolean; people: string[];
  status: string; closedReason: string | null; createdAt: string; updatedAt: string;
}

export interface BoardGroups {
  today: AssistantItem[];
  overdue: { item: AssistantItem; days: number }[];
  week: { date: string; items: AssistantItem[] }[];
  farther: AssistantItem[];
  waiting: { item: AssistantItem; days: number }[];
  undated: AssistantItem[];
}

function parseDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function diffDays(later: string, earlier: string): number {
  const a = parseDate(later);
  const b = parseDate(earlier);
  // Round to absorb DST hour shifts.
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

function addDays(date: string, n: number): string {
  const d = parseDate(date);
  return formatDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

function byTimeThenId(a: AssistantItem, b: AssistantItem): number {
  if (a.time !== b.time) {
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time < b.time ? -1 : 1;
  }
  return a.id - b.id;
}

export function groupBoard(items: AssistantItem[], today: string): BoardGroups {
  const weekEnd = addDays(today, 7);
  const out: BoardGroups = { today: [], overdue: [], week: [], farther: [], waiting: [], undated: [] };
  const weekMap = new Map<string, AssistantItem[]>();

  for (const item of items) {
    if (item.kind === "waiting") {
      out.waiting.push({ item, days: Math.max(0, diffDays(today, item.createdAt)) });
      continue;
    }
    const { date } = item;
    if (date === null) {
      if (item.kind === "todo") out.undated.push(item);
    } else if (date === today) {
      out.today.push(item);
    } else if (date < today) {
      if (item.kind === "todo") out.overdue.push({ item, days: diffDays(today, date) });
    } else if (date <= weekEnd) {
      const list = weekMap.get(date) ?? [];
      list.push(item);
      weekMap.set(date, list);
    } else {
      out.farther.push(item);
    }
  }

  out.today.sort(byTimeThenId);
  out.overdue.sort((a, b) => (a.item.date! < b.item.date! ? -1 : a.item.date! > b.item.date! ? 1 : a.item.id - b.item.id));
  out.week = [...weekMap.keys()].sort().map((date) => ({ date, items: weekMap.get(date)!.sort(byTimeThenId) }));
  out.farther.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : byTimeThenId(a, b)));
  out.waiting.sort((a, b) => (a.item.createdAt < b.item.createdAt ? -1 : a.item.createdAt > b.item.createdAt ? 1 : a.item.id - b.item.id));
  out.undated.sort((a, b) => a.id - b.id);
  return out;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function weekdayLabel(date: string): string {
  const d = parseDate(date);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} 周${WEEKDAYS[d.getDay()]}`;
}
