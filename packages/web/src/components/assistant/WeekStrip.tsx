import { nextWeekDates, weekdayLabel, type BoardGroups } from "../../lib/assistantBoard.js";
import { Section } from "./Section.js";

export function WeekStrip({ today, week }: { today: string; week: BoardGroups["week"] }) {
  const byDate = new Map(week.map((d) => [d.date, d.items]));
  return (
    <Section title="接下来一周">
      {/* Seven columns side by side; on a phone they scroll sideways instead of squashing. */}
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 pt-2">
        {nextWeekDates(today).map((date) => {
          const items = byDate.get(date) ?? [];
          return (
            <div
              key={date}
              data-testid={`week-${date}`}
              className="min-h-24 min-w-28 flex-1 md:min-w-0 rounded-lg border border-border bg-surface p-2"
            >
              <div className="mb-1 text-xs text-text-secondary">{weekdayLabel(date)}</div>
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.id} className="rounded bg-surface-secondary px-1.5 py-1 text-xs text-text-primary">
                    {item.time && <span className="mr-1 font-medium text-primary">{item.time}</span>}
                    {item.title}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
