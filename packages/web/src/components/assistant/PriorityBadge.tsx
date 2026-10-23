import type { AssistantItem } from "../../lib/assistantBoard.js";

/** 高优先级标红色「急」，低优先级标灰色「不急」，普通的不标。 */
export function PriorityBadge({ item }: { item: AssistantItem }) {
  if (item.priority === "high") {
    return (
      <span className="ml-1.5 rounded bg-red-50 px-1 text-[10px] font-medium text-red-600 align-middle">急</span>
    );
  }
  if (item.priority === "low") {
    return (
      <span className="ml-1.5 rounded bg-surface-tertiary px-1 text-[10px] font-normal text-text-secondary align-middle">
        不急
      </span>
    );
  }
  return null;
}
