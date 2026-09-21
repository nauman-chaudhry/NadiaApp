# Architecture — Phase 1

## End-to-end data flow

```
┌─────────────┐    ┌─────────────┐    ┌──────────────────┐
│   Taboola   │    │  Outbrain   │    │ Codefuel/Perion  │
│     API     │    │     API     │    │       API        │
└──────┬──────┘    └──────┬──────┘    └─────────┬────────┘
       │                  │                     │
       │   (hourly cron, sliding 2-hour window) │
       ▼                  ▼                     ▼
┌──────────────────────────────────────────────────────────┐
│                  Sync Worker (Node)                       │
│  - OAuth token refresh                                    │
│  - Pull → normalize → upsert                              │
│  - Extract gd & r params from ad URLs                     │
│  - Refresh joined_stats_hourly materialized view          │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│              Supabase Postgres                            │
│  ad_accounts → campaigns → ads → ad_stats_hourly          │
│                                  partner_stats_hourly     │
│                                  joined_stats_hourly (MV) │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│            Express API (read-only for dashboard)          │
│  GET /api/stats?view=campaign&from=...&to=...&filters=... │
│  GET /api/filters/options                                 │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│         Next.js Dashboard (Vercel)                        │
│  Tabs: Campaign | Device | Site | Country | Ads |         │
│        Daily   | Hourly                                   │
│  Filters: Date range, GD, Campaign ID, Website,           │
│           Status, Account ID, Account name                │
└──────────────────────────────────────────────────────────┘
```

## The join — why it's the core of this system

Cost and revenue come from different systems and need to be matched at the ad level.
The bridge is two URL parameters embedded in the Taboola/Outbrain landing URL:

```
https://www.mysearch4you.com/Search?q=...&gd=AP1008549&r=4268019316
                                          ^^^^^^^^^^^^ ^^^^^^^^^^^^^^
                                          │            │
                                          │            └─ Codefuel "channel"
                                          └────────────── Codefuel "asset_gid"
```

When syncing Taboola ads we extract `gd` and `r` from the landing URL and store them
on the `ads` row. When syncing Codefuel we request `asset_gid` and `channel` as
breakdowns. The joined materialized view matches on `(gd_param, r_param) = (asset_gid,
channel)` plus `(hour_utc, country, device)`.

## Codefuel authentication (confirmed)

OAuth2 client_credentials against a separate auth host:

```
POST https://search-auth.perion.com/oauth/token
Content-Type: application/json

{
  "client_id":     "...",
  "client_secret": "...",
  "audience":      "codefuel-api",
  "grant_type":    "client_credentials"
}
```

Response: `{ "access_token": "<JWT>", "token_type": "Bearer" }`. Pass `Authorization:
Bearer <token>` on every call to `search-api.perion.com`. Token expiry is read from
the JWT's `exp` claim; falls back to 1h if unparseable.

## Codefuel endpoints (relevant ones)

| Endpoint                            | Retention   | Used for                       |
| ----------------------------------- | ----------- | ------------------------------ |
| `/io/getHourlyPerformanceData`      | 14 days     | hourly cron, last-14-day window|
| `/io/getDailyPerformanceData`       | 3 months    | older backfill (April → May 8) |
| `/io/getClickIdRevenueBreakdown`    | 7 days      | per-click attribution (later)  |
| `/io/getTrafficQualityScore`        | 3 months    | TQS reporting (later)          |

Required query params on the perf endpoints: `start_date`, `end_date`,
`breakdowns` (CSV; we use `date,hour,country_code,asset_gid,channel,device`
for hourly and the same minus `hour` for daily), `metrics=all`, `asset_gids=all`,
`channels=all`, `format=JSON`.

## Cron schedule

| Job                    | Frequency      | Window pulled               | Purpose                        |
| ---------------------- | -------------- | --------------------------- | ------------------------------ |
| Taboola hourly stats   | every hour :05 | last 2 hours                | normal incremental update      |
| Codefuel hourly stats  | every hour :15 | last 2 hours                | normal incremental update      |
| Metadata sync          | every 6 hours  | full account/campaign/ads   | catch new accounts + campaigns |
| Daily backfill         | once daily 03  | last 3 days, all sources    | catch late-arriving conversions|
| View refresh           | after each job | n/a                         | rebuild joined_stats_hourly    |

**Why a 2-hour window for hourly jobs**: protects against late data and lets a single
cron miss self-heal on the next run.

## New account auto-discovery (confirmed with Nadia)

When Nadia adds a new Taboola sub-account under `sevenspheremedia4433-network`:

1. The metadata cron (every 6 hours) calls Taboola's `/networks/{network}/accounts`
   and discovers the new account.
2. A row is auto-inserted into `ad_accounts` with `client_partner_id = NULL`.
3. Hourly stats start flowing immediately into `ad_stats_hourly`.
4. The only manual step is tagging the partner: one SQL UPDATE (or a button in the
   admin UI later):

   ```sql
   UPDATE ad_accounts
      SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'codefuel')
    WHERE external_id = '<new_taboola_account_id>';
   ```

5. Once tagged, the joined view picks up the new account's revenue side automatically.

Same for new Codefuel asset GIDs — they show up as soon as they appear in the API
response, no config needed.

## Codefuel rate limit accounting

60 requests/hour/account, sliding window. Per hourly cron run, per Codefuel
account, we make ~2–3 calls:
- 1 × `getHourlyPerformanceData` (last 2 hours)
- Optional: 1 × `getClickIdRevenueBreakdown` (GCLID — only if enabled later)

= safely under 60/hour even with 5+ accounts looped sequentially.

## Historical backfill from April 1 (Nadia's request)

The `backfill-full` script handles this in one command:

```bash
npm run sync:once -- backfill-full 2026-04-01
```

It does:
1. Taboola metadata sync.
2. Taboola hourly stats from Apr 1 → today (in 7-day chunks).
3. Codefuel **daily** stats from Apr 1 → today − 14d (covers the period beyond
   Codefuel's hourly retention).
4. Codefuel **hourly** stats from today − 14d → today.
5. Refresh the joined view.

Result: the Daily tab and the Campaign/Device/Site/Country/Ads tabs show data
across the whole Apr 1 → today range. The Hourly tab only has data for the last
14 days because Codefuel doesn't expose hourly granularity beyond that — flagged
to Nadia.

## Files / responsibilities

```
backend/
  src/
    config/        env vars, DB connection, logging
    sources/
      taboola/     OAuth, accounts, campaigns, ads, stats fetchers
      outbrain/    OAuth, marketers, campaigns, stats fetchers
      codefuel/    OAuth2 client_credentials, hourly + daily fetchers
    sync/
      taboola.ts   orchestrate Taboola pull → upsert
      outbrain.ts  orchestrate Outbrain pull → upsert (later)
      codefuel.ts  orchestrate Codefuel pull → upsert (hourly + daily)
    api/
      server.ts    GET /api/stats and /api/filters/options
    workers/
      cron.ts      schedule + dispatch (worker process entry point)
      run-once.ts  manual sync runner + backfill-full
    db/
      client.ts    pg pool
      migrate.ts   migrations runner
    utils/
      url-params.ts  extract gd + r from ad URLs

frontend/
  app/
    (dashboard)/
      layout.tsx       sidebar + top filter bar
      campaign/page.tsx
      device/page.tsx
      site/page.tsx
      country/page.tsx
      ads/page.tsx
      daily/page.tsx
      hourly/page.tsx
  components/
    filters/         date range, multi-select dropdowns
    table/           TanStack table wrapper, totals row, profit/margin formatters
    charts/          Recharts line, bar, pie wrappers
  lib/
    api.ts           typed fetch client
    formatters.ts    currency, percent, integer formatters
```

## Open items

- Outbrain hourly sync function (creds received; need to build the upsert)
- Frontend UI (data layer ready; tabs not built yet)
- Supabase Auth wiring with admin + viewer roles
