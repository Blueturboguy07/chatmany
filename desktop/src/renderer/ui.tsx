import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChatmanyBridge } from "../shared/bridge";

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

/** A button's label while its request runs: the same words, with a spinner beside them. */
export function BusyLabel({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <>
      {busy ? <span aria-hidden className="spinner" /> : null}
      <span>{children}</span>
    </>
  );
}

/**
 * The in-page two-step confirm ("Delete", then "Confirm delete" and "Keep
 * it"). Focus moves to the confirm button when the step arms and back to
 * the first button when it is cancelled; Escape cancels. No browser
 * dialogs anywhere in the app.
 */
export function useConfirmStep() {
  const [armed, setArmed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (armed) {
      confirmRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [armed]);

  const arm = useCallback(() => setArmed(true), []);
  const cancel = useCallback(() => {
    returnFocus.current = true;
    setArmed(false);
  }, []);
  const reset = useCallback(() => setArmed(false), []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel();
    },
    [cancel],
  );

  return { armed, arm, cancel, reset, onKeyDown, triggerRef, confirmRef };
}

/** A link to a publik or Instagram page: it opens in the system browser. */
export function ExternalLink({ href, className = "link", children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        void bridge().openExternal(href);
      }}
    >
      {children}
    </a>
  );
}
