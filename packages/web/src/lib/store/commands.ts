import { create } from "zustand";
import type { SlashCommand } from "@cc-pet/shared";

interface CommandState {
  /** Dynamic slash hints from bridge `skills_updated`, keyed by connection id */
  agentCommandsByConnection: Record<string, SlashCommand[]>;
  setAgentCommands: (connectionId: string, commands: SlashCommand[]) => void;
}

export const useCommandStore = create<CommandState>((set) => ({
  agentCommandsByConnection: {},

  setAgentCommands: (connectionId, commands) =>
    set((s) => ({
      agentCommandsByConnection: {
        ...s.agentCommandsByConnection,
        [connectionId]: commands,
      },
    })),
}));
