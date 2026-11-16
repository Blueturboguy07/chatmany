import { CircleAlert, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { AppBilling } from "../../shared/bridge";
import { draftFromCampaign, newDraft, type Draft } from "../../shared/campaign";
import { accountTypeLabel } from "../../shared/messages";
import type { CampaignRow, ConnectedStatus, DashboardView, IgMedia } from "../../shared/types";
import { BusyLabel, ExternalLink, bridge } from "../ui";
import { AutomationBuilder } from "./AutomationBuilder";
import { AutomationRow } from "./AutomationRow";
import { ContactsSection } from "./ContactsSection";
import { DisconnectSection } from "./DisconnectSection";
import { EmptyState } from "./EmptyState";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Progress } from "./ui/progress";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "error"; message: string };

export type Tab = "automations" | "people" | "account";

const COUNT = new Intl.NumberFormat("en-US");
const WALLET_URL = "https://publikhq.com/wallet";

/**
 * The connected view: whose account it is and three tabs. Automations: the
 * last 30 days in three numbers and the automations (the builder takes the
 * tab while one is open). People: everyone who came through, with the CSV.
 * Account: what chatmany uses of the publik plan, and the way out. A paused
 * connection or an empty balance shows above the tabs, on every tab.
 */
export function Workspace({
  status,
  billing = null,
  onReconnect,
  reconnecting,
  onDisconnected,
  initialTab = "automations",
}: {
  status: ConnectedStatus;
  billing?: AppBilling | null;
  onReconnect: () => void;
  reconnecting: boolean;
  onDisconnected: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [media, setMedia] = useState<Load<IgMedia[]>>({ state: "loading" });
  const [campaigns, setCampaigns] = useState<Load<CampaignRow[]>>({ state: "loading" });
  const [summary, setSummary] = useState<Load<DashboardView>>({ state: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);

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
  const empty = campaigns.state === "ready" && rows.length === 0;

  function open(next: Draft) {
    setDraft(next);
    setTab("automations");
    window.scrollTo({ top: 0 });
  }

  const trigger = (value: Tab, label: string) => (
    // onClick as well as Radix's own handlers, so a plain click() (the smoke test's) switches too.
    <TabsTrigger value={value} onClick={() => setTab(value)} data-tab={value}>
      {label}
    </TabsTrigger>
  );

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="gap-4" data-workspace>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AccountHeader status={status} />
        <TabsList className="w-full sm:w-fit">
          {trigger("automations", "Automations")}
          {trigger("people", "People")}
          {trigger("account", "Account")}
        </TabsList>
      </div>

      {status.token_expired ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Instagram ended this connection, so your automations are paused.</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" className="mt-1 text-foreground" onClick={onReconnect} disabled={reconnecting} aria-busy={reconnecting}>
              <BusyLabel busy={reconnecting}>Connect Instagram again</BusyLabel>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {billing && !billing.can_pay && billing.notice ? <NoBalanceNotice notice={billing.notice} /> : null}

      <TabsContent value="automations" className="grid gap-6">
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
              toast.success(`Saved “${name}”.`);
              void loadCampaigns();
              void loadSummary();
            }}
          />
        ) : (
          <>
            <SummaryTiles summary={summary} />
            <section className="grid gap-3" aria-labelledby="automations-title">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="grid gap-0.5">
                  <h2 id="automations-title" className="text-base font-semibold">
                    Automations
                  </h2>
                  <p className="text-muted-foreground">Each one watches one post for a keyword and sends one DM.</p>
                </div>
                {empty ? null : (
                  <Button onClick={() => open(newDraft())} data-new-automation>
                    <Plus aria-hidden />
                    New automation
                  </Button>
                )}
              </div>

              {campaigns.state === "loading" ? (
                <Card className="gap-0 py-0" aria-busy="true">
                  {[0, 1].map((i) => (
                    <div key={i} className="flex items-center gap-3 border-b p-4 last:border-0">
                      <Skeleton className="size-12" />
                      <div className="grid flex-1 gap-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-56 max-w-full" />
                      </div>
                    </div>
                  ))}
                </Card>
              ) : campaigns.state === "error" ? (
                <EmptyState text={`Your automations didn’t load. ${campaigns.message}`}>
                  <Button variant="outline" size="sm" onClick={() => void loadCampaigns()}>
                    <RotateCw aria-hidden />
                    Try again
                  </Button>
                </EmptyState>
              ) : empty ? (
                <EmptyState text="No automations yet. Make one: pick a post, a keyword and the link to send.">
                  <Button size="sm" onClick={() => open(newDraft())} data-new-automation>
                    <Plus aria-hidden />
                    New automation
                  </Button>
                </EmptyState>
              ) : (
                <Card className="gap-0 py-0">
                  <ul className="divide-y">
                    {rows.map((row) => (
                      <AutomationRow
                        key={row.campaign_id}
                        row={row}
                        media={mediaById.get(row.media_id) ?? null}
                        onEdit={() => open(draftFromCampaign(row))}
                        onChanged={() => {
                          void loadCampaigns();
                          void loadSummary();
                        }}
                      />
                    ))}
                  </ul>
                </Card>
              )}
            </section>
          </>
        )}
      </TabsContent>

      <TabsContent value="people">
        <ContactsSection campaigns={rows} />
      </TabsContent>

      <TabsContent value="account" className="grid gap-4">
        {billing ? <HostingUsage billing={billing} /> : null}
        <DisconnectSection username={status.username} onDisconnected={onDisconnected} />
        <p className="flex gap-4 text-xs">
          <ExternalLink href="https://publikhq.com/privacy#chatmany" className="text-muted-foreground hover:text-foreground">
            What publik keeps
          </ExternalLink>
          <ExternalLink href="https://publikhq.com/data-deletion#chatmany" className="text-muted-foreground hover:text-foreground">
            Data deletion
          </ExternalLink>
        </p>
      </TabsContent>
    </Tabs>
  );
}

function AccountHeader({ status }: { status: ConnectedStatus }) {
  const name = status.username ? `@${status.username}` : "Your Instagram account";
  return (
    <div className="flex min-w-0 items-center gap-3">
      {status.profile_picture_url ? (
        <img src={status.profile_picture_url} alt="" width={36} height={36} referrerPolicy="no-referrer" className="size-9 shrink-0 rounded-full border object-cover" />
      ) : (
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full border bg-muted font-semibold text-muted-foreground">
          {(status.username ?? "?").slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate font-medium" translate="no">
          {name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{accountTypeLabel(status.account_type)} · connected to publik</p>
      </div>
      {status.token_expired ? (
        <Badge variant="destructive">Paused</Badge>
      ) : (
        <Badge variant="outline" className="text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          Connected
        </Badge>
      )}
    </div>
  );
}

/** The publik balance cannot pay: the hosted service sends nothing. publik's words, with the way out. */
function NoBalanceNotice({ notice }: { notice: { title: string; body: string } }) {
  return (
    <Alert variant="destructive" data-chatmany-no-balance>
      <CircleAlert aria-hidden />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        <p>{notice.body}</p>
        <ExternalLink href={WALLET_URL} className="text-destructive underline">
          Open your wallet
        </ExternalLink>
      </AlertDescription>
    </Alert>
  );
}

/** A share 0..1 as a percent with at most one decimal, for the bar. */
const percent = (share: number) => Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10;

/**
 * What chatmany used of the plan's monthly limit, as shares and publik's
 * sentences (never an amount): chatmany's part of the bar first, the other
 * apps' part after it. Without a plan, the prepaid sentence alone.
 */
function HostingUsage({ billing }: { billing: AppBilling }) {
  const { usage } = billing;
  const hosting = usage.hosting_share;
  const others = hosting !== null && usage.used_share !== null ? Math.max(0, usage.used_share - hosting) : null;
  return (
    <Card role="region" aria-labelledby="chatmany-usage-title" data-chatmany-usage>
      <CardHeader>
        <h2 id="chatmany-usage-title" className="font-semibold">
          What chatmany uses
        </h2>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p>{usage.headline}</p>
        {hosting !== null && others !== null ? (
          <div className="grid gap-2">
            <Progress value={percent(hosting)} secondary={percent(others)} aria-label="Your plan's monthly limit used by chatmany" data-usage-bar />
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full bg-primary" />
                chatmany
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full bg-primary/35" />
                Your other apps
              </span>
            </div>
          </div>
        ) : null}
        {usage.detail ? <p className="text-muted-foreground">{usage.detail}</p> : null}
        <Separator />
        <p className="text-xs text-muted-foreground">
          {usage.cost} <ExternalLink href={WALLET_URL}>Open your wallet</ExternalLink>
        </p>
      </CardContent>
    </Card>
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
    <section className="grid gap-2" aria-labelledby="summary-title">
      <h2 id="summary-title" className="text-xs font-medium text-muted-foreground">
        Last 30 days, all automations
      </h2>
      {summary.state === "error" ? (
        <p className="text-muted-foreground">These numbers didn’t load. {summary.message}</p>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {tiles.map(([label, value]) => (
            <Card key={label} className="gap-1 px-4 py-3" data-summary-tile>
              <p className="text-xs leading-tight text-muted-foreground">{label}</p>
              {value === null ? <Skeleton className="h-7 w-12" /> : <p className="text-2xl font-semibold tabular-nums">{COUNT.format(value)}</p>}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
