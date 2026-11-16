import { ChartColumn, ChevronDown, ExternalLink as ExternalIcon, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { CampaignRow, DashboardView, IgMedia } from "../../shared/types";
import { cn } from "../lib/utils";
import { BusyLabel, ExternalLink, bridge } from "../ui";
import { mediaThumb } from "./AutomationBuilder";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Switch } from "./ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const COUNT = new Intl.NumberFormat("en-US");
const DAYS = [7, 30, 90] as const;

/**
 * One automation in the list: its post, name and keywords, the On switch,
 * and Numbers, Edit and Delete. Delete asks in a dialog in the page. The
 * switch moves at once and moves back if the save fails.
 */
export function AutomationRow({ row, media, onEdit, onChanged }: { row: CampaignRow; media: IgMedia | null; onEdit: () => void; onChanged: () => void }) {
  const [active, setActive] = useState(row.active);
  const [switching, setSwitching] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [numbersOpen, setNumbersOpen] = useState(false);
  const name = row.name || row.campaign_id;
  const thumb = mediaThumb(media);
  const safeId = row.campaign_id.replace(/[^A-Za-z0-9_-]/g, "");
  const panelId = `cm-numbers-${safeId}`;
  const switchId = `cm-on-${safeId}`;

  useEffect(() => setActive(row.active), [row.active]);

  async function toggle(next: boolean) {
    setActive(next);
    setSwitching(true);
    const res = await bridge().workspace.api("campaigns/status", { method: "POST", body: { campaign_id: row.campaign_id, active: next } });
    setSwitching(false);
    if (!res.ok) {
      setActive(!next);
      toast.error(res.message);
    }
  }

  async function remove() {
    setDeleting(true);
    setDeleteError("");
    const res = await bridge().workspace.api("campaigns/delete", { method: "POST", body: { campaign_id: row.campaign_id } });
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(res.message);
      return;
    }
    setConfirmOpen(false);
    toast.success(`Deleted “${name}”.`);
    onChanged();
  }

  return (
    <li data-automation={row.campaign_id} className="grid gap-3 p-4">
      <div className="flex items-start gap-3">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-12 shrink-0 rounded-md border object-cover" />
        ) : (
          <span aria-hidden className="size-12 shrink-0 rounded-md border bg-muted" />
        )}
        <div className="grid min-w-0 flex-1 gap-1.5">
          <p className="truncate font-medium">{name}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Comment</span>
            {row.keywords.map((k) => (
              <Badge key={k} variant="secondary" translate="no">
                {k}
              </Badge>
            ))}
            <span>{row.deliver_in_opening ? "→ DM with the link" : "→ DM with a button, then the link"}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <Switch id={switchId} checked={active} disabled={switching} onCheckedChange={(next) => void toggle(next)} aria-label={`${name} is on`} />
          <Label htmlFor={switchId} className="w-6 font-normal text-muted-foreground">
            {active ? "On" : "Off"}
          </Label>
        </div>
      </div>

      <div className="-ml-2 flex flex-wrap items-center gap-1 sm:ml-13">
        <Button variant="ghost" size="sm" onClick={() => setNumbersOpen((v) => !v)} aria-expanded={numbersOpen} aria-controls={panelId}>
          <ChartColumn aria-hidden />
          Numbers
          <ChevronDown aria-hidden className={cn("transition-transform", numbersOpen && "rotate-180")} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit} data-edit>
          <Pencil aria-hidden />
          Edit
        </Button>
        {media?.permalink ? (
          <Button variant="ghost" size="sm" asChild>
            <ExternalLink href={media.permalink} className="text-foreground hover:no-underline">
              <ExternalIcon aria-hidden />
              Open the post
            </ExternalLink>
          </Button>
        ) : null}
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            if (deleting) return;
            setConfirmOpen(open);
            if (open) setDeleteError("");
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="ml-auto size-8 text-muted-foreground hover:text-destructive" aria-label={`Delete ${name}`} data-delete>
                  <Trash2 aria-hidden />
                </Button>
              </AlertDialogTrigger>
            </TooltipTrigger>
            <TooltipContent>Delete</TooltipContent>
          </Tooltip>
          <AlertDialogContent data-delete-confirm>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
              <AlertDialogDescription>Its numbers go with it. This cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError ? (
              <p role="alert" className="text-destructive">
                {deleteError}
              </p>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Keep it</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={deleting}
                aria-busy={deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                <BusyLabel busy={deleting}>Delete</BusyLabel>
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
    <div id={id} className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:ml-15">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Numbers</p>
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value) as (typeof DAYS)[number])}>
          <SelectTrigger size="sm" aria-label="Range" className="w-36 bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAYS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                Last {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <p className="text-destructive">{error}</p>
      ) : !c ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map((t) => (
            <div key={t.label} className="rounded-md border bg-card px-3 py-2">
              <dt className="text-xs leading-tight text-muted-foreground">{t.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{COUNT.format(t.value)}</dd>
              {t.sub ? <dd className="text-xs text-muted-foreground">{t.sub}</dd> : null}
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
