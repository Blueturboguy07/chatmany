import { useEffect, useState } from "react";
import type { GateView } from "../shared/bridge";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { Gate } from "./Gate";
import { Home } from "./Home";
import { cn } from "./lib/utils";
import { bridge } from "./ui";

/**
 * The whole app: the sign-in gate until the main process says the install
 * is signed in, then the chatmany workspace. The screen follows the main
 * process's gate state only; an address or a stored flag cannot change it.
 */
export function App() {
  const [gate, setGate] = useState<GateView>({ screen: "starting" });
  // On macOS the window has no title bar (hiddenInset): this header is it, with room for the window buttons.
  const mac = bridge().info.platform === "darwin";

  useEffect(() => {
    const off = bridge().gate.onChange(setGate);
    void bridge()
      .gate.get()
      .then(setGate)
      .catch(() => undefined);
    return off;
  }, []);

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col">
        <header className={cn("sticky top-0 z-40 flex h-12 shrink-0 items-center justify-between gap-4 border-b bg-background px-4 select-none", mac && "app-drag pl-20")}>
          <span className="flex items-center gap-2 font-semibold">
            <span aria-hidden className="grid size-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              c
            </span>
            chatmany
          </span>
          {gate.screen === "signed_in" ? (
            <span className="truncate text-xs text-muted-foreground" translate="no">
              {gate.handle ? `@${gate.handle} on publik` : "Signed in to publik"}
            </span>
          ) : null}
        </header>
        {gate.screen === "signed_in" ? <Home /> : <Gate view={gate} />}
      </div>
      {/* At the top, under the header: at the bottom a toast would cover the builder's Save button. */}
      <Toaster position="top-center" offset={{ top: 60 }} mobileOffset={{ top: 60 }} />
    </TooltipProvider>
  );
}
