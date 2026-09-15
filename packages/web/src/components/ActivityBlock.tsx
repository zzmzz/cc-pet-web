import { useState } from "react";
import type { ToolStep } from "../lib/group-messages.js";
import {
  getToolCallLabel,
  getToolCallDetail,
  getToolCallFullDetail,
  parseToolResult,
} from "../lib/tool-call.js";

interface ActivityBlockProps {
  steps: ToolStep[];
  done: boolean;
}

interface StepView {
  id: string;
  label: string;
  detail: string;
  fullDetail: string;
  status: "ok" | "error" | null;
  resultBody: string;
  hasMore: boolean;
}

function buildStepView(step: ToolStep): StepView {
  const { call, result } = step;
  const label = getToolCallLabel(call.content);
  const detail = getToolCallDetail(call.content);
  const fullDetail = getToolCallFullDetail(call.content);
  const parsed = result ? parseToolResult(result.content) : null;
  const resultBody = parsed?.body ?? "";
  const hasMore = (!!fullDetail && fullDetail !== detail) || resultBody.length > 0;
  return {
    id: call.id,
    label,
    detail,
    fullDetail,
    status: parsed ? parsed.status : null,
    resultBody,
    hasMore,
  };
}

function StatusDot({ status }: { status: "ok" | "error" | null }) {
  if (status === null) return null;
  return <span className="shrink-0">{status === "error" ? "🔴" : "🟢"}</span>;
}

interface StepRowProps {
  view: StepView;
  tone: "progress-active" | "progress-past" | "done";
  expanded: boolean;
  onToggle: () => void;
}

function StepRow({ view, tone, expanded, onToggle }: StepRowProps) {
  const labelClass =
    tone === "progress-active"
      ? "text-purple-700 font-medium"
      : tone === "progress-past"
        ? "text-gray-400"
        : "text-gray-500";
  const detailClass = tone === "progress-active" ? "text-purple-500" : "text-gray-300";
  const isError = view.status === "error";
  const checkMark = tone === "progress-active" ? "" : "✓";
  const preBorder = tone === "done" ? "border-green-100" : "border-purple-100";

  return (
    <div className="py-0.5">
      <button
        type="button"
        className={`w-full text-left flex items-center gap-1.5 text-xs rounded px-1 -mx-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
          isError ? "text-red-600 font-medium" : labelClass
        }`}
        onClick={() => {
          if (view.hasMore) onToggle();
        }}
        aria-expanded={view.hasMore ? expanded : undefined}
      >
        <span className="w-4 text-center shrink-0">{checkMark}</span>
        <StatusDot status={view.status} />
        <span>{view.label}</span>
        {view.detail && (
          <span className={`truncate ${isError ? "text-red-400" : detailClass}`}>
            — <code className="text-[11px]">{view.detail}</code>
          </span>
        )}
        {view.hasMore && (
          <span className={`text-[10px] ml-1 ${isError ? "text-red-400" : detailClass}`}>
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </button>
      {view.hasMore && (
        <>
          {view.fullDetail && view.fullDetail !== view.detail && (
            <pre
              className={`mt-0.5 ml-5.5 text-[11px] leading-relaxed bg-white/60 rounded px-2 py-1 whitespace-pre-wrap break-words border ${preBorder} text-gray-500 select-text ${
                expanded ? "block" : "hidden"
              }`}
            >
              {view.fullDetail}
            </pre>
          )}
          {view.resultBody && (
            <pre
              className={`mt-0.5 ml-5.5 text-[11px] leading-relaxed rounded px-2 py-1 whitespace-pre-wrap break-words border select-text ${
                isError ? "bg-red-50 border-red-200 text-red-600" : "bg-gray-50 border-gray-200 text-gray-600"
              } ${expanded ? "block" : "hidden"}`}
            >
              {view.resultBody}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export function ActivityBlock({ steps, done }: ActivityBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  const views = steps.map(buildStepView);
  const count = views.length;
  const failures = views.filter((v) => v.status === "error").length;

  const toggleStep = (id: string) => setExpandedStepId((prev) => (prev === id ? null : id));

  if (!done) {
    return (
      <div className="flex justify-start px-3 py-1">
        <div className="max-w-[85%] w-full rounded-2xl rounded-bl-md border border-purple-200 bg-purple-50 px-4 py-2.5 text-[13px]">
          <div className="flex items-center gap-1.5 text-purple-600 text-xs font-medium mb-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-purple-500 border-t-transparent animate-spin" />
            <span>工具调用中…</span>
          </div>
          <div className="space-y-0.5">
            {views.map((view, i) => (
              <StepRow
                key={view.id}
                view={view}
                tone={i === count - 1 ? "progress-active" : "progress-past"}
                expanded={expandedStepId === view.id}
                onToggle={() => toggleStep(view.id)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const titleColor = failures > 0 ? "text-amber-700" : "text-green-700";
  const containerColor = failures > 0 ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50";
  const summary = failures > 0 ? `已执行 ${count} 个操作（${failures} 个失败）` : `已执行 ${count} 个操作`;

  return (
    <div className="flex justify-start px-3 py-1">
      <div className={`max-w-[85%] w-full rounded-2xl rounded-bl-md border px-4 py-2 text-[13px] ${containerColor}`}>
        <button
          type="button"
          onClick={() => {
            setExpanded((v) => {
              const next = !v;
              if (!next) setExpandedStepId(null);
              return next;
            });
          }}
          className="w-full text-left transition-colors hover:bg-black/[0.04] -mx-1 px-1 rounded"
        >
          <div className={`flex items-center gap-1.5 text-xs ${titleColor}`}>
            <span>{failures > 0 ? "⚠️" : "✅"}</span>
            <span>{summary}</span>
            <span className="text-[11px] ml-1 opacity-60">{expanded ? "▼ 收起" : "▶ 展开"}</span>
          </div>
        </button>
        {expanded && (
          <div className="mt-1.5 pt-1.5 border-t border-black/10 space-y-0.5">
            {views.map((view) => (
              <StepRow
                key={view.id}
                view={view}
                tone="done"
                expanded={expandedStepId === view.id}
                onToggle={() => toggleStep(view.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
