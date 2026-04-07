export type BridgeIncoming =
  | { type: "register_ack"; ok?: boolean; error?: string; session_key?: string }
  | { type: "reply"; session_key: string; reply_ctx?: string; content: string }
  | { type: "reply_stream"; session_key: string; reply_ctx?: string; content?: string; done?: boolean; full_text?: string }
  | { type: "buttons"; session_key: string; content?: string; buttons: BridgeButton[] }
  | { type: "typing_start"; session_key: string }
  | { type: "typing_stop"; session_key: string }
  | { type: "preview_start"; session_key: string; preview_id: string; content: string }
  | { type: "update_message"; session_key: string; preview_id: string; content: string }
  | { type: "delete_message"; session_key: string; preview_id: string }
  | { type: "file"; session_key: string; name: string; data: string }
  | { type: "card"; session_key: string; reply_ctx?: string; card: BridgeCard }
  | { type: "audio"; session_key: string; reply_ctx?: string; data: string; format?: string }
  | { type: "skills_updated"; commands: SlashCommand[] }
  | { type: "error"; message: string; code?: string };

// ── Card types ──

export interface BridgeCard {
  header?: { title: string; color?: string };
  elements: BridgeCardElement[];
}

export type BridgeCardElement =
  | { type: "markdown"; content: string }
  | { type: "divider" }
  | { type: "actions"; buttons: BridgeCardButton[]; layout?: "row" | "column" }
  | { type: "list_item"; text: string; btn_text?: string; btn_type?: string; btn_value?: string }
  | { type: "select"; placeholder?: string; options: BridgeCardSelectOption[]; init_value?: string }
  | { type: "note"; text: string; tag?: string };

export interface BridgeCardButton {
  text: string;
  btn_type?: "primary" | "default" | "danger";
  value: string;
}

export interface BridgeCardSelectOption {
  text: string;
  value: string;
}

export interface BridgeButton {
  id: string;
  label: string;
}

/** Slash / skill hints from bridge `skills_updated` or UI builtins */
export type SlashCommandCategory =
  | "builtin"
  | "session"
  | "agent"
  | "dir"
  | "cron"
  | "skill"
  | "other";

export interface SlashCommand {
  /** Command token without leading `/` (e.g. `help`); bridge may send `command` instead — normalize at consumer */
  name: string;
  description: string;
  category?: SlashCommandCategory;
  /** `local` = client-only; `send` = forward as chat text to bridge */
  type?: "local" | "send";
}

export interface BridgeOutgoingFile {
  file_name: string;
  mime_type: string;
  data: string;
}

export type BridgeOutgoing =
  | {
      type: "message";
      session_key: string;
      content: string;
      msg_id?: string;
      user_id?: string;
      user_name?: string;
      reply_ctx?: string;
      files?: BridgeOutgoingFile[];
    }
  | { type: "button_response"; session_key: string; button_id: string; custom_input?: string; reply_ctx?: string }
  | { type: "file"; session_key: string; name: string; data: string };
