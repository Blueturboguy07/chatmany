# Hosted chatmany (publik hosts it for the creator)

> **Nothing here is deployed, and nothing is published to users.** This branch builds the hosted
> mode; going live waits on publik being approved for the Meta API. The founder's own live Worker
> (`chatmany.blueturboguy07.workers.dev`) is untouched by this branch, no `wrangler deploy` has
> been run from it, and no secret has been set.

Self-hosting stays fully supported and unchanged (R30 D6). A self-host deployment does not set
`HOSTED`, so the hosted routes answer 404, the cron keeps polling that one account, and the
existing 22-step install guide still applies. Apply migration `0005` and your rows become the
reserved tenant `self`; nothing else changes.

---

## 1. What the creator is charged — read this before touching a price

**The 3% rides on publik's ACTUAL Cloudflare bill, not on Cloudflare's list prices.**

- While publik's marginal cost for a unit class is zero — the work fits inside the quotas the $5
  Workers Paid plan already includes — **the creator is charged zero for that class.**
- Once publik's bill for that class is non-zero, the rate for that month is
  **(real marginal monthly cost for the class ÷ units metered in that month) × 1.03.**
- The rate therefore **changes every month**, **defaults to zero**, and is set by an operator job
  publik-side from the real invoice. There is no subscription and no minimum; the charge is drawn
  from the creator's existing publik wallet in the usual order (plan window → starter → packs).

Consequently **this repo contains no price at all.** The Worker counts units; it never converts a
unit into money. If you ever find a Cloudflare list price hard-coded in here, it is a bug: it
would invent a charge that publik's bill does not support.

### The three billable classes

| slug | one unit is |
|---|---|
| `chatmany.event` | one inbound comment or message, counted **once ever** per tenant (the `metered_events` ledger, schema 0007). A comment read again on later polls, sweeps or webhook redeliveries is not counted again. DMs already in the inbox at the first read are not counted |
| `chatmany.send` | one outbound Graph call **attempted** — any outcome. A private reply Instagram refuses still cost the round trip; the dashboard shows refusals separately so the creator can see why |
| `chatmany.poll` | one polling tick for this tenant (fallback mode only; a webhook tenant has none) |

Cloudflare's own meters are per script and per database, never per tenant, so first-party counting
is the only possible source. Cloudflare's invoice is the numerator of the rate above; it is not
the meter.

### The operator's monthly rate job

Per-tenant units are durable in D1 (`usage_monthly`), and `units − reported` is what has not yet
reached publik. The denominator of the rate is one query:

```sql
SELECT month, slug, SUM(units) AS units
FROM usage_monthly
WHERE month = '2026-09'
GROUP BY month, slug;
```

Then, per class, `rate_per_unit = (this month's real marginal Cloudflare cost for that class ÷
units) × 1.03`, or `0` when that cost is zero. The class-to-invoice-line mapping is a judgement
call the operator makes and records — a send is mostly D1 row writes and Durable Object duration,
an event is mostly requests and row writes, a poll is mostly DO alarms and duration.

---

## 2. Shape

```
Meta ──POST /webhook/{tenant}──▶ ingress Worker ──stub.fetch──▶ TenantDO(idFromName(tenant_id))
                                  │ per-tenant verify token           │ ONE runner per tenant
                                  │ per-tenant app secret (signature) ├─ engine (comments, messages)
publik ──/hosted/*───────────────▶│                                   ├─ send pacing, 613 cooldown,
cron * * * * * (re-arm only) ────▶│                                   │  hourly cap, run budgets
                                  ▼                                   ├─ alarms: poll 90s, sweep 20m,
                            shared D1, tenant_id on every row         │  usage 60s, token refresh 24h
                                                                      └─ usage → POST publik ingest
```

**Why Cloudflare, stated honestly:** it is *not* the cheapest per event — Vercel Functions on the
Supabase publik already pays for is roughly half the marginal price. It is the only candidate
whose isolation primitive is native: one object per tenant, addressed by name, single-threaded.
Every production failure chatmany has had was an isolation failure (the `exceededCpu` kill of an
account-wide tick, the unindexed global count that took D1 down for a UTC day, the overlapping
15-minute runs that saturated Instagram's rate limit). The full argument is in the comment at the
top of `src/tenant/runner.ts`.

### Isolation, concretely

- `tenants` row per creator; `tenant_id` first in every primary key and every hot-path index.
- `TenantDb` is the only class that touches campaign or conversation data, and it binds
  `tenant_id` on every statement. `src/db.ts` is the same class bound to `'self'`.
- One Durable Object per tenant owns that tenant's queue, pacing clock, poll slot, 613 cooldown,
  sweep cursors and usage counters. `runExclusive` serialises everything inside it.
- Per run: 25 sends, 200 new comments, 4 minutes. Per hour: 750 opening sends. A viral post
  yields between runs instead of running until Cloudflare kills the invocation.
- The cron does one indexed read and pokes each polling tenant's object to re-arm its own alarm.
  It performs no tenant work inline and costs none of the account's 250 Cron Triggers per tenant.

### Secrets

Every Instagram token and creator app secret is AES-256-GCM encrypted with the `TOKEN_KEK` Worker
secret, a fresh 96-bit IV per value, and **the tenant id as additional authenticated data** — so a
ciphertext lifted from one tenant's row cannot be decrypted as another's. Plaintext exists only
inside that tenant's object, for the moment of use. Rotate by moving the old value to
`TOKEN_KEK_PREVIOUS`.

---

## 3. The metering contract with publik

Both calls use `Authorization: Bearer <INFRA_INGEST_TOKEN>` and `PUBLIK_API_BASE`. With either
unset, usage is only counted in D1 and nothing is ever paused for credit.

**Usage** (the body publik parses in `lib/publik-api/infra/units.ts`):

```
POST {PUBLIK_API_BASE}/api/v1/infra/usage
Idempotency-Key: <batch key>
Content-Type: application/json

{"batches": [{
  "tenant": "<publik user id that owns the tenant>",
  "idempotency_key": "t_9f2c.1758240000.ab12cd",
  "units": [
    {"slug": "chatmany.event", "units": 412},
    {"slug": "chatmany.send",  "units": 247},
    {"slug": "chatmany.poll",  "units": 16}
  ]
}]}

200 {"results": [{"idempotency_key": "...", "settled": true, "replayed": false, "paused": false, ...}]}
```

- Batched at 100 units or 60 seconds, whichever comes first; at most 20 batches per flush.
- `settled: true` — recorded (a replayed key is free). `paused: true` means the wallet cannot pay
  any more: the tenant's sends pause.
- `settled: false` with `invalid_tenant` — publik has no wallet key for that user yet: kept and
  retried. Any other refusal, or a `400`, means the batch itself is bad: it leaves the send queue
  (its units stay unreported in D1, visible to the operator).
- Anything else, or no answer at all — the batch stays queued and is retried with the **same**
  idempotency key. **A reporting failure never drops the creator's work.**

**Balance** (asked before any run that can send; `src/tenant/balance.ts`):

```
GET {PUBLIK_API_BASE}/api/v1/infra/balance?tenant=<publik user id>
200 {"tenant": "...", "can_pay": true}
```

- `can_pay: false` pauses sends (`status = 'paused_credit'`). A paused tenant makes no Instagram
  call and is metered for nothing. It is asked again every minute, so a top-up resumes replies
  within about a minute; while it can pay, every ten minutes (each usage answer refreshes it too).
- No answer (publik down, a 5xx, not configured) keeps the last known state. A tenant never
  checked is treated as able to pay: a bad minute at publik must not stop a creator's replies.

**Calling fetch.** Both calls go through `globalFetch` (`src/tenant/metering.ts`). Never store the
global `fetch` on an object and call it as a method: workerd throws "Illegal invocation" before
anything is sent. Until 2026-11-16 that is what both calls did, so no usage report and no balance
check ever reached publik (the error was caught as "unreachable" and retried forever).

**Meter version 2** (2026-11-16): the first run of this code in each tenant's object drops every
`chatmany.event` unit counted under the old rule (pending, queued, and `units` back to `reported`
in D1). Those units were over-counted and never reported, so none is charged. Poll and send counts
stay queued and are reported under their own keys.

**Retention**: the daily `0 3 * * *` cron deletes events, processed comments, comment actions,
send claims, metered-event keys and contacts (conversations) older than 90 days, across every tenant
(`src/tenant/retention.ts`). Comments older than Instagram's 7-day private-reply window are never
read, so a deleted processed-comment row cannot turn into a second DM.

## 4. Control plane (publik → this Worker)

All under `Authorization: Bearer <INFRA_ADMIN_TOKEN>`, constant-time compared.

| route | does |
|---|---|
| `POST /hosted/tenants` | create a tenant; returns the six connect-page values and the verify token **once** |
| `GET /hosted/tenants` | list tenants (no secret material); `?publik_user_id=` or `?ig_user_id=` (either Instagram id, for Meta's data-deletion callback) filters |
| `GET/DELETE /hosted/tenants/{id}` | read one; delete asks the tenant's object to flush its last usage and forget its alarm, then erases that tenant's rows and the registry row (disconnect and Meta's data-deletion path; no call to Meta) |
| `POST /hosted/tenants/{id}/connect` | store the token encrypted, mark active, call `POST /me/subscribed_apps`, arm the alarm |
| `POST /hosted/tenants/{id}/{poll,sweep,subscribe,pause,resume}` | operator actions |
| `GET /hosted/tenants/{id}/{status,usage,export}` | object state, this month's metered units, full data export |

`POST /me/subscribed_apps?subscribed_fields=comments,messages` is what actually turns deliveries
on. **No call to it existed anywhere in this repo** — which is why the deployed Worker still
reports `mode: polling`. A tenant stays on polling until its first *signed* delivery arrives, so
an account whose webhooks never fire (private account, unpublished app) keeps working.

---

## 5. Configuration

`wrangler.toml`: `HOSTED = "1"`, `PUBLIK_API_BASE`, the `TENANT` Durable Object binding and its
migration (already in the file, commented where it is publik-only).

Secrets (`wrangler secret put`): `TOKEN_KEK` (≥ 32 random characters), `INFRA_INGEST_TOKEN`,
`INFRA_ADMIN_TOKEN`, optionally `TOKEN_KEK_PREVIOUS` during a rotation. A self-hoster needs none
of them.

---

## 6. Field fixes carried into this code

The GitHub repo was behind the deployed Worker; these had been running live and were never
committed. Each is now in committed code with the incident attached in a comment:

| fix | where |
|---|---|
| a 5xx / code 1 is an **unknown** outcome, never a refusal (116 duplicate DMs, 2026-08-23) | `src/engine/failure.ts` |
| permanent refusals (2534001 & co) dead-lettered instead of retried forever | `src/engine/engine.ts` |
| DM first, public reply only after it lands (~6,500 public "sent" with no DM, 2026-09-13) | `src/engine/engine.ts` |
| run lock + 613 cooldown + per-run send budget (the 2026-09-15 death spiral) | `src/tenant/runner.ts`, Durable Object |
| comment paging with replies + rotating backlog sweep (the newest-100 window) | `src/api/client.ts`, `src/tenant/runner.ts` |
| batched processed-comment lookup and event writes (the `exceededCpu` kill) | `src/tenant/db.ts` |
| `idx_events_type_time` (the D1 daily-read-cap outage, 2026-09-01) | `schema/0004` |
| `deliver_in_opening` — ManyChat parity, one private reply carrying the link | engine, types, builder UI |
| inbound-first delivery: whoever DMs the keyword gets the reward (12/12 live) | `src/engine/engine.ts` |
| comments past the 7-day private-reply window are closed out | `src/engine/engine.ts` |

## 7. Not done here

- Not deployed. No `wrangler deploy`, no secrets set, no listing published.
- Per-tenant OAuth (`/auth/callback/{tenant}`) is not implemented: `POST /hosted/tenants/{id}/connect`
  takes the token from publik, which runs the exchange. Either side can own it; this was the
  smaller surface.
- Path T (one publik Meta app for every creator, routed by `entry.id`) has the routing helper
  (`tenantForEntry`) but not the shared-secret ingress; launch is path L, creator-owned apps.
- The `AppBudget` object that would ration Meta's app-level code-4 quota across tenants is path-T
  only and is not built.
- Migrating the founder's live tenant (R30 D7) needs the live bundle committed first: the deployed
  Worker carries fix2/fix3 deltas that exist only in that bundle.
