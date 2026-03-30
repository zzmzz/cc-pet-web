export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  connectionId?: string;
  sessionKey?: string;
  buttons?: ButtonOption[];
  files?: FileAttachment[];
  replyCtx?: string;
  preview?: PreviewBlock;
}

export interface ButtonOption {
  id: string;
  label: string;
  value: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  url?: string;
}

export interface PreviewBlock {
  id: string;
  content: string;
}

export interface StreamDelta {
  connectionId: string;
  sessionKey: string;
  delta: string;
}

export interface StreamDone {
  connectionId: string;
  sessionKey: string;
  fullText: string;
}
