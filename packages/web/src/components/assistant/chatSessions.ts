import type { Session } from "@cc-pet/shared";
import { sessionBaseLabel } from "../../lib/sessionActions.js";

/** Sessions opened from a board item use this key prefix (see useItemDiscussion). */
export const ITEM_SESSION_PREFIX = "item-";
const ITEM_LABEL_PREFIX = "事项：";

export function isItemSession(s: Session): boolean {
  return s.key.startsWith(ITEM_SESSION_PREFIX);
}

/** Title for a row in 秋来's list; item sessions drop the 事项： prefix, the tag says it. */
export function chatTitle(s: Session): string {
  if (s.isResident) return "秋来 · 总台";
  const base = sessionBaseLabel(s);
  return isItemSession(s) && base.startsWith(ITEM_LABEL_PREFIX) ? base.slice(ITEM_LABEL_PREFIX.length) : base;
}
