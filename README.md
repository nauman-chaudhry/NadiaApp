# Seven Sphere Media — Ad Performance Dashboard

An ad-arbitrage P&L dashboard for Nadia Solutions / Seven Sphere Media. Traffic is bought on
**native ad platforms** (cost) and monetised through **search/display partners** (revenue); the
dashboard joins the two so profit and margin can be seen per campaign, per ad, per hour.

| Side | Sources |
|---|---|
| **Cost** (traffic platforms) | Taboola, Outbrain |
| **Revenue** (monetisation partners) | Codefuel / Perion, Image Advantage (Yahoo + Flux feeds), DDC |

> **Working on this repo?** Read [`CLAUDE.md`](CLAUDE.md) first — it is the authoritative
> description of the system, its hard rules, and its landmines. [`TRACK.md`](TRACK.md) is the
> running build log with the reasoning behind every change.

---

## Live deployment

| Piece | Where |
|---|---|
| Dashboard | `https://nadia-dashboard-two.vercel.app` (Vercel) |
| API | `https://nadiaapp.onrender.com` (Render web service) |
| Sync worker | Render background worker `nadia-worker` |
| Database | Supabase PostgreSQL (live production — there is no staging) |
| Auth | Supabase Auth, magic-link email |

Both Render services build from `backend/` (`render.yaml`). The API service runs migrations on
build; the worker runs the cron schedule (`ENABLE_CRON=true`). Deploys are done manually by the
repo owner.

---

## How the join works

Every partner attributes revenue differently, and the asymmetry is where the complexity lives:

| Partner | Attribution key | Resolved against |
|---|---|---|
| Codefuel | `gd` + `r` params on the ad's landing URL (`asset_gid` / `channel`) | `ads` (Taboola) / `outbrain_ads` (Outbrain) |
| Image Advantage | `user_tag` → campaign id **or** ad/item id, prefixed `tb:` / `ob:` | `campaigns` → `ads.external_id`; Outbrain via `outbrain_campaigns` → `outbrain_ad_links` |
| DDC | `tt` type tag carried in the promoted link's URL | `outbrain_ad_links.tt_param`, split across candidate links by their real clicks over a trailing 7-day window |

All revenue lands in one table (`partner_stats_hourly`); all of it is collapsed to one row per
campaign-hour-account *before* being joined to cost in the materialized view `joined_stats_hourly`.
Revenue that resolves to nothing is surfaced as a labelled "unattributed" row rather than dropped,
so totals always reconcile. The invariant the client cares about most: **Campaign tab total ==
Ads tab total, on both spend and revenue, under every filter.**

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 14 (App Router), Tailwind, TanStack Table, `xlsx` export |
| Backend API | Node + TypeScript, Express, `pg`, zod |
| Sync workers | Same codebase, separate process, `node-cron` |
| Database | Supabase PostgreSQL 17 with a materialized view for the main tabs |
| Email | Resend (daily DDC report to the client) |
| Hosting | Vercel (frontend) + Render (API + worker) |

---

## Repo layout

```
backend/
  db/                 NNN_*.sql migrations, applied in filename order (047 is latest)
  src/
    api/server.ts     the entire read API — /api/stats, /api/filters/options, /api/sync-status
    sources/<name>/   HTTP clients only (taboola, outbrain, codefuel, imageadvantage, ddc, resend)
    sync/<name>.ts    DB writers, one per source
    workers/          cron.ts (schedule), daily-backfill.ts (03:00 job), run-once.ts (manual CLI)
    reports/          ddc-hourly-csv.ts (client email report)
    scripts/          one-off diagnostics from past investigations
frontend/
  app/dashboard/<view>/   7 tabs: campaign, daily, hourly, device, country, ads, site
  components/             FilterBar, StatsTable, DashboardShell
  lib/                    typed API client, formatters, Supabase helpers
docs/
  plans/                  milestone plans and drafted client messages
  reviews/                independent verification reports
db/                       LEGACY — early copies of migrations 001–007; backend/db/ is the real set
```

---

## Local development

```bash
# backend (copy backend/.env.example → backend/.env and fill in credentials)
cd backend && npm install
npm run dev:api        # API on :4000
npm run dev:worker     # cron worker (set ENABLE_CRON=true)

# frontend (copy frontend/.env.example → frontend/.env.local)
cd frontend && npm install
npm run dev            # dashboard on :3000

# manual sync jobs — see the docblock at the top of backend/src/workers/run-once.ts
cd backend && npm run sync:once -- refresh-all
cd backend && npm run sync:once -- daily-backfill
cd backend && npm run sync:once -- refresh-view
```

`npm run migrate` applies any unapplied files in `backend/db/` — **against whatever `DATABASE_URL`
points at**, which in this repo's `.env` is production.

---

## Cron schedule (worker)

| When (UTC) | Job |
|---|---|
| `:05` | Taboola hourly cost + MV refresh |
| `:15` | Codefuel revenue, yesterday + today + MV refresh |
| `:20` | Image Advantage revenue, yesterday + today + MV refresh |
| `:25` | Outbrain cost: marketer-hourly, per-campaign, per-promoted-link + MV refresh |
| `:45` | DDC revenue: daily report + hourly feed + MV refresh |
| 10:00 Europe/London | DDC hourly-by-Type-Tag CSV emailed to the client |
| every 2h | Taboola metadata (new accounts / campaigns / ads) |
| `03:00` | Full 4-day backfill across every source, each step isolated and recorded in `sync_runs` |

---

## Status

- **Milestones 1–3 complete:** Taboola + Outbrain cost, Codefuel + Image Advantage + DDC revenue,
  7 tabs, filters, Excel export, reconciliation verified against each partner's own reporting.
- **Next:** a second, isolated dashboard for a second entity — see `docs/plans/joe-dashboard.md`.
- Open issues and upstream caveats are tracked in `CLAUDE.md` §12 and at the tail of `TRACK.md`.
