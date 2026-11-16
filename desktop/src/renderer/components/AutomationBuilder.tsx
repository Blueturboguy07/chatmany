import { useState, type FormEvent } from "react";
import { LINK_TOKEN, campaignFromDraft, deliveryText, draftProblem, splitLines, splitWords, type Draft, type DraftProblem } from "../../shared/campaign";
import type { ConnectedStatus, IgMedia } from "../../shared/types";
import { BusyLabel, Status, bridge, useConfirmStep } from "../ui";
import type { Load } from "./Workspace";

const SHOWN_MEDIA = 12;

function idSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function mediaThumb(m: IgMedia | null | undefined): string | null {
  if (!m) return null;
  // A video's media_url is the video itself; its thumbnail is the picture.
  return m.thumbnail_url || (m.media_type === "VIDEO" ? null : m.media_url) || null;
}

function mediaLabel(m: IgMedia, index: number): string {
  const caption = (m.caption ?? "").replace(/\s+/g, " ").trim();
  const kind = m.media_type === "VIDEO" ? "Reel" : "Post";
  return caption ? `${kind}: ${caption.slice(0, 80)}` : `${kind} ${index + 1}`;
}

/**
 * "New automation" and "Edit": the post, the keywords, the DM and its link,
 * an optional public reply, and an "On" switch, with what the commenter
 * will get beside it as it is typed. Direct delivery is the default: one
 * private reply that carries the link. The two-step flow (a button first,
 * optionally asking for a follow or an email) is under "More options".
 * Closing with unsaved changes asks first, in the page.
 */
export function AutomationBuilder({
  initial,
  media,
  onRetryMedia,
  status,
  onCancel,
  onSaved,
}: {
  initial: Draft;
  media: Load<IgMedia[]>;
  onRetryMedia: () => void;
  status: ConnectedStatus;
  onCancel: () => void;
  onSaved: (name: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const closeStep = useConfirmStep();
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  const editing = Boolean(initial.campaign_id);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (problem) setProblem(null);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    const found = draftProblem(draft);
    setProblem(found);
    setError("");
    if (found) {
      document.getElementById(`cm-${found.field}`)?.focus();
      return;
    }
    const campaign = campaignFromDraft(draft, idSuffix());
    setSaving(true);
    const res = await bridge().workspace.api<{ ok: boolean; campaign_id?: string }>("campaigns", { method: "POST", body: { campaign, active: draft.active } });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSaved(campaign.name ?? campaign.campaign_id);
  }

  function cancel() {
    if (dirty) {
      closeStep.arm();
      return;
    }
    onCancel();
  }

  const items = media.state === "ready" ? media.data : [];
  const shown = showAll ? items : items.slice(0, SHOWN_MEDIA);
  // An older post an automation already watches stays in view when the grid is short.
  const picked = items.find((m) => m.id === draft.media_id);
  if (picked && !shown.includes(picked)) shown.push(picked);
  const selectedMissing = Boolean(draft.media_id) && media.state === "ready" && !items.some((m) => m.id === draft.media_id);
  const invalid = (field: DraftProblem["field"]) => (problem?.field === field ? true : undefined);
  const describe = (field: DraftProblem["field"], help?: string) => [problem?.field === field ? "cm-problem" : null, help].filter(Boolean).join(" ") || undefined;

  return (
    <section id="chatmany-builder" className="card mt-6" aria-labelledby="cm-builder-title" data-builder>
      <h3 id="cm-builder-title" className="bold">
        {editing ? "Edit automation" : "New automation"}
      </h3>

      <form onSubmit={save} noValidate className="builder-grid">
        <div className="stack">
          <fieldset className="bare">
            <legend className="label">1. The post it watches</legend>
            {media.state === "loading" ? (
              <p className="mt-2 small muted">Loading your posts…</p>
            ) : media.state === "error" ? (
              <div className="mt-2 small">
                <p className="danger-text">Your posts didn’t load. {media.message}</p>
                <button type="button" onClick={onRetryMedia} className="btn btn-quiet btn-small mt-2">
                  Try again
                </button>
              </div>
            ) : items.length === 0 ? (
              <p className="mt-2 small muted">This account has no posts yet. Post on Instagram first, then try again.</p>
            ) : (
              <>
                <div id="cm-media" role="radiogroup" aria-label="Pick a post" aria-invalid={invalid("media")} aria-describedby={describe("media")} tabIndex={-1} className="media-grid">
                  {shown.map((m, i) => {
                    const thumb = mediaThumb(m);
                    const selected = m.id === draft.media_id;
                    return (
                      <button key={m.id} type="button" role="radio" aria-checked={selected} aria-label={mediaLabel(m, i)} onClick={() => set("media_id", m.id)} className="media">
                        {thumb ? <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="none">No preview</span>}
                        {selected ? (
                          <span aria-hidden className="tick">
                            ✓
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                {items.length > SHOWN_MEDIA ? (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className="link small mt-2">
                    {showAll ? "Show fewer" : `Show all ${items.length}`}
                  </button>
                ) : null}
                {selectedMissing ? <p className="help">The post this automation watches is older than your {items.length} most recent. It stays picked.</p> : null}
              </>
            )}
          </fieldset>

          <div>
            <label htmlFor="cm-keywords" className="label">
              2. Keywords
            </label>
            <input
              id="cm-keywords"
              value={draft.keywords}
              onChange={(e) => set("keywords", e.target.value)}
              placeholder="LINK, GUIDE"
              autoComplete="off"
              aria-invalid={invalid("keywords")}
              aria-describedby={describe("keywords", "cm-keywords-help")}
              className="input"
            />
            <p id="cm-keywords-help" className="help">
              Separate them with commas. A comment that has one of these words gets the DM. Capital letters do not matter.
            </p>
          </div>

          <div>
            <label htmlFor="cm-dm_text" className="label">
              3. The DM they get
            </label>
            <textarea
              id="cm-dm_text"
              value={draft.dm_text}
              onChange={(e) => set("dm_text", e.target.value)}
              rows={3}
              aria-invalid={invalid("dm_text")}
              aria-describedby={describe("dm_text", "cm-dm-help")}
              className="input"
            />
            <p id="cm-dm-help" className="help">
              The link goes at the end. To put it somewhere else, type <code className="ink">{LINK_TOKEN}</code> where it goes.
            </p>
          </div>

          <div>
            <label htmlFor="cm-link" className="label">
              4. The link
            </label>
            <input
              id="cm-link"
              type="url"
              inputMode="url"
              value={draft.link}
              onChange={(e) => set("link", e.target.value)}
              placeholder="https://"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={invalid("link")}
              aria-describedby={describe("link")}
              className="input"
            />
          </div>

          <div>
            <label className="switch">
              <input type="checkbox" role="switch" checked={draft.public_reply_enabled} onChange={(e) => set("public_reply_enabled", e.target.checked)} />
              Also reply under their comment
            </label>
            {draft.public_reply_enabled ? (
              <>
                <textarea
                  id="cm-public_reply"
                  value={draft.public_reply_text}
                  onChange={(e) => set("public_reply_text", e.target.value)}
                  rows={2}
                  aria-label="Public replies, one per line"
                  aria-invalid={invalid("public_reply")}
                  aria-describedby={describe("public_reply", "cm-reply-help")}
                  className="input"
                />
                <p id="cm-reply-help" className="help">
                  One reply per line. Each comment gets one of them, only after the DM is sent.
                </p>
              </>
            ) : null}
          </div>

          {/* Open from the start for an automation saved with the button flow, and from then on only by hand. */}
          <details className="more" open={initial.direct ? undefined : true}>
            <summary>More options</summary>
            <div className="stack mt-4">
              <div>
                <label htmlFor="cm-exclude" className="label">
                  Words to skip
                </label>
                <input id="cm-exclude" value={draft.exclude} onChange={(e) => set("exclude", e.target.value)} placeholder="scam, fake" autoComplete="off" aria-describedby="cm-exclude-help" className="input" />
                <p id="cm-exclude-help" className="help">
                  A comment with one of these words gets no DM, even with a keyword in it.
                </p>
              </div>

              <div>
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.direct}
                    onChange={(e) => {
                      const direct = e.target.checked;
                      // Direct delivery leaves no tap for the follow and email asks to wait on.
                      setDraft((d) => ({ ...d, direct, check_follow: direct ? false : d.check_follow, ask_email: direct ? false : d.ask_email }));
                    }}
                    aria-describedby="cm-direct-help"
                  />
                  Send the link straight away
                </label>
                <p id="cm-direct-help" className="help">
                  On: one DM with the link in it. Off: a first DM with a button, and the link after they tap it.
                </p>
              </div>

              {draft.direct ? null : (
                <div className="stack indent">
                  <div>
                    <label htmlFor="cm-opening" className="label">
                      First DM
                    </label>
                    <textarea id="cm-opening" value={draft.opening} onChange={(e) => set("opening", e.target.value)} rows={2} aria-invalid={invalid("opening")} aria-describedby={describe("opening")} className="input" />
                  </div>
                  <div>
                    <label htmlFor="cm-opening-button" className="label">
                      Button
                    </label>
                    <input id="cm-opening-button" value={draft.opening_button} onChange={(e) => set("opening_button", e.target.value)} className="input" />
                  </div>
                  <div>
                    <label className="switch">
                      <input type="checkbox" role="switch" checked={draft.check_follow} onChange={(e) => set("check_follow", e.target.checked)} />
                      Ask them to follow you first
                    </label>
                    {draft.check_follow ? (
                      <>
                        <textarea value={draft.follow_gate} onChange={(e) => set("follow_gate", e.target.value)} rows={2} aria-label="Follow message" className="input" />
                        <input value={draft.follow_button} onChange={(e) => set("follow_button", e.target.value)} aria-label="Follow button" className="input" />
                        <p className="help">Instagram cannot confirm a follow. The person taps the button to say they followed.</p>
                      </>
                    ) : null}
                  </div>
                  <div>
                    <label className="switch">
                      <input type="checkbox" role="switch" checked={draft.ask_email} onChange={(e) => set("ask_email", e.target.checked)} />
                      Ask for their email
                    </label>
                    {draft.ask_email ? <textarea value={draft.email_ask} onChange={(e) => set("email_ask", e.target.value)} rows={2} aria-label="Email message" className="input" /> : null}
                  </div>
                </div>
              )}
            </div>
          </details>

          <div>
            <label htmlFor="cm-name" className="label">
              Name <span className="muted">(only you see it)</span>
            </label>
            <input id="cm-name" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={`Comment ${splitWords(draft.keywords)[0] ?? "keyword"}`} autoComplete="off" className="input" />
          </div>

          <div>
            <label className="switch">
              <input type="checkbox" role="switch" checked={draft.active} onChange={(e) => set("active", e.target.checked)} aria-describedby="cm-active-help" />
              On
            </label>
            <p id="cm-active-help" className="help">
              {draft.active ? "publik answers new comments on this post as soon as you save." : "Saved, but publik does not answer comments until you turn it on."}
            </p>
          </div>

          <div>
            <Status assertive id="cm-problem" className="small danger-text">
              {problem?.message ?? error}
            </Status>
            {closeStep.armed ? (
              <div className="row mt-3" onKeyDown={closeStep.onKeyDown} data-close-confirm>
                <span className="small muted">Close the automation without saving your changes?</span>
                <button type="button" ref={closeStep.confirmRef} onClick={onCancel} className="btn btn-danger btn-small">
                  Close without saving
                </button>
                <button type="button" onClick={closeStep.cancel} className="btn btn-quiet btn-small">
                  Keep editing
                </button>
              </div>
            ) : (
              <div className="row mt-3">
                <button type="submit" disabled={saving} aria-busy={saving} className="btn btn-primary" data-save>
                  <BusyLabel busy={saving}>{editing ? "Save changes" : "Save automation"}</BusyLabel>
                </button>
                <button type="button" ref={closeStep.triggerRef} onClick={cancel} disabled={saving} className="btn btn-quiet">
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>

        <Preview draft={draft} status={status} media={items.find((m) => m.id === draft.media_id) ?? null} />
      </form>
    </section>
  );
}

/** What the commenter sees, in order: their comment, the public reply, then the DMs. */
function Preview({ draft, status, media }: { draft: Draft; status: ConnectedStatus; media: IgMedia | null }) {
  const you = status.username ?? "you";
  const keyword = splitWords(draft.keywords)[0] ?? "LINK";
  const reply = draft.public_reply_enabled ? splitLines(draft.public_reply_text)[0] : undefined;
  const thumb = mediaThumb(media);

  return (
    <aside aria-labelledby="cm-preview-title" data-preview>
      <div className="preview-sticky">
        <h4 id="cm-preview-title" className="small bold">
          What they get
        </h4>
        <div className="preview">
          <p className="tiny bold muted">On your post</p>
          <div className="row mt-2">
            {thumb ? <img src={thumb} alt="" referrerPolicy="no-referrer" className="thumb" /> : <span aria-hidden className="thumb" />}
            <div className="small break">
              <p>
                <b>someone</b> {keyword}
              </p>
              {reply ? (
                <p className="mt-1 muted">
                  <b className="ink" translate="no">
                    {you}
                  </b>{" "}
                  {reply}
                </p>
              ) : null}
            </div>
          </div>

          <p className="tiny bold muted mt-4">In their DMs, from @{you}</p>
          <div className="bubbles">
            {draft.direct ? (
              <p className="bubble bubble-ours">{deliveryText(draft)}</p>
            ) : (
              <>
                <p className="bubble bubble-ours">{draft.opening.trim() || "…"}</p>
                <span className="chip">{draft.opening_button.trim() || "Continue"}</span>
                <p className="bubble bubble-theirs">{draft.opening_button.trim() || "Continue"}</p>
                {draft.check_follow ? (
                  <>
                    <p className="bubble bubble-ours">{draft.follow_gate.trim() || "…"}</p>
                    <p className="bubble bubble-theirs">{draft.follow_button.trim() || "I followed"}</p>
                  </>
                ) : null}
                {draft.ask_email ? (
                  <>
                    <p className="bubble bubble-ours">{draft.email_ask.trim() || "…"}</p>
                    <p className="bubble bubble-theirs">you@example.com</p>
                  </>
                ) : null}
                <p className="bubble bubble-ours">{deliveryText(draft)}</p>
              </>
            )}
          </div>
          {!draft.active ? <p className="mt-4 tiny bold muted">Off: nothing is sent until you turn it on.</p> : null}
        </div>
      </div>
    </aside>
  );
}
