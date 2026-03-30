export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
}

export type TaskPhase =
  | "idle"
  | "thinking"
  | "working"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "stalled"
  // legacy aliases kept for compatibility during migration
  | "processing"
  | "waiting_confirm"
  | "possibly_stuck";

export interface SessionTaskState {
  activeRequestId: string | null;
  phase: TaskPhase;
  startedAt: number | null;
  lastActivityAt: number | null;
  firstTokenAt: number | null;
  stalledReason: "first_token_timeout" | "stream_idle_timeout" | null;
}
