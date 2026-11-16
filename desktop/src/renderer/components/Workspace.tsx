import { useCallback, useEffect, useState } from "react";
import { draftFromCampaign, newDraft, type Draft } from "../../shared/campaign";
import { accountTypeLabel } from "../../shared/messages";
import type { CampaignRow, ConnectedStatus, DashboardView, IgMedia } from "../../shared/types";
import { BusyLabel, Status, bridge } from "../ui";
import { AutomationBuilder } from "./AutomationBuilder";
import { AutomationRow } from "./AutomationRow";
import { ContactsSection } from "./ContactsSection";
import { DisconnectSection } from "./DisconnectSection";

export type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

const COUNT = new Intl.NumberFormat("en-US");

/**
 * The connected view: whose account it is, the last 30 days in three
 * numbers, the automations (with the builder above them when one is open),
 * the people who came through, and the way out.
 */
export function Workspace({
  status,
  onReconnect,
  reconnecting,
  onDisconnected,
}: {
  status: ConnectedStatus;
  onReconnect: () => void;
  reconnecting: boolean;
  onDisconnected: () => void;
}) {
  const [media, setMedia] = useState<Load<IgMedia[]>>({ state: "loading" });
  const [campaigns, setCampaigns] = useState<Load<CampaignRow[]>>({ state: "loading" });
  const [summary, setSummary] = useState<Load<DashboardView>>({ state: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState("");

  const loadMedia = useCallback(async () => {
    setMedia({ state: "loading" });
    const res = await bridge().workspace.api<{ media?: IgMedia[] }>("media");
    setMedia(res.ok ? { state: "ready", data: res.data.media ?? [] } : { state: "error", message: res.message });
  }, []);

  const loadCampaigns = useCallback(async () => {
    const res = await bridge().workspace.api<{ campaigns?: CampaignRow[] }>("campaigns");
    setCampaigns(res.ok ? { state: "ready", data: res.data.campaigns ?? [] } : { state: "error", message: res.message });
  }, []);

  const loadSummary = useCallback(async () => {
    const res = await bridge().workspace.api<DashboardView>("dashboard?days=30");
    setSummary(res.ok ? { state: "ready", data: res.data } : { state: "error", message: res.message });
  }, []);

  useEffect(() => {
    void loadMedia();
    void loadCampaigns();
    void loadSummary();
  }, [loadMedia, loadCampaigns, loadSummary]);

  const rows = campaigns.state === "ready" ? campaigns.data : [];
  const mediaById = new Map((media.state === "ready" ? media.data : []).map((m) => [m.id, m]));

  function open(next: Draft) {
    setNote("");
    setDraft(next);
    // The builder opens above the list; bring it into view on a narrow window.
    requestAnimationFrame(() => document.getElementById("chatmany-builder")?.scrollIntoView({ block: "start" }));
  }

  return (
    <div className="mt-8" data-workspace>
      <AccountHeader status={status} />

      {status.token_expired ? (
        <div className="notice notice-error mt-6" role="alert">
          <p>Instagram ended this connection, so your automations are paused.</p>
          <button type="button" className="btn btn-quiet btn-small mt-2" onClick={onReconnect} disabled={reconnecting} aria-busy={reconnecting}>
            <BusyLabel busy={reconnecting}>Connect Instagram again</BusyLabel>
          </button>
        </div>
      ) : null}

      <SummaryTiles summary={summary} />

      <section className="mt-12" aria-labelledby="automations-title">
        <div className="spread">
          <div>
            <h2 id="automations-title" className="h2">
              Automations
            </h2>
            <p className="mt-2 small muted">Each one watches one post for a keyword and sends one DM.</p>
          </div>
          {draft ? null : (
            <button type="button" onClick={() => open(newDraft())} className="btn btn-primary" data-new-automation>
              ＋ New automation
            </button>
          )}
        </div>

        {draft ? (
          <AutomationBuilder
            key={draft.campaign_id || "new"}
            initial={draft}
            media={media}
            onRetryMedia={loadMedia}
            status={status}
            onCancel={() => setDraft(null)}
            onSaved={(name) => {
              setDraft(null);
              setNote(`Saved “${name}”.`);
              void loadCampaigns();
              void loadSummary();
            }}
          />
        ) : null}

        <Status className="mt-4 small ok-text">{note}</Status>

        {campaigns.state === "loading" ? (
          <p className="mt-6 small muted">Loading automations…</p>
        ) : campaigns.state === "error" ? (
          <div className="plain mt-6">
            <p className="danger-text small">{campaigns.message}</p>
            <button type="button" onClick={() => void loadCampaigns()} className="btn btn-quiet mt-3">
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          draft ? null : (
            <div className="plain mt-6">
              <p>No automations yet.</p>
              <p className="mt-1 small muted">Make one: pick a post, a keyword and the link to send.</p>
            </div>
          )
        ) : (
          <ul className="list">
            {rows.map((row) => (
              <AutomationRow
                key={row.campaign_id}
                row={row}
                media={mediaById.get(row.media_id) ?? null}
                editing={draft?.campaign_id === row.campaign_id}
                builderOpen={draft !== null}
                onEdit={() => open(draftFromCampaign(row))}
                onChanged={() => {
                  void loadCampaigns();
                  void loadSummary();
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <ContactsSection campaigns={rows} />

      <DisconnectSection username={status.username} onDisconnected={onDisconnected} />
    </div>
  );
}

function AccountHeader({ status }: { status: ConnectedStatus }) {
  const name = status.username ? `@${status.username}` : "Your Instagram account";
  return (
    <div className="account">
      {status.profile_picture_url ? (
        <img src={status.profile_picture_url} alt="" width={56} height={56} referrerPolicy="no-referrer" className="avatar" />
      ) : (
        <span aria-hidden className="avatar">
          {(status.username ?? "?").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min0">
        <p className="account-name" translate="no">
          {name}
        </p>
        <p className="small muted">{accountTypeLabel(status.account_type)} · connected to publik</p>
      </div>
    </div>
  );
}

function SummaryTiles({ summary }: { summary: Load<DashboardView> }) {
  const cards = summary.state === "ready" ? summary.data.cards : null;
  const tiles: Array<[string, number | null]> = [
    ["Comments with a keyword", cards ? cards.comments : null],
    ["DMs sent", cards ? cards.sends : null],
    ["Links delivered", cards ? cards.delivered : null],
  ];
  return (
    <section className="mt-8" aria-labelledby="summary-title">
      <h2 id="summary-title" className="small bold">
        Last 30 days, all automations
      </h2>
      {summary.state === "error" ? (
        <p className="mt-2 small muted">These numbers didn’t load. {summary.message}</p>
      ) : (
        <div className="tiles mt-3">
          {tiles.map(([label, value]) => (
            <div key={label} className="card" data-summary-tile>
              <p className="tile-label">{label}</p>
              <p className="tile-value">{value === null ? "…" : COUNT.format(value)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
