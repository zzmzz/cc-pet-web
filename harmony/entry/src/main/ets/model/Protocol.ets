export class WsEvents {
  static readonly BRIDGE_MANIFEST: string = 'bridge:manifest';
  static readonly BRIDGE_CONNECTED: string = 'bridge:connected';
  static readonly BRIDGE_ERROR: string = 'bridge:error';
  static readonly BRIDGE_MESSAGE: string = 'bridge:message';
  static readonly BRIDGE_STREAM_DELTA: string = 'bridge:stream-delta';
  static readonly BRIDGE_STREAM_DONE: string = 'bridge:stream-done';
  static readonly BRIDGE_BUTTONS: string = 'bridge:buttons';
  static readonly BRIDGE_TYPING_START: string = 'bridge:typing-start';
  static readonly BRIDGE_TYPING_STOP: string = 'bridge:typing-stop';
  static readonly BRIDGE_FILE_RECEIVED: string = 'bridge:file-received';
  static readonly BRIDGE_SKILLS_UPDATED: string = 'bridge:skills-updated';
  static readonly BRIDGE_PREVIEW_START: string = 'bridge:preview-start';
  static readonly BRIDGE_PREVIEW_UPDATE: string = 'bridge:preview-update';
  static readonly BRIDGE_PREVIEW_DELETE: string = 'bridge:preview-delete';
  static readonly BRIDGE_CARD: string = 'bridge:card';
  static readonly BRIDGE_AUDIO: string = 'bridge:audio';
  static readonly SEND_MESSAGE: string = 'send-message';
  static readonly SEND_BUTTON: string = 'send-button';
  static readonly SEND_FILE: string = 'send-file';
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  connectionId?: string;
  sessionKey?: string;
}

export interface Session {
  key: string;
  connectionId: string;
  label?: string;
  createdAt: number;
  lastActiveAt: number;
}

export type TaskPhase =
  | 'idle' | 'thinking' | 'working' | 'awaiting_confirmation'
  | 'completed' | 'failed' | 'stalled';

export type PetState = 'idle' | 'thinking' | 'talking' | 'happy' | 'error';

export type SlashCommandType = 'local' | 'send';
export type SlashCommandCategory = 'builtin' | 'session' | 'agent' | 'skill';

export interface SlashCommandSpec {
  command: string;
  description: string;
  category: SlashCommandCategory;
  type: SlashCommandType;
}
