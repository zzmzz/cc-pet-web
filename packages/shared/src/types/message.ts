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
  card?: ChatCard;
  audio?: ChatAudio;
}

export interface ChatCard {
  header?: { title: string; color?: string };
  elements: ChatCardElement[];
}

export type ChatCardElement =
  | { type: "markdown"; content: string }
  | { type: "divider" }
  | { type: "actions"; buttons: ChatCardButton[]; layout?: "row" | "column" }
  | { type: "list_item"; text: string; btnText?: string; btnType?: string; btnValue?: string }
  | { type: "select"; placeholder?: string; options: ChatCardSelectOption[]; initValue?: string }
  | { type: "note"; text: string; tag?: string };

export interface ChatCardButton {
  text: string;
  btnType?: "primary" | "default" | "danger";
  value: string;
}

export interface ChatCardSelectOption {
  text: string;
  value: string;
}

export interface ChatAudio {
  /** base64 encoded audio data */
  data: string;
  format: string;
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
