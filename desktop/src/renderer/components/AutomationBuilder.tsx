import { Check, ChevronRight, RotateCw } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { LINK_TOKEN, campaignFromDraft, deliveryText, draftProblem, splitLines, splitWords, type Draft, type DraftProblem } from "../../shared/campaign";
import type { ConnectedStatus, IgMedia } from "../../shared/types";
import { cn } from "../lib/utils";
import { BusyLabel, Status, bridge } from "../ui";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
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
 * an optional public reply, and an "On" switch. On a wide window the form is
 * on the left and what the commenter gets is on the right, as a phone chat,
 * updated as it is typed. Save and Cancel stay in view at the bottom.
 * Direct delivery is the default: one private reply that carries the link.
 * The two-step flow (a button first, optionally asking for a follow or an
 * email) is under "More options". Closing with unsaved changes asks first,
 * in a dialog in the page.
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
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [closing, setClosing] = useState(false);
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
    if (found) {
      document.getElementById(`cm-${found.field}`)?.focus();
      return;
    }
    const campaign = campaignFromDraft(draft, idSuffix());
    setSaving(true);
    const res = await bridge().workspace.api<{ ok: boolean; campaign_id?: string }>("campaigns", { method: "POST", body: { campaign, active: draft.active } });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.message);
      return;
    }
    onSaved(campaign.name ?? campaign.campaign_id);
  }

  function cancel() {
    if (dirty) setClosing(true);
    else onCancel();
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
    <Card id="chatmany-builder" className="gap-0 py-0" role="region" aria-labelledby="cm-builder-title" data-builder>
      <form onSubmit={save} noValidate>
        <div className="grid gap-0.5 border-b px-4 py-3">
          <h2 id="cm-builder-title" className="text-base font-semibold">
            {editing ? "Edit automation" : "New automation"}
          </h2>
          <p className="text-xs text-muted-foreground">Pick a post, a keyword and the link to send.</p>
        </div>

        <div className="grid gap-6 p-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
          <div className="grid content-start gap-5">
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">The post it watches</legend>
              {media.state === "loading" ? (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="aspect-square" />
                  ))}
                </div>
              ) : media.state === "error" ? (
                <MediaNote text={`Your posts didn’t load. ${media.message}`} onRetry={onRetryMedia} />
              ) : items.length === 0 ? (
                <MediaNote text="This account has no posts yet. Post on Instagram first, then try again." onRetry={onRetryMedia} />
              ) : (
                <>
                  <div
                    id="cm-media"
                    role="radiogroup"
                    aria-label="Pick a post"
                    aria-invalid={invalid("media")}
                    aria-describedby={describe("media")}
                    tabIndex={-1}
                    className="grid grid-cols-4 gap-2 rounded-md outline-none sm:grid-cols-6"
                    data-post-picker
                  >
                    {shown.map((m, i) => {
                      const thumb = mediaThumb(m);
                      const selected = m.id === draft.media_id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={mediaLabel(m, i)}
                          onClick={() => set("media_id", m.id)}
                          className={cn(
                            "relative aspect-square overflow-hidden rounded-md border bg-muted outline-none transition-shadow focus-visible:ring-[3px] focus-visible:ring-ring/50",
                            selected ? "ring-2 ring-primary ring-offset-2 ring-offset-card" : "hover:opacity-90",
                          )}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
                          ) : (
                            <span className="grid size-full place-items-center p-1 text-center text-[11px] text-muted-foreground">No preview</span>
                          )}
                          {selected ? (
                            <span aria-hidden className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm">
                              <Check className="size-3" strokeWidth={3} />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  {items.length > SHOWN_MEDIA ? (
                    <Button type="button" variant="link" size="sm" className="h-auto justify-self-start px-0" onClick={() => setShowAll((v) => !v)}>
                      {showAll ? "Show fewer" : `Show all ${items.length}`}
                    </Button>
                  ) : null}
                  {selectedMissing ? <Help>The post this automation watches is older than your {items.length} most recent. It stays picked.</Help> : null}
                </>
              )}
            </fieldset>

            <Field id="cm-keywords" label="Keywords" help="Separate them with commas. A comment that has one of these words gets the DM. Capital letters do not matter.">
              <Input
                id="cm-keywords"
                value={draft.keywords}
                onChange={(e) => set("keywords", e.target.value)}
                placeholder="LINK, GUIDE"
                autoComplete="off"
                aria-invalid={invalid("keywords")}
                aria-describedby={describe("keywords", "cm-keywords-help")}
              />
            </Field>

            <Field
              id="cm-dm_text"
              helpId="cm-dm-help"
              label="The DM they get"
              help={
                <>
                  The link goes at the end. To put it somewhere else, type <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">{LINK_TOKEN}</code> where it goes.
                </>
              }
            >
              <Textarea id="cm-dm_text" value={draft.dm_text} onChange={(e) => set("dm_text", e.target.value)} rows={3} aria-invalid={invalid("dm_text")} aria-describedby={describe("dm_text", "cm-dm-help")} />
            </Field>

            <Field id="cm-link" label="The link">
              <Input
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
              />
            </Field>

            <div className="grid gap-2">
              <SwitchRow id="cm-public-reply-on" checked={draft.public_reply_enabled} onChange={(on) => set("public_reply_enabled", on)} label="Also reply under their comment" />
              {draft.public_reply_enabled ? (
                <div className="grid gap-1.5 pl-11">
                  <Textarea
                    id="cm-public_reply"
                    value={draft.public_reply_text}
                    onChange={(e) => set("public_reply_text", e.target.value)}
                    rows={2}
                    aria-label="Public replies, one per line"
                    aria-invalid={invalid("public_reply")}
                    aria-describedby={describe("public_reply", "cm-reply-help")}
                  />
                  <Help id="cm-reply-help">One reply per line. Each comment gets one of them, only after the DM is sent.</Help>
                </div>
              ) : null}
            </div>

            {/* Open from the start for an automation saved with the button flow, and from then on only by hand. */}
            <details className="group rounded-lg border" open={initial.direct ? undefined : true}>
              <summary className="flex list-none items-center gap-2 rounded-lg px-3 py-2.5 font-medium select-none hover:bg-accent/60 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                More options
              </summary>
              <div className="grid gap-5 border-t p-3">
                <Field id="cm-exclude" label="Words to skip" help="A comment with one of these words gets no DM, even with a keyword in it.">
                  <Input id="cm-exclude" value={draft.exclude} onChange={(e) => set("exclude", e.target.value)} placeholder="scam, fake" autoComplete="off" aria-describedby="cm-exclude-help" />
                </Field>

                <SwitchRow
                  id="cm-direct"
                  checked={draft.direct}
                  onChange={(direct) => {
                    // Direct delivery leaves no tap for the follow and email asks to wait on.
                    setDraft((d) => ({ ...d, direct, check_follow: direct ? false : d.check_follow, ask_email: direct ? false : d.ask_email }));
                  }}
                  label="Send the link straight away"
                  help="On: one DM with the link in it. Off: a first DM with a button, and the link after they tap it."
                />

                {draft.direct ? null : (
                  <div className="grid gap-5 border-l-2 pl-4">
                    <Field id="cm-opening" label="First DM">
                      <Textarea id="cm-opening" value={draft.opening} onChange={(e) => set("opening", e.target.value)} rows={2} aria-invalid={invalid("opening")} aria-describedby={describe("opening")} />
                    </Field>
                    <Field id="cm-opening-button" label="Button">
                      <Input id="cm-opening-button" value={draft.opening_button} onChange={(e) => set("opening_button", e.target.value)} />
                    </Field>
                    <div className="grid gap-2">
                      <SwitchRow id="cm-check-follow" checked={draft.check_follow} onChange={(on) => set("check_follow", on)} label="Ask them to follow you first" />
                      {draft.check_follow ? (
                        <div className="grid gap-2 pl-11">
                          <Textarea value={draft.follow_gate} onChange={(e) => set("follow_gate", e.target.value)} rows={2} aria-label="Follow message" />
                          <Input value={draft.follow_button} onChange={(e) => set("follow_button", e.target.value)} aria-label="Follow button" />
                          <Help>Instagram cannot confirm a follow. The person taps the button to say they followed.</Help>
                        </div>
                      ) : null}
                    </div>
                    <div className="grid gap-2">
                      <SwitchRow id="cm-ask-email" checked={draft.ask_email} onChange={(on) => set("ask_email", on)} label="Ask for their email" />
                      {draft.ask_email ? (
                        <div className="pl-11">
                          <Textarea value={draft.email_ask} onChange={(e) => set("email_ask", e.target.value)} rows={2} aria-label="Email message" />
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </details>

            <Field id="cm-name" label="Name" hint="(only you see it)">
              <Input id="cm-name" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder={`Comment ${splitWords(draft.keywords)[0] ?? "keyword"}`} autoComplete="off" />
            </Field>

            <SwitchRow
              id="cm-active"
              checked={draft.active}
              onChange={(on) => set("active", on)}
              label="On"
              help={draft.active ? "publik answers new comments on this post as soon as you save." : "Saved, but publik does not answer comments until you turn it on."}
            />
          </div>

          <Preview draft={draft} status={status} media={items.find((m) => m.id === draft.media_id) ?? null} />
        </div>

        {/* Save stays in view at the bottom of the window while the form scrolls. */}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t bg-card px-4 py-3" data-builder-footer>
          <div className="mr-auto min-w-0 flex-1">
            <Status assertive id="cm-problem" className="text-destructive">
              {problem?.message}
            </Status>
          </div>
          <Button type="button" variant="outline" onClick={cancel} disabled={saving} data-builder-cancel>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} aria-busy={saving} data-save>
            <BusyLabel busy={saving}>{editing ? "Save changes" : "Save automation"}</BusyLabel>
          </Button>
        </div>
      </form>

      <AlertDialog open={closing} onOpenChange={setClosing}>
        <AlertDialogContent data-close-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>Close without saving?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to this automation are not saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onCancel} data-close-discard>
              Close without saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Help({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}

function Field({ id, label, hint, help, helpId, children }: { id: string; label: string; hint?: string; help?: ReactNode; helpId?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>
        {label}
        {hint ? <span className="font-normal text-muted-foreground">{hint}</span> : null}
      </Label>
      {children}
      {help ? <Help id={helpId ?? `${id}-help`}>{help}</Help> : null}
    </div>
  );
}

function SwitchRow({ id, checked, onChange, label, help }: { id: string; checked: boolean; onChange: (on: boolean) => void; label: string; help?: string }) {
  return (
    <div className="flex items-start gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={help ? `${id}-help` : undefined} className="mt-0.5" />
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        {help ? <Help id={`${id}-help`}>{help}</Help> : null}
      </div>
    </div>
  );
}

function MediaNote({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="grid justify-items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center">
      <p className="text-muted-foreground">{text}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}

/** What the commenter sees, in order: their comment, the public reply, then the DMs, as a phone chat. */
function Preview({ draft, status, media }: { draft: Draft; status: ConnectedStatus; media: IgMedia | null }) {
  const you = status.username ?? "you";
  const keyword = splitWords(draft.keywords)[0] ?? "LINK";
  const reply = draft.public_reply_enabled ? splitLines(draft.public_reply_text)[0] : undefined;
  const thumb = mediaThumb(media);
  const button = draft.opening_button.trim() || "Continue";

  return (
    <aside aria-labelledby="cm-preview-title" className="grid content-start gap-2 self-start md:sticky md:top-16" data-preview>
      <h3 id="cm-preview-title" className="text-xs font-medium text-muted-foreground">
        What they get
      </h3>
      <div className="overflow-hidden rounded-[2rem] border-[6px] border-phone bg-background shadow-sm">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <span aria-hidden className="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {you.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-semibold" translate="no">
              {you}
            </p>
            <p className="text-[11px] text-muted-foreground">Instagram</p>
          </div>
        </div>

        <div className="grid gap-3 p-3 text-xs">
          <div className="rounded-xl bg-muted/60 p-2.5">
            <p className="text-[11px] font-medium text-muted-foreground">On your post</p>
            <div className="mt-1.5 flex gap-2">
              {thumb ? <img src={thumb} alt="" referrerPolicy="no-referrer" className="size-9 shrink-0 rounded object-cover" /> : <span aria-hidden className="size-9 shrink-0 rounded bg-muted" />}
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <p>
                  <b className="font-semibold">someone</b> {keyword}
                </p>
                {reply ? (
                  <p className="mt-1 text-muted-foreground">
                    <b className="font-semibold text-foreground" translate="no">
                      {you}
                    </b>{" "}
                    {reply}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <p className="text-center text-[11px] text-muted-foreground">In their DMs, from @{you}</p>
          <div className="grid gap-1.5">
            {draft.direct ? (
              <Bubble from="you">{deliveryText(draft)}</Bubble>
            ) : (
              <>
                <Bubble from="you">{draft.opening.trim() || "…"}</Bubble>
                <span className="max-w-[80%] justify-self-start rounded-xl border bg-background px-3 py-1.5 text-center font-medium text-primary">{button}</span>
                <Bubble from="them">{button}</Bubble>
                {draft.check_follow ? (
                  <>
                    <Bubble from="you">{draft.follow_gate.trim() || "…"}</Bubble>
                    <Bubble from="them">{draft.follow_button.trim() || "I followed"}</Bubble>
                  </>
                ) : null}
                {draft.ask_email ? (
                  <>
                    <Bubble from="you">{draft.email_ask.trim() || "…"}</Bubble>
                    <Bubble from="them">you@example.com</Bubble>
                  </>
                ) : null}
                <Bubble from="you">{deliveryText(draft)}</Bubble>
              </>
            )}
          </div>
          {!draft.active ? <p className="text-center text-[11px] font-medium text-muted-foreground">Off: nothing is sent until you turn it on.</p> : null}
        </div>
      </div>
    </aside>
  );
}

/** One chat message: yours on the left (as the commenter sees it), theirs on the right. */
function Bubble({ from, children }: { from: "you" | "them"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "max-w-[80%] rounded-2xl px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]",
        from === "you" ? "justify-self-start rounded-bl-md bg-muted" : "justify-self-end rounded-br-md bg-primary text-primary-foreground",
      )}
    >
      {children}
    </p>
  );
}
