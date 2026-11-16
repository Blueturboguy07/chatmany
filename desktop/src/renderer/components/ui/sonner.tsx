import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/** Sonner toasts in the app's colours. "system" follows the light or dark setting, as the page does. */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
