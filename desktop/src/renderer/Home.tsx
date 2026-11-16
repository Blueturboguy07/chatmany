import { Check, CircleAlert, ExternalLink as ExternalIcon, Loader2, RotateCcw, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppBilling, StatusAnswer } from "../shared/bridge";
import { CONNECTED_TEXT, CONNECT_ERROR_TEXT, CONNECT_TIMEOUT_TEXT, UNAVAILABLE } from "../shared/messages";
import type { ConnectedStatus, StatusView } from "../shared/types";
import { Workspace } from "./components/Workspace";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import { BusyLabel, ExternalLink, Status, bridge } from "./ui";

type PageState = { kind: "loading" } | { kind: "unavailable" } | { kind: "error"; message: string } | { kind: "ready"; status: StatusView; billing: AppBilling | null };

/** How the Instagram connect is going. The consent page is in the system browser. */
type ConnectPhase = { phase: "idle" } | { phase: "starting" } | { phase: "waiting"; connectId: string; until: number };

export const POLL_MS = 3_000;
export const CONNECT_LIMIT_MS = 10 * 60_000;

/**
 * After sign-in, one of these screens (`data-screen`): loading, error (with
 * Try again), unavailable, connect (one button), connecting (waiting for the
 * browser), workspace. A connect that did not finish says why above the
 * screen until the next try; "connected" and "disconnected" are toasts.
 */
export function Home() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [connect, setConnect] = useState<ConnectPhase>({ phase: "idle" });
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const res = await bridge().workspace.status();
    if (res.ok) setState({ kind: "ready", status: stripConnect(res.data), billing: res.data.billing ?? null });
    else if (res.error === UNAVAILABLE) setState({ kind: "unavailable" });
    else setState({ kind: "error", message: res.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startConnect() {
    setProblem("");
    setConnect({ phase: "starting" });
    const res = await bridge().workspace.connect();
    if (!res.ok) {
      setConnect({ phase: "idle" });
      setProblem(res.message);
      return;
    }
    setConnect({ phase: "waiting", connectId: res.data.connect_id, until: Date.now() + CONNECT_LIMIT_MS });
  }

  const finish = useCallback(
    async (outcome: { ok: true } | { ok: false; text: string }) => {
      setConnect({ phase: "idle" });
      if (outcome.ok) {
        toast.success(CONNECTED_TEXT);
        await load();
      } else {
        setProblem(outcome.text);
      }
    },
    [load],
  );

  const disconnected = useCallback(async () => {
    setProblem("");
    toast.success("Disconnected. publik deleted your automations, their numbers and the people list.");
    await load();
  }, [load]);

  let screen = "loading";
  let body: React.ReactNode = <LoadingView />;
  if (connect.phase === "waiting") {
    screen = "connecting";
    body = (
      <Narrow>
        <Connecting
          key={connect.connectId}
          connectId={connect.connectId}
          until={connect.until}
          onCancel={() => setConnect({ phase: "idle" })}
          onRestart={() => void startConnect()}
          onDone={finish}
        />
      </Narrow>
    );
  } else if (connect.phase === "starting" && state.kind === "ready" && !state.status.connected) {
    screen = "connect";
    body = (
      <Narrow>
        <ConnectCard busy onConnect={() => undefined} />
      </Narrow>
    );
  } else if (state.kind === "unavailable") {
    screen = "unavailable";
    body = <Plain title="chatmany is not available yet." body="publik is still setting it up. Try again later." onRetry={load} />;
  } else if (state.kind === "error") {
    screen = "error";
    body = <Plain title="chatmany didn’t load." body={state.message} onRetry={load} />;
  } else if (state.kind === "ready") {
    if (state.status.connected) {
      screen = "workspace";
      body = (
        <Workspace
          status={state.status}
          billing={state.billing}
          onReconnect={() => void startConnect()}
          reconnecting={connect.phase === "starting"}
          onDisconnected={() => void disconnected()}
        />
      );
    } else {
      screen = "connect";
      body = (
        <Narrow>
          <ConnectCard busy={connect.phase === "starting"} onConnect={() => void startConnect()} />
        </Narrow>
      );
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-5 sm:px-6" data-screen={screen}>
      {problem ? (
        <Narrow wide={screen === "workspace"}>
          <Alert variant="destructive" data-connect-problem>
            <CircleAlert aria-hidden />
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        </Narrow>
      ) : null}
      {body}
    </main>
  );
}

function stripConnect(answer: StatusAnswer): StatusView {
  if (!answer.connected) return { connected: false };
  const { connect: _connect, billing: _billing, ...rest } = answer;
  return rest as ConnectedStatus;
}

/** The screens before the workspace: one card, centred, at a reading width. */
function Narrow({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <div className={wide ? "w-full" : "mx-auto w-full max-w-lg sm:pt-6"}>{children}</div>;
}

function LoadingView() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <div className="grid gap-1.5">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <Skeleton className="h-9 w-72 max-w-full" />
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-[74px]" />
        <Skeleton className="h-[74px]" />
        <Skeleton className="h-[74px]" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

function Plain({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <Narrow>
      <Card>
        <CardHeader>
          <h2 className="font-semibold">{title}</h2>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={onRetry}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </CardContent>
      </Card>
    </Narrow>
  );
}

export function ConnectCard({ busy, onConnect }: { busy: boolean; onConnect: () => void }) {
  return (
    <Card aria-labelledby="connect-title" role="region">
      <CardHeader>
        <h2 id="connect-title" className="text-base font-semibold">
          Connect your Instagram account
        </h2>
        <CardDescription>When someone comments a keyword on your Instagram post, they get a DM with your link.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>You pick a post, a keyword and a link. When someone comments that keyword, publik sends them your DM with the link. It runs in the cloud, also when this computer is off.</p>
        <ul className="grid gap-2 text-muted-foreground">
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              You need a <b className="font-medium text-foreground">Professional account (Creator or Business)</b>. A personal account cannot connect. To switch, open Instagram, then Settings, then Account type and tools.
            </span>
          </li>
          <li className="flex gap-2">
            <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>You approve access on Instagram’s own page, in your browser. publik never sees your Instagram password.</span>
          </li>
        </ul>
        <Button size="lg" className="w-full sm:w-fit" onClick={onConnect} disabled={busy} aria-busy={busy} data-connect-button>
          <BusyLabel busy={busy}>Connect Instagram</BusyLabel>
        </Button>
      </CardContent>
      <CardFooter className="gap-4 border-t text-xs">
        <ExternalLink href="https://publikhq.com/privacy#chatmany" className="text-muted-foreground hover:text-foreground">
          What publik keeps
        </ExternalLink>
        <ExternalLink href="https://publikhq.com/data-deletion#chatmany" className="text-muted-foreground hover:text-foreground">
          Data deletion
        </ExternalLink>
      </CardFooter>
    </Card>
  );
}

/**
 * Waiting for Instagram: the consent page is open in the system browser.
 * Asks publik every 3 seconds, for at most 10 minutes, how this connect
 * went: connected, or refused with a reason the person can act on.
 *
 * A Cancel on Instagram does not always come back to publik (Instagram may
 * drop the connect's state), so the app cannot always know. "I cancelled,
 * start again" ends this wait at once and opens a new Instagram link.
 */
export function Connecting({
  connectId,
  until,
  onCancel,
  onRestart,
  onDone,
}: {
  connectId: string;
  until: number;
  onCancel: () => void;
  onRestart: () => void;
  onDone: (outcome: { ok: true } | { ok: false; text: string }) => void;
}) {
  const [note, setNote] = useState("");
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = (outcome: { ok: true } | { ok: false; text: string }) => {
      if (done.current) return;
      done.current = true;
      onDone(outcome);
    };
    const tick = async () => {
      if (done.current) return;
      if (Date.now() >= until) return end({ ok: false, text: CONNECT_TIMEOUT_TEXT });
      const res = await bridge().workspace.status(connectId);
      if (done.current) return;
      if (res.ok) {
        setNote("");
        const progress = res.data.connect;
        if (progress?.state === "connected") return end({ ok: true });
        if (progress?.state === "failed") return end({ ok: false, text: progress.message });
        if (progress?.state === "unknown") return end({ ok: false, text: CONNECT_ERROR_TEXT.expired });
        if (!progress && res.data.connected && !res.data.token_expired) return end({ ok: true });
      } else if (res.status === 401) {
        return; // the gate takes over
      } else {
        setNote(res.message);
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      done.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [connectId, until, onDone]);

  return (
    <Card aria-labelledby="connecting-title" role="region">
      <CardHeader>
        <h2 id="connecting-title" className="text-base font-semibold">
          Finish on Instagram
        </h2>
        <CardDescription>chatmany opened Instagram in your browser. Approve access there. This window continues when Instagram is connected.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-muted-foreground" role="status">
          <Loader2 aria-hidden className="size-4 animate-spin text-primary" /> Waiting for Instagram…
        </p>
        <Status className="text-destructive">{note}</Status>
        <p className="text-muted-foreground">Did you press Cancel on Instagram, or close the page? Start again with a new link.</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onRestart} data-connect-restart>
            <RotateCcw aria-hidden />I cancelled, start again
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void bridge()
                .workspace.reopenConnect()
                .then((ok) => {
                  if (ok) toast("Opened Instagram again in your browser.");
                });
            }}
          >
            <ExternalIcon aria-hidden />
            Open Instagram again
          </Button>
          <Button variant="ghost" onClick={onCancel} data-connect-cancel>
            Stop waiting
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
