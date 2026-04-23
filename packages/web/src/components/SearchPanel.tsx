import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchStore } from "../lib/store/search.js";
import { useConnectionStore } from "../lib/store/connection.js";
import { useSessionStore } from "../lib/store/session.js";

function formatTime(ts: number): string {
  const now = new Date();
  const target = new Date(ts);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysDiff = Math.floor((todayStart - target.getTime()) / 86_400_000);
  if (daysDiff <= 0) return target.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (daysDiff === 1) return "昨天";
  if (daysDiff < 7) return `${daysDiff}天前`;
  return target.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function HighlightedSnippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(/(<<hl>>.*?<<\/hl>>)/g);
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith("<<hl>>") && part.endsWith("<</hl>>")) {
          return (
            <mark key={i} className="bg-accent/30 text-accent rounded-sm px-0.5">
              {part.slice(6, -7)}
            </mark>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}

export function SearchPanel({ variant = "panel" }: { variant?: "panel" | "mobile" }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [localQuery, setLocalQuery] = useState("");

  const { results, total, loading, isOpen, search, clearSearch, setOpen } = useSearchStore();
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const clearSessionUnread = useSessionStore((s) => s.clearSessionUnread);

  const doSearch = useCallback(
    (q: string) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void search(q, activeConnectionId ?? undefined);
      }, 300);
    },
    [search, activeConnectionId],
  );

  const handleInput = (value: string) => {
    setLocalQuery(value);
    if (!value.trim()) {
      clearSearch();
      return;
    }
    doSearch(value);
  };

  const handleClear = () => {
    setLocalQuery("");
    clearSearch();
    if (variant === "mobile") setOpen(false);
  };

  const handleResultClick = (connectionId: string | null, sessionKey: string | null) => {
    if (!connectionId || !sessionKey) return;
    setActiveSession(connectionId, sessionKey);
    clearSessionUnread(connectionId, sessionKey);
    handleClear();
  };

  useEffect(() => {
    if (isOpen && variant === "mobile" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen, variant]);

  useEffect(() => () => clearTimeout(debounceRef.current), []);

  type GroupedResults = Record<string, typeof results>;
  const grouped: GroupedResults = {};
  for (const r of results) {
    const key = `${r.connectionId ?? ""}::${r.sessionKey ?? ""}`;
    (grouped[key] ??= []).push(r);
  }

  if (variant === "mobile" && !isOpen) return null;

  return (
    <div className={variant === "mobile" ? "px-3 pb-2" : "w-full"}>
      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5">
        <svg className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={localQuery}
          onChange={(e) => handleInput(e.target.value)}
          placeholder="搜索消息..."
          className="min-w-0 flex-1 bg-transparent text-[13px] text-gray-800 placeholder-gray-500 outline-none"
        />
        {localQuery && (
          <button
            type="button"
            onClick={handleClear}
            className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-gray-500 hover:text-gray-300"
          >
            <span className="text-xs leading-none">✕</span>
          </button>
        )}
      </div>

      {localQuery.trim() && (
        <div className="mt-1.5 max-h-[60vh] overflow-y-auto rounded-xl border border-border bg-surface-tertiary/50">
          {loading && (
            <div className="px-3 py-4 text-center text-xs text-gray-500">搜索中...</div>
          )}

          {!loading && results.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-gray-500">无匹配结果</div>
          )}

          {!loading && results.length > 0 && (
            <div className="py-1">
              <div className="px-3 py-1 text-[10px] text-gray-600">
                共 {total} 条结果
              </div>
              {Object.entries(grouped).map(([groupKey, items]) => {
                const first = items[0];
                const label = first.sessionLabel || first.sessionKey || groupKey;
                return (
                  <div key={groupKey}>
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold text-gray-600 truncate">
                      {label}
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.messageId}
                        type="button"
                        onClick={() => handleResultClick(item.connectionId, item.sessionKey)}
                        className="w-full px-3 py-1.5 text-left hover:bg-surface-tertiary transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-medium leading-none ${
                              item.role === "user"
                                ? "bg-accent/15 text-accent"
                                : "bg-green-500/15 text-green-400"
                            }`}
                          >
                            {item.role === "user" ? "我" : "AI"}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] text-gray-800">
                            <HighlightedSnippet snippet={item.snippet} />
                          </span>
                          <span className="flex-shrink-0 text-[10px] text-gray-600">
                            {formatTime(item.timestamp)}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
