import type { ReactNode } from "react";

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-secondary px-4 py-3">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
        {title}
        {count !== undefined && (
          <span className="rounded-full bg-surface px-2 text-xs font-normal text-text-secondary">{count}</span>
        )}
      </h2>
      {children}
    </section>
  );
}
