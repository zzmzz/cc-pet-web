import { useState } from "react";
import type { ChatMessage } from "@cc-pet/shared";
import { getToolCallLabel, getToolCallDetail, getToolCallFullDetail } from "../lib/tool-call.js";

interface ActivityBlockProps {
  messages: ChatMessage[];
  done: boolean;
}

export function ActivityBlock({ messages, done }: ActivityBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedDetailId, setExpandedDetailId] = useState<string | null>(null);
  const count = messages.length;

  if (!done) {
    return (
      <div className="flex justify-start px-3 py-1">
        <div className="max-w-[85%] w-full rounded-2xl rounded-bl-md border border-purple-200 bg-purple-50 px-4 py-2.5 text-[13px]">
          <div className="flex items-center gap-1.5 text-purple-600 text-xs font-medium mb-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <span>工具调用中…</span>
          </div>
          <div className="space-y-0.5">
            {messages.map((msg, i) => {
              const label = getToolCallLabel(msg.content);
              const detail = getToolCallDetail(msg.content);
              const fullDetail = getToolCallFullDetail(msg.content);
              const hasMore = fullDetail && fullDetail !== detail;
              const detailExpanded = expandedDetailId === msg.id;
              const isLast = i === count - 1;
              return (
                <div key={msg.id} className="py-0.5">
                  <button
                    type="button"
                    className={`w-full text-left flex items-center gap-1.5 text-xs rounded px-1 -mx-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
                      isLast ? "text-purple-700 font-medium" : "text-gray-400"
                    }`}
                    onClick={() => {
                      if (!hasMore) return;
                      setExpandedDetailId((prev) => (prev === msg.id ? null : msg.id));
                    }}
                    aria-expanded={hasMore ? detailExpanded : undefined}
                  >
                    <span className="w-4 text-center shrink-0">{isLast ? "" : "✓"}</span>
                    <span>{label}</span>
                    {detail && (
                      <span className={`truncate ${isLast ? "text-purple-500" : "text-gray-300"}`}>
                        — <code className="text-[11px]">{detail}</code>
                      </span>
                    )}
                    {hasMore && (
                      <span className={`text-[10px] ml-1 ${isLast ? "text-purple-400" : "text-gray-300"}`}>
                        {detailExpanded ? "▾" : "▸"}
                      </span>
                    )}
                  </button>
                  {hasMore && (
                    <pre
                      className={`mt-0.5 ml-5.5 text-[11px] leading-relaxed bg-white/60 rounded px-2 py-1 whitespace-pre-wrap break-words border border-purple-100 select-text ${
                        detailExpanded ? "block text-purple-500" : "hidden"
                      }`}
                    >
                      {fullDetail}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start px-3 py-1">
      <div className="max-w-[85%] w-full rounded-2xl rounded-bl-md border border-green-200 bg-green-50 px-4 py-2 text-[13px]">
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => {
              const next = !v;
              if (!next) setExpandedDetailId(null);
              return next;
            });
          }}
          className="w-full text-left transition-colors hover:bg-green-100 -mx-1 px-1 rounded"
        >
          <div className="flex items-center gap-1.5 text-green-700 text-xs">
            <span>✅</span>
            <span>已执行 {count} 个操作</span>
            <span className="text-green-400 text-[11px] ml-1">
              {expanded ? "▼ 收起" : "▶ 展开"}
            </span>
          </div>
        </button>
        {expanded && (
          <div className="mt-1.5 pt-1.5 border-t border-green-100 space-y-0.5">
            {messages.map((msg) => {
              const label = getToolCallLabel(msg.content);
              const detail = getToolCallDetail(msg.content);
              const fullDetail = getToolCallFullDetail(msg.content);
              const hasMore = fullDetail && fullDetail !== detail;
              const detailExpanded = expandedDetailId === msg.id;
              return (
                <div key={msg.id} className="group/step py-0.5">
                  <button
                    type="button"
                    className="w-full text-left rounded px-1 -mx-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-300"
                    onClick={() => {
                      if (!hasMore) return;
                      setExpandedDetailId((prev) => (prev === msg.id ? null : msg.id));
                    }}
                    aria-expanded={hasMore ? detailExpanded : undefined}
                  >
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="w-4 text-center shrink-0 text-gray-300">✓</span>
                      <span>{label}</span>
                      {detail && (
                        <span className="truncate text-gray-300">
                          — <code className="text-[11px]">{detail}</code>
                        </span>
                      )}
                      {hasMore && (
                        <span className="text-[10px] text-gray-400 ml-1">{detailExpanded ? "▾" : "▸"}</span>
                      )}
                    </div>
                  </button>
                  {hasMore && (
                    <pre
                      className={`mt-0.5 ml-5.5 text-[11px] leading-relaxed text-gray-400 bg-white/60 rounded px-2 py-1 whitespace-pre-wrap break-words border border-green-100 select-text ${detailExpanded ? "block" : "hidden"}`}
                    >
                      {fullDetail}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
