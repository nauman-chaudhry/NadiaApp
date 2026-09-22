# Dashboard performance — analysis and plan

**Date:** 2026-09-22 · **Status:** plan, nothing built · **Trigger:** client — *"the dashboard is a bit
slow to load most of the time, and as we add more sites and projects I'd like it faster."*

Everything below was measured on the live system today (API `https://nadiaapp.onrender.com`,
production Supabase, read-only). Estimates are labelled as estimates.

---

## 1. What a page load costs today

The frontend renders every tab on the server. Each navigation makes **three API calls in parallel** —
`/api/filters/options`, `/api/stats?view=…`, `/api/sync-status` — waits for the slowest, then ships
the rows *twice* (HTML + React payload). So a page is never faster than its slowest call.

Live timings (14-day window, all accounts, measured 2026-09-22 08:50–09:05 UTC):

| call | warm, back-to-back | first hit after a pause | notes |
|---|---|---|---|
| Render cold start (after ~15 min idle) | — | **22.8 s** | free instance spins down; every morning open pays this |
| `/api/filters/options` | 1.0 s | **2.1–6.1 s** | 358 KB; 6 queries, two of them scan all 340k `partner_stats_hourly` rows |
| `/api/sync-status` | 0.7 s | **1.5–3.5 s** | seq-scans `ad_stats_hourly` (170k) + `partner_stats_hourly` ×3 |
| `campaign` | 1.3 s | | 235 KB, 400 rows; DB exec 0.26 s |
| `daily` / `hourly` | 0.4–0.6 s | | DB exec < 10 ms — the rest is transfer/latency |
| `device` / `country` / `site` (Taboola) | 2.2–2.9 s | | DB exec ~2.2 s each — same hot spot (§2.3) |
| `ads` (all sources) | **10.2 s** | | 637 KB, 891 rows; DB exec 3.6 s + 1.8 s |
| `ads`, 90-day window | **120 s → HTTP 500** | | hits `statement_timeout` |
| `ads` outbrain, 30-day | 3.1 s (local) | | pg_stat_statements: filtered variants average **25–49 s**, max 96 s |

**Net for the client:** opening the Campaign tab in the morning ≈ 23 s cold start + ~6 s; each tab
switch afterwards ≈ 2–6 s; the Ads tab ≈ 10 s; anything over ~2 months on Ads fails.

### What is *not* the problem
- Row counts are small (MV 186k rows / 38 MB; largest table 340k rows / 211 MB; DB 383 MB).
- Render → Supabase latency is ~30–100 ms per query; fine.
- The MV-backed tabs (campaign/daily/hourly) execute in 10–260 ms once the data is cached.

---

## 2. Root causes, ranked by impact

### 2.1 Render free instance — cold starts (23 s) and 0.1 CPU
`render.yaml` has `plan: free` for the API. Render spins it down after 15 minutes idle; the first
request pays a full boot. This is the single largest number in the analysis and it needs no code.

### 2.2 The pool drops connections after 30 s idle; the DB's cache is smaller than its working set
`db/client.ts` sets `idleTimeoutMillis: 30_000`, so after a short pause every query first
re-handshakes TLS to the Supabase pooler in Tokyo. Separately, Supabase is on the smallest compute
(`shared_buffers` 224 MB, `work_mem` 2 MB, 60 connections) while the tables the dashboard scans total
~315 MB — so any full scan evicts the cache and the next scan reads disk again. Together these are
why the same endpoint measures 0.7 s one minute and 3.5 s the next.

### 2.3 A per-row lateral subquery in the "Codefuel orphan" branch — ~2.1 s on four tabs
Device, Country, Site and the Taboola side of Ads (and the MV's `codefuel_orphan` CTE) all contain:

```sql
LEFT JOIN LATERAL (SELECT c.ad_account_id FROM ads a JOIN campaigns c ON c.id = a.campaign_id
                    WHERE a.gd_param = p.asset_gid GROUP BY c.ad_account_id
                   HAVING COUNT(DISTINCT c.ad_account_id) = 1 LIMIT 1) gid ON TRUE
```

Postgres runs it once **per orphan row**: 1,767 iterations × ~1.2 ms, 810,950 index lookups on
`campaigns_pkey`, for a 14-day window. Plan: `Nested Loop Anti Join … actual time=767..2299 ms`. It
is the entire cost of those three tabs and the majority of the Taboola Ads cost. The result depends
only on `gd_param`, so it can be computed once as a small hashed CTE.

### 2.4 Every page load re-queries filter options and sync freshness from the big tables
`/api/filters/options` runs `SELECT DISTINCT country …` and `SELECT DISTINCT device …` over all
340k `partner_stats_hourly` rows (443 ms + 171 ms execution, 4,563 + 1,728 + 2,835 calls to date —
the **second and third most expensive statements in the database's history** after the refresh).
`/api/sync-status` seq-scans `ad_stats_hourly` (1.1 s) and `partner_stats_hourly` three times
(3.3 s total) because `MAX(fetched_at)` has no index. Both results change at most hourly.

### 2.5 The materialized view refresh: 17 s, five times an hour, exclusive lock, spilling to disk
`pg_stat_statements`: `REFRESH MATERIALIZED VIEW joined_stats_hourly` — **6,789 calls, mean 15.2 s,
max 55 s, 28.7 hours of DB time since May**. It is scheduled inside five separate hourly jobs
(`:05 :15 :20 :25 :45`) plus the 03:00 backfill, so the small shared vCPU is pegged for ~80 s of
every hour. Two structural problems:
- It is the **non-`CONCURRENTLY`** form, which takes an `ACCESS EXCLUSIVE` lock: Campaign/Daily/Hourly
  reads *wait* while it runs. Measured collisions are rare today (campaign-query max 1.9 s) because
  traffic is light, but the window grows with data and with users.
- The plan shows **96 sort/hash spills** (2 MB `work_mem`) and its single worst CTE is `ddc_cand`
  (5.3 s): 1,773 loops over `outbrain_ad_daily` by day with **no index on `promoted_link_uuid`**.

### 2.6 The Ads tab
Two heavy CTE chains run per request (Taboola + Outbrain, ~4.5 s DB), then 637 KB of JSON is
serialised on a 0.1-CPU instance and shipped twice. Missing indexes force a 264k-row bitmap scan of
`idx_partner_source_platform` to find 3.4k rows, and a 752 ms scan of the unattributed unique index
for 1.7k rows. Over ~2 months the planner's estimates collapse and it exceeds 120 s.

### 2.7 Frontend data flow
- `cache: 'no-store'` + `force-dynamic` on every fetch, so nothing is reused between navigations.
- `FilterBar` (client component) receives all **4,263 campaigns** as props on every page.
- No streaming: the whole page waits for the slowest of the three calls before anything paints.

### 2.8 Sync-side chatter (not user-facing, but it competes for the same tiny DB)
Row-by-row upserts: `INSERT INTO ads` **6.3 million** single-row calls, `campaigns` 3.8 M,
`outbrain_campaigns` 292k. The `:25` Outbrain job runs ~7 minutes largely for this reason.

---

## 3. The plan

Ordered so each phase is independently shippable and measurable with the same curl matrix. Effort is
working time; every step ends with the existing **Campaign == Ads (spend and revenue)** check.

### Phase 0 — infrastructure (no code; ~1 hour; the user does these)
| step | effect | notes |
|---|---|---|
| **Move the API off the free plan** (Render Starter, ~$7/mo) | removes the 23 s cold start; 5× more CPU for JSON serialisation | the biggest single win available; verify the worker's plan while there |
| Keep DB connections warm: `idleTimeoutMillis` 30 s → 10 min, `min: 2` in `db/client.ts` | removes the ~1 s first-hit re-handshake | tiny code change, ships with Phase 1 |
| Note the regions: Supabase = **Tokyo**, Render = Oregon (default), Vercel functions = check project setting | co-locating Render (Singapore) + Vercel (`hnd1`/`sin1`) saves ~100–200 ms per page | low priority; one-time settings, no code |

### Phase 1 — quick database wins (migration `048` + `server.ts`; 1–2 days)
1. **Indexes** (`048_perf_indexes.sql`, all `CREATE INDEX CONCURRENTLY`-safe, no data change):
   - `partner_stats_hourly (client_partner_id, hour_utc DESC)` and `(client_partner_id, fetched_at DESC)` — `sync-status` 3.3 s → ~5 ms; also serves the `cf_key` scan (752 ms → ~20 ms).
   - `ad_stats_hourly (fetched_at DESC)`.
   - `partner_stats_hourly (client_partner_id, source_platform, hour_utc)` — replaces the 264k-row bitmap scan in every Outbrain CTE.
   - `outbrain_ad_daily (promoted_link_uuid, day_utc)` — `ddc_cand` in the MV (5.3 s) and the Ads tab (467 ms seq scan).
2. **Replace the per-row orphan lateral with a hashed `gd_owner` CTE** in the device/country/site/ads
   builders and in the MV's `codefuel_orphan` (that part is migration `049`, a full MV re-declaration
   per §7 of CLAUDE.md). Expected: those three tabs 2.2 s → ~0.3 s; Taboola Ads −2 s; MV refresh −2 s.
   Attribution semantics are unchanged (same "exactly one owning account" rule) — verify row-for-row.
3. **`/api/filters/options`**: cache the assembled response in-process for 5 minutes (metadata only
   changes on the 2-hourly job) and derive countries/devices from indexed, bounded queries instead of
   table scans. Also drop `id` from the campaign list (the frontend keys on `external_id`) and add
   `Cache-Control`/ETag so Vercel can revalidate cheaply. Expected: 1–6 s → <50 ms after first call.
4. **`/api/sync-status`**: indexes from step 1 plus a 60 s in-process cache. Expected: 0.7–3.5 s → ~10 ms.
5. **`SET LOCAL work_mem = '64MB'`** inside the refresh transaction and the Ads endpoint — eliminates
   the spills without touching the global setting. Micro compute has 1 GB; a handful of concurrent
   64 MB sorts is safe.

Expected after Phase 1 (estimates): Campaign tab ~1 s warm; Device/Country/Site ~1 s; Ads 14d
~3–4 s; refresh 17 s → ~8 s.

### Phase 2 — refresh architecture (2–3 days)
This is the part that decides whether "more sites and projects" stays fast.
1. **Make the refresh non-blocking.** Recommended: the *swap* pattern — build `joined_stats_hourly_next`
   as a table with `CREATE TABLE … AS <select>`, create its indexes, then `DROP` + `RENAME` in one
   transaction (readers block for milliseconds, not 17 s). Alternative: `REFRESH … CONCURRENTLY`,
   which needs a synthetic unique key column (`row_number()`) and costs 2–3× the refresh time in
   diffing — workable but worse. The API keeps reading the same name and columns; only the
   migration convention changes (view → table + a `rebuild_joined_stats()` SQL function).
2. **One refresh, not five.** Each sync sets a dirty flag; a single debounced refresher runs at most
   once per ~10 minutes when dirty, and the 03:00 backfill triggers one at the end. Same freshness
   for the client, one fifth of the DB time.
3. **Rebuild only what changed.** Everything older than the backfill's 4-day window is immutable, so
   partition the joined table by day and rebuild the last 7 days on each refresh, with a full rebuild
   nightly. Refresh cost stops growing with history: ~17 s today → ~2 s, flat.
4. **Batch the sync writes** — multi-row upserts for `ads`, `campaigns`, `outbrain_*` (the
   partner_stats syncs already do this). Shrinks the `:25` job from ~7 min to <1 min and frees the
   DB for readers.

### Phase 3 — frontend (1–2 days)
1. `fetchFilterOptions` → `next: { revalidate: 300 }`; `fetchSyncStatus` → 60 s. With Phase 1 this
   makes both effectively free and removes them from the critical path of every navigation.
2. Stop serialising 4,263 campaigns into every page: load the campaign list lazily when the picker
   opens (client fetch, cached), or add a server-side search endpoint.
3. **Stream the table**: wrap `StatsTable` in `Suspense` with a skeleton so the shell and filters
   paint immediately and the table arrives when ready. Navigation feels instant even if the query
   takes 2 s.
4. Ads payload: round money to 2 dp in the API, drop the never-rendered `actual_cpm`, and virtualise
   the table body (`react-window`) — 891 rows × 25 columns is ~22k DOM cells today.

### Phase 4 — for growth (when data or partners roughly double)
- A **daily-grain rollup** (`joined_stats_daily`, and an ads rollup at link×day grain) serving any
  window longer than 14 days: 1/24 the rows, and it is what fixes the 90-day Ads timeout properly.
- Partition `partner_stats_hourly` by month once it passes ~2 M rows.
- Re-check Supabase compute *after* Phases 1–2 by measuring cache-hit ratio; upgrade Micro → Small
  (~$15/mo, 2 GB) only if the working set still exceeds cache. Don't buy hardware to hide the
  lateral and the missing indexes.

### Expected outcome (estimates, to be replaced by measurements as each phase lands)

| scenario | today | after Phase 0+1+3 | after Phase 2+4 |
|---|---|---|---|
| morning first open, Campaign tab | ~30 s | ~2 s | ~1 s |
| tab switch, warm | 2–6 s | ~1 s | <1 s |
| Ads tab, 14 days | ~10 s | ~3 s | ~2 s |
| Ads tab, 90 days | fails (120 s) | ~20 s | ~3 s |
| refresh lock window per hour | ~80 s, blocking | ~40 s, blocking | ~10 s, non-blocking |

---

## 4. What I would not do
- No rewrite, no move off Supabase/Render/Vercel, no Redis: in-process caching and indexes cover it.
- No change to attribution logic. Every step here is a plan-shape or caching change; the numbers on
  screen must not move, and the Campaign == Ads matrix is the gate for each commit.

## 5. Decisions needed
1. Approve the Render paid instance (and confirm the worker's plan) — Phase 0.
2. Phase 2 changes the MV from a view to a swap-rebuilt table; confirm that convention change is
   acceptable before it is built (it touches how future MV migrations are written).
3. Order: I recommend 0 → 1 → 3 → 2 → 4. Phase 3 before 2 because it is what the client *feels*
   first; Phase 2 is what keeps it that way as data grows.

## 6. Evidence
Raw outputs from today's session (not committed): live curl matrix, `pg_stat_statements` top-40,
`EXPLAIN (ANALYZE, BUFFERS)` for every API statement over 300 ms and for the MV body, in the
session scratchpad. Key numbers are reproduced above and in `TRACK.md` 2026-09-22.
