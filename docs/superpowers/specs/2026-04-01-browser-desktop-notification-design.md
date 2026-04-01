# Browser Desktop Notification Design

**Date:** 2026-04-01  
**Status:** Approved  
**Version:** 1.0

## Overview

Add browser desktop notification support to cc-pet-web. When a task completes and the user is not actively viewing that session (either viewing a different session or the browser tab is in the background), send a desktop notification with the last message content to alert the user.

## Goals

1. Notify users when tasks complete in background sessions
2. Use browser Notification API with proper permission handling
3. Integrate with existing session state management (`taskStateByConnection`)
4. Support user preferences via localStorage
5. Gracefully degrade when notifications are unsupported or denied

## Non-Goals

- Tauri desktop app notifications (native notifications handled separately)
- Sound notifications (future enhancement)
- Notification history/management UI
- Quiet hours or advanced filtering

## Architecture

### New Module: `packages/web/src/lib/notification.ts`

A standalone notification management module with no UI dependencies. Exports:

**Permission Management:**
- `checkNotificationSupport(): boolean` - Feature detection
- `requestNotificationPermission(): Promise<NotificationPermission>` - Request permission
- `getNotificationPermission(): NotificationPermission` - Get current permission

**Notification Sending:**
- `sendTaskCompletionNotification(content: string, connectionId: string, sessionKey: string): void` - Send notification

**Settings Management:**
- `NotificationSettings` interface
- `getNotificationSettings(): NotificationSettings` - Load from localStorage
- `updateNotificationSettings(settings: Partial<NotificationSettings>): void` - Save settings

**Visibility Check:**
- `shouldShowNotification(connectionId: string, sessionKey: string, isPageHidden: boolean): boolean` - Determine if notification should be shown

### Integration Point: `packages/web/src/App.tsx`

Modify the existing `useEffect` hook that manages WebSocket event handling:

1. **Initialization** - Request notification permission 3 seconds after app loads
2. **Visibility Tracking** - Add `visibilitychange` listener to track `document.hidden`
3. **Notification Trigger** - After `setTaskPhase('completed')`, check conditions and send notification

## Data Flow

### Initialization Flow

```
App mounts
  → Check notification support
  → If supported, wait 3 seconds
  → If still mounted and permission = "default"
    → Call requestNotificationPermission()
    → Update settings.permissionRequested = true
```

### Notification Trigger Flow

```
Task completes (phase → 'completed')
  → Extract connectionId, sessionKey, chatKey
  → Call shouldShowNotification(connectionId, sessionKey, document.hidden)
    → Check permission === "granted"
    → Check settings.enabled === true
    → Check NOT (active session AND page visible)
  → If true:
    → Get last message from useMessageStore
    → Call sendTaskCompletionNotification(content, connectionId, sessionKey)
```

### Message Content Extraction

Priority order:
1. Check `useMessageStore.streamingContent[chatKey]` (if currently streaming)
2. Otherwise, get last message from `useMessageStore.messages[chatKey]` where `role === "assistant"`
3. Truncate to 100 characters
4. If empty, use fallback: "任务已完成"

## Component Details

### NotificationSettings Interface

```typescript
interface NotificationSettings {
  enabled: boolean;           // Master switch for notifications
  permissionRequested: boolean; // Track if we've asked for permission
}
```

Stored in localStorage key: `cc-pet-notification-settings`

Default values:
```json
{
  "enabled": true,
  "permissionRequested": false
}
```

### Notification Content Format

- **Title:** `任务完成 - [Connection Name]`
- **Body:** First 100 characters of last message
- **Icon:** `/favicon.ico` or pet icon path
- **Tag:** `chatKey` (same session notifications replace each other)
- **requireInteraction:** `false` (auto-dismiss after ~5 seconds)

### Notification Click Behavior

When user clicks notification:
1. Focus browser window (`window.focus()`)
2. Switch to the corresponding session (update `activeSessionKey[connectionId]`)
3. Close the notification

Implementation:
```typescript
notification.onclick = () => {
  window.focus();
  useSessionStore.getState().setActiveSession(connectionId, sessionKey);
  notification.close();
};
```

## Decision Logic

### shouldShowNotification Algorithm

```typescript
function shouldShowNotification(
  connectionId: string,
  sessionKey: string,
  isPageHidden: boolean
): boolean {
  // Check 1: Permission
  if (getNotificationPermission() !== "granted") return false;

  // Check 2: User settings
  const settings = getNotificationSettings();
  if (!settings.enabled) return false;

  // Check 3: Visibility (OR logic)
  const sessionStore = useSessionStore.getState();
  const isActiveSession = sessionStore.activeSessionKey[connectionId] === sessionKey;
  const shouldNotify = isPageHidden || !isActiveSession;

  return shouldNotify;
}
```

**Logic explanation:**
- User is viewing the active session AND tab is visible → No notification (user is watching)
- User switched to different session → Notify (even if tab visible)
- User switched to different browser tab → Notify (user can't see updates)

## Error Handling

### Browser Compatibility

- Feature detection: `'Notification' in window`
- If unsupported, all notification functions silently no-op
- No error messages shown to user (graceful degradation)

### Permission States

| State | Behavior |
|-------|----------|
| `granted` | Send notifications normally |
| `denied` | Silently skip, never request again |
| `default` | Request once on initialization, respect user choice |

### Exception Handling

1. **Notification constructor throws** - Wrap in try/catch, log warning, continue
2. **localStorage unavailable** - Use in-memory fallback settings
3. **Message content empty** - Use default text: "任务已完成"
4. **useMessageStore missing data** - Fallback to default text

### Cleanup

- Remove `visibilitychange` listener on App unmount
- Notification objects managed by browser, no manual cleanup needed

## Testing Strategy

### Manual Testing

1. **Permission flow:**
   - First visit: should request permission after 3 seconds
   - Permission granted: notifications should appear
   - Permission denied: no notifications, no repeated requests

2. **Visibility conditions:**
   - Active session + visible tab → no notification
   - Different session + visible tab → notification
   - Active session + hidden tab → notification
   - Different session + hidden tab → notification

3. **Click behavior:**
   - Click notification → window focus + switch to session

4. **Edge cases:**
   - Multiple rapid completions → multiple notifications
   - localStorage disabled → still works with defaults
   - Notification unsupported → app works normally

## Implementation Plan

### Files to Create

1. `packages/web/src/lib/notification.ts` - Core notification module

### Files to Modify

1. `packages/web/src/App.tsx` - Integration point
   - Add visibility tracking
   - Add permission request
   - Add notification trigger

2. `packages/web/src/lib/store/message.ts` (if needed) - Helper to get last message

### Implementation Steps

1. Create `notification.ts` with all helper functions
2. Add notification trigger in `App.tsx` after `setTaskPhase('completed')`
3. Add initialization logic (permission request, visibility tracking)
4. Add message extraction helper
5. Add click handler for session switching
6. Test manually across browsers (Chrome, Firefox, Safari)
7. Build and test in Docker

### Docker Build (no changes needed)

Existing Dockerfile already handles frontend build. After implementation:

```bash
cd /home/hy/code/cc-pet-web
docker build -t cc-pet-web:latest .
docker compose up -d
```

## Future Enhancements

Not in scope for this iteration, but documented for future consideration:

- **Sound notifications:** Play audio on notification
- **Quiet hours:** Suppress notifications during specific time ranges
- **Notification settings UI:** Add settings panel in web interface
- **Notification grouping:** Batch multiple completions
- **Custom notification text:** Let users configure notification format
- **Tauri integration:** Native desktop notifications for Tauri app

## References

- [MDN: Notification API](https://developer.mozilla.org/en-US/docs/Web/API/Notification)
- [MDN: Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- Existing code: `packages/web/src/App.tsx` lines 83-434
- Existing code: `packages/web/src/lib/store/session.ts`
- Existing code: `packages/web/src/lib/store/message.ts`
