import { create } from "zustand";
import { getPlatform } from "../platform.js";

export interface SearchResultItem {
  messageId: string;
  snippet: string;
  role: string;
  timestamp: number;
  connectionId: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
}

interface SearchState {
  query: string;
  results: SearchResultItem[];
  total: number;
  loading: boolean;
  isOpen: boolean;

  setQuery: (q: string) => void;
  search: (q: string, connectionId?: string) => Promise<void>;
  clearSearch: () => void;
  setOpen: (open: boolean) => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: "",
  results: [],
  total: 0,
  loading: false,
  isOpen: false,

  setQuery: (query) => set({ query }),

  search: async (q, connectionId) => {
    const trimmed = q.trim();
    if (!trimmed) {
      set({ results: [], total: 0, loading: false });
      return;
    }
    set({ loading: true, query: trimmed });
    try {
      const params = new URLSearchParams({ q: trimmed });
      if (connectionId) params.set("connectionId", connectionId);
      const res = await getPlatform().fetchApi<{
        results: SearchResultItem[];
        total: number;
      }>(`/api/search?${params.toString()}`);
      set({ results: res.results ?? [], total: res.total ?? 0, loading: false });
    } catch {
      set({ loading: false, results: [], total: 0 });
    }
  },

  clearSearch: () => set({ query: "", results: [], total: 0, loading: false }),

  setOpen: (isOpen) => {
    if (!isOpen) {
      set({ isOpen, query: "", results: [], total: 0 });
    } else {
      set({ isOpen });
    }
  },
}));
