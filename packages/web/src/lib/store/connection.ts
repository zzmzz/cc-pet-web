import { create } from "zustand";

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
  setActiveConnection: (id: string) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  activeConnectionId: null,

  setConnections: (connections) => set({ connections }),
  setConnectionStatus: (id, connected) =>
    set((s) => ({
      connections: s.connections.map((c) => (c.id === id ? { ...c, connected } : c)),
    })),
  setActiveConnection: (id) => set({ activeConnectionId: id }),
}));
