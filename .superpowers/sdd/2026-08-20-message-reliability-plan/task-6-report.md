# Task 6 Report: Queue Outgoing Messages

**Commit:** e7c03e6  
**Branch:** feat/message-reliability  
**Status:** DONE

---

## Files Changed

### `packages/web/src/lib/platform.ts`
- Added `import type { RetryPolicy } from "./store/outbox.js"` at the top.
- Changed `sendWsMessage(msg: any): void` → `sendWsMessage(msg: any, policy: RetryPolicy): string`.
- Added `flushOutbox(): void` to the interface.

### `packages/web/src/lib/web-adapter.ts`
- Added `import { useOutboxStore } from "./store/outbox.js"`.
- Added `expireStaleInterval` variable to the closure.
- **`sendWsMessage`**: Replaced the old drop-with-console-error body. `never` policy: sends immediately if OPEN, else warns and returns `""`. Other policies: enqueue into outbox via `enqueue()`, send immediately if OPEN (with `clientMsgId` merged into envelope), return the `clientMsgId`.
- **`flushOutbox`** (new): Guards on `ws?.readyState !== WebSocket.OPEN`. Calls `reviveAuto()` first (critical for the reconnect-after-outage case), then `takeSendable()` and sends each entry with `clientMsgId` merged in.
- **`socket.onopen`**: After `reconnectAttempt = 0`, calls `api.flushOutbox()` and starts the `expireStale` interval (5 000 ms). Guard inside the interval: only calls `expireStale()` if socket is OPEN.
- **`socket.onmessage`**: Before `applyIncomingWsSessionRouting`, intercepts `MESSAGE_ACK`. Reads `msg.clientMsgId` from the flat envelope (no nested `.payload` key), calls `markSent`, and returns early without forwarding to `eventHandler`.
- **`disconnectWs`**: `clearInterval(expireStaleInterval)` and sets it to `null`.

### `packages/web/src/components/ChatWindow.tsx`
- **File send path**: Moved `sendWsMessage(…, "auto")` before `addMessage`; uses the returned `clientMsgId` as the message `id` (replaces `file-${Date.now()}`).
- **Text send path**: Same reorder — `sendWsMessage(…, "auto")` first, then `addMessage` with the returned `clientMsgId` (replaces `msg-${Date.now()}`).
- **`handleStop`**: Added `"never"` as second argument.

### `packages/web/src/components/AskQuestionCard.tsx`
- `dispatchMessage`: Added `"manual"` as second argument to `sendWsMessage`.

### `packages/web/src/components/CardMessage.tsx`
- `sendCardAction`: Added `"manual"` as second argument to `sendWsMessage`.

### `packages/web/src/App.integration.test.tsx`
- `FakeAdapter.sendWsMessage`: Changed from bare `vi.fn()` to `vi.fn().mockReturnValue("fake-client-msg-id")` (so optimistic render gets a string id, not `undefined`).
- Added `flushOutbox = vi.fn()` to `FakeAdapter`.
- Updated 6 `toHaveBeenCalledWith` assertions to include the policy second argument: `"auto"` for `SEND_MESSAGE` and `SEND_FILE` user messages, `"never"` for `/stop`.

### `packages/web/src/components/Pet.test.tsx`
- `minimalPlatform.sendWsMessage`: Changed from `noop` to `vi.fn().mockReturnValue("")`.
- Added `flushOutbox: noop` to `minimalPlatform`.

### `packages/web/src/lib/web-adapter.test.ts` (new)
- 12 new tests covering:
  - `policy="never"`: sends when OPEN, drops + warns when closed, does not enqueue.
  - `policy="auto"`: enqueues + sends when OPEN (clientMsgId in envelope); enqueues without sending when closed.
  - `policy="manual"`: enqueues and sends when OPEN.
  - `MESSAGE_ACK`: calls `markSent`; does not forward to event handler.
  - `flushOutbox on reconnect`: re-sends pending entries on `onopen`; revives `failed` auto entries before sending.
  - `expireStale interval`: does NOT expire entries when socket is closed; expires entries when socket is OPEN.

---

## Test Results

**Before:** 198 tests / 18 test files passing  
**After:** 210 tests / 19 test files passing  
**New tests added:** 12 (all in `web-adapter.test.ts`)

Build typecheck (`tsconfig.build.json`): **clean** (0 errors).  
The pre-existing `tsconfig.json` error about `tests/setup.ts` not being under `rootDir` is unchanged and was present before this task.

---

## Deviations from Brief

### 1. `reviveAuto` call in `flushOutbox` (extra work vs brief, aligned with system-level context)
The brief's `flushOutbox` snippet does not call `reviveAuto`. The system-level context (the instructions above the brief) explicitly requires calling `reviveAuto()` first, before `takeSendable()`, because otherwise a message that was enqueued during a 60-second outage will have been flipped to `failed` at second 15 by `expireStale` and then silently skipped by the reconnect flush. This is the central failure the feature exists to fix. `reviveAuto` was added after the brief was written, so the brief could not mention it.

### 2. `expireStale` interval: guard added, interval not cleared on reconnect
The brief says to start a single interval. The guard (`if ws?.readyState === WebSocket.OPEN`) is added per the system-level context. The interval is started inside `onopen` with an idempotency check (`if (!expireStaleInterval)`) so multiple reconnects don't accumulate multiple intervals. It is cleared only in `disconnectWs`, matching the brief's intent.

### 3. Optimistic render order in `ChatWindow.tsx` (send before addMessage)
The brief says to call `sendWsMessage` first, then `addMessage` with the returned `clientMsgId`. This is implemented exactly as specified for both text and file paths.

---

## Things Noticed but Deliberately Left Alone

- **`Pet.test.tsx` `fetchApiRaw`**: The `minimalPlatform` object doesn't implement `fetchApiRaw`. This is a pre-existing gap; Pet tests don't exercise that method and it still compiles because TypeScript structural checking doesn't reach there through `setPlatform`. Not touched to avoid scope creep.
- **Outbox persistence across page reloads**: The outbox `loadPersisted` will restore entries on reload and the `onopen` flush will resend them. This is exactly the intended behavior, nothing to change.
- **`seq` field in `MESSAGE_ACK`**: The ack handler reads `clientMsgId` and calls `markSent`. The `seq` field is deliberately ignored — no watermark is advanced here (that's Task 7's job).
