import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatCard, ChatCardElement } from "@cc-pet/shared";
import { getPlatform } from "../lib/platform.js";
import { WS_EVENTS } from "@cc-pet/shared";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";

interface Props {
  card: ChatCard;
}

const HEADER_COLORS: Record<string, string> = {
  blue: "border-blue-400 bg-blue-50 text-blue-800",
  green: "border-green-400 bg-green-50 text-green-800",
  red: "border-red-400 bg-red-50 text-red-800",
  orange: "border-orange-400 bg-orange-50 text-orange-800",
  purple: "border-purple-400 bg-purple-50 text-purple-800",
};

function sendCardAction(value: string) {
  const connectionId = useConnectionStore.getState().activeConnectionId;
  if (!connectionId) return;
  const sessionKey = useSessionStore.getState().activeSessionKey[connectionId] ?? "default";
  // card button values starting with "cmd:" are sent as chat messages
  const content = value.startsWith("cmd:") ? value.slice(4) : value;
  getPlatform().sendWsMessage({
    type: WS_EVENTS.SEND_MESSAGE,
    connectionId,
    sessionKey,
    content,
  });
}

function CardElement({ element }: { element: ChatCardElement }) {
  const [selectedValue, setSelectedValue] = useState<string | undefined>(undefined);

  switch (element.type) {
    case "markdown":
      return (
        <div className="text-sm markdown-body card-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{element.content}</ReactMarkdown>
        </div>
      );
    case "divider":
      return <hr className="border-t border-gray-200 my-2" />;
    case "actions":
      return (
        <div className={`flex gap-2 ${element.layout === "column" ? "flex-col" : "flex-wrap"}`}>
          {element.buttons.map((btn, i) => {
            const variant =
              btn.btnType === "primary"
                ? "bg-indigo-500 hover:bg-indigo-600 text-white"
                : btn.btnType === "danger"
                  ? "bg-red-500 hover:bg-red-600 text-white"
                  : "bg-gray-100 hover:bg-gray-200 text-gray-700";
            return (
              <button
                key={i}
                className={`px-3 py-1.5 rounded text-sm transition ${variant}`}
                onClick={() => sendCardAction(btn.value)}
              >
                {btn.text}
              </button>
            );
          })}
        </div>
      );
    case "list_item":
      return (
        <div className="flex items-center justify-between gap-2 py-1.5">
          <span className="text-sm text-gray-700 min-w-0 break-words">{element.text}</span>
          {element.btnText && element.btnValue && (
            <button
              className={`shrink-0 px-3 py-1 rounded text-xs transition ${
                element.btnType === "primary"
                  ? "bg-indigo-500 hover:bg-indigo-600 text-white"
                  : "bg-gray-100 hover:bg-gray-200 text-gray-700"
              }`}
              onClick={() => sendCardAction(element.btnValue!)}
            >
              {element.btnText}
            </button>
          )}
        </div>
      );
    case "select": {
      const current = selectedValue ?? element.initValue;
      return (
        <select
          className="w-full rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 outline-none focus:border-indigo-400"
          value={current ?? ""}
          onChange={(e) => {
            setSelectedValue(e.target.value);
            sendCardAction(e.target.value);
          }}
        >
          {element.placeholder && !current && (
            <option value="" disabled>
              {element.placeholder}
            </option>
          )}
          {element.options.map((opt, i) => (
            <option key={i} value={opt.value}>
              {opt.text}
            </option>
          ))}
        </select>
      );
    }
    case "note":
      return (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {element.tag && (
            <span className="bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">{element.tag}</span>
          )}
          <span>{element.text}</span>
        </div>
      );
    default:
      return null;
  }
}

export function CardMessage({ card }: Props) {
  const headerColor = card.header?.color ?? "blue";
  const headerClass = HEADER_COLORS[headerColor] ?? HEADER_COLORS.blue;

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden bg-white shadow-sm max-w-[85%]">
      {card.header && (
        <div className={`border-l-4 px-3 py-2 font-medium text-sm ${headerClass}`}>
          {card.header.title}
        </div>
      )}
      <div className="px-3 py-2 space-y-2">
        {card.elements.map((el, i) => (
          <CardElement key={i} element={el} />
        ))}
      </div>
    </div>
  );
}
