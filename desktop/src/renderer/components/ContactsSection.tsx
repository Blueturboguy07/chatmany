import { Download, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { contactStateWords } from "../../shared/messages";
import type { CampaignRow, ContactView } from "../../shared/types";
import { BusyLabel, bridge } from "../ui";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const ALL = "all";

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
    const res = await bridge().workspace.exportCsv(filter || null);
    setSaving(false);
    if (!res.ok) toast.error(res.message);
    else if (res.saved) toast.success("Saved the CSV file.");
  }

  const names = new Map(campaigns.map((c) => [c.campaign_id, c.name || c.campaign_id]));
  const hasRows = rows !== null && rows.length > 0;

  return (
    <section className="grid gap-3" aria-labelledby="contacts-title" data-contacts>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 id="contacts-title" className="text-base font-semibold">
            People
          </h2>
          <p className="text-muted-foreground">Everyone who commented a keyword, and how far they got.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter || ALL} onValueChange={(value) => setFilter(value === ALL ? "" : value)}>
            <SelectTrigger size="sm" aria-label="Show people from" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All automations</SelectItem>
              {campaigns.map((c) => (
                <SelectItem key={c.campaign_id} value={c.campaign_id}>
                  {c.name || c.campaign_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasRows ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" className="size-8" onClick={() => void load()} aria-label="Refresh">
                  <RotateCw aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Refresh</TooltipContent>
            </Tooltip>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void download()} disabled={saving} aria-busy={saving} data-export>
            <BusyLabel busy={saving} icon={<Download aria-hidden />}>
              Download CSV
            </BusyLabel>
          </Button>
        </div>
      </div>

      {error ? (
        <EmptyState text={`The people list didn’t load. ${error}`}>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCw aria-hidden />
            Try again
          </Button>
        </EmptyState>
      ) : rows === null ? (
        <Card className="gap-0 py-0" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b px-3 py-3 last:border-0">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState text="No one yet. When someone comments a keyword, they show up here.">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCw aria-hidden />
            Refresh
          </Button>
        </EmptyState>
      ) : (
        // The one element allowed to be wider than the window: it scrolls in its own box.
        <Card className="gap-0 overflow-hidden py-0">
          <div tabIndex={0} role="region" aria-label="People" className="outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Table>
              <TableCaption className="sr-only">People who commented a keyword</TableCaption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Person</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead>Where they are</TableHead>
                  <TableHead>Followed</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Last change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.campaign_id}:${r.igsid}`}>
                    <TableCell className="font-medium" translate="no">
                      {r.username ? `@${r.username}` : <span className="font-normal text-muted-foreground">Name not shared</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{names.get(r.campaign_id) ?? r.campaign_id}</TableCell>
                    <TableCell>{contactStateWords(r)}</TableCell>
                    <TableCell className="text-muted-foreground">{r.followed ? "Yes" : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{r.email ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{DAY.format(new Date(r.updated_at * 1000))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </section>
  );
}
