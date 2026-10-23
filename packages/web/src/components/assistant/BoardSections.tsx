import type { ReactNode } from "react";
import { weekdayLabel, type AssistantItem, type BoardGroups } from "../../lib/assistantBoard.js";
import { ClosedRecent } from "./ClosedRecent.js";
import { ItemRow } from "./ItemRow.js";
import { Section } from "./Section.js";
import type { ItemStatus } from "./useAssistantBoard.js";
import { WeekStrip } from "./WeekStrip.js";

type OnStatus = (id: number, status: ItemStatus) => Promise<void>;

function Empty({ text }: { text: string }) {
  return <p className="py-3 text-xs text-text-secondary">{text}</p>;
}

/**
 * 今天、等你回复、没定日期的、最近结案：手机上「今天」标签页的内容。
 * 电脑上一页放全，日程夹在「今天」后面（`afterToday`）。
 */
export function TodaySections({
  groups,
  closed,
  onStatus,
  afterToday,
}: {
  groups: BoardGroups;
  closed: AssistantItem[];
  onStatus: OnStatus;
  afterToday?: ReactNode;
}) {
  const todayCount = groups.today.length + groups.overdue.length;
  return (
    <>
      <Section title="今天" count={todayCount}>
        {todayCount === 0 ? (
          <Empty text="今天没有安排" />
        ) : (
          <ul>
            {groups.overdue.map(({ item, days }) => (
              <ItemRow key={item.id} item={item} when={item.time} note={`已过 ${days} 天`} onStatus={onStatus} />
            ))}
            {groups.today.map((item) => (
              <ItemRow key={item.id} item={item} when={item.time} onStatus={onStatus} />
            ))}
          </ul>
        )}
      </Section>
      {afterToday}
      {groups.waiting.length > 0 && (
        <Section title="等你回复" count={groups.waiting.length}>
          <ul>
            {groups.waiting.map(({ item, days }) => (
              <ItemRow key={item.id} item={item} note={days > 0 ? `等了 ${days} 天` : undefined} onStatus={onStatus} />
            ))}
          </ul>
        </Section>
      )}
      {groups.undated.length > 0 && (
        <Section title="没定日期的待办" count={groups.undated.length}>
          <ul>
            {groups.undated.map((item) => (
              <ItemRow key={item.id} item={item} onStatus={onStatus} />
            ))}
          </ul>
        </Section>
      )}
      <ClosedRecent items={closed} onStatus={onStatus} />
    </>
  );
}

/** 接下来一周和更远：手机上「日程」标签页的内容。 */
export function ScheduleSections({
  today,
  groups,
  onStatus,
}: {
  today: string;
  groups: BoardGroups;
  onStatus: OnStatus;
}) {
  return (
    <>
      <WeekStrip today={today} week={groups.week} />
      {groups.farther.length > 0 && (
        <Section title="更远" count={groups.farther.length}>
          <ul>
            {groups.farther.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                when={item.date ? weekdayLabel(item.date) : null}
                onStatus={onStatus}
              />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
