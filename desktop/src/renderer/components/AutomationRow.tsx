import { useCallback, useEffect, useState } from "react";
import type { CampaignRow, DashboardView, IgMedia } from "../../shared/types";
import { BusyLabel, ExternalLink, Status, bridge, useConfirmStep } from "../ui";
import { mediaThumb } from "./AutomationBuilder";

const COUNT = new Intl.NumberFormat("en-US");
const DAYS = [7, 30, 90] as const;

/**
 * One automation in the list: its post, name and keywords, the On switch,
 * and Numbers, Edit and Delete. Delete takes two clicks in the page, the
 * second confirms. The switch moves at once and moves back if the save fails.
 */
export function AutomationRow({
  row,
  media,
  editing,
  builderOpen,
  onEdit,
  onChanged,
}: {
  row: CampaignRow;
  media: IgMedia | null;
  editing: boolean;
  /** One builder at a time: Edit waits until the open one is saved or closed, so no typing is lost. */
  builderOpen: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [active, setActive] = useState(row.active);
  const [switching, setSwitching] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [numbersOpen, setNumbersOpen] = useState(false);
  const step = useConfirmStep();
  const name = row.name || row.campaign_id;
  const thumb = mediaThumb(media);
  const panelId = `cm-numbers-${row.campaign_id.replace(/[^A-Za-z0-9_-]/g, "")}`;

  useEffect(() => setActive(row.active), [row.active]);

  async function toggle(next: boolean) {
    setActive(next);
    setSwitching(true);
    setError("");
    const res = await bridge().workspace.api("campaigns/status", { method: "POST", body: { campaign_id: row.campaign_id, active: next } });
    setSwitching(false);
    if (!res.ok) {
      setActive(!next);
      setError(res.message);
    }
  }

  async function remove() {
    setDeleting(true);
    setError("");
    const res = await bridge().workspace.api("campaigns/delete", { method: "POST", body: { campaign_id: row.campaign_id } });
    setDeleting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    step.reset();
    onChanged();
  }

  return (
    <li data-automation={row.campaign_id}>
      <div className="auto-head">
        {thumb ? <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="thumb" /> : <span aria-hidden className="thumb" />}
        <div className="auto-main">
          <p className="bold break">{name}</p>
          <p className="mt-1 small muted">
            Comment{" "}
            {row.keywords.map((k, i) => (
              <span key={k}>
                {i > 0 ? ", " : null}
                <b className="ink">{k}</b>
              </span>
            ))}{" "}
            {row.deliver_in_opening ? "→ DM with the link" : "→ DM with a button, then the link"}
          </p>
          {media?.permalink ? (
            <ExternalLink href={media.permalink} className="link tiny">
              Open the post on Instagram
            </ExternalLink>
          ) : null}
        </div>
        <label className="switch small">
          <input type="checkbox" role="switch" checked={active} disabled={switching} onChange={(e) => void toggle(e.target.checked)} aria-label={`${name} is on`} />
          {active ? "On" : "Off"}
        </label>
      </div>

      <div className="row auto-actions">
        <button type="button" onClick={() => setNumbersOpen((v) => !v)} aria-expanded={numbersOpen} aria-controls={panelId} className="btn btn-quiet btn-small">
          {numbersOpen ? "Hide numbers" : "Numbers"}
        </button>
        <button type="button" onClick={onEdit} disabled={builderOpen} title={builderOpen && !editing ? "Save or cancel the automation you are editing first." : undefined} className="btn btn-quiet btn-small">
          {editing ? "Editing above" : "Edit"}
        </button>
        {step.armed ? (
          <span className="row" onKeyDown={step.onKeyDown}>
            <span className="tiny muted">Delete “{name}” and its numbers? This cannot be undone.</span>
            <button type="button" ref={step.confirmRef} onClick={() => void remove()} disabled={deleting} aria-busy={deleting} className="btn btn-danger btn-small">
              <BusyLabel busy={deleting}>Confirm delete</BusyLabel>
            </button>
            <button type="button" onClick={step.cancel} disabled={deleting} className="btn btn-quiet btn-small">
              Keep it
            </button>
          </span>
        ) : (
          <button type="button" ref={step.triggerRef} onClick={step.arm} className="link-danger">
            Delete
          </button>
        )}
      </div>
      <div className="auto-status">
        <Status assertive className="mt-2 small danger-text">
          {error}
        </Status>
      </div>

      {numbersOpen ? <Numbers id={panelId} row={row} /> : null}
    </li>
  );
}

/** One automation's funnel over 7, 30 or 90 days, the steps it actually has. Shares, never amounts of money. */
function Numbers({ id, row }: { id: string; row: CampaignRow }) {
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const [data, setData] = useState<DashboardView | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setData(null);
    setError("");
    const res = await bridge().workspace.api<DashboardView>(`dashboard?campaign_id=${encodeURIComponent(row.campaign_id)}&days=${days}`);
    if (res.ok) setData(res.data);
    else setError(res.message);
  }, [row.campaign_id, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const c = data?.cards;
  const share = (n: number) => (c && c.comments > 0 ? `${Math.round((n / c.comments) * 100)}% of comments` : undefined);
  const tiles: Array<{ label: string; value: number; sub?: string }> = c
    ? [
        { label: "Comments with a keyword", value: c.comments },
        { label: "DMs sent", value: c.sends, sub: share(c.sends) },
        ...(row.deliver_in_opening ? [] : [{ label: "Tapped the button", value: c.clicks, sub: c.sends > 0 ? `${c.ctr}% of DMs` : undefined }]),
        ...(row.check_follow ? [{ label: "Said they followed", value: c.follows }] : []),
        ...(row.ask_email ? [{ label: "Gave an email", value: c.emails }] : []),
        { label: "Links delivered", value: c.delivered, sub: share(c.delivered) },
      ]
    : [];

  return (
    <div id={id} className="numbers">
      <div className="spread">
        <p className="small bold">Numbers</p>
        <label className="row tiny muted">
          Range
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as (typeof DAYS)[number])} className="select select-inline">
            {DAYS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <p className="mt-3 small danger-text">{error}</p>
      ) : !c ? (
        <p className="mt-3 small muted">Loading…</p>
      ) : (
        <dl>
          {tiles.map((t) => (
            <div key={t.label}>
              <dt>{t.label}</dt>
              <dd className="value">{COUNT.format(t.value)}</dd>
              {t.sub ? <dd className="tiny muted">{t.sub}</dd> : null}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
