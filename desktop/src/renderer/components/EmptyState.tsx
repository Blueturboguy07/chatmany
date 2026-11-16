import type { ReactNode } from "react";

/** An empty or failed list: one sentence and one action. */
export function EmptyState({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
      <p className="max-w-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}
