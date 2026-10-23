import { useCallback, useEffect, useRef, useState } from "react";
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
async function requestJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T | null }> {
  const res = await getPlatform().fetchApiRaw(path, init);
  if (!res?.ok) return { status: res?.status ?? 0, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

export function useAssistantBoard() {
  const [board, setBoard] = useState<AssistantBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const { status, body } = await requestJson<AssistantBoard>("/api/assistant/board");
      if (!mounted.current) return;
      if (body) {
        setBoard(body);
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
    (id: number, status: DeliverableAction) => post(`/api/assistant/deliverables/${id}/status`, status),
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
