import { nextWeekDates, weekdayLabel, type AssistantItem, type BoardGroups } from "../../lib/assistantBoard.js";
import { PriorityBadge } from "./PriorityBadge.js";
import { Section } from "./Section.js";

function DayItem({ item, onDiscuss }: { item: AssistantItem; onDiscuss?: (item: AssistantItem) => void }) {
  return (
    <li>
      {/* Tapping a day's item opens a chat about it. */}
      <button
        type="button"
        aria-label={`讨论：${item.title}`}
        title="和蟹哥聊聊这件事"
        disabled={!onDiscuss}
        onClick={() => onDiscuss?.(item)}
        className="w-full rounded bg-surface-secondary px-1.5 py-1 text-left text-xs text-text-primary enabled:hover:bg-primary/10"
      >
        {item.time && <span className="mr-1 font-medium text-primary">{item.time}</span>}
        {item.title}
        <PriorityBadge item={item} />
      </button>
    </li>
  );
}

export function WeekStrip({
  today,
  week,
  onDiscuss,
  layout = "columns",
}: {
  today: string;
  week: BoardGroups["week"];
  onDiscuss?: (item: AssistantItem) => void;
  /** `rows`: one line per day, for a narrow column. */
  layout?: "columns" | "rows";
}) {
  const byDate = new Map(week.map((d) => [d.date, d.items]));
  if (layout === "rows") {
    return (
      <Section title="接下来一周">
        <div className="divide-y divide-border">
          {nextWeekDates(today).map((date) => {
            const items = byDate.get(date) ?? [];
            return (
              <div key={date} data-testid={`week-${date}`} className="flex gap-3 py-2">
                <div className="w-20 shrink-0 pt-1 text-xs text-text-secondary">{weekdayLabel(date)}</div>
                {items.length === 0 ? (
                  <div className="pt-1 text-xs text-text-secondary/60">—</div>
                ) : (
                  <ul className="min-w-0 flex-1 space-y-1">
                    {items.map((item) => (
                      <DayItem key={item.id} item={item} onDiscuss={onDiscuss} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    );
  }
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
                  <DayItem key={item.id} item={item} onDiscuss={onDiscuss} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
