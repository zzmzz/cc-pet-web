import type { ChatMessage } from "@cc-pet/shared";
import { detectAskQuestion } from "../components/AskQuestionCard.js";

/**
 * Which reply answered each AskUserQuestion card.
 *
 * The card's own selection state lives in component state and is gone after a
 * reload, so it is re-derived from the transcript: cc-connect treats the first
 * reply after the question as its answer (option number, askq: button value or
 * free text), so that is what locks the card.
 */
export function buildAskAnswerMap(messages: ChatMessage[]): Map<string, string> {
  const answers = new Map<string, string>();
  let pendingCardId: string | null = null;

  for (const msg of messages) {
    if (msg.card) {
      pendingCardId = detectAskQuestion(msg.card) ? msg.id : pendingCardId;
      continue;
    }
    if (pendingCardId && msg.role === "user") {
      answers.set(pendingCardId, msg.content);
      pendingCardId = null;
    }
  }

  return answers;
}
