import { useState } from "react";

interface LoginGateProps {
  onSubmit: (token: string) => Promise<boolean>;
  errorMessage?: string | null;
}

export function LoginGate({ onSubmit, errorMessage }: LoginGateProps) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
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
          输入访问 Token
        </h1>
        <p className="mb-5 text-sm leading-relaxed text-text-secondary">
          认证通过后才可进入会话界面。
        </p>
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
