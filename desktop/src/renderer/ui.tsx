import { Loader2 } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { ChatmanyBridge } from "../shared/bridge";
import { cn } from "./lib/utils";

/** The preload's bridge. Read when called, so a test can render without a window. */
export function bridge(): ChatmanyBridge {
  return (window as unknown as { chatmany: ChatmanyBridge }).chatmany;
}

/**
 * A message a screen reader hears when it changes. The region stays in the
 * page and only its text changes. Polite by default; `assertive` for an
 * error that stops the person.
 */
export function Status({ children, className, assertive = false, id }: { children?: ReactNode; className?: string; assertive?: boolean; id?: string }) {
  const has = children !== null && children !== undefined && children !== false && children !== "";
  return (
    <div role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"}>
      {has ? (
        <p id={id} className={className}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

/** A button's label while its request runs: a spinner in place of the icon, the same words. */
export function BusyLabel({ busy, icon, children }: { busy: boolean; icon?: ReactNode; children: ReactNode }) {
  return (
    <>
      {busy ? <Loader2 aria-hidden className="animate-spin" /> : (icon ?? null)}
      <span>{children}</span>
    </>
  );
}

/** A link to a publik or Instagram page: it opens in the system browser. */
export function ExternalLink({ href, className, children, onClick, ...props }: Omit<ComponentProps<"a">, "href"> & { href: string }) {
  return (
    <a
      href={href}
      className={cn("font-medium text-primary underline-offset-4 hover:underline", className)}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        void bridge().openExternal(href);
      }}
      {...props}
    >
      {children}
    </a>
  );
}
