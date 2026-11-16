import { ExternalLink as ExternalIcon, Loader2, RotateCw } from "lucide-react";
import { useState } from "react";
import type { GateView } from "../shared/bridge";
import { OFFLINE_TEXT } from "../shared/messages";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { BusyLabel, bridge } from "./ui";

export const SIGN_IN_BODY = "chatmany uses your publik account. Click Sign in with publik, then sign in in your browser. This window continues when you are signed in.";

/**
 * Sign in with publik: the one screen before the workspace. The main
 * process decides which screen this is; nothing here can skip it.
 */
export function Gate({ view }: { view: Exclude<GateView, { screen: "signed_in" }> }) {
  const [busy, setBusy] = useState(false);

  async function press(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-10" data-screen={view.screen}>
      <Card className="w-full max-w-sm gap-5 py-6" aria-labelledby="gate-title" role="region">
        <CardHeader className="justify-items-center gap-3 px-6 text-center">
          <span aria-hidden className="grid size-10 place-items-center rounded-lg bg-primary text-base font-bold text-primary-foreground">
            c
          </span>
          <h1 id="gate-title" className="text-lg font-semibold">
            Sign in with publik
          </h1>
        </CardHeader>
        <CardContent className="grid gap-4 px-6 text-center">
          {view.screen === "starting" ? (
            <p className="flex items-center justify-center gap-2 text-muted-foreground" role="status">
              <Loader2 aria-hidden className="size-4 animate-spin" /> Starting…
            </p>
          ) : view.screen === "sign_in" ? (
            <>
              <p className="text-muted-foreground">{SIGN_IN_BODY}</p>
              <Button size="lg" className="w-full" onClick={() => void press(() => bridge().gate.signIn())} disabled={busy} aria-busy={busy} data-gate-signin>
                <BusyLabel busy={busy}>Sign in with publik</BusyLabel>
              </Button>
              <div role="status" aria-live="polite">
                {view.note ? (
                  <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                    {view.waiting ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : null}
                    {view.note}
                  </p>
                ) : null}
              </div>
            </>
          ) : view.screen === "unreachable" ? (
            <>
              <p className="text-muted-foreground" role="alert">
                {view.offline ? OFFLINE_TEXT : view.message}
              </p>
              <Button size="lg" className="w-full" onClick={() => void press(() => bridge().gate.retry())} disabled={busy} aria-busy={busy} data-gate-retry>
                <BusyLabel busy={busy} icon={<RotateCw aria-hidden />}>
                  Retry
                </BusyLabel>
              </Button>
            </>
          ) : (
            <>
              <p className="text-muted-foreground" role="alert">
                {view.message}
              </p>
              <Button variant="outline" className="w-full" onClick={() => void bridge().openExternal("https://publikhq.com/chatmany")}>
                <ExternalIcon aria-hidden />
                Open chatmany on publik
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
