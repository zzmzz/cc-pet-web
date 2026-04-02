import { useEffect, useState } from "react";
import { isTauri } from "../lib/platform.js";
import { CC_PET_SERVER_URL_KEY, getTauriServerBaseUrl } from "../lib/server-url.js";

interface LoginGateProps {
  onSubmit: (token: string) => Promise<boolean>;
  errorMessage?: string | null;
}

export function LoginGate({ onSubmit, errorMessage }: LoginGateProps) {
  const desktop = isTauri();
  const [serverUrl, setServerUrl] = useState(() => (desktop ? getTauriServerBaseUrl() : ""));
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void import("@tauri-apps/api/core").then(async ({ invoke }) => {
      try {
        await invoke("prepare_login_window");
      } catch (e) {
        if (!cancelled) console.warn("[cc-pet] prepare_login_window failed:", e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  const submit = async () => {
    if (submitting) return;
    if (desktop) {
      const v = serverUrl.trim();
      if (v.length === 0) {
        localStorage.removeItem(CC_PET_SERVER_URL_KEY);
      } else {
        localStorage.setItem(CC_PET_SERVER_URL_KEY, v);
      }
    }
    setSubmitting(true);
    try {
      await onSubmit(token);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="box-border flex min-h-[100dvh] items-center justify-center overflow-y-auto bg-surface p-4 py-8">
      <div className="my-auto w-full max-w-lg rounded-xl border border-border bg-surface-secondary p-6 shadow sm:p-8">
        <h1 className="mb-2 text-xl font-semibold text-text-primary">
          {desktop ? "登录" : "输入访问 Token"}
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-text-secondary">
          {desktop
            ? "填写服务端根地址与访问 Token；地址与设置中「服务器 URL」一致，留空则使用内置页面同源 API。"
            : "认证通过后才可进入会话界面。"}
        </p>
        {desktop ? (
          <input
            className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-text-primary placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-primary"
            placeholder="https://example.com:8080"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            disabled={submitting}
            autoComplete="url"
          />
        ) : null}
        <input
          className="mb-3 w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-text-primary placeholder:text-gray-500 outline-none focus:ring-2 focus:ring-primary"
          placeholder="请输入 token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submit();
            }
          }}
          disabled={submitting}
        />
        {errorMessage ? <p className="mb-3 text-sm text-red-500">{errorMessage}</p> : null}
        <button
          type="button"
          className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={submitting}
          onClick={() => {
            void submit();
          }}
        >
          {submitting ? "验证中..." : "进入"}
        </button>
      </div>
    </div>
  );
}
