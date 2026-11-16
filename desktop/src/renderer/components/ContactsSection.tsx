import { useCallback, useEffect, useState } from "react";
import { contactStateWords } from "../../shared/messages";
import type { CampaignRow, ContactView } from "../../shared/types";
import { BusyLabel, Status, bridge } from "../ui";

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/**
 * Everyone who commented a keyword, per automation or all of them, with a
 * CSV download of the same list. The download is made by the main process,
 * which then asks where to save the file.
 */
export function ContactsSection({ campaigns }: { campaigns: readonly CampaignRow[] }) {
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<ContactView[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    setError("");
    const query = filter ? `?campaign_id=${encodeURIComponent(filter)}` : "";
    const res = await bridge().workspace.api<{ contacts?: ContactView[] }>(`contacts${query}`);
    if (res.ok) setRows(res.data.contacts ?? []);
    else setError(res.message);
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download() {
    setSaving(true);
    setSaveNote(null);
    const res = await bridge().workspace.exportCsv(filter || null);
    setSaving(false);
    if (!res.ok) setSaveNote({ tone: "error", text: res.message });
    else if (res.saved) setSaveNote({ tone: "ok", text: "Saved the CSV file." });
  }

  const names = new Map(campaigns.map((c) => [c.campaign_id, c.name || c.campaign_id]));

  return (
    <section className="mt-12" aria-labelledby="contacts-title" data-contacts>
      <div className="spread">
        <div>
          <h2 id="contacts-title" className="h2">
            People
          </h2>
          <p className="mt-2 small muted">Everyone who commented a keyword, and how far they got.</p>
        </div>
        <div className="row">
          <label className="row tiny muted">
            <span className="sr-only">Show people from</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show people from" className="select select-inline">
              <option value="">All automations</option>
              {campaigns.map((c) => (
                <option key={c.campaign_id} value={c.campaign_id}>
                  {c.name || c.campaign_id}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void load()} className="btn btn-quiet btn-small">
            Refresh
          </button>
          <button type="button" onClick={() => void download()} disabled={saving} aria-busy={saving} className="btn btn-quiet btn-small" data-export>
            <BusyLabel busy={saving}>Download CSV</BusyLabel>
          </button>
        </div>
      </div>
      <Status assertive={saveNote?.tone === "error"} className={`mt-2 small ${saveNote?.tone === "error" ? "danger-text" : "ok-text"}`}>
        {saveNote?.text ?? ""}
      </Status>

      {error ? (
        <div className="plain mt-6">
          <p className="small danger-text">{error}</p>
          <button type="button" onClick={() => void load()} className="btn btn-quiet mt-3">
            Try again
          </button>
        </div>
      ) : rows === null ? (
        <p className="mt-6 small muted">Loading people…</p>
      ) : rows.length === 0 ? (
        <div className="plain mt-6">
          <p>No one yet.</p>
          <p className="mt-1 small muted">When someone comments a keyword, they show up here.</p>
        </div>
      ) : (
        // The one element allowed to be wider than the window: it scrolls in its own box.
        <div className="table-box" tabIndex={0} role="region" aria-label="People">
          <table>
            <caption className="sr-only">People who commented a keyword</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Automation</th>
                <th scope="col">Where they are</th>
                <th scope="col">Followed</th>
                <th scope="col">Email</th>
                <th scope="col">Last change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.campaign_id}:${r.igsid}`}>
                  <td className="bold" translate="no">
                    {r.username ? `@${r.username}` : <span className="muted">Name not shared</span>}
                  </td>
                  <td className="muted">{names.get(r.campaign_id) ?? r.campaign_id}</td>
                  <td>{contactStateWords(r)}</td>
                  <td className="muted">{r.followed ? "Yes" : "—"}</td>
                  <td className="muted break">{r.email ?? "—"}</td>
                  <td className="muted nowrap">{DAY.format(new Date(r.updated_at * 1000))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
