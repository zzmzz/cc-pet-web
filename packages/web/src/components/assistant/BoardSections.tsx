import { useState } from "react";
import {
  weekdayLabel,
  type AssistantDeliverable,
  type AssistantItem,
  type BoardGroups,
} from "../../lib/assistantBoard.js";
import { ClosedRecent } from "./ClosedRecent.js";
import { Deliverables } from "./Deliverables.js";
import { ItemRow } from "./ItemRow.js";
import { Section } from "./Section.js";
import type { DeliverableAction, ItemStatus } from "./useAssistantBoard.js";
import { WeekStrip } from "./WeekStrip.js";

type OnStatus = (id: number, status: ItemStatus) => Promise<void>;
type OnDiscuss = (item: AssistantItem) => void;

/** 「蟹哥做好的」 sits right under 今天 on both layouts. */
interface Made {
  today: string;
  deliverables: AssistantDeliverable[];
  onDeliverableStatus: (id: number, status: DeliverableAction) => Promise<void>;
}

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

export const UNDATED_FOLDED_KEY = "cc-pet-assistant-undated-folded";

function readUndatedOpen(): boolean {
  try {
    return localStorage.getItem(UNDATED_FOLDED_KEY) === "open";
  } catch {
    return false;
  }
}

/** 没定日期的待办：急的（high）一直摆着，其余收在「还有 N 件不急的」里，默认收起。标题上是总数。 */
function UndatedSection({ groups, onStatus, onDiscuss }: Common) {
  const [open, setOpen] = useState(readUndatedOpen);
  if (groups.undated.length === 0) return null;
  const urgent = groups.undated.filter((i) => i.priority === "high");
  const calm = groups.undated.filter((i) => i.priority !== "high");
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      if (next) localStorage.setItem(UNDATED_FOLDED_KEY, "open");
      else localStorage.removeItem(UNDATED_FOLDED_KEY);
    } catch {
      // Private mode and the like: the toggle still works, it just isn't remembered.
    }
  };
  return (
    <Section title="没定日期的待办" count={groups.undated.length}>
      {urgent.length > 0 && (
        <ul>
          {urgent.map((item) => (
            <ItemRow key={item.id} item={item} onStatus={onStatus} onDiscuss={onDiscuss} />
          ))}
        </ul>
      )}
      {calm.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="assistant-undated-calm"
            onClick={toggle}
            className="flex items-center gap-1 py-1 text-xs text-text-secondary hover:text-text-primary"
          >
            <span aria-hidden>{open ? "▾" : "▸"}</span>
            还有 {calm.length} 件不急的
          </button>
          <ul id="assistant-undated-calm" hidden={!open}>
            {calm.map((item) => (
              <ItemRow key={item.id} item={item} onStatus={onStatus} onDiscuss={onDiscuss} />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/**
 * 电脑上事项栏放全：今天、蟹哥做好的、接下来一周、等你回复、更远、没定日期的待办、最近结案。
 * 栏窄时接下来一周按天一行（`rows`），放大后七天并排（`columns`）。
 */
export function FullBoard({
  today,
  closed,
  deliverables,
  onDeliverableStatus,
  weekLayout = "rows",
  ...common
}: Common & Made & { closed: AssistantItem[]; weekLayout?: "columns" | "rows" }) {
  return (
    <>
      <TodaySection {...common} />
      <Deliverables deliverables={deliverables} today={today} onStatus={onDeliverableStatus} />
      <WeekStrip today={today} week={common.groups.week} onDiscuss={common.onDiscuss} layout={weekLayout} />
      <WaitingSection {...common} />
      <FartherSection {...common} />
      <UndatedSection {...common} />
      <ClosedRecent items={closed} onStatus={common.onStatus} />
    </>
  );
}

/** 手机上「今天」标签页：今天、蟹哥做好的、等你回复、没定日期的待办、最近结案。 */
export function TodaySections({
  closed,
  today,
  deliverables,
  onDeliverableStatus,
  ...common
}: Common & Made & { closed: AssistantItem[] }) {
  return (
    <>
      <TodaySection {...common} />
      <Deliverables deliverables={deliverables} today={today} onStatus={onDeliverableStatus} />
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
