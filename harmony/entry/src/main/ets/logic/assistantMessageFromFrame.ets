import { ChatMessage } from '../model/Protocol';
import { WsFrame } from './normalizeEvent';

/**
 * Builds the `ChatMessage` for an assistant reply arriving off the wire
 * (`bridge:message`'s `content` or `bridge:stream-done`'s `fullText` —
 * exactly one of the two is populated on any real frame, so picking
 * whichever is present is safe).
 *
 * Carries the server's real `msgId`/`seq` through untouched — synthesising
 * them breaks `ChatStore.maxSeqOf()`, which Task 17's incremental history
 * backfill reads as its cursor. Falls back to a synthesised id only when the
 * server omits `msgId`, and to `seq: 0` when the server omits `seq`.
 *
 * Pure: no store access, no internal clock — `now` is the caller's
 * `Date.now()`, passed in so this tests deterministically like the rest of
 * `logic/`.
 */
export function assistantMessageFromFrame(frame: WsFrame, chatKey: string, now: number): ChatMessage {
  const parts: string[] = chatKey.split('::');
  const connectionId: string = parts[0] ?? '';
  const sessionKey: string = parts[1] ?? '';
  const content: string = frame.content ?? frame.fullText ?? '';
  const id: string = frame.msgId ?? `srv-${now}`;
  const seq: number = frame.seq ?? 0;
  return {
    id: id,
    role: 'assistant',
    content: content,
    timestamp: now,
    connectionId: connectionId,
    sessionKey: sessionKey,
    seq: seq,
  };
}
