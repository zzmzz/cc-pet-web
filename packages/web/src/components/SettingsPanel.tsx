import { useCallback, useEffect, useState } from "react";
import { getPlatform, isTauri } from "../lib/platform.js";
import {
  CC_PET_SERVER_URL_KEY,
  getTauriServerBaseUrl,
  resolveApiUrl,
} from "../lib/server-url.js";

const CC_PET_TOKEN_KEY = "cc-pet-token";
import { useConnectionStore } from "../lib/store/connection.js";
import { useUIStore } from "../lib/store/ui.js";
import {
  checkNotificationSupport,
  getNotificationSettings,
  updateNotificationSettings,
} from "../lib/notification.js";

export function SettingsPanel() {
  const open = useUIStore((s) => s.desktopConfigOpen);
  const setDesktopConfigOpen = useUIStore((s) => s.setDesktopConfigOpen);
  const activeConnectionId = useConnectionStore((s) => s.activeConnectionId);
  const connections = useConnectionStore((s) => s.connections);
  const active = activeConnectionId ? connections.find((c) => c.id === activeConnectionId) : undefined;

  const [serverUrlDraft, setServerUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSaving, setTokenSaving] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setServerUrlDraft(getTauriServerBaseUrl());
    setTokenDraft(localStorage.getItem(CC_PET_TOKEN_KEY)?.trim() ?? "");
    setTokenError(null);
    setNotifyEnabled(getNotificationSettings().enabled);
    if (isTauri()) {
      void getPlatform().setWindowMode?.("settings");
    }
  }, [open]);

  const close = useCallback(() => {
    setDesktopConfigOpen(false);
    if (isTauri()) {
      void getPlatform().setWindowMode?.(useUIStore.getState().windowMode);
    }
  }, [setDesktopConfigOpen]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  const saveServerUrl = useCallback(() => {
    const v = serverUrlDraft.trim();
    if (v.length === 0) {
      localStorage.removeItem(CC_PET_SERVER_URL_KEY);
    } else {
      localStorage.setItem(CC_PET_SERVER_URL_KEY, v);
    }
    window.location.reload();
  }, [serverUrlDraft]);

  const bridgeAction = useCallback(
    async (path: "connect" | "disconnect") => {
      if (!activeConnectionId) return;
      try {
        await getPlatform().fetchApi(
          `/api/bridges/${encodeURIComponent(activeConnectionId)}/${path}`,
          { method: "POST" },
        );
      } catch (e) {
        console.error(`[settings] bridge ${path} failed:`, e);
      }
    },
    [activeConnectionId],
  );

  const saveToken = useCallback(async () => {
    const token = tokenDraft.trim();
    if (!token.length) {
      setTokenError("Token 不能为空");
      return;
    }
    setTokenSaving(true);
    setTokenError(null);
    try {
      const res = await fetch(resolveApiUrl("/api/auth/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setTokenError("Token 无效");
        return;
      }
    } catch {
      setTokenError("认证服务不可用，请稍后重试");
      return;
    } finally {
      setTokenSaving(false);
    }
    localStorage.setItem(CC_PET_TOKEN_KEY, token);
    window.location.reload();
  }, [tokenDraft]);

  const logout = useCallback(() => {
    localStorage.removeItem(CC_PET_TOKEN_KEY);
    window.location.reload();
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="max-h-[min(90dvh,640px)] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-surface-secondary p-5 shadow-lg">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 id="settings-title" className="text-lg font-semibold text-text-primary">
            设置
          </h2>
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-text-secondary hover:bg-surface"
            onClick={close}
          >
            关闭
          </button>
        </div>

        <section className="mb-5 border-b border-border pb-5">
          <h3 className="mb-2 text-sm font-medium text-text-primary">cc-connect Bridge</h3>
          {activeConnectionId ? (
            <>
              <p className="mb-2 text-xs text-text-secondary">
                当前：{active?.name ?? activeConnectionId}
                {active ? `（${active.connected ? "已连接" : "未连接"}）` : null}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                  onClick={() => void bridgeAction("connect")}
                >
                  连接
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-surface"
                  onClick={() => void bridgeAction("disconnect")}
                >
                  断开
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-text-secondary">暂无可用 Bridge，请检查服务端配置。</p>
          )}
        </section>

        {isTauri() ? (
          <section className="mb-5 border-b border-border pb-5">
            <h3 className="mb-2 text-sm font-medium text-text-primary">服务地址</h3>
            <p className="mb-2 text-xs text-text-secondary">
              留空表示使用内置页面同源。修改后需重新加载应用。
            </p>
            <input
              className="mb-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-primary"
              placeholder="https://example.com"
              value={serverUrlDraft}
              onChange={(e) => setServerUrlDraft(e.target.value)}
            />
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              onClick={saveServerUrl}
            >
              保存并重新加载
            </button>
          </section>
        ) : null}

        {!isTauri() && checkNotificationSupport() ? (
          <section className="mb-5 border-b border-border pb-5">
            <h3 className="mb-2 text-sm font-medium text-text-primary">通知</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={notifyEnabled}
                onChange={(e) => {
                  const on = e.target.checked;
                  setNotifyEnabled(on);
                  updateNotificationSettings({ enabled: on });
                }}
              />
              任务完成时在后台显示浏览器通知
            </label>
          </section>
        ) : null}

        <section className="mb-5 border-b border-border pb-5">
          <h3 className="mb-2 text-sm font-medium text-text-primary">访问 Token</h3>
          <p className="mb-2 text-xs text-text-secondary">
            与登录页相同，用于 API / WebSocket 认证。修改后需重新加载以生效。
          </p>
          <input
            type="password"
            autoComplete="off"
            className="mb-2 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-primary"
            placeholder="输入新的 Token"
            value={tokenDraft}
            onChange={(e) => {
              setTokenDraft(e.target.value);
              setTokenError(null);
            }}
            disabled={tokenSaving}
          />
          {tokenError ? <p className="mb-2 text-xs text-red-500">{tokenError}</p> : null}
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={tokenSaving}
            onClick={() => void saveToken()}
          >
            {tokenSaving ? "校验中…" : "保存 Token 并重新加载"}
          </button>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium text-text-primary">账号</h3>
          <button
            type="button"
            className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
            onClick={logout}
          >
            退出登录
          </button>
        </section>
      </div>
    </div>
  );
}
