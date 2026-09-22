# rescue/ — the deployed Worker, pulled back out of Cloudflare

**What this is:** the actual bundle running in production, downloaded from the
Cloudflare dashboard on 2026-09-21. It is here because for a while it was the
*only* copy of about a month of work.

## Why it exists

This repo's last real source commit before 2026-09-21 was `74424c2`, **2026-08-19**.
Production had been deployed five times after that:

| deployed | version |
|---|---|
| 2026-09-06 | `b3855087` |
| 2026-09-09 | `4813ec90` |
| 2026-09-13 | `9a8a514b` |
| 2026-09-15 | `46068248` |
| 2026-09-16 | `a1be9b23` ← the live one, captured here |

Every one of those came from a working tree that was never committed and no
longer exists — `~/chatmany` was wiped from the founder's Mac some time after
Sep 16. So the code serving real users had no source anywhere: not on the
machine, not on the remote.

Confirmed by what is in this bundle and not in `src/`: the TikTok funnel
(`tiktokEngine`, `webhook/tiktok`, `TIKTOK_APP_ID` — 63 matches on "tiktok"),
which `README.md` describes and the repository has never contained.

## The hazard this defuses

**A `wrangler deploy` from this repo's source rolls production back to
2026-08-19** and deletes everything above. There is no CI here, so only a manual
deploy can do it — but the pooled-tenancy work ends in exactly such a deploy.
Before deploying, diff against `index.deployed.js` and know what you are
dropping.

## What is and is not here

- `deployed-a1be9b23.multipart.txt` — exactly what Cloudflare returned
  (`multipart/form-data`, 139,153 bytes), untouched.
- `index.deployed.js` — the `index.js` module split out of it, so it can be
  read and diffed.

This is **esbuild output, not original source**: bundled, minified in places,
with `node_modules` inlined. It is enough to read the logic, recover an
algorithm, or confirm whether a behaviour shipped. It is not a drop-in
replacement for the TypeScript that produced it, and it should never be
edited and redeployed as-is.

Secrets are not in here — `APP_ID`, `APP_SECRET` and `OWNER_TOKEN` live in the
Worker's secret store and are never part of a script download.

## If you are reconstructing

The deployed config, read off the same version, was:

- vars: `GRAPH_VERSION=v23.0`, `MODE=polling`, `POLL_INTERVAL_SECONDS=90`,
  `REDIRECT_URI=https://chatmany.blueturboguy07.workers.dev/...`
- bindings: D1 `DB` (`682c90a5-cb4f-446a-ae1c-a48f02b737a5`), `ASSETS`
- handlers: `fetch`, `scheduled`
- **no** `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` / `TIKTOK_MODE` — so the TikTok
  routes are deployed but unconfigured, which matches the note that developer
  registration was still blocked. Live code, dead feature.
