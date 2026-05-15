import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatCard, ChatCardElement } from "@cc-pet/shared";
import { WS_EVENTS } from "@cc-pet/shared";
import { getPlatform } from "../lib/platform.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";

interface AskOption {
  /** 1-based index used by cc-connect for multi-select numeric input */
  index: number;
  label: string;
  description: string;
  /** Full askq:<qIdx>:<optIdx> value used for single-select dispatch */
  value: string;
}

interface AskQuestionData {
  questionMarkdown: string;
  multiSelect: boolean;
  options: AskOption[];
  note?: string;
}

const MULTI_SELECT_HINTS = [
  "可多选",
  "可多選",
  "multiple selections",
  "複数選択",
  "selección múltiple",
];

function isAskItem(el: ChatCardElement): el is Extract<ChatCardElement, { type: "list_item" }> {
  return el.type === "list_item" && typeof el.btnValue === "string" && el.btnValue.startsWith("askq:");
}

export function detectAskQuestion(card: ChatCard): AskQuestionData | null {
  const items = card.elements.filter(isAskItem);
  if (items.length === 0) return null;

  const markdownEl = card.elements.find((el): el is Extract<ChatCardElement, { type: "markdown" }> => el.type === "markdown");
  const noteEl = card.elements.find((el): el is Extract<ChatCardElement, { type: "note" }> => el.type === "note");

  const questionMarkdown = markdownEl?.content ?? "";
  const multiSelect = MULTI_SELECT_HINTS.some((hint) => questionMarkdown.includes(hint));

  const options: AskOption[] = items.map((el, i) => {
    const label = el.btnText ?? "";
    const text = el.text ?? "";
    // text is "Label — Description"; strip leading label if present
    let description = text;
    if (label && text.startsWith(label)) {
      description = text.slice(label.length).replace(/^\s*[—–-]\s*/, "");
    }
    return { index: i + 1, label, description, value: el.btnValue! };
  });

  return { questionMarkdown, multiSelect, options, note: noteEl?.text };
}

function dispatchMessage(content: string) {
  const connectionId = useConnectionStore.getState().activeConnectionId;
  if (!connectionId) return;
  const sessionKey = useSessionStore.getState().activeSessionKey[connectionId] ?? "default";
  getPlatform().sendWsMessage({
    type: WS_EVENTS.SEND_MESSAGE,
    connectionId,
    sessionKey,
    content,
  });
}

interface Props {
  data: AskQuestionData;
}

export function AskQuestionCard({ data }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  const summary = useMemo(() => {
    if (chosen.size === 0) return "";
    return data.options
      .filter((o) => chosen.has(o.index))
      .map((o) => o.label)
      .join(", ");
  }, [chosen, data.options]);

  const handleSingleSelect = (opt: AskOption) => {
    if (submitted) return;
    setSubmitted(true);
    setChosen(new Set([opt.index]));
    dispatchMessage(opt.value);
  };

  const handleToggle = (opt: AskOption) => {
    if (submitted) return;
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(opt.index)) next.delete(opt.index);
      else next.add(opt.index);
      return next;
    });
  };

  const handleSubmit = () => {
    if (submitted || chosen.size === 0) return;
    setSubmitted(true);
    const indices = Array.from(chosen).sort((a, b) => a - b).join(",");
    dispatchMessage(indices);
  };

  return (
    <div className="space-y-2">
      {data.questionMarkdown && (
        <div className="text-sm text-gray-800 whitespace-pre-wrap break-words markdown-body card-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.questionMarkdown.replace(/\n/g, "  \n")}</ReactMarkdown>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {data.options.map((opt) => {
          const selected = chosen.has(opt.index);
          const onClick = data.multiSelect ? () => handleToggle(opt) : () => handleSingleSelect(opt);
          return (
            <button
              key={opt.index}
              type="button"
              disabled={submitted}
              onClick={onClick}
              className={`w-full text-left flex items-start gap-2.5 rounded-lg border px-3 py-2 transition ${
                selected
                  ? "border-indigo-400 bg-indigo-50"
                  : "border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40"
              } ${submitted ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <span
                className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center border ${
                  data.multiSelect ? "rounded-sm" : "rounded-full"
                } ${selected ? "border-indigo-500 bg-indigo-500 text-white" : "border-gray-300 bg-white"}`}
              >
                {selected && (
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                    {data.multiSelect ? (
                      <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                    ) : (
                      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
                    )}
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-800 break-words">{opt.label}</span>
                {opt.description && (
                  <span className="mt-0.5 block text-xs text-gray-500 break-words">{opt.description}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {data.multiSelect && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs text-gray-500 truncate">
            {chosen.size === 0 ? "未选择" : `已选 ${chosen.size} 项：${summary}`}
          </span>
          <button
            type="button"
            disabled={submitted || chosen.size === 0}
            onClick={handleSubmit}
            className={`shrink-0 rounded px-3 py-1.5 text-sm transition ${
              submitted || chosen.size === 0
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-indigo-500 hover:bg-indigo-600 text-white"
            }`}
          >
            提交
          </button>
        </div>
      )}
      {data.note && <div className="text-xs text-gray-500 break-words">{data.note}</div>}
    </div>
  );
}
