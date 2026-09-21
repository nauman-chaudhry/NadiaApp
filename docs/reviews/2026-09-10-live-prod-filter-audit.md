# Live production audit — every filter × every tab
**Date:** 2026-09-10 (run 2026-09-09 19:40–20:25 UTC)
**Target:** LIVE — API `https://nadia-api.onrender.com`, frontend `https://nadia-dashboard-two.vercel.app`
**Mode:** read-only. No deploy, no migration, no write, no sync job. DB touched with SELECTs only.
**Deploy state confirmed live:** `_migrations` tops out at `047_mv_ia_orphan_deterministic_account.sql`
(applied 2026-09-09 19:31 UTC). `/api/filters/options` returns 4,263 campaigns and 41 GDs → the
dropdown fix and the GD fix are both live on the API.

Probe volume: **~320 live requests** across 3 windows (2026-08-01..09-09, 2026-09-01..09-09,
2026-06-01..06-30) plus a 114-value dropdown sweep. **Zero HTTP 500s. Zero non-200s anywhere.**

---

## 1. Filter × tab matrix

Window 2026-08-01..2026-09-09. Baselines: campaign/daily/hourly/ads = **$83,697.50 spend /
$139,813.8643 revenue**; device/country/site = **$1,707.06 / $1,638.10**.
INERT = returns byte-identical rows *and* totals to unfiltered.

| filter | campaign | daily | hourly | device | country | ads | site |
|---|---|---|---|---|---|---|---|
| date range | WORK | WORK | WORK | WORK | WORK | WORK | WORK |
| source=taboola | WORK | WORK | WORK | **INERT** | **INERT** | WORK | **INERT** |
| source=outbrain | WORK | WORK | WORK | WORK | WORK | WORK | WORK |
| account_id | WORK | WORK | WORK | **EMPTY** | **EMPTY** | WORK | **EMPTY** |
| campaign_id | WORK | WORK | WORK | WORK | WORK | WORK | **EMPTY** |
| status | WORK | WORK | WORK | **INERT** | **INERT** | WORK | **INERT** |
| country | **INERT** | **INERT** | **INERT** | **INERT** | WORK | **INERT** | **INERT** |
| device | **INERT** | **INERT** | **INERT** | WORK | **INERT** | **INERT** | **INERT** |
| gd | WORK | WORK | WORK | EMPTY* | EMPTY* | WORK | EMPTY* |
| feed=yahoo/flux | WORK | WORK | WORK | WORK | WORK | WORK | WORK |
| **site** | **INERT** | **INERT** | **INERT** | **INERT** | **INERT** | **INERT** | **INERT** |

`*` GD returns empty on device/country/site because those tabs only ever show the Taboola slice
(defect D1) and the probed GD is Outbrain-side. Downstream of D1, not independent.

`feed` splits exactly: yahoo $138,718.7948 + flux $1,095.0695 = $139,813.8643 = base, on all
three grains. `source` splits exactly on campaign/daily: $1,638.095 + $138,175.7693 = base.

---

## 2. THE INVARIANT — Campaign total == Ads total

**84 combinations tested (28 filter combos × 3 windows). Revenue: 84 matched, 0 mismatched, 0 errors.**
Combos included every multi-value form, the F1 500-repro (`gd`+`campaign_id`), 6-filter stacks,
and garbage input (`account_id=abc,239`, bogus campaign/gd/account ids — all 200, all reconciled).

**Spend does NOT match exactly.** Campaign is consistently *below* Ads:

| window | filter | campaign spend | ads spend | drift |
|---|---|---|---|---|
| Aug | unfiltered | 83,697.50 | 83,699.62 | **−2.12** |
| Aug | account=239 | 32,639.88 | 32,640.11 | −0.23 |
| Sep | unfiltered | 18,504.84 | 18,506.64 | **−1.80** |
| Jun | unfiltered | 40,513.36 | 40,513.22 | **+0.14** |

Present on 43 of 84 combos, max **$2.12** (0.0025%). Sign flips by window, consistent with
share-allocation rounding. This is the already-known open item, still open, and it means
"Campaign == Ads" is exact on revenue but only ~$2 true on spend.

---

## 3. Defects

### D1 — CRITICAL. Country / Device / Site under "All Traffic Sources" show ONLY Taboola.
`buildStatsSql` gates the Outbrain branches on `p.source === 'outbrain'` (server.ts:554, 612, 716).
With no source filter it falls through to the Taboola-only builder. The Ads tab handles this
correctly by running both builders and concatenating (server.ts:196); device/country/site do not.

Live, 2026-08-01..09-09:

| tab | default (all sources) | source=outbrain alone | invisible by default |
|---|---|---|---|
| Country | $1,707.06 spend / $1,638.10 rev, 5 rows | **$81,994.39 / $8,575.72, 22 rows** | 98.0% of spend |
| Site | $1,707.08 / $1,638.10, 363 rows | **$79,830.29 / $8,575.72, 2,064 rows** | 97.9% of spend |
| Device | $1,707.06 / $1,638.10, 4 rows | $0 / $1,366.45, 3 rows | $1,366.45 rev |

June 2026 same shape: Country default $6,050.64 spend, Outbrain-only $34,462.84 unseen.
Campaign tab for the same window is $83,697.50 — a client opening Country sees **2%** of it.
Repro: `/api/stats?view=country&from=2026-08-01&to=2026-09-09` vs the same with `&source=outbrain`.

### D2 — CRITICAL (same class as the two bugs already shipped). Country and Device are INERT on Campaign, Daily, Hourly and Ads.
`FilterBar.tsx` renders the Country multi-select (line 541) and Device select (line 552)
**unconditionally on all 7 tabs** — no per-view gating — and `DashboardShell` sends them. The MV
has no country/device dimension, so `mvWhereParts` never applies them.
Live: `view=campaign&country=US` → 414 rows / $83,697.50 / $139,813.8643 — **identical to
unfiltered, to the cent**. Same for `device=mobile`, `device=desktop`, on campaign, daily, hourly
and ads (ads: 1,476 rows / $83,699.62 / $139,813.8643 unchanged).
This is exactly what Nadia reported for GD: a control that visibly does nothing.

### D3 — MAJOR. The `site` parameter is accepted and silently ignored on every tab, including the Site tab.
`p.site` appears **nowhere** in `server.ts` (zod accepts it at line 178; no consumer). Live:
`view=site&site=Stellis - App - US2` returns all 363 rows / $1,707.08 / $1,638.095 — the full
unfiltered result. Mitigating: there is no Site control in `FilterBar.tsx`, and
`/api/filters/options` returns `sites: []` (hardcoded, server.ts:161), so Nadia cannot reach it
today. It is a live trap for whoever adds the control.

### D4 — MAJOR. Hourly disagrees with Campaign/Daily under `source=outbrain`.
2026-08-01..09-09, `source=outbrain`:
- Campaign **$81,990.90 / $138,175.7693**, Daily identical.
- Hourly **$84,020.46 / $130,966.4947** → spend **+$2,029.56**, revenue **−$7,209.27 (−5.2%)**.

June 2026: spend −$9.21, revenue identical. Unfiltered and every non-outbrain filter, Hourly
matches Campaign to the cent. The gap is confined to the `outbrain_marketer_hourly` branch
(server.ts:374). The spend delta is expected by design (account-grain hourly cost); the
**$7,209.27 revenue shortfall is not explained** and is the number Nadia would query.

### D5 — MAJOR. Status is INERT on Country, Device and Site.
All four statuses (`enabled`, `disabled`, `PAUSED`, `REJECTED`) return the identical
$1,707.06 / $1,638.10 on all three tabs. The control is rendered on those pages.

### D6 — MAJOR. The current day always reads 100% margin.
`view=daily&from=2026-09-09&to=2026-09-09` → **116 rows, $0.00 spend, $1,820.2616 revenue,
margin 100.0%, profit $1,820.26** — identical on campaign, daily and ads. Outbrain cost is
daily-grain and lands next day; Taboola has been dead upstream since 2026-08-19. The
**"Today" preset is the first entry in the date picker** (`FilterBar.tsx:39`), so this is one
click from the default view. 09-03..09-08 all look sane (margins 6.6%–37.1%).

### D7 — MAJOR (worker deploy missing). The Codefuel yesterday+today fix is NOT live.
`sync_runs` shows **exactly 1 codefuel run per hour** for the last 14 hours (new code = 2).
DDC by contrast shows **4 rows/hour** — the merged hourly DDC job **is** deployed. So the worker
carries the DDC change but not the Codefuel one.
Live consequence, right now: **2026-09-08 hour 23 is missing** from `partner_stats_hourly`
(09-08 has 23 of 24 hours; 09-06 and 09-07 have 24). Last write touching 09-08 was
`fetched_at = 2026-09-09 05:21:42 UTC`; every run since has asked for 09-09 only. That hour
cannot arrive until the 03:00 backfill ~7h from now. Neighbouring hours run $9–$20.

### D8 — MINOR. `conversion_scrub` goes negative on orphan rows.
`conversions − ad_clicks` (server.ts:358). On revenue-only synthetic rows conversions is 0, so
the column renders negative: **43 campaign rows, 190 ads rows, 39 site rows** in the Aug window.
Worst: the `-1` IA-unmapped row at **−537**.

### D9 — MINOR. Two Campaign rows carry revenue with a blank Account cell.
`(Unattributed — Outbrain Image Advantage)` **$1,637.29** and `(Outbrain — Codefuel, not mapped
to campaign)` **$0.04** have `ad_account_id IS NULL` in the MV, so `ad_account_name` is null.
They are correctly *labelled* in the campaign column, so totals reconcile — but they vanish under
any account filter, which is why per-account slices sum below the total.

### D10 — MINOR. Dropdowns are not filtered by activity.
**30 of 41 GDs return nothing over a 3.5-month window** (2026-06-01..09-09), and **19 have never
had a single Taboola cost row** (e.g. AP1008139: 103 ads, `last_cost = never`). The rest last had
cost in April (AP1009077/79/80/81, AP1009169/70, AP1009194–98) or June/July (AP1008549, AP1008652).
Likewise **16 of 33 accounts** return 0 rows or all-zero over that window — all Taboola, consistent
with the upstream Taboola outage.
All defensible individually, but it means a genuinely broken filter is indistinguishable from a
correctly-empty one, which is how D2 stayed invisible.

---

## 4. What is CLEAN — stated plainly

- **No HTTP 500s.** ~320 requests, including the exact `gd`+`campaign_id` combination that
  returned 500 before the `/g` regex fix, plus 6-filter stacks and malformed input. All 200.
- **Campaign == Ads on revenue: 84/84**, to the cent, across 3 windows.
- **Nadia's original complaint is fixed at the data layer.** `US-IT Best Management Software- 3 Sept`
  (`001e45713998339de4317025ace06d9cac`) is present in the live `/api/filters/options` payload, and
  `FilterBar.tsx:191` matches case-insensitive substring on label **or** key — so typing that name
  finds it. 556 Outbrain campaigns now carry `id: null` as designed; 0 duplicate `external_id`,
  0 blank names.
- **GD filter bites** on campaign/daily/hourly/ads: `gd=AP1009377` → 9 campaigns,
  $1,689.79 / $3,230.87 vs the $83,697.50 / $139,813.8643 base.
- **Partner badges are complete.** Live accounts carry exactly `codefuel` (12), `image_advantage` (6),
  `ddc` (1) and `null` (14 → "Untagged"). All three codes are mapped in all four frontend maps
  (`PARTNER_COLORS`, `PARTNER_LABELS`, `PARTNER_FULL`, `ACCT_BADGE`). No unmapped code, no grey chip.
- **Feed split is exact** and does not double-count cost: yahoo + flux == base on every tab.
- **Row hygiene:** across all 7 tabs — **0 NaN, 0 Infinity, 0 negative impressions / clicks /
  conversions / sessions, 0 blank dimension names.** Every 100%-margin row is a labelled
  zero-cost orphan bucket, which is by design. MV scan (31,229 rows since 2026-08-01):
  0 blank campaign names, 0 negative money or traffic columns.
- **Totals rows cannot drift from the body** — `StatsTable.tsx` computes them client-side from the
  same rows it renders.
- **Multi-value filters work** for account_id, campaign_id, status and gd, and `account_id` ignores
  non-numeric tokens instead of erroring.
- **Latency:** worst observed 8.2s (`view=ads&device=desktop`, full window). Typical 0.4–3s.
  Cold start ~6s on first request.

---

## 5. Could NOT verify

- **The live UI itself.** The Chrome extension is not connected ("Browser extension is not
  connected"), and `https://nadia-dashboard-two.vercel.app/dashboard/*` returns **307** to the
  Supabase login for an unauthenticated client. Everything in §7 of the brief was therefore
  verified against the live API payload and the frontend source, not by clicking. Specifically
  **unverified by eye**: that the dropdowns render and are searchable in the browser, and that the
  badges paint. The data and the code behind them are correct.
- **The dollar value of the missing 2026-09-08 h23** — that needs a call to Codefuel's API, which
  would be a sync-adjacent action, out of scope for a read-only pass.
- **Root cause of D4's $7,209.27** — identified the branch, did not trace which revenue bucket the
  `outbrain_marketer_hourly` path drops.
