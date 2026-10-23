import { useState } from "react";
import { weekdayLabel, type AssistantItem, type BoardGroups } from "../../lib/assistantBoard.js";
import { ClosedRecent } from "./ClosedRecent.js";
import { ItemRow } from "./ItemRow.js";
import { Section } from "./Section.js";
import type { ItemStatus } from "./useAssistantBoard.js";
import { WeekStrip } from "./WeekStrip.js";

type OnStatus = (id: number, status: ItemStatus) => Promise<void>;
type OnDiscuss = (item: AssistantItem) => void;

interface Common {
  groups: BoardGroups;
  onStatus: OnStatus;
  onDiscuss?: OnDiscuss;
}

function Empty({ text }: { text: string }) {
  return <p className="py-3 text-xs text-text-secondary">{text}</p>;
}

function TodaySection({ groups, onStatus, onDiscuss }: Common) {
  const todayCount = groups.today.length + groups.overdue.length;
  return (
    <Section title="今天" count={todayCount}>
      {todayCount === 0 ? (
        <Empty text="今天没有安排" />
      ) : (
        <ul>
          {groups.overdue.map(({ item, days }) => (
            <ItemRow key={item.id} item={item} when={item.time} note={`已过 ${days} 天`} onStatus={onStatus} onDiscuss={onDiscuss} />
          ))}
          {groups.today.map((item) => (
            <ItemRow key={item.id} item={item} when={item.time} onStatus={onStatus} onDiscuss={onDiscuss} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function WaitingSection({ groups, onStatus, onDiscuss }: Common) {
  if (groups.waiting.length === 0) return null;
  return (
    <Section title="等你回复" count={groups.waiting.length}>
      <ul>
        {groups.waiting.map(({ item, days }) => (
          <ItemRow key={item.id} item={item} note={days > 0 ? `等了 ${days} 天` : undefined} onStatus={onStatus} onDiscuss={onDiscuss} />
        ))}
      </ul>
    </Section>
  );
}

function FartherSection({ groups, onStatus, onDiscuss }: Common) {
  if (groups.farther.length === 0) return null;
  return (
    <Section title="更远" count={groups.farther.length}>
      <ul>
        {groups.farther.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            when={item.date ? weekdayLabel(item.date) : null}
            onStatus={onStatus}
            onDiscuss={onDiscuss}
          />
        ))}
      </ul>
    </Section>
  );
}

/** 没定日期的待办默认收起，标题上有件数，点一下展开。 */
function UndatedSection({ groups, onStatus, onDiscuss }: Common) {
  const [open, setOpen] = useState(false);
  if (groups.undated.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-surface-secondary px-4 py-3">
      <h2 className="text-sm font-semibold text-text-primary">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="assistant-undated"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 text-left"
        >
          <span aria-hidden className="text-text-secondary">{open ? "▾" : "▸"}</span>
          没定日期的待办
          <span className="rounded-full bg-surface px-2 text-xs font-normal text-text-secondary">
            {groups.undated.length}
          </span>
        </button>
      </h2>
      {open && (
        <ul id="assistant-undated" className="mt-1">
          {groups.undated.map((item) => (
            <ItemRow key={item.id} item={item} onStatus={onStatus} onDiscuss={onDiscuss} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 电脑上右边一栏放全：今天、接下来一周、等你回复、更远、没定日期的待办、最近结案。
 * 栏窄，接下来一周按天一行。
 */
export function FullBoard({
  today,
  closed,
  ...common
}: Common & { today: string; closed: AssistantItem[] }) {
  return (
    <>
      <TodaySection {...common} />
      <WeekStrip today={today} week={common.groups.week} onDiscuss={common.onDiscuss} layout="rows" />
      <WaitingSection {...common} />
      <FartherSection {...common} />
      <UndatedSection {...common} />
      <ClosedRecent items={closed} onStatus={common.onStatus} />
    </>
  );
}

/** 手机上「今天」标签页：今天、等你回复、没定日期的待办、最近结案。 */
export function TodaySections({ closed, ...common }: Common & { closed: AssistantItem[] }) {
  return (
    <>
      <TodaySection {...common} />
      <WaitingSection {...common} />
      <UndatedSection {...common} />
      <ClosedRecent items={closed} onStatus={common.onStatus} />
    </>
  );
}

/** 手机上「日程」标签页：接下来一周和更远。 */
export function ScheduleSections({ today, ...common }: Common & { today: string }) {
  return (
    <>
      <WeekStrip today={today} week={common.groups.week} onDiscuss={common.onDiscuss} />
      <FartherSection {...common} />
    </>
  );
}
