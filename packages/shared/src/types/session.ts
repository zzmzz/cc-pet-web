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
  | "processing"
  | "waiting_confirm"
  | "completed"
  | "failed"
  | "possibly_stuck";

export interface SessionTaskState {
  phase: TaskPhase;
  startedAt?: number;
  timeoutMs?: number;
}
