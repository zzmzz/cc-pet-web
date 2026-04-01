import { useSessionStore } from "./store/session.js";
import { useConnectionStore } from "./store/connection.js";

const STORAGE_KEY = "cc-pet-notification-settings";

export interface NotificationSettings {
  enabled: boolean;
  permissionRequested: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  permissionRequested: false,
};

/**
 * Check if browser supports Notification API
 */
export function checkNotificationSupport(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Get current notification permission status
 */
export function getNotificationPermission(): NotificationPermission {
  if (!checkNotificationSupport()) return "denied";
  return Notification.permission;
}

/**
 * Request notification permission from user
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!checkNotificationSupport()) return "denied";

  try {
    const permission = await Notification.requestPermission();
    const settings = getNotificationSettings();
    updateNotificationSettings({ ...settings, permissionRequested: true });
    return permission;
  } catch (error) {
    console.warn("[notification] Failed to request permission:", error);
    return "denied";
  }
}

/**
 * Get notification settings from localStorage
 */
export function getNotificationSettings(): NotificationSettings {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(stored) as Partial<NotificationSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (error) {
    console.warn("[notification] Failed to load settings:", error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Update notification settings to localStorage
 */
export function updateNotificationSettings(settings: Partial<NotificationSettings>): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }

  try {
    const current = getNotificationSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (error) {
    console.warn("[notification] Failed to save settings:", error);
  }
}

/**
 * Determine if notification should be shown based on visibility and active session
 */
export function shouldShowNotification(
  connectionId: string,
  sessionKey: string,
  isPageHidden: boolean
): boolean {
  // Check 1: Permission
  if (getNotificationPermission() !== "granted") {
    return false;
  }

  // Check 2: User settings
  const settings = getNotificationSettings();
  if (!settings.enabled) {
    return false;
  }

  // Check 3: Visibility (OR logic: notify if page hidden OR not active session)
  const sessionStore = useSessionStore.getState();
  const isActiveSession = sessionStore.activeSessionKey[connectionId] === sessionKey;
  const shouldNotify = isPageHidden || !isActiveSession;

  return shouldNotify;
}

/**
 * Send a task completion notification
 */
export function sendTaskCompletionNotification(
  content: string,
  connectionId: string,
  sessionKey: string
): void {
  if (!checkNotificationSupport()) {
    return;
  }

  if (getNotificationPermission() !== "granted") {
    return;
  }

  try {
    // Get connection name
    const connectionStore = useConnectionStore.getState();
    const connection = connectionStore.connections.find((c) => c.id === connectionId);
    const connectionName = connection?.name || connectionId;

    // Format notification content
    const title = `任务完成 - ${connectionName}`;
    const body = content.trim().slice(0, 100) || "任务已完成";
    const tag = `${connectionId}::${sessionKey}`; // chatKey format

    // Create notification
    const notification = new Notification(title, {
      body,
      icon: "/favicon.ico",
      tag,
      requireInteraction: false,
    });

    // Handle click: focus window and switch to session
    notification.onclick = () => {
      window.focus();
      useSessionStore.getState().setActiveSession(connectionId, sessionKey);
      notification.close();
    };

    // Auto-cleanup on error
    notification.onerror = (error) => {
      console.warn("[notification] Notification error:", error);
    };
  } catch (error) {
    console.warn("[notification] Failed to send notification:", error);
  }
}
