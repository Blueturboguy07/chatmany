import * as ProgressPrimitive from "@radix-ui/react-progress";
import type * as React from "react";
import { cn } from "../../lib/utils";

const clamp = (n: number) => Math.min(100, Math.max(0, Number.isFinite(n) ? n : 0));

/**
 * shadcn/ui's Progress, with an optional second part drawn right after the
 * first (lighter): "this app" first, "your other apps" after it.
 */
function Progress({ className, value, secondary = 0, ...props }: React.ComponentProps<typeof ProgressPrimitive.Root> & { secondary?: number }) {
  const main = clamp(value ?? 0);
  const extra = Math.min(100 - main, clamp(secondary));
  return (
    <ProgressPrimitive.Root data-slot="progress" value={main} className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)} {...props}>
      {extra > 0 ? <div data-slot="progress-secondary" className="absolute inset-y-0 bg-primary/35" style={{ left: `${main}%`, width: `${extra}%` }} /> : null}
      <ProgressPrimitive.Indicator data-slot="progress-indicator" className="h-full w-full flex-1 bg-primary transition-transform" style={{ transform: `translateX(-${100 - main}%)` }} />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
