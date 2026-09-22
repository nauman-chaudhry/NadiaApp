# CLAUDE.md — Seven Sphere Media performance dashboard

Read this first in any new session. It is the authoritative description of this project.
`docs/ARCHITECTURE.md` and `RUNBOOK.md` predate most of the current system and are **partly
stale** (see [Stale docs](#stale-docs)) — trust this file over them.

---

## 1. Hard rules

1. **NEVER deploy. The user deploys.** Stated verbatim by the user: *"DONT DEPLOY ILL DEPLOY
   MYSELF"*. Tell them what to deploy where (API / worker / frontend, and whether a migration rides
   with it).
   **Git workflow (updated 2026-09-22):** the repo is on branch `main` with a GitHub remote
   (`origin` → `nauman-chaudhry/NadiaApp`). After any change, **commit everything** (code, migrations,
   `TRACK.md`, docs) with a clear message. **You will push to `origin`, but ALWAYS ask the user
   first** — show the commits about to go out, one line each, and wait for an explicit OK in that
   turn. Never push unprompted, including docs-only changes.
2. **The database is live production.** `DATABASE_URL` points at the real Supabase instance. Any
   migration you apply, or any `UPDATE`/backfill you run, is immediately live for Nadia. There is
   no staging DB. Read before you write; prefer idempotent SQL.
3. **Always update `TRACK.md` after any change.** Every code change, migration, bug fix, or
   decision gets an entry. See [§11](#11-track-md-is-mandatory).
4. **Reconcile, don't assume.** This project's entire history is data-accuracy bugs. Any change
   touching revenue or cost must be verified against the source API or Nadia's spreadsheet before
   being called done. State real numbers, not "should be correct now".
5. **The client is Nadia** (Nadia Solutions / Seven Sphere Media). The user relays her feedback.
   When she reports a discrepancy, she is usually right — every past complaint traced to a real bug.

---

## 2. What this is

An ad-arbitrage performance dashboard. Seven Sphere Media buys traffic on **native ad platforms**
(cost) and monetizes it through **search/display partners** (revenue). The dashboard's job is to
join the two so Nadia can see profit and margin per campaign, per ad, per hour.

- **Cost sources (traffic platforms):** Taboola, Outbrain
- **Revenue sources (monetization partners):** Codefuel/Perion, Image Advantage (IA), DDC *(being
  added — see [§12](#12-current-state))*

The hard part is **attribution**: matching a revenue row from a partner back to the specific ad
that produced it. Each partner does this differently, and that asymmetry is the source of nearly
every bug in this codebase.

---

## 3. Stack and topology

| Piece | Tech | Deployed to |
|---|---|---|
| Database | Supabase PostgreSQL 17.6 | Supabase (live) |
| Backend API | Node + TypeScript, Express, `pg` | Render web service — **`https://nadiaapp.onrender.com`** (since 2026-09-22; older TRACK entries reference `nadia-api.onrender.com`) |
| Sync worker | Node + TypeScript, `node-cron` | Render worker `nadia-worker` |
| Frontend | Next.js App Router, TanStack Table, Tailwind | Vercel (`nadia-dashboard-two.vercel.app`) |
| Auth | Supabase Auth (magic link; `frontend/middleware.ts`) | — |

The API has **no auth of its own** — only CORS, which is browser-only. Anyone with the URL can
`curl` every endpoint.

Both Render services build from `rootDir: backend` (see `render.yaml`). **The API service runs
migrations on build** (`npm run migrate:prod`); the worker does not. `ENABLE_CRON` is `false` on
the API and `true` on the worker — `cron.ts` exits immediately if it's false.

### Local dev

```bash
cd backend && npm run dev:api      # API on :4000
cd backend && npm run dev:worker   # cron worker
cd frontend && npm run dev         # dashboard on :3000
```

Environment notes:

- `npm run` / `tsx` work on this Mac (`backend/node_modules` is installed). Ad-hoc DB queries go
  through `npm run sync:once -- <job>` or a short `tsx` script that imports `db/client.ts`; the
  earlier note that the sandbox blocked reading `backend/.env` is stale (TRACK 2026-09-10).
- **The API server does not hot-reload reliably after `server.ts` edits.** Kill and relaunch:
  find the PID on `:4000` and restart `dev:api`.
- One `npm run sync:once` has been seen to write **two** overlapping `sync_runs` rows for the same
  job (tsx double-execution). Idempotent, harmless, but don't read it as a cron bug.

---

## 4. Repo layout

```
backend/
  db/                    NNN_*.sql migrations, applied in filename order
  src/
    config/env.ts        zod-validated env, process.exit(1) on failure
    db/client.ts         pg pool: query(), withTx()
    db/migrate.ts        runner; tracks applied files in _migrations
    sources/<name>/client.ts   HTTP only, no DB  (taboola, outbrain, codefuel, imageadvantage)
    sync/<name>.ts             DB only, imports the client
    api/server.ts        the entire read API (~1700 lines, the heart of the app)
    workers/cron.ts            schedule + dispatch
    workers/daily-backfill.ts  the 03:00 job, per-step isolated
    workers/run-once.ts        manual CLI runner
    utils/url-params.ts        extract gd + r from ad landing URLs
frontend/
  app/dashboard/<view>/page.tsx    7 tabs
  components/FilterBar.tsx         all filters (searchable multi-selects, date presets, feeds)
  components/StatsTable.tsx        table, zebra, sticky cols, drag reorder, search, export
  components/DashboardShell.tsx    fetch + wiring
  lib/api.ts                       typed client
```

**Convention:** one `sources/<partner>/client.ts` + one `sync/<partner>.ts` per partner. There is
**no registry and no shared partner abstraction** — wiring is direct imports, and helpers like
`getPartnerId` / `startRun` / `finishRun` are **duplicated verbatim** in each sync file. Follow that
pattern rather than refactoring it mid-task.

---

## 5. Data model

### Core tables (`backend/db/001_schema.sql`)

```
platforms          'taboola' (id 1) | 'outbrain' (id 2)
client_partners    id, code UNIQUE, name       ← revenue partners
ad_accounts        platform_id, external_id, name, client_partner_id (nullable)
campaigns          ad_account_id, external_id, name, status
ads                campaign_id, external_id, title, gd_param, r_param
ad_stats_hourly    Taboola cost, per campaign+hour+account
partner_stats_hourly   ALL partner revenue, every partner shares this table
```

`platform_id = 2` for Outbrain is hardcoded as a magic number in ~8 places in `server.ts` and in
the MV. Don't "fix" it in passing.

### `partner_stats_hourly` — read this carefully

Every revenue partner writes here. Two mutually exclusive row shapes, distinguished by whether
`campaign_ext_id` is NULL, each with its **own partial unique index**:

| | Unattributed rows | Attributed rows |
|---|---|---|
| Condition | `campaign_ext_id IS NULL` | `campaign_ext_id IS NOT NULL` |
| Index | `partner_stats_hourly_unattr_unique` | `partner_stats_hourly_attr_unique` |
| Key | `(client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform)` **`NULLS NOT DISTINCT`** | `(client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)` |
| Used by | Codefuel (always), IA fallback | IA (`tb:`/`ob:` prefixed) |

**⚠️ The `NULLS NOT DISTINCT` trap.** In Postgres, `NULL != NULL`, so a NULL in any indexed column
means `ON CONFLICT` never matches and **every re-sync appends a duplicate row**. This caused a real
production bug (a new IA affiliate with a NULL `source_platform` grew to 26 copies of every row);
migration `039` fixed the unattributed index with `NULLS NOT DISTINCT`.
**The attributed index still lacks it** — so never write NULL into `item_ext_id`; use `''`.

`granularity` — `CHECK (granularity IN ('hourly','daily','x-daily'))`:
- `hourly` — always included by the MV.
- `daily` — **fallback only**: suppressed for any `(client_partner_id, date)` that has hourly rows.
- `x-daily` — IA x-metrics (Flux). Never shadowed. **This is the sole definition of "Flux".**

Also: `sessions` means *bidded searches*; `revenue` is the partner's revenue share.

---

## 6. Attribution — how each partner maps revenue to an ad

**Codefuel → `(gd_param, r_param)`.** The Taboola/Outbrain landing URL carries `?gd=...&r=...`;
`utils/url-params.ts` extracts them onto the `ads` row, and Codefuel reports the same values as
`asset_gid` / `channel`. Join on the pair.

**Image Advantage → `campaign_ext_id`.** IA reports a `user_tag` that we parse into
`campaign_ext_id` / `item_ext_id`, prefixed by platform from the affiliate-name suffix:
`.tb`/`.tb-2` → Taboola, `.ob` → Outbrain (regex `/\.tb(-\d+)?$/`, not `.endsWith('.tb')`).
The stored value can be **either** a Taboola campaign id **or** an ad/item id, so resolution tries
`campaigns.external_id` first, then `ads.external_id` — that dual lookup is why `ia_item_map` /
`ia_map` CTEs exist. On Outbrain the tag is a hex id resolved against `outbrain_campaigns.campaign_id`
then `outbrain_ad_links.link_id`.

**Anything that resolves to nothing becomes an "orphan"/"unattributed" row** surfaced as a labelled
synthetic row, so totals still reconcile. Never silently drop revenue.

**Account → partner** is via `ad_accounts.client_partner_id`, and that is the *only* link. It's what
powers the "Project" filter. New Outbrain marketers auto-register with `client_partner_id = NULL`
(deliberately — see the comment in `sync/outbrain.ts`) and must be tagged manually:

```sql
UPDATE ad_accounts SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'codefuel')
 WHERE external_id = '<external_id>';
```

---

## 7. The materialized view — `joined_stats_hourly`

The dashboard reads this, not the base tables. **`backend/db/047_mv_ia_orphan_deterministic_account.sql`
is the authoritative definition** (applied 2026-09-09; a copy of `046` with one change — `ORDER BY id`
on the `ia_orphan` lateral. `046` superseded `043` → `041` → `037`. Check `_migrations` for what is
actually applied).

**To change the MV, copy the whole of the latest MV migration into a new numbered migration and
edit that.** Every MV migration re-declares the view in full; there is no incremental path.

Structure: CTEs per partner per platform → all Taboola-side revenue collapsed into
`all_attributed_revenue` (one row per `campaign_id, hour_utc, ad_account_id`) → `FULL OUTER JOIN`
against `cost` → then `UNION ALL` branches for each orphan bucket and for Outbrain.

Two rules you must not break:

- **Add new attributed revenue to the `all_attributed_revenue` union**, never as a new top-level
  `UNION ALL`. Revenue is collapsed to one row per campaign-hour-account *before* joining cost; a
  separate top-level branch would double-count cost.
- **All branches are positional across 29 columns.** A new branch must match types and order
  exactly, including the three flux columns.

**Feeds (Yahoo vs Flux)** are a *column* split, not a row split — `revenue_flux` etc. carry the
x-daily portion of each row, and the API selects `revenue`, `revenue - revenue_flux`, or
`revenue_flux`. This design exists specifically to avoid double-counting cost. Partners with no
Flux equivalent emit literal zeros.

Outbrain is **daily-grain** in the MV (`outbrain_stats_daily`), so Outbrain revenue is collapsed to
`hour_utc::date`. Account-level *hourly* Outbrain cost lives in `outbrain_marketer_hourly`
(migration 038) and is used only by the API's Hourly tab.

---

## 8. API — `backend/src/api/server.ts`

`GET /api/stats?view=&from=&to=&...` — views: `campaign, device, site, country, ads, daily, hourly`.
`GET /api/filters/options` — accounts (with `partner_code`), campaigns, countries, devices, statuses.
`GET /api/sync-status` — freshness per source.

- `campaign`/`daily`/`hourly` read the MV. `device`/`site`/`country`/`ads` query base tables
  directly, with per-partner CTEs.
- `source` = `taboola` | `outbrain` | *(absent = all)*. Note **`taboola` means `source_platform IS
  DISTINCT FROM 'Outbrain'`**, because IA writes NULL there.
- `feed` = `yahoo` | `flux` | *(absent = all)*, implemented via the `REV`/`ADC`/`SES` expression
  selectors plus the `iaFeed` granularity clause.
- Multi-value filters (`account_id`, `campaign_id`, `status`, `country`, `gd`) use
  `= ANY(string_to_array($N,','))`.
- **All-sources Ads runs the builder twice** (Taboola + Outbrain) and concatenates.

**Synthetic rows** — negative `ad_id`s that exist so totals reconcile:

| id | Meaning |
|---|---|
| `-1` | IA campaign-level revenue (Taboola) |
| `-2` | Unattributed Codefuel orphans |
| `-3` | Taboola cost on campaigns with no ad-level revenue mapping |
| `-4` | Real Outbrain per-promoted-link row |
| `-5` | IA campaign-level revenue (Outbrain) |
| `-6` | Unattributed Outbrain (Codefuel + IA) |
| `-7` | DDC campaign-level revenue on Outbrain campaigns with no ad-level cost |
| `-8` | Unattributed DDC — **the majority of DDC revenue** (82.8%). Unlike `-6` this is *not* blanket-suppressed under a filter: it reproduces the MV's `ddc_orphan` account lateral so Campaign == Ads holds under an account filter |
| `-9` | Codefuel-Outbrain revenue on a campaign with no ad-level cost in the window. Mirrors the MV, which books this revenue to `outbrain_ads.campaign_id` unconditionally; without it the Ads tab silently reassigned it to another account's link |

---

## 9. Cron schedule (actual — `workers/cron.ts`)

| When | Job |
|---|---|
| `:05` | Taboola hourly (2h window) + MV refresh |
| `:15` | Codefuel hourly — yesterday **and** today, isolated (Codefuel publishes ~3–6h late) + MV refresh |
| `:20` | IA hourly — yesterday **and** today, isolated + MV refresh |
| `:25` | Outbrain, 2-day EDT window: marketer-hourly → per-campaign cost → per-promoted-link cost → MV refresh (~7 min, 42 calls) |
| `:45` | DDC — daily `detail` (D-3..D-0, gated by the `date` report) **and** the hourly feed + MV refresh |
| 10:00 `Europe/London` | DDC hourly-by-Type-Tag CSV emailed to the client via Resend (`REPORT_EMAIL_TO`), recorded as `sync_runs` source `ddc` / job `report` |
| every 2h | Taboola metadata (new accounts/campaigns/ads) |
| `03:00` | `runDailyBackfill()` — 4-day window, all sources (the only job running `syncOutbrainPromotedLinks`, IA x-metrics, geo-cost, Outbrain country/publisher) |

There is **no automatic stale-source alerting** — a watchdog was built and then removed at the
user's instruction (TRACK 2026-09-18). To check health:
`SELECT source, MAX(started_at) FILTER (WHERE status='ok') FROM sync_runs GROUP BY 1`.

Two helpers matter: `attempt(name, fn)` in `cron.ts` logs and swallows so one failure can't kill a
tick; `withSyncRun(...)` and `step(...)` in `daily-backfill.ts` record every step to `sync_runs` and
isolate failures, then throw at the end naming what failed. **This structure exists because the
03:00 backfill once died silently for days** — it is the only job carrying Outbrain, IA x-metrics,
and geo-cost. Don't collapse it back into one try/catch.

Manual runs: `npm run sync:once -- <job> [start] [end]` (see the docblock at the top of
`run-once.ts`). Most useful: `refresh-all`, `daily-backfill`, `sync-day <date>`, `refresh-view`.

---

## 10. Landmines

**Upstream API quirks** — each cost real debugging time:

- **Outbrain `/periodic` silently defaults to `limit=10`.** Always pass `limit: 24` for hourly, or
  you get 10 of 24 hours and ~30% of the true total. Valid `breakdown` values: `daily, monthly,
  weekly, hourOfDay, dayOfWeek, dayOfWeekByHour, hourly, realtime` — for account-level hourly the
  working one is **`hourOfDay`**, not `hourly`.
- **Outbrain `/login` is rate-limited to 2/hour.** The token is cached to
  `.cache/outbrain-token.json`. Don't loop logins.
- **Taboola hourly reports accept max 48h per request** and retain ~14 days — hence the 2-day
  sub-window loop in the backfill.
- **IA's API is single-day** and rejects today for some endpoints; y-metrics endpoints are called
  **unfiltered** so new affiliates auto-appear (a hardcoded affiliate list once lost $46–101/day).

**Code landmines:**

- **`cf_key` in `server.ts` has no `client_partners` join.** It scans every
  `campaign_ext_id IS NULL` row and treats it as Codefuel. Any new partner writing unattributed
  rows will silently inflate Codefuel revenue.
- **The `-3` row guards only Codefuel and IA.** A new partner with campaign-level revenue needs a
  third `NOT EXISTS` or that campaign's spend is counted twice on the Ads tab.
- **Migration `031` tags Outbrain accounts with `CASE ... ELSE 1` (= Codefuel).** Never copy that
  pattern; a new marketer would be silently mis-tagged.
- **Partner identity is hardcoded in ~17 places in `server.ts`, 8 in the MV, and 4 maps in the
  frontend** (`FilterBar.tsx` `PARTNER_COLORS`/`PARTNER_LABELS`/`PARTNER_FULL` + the Project
  `<option>` list, and `StatsTable.tsx` `ACCT_BADGE`). An unmapped code degrades quietly — a grey
  chip, or no badge at all — rather than erroring.
- **In-memory dedup before bulk upsert is mandatory.** Build a `Map` keyed on the conflict key;
  a multi-row `INSERT` hitting the same key twice throws *"cannot affect row a second time"*.

**Invariant to test after any attribution change:**
**Campaign tab total == Ads tab total**, under every combination of source, account, and feed.
Nadia named this her most important requirement. Verify it, don't assume it.

---

## 11. TRACK.md is mandatory

`TRACK.md` is the running build log — what was built, when, and *why*. It is how a future session
reconstructs intent that the code alone doesn't carry.

**After every change — code, migration, schema, bug fix, or decision — append an entry to
`TRACK.md` before you finish your turn.** This is not optional, and it applies even to small
changes. Follow the existing format there. If a change was investigated but *not* made, record that
too, with the reason.

---

## 12. Current state

*(Rewritten 2026-09-22. Trust `git log`, `_migrations`, and the tail of `TRACK.md` over this list.)*

- **Git:** branch `main`, remote `origin` (GitHub). History was re-initialised on 2026-09-21
  (`36e7de1 m1.0`), so older TRACK.md commit hashes no longer resolve. Commit everything; push only
  after the user's explicit OK (§1).
- **Latest applied migration: `047`** (2026-09-09). Authoritative MV = `047`. No migration is
  pending.
- **Milestones 1–3 complete and live.** DDC (Milestone 3) is fully integrated: daily + hourly
  feeds, device split, `tt` normalisation + trailing-window click-weighted attribution (046),
  hourly cron, daily client CSV report. Live figures tie to DDC's own `report_type=date` API to the
  cent on every day checked.
- **Performance plan (2026-09-22):** `docs/plans/performance-plan.md` — measured causes of slow page
  loads (Render cold starts, non-concurrent MV refresh 5×/hour, a per-row orphan lateral, unindexed
  `sync-status`/options scans) and a phased fix. Nothing built yet.
- **Next planned work: a second dashboard ("Joe")** — `docs/plans/joe-dashboard.md` (2026-09-17).
  Same repo deployed twice with a **separate Supabase DB**; needs `TENANT_ACCOUNT_INCLUDE/EXCLUDE`
  and `ENABLED_SOURCES` env filters at ingestion. Nothing built; blocked on Joe's Taboola account
  naming and IA affiliate names. Not yet in TRACK.md.
- **Known open issues (not bugs to fix in passing — check TRACK first):**
  - Taboola cost has been effectively dead upstream since ~2026-08-19 (verified upstream, not
    pipeline). Taboola-side Campaign-vs-Ads spend gap ~$52 on a $194 base, and a $0.23 revenue
    delta under `gd=AP1009377` — logged 2026-09-18, unchased.
  - 17 `(gd, r)` pairs genuinely shared by two Outbrain accounts are single-owned by the scoring
    rule in `syncOutbrainPromotedLinks`; a proper split needs click-share allocation in the MV
    (user's decision).
  - `view=ads` returns 500 for windows longer than ~2 months; `/api/filters/options` is ~341 KB.
  - Latent: the API's `-8` arm is Outbrain-only while the MV's `ddc_orphan` also routes
    Taboola/NULL-platform DDC rows to the DDC account — breaks Campaign == Ads only if
    `tb.startgonow.com` ever earns (2 rows, $0 today).
  - `actual_cpm` is computed by the API but rendered nowhere.
  - SBH_ssm_08 and SBH_ssm_10 remain untagged (partner never confirmed).
- **Outstanding asks for Nadia's team:** the broken IA tracking template on `ssm.flux.pro.fb`
  (literal unsubstituted macro) and the ~38 campaigns whose IA templates send `campaign_id` where
  `ad_id` is expected.

## Stale docs

- `docs/ARCHITECTURE.md` — good on the Codefuel join and OAuth; **wrong** on the cron table (says
  6h metadata / 3-day backfill), the frontend tree, and "UI not built yet".
- `RUNBOOK.md` — same cron drift.
- Treat both as historical. This file is current.
