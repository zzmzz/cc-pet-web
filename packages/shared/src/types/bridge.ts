export type BridgeIncoming =
  | { type: "register_ack"; session_key: string }
  | { type: "reply"; session_key: string; reply_ctx?: string; content: string }
  | { type: "reply_stream"; session_key: string; reply_ctx?: string; content?: string; done?: boolean; full_text?: string }
  | { type: "buttons"; session_key: string; content?: string; buttons: BridgeButton[] }
  | { type: "typing_start"; session_key: string }
  | { type: "typing_stop"; session_key: string }
  | { type: "preview_start"; session_key: string; preview_id: string; content: string }
  | { type: "update_message"; session_key: string; preview_id: string; content: string }
  | { type: "delete_message"; session_key: string; preview_id: string }
  | { type: "file"; session_key: string; name: string; data: string }
  | { type: "skills_updated"; commands: SlashCommand[] }
  | { type: "error"; message: string };

export interface BridgeButton {
  id: string;
  label: string;
}

export interface SlashCommand {
  name: string;
  description: string;
}

export type BridgeOutgoing =
  | { type: "message"; session_key: string; content: string }
  | { type: "button_response"; session_key: string; button_id: string; custom_input?: string }
  | { type: "file"; session_key: string; name: string; data: string };
