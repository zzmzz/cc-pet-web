import { create } from "zustand";

const ACTIVE_CONNECTION_STORAGE_KEY = "cc-pet-active-connection-id";

function readPersistedActiveConnectionId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function persistActiveConnectionId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (id) {
      localStorage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors; state still works in memory.
  }
}

export interface ConnectionInfo {
  id: string;
  name: string;
  connected: boolean;
}

interface ConnectionState {
  connections: ConnectionInfo[];
  activeConnectionId: string | null;

  setConnections: (connections: ConnectionInfo[]) => void;
  setConnectionStatus: (id: string, connected: boolean) => void;
  setActiveConnection: (id: string | null) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  activeConnectionId: readPersistedActiveConnectionId(),

  setConnections: (connections) => set({ connections }),
  setConnectionStatus: (id, connected) =>
    set((s) => ({
      connections: s.connections.map((c) => (c.id === id ? { ...c, connected } : c)),
    })),
  setActiveConnection: (id) =>
    set(() => {
      persistActiveConnectionId(id);
      return { activeConnectionId: id };
    }),
}));
