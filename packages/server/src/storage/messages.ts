import type Database from "better-sqlite3";
import type { ChatMessage } from "@cc-pet/shared";
import { makeChatKey } from "@cc-pet/shared";

/** First N chars of the first user message become the session label. Mirrors the client's AUTO_SESSION_TITLE_MAX_LEN. */
const AUTO_TITLE_MAX_LEN = 15;

function deriveAutoTitle(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > AUTO_TITLE_MAX_LEN
    ? `${trimmed.slice(0, AUTO_TITLE_MAX_LEN)}…`
    : trimmed;
}

export class MessageStore {
  private stmtInsert;
  private stmtSelect;
  private stmtDelete;
  private stmtUpsertSessionActivity;
  private stmtSetSessionLabelIfMissing;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT OR REPLACE INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtSelect = db.prepare(
      `SELECT * FROM messages WHERE chat_key = ? ORDER BY timestamp ASC`
    );
    this.stmtDelete = db.prepare(`DELETE FROM messages WHERE chat_key = ?`);
    // Update-only: bump an existing session's last_active_at so cleanup and
    // the client's "newest session" logic stay accurate. Never create a row;
    // messages without a matching sessions row remain "ghost" messages
    // filtered out by search/list (preserves existing invariants).
    this.stmtUpsertSessionActivity = db.prepare(
      `UPDATE sessions SET last_active_at = ?
       WHERE connection_id = ? AND key = ? AND last_active_at < ?`
    );
    // Set label only when missing, so user-edited labels are preserved.
    // Persisting the auto-title server-side lets the dropdown show real titles
    // without loading every session's history.
    this.stmtSetSessionLabelIfMissing = db.prepare(
      `UPDATE sessions SET label = ?
       WHERE connection_id = ? AND key = ? AND (label IS NULL OR label = '' OR label = key)`
    );
  }

  save(msg: ChatMessage): void {
    const chatKey = makeChatKey(msg.connectionId ?? "", msg.sessionKey ?? "");
    const extra = JSON.stringify({
      buttons: msg.buttons,
      files: msg.files,
      replyCtx: msg.replyCtx,
      preview: msg.preview,
      card: msg.card,
    });
    this.stmtInsert.run(msg.id, chatKey, msg.role, msg.content, msg.timestamp, msg.connectionId, msg.sessionKey, extra);
    if (msg.connectionId && msg.sessionKey) {
      this.stmtUpsertSessionActivity.run(
        msg.timestamp,
        msg.connectionId,
        msg.sessionKey,
        msg.timestamp,
      );
      if (msg.role === "user") {
        const title = deriveAutoTitle(msg.content);
        if (title) {
          this.stmtSetSessionLabelIfMissing.run(title, msg.connectionId, msg.sessionKey);
        }
      }
    }
  }

  getByChatKey(chatKey: string): ChatMessage[] {
    const rows = this.stmtSelect.all(chatKey) as any[];
    return rows.map((r) => {
      const extra = r.extra ? JSON.parse(r.extra) : {};
      return {
        id: r.id,
        role: r.role,
        content: r.content,
        timestamp: r.timestamp,
        connectionId: r.connection_id,
        sessionKey: r.session_key,
        ...extra,
      };
    });
  }

  deleteByChatKey(chatKey: string): void {
    this.stmtDelete.run(chatKey);
  }
}
