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
  /** Full askq:<qIdx>:<optIdx> value used for single-select dispatch; "" for markdown-only cards */
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

/** `1. **Label** — description` — how cc-connect renders multi-select options. */
const MD_OPTION_RE = /^(\d+)\.\s+\*\*(.+?)\*\*\s*(?:[—–-]\s*(.*))?$/;

/**
 * Multi-select questions arrive as a numbered markdown list with no buttons:
 * a button click can only carry one answer, so cc-connect asks for a typed
 * "1,3" reply instead. Recover the options so we can render checkboxes.
 */
function parseMarkdownOptions(markdown: string): { question: string; options: AskOption[] } | null {
  const lines = markdown.split("\n");
  const firstOptionLine = lines.findIndex((line) => MD_OPTION_RE.test(line.trim()));
  if (firstOptionLine < 0) return null;

  const options: AskOption[] = [];
  for (const line of lines.slice(firstOptionLine)) {
    const m = MD_OPTION_RE.exec(line.trim());
    if (!m) continue;
    if (Number(m[1]) !== options.length + 1) return null; // not a clean 1..N option list
    options.push({ index: Number(m[1]), label: m[2].trim(), description: (m[3] ?? "").trim(), value: "" });
  }
  if (options.length === 0) return null;

  return { question: lines.slice(0, firstOptionLine).join("\n").trim(), options };
}

/**
 * Map a stored answer back to option indices so an already-answered card
 * renders as answered after a reload. Returns [] for free-text answers.
 */
export function parseAnswerIndices(answer: string, optionCount: number): number[] {
  const trimmed = answer.trim();
  const btn = /^askq:\d+:(\d+)$/.exec(trimmed);
  if (btn) {
    const idx = Number(btn[1]);
    return idx >= 1 && idx <= optionCount ? [idx] : [];
  }
  if (!/^\d+(\s*[,，]\s*\d+)*$/.test(trimmed)) return [];
  const indices = trimmed
    .split(/[,，]/)
    .map((part) => Number(part.trim()))
    .filter((idx) => idx >= 1 && idx <= optionCount);
  return Array.from(new Set(indices)).sort((a, b) => a - b);
}

export function detectAskQuestion(card: ChatCard): AskQuestionData | null {
  const items = card.elements.filter(isAskItem);

  const markdownEl = card.elements.find((el): el is Extract<ChatCardElement, { type: "markdown" }> => el.type === "markdown");
  const noteEl = card.elements.find((el): el is Extract<ChatCardElement, { type: "note" }> => el.type === "note");

  const questionMarkdown = markdownEl?.content ?? "";
  const multiSelect = MULTI_SELECT_HINTS.some((hint) => questionMarkdown.includes(hint));

  if (items.length === 0) {
    // Only the multi-select hint tells us a button-less card is a question card,
    // otherwise any numbered markdown list would turn into a picker.
    if (!multiSelect) return null;
    const parsed = parseMarkdownOptions(questionMarkdown);
    if (!parsed) return null;
    return { questionMarkdown: parsed.question, multiSelect: true, options: parsed.options, note: noteEl?.text };
  }

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
  useSessionStore.getState().noteStickySession(connectionId, sessionKey);
  getPlatform().sendWsMessage({
    type: WS_EVENTS.SEND_MESSAGE,
    connectionId,
    sessionKey,
    content,
  });
}

interface Props {
  data: AskQuestionData;
  /**
   * The reply that already answered this question, if any. Component state is
   * lost on reload, so the answered/locked state is derived from the message
   * history instead of being kept in memory.
   */
  answeredWith?: string;
}

export function AskQuestionCard({ data, answeredWith }: Props) {
  const [submitted, setSubmitted] = useState(false);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

  const answeredIndices = useMemo(
    () => (answeredWith ? parseAnswerIndices(answeredWith, data.options.length) : []),
    [answeredWith, data.options.length],
  );
  const locked = submitted || answeredWith !== undefined;
  const selectedIndices = useMemo(
    () => (answeredWith !== undefined && !submitted ? new Set(answeredIndices) : chosen),
    [answeredWith, submitted, answeredIndices, chosen],
  );

  const summary = useMemo(() => {
    if (selectedIndices.size === 0) return "";
    return data.options
      .filter((o) => selectedIndices.has(o.index))
      .map((o) => o.label)
      .join(", ");
  }, [selectedIndices, data.options]);

  const handleSingleSelect = (opt: AskOption) => {
    if (locked) return;
    setSubmitted(true);
    setChosen(new Set([opt.index]));
    dispatchMessage(opt.value);
  };

  const handleToggle = (opt: AskOption) => {
    if (locked) return;
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(opt.index)) next.delete(opt.index);
      else next.add(opt.index);
      return next;
    });
  };

  const handleSubmit = () => {
    if (locked || chosen.size === 0) return;
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
          const selected = selectedIndices.has(opt.index);
          const onClick = data.multiSelect ? () => handleToggle(opt) : () => handleSingleSelect(opt);
          return (
            <button
              key={opt.index}
              type="button"
              disabled={locked}
              onClick={onClick}
              className={`w-full text-left flex items-start gap-2.5 rounded-lg border px-3 py-2 transition ${
                selected
                  ? "border-indigo-400 bg-indigo-50"
                  : "border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40"
              } ${locked ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
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
      {locked ? (
        <div className="pt-1 text-xs text-gray-500 break-words">
          已回答{summary ? `：${summary}` : answeredWith ? `：${answeredWith}` : ""}
        </div>
      ) : (
        data.multiSelect && (
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-gray-500 truncate">
              {chosen.size === 0 ? "未选择" : `已选 ${chosen.size} 项：${summary}`}
            </span>
            <button
              type="button"
              disabled={chosen.size === 0}
              onClick={handleSubmit}
              className={`shrink-0 rounded px-3 py-1.5 text-sm transition ${
                chosen.size === 0
                  ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                  : "bg-indigo-500 hover:bg-indigo-600 text-white"
              }`}
            >
              提交
            </button>
          </div>
        )
      )}
      {data.note && !locked && <div className="text-xs text-gray-500 break-words">{data.note}</div>}
    </div>
  );
}
