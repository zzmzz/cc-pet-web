import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPlatform } from "../../lib/platform.js";
import type { AssistantDeliverable, AssistantItem, AssistantThread } from "../../lib/assistantBoard.js";

export interface AssistantBoard {
  items: AssistantItem[];
  closedRecent: AssistantItem[];
  /** Missing from servers that predate them. */
  deliverables?: AssistantDeliverable[];
  threads?: AssistantThread[];
  plannedAt: string | null;
  generatedAt: string;
}

export type ItemStatus = "open" | "done" | "dismissed";
export type DeliverableAction = "seen" | "used" | "dismissed";

const POLL_MS = 30_000;

export const NOT_READY_MESSAGE = "蟹哥的数据还没准备好";
const LOAD_FAILED_MESSAGE = "事项没拉下来，稍后会再试";
const SAVE_FAILED_MESSAGE = "没改成，再试一次";
export const AUTH_FAILED_MESSAGE = "登录失效了，请退出后重新登录";

const isAuthFailure = (status: number) => status === 401 || status === 403;

// fetchApi resolves on any HTTP status, so go through fetchApiRaw and check it here.
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** The server always sends every list, but a proxy error page or a test stub may not: missing lists become empty. */
export function normalizeBoard(raw: unknown): AssistantBoard {
  const b = (raw && typeof raw === "object" ? raw : {}) as Partial<AssistantBoard>;
  return {
    ...b,
    items: asArray<AssistantItem>(b.items),
    closedRecent: asArray<AssistantItem>(b.closedRecent),
    deliverables: asArray<AssistantDeliverable>(b.deliverables),
    threads: asArray<AssistantThread>(b.threads),
    plannedAt: typeof b.plannedAt === "string" ? b.plannedAt : null,
    generatedAt: typeof b.generatedAt === "string" ? b.generatedAt : "",
  } as AssistantBoard;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const res = await getPlatform().fetchApiRaw(path, init);
  if (!res?.ok) return { status: res?.status ?? 0, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

export function useAssistantBoard() {
  const [rawBoard, setBoard] = useState<AssistantBoard | null>(null);
  /** 点了「不用了」的成品：服务端确认前先藏起来 */
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const board = useMemo(
    () =>
      rawBoard && rawBoard.deliverables && hidden.size > 0
        ? { ...rawBoard, deliverables: rawBoard.deliverables.filter((d) => !hidden.has(d.id)) }
        : rawBoard,
    [rawBoard, hidden],
  );

  const reload = useCallback(async () => {
    try {
      const { status, body } = await requestJson<AssistantBoard>("/api/assistant/board");
      if (!mounted.current) return;
      if (body) {
        setBoard(normalizeBoard(body));
        setError(null);
      } else {
        setError(
          isAuthFailure(status) ? AUTH_FAILED_MESSAGE : status === 503 ? NOT_READY_MESSAGE : LOAD_FAILED_MESSAGE,
        );
      }
    } catch {
      if (mounted.current) setError(LOAD_FAILED_MESSAGE);
    }
  }, []);

  /** POSTs a status change, then reloads the board; failures show the save banner. */
  const post = useCallback(
    async (path: string, status: string) => {
      try {
        const { status: code, body } = await requestJson(path, {
          method: "POST",
          body: JSON.stringify({ status }),
        });
        if (!mounted.current) return;
        if (!body) {
          setError(isAuthFailure(code) ? AUTH_FAILED_MESSAGE : SAVE_FAILED_MESSAGE);
          return;
        }
      } catch {
        if (mounted.current) setError(SAVE_FAILED_MESSAGE);
        return;
      }
      await reload();
    },
    [reload],
  );

  const setStatus = useCallback(
    (id: number, status: ItemStatus) => post(`/api/assistant/items/${id}/status`, status),
    [post],
  );

  const setDeliverableStatus = useCallback(
    async (id: number, status: DeliverableAction) => {
      if (status !== "dismissed") return post(`/api/assistant/deliverables/${id}/status`, status);
      setHidden((h) => new Set(h).add(id));
      try {
        await post(`/api/assistant/deliverables/${id}/status`, status);
      } finally {
        // 成功的话刷新后的看板已不含它；失败的话让它回来
        if (mounted.current) {
          setHidden((h) => {
            const n = new Set(h);
            n.delete(id);
            return n;
          });
        }
      }
    },
    [post],
  );

  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  return { board, error, setStatus, setDeliverableStatus, reload };
}
