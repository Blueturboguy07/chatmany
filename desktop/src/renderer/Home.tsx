import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusAnswer } from "../shared/bridge";
import { CONNECTED_TEXT, CONNECT_ERROR_TEXT, CONNECT_TIMEOUT_TEXT, UNAVAILABLE } from "../shared/messages";
import type { ConnectedStatus, StatusView } from "../shared/types";
import { Workspace } from "./components/Workspace";
import { BusyLabel, ExternalLink, Status, bridge } from "./ui";

type PageState = { kind: "loading" } | { kind: "unavailable" } | { kind: "error"; message: string } | { kind: "ready"; status: StatusView };
export type Notice = { tone: "ok" | "error"; text: string } | null;

/** How the Instagram connect is going. The consent page is in the system browser. */
type ConnectPhase = { phase: "idle" } | { phase: "starting" } | { phase: "waiting"; connectId: string; until: number; note: string };

export const POLL_MS = 3_000;
export const CONNECT_LIMIT_MS = 10 * 60_000;

/**
 * After sign-in: the title, any notice, then one of these screens
 * (`data-screen`): loading, error (with Try again), unavailable, connect
 * (one button), connecting (waiting for the browser), workspace.
 */
export function Home() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [connect, setConnect] = useState<ConnectPhase>({ phase: "idle" });
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const res = await bridge().workspace.status();
    if (res.ok) setState({ kind: "ready", status: stripConnect(res.data) });
    else if (res.error === UNAVAILABLE) setState({ kind: "unavailable" });
    else setState({ kind: "error", message: res.message });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function startConnect() {
    setNotice(null);
    setConnect({ phase: "starting" });
    const res = await bridge().workspace.connect();
    if (!res.ok) {
      setConnect({ phase: "idle" });
      setNotice({ tone: "error", text: res.message });
      return;
    }
    setConnect({ phase: "waiting", connectId: res.data.connect_id, until: Date.now() + CONNECT_LIMIT_MS, note: "" });
  }

  const finish = useCallback(
    async (outcome: { ok: true } | { ok: false; text: string }) => {
      setConnect({ phase: "idle" });
      if (outcome.ok) {
        setNotice({ tone: "ok", text: CONNECTED_TEXT });
        await load();
      } else {
        setNotice({ tone: "error", text: outcome.text });
      }
    },
    [load],
  );

  const disconnected = useCallback(async () => {
    setNotice({ tone: "ok", text: "Disconnected. publik deleted your automations, their numbers and the people list." });
    await load();
  }, [load]);

  let screen = "loading";
  let body: React.ReactNode = <p className="mt-8 muted">Loading…</p>;
  if (connect.phase === "waiting") {
    screen = "connecting";
    body = <Connecting connectId={connect.connectId} until={connect.until} onCancel={() => setConnect({ phase: "idle" })} onDone={finish} />;
  } else if (state.kind === "unavailable") {
    screen = "unavailable";
    body = <Plain title="chatmany is not available yet." body="publik is still setting it up. Try again later." onRetry={load} />;
  } else if (state.kind === "error") {
    screen = "error";
    body = <Plain title="chatmany didn’t load." body={state.message} onRetry={load} />;
  } else if (state.kind === "ready") {
    if (state.status.connected) {
      screen = "workspace";
      body = <Workspace status={state.status} onReconnect={() => void startConnect()} reconnecting={connect.phase === "starting"} onDisconnected={() => void disconnected()} />;
    } else {
      screen = "connect";
      body = <ConnectCard busy={connect.phase === "starting"} onConnect={() => void startConnect()} />;
    }
  }

  return (
    <main className="page" data-screen={screen}>
      <h1 className="title">chatmany</h1>
      <p className="lead">When someone comments a keyword on your Instagram post, they get a DM with your link.</p>
      <Status assertive={notice?.tone === "error"} className={`notice mt-6 ${notice?.tone === "error" ? "notice-error" : "notice-ok"}`}>
        {notice?.text ?? ""}
      </Status>
      {body}
    </main>
  );
}

function stripConnect(answer: StatusAnswer): StatusView {
  if (!answer.connected) return { connected: false };
  const { connect: _connect, ...rest } = answer;
  return rest as ConnectedStatus;
}

function Plain({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return (
    <div className="plain mt-8">
      <p className="bold">{title}</p>
      <p className="mt-2 small muted">{body}</p>
      <button type="button" className="btn btn-quiet mt-4" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function ConnectCard({ busy, onConnect }: { busy: boolean; onConnect: () => void }) {
  return (
    <section className="card mt-8" aria-labelledby="connect-title">
      <h2 id="connect-title" className="h2">
        Connect your Instagram account
      </h2>
      <p className="mt-3 prose">
        You pick a post, a keyword and a link. When someone comments that keyword, publik sends them your DM with the link. It runs in the cloud, also when this computer is off.
      </p>
      <button type="button" className="btn btn-primary btn-big mt-6" onClick={onConnect} disabled={busy} aria-busy={busy} data-connect-button>
        <BusyLabel busy={busy}>Connect Instagram</BusyLabel>
      </button>
      <ul className="mt-6 small muted bullets">
        <li>
          You need a <b className="ink">Professional account (Creator or Business)</b>. A personal account cannot connect. To switch, open Instagram, then Settings, then Account type and tools.
        </li>
        <li className="mt-1">You approve access on Instagram’s own page, in your browser. publik never sees your Instagram password.</li>
      </ul>
      <p className="mt-6 tiny muted">
        <ExternalLink href="https://publikhq.com/privacy#chatmany">What publik keeps</ExternalLink>
        {" · "}
        <ExternalLink href="https://publikhq.com/data-deletion#chatmany">Data deletion</ExternalLink>
      </p>
    </section>
  );
}

/**
 * Waiting for Instagram: the consent page is open in the system browser.
 * Asks publik every 3 seconds, for at most 10 minutes, how this connect
 * went: connected, or refused with a reason the person can act on.
 */
function Connecting({
  connectId,
  until,
  onCancel,
  onDone,
}: {
  connectId: string;
  until: number;
  onCancel: () => void;
  onDone: (outcome: { ok: true } | { ok: false; text: string }) => void;
}) {
  const [note, setNote] = useState("");
  const [reopened, setReopened] = useState(false);
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
    <section className="card mt-8" aria-labelledby="connecting-title">
      <h2 id="connecting-title" className="h2">
        Finish on Instagram
      </h2>
      <p className="mt-3 prose">
        chatmany opened Instagram in your browser. Approve access there. This window continues when Instagram is connected.
      </p>
      <p className="mt-4 row small muted" role="status">
        <span aria-hidden className="spinner" /> Waiting for Instagram…
      </p>
      <Status className="mt-2 small danger-text">{note}</Status>
      <div className="row mt-6">
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            void bridge()
              .workspace.reopenConnect()
              .then((ok) => setReopened(ok));
          }}
        >
          Open Instagram again
        </button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {reopened ? <p className="mt-2 tiny muted">Opened again in your browser.</p> : null}
    </section>
  );
}
