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
  private stmtSelectSeq;
  private stmtSelectAfterSeq;
  private stmtDelete;
  private stmtUpsertSessionActivity;
  private stmtSetSessionLabelIfMissing;
  private nextSeq: number;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(
      `INSERT INTO messages (id, chat_key, role, content, timestamp, connection_id, session_key, extra, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- timestamp is deliberately not updated: a resend is the same message,
       -- and stamping it with the retry time sorts it after the replies it
       -- caused (clients order by timestamp).
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         extra = excluded.extra`
    );
    this.stmtSelect = db.prepare(
      // rowid is a final tiebreaker so the order is fully determined even if a
      // future migration ever leaves two rows sharing a seq.
      `SELECT * FROM messages WHERE chat_key = ? ORDER BY seq ASC, rowid ASC`
    );
    this.stmtSelectSeq = db.prepare(`SELECT seq FROM messages WHERE id = ?`);
    this.stmtSelectAfterSeq = db.prepare(
      `SELECT * FROM messages WHERE chat_key = ? AND seq > ? ORDER BY seq ASC, rowid ASC LIMIT ?`
    );
    const maxSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages`).get() as { m: number };
    this.nextSeq = maxSeq.m + 1;
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

  /** Returns the row's seq. Prefer saveWithStatus when the caller has a side effect to dedupe. */
  save(msg: ChatMessage): number {
    return this.saveWithStatus(msg).seq;
  }

  /**
   * Upsert a message and report whether the row was newly inserted.
   *
   * `inserted: false` means the id was already in the table — the client is
   * resending a message whose ack was lost. Callers must not repeat any side
   * effect tied to the message (notably forwarding the prompt to the bridge,
   * which would re-run the whole turn), but should still ack so the client can
   * clear its outbox entry.
   */
  saveWithStatus(msg: ChatMessage): { seq: number; inserted: boolean } {
    const existing = this.stmtSelectSeq.get(msg.id) as { seq: number } | undefined;
    const chatKey = makeChatKey(msg.connectionId ?? "", msg.sessionKey ?? "");
    const extra = JSON.stringify({
      buttons: msg.buttons,
      files: msg.files,
      replyCtx: msg.replyCtx,
      preview: msg.preview,
      card: msg.card,
    });
    this.stmtInsert.run(msg.id, chatKey, msg.role, msg.content, msg.timestamp, msg.connectionId, msg.sessionKey, extra, this.nextSeq++);
    const seq = existing?.seq ?? (this.stmtSelectSeq.get(msg.id) as { seq: number }).seq;
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
    return { seq, inserted: existing === undefined };
  }

  private toChatMessage(r: any): ChatMessage {
    const extra = r.extra ? JSON.parse(r.extra) : {};
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      connectionId: r.connection_id,
      sessionKey: r.session_key,
      seq: r.seq,
      ...extra,
    };
  }

  getByChatKey(chatKey: string): ChatMessage[] {
    const rows = this.stmtSelect.all(chatKey) as any[];
    return rows.map((r) => this.toChatMessage(r));
  }

  getByChatKeyAfterSeq(
    chatKey: string,
    afterSeq: number,
    limit: number
  ): { messages: ChatMessage[]; hasMore: boolean } {
    const rows = this.stmtSelectAfterSeq.all(chatKey, afterSeq, limit + 1) as any[];
    const hasMore = rows.length > limit;
    return {
      messages: rows.slice(0, limit).map((r) => this.toChatMessage(r)),
      hasMore,
    };
  }

  deleteByChatKey(chatKey: string): void {
    this.stmtDelete.run(chatKey);
  }
}
