import { useState } from "react";
import type { GateView } from "../shared/bridge";
import { OFFLINE_TEXT } from "../shared/messages";
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
    <main className="gate" data-screen={view.screen}>
      <section className="gate-card" aria-labelledby="gate-title">
        <div className="gate-mark" aria-hidden>
          c
        </div>
        <h1 id="gate-title" className="title">
          Sign in with publik
        </h1>

        {view.screen === "starting" ? (
          <p className="body" role="status">
            Starting…
          </p>
        ) : view.screen === "sign_in" ? (
          <>
            <p className="body">{SIGN_IN_BODY}</p>
            <button type="button" className="btn btn-primary btn-big mt-6" onClick={() => void press(() => bridge().gate.signIn())} disabled={busy} aria-busy={busy} data-gate-signin>
              <BusyLabel busy={busy}>Sign in with publik</BusyLabel>
            </button>
            <div role="status" aria-live="polite">
              {view.note ? (
                <p className="note">
                  {view.waiting ? <span aria-hidden className="spinner" /> : null}
                  {view.note}
                </p>
              ) : null}
            </div>
          </>
        ) : view.screen === "unreachable" ? (
          <>
            <p className="body" role="alert">
              {view.offline ? OFFLINE_TEXT : view.message}
            </p>
            <button type="button" className="btn btn-primary btn-big mt-6" onClick={() => void press(() => bridge().gate.retry())} disabled={busy} aria-busy={busy} data-gate-retry>
              <BusyLabel busy={busy}>Retry</BusyLabel>
            </button>
          </>
        ) : (
          <>
            <p className="body" role="alert">
              {view.message}
            </p>
            <button type="button" className="btn btn-quiet mt-6" onClick={() => void bridge().openExternal("https://publikhq.com/chatmany")}>
              Open chatmany on publik
            </button>
          </>
        )}
      </section>
    </main>
  );
}
