/** 与 cc-pet bridge `handle_message` 的 JSON 取值方式对齐（含 `data.*` 嵌套与 camelCase） */

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function bridgeNestedData(val: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(val.data);
}

/** register_ack：顶层或 data 内 ok===true（便于兼容不同 bridge 封装） */
export function registerAckOk(val: Record<string, unknown>): boolean {
  if (val.ok === true) return true;
  const data = bridgeNestedData(val);
  return data?.ok === true;
}

/** 与 Rust: reply_ctx 或 data.reply_ctx 一致，并兼容 replyCtx */
export function bridgeReplyCtx(val: Record<string, unknown>): string {
  return (
    str(val.reply_ctx) ??
    str(val.replyCtx) ??
    str(bridgeNestedData(val)?.reply_ctx) ??
    str(bridgeNestedData(val)?.replyCtx) ??
    ""
  );
}

export function bridgeSessionKey(val: Record<string, unknown>): string | undefined {
  const s =
    str(val.session_key) ??
    str(val.sessionKey) ??
    str(bridgeNestedData(val)?.session_key) ??
    str(bridgeNestedData(val)?.sessionKey);
  return s && s.length > 0 ? s : undefined;
}

/** reply 正文：顶层 content/text/message，或 data 内同名字段 */
export function bridgeReplyTextContent(val: Record<string, unknown>): string {
  const pick = (o: Record<string, unknown>) => str(o.content) ?? str(o.text) ?? str(o.message);
  return pick(val) ?? pick(bridgeNestedData(val) ?? {}) ?? "";
}

/** reply_stream.done：顶层或 data 内 */
export function bridgeReplyStreamDone(val: Record<string, unknown>): boolean {
  if (val.done === true) return true;
  if (val.done === false) return false;
  return bridgeNestedData(val)?.done === true;
}

/** reply_stream 结束时的全文：对齐 Rust 的 full_text / full / text / content，并查 data */
export function extractReplyStreamFullText(val: Record<string, unknown>): string | undefined {
  const pick = (o: Record<string, unknown>) => {
    for (const k of ["full_text", "fullText", "full", "text", "content"]) {
      const s = str(o[k]);
      if (s && s.length > 0) return s;
    }
    return undefined;
  };
  return pick(val) ?? pick(bridgeNestedData(val) ?? {});
}

/** 与 Rust `reply_stream_chunk` 对齐的增量文本 */
export function extractReplyStreamChunk(val: Record<string, unknown>): string | undefined {
  const delta = val.delta;
  if (delta !== undefined) {
    if (typeof delta === "string") return delta;
    const dObj = asRecord(delta);
    const inner = dObj ? str(dObj.content) : undefined;
    if (inner) return inner;
  }
  const chunk = str(val.chunk);
  if (chunk) return chunk;
  const data = bridgeNestedData(val);
  if (data) {
    const ds = str(data.delta);
    if (ds) return ds;
    const dc = str(data.content);
    if (dc) return dc;
    const dt = str(data.text);
    if (dt) return dt;
    const deltaObj = asRecord(data.delta);
    if (deltaObj) {
      const c = str(deltaObj.content);
      if (c) return c;
    }
  }
  return str(val.text) ?? str(val.content);
}
