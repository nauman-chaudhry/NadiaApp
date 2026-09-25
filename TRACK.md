# TRACK.md — build log

Running record of how this dashboard was built: what changed, when, and **why**. The code shows
*what* the system does; this file preserves the reasoning, the bugs behind each fix, and the
decisions that aren't recoverable from a diff.

## How to update this file

**Rule (also stated in `CLAUDE.md`): after any change — code, migration, schema, bug fix, or
decision — append an entry here before finishing the turn.** This applies to small changes too.
Record investigations that led to *no* change as well, with the reason: knowing something was ruled
out is as valuable as knowing what was done.

Append to the current milestone (newest milestone at the bottom). Use this shape:

```markdown
### YYYY-MM-DD — short title
**What:** one or two lines on the change.
**Why:** the problem, symptom, or request behind it. Name the bug if there was one.
**Files/migrations:** paths and migration numbers.
**Verified:** how you proved it works — real numbers, not "should be fine".
**Commit:** `<hash>` (or "uncommitted" / "not committed — user deploys")
```

Keep entries factual. If something is unverified, say so explicitly.

---

## Milestone 1 — Foundation: Taboola cost + Codefuel revenue

Goal: join native-ad cost to search-partner revenue and get the numbers to match ground truth.

### 2026-05-26 — First data-accuracy pass (v1, v2)
**What:** Resolved the first five reported dashboard data bugs, then a second round reconciling
against Taboola and Codefuel as ground truth.
**Why:** Initial numbers didn't match the source platforms. This set the pattern for the whole
project — every subsequent milestone is a reconciliation exercise.
**Commits:** `e732e89`, `108de8d`

### 2026-05-27 — Impressions metric corrected
**What:** Store Taboola `visible_impressions` instead of total impressions.
**Why:** Total impressions inflated CPM and CTR versus what Taboola's own UI reports.
**Commit:** `ba10b4b`

### 2026-05-30 — Image Advantage (AMOS) revenue integration
**What:** Second revenue partner added: `sources/imageadvantage/client.ts` + `sync/imageadvantage.ts`,
plus migration `008` adding `campaign_ext_id` / `item_ext_id` to `partner_stats_hourly`.
**Why:** IA attributes revenue by a tracking tag, not by the `(gd, r)` pair Codefuel uses — so the
table needed a second row shape and a second partial unique index.
**Commit:** `da52a94`

### 2026-05-30 — Two immediate consequences of migration 008
**What:** (a) Added `WHERE campaign_ext_id IS NULL` to Codefuel's `ON CONFLICT`; (b) batched Codefuel
upserts at 100 rows/statement.
**Why:** (a) Migration `008` replaced the table-level UNIQUE with two *partial* indexes, so
`ON CONFLICT` had to name the predicate or it matched nothing. (b) Row-at-a-time upserts hit
Supabase's statement timeout.
**Commits:** `1bfd5c8`, `762b9cf`

### 2026-06-01 → 06-06 — Reconciliation v3, partial-day gaps, audits
**What:** Column standardization, Ads-tab dedup, hourly fix, and the `refresh-all` command
(`33fb5b7`). Then `sync-day`, a 48h `refresh-all` window, and a sync-status bar (`9f4bb46`). IA data
extended into the device/country/ads reports (`e070bf8`). Platform-tag extraction in the IA sync to
separate Taboola from Outbrain revenue (`f0c4e16`). Several full audits of Apr 1 → Jun 6.
**Why:** Syncing a *partial* day left permanent gaps — a cron run mid-day recorded incomplete hours
and never revisited them. Rolling windows were introduced so every run self-heals earlier days.
**Commits:** `33fb5b7`, `e7be24b`, `9f4bb46`, `e070bf8`, `a044b80`, `f0c4e16`, and the 06-06 audits

### 2026-06-07 → 06-13 — The materialized-view rewrites
**What:** Migrations `012`, `014`, `015`, then `016`–`023`. Iterations: 5-branch aggregation →
campaign-grain merge → cost/revenue co-located on one row → orphan Codefuel assets surfaced → IA
`tb:`-prefix strip for 100% attribution → real per-account device/country cost from Taboola's
breakdown reports → the Site tab built on Taboola's publisher breakdown.
**Why:** This was the hardest stretch. The recurring failure was **revenue fan-out**: joining
revenue to multiple matching ads multiplied it. The fix that finally held was collapsing all revenue
to one row per `(campaign, hour, account)` *before* joining cost — still the architecture today.
Orphan/unattributed rows were introduced here too, so revenue that resolves to no ad is *shown* as a
labelled row rather than dropped.
**Also:** per-site IA revenue after discovering `item_ext_id` **is** the Taboola site id (`93c63cf`);
geo-cost backfill made ~25× faster by skipping spendless days (`938b354`).
**Commits:** `50c6180`, `24b8931`, `55f19c3`, `4c631bd`, `590ab0d`, `c06f68e`, `0396c1d`, `c934887`,
`5a343ff`, `0f94dd4`, `594dbc5`, `bac4dc5`, `e9aedba`, `3f3800d`, `0cbc4e6`, `1d65dd6`, `dbd7113`,
`422c8b3`, `938b354`, `93c63cf`, `4003d37`, `b09ef42`

### 2026-06-18 → 06-19 — Outbrain as a second cost platform
**What:** Full Outbrain cost + revenue integration (migrations `024`–`032`): schema, per-campaign
attribution for Codefuel-Outbrain, IA ad-id resolution, a 3-way source filter (Taboola / Outbrain /
All), grouped account dropdown, and `ad_accounts` rows for the 7 `SBH_ssm_XX` marketers.
**Why:** Nadia buys on both platforms. Outbrain's reporting is **daily-grain**, not hourly, which is
why its MV branch collapses revenue to `hour_utc::date` and why detail tabs were made Taboola-only
under an Outbrain filter — with an on-screen notice rather than a silently empty table.
**Commits:** `5ebb5e3`, `e357d37`, `aa372b7`, `a3100cf`, `006b6f9`, `1509d79`, `f48b016`, `f01c364`

### 2026-06-21 → 06-30 — x-metrics (Flux), filter UX, Outbrain breakdowns
**What:** `refresh-all` moved to a rolling 4-day window (`afbc64e`). IA **x-metrics** revenue added
with `granularity='x-daily'` (migration `033`) — the non-Yahoo display feed (`4cebfd2`). Filter UX:
inline column filter row, Traffic Source + Project dropdowns, Excel export, frozen header rows.
IA-Outbrain revenue attributed to promoted links (`e102257`) and then allocated down to ads by
click share (`6ce7370`). Per-ad / per-country / per-publisher Outbrain breakdown sync (migration
`036`).
**Why:** x-metrics is a separate, additive revenue stream that has no hourly endpoint — hence a
granularity value the MV never shadows. Note `2409bab`: migrations `033`/`034` **regressed** the
Outbrain `ad_account_id` mapping and it had to be restored in `035` — a reminder that each MV
rewrite re-declares the whole view and can silently drop earlier fixes.
**Commits:** `afbc64e`, `4cebfd2`, `8596d69`, `9e50612`, `aea52a7`, `2409bab`, `e102257`, `6ce7370`,
`9190536`, `51c845b`

---

## Milestone 2 — Reliability + Nadia's requested batch

Trigger: Nadia reported *"new campaigns … are not showing / the cost are not matching for past 2
days, and there is other gaps for some reports."*

### 2026-07-01 — Metadata before stats
**What:** The backfill now discovers new campaigns *before* pulling their stats.
**Why:** Nadia's newly created Taboola campaigns were invisible: stats were fetched for campaigns
the DB didn't know about yet, so the rows had nowhere to land.
**Commit:** `29a1e47`

### 2026-07-05 — Root cause: the 03:00 backfill had been dying silently
**What:** Rewrote the daily backfill into `workers/daily-backfill.ts` with per-step isolation
(`step()`), full `sync_runs` recording (`withSyncRun()`), and a final throw naming every failed step.
**Why:** **The hourly syncs were never broken.** The 03:00 daily backfill was — and it is the *only*
job carrying Outbrain cost, IA x-metrics, and geo-cost. One unhandled error killed the whole job and
nothing recorded the failure, which mapped exactly onto Nadia's "missing cost/revenue since month
start". Metadata frequency also went 6h → 2h.
**Verified:** two consecutive clean cycles on Render.
**Commit:** `61867b9`

### 2026-07-05 — Outbrain marketers auto-register as accounts
**What:** `syncOutbrainCampaigns` now inserts an `ad_accounts` row per marketer, `client_partner_id`
left NULL deliberately.
**Why:** A new marketer (`SBH_ssm_03`) was syncing cost but had no account row, making it invisible
under every Project filter. Partner tagging stays a manual step so an account is never mis-assigned.
**Commit:** `a9459a8`

### 2026-07-05 — Nadia's formatting + filter batch
**What:** Gridlines and zebra striping; date-range presets plus a custom calendar; a global
campaign/ad/ID search box; a hard-refresh button; drag-to-reorder columns with a frozen first column
(persisted per view in localStorage); searchable multi-select dropdowns for Account, Campaign,
Traffic Source, Status, Country, and GD.
**Commits:** `963a6e2`, `ffdaaf7`, `cf88eb8`

### 2026-07-05 — IA reconciliation vs Nadia's spreadsheet
**What:** Reconciled cost across 3 Taboola accounts and Yahoo revenue day-by-day for Jun 1 – Jul 3.
Fixed four distinct bugs to make **Campaign tab == Ads tab**: missing item-id resolution; all-sources
Ads omitting Outbrain entirely; Codefuel revenue fanning out across links sharing a `(gd, r)` pair
plus cross-account leakage under filters; and the `-5` net row ignoring the account filter. Switched
IA y-metrics to **unfiltered** endpoints so new affiliates auto-appear, and fixed the affiliate
suffix regex to `/\.tb(-\d+)?$/` so numbered suffixes like `.tb-2` resolve.
**Why:** The hardcoded affiliate list was silently losing $46–101/day. Nadia named Campaign == Ads
her single most important requirement.
**Verified:** cost matched to the cent on all 6 accounts; Yahoo revenue to the cent on 31 of 33 days
(the ~$16 residual is IA's hourly-vs-daily settling lag on the two newest days, which the nightly
backfill converges). Campaign == Ads confirmed across all sources × accounts 10, 12, 14, 17, 239–244,
834 × both feed values.
**Commit:** `7545509`

### 2026-07-05 — Feeds filter (Yahoo vs Flux)
**What:** Migration `037` adds `revenue_flux` / `ad_clicks_flux` / `sessions_flux` to the MV; the API
exposes `feed=all|yahoo|flux`; a Feeds dropdown appears for the IA project.
**Why:** Implemented as a **column** split rather than a row split, deliberately: splitting revenue
into separate rows would double-count cost through the cost⟕revenue `FULL OUTER JOIN`.
**Commit:** `dd4730e`

### 2026-07-05 — Outbrain account-level hourly cost
**What:** `fetchMarketerHourly` + `outbrain_marketer_hourly` (migration `038`); the Hourly tab now
works under an Outbrain filter.
**Why:** Nadia said Outbrain exposes hourly data and she was right. `breakdown=hourly` returns 400;
the error message leaked the valid enum, revealing **`hourOfDay`** as the working value.
**Commit:** `5c62fc1`

### 2026-07-05 — Outbrain `/periodic` returns only 10 rows by default
**What:** Pass `limit: 24` on the hourly report.
**Why:** Hourly sums came to only ~30% of the daily total. The endpoint silently caps at 10 rows —
found by comparing hourly sums to the daily report per marketer-day, where the response's own
`summary` field exposed the gap.
**Verified:** hourly totals matched the daily report across all 7 marketers.
**Commit:** `6f8bec9`

### 2026-07-07 — Duplicate unattributed rows (migration 039)
**What:** Collapsed existing duplicates, then rebuilt `partner_stats_hourly_unattr_unique` with
`NULLS NOT DISTINCT`.
**Why:** A new IA Facebook affiliate wrote `source_platform = NULL`. Because `NULL != NULL` in
Postgres, `ON CONFLICT` never matched and **every hourly sync appended another copy** — up to 26
duplicates of the same row. Note the *attributed* index still lacks `NULLS NOT DISTINCT`, so
`item_ext_id` must never be NULL.
**Verified:** re-synced twice; row count stayed flat at 25.
**Commit:** `230618e`

### 2026-07-08 — Full data-quality audit
**What:** Audited freshness, `sync_runs`, 9 duplicate-key checks, MV internal duplicates, and a
30-day missing-days matrix. **No changes made.**
**Result:** all 9 duplicate checks = 0, MV duplicates = 0, no sync failures in 3 days, no gaps for
Codefuel / IA / Outbrain. One anomaly: **Taboola cost stopped after 2026-07-06 21:00 UTC.**
**Why no fix:** diagnosed as upstream. A direct API probe showed auth working and 19 accounts
reachable, but zero rows for 07-07 and 07-08, and Taboola's own daily report agreed. 07-07 is a
fully closed day, ruling out settling lag. Our sync correctly fetched, received nothing, and wrote
nothing. Needs Nadia to confirm whether campaigns were paused or budgets exhausted — network-wide
Taboola spend had already fallen to $33.26 on 07-06 before going to zero.

### Outstanding asks for Nadia's team
- Broken IA tracking template on `ssm.flux.pro.fb` — emitting a literal unsubstituted macro
  (`channel = 'campaign.id.ad.id'`).
- ~38 campaigns whose IA templates send `campaign_id` where `ad_id` is expected.

---

## Milestone 3 — DDC as a third revenue partner *(in progress)*

Trigger: Nadia onboarded a new monetization partner, **DDC**, on Outbrain account **SBH_ssm_09**,
with traffic from 22 July. Same integration shape as Codefuel and IA.

### 2026-07-30 — DDC API investigated; plan written; implementation paused
**What:** Probed the live DDC API and mapped every integration touch point. Wrote the full
implementation plan. **No code changes yet** — paused at the user's instruction pending Nadia's
answers.
**Findings (verified against the live API, not assumed):**
- Auth works: `GET /oauth2/access_token?code=<code>` → 30-minute token.
- Report: `GET /api/v1/dw/yss_current_day?access_token=<tok>` → tab-delimited `text/plain`, columns
  `date, hour, domain, country code, device type, campaign, searches, clicks, revenue, TQ, coverage,
  bidded_searches`. **The response begins with a blank line** before the header.
- **DDC's clock is UTC** — the token's `expires` was exactly 30 minutes after our UTC now, confirming
  Nadia's "Yahoo is on UTC". No timezone conversion needed, unlike Outbrain.
- **The endpoint ignores all date parameters.** `?date=`, `?start_date=/?end_date=` returned
  byte-identical responses. It serves a fixed rolling 3-day window. `yss_daily`, `yss_history`,
  `yss_previous_day` → `"Invalid method"`. **So 22–27 July is unreachable via this API.**
- The `tt` type tag is a 34-char hex string — Outbrain's ID format — so DDC can attribute at
  campaign/ad level via the same path IA uses for Outbrain. 8 distinct tags live, all on
  `ob.startgonow.com`; `tb.startgonow.com` (tmpl C245) has no traffic yet.
- `country code` and `device type` are populated — richer than IA, which reports neither.
- `TQ` is `0.00` on every row; natural key `(date, hour, domain, country, device, tt)` has zero
  duplicates.
**Two pre-existing latent bugs identified that DDC would trip:** `cf_key` in `server.ts` has no
`client_partners` join (any new partner's unattributed rows would inflate Codefuel revenue), and the
`-3` synthetic row guards only Codefuel and IA (a third `NOT EXISTS` is needed or campaign spend
double-counts).
**Blocked on Nadia:** (1) route for the 22–27 July history — the "see attached" stats-API doc never
arrived; (2) whether `revenue` is net to Seven Sphere or gross; (3) whether TQ should be surfaced;
(4) confirmation that SBH_ssm_09 is the only DDC account. A message covering all four was drafted
for the user to send.
**Plan:** `C:\Users\DELL\.claude\plans\fancy-squishing-charm.md` (approved)
**Commit:** not committed — no code written yet

### 2026-08-31 — DDC plan rebuilt around the real Stats API; reviewed and revised. Still no code.
**What:** Nadia sent the DDC API documentation (`README.txt`, `ddcStats2.php`, `DDC_API.class.txt`)
and answered the four July questions. Rewrote the Milestone 3 plan from scratch, had it reviewed
adversarially by a separate agent session against the actual source, verified the review's two
open empirical questions against production, and folded everything in.
**Plan:** `docs/plans/milestone-3-ddc.md` (replaces the July plan, which lived at
`C:\Users\DELL\.claude\plans\fancy-squishing-charm.md` and is **not on this machine**).
**Why the plan changed completely:** July probed `yss_current_day` — a fixed rolling 3-day window
that ignored all date params — and concluded 22–27 July was unreachable. The attachments describe a
**different service**, DDC Stats API v2
(`<host>.ddcxlayer.com/webservices.php?service=dailystats`), which takes an explicit
`date_start_*`/`date_end_*` range and reports Type Tag, Country, TQ and Source TQ per domain.
The history blocker is resolved.
**Nadia's answers:** revenue is net, no % to apply (the column is literally *Net Client*); TQ should
be shown, though it stays 0.00 until 3–6+ weeks of volume; the type-tag cap rose from 50 to ~2,000,
closing July's scaling concern; the `tt` now carries an Outbrain publisher macro and reads
`<34-char hex>_<publisher_id>`.
**Findings that changed the design (from the review):**
- The Outbrain Ads tab's `-5`/`-6` rows are hard-wired to `image_advantage`/`codefuel`
  (`server.ts:723,756,793`), so unresolvable DDC revenue would be silently dropped there while the
  MV keeps it — breaking Campaign == Ads. Three explicit DDC branches are mandatory, not optional.
- `ob_ddc_rev` and `ob_ddc_orphan` must be disjoint *by construction* (the IA pair only avoids
  double-counting because its two predicates cannot overlap), and the DDC orphan branch must carry
  a real `ad_account_id` via the `037:120` lateral — otherwise the revenue vanishes the moment the
  account filter is applied while the cost stays.
- Copying IA's last-write-wins dedup Map would **lose** revenue: `source_platform` is absent from
  the attributed unique index, so two `detail` rows on different domains collapse onto one key. The
  DDC Map must accumulate.
- `granularity = 'ddc-daily'` was dropped for plain `'daily'`. The draft's justification was wrong:
  `x-daily` is never shadowed only because `037:28` names it explicitly; `'ddc-daily'` would fall
  into the same fallback arm as `'daily'`, buying nothing and inverting the guarantee if an hourly
  feed is ever added — while costing an `ACCESS EXCLUSIVE` CHECK rebuild on the largest table.
- `cf_key` is **not** a DDC blocker after all (DDC rows are attributed and carry
  `source_platform='Outbrain'`, so they fail both of its predicates). Still worth fixing, but as its
  own earlier commit with its own before/after numbers.
**Verified against production (the reviewer had no DB access):**
- **C5 precondition cleared.** The Ads tab reads `outbrain_ad_daily` while the Campaign tab reads
  `outbrain_stats_daily`; if the former were thin for SBH_ssm_09 the invariant would be unreachable.
  It is not: **$8,104.98 (1,296 rows) vs $8,103.93**, full date coverage 07-22..08-30. The $1.05
  link-grain skew exists for every marketer — Campaign == Ads on Outbrain matches to cents, not zero.
- **A live pre-existing bug found and sized.** Under `feed=flux` the MV's Outbrain branch emits zero
  flux columns so the Campaign tab shows $0, but the Ads tab's `ob_cf_rev` (`server.ts:585`) has no
  feed filter and returns everything. Codefuel-Outbrain revenue was **$8,877.06 in August** across
  17,236 rows. Campaign != Ads is already broken today, before DDC. Sequenced as commit 1.
- IA's broken `.fb` affiliate is still writing NULL-`source_platform` rows: **$410.86** across 2,069
  rows in August.
- SBH_ssm_09: **$8,103.93 of Outbrain cost over 32 campaigns, 2026-07-22..08-30, zero revenue** —
  the account currently reads as a pure loss.
**Blocked on Nadia:** DDC reporting host, username and password are **not in `.env` and nowhere in
the repo** — July's probe used values that were never saved, so nothing can be built or tested
until they arrive. Ten further questions are listed in §9 of the plan; the three that change the
storage key are whether SBH_ssm_09 is DDC-only, whether one type tag can appear on two domains in a
day, and whether DDC should count as "Yahoo" in the Feeds filter.
**Verified:** nothing built — plan only. Awaiting Nauman's line-by-line approval before any code.
**Commit:** not committed — no code written

### 2026-08-31 — DDC credentials found in an earlier message; API tested live; plan verified end-to-end
**What:** Nadia's earlier message (the one that opened Milestone 3) contained the DDC reporting
credentials all along — `https://24223-c9mazdp.ddcxlayer.com`, `nadia@revlogicmedia.com`. Called the
API directly and settled every open assumption in the plan. **Still no code written.**
**Why it matters:** the plan's one hard blocker ("nothing can be built until credentials arrive")
is gone, and six of its eleven open client questions are answered from data instead of waiting on her.
**Verified against the live API:**
- HTTPS works. `date_start`/`date_end` accept a real range — **but the range is SUMMED**, `detail`
  carries no date column, so **the backfill must loop one call per day**. Ranges are only useful for totals.
- **Retention reaches 2026-07-22** — a 40-day `report_type=date` call returned all 40 days.
- Field names: `Mode` (this is the *domain*), `Visitors`, `Clicks`, `Net Client`, `Searches`,
  `BiddedSearches`, `TypeTag`, `Country`, `Tq`, `Source Tq`.
- `detail` reconciles exactly with `date`: 27–29 Aug `detail` = $965.3843 = 388.2823 + 299.1712 +
  277.9308. Free per-day cross-check, built into the API.
- `(Mode, TypeTag, Country)` is **unique in the source** — 0 collisions in 359 rows. DDC sends no duplicates.
- **The review's C3 concern is real and now precisely bounded:** collapsing the tag to its base and
  keying on `(baseTag, Country)` gives **47 collisions across 166 keys in one day**, because one base
  tag fans out over many publisher IDs. Storing the publisher part in `item_ext_id` is therefore
  **required**, not optional. With it, our key is exactly as unique as the source's.
- **The tag change is not a date cutover.** Both bare and suffixed forms appear on the same day for
  the same base tag (29 Aug: 27 bare rows, all $0.00; 332 suffixed rows carrying all $277.93). No
  date-based branching needed anywhere.
- Live tag length is **69 chars**, exceeding the "under 50" limit in Nadia's setup notes. Works anyway.
- `Tq` is **`null`**, not `0.00` as July's probe recorded. `Source Tq` *is* populated (4.00 / 0.00).
- `Visitors` is always 0; `Searches` == `BiddedSearches` in every row observed.
- Only `ob.startgonow.com` returns rows; `tb.startgonow.com` (tmpl C245) still has no traffic.
- Confirmed from her notes: `tmpl=C244` → `ob.`, `C245` → `tb.`; the DDC/Yahoo day ends 5pm PST =
  **midnight UTC**, so it aligns with our `hour_utc` with no conversion.
**The number that matters — SBH_ssm_09 is losing money:** pulled the full DDC history and joined it
to the Outbrain cost already in the DB. 2026-07-22..08-30: cost **$8,103.93**, DDC net revenue
**$6,270.32**, profit **−$1,833.61**, margin **−29%**. Last 7 closed days are worse: cost $3,286.66,
revenue $2,370.01, **−39%**. Only 2 of 40 days were meaningfully profitable (20–21 Aug). First
revenue lands 2026-07-24; 22–23 July are $0.00, matching Nadia's note that the earliest data was
link testing. The dashboard currently shows this account as a pure $8.1k loss because no revenue is
wired in — the true figure is −$1.8k, and worsening as spend scales.
**Backfill target:** $6,270.32 total. The sync must reproduce that to the cent, per day.
**Also available, deferred:** hourly access is credentialed (auth code at `rdp.ddc.com/oauth2`,
then `yss_current_day`, 4–6h lag; `yss_fast_current_day` is 2–4h but carries no TQ). Phase 1 stays
daily-only — see §5.4 of the plan.
**Files:** `docs/plans/milestone-3-ddc.md` (§0 added, §§1,2,4,5.3,7,8,9 revised),
`docs/plans/milestone-3-ddc-message-to-nadia.md`
**Verified:** live API responses, cross-checked against production cost data. Nothing built.
**Commit:** not committed — no code written

### 2026-08-31 — Nadia's answers close every open question; publisher join resolved; TQ dropped
**What:** Second reply from Nadia plus an Outbrain publishers export. All four remaining questions
answered, the publisher-ID mismatch resolved, and TQ removed from scope. Plan updated
(`docs/plans/milestone-3-ddc.md`, now 517 lines). **Still no code written.**
**Her answers:** (1) partners are one-per-account — tag SBH_ssm_09 as DDC; SBH_ssm_08/_10 are **not**
DDC. (2) Sent the publishers export. (3) **TQ is not available — "leave it for now"**, add it later.
(4) 4-day restatement window is fine. (5) The 50-character type-tag limit applies to the **first
part only**; the appended macro isn't counted.
**Publisher mismatch resolved — and the join key was already in our DB.** Outbrain publishes *three*
identifiers and we had been comparing two different ones: `Publisher ID` = 34-char hex (what DDC's
`{{publisher_id}}` macro emits), `Publisher Identifier` = numeric (what
`outbrain_publisher_daily.publisher_id` stores), plus the name. **32 of 34 DDC publisher hexes match
the export, covering 100.0% of suffixed revenue** (the 2 misses are $0.00). No new sync work needed:
`fetchPublisherBreakdown` already returns `publisherUuid` (`metadata.id`) and `syncOutbrainPublisher`
already persists it — verified in production, **545 rows for SBH_ssm_09, all populated, all 34
chars, 129 distinct**. The Site report is just
`partner_stats_hourly.item_ext_id = outbrain_publisher_daily.publisher_uuid`, giving publisher name,
cost and revenue on one row — the first time the Outbrain Site tab shows revenue at all (it
currently hard-codes `0::numeric`, `server.ts:496`). Promoted to phase 1 scope.
**Correction to yesterday's entry — the tag change IS a date cutover.** Earlier I generalised from a
single day and recorded that both formats coexist. Per-day sampling shows the publisher macro went
live **2026-08-28**: everything through 27 Aug is bare, 29–30 Aug is fully suffixed, and 28 Aug is
the one transition day carrying both ($288.90 bare + $10.27 suffixed = **$299.1712**, exactly the
`date` report total — proving the two sets are **disjoint**, not a rollup, so summing both is safe).
**Consequence: DDC's Site report starts 28 Aug, not 22 Jul** — the five weeks before it carry no
publisher attribution. Revenue/cost totals unaffected; only the per-publisher split is.
**Storage key verified collision-free on every day type:** 0 collisions for
`(campaign_ext_id, item_ext_id, hour_utc, country)` on an all-bare day (27 Aug, 110 rows), the
transition day (28 Aug, 203 rows) and both all-suffixed days (29–30 Aug, 359/278 rows).
**TQ dropped — the single biggest simplification.** No `tq`/`source_tq`/`searches` columns, and the
whole weighted-average problem disappears: no SQL aggregate, no `computeTotals` case, no
`computeTotalsClient` case (`StatsTable.tsx:11-33` — the *second* totals implementation that takes
over when an inline column filter is active, which the first draft had missed). `Searches` is
identical to `BiddedSearches` in every observed row and `Visitors` is always 0, so neither is stored.
Because the stats API retains 40+ days, TQ can be added **and backfilled** whenever it populates.
**Net effect on migrations:** `040` now adds **no columns and no CHECK change** — one
`client_partners` INSERT plus one `ad_accounts` UPDATE. The only schema change in the milestone is
the MV rebuild in `041`.
**Where the loss actually is:** joining DDC revenue to Outbrain publisher spend, `glance.com` took
**$5,376.99 of spend and returned $71.02** — about two-thirds of the account's spend for ~1.6% of
its revenue. `sportscentralnews` returned $175.24 on $1,100.34. Nadia has had no way to see this,
which is precisely why she wants the integration. She confirmed she already knows the feed runs at a
loss and wants the dashboard "as soon as possible so I can have more control over the loss".
**Verified:** live DDC API responses cross-checked against production cost and publisher data.
**Commit:** not committed — no code written

### 2026-08-31 — Milestone 3 BUILT (code complete, NOT applied to production)
**What:** Implemented the DDC integration per `docs/plans/milestone-3-ddc.md`, then had an
independent session verify it and fix what it found. **Migrations are NOT applied and no backfill
has run** — `npm run migrate` targets the live production DB and CLAUDE.md §1 says the user deploys.
**Files:** NEW `src/sources/ddc/client.ts`, `src/sync/ddc.ts`, `db/040_ddc_partner.sql`,
`db/041_mv_ddc.sql`, `src/scripts/verify_ddc_sync.ts`. MODIFIED `src/api/server.ts`,
`src/config/env.ts`, `.env.example`, `workers/daily-backfill.ts`, `workers/run-once.ts`,
`frontend/components/{FilterBar,StatsTable,DashboardShell}.tsx`, `CLAUDE.md` §8.
**Design decisions that held:** `granularity='daily'` (no CHECK change, no ALTER); TQ not stored
(client deferred it, and the API's 40-day retention means it can be backfilled later); publisher hex
in `item_ext_id` (required — dropping it collapses 47 of 166 keys in one day); accumulate-don't-
overwrite Map; migration 040 adds no columns.
**Verified before any production change:**
- **041 is a no-op for existing partners.** Built it under a throwaway name against production and
  compared to the live MV: all aggregates identical over ~180k rows (spent 175604.4000,
  revenue 280925.6676, revenue_flux 5054.7185). Test view dropped. The verifier repeated this
  independently as a read-only subquery and got the same answer on 11 aggregates.
- **The sync transform is lossless.** Real parse/accumulate code against the live API for all 40
  days: **$6,270.3164 vs DDC's own `report_type=date` total $6,270.3164**, 40/40 days exact,
  2,077 rows, 0 skipped, 0 collisions. Kept as `src/scripts/verify_ddc_sync.ts`.
- **No API regressions.** Ran the new code locally against production and diffed 12 view/filter/feed
  permutations against the deployed API: 10 byte-identical. The 2 that differ are the intended flux
  fix (see below). Re-ran after the verifier's fixes — same result. 8 further `-8` filter
  permutations all return 200 with valid SQL. Backend + frontend `tsc` clean, `next build` clean.
**The flux bug, sized on real data:** under `feed=flux` the deployed Ads tab returns **$2,592.69** of
Codefuel revenue for 20–30 Aug while the Campaign tab returns **$0.00** (the MV's Outbrain branch
emits `revenue_flux = 0`). Campaign != Ads is broken in production today, before DDC. Fixed in
`ob_cf_rev` and `cf_key`; both now return $0.00, matching Campaign.
**CRITICAL bug the verifier caught in my build:** I put the DDC unattributed members inside the `-6`
row, which ends `AND ${obFiltered ? 'FALSE' : 'TRUE'}` — blanket-suppressed under ANY filter. That is
right for Codefuel/IA (both sides drop together) and **wrong for DDC**, whose MV branch deliberately
carries a real `ad_account_id`. Projected on 4 sampled days, `account_id=3971` would have shown
Campaign $902.62 vs Ads $120.42 — **Ads 86.7% low, on the one filter Nadia will use for this
account**, breaking her #1 invariant in the direction she notices. Fixed by lifting them into a new
top-level `-8` branch whose account gate reproduces migration 041's lateral exactly
(`ORDER BY id LIMIT 1`), so MV and Ads agree row for row rather than only in aggregate.
**Four further fixes by the verifier:** DDC ignored `feed=flux` in `ddc_raw`, the `-6` DDC members
and the Site tab (same class as the bug above, reintroduced for DDC); the pre-existing `-2`
Codefuel-orphan row also ignored the feed filter ($161.50 of history, demonstrated on 15–16 Apr:
campaign $0.00 vs ads $138.36 before, both $0.00 after); the country dropdown was not partner-scoped
(plan §5.6, zero impact today — all 11 DDC countries already appear); and `syncDDCRange` swallowed
per-day failures so a range where every day failed still recorded step `ddc` as **ok** — exactly the
silent-failure mode §9's per-step isolation exists to prevent. It now throws naming the failed days.
**Known gaps, documented not fixed:** (A) Taboola-side DDC (`tmpl=C245`) would break Campaign == Ads
on the Taboola side — zero rows today, must be handled before it goes live; (B) the Hourly tab is
only DDC-correct under `source=outbrain` (under All Sources the MV puts DDC at hour 0 with no
on-screen note — pre-existing behaviour for all daily-grain Outbrain data); (C) `ddc_orphan`'s
`JOIN LATERAL` is an inner join, so if no account is tagged `ddc` then 83% of DDC revenue vanishes
**silently** — 040-before-041-before-backfill is a hard precondition, verify it after applying;
(D) the `-3` third `NOT EXISTS` was deliberately NOT added (with no Taboola DDC branch it would
suppress Taboola spend rather than protect it); (E) `ddc_link_rev` is dead code today — no DDC hex
is a promoted-link uuid.
**Attribution finding for Nadia:** **82.8% of DDC revenue ($5,190.95 of $6,270.32, 91 of 101 type
tags) resolves to no Outbrain object at all.** IA-Outbrain resolves 100% via the identical mechanism
and this account has 235 healthy promoted links, so it is specific to how DDC's tags are configured.
The build handles it correctly — that revenue lands on `-8`/`ddc_orphan` with a real account id, so
account margin is right and Campaign == Ads holds — but per-campaign and per-ad attribution will be
missing for most DDC revenue until her tracking template is fixed. Analogous to the existing broken
IA-template asks. The verifier independently measured 86.7% on a 4-day sample and confirmed 100% of
the *resolved* portion maps to SBH_ssm_09.
**Verified:** see above — all read-only or against a throwaway view. Production is unchanged.
**Reports:** `scratchpad/ddc-build-verification.md` (240 lines).
**Commit:** not committed — awaiting the user's line-by-line review

### 2026-08-31 — Milestone 3 APPLIED to production: migrations 040/041 + DDC backfill
**What:** User authorised the production change. Applied `040_ddc_partner.sql` and `041_mv_ddc.sql`,
backfilled DDC from 2026-07-22, refreshed the MV, and reconciled. **Code is still uncommitted and
NOT deployed** — Render/Vercel are untouched, so the live API/worker still run the old code.
**Sequence:** pre-migration snapshot -> migrate (040 2s, 041 30s) -> verify precondition ->
`ddc-backfill 2026-07-22 2026-08-31` -> `refresh-view` -> reconcile.
**Verified, with numbers:**
- **Precondition C passed:** exactly one account tagged `ddc`, and it is row 3971 (SBH_ssm_09,
  platform 2). This matters because `ddc_orphan`'s `JOIN LATERAL` is an inner join — with no tagged
  account, 83% of DDC revenue would vanish from the MV silently.
- **041 changed nothing on its own:** MV aggregates identical to the pre-migration snapshot across
  180,146 rows (spent 175604.4000, revenue 281151.1495, revenue_flux 5054.7185).
- **Backfill exact:** 2,077 rows over 40 days (22 Jul – 30 Aug), **$6,270.3164 — matching DDC's own
  `report_type=date` total to the cent.** 0 NULL `item_ext_id`, 0 duplicate keys.
- **No regression:** codefuel 71,969 rows / $60,060.18 and image_advantage 208,023 rows /
  $221,176.4966 both **UNCHANGED**. MV revenue moved by exactly +$6,270.3164; MV **spend did not
  move at all**, confirming no cost fan-out.
- **The orphan path works:** $5,190.95 of unattributed DDC across 30 MV rows, **0 of them with a
  NULL `ad_account_id`** — the whole $6,270.32 resolves to SBH_ssm_09.
- **Campaign == Ads holds on all 11 scenarios** (source outbrain/taboola/all x account filter x
  feed all/yahoo/flux), revenue matching to the cent — including
  `source=outbrain&account_id=3971`, which without the `-8` fix would have read 86.7% low. Spend
  differs by $1.05–$1.71, the documented `outbrain_ad_daily` vs `outbrain_stats_daily` link-grain
  skew (plan §7).
- **Idempotent:** re-synced 28/29/30 Aug; row count and revenue both unchanged at 2,077 / $6,270.3164.
**SBH_ssm_09 now reads correctly:** cost $8,103.93, revenue $6,270.32, **profit −$1,833.61,
margin −29.2%** — instead of the pure $8.1k loss the dashboard showed before.
**Bug found by running it:** DDC bars the current day (`{"error":"No stats for this date"}`), like
IA. The backfill's D-4..**D-0** window would therefore have failed the `ddc` step **every single
night**, and a step that always fails is a step nobody reads when it fails for a real reason.
Changed the DDC step to D-4..D-1, matching IA's existing pattern. The failure was surfaced only
because of the `syncDDCRange` throw added during verification — it worked exactly as intended on its
first real run.
**Verified:** all numbers above are live production reads taken after the change.
**Commit:** not committed — awaiting the user's line-by-line review

### 2026-09-01 — Post-apply tab-by-tab audit; Country tab now carries DDC revenue
**What:** Audited every tab and column with DDC data actually present (the earlier Site-tab check ran
*before* the backfill, so it had returned $0.00 and proved nothing). Found and closed one real gap.
**Gap found — the Country tab.** DDC's `detail` report carries a Country column and the sync stores
it ($6,167.22 US, $102.64 CA, plus 13 smaller markets), but the Outbrain country view hard-coded
`0::numeric AS revenue`. SBH_ssm_09 therefore read as **$8,117.07 spend against $0.00 revenue** —
exactly the defect the Site tab had. Plan §5.6 offered two options: surface it or tell Nadia it is
stored but hidden. Surfaced it, mirroring the Site branch (CTE per side + FULL OUTER JOIN on
country), since the data was already there and she asked for DDC *in the dashboard*.
**Verified after the change:** Country tab totals $6,270.32 revenue / $8,117.07 spend, 15 rows;
the `country=US` filter still narrows to one row ($6,167.22); other Outbrain accounts unchanged
(account 239: 16 rows, $0.00 revenue, $31,287.89 spend); **Campaign == Ads still matches on all 11
scenarios**; `tsc` clean.
**Tab-by-tab result (source=outbrain, account 3971, 22 Jul – 30 Aug):**
| tab | rows | revenue | note |
|---|---|---|---|
| campaign | 33 | $6,270.32 | |
| daily | 40 | $6,270.32 | |
| ads | 228 | $6,270.32 | |
| site | 132 | $6,270.32 | publisher names + spend + revenue on one row |
| country | 15 | $6,270.32 | fixed this session |
| hourly | 24 | $0.00 | DDC excluded by design + on-screen note (daily-grain would pile into hour 0) |
| device | 0 | — | Outbrain exposes no device data; pre-existing, DashboardShell already explains it |
All 18 of Nadia's metrics are present in the API response on every populated tab.
**Frontend:** Project dropdown lists DDC and account 3971 carries `partner_code: 'ddc'`; the DDC
badge is wired in both `FilterBar` and `StatsTable`; `/api/sync-status` reports a `ddc` row. Every
tab renders `TABOOLA_COLS + PARTNER_COLS + its dimension column`, and DDC populates exactly the same
`partner_stats_hourly` fields as Codefuel/IA (`revenue`, `ad_clicks`, `sessions`), so there is no
DDC-specific column gap.
**Pre-existing, NOT changed:** `actual_cpm` is computed by the API for every view but is in neither
`TABOOLA_COLS`/`PARTNER_COLS` nor `EXPORT_COLUMNS`, so it renders nowhere. That predates this
milestone and is unrelated to DDC — flagged, not touched.
**Site tab, first real look at where the loss is:** glance.com **$5,382.93 spend -> $71.02 revenue**;
sportscentralnews $1,100.34 -> $175.24; Journey Peaks $193.38 -> $67.66. One publisher is
substantially the whole −$1,833.61.
**Commit:** not committed — awaiting the user's line-by-line review

### 2026-09-03 — Post-deploy verification of the live app; empty-row cleanup; worker NOT deployed
**What:** Full verification against the deployed API after the user went live. Confirmed the new API
build is running, audited every tab under 8 filter scenarios, found and fixed 5 classes of blank row,
and found that **the cron worker was never redeployed**.
**BLOCKER — `nadia-worker` is still running the old build.** `/api/sync-status` shows the `ddc`
source (so the API redeployed), but DDC's `last_fetched` is still 2026-08-31T17:10 — my manual
backfill. The 03:00 job ran on 09-01 and 09-02 and both recorded `ok`, yet **`sync_runs` contains no
`ddc` rows from either run**. If the worker had the new code, `syncDDC` writes its `sync_runs` row
*before* calling the API, so a missing-credentials failure would still leave an `error` row. Nothing
was written at all, so the DDC step does not exist in the running worker. Consequence: DDC data is
frozen at 2026-08-30 and will not advance until the worker is redeployed **with `DDC_REPORTING_URL`,
`DDC_USERNAME`, `DDC_PASSWORD` set on that service**. Not a code defect.
**Empty rows found and fixed (5 classes).** All-zero rows contribute nothing to any total, so
suppressing them cannot move a number — confirmed empirically on all 13 checked view/filter pairs.
| view | filter | empty before | after | cause |
|---|---|---|---|---|
| country | outbrain + acct 3971 | 7 | 0 | **introduced by the DDC country join** — DDC reports CH/AT/ES/NL/FR/FI/AU with $0 and no Outbrain cost |
| country | outbrain | 1 | 0 | same (FI) |
| site | outbrain + acct 3971 | 1 | 0 | **introduced by the DDC publisher join** |
| site | taboola / all | 15 | 0 | pre-existing `(site NNN)` rows from the cost⟕IA FULL OUTER JOIN |
| ads | taboola / all | 2 | 0 | pre-existing — ad whose (gd,r) earned nothing and whose campaign has no cost |
Fixed with a "has any activity" predicate on each of the four joins. Row counts moved
(623→608 site, 1101→1099 ads, 15→8 country) while **every revenue and spend total stayed identical**.
**Verified after the fix:** all 7 tabs × 8 scenarios (all/outbrain/taboola, DDC acct 3971, IA acct
239, feed yahoo/flux, DDC+flux) report **clean** — no null dimensions, no NaN/Inf, no all-zero rows,
no negative spend or revenue, and all 18 of Nadia's metrics present on every populated tab.
**Campaign == Ads still matches on all 11 scenarios.**
**Strongest correctness evidence:** the dashboard's Daily tab for account 3971 compared to DDC's own
`report_type=date` API, day by day: **40 days, 0 mismatches, $6,270.3164 vs $6,270.3164 exact.**
**Still true:** 31 Aug shows $250.69 of Outbrain spend and DDC reports no revenue for that day at
all (their own report omits it). Once the worker is redeployed the D-4..D-1 window will retry it.
**Commit:** not committed

### 2026-09-02 — DDC has reported NO data since 2026-08-30 while the account keeps spending
**What:** Post-redeploy check. Probed the DDC API directly for 31 Aug, 1 Sep and 2 Sep — all three
return `{"error":"No stats for this date"}`. 31 Aug is three days closed, so this is **not** the
reporting lag seen earlier; DDC has gone dark.
**Meanwhile SBH_ssm_09 is still buying traffic normally:**
| day | Outbrain spend | Outbrain clicks | DDC revenue |
|---|---|---|---|
| 08-28 | $489.62 | 4,055 | $299.17 |
| 08-29 | $475.53 | 4,881 | $277.93 |
| 08-30 | $256.42 | 2,206 | $147.78 |
| **08-31** | **$254.33** | **2,102** | **$0.00** |
| **09-01** | **$256.92** | **2,181** | **$0.00** |
**$511.25 spent across 4,283 clicks since 30 Aug with zero revenue recorded.** Clicks and spend are
steady at ~$255/day and ~2,100 clicks/day, and the preceding week monetised at 55–90% of spend, so
an absolute zero for three consecutive days is not a plausible performance result — it points to a
broken tracking template or a stalled DDC feed, not to genuinely worthless traffic. **Escalate to
Nadia.** This is the same class of problem as the existing broken IA templates, and it is live money.
**Consequence for the nightly job:** while this persists the 03:00 backfill's DDC step will fail
every night on D-1 and mark the step failed. That is the intended loud behaviour (the throw added
during verification), not a deploy fault — but expect it in `sync_runs` and don't read it as the
worker being broken.
**Worker redeploy status: not yet confirmable.** The worker is alive and healthy — hourly Taboola /
Codefuel / IA / Outbrain jobs all ran ok through 09-02 19:25 UTC. But DDC only runs inside the 03:00
UTC daily backfill, and the last one (09-02 03:00) predates the env-var change, so there is no DDC
evidence either way until 03:00 UTC. Nothing in `sync_runs` distinguishes a redeployed worker from
an old one outside that window.
**Commit:** not committed

### 2026-09-03 — DDC recovered; caught up to 1 Sep; type-tag attribution report for Nadia
**What:** Nadia confirmed her DDC console showed 31 Aug / 1 Sep and asked us to retry. Retried: the
API now serves those dates. Backfilled 30 Aug – 1 Sep and refreshed the MV.
**The outage was transient on DDC's side, not ours.** At 19:38 UTC on 09-02 every probe (including
30 Aug, which we had already stored) returned "No stats for this date". By 09:55 UTC on 09-03 both
single-day and range calls worked for every date and both report types. Nothing changed in our code
between those probes. Her console figures match ours to the cent: 30 Aug $147.78, **31 Aug $307.20,
1 Sep $233.76**.
**State now:** DDC = 2,277 rows, 42 days, 2026-07-22..2026-09-01, **$6,811.28** — equal to the API's
own range total. SBH_ssm_09 over that period: cost $8,925.47, revenue $6,811.28, **−$2,114.19 at
−31.0%**.
**Type-tag report (Nadia's request).** 101 distinct tags. **10 matched ($1,174.29, 17.2%); 91 NOT
matched ($5,636.99, 82.8%).** Raw CSV at
`~/Downloads/ddc-type-tag-attribution-2026-09-03.csv` — one row per tag with revenue, clicks,
bidded searches, days active, first/last day and the matched campaign where there is one.
**Root cause identified — it is a date boundary, not random.** Every matched tag belongs to the
original 22 July campaigns (`US-Mixed KW 21th July V1/V2/V3 - DDC`, `US-Tax Planning And Strategies
- DDC`). **Every unmatched tag first appears on 2026-08-05.** Daily split confirms it: 1–4 Aug is
100% matched with zero unmatched; 5 Aug is the first day unmatched revenue appears ($14.29 vs
$19.86 matched); by 6 Aug unmatched dominates ($82.12 vs $16.51). The newer tags are well-formed
34-character hex — they simply are not IDs that exist in the Outbrain account, so whatever sets the
`tt` changed on 5 August. This is a far more actionable finding than "83% is unattributed", and it
is what the message to Nadia leads with.
**No code changed this session.**
**Commit:** not committed

### 2026-09-03 — ROOT CAUSE: the DDC type tag lives in the ad's landing URL, not in an Outbrain ID
**What:** Nadia pushed back that she matches DDC to Outbrain in Excel from 22 July onward, so we
should be able to as well. She was right, and the earlier "82.8% unattributable" conclusion was
**wrong** — it came from resolving the tag against the wrong thing.
**The mistake.** 041 resolved DDC's `tt` against `outbrain_campaigns.campaign_id` /
`outbrain_ad_links.link_id`. Probing Outbrain's API directly with three unmatched tags returned
`{"message":"Invalid id ..."}` for both endpoints — they are not Outbrain object ids at all.
**The actual key** was in her original setup notes all along:
`startgonow.com/<path>/?amxt=blue&tmpl=C244&tt=<34-hex>&kw=<keywords>` — `tt` is a **URL parameter on
the promoted link**. Verified against the live Outbrain API: all 235 promoted links on SBH_ssm_09
carry a `tt=`, 196 distinct values, resolving **100% of DDC revenue**. The only 3 unmatched tags are
`{{ad` (unsubstituted macro), `abc123` (the vendor's doc example) and literal `null` — all $0.00.
**Nadia then confirmed the history independently:** she began with the `ad_id` macro (those DO match
a promoted-link id — the 10 we had), then hand-made ~100 unique 34-char tags when DDC capped her at
50/100 type tags. Those correspond to no Outbrain id by design. She intends to return to the `ad_id`
macro for new campaigns, so **all three tag shapes must resolve permanently** — `ddc_tt_link` unions
`tt_param`, `link_id` and `campaign_id` so old, current and future campaigns all work.
**Allocation, not a join.** 158 of 196 tags map to one promoted link, but 38 are reused across links
and campaigns — joining every match would multiply revenue (this project's recurring fan-out bug).
Each (tag, day) is split across candidate links by that link's real Outbrain clicks that day, equal
split when a day has no clicks, so shares sum to exactly 1 and revenue is conserved.
**Migrations/files:** `042_outbrain_link_tt.sql` (adds `outbrain_ad_links.tt_param` + partial index),
`043_mv_ddc_tt.sql` (full MV re-declaration with tt resolution + allocation), `sync/outbrain.ts`
(`parseTt`, persists the param), `api/server.ts` (Ads tab mirrors 043 exactly).
**Verified:**
- Test MV built under a throwaway name first: **total revenue and spend byte-identical to live**
  (revenue 295411.1939, spend 181871.4900) — the change only moves DDC revenue from the orphan
  bucket into campaigns.
- DDC attribution went from **$5,636.99 unattributed (82.8%) to $0.00**. All $6,811.28 now lands on
  named campaigns: 32 campaigns with activity, **135 ads with revenue**.
- **Campaign == Ads matches to the cent on all 7 scenarios** (outbrain / taboola / all x account
  filter x feed all/yahoo/flux).
- All 7 tabs x 5 filter scenarios audited **clean** — no empty rows, no NaN, no nulls.
**One gap found and closed during verification:** revenue allocated to a promoted link with no cost
in the window was dropped by the Ads tab while the MV kept it at campaign level — Ads sat **$0.48**
below Campaign on $6,811.28. Added a `-7` branch for uncosted links; now exact.
**Deploy needed:** migrations 042/043 are applied and the MV is refreshed, but `api/server.ts` and
`sync/outbrain.ts` are uncommitted — the live Ads/Site tabs still use the old resolution until the
API is redeployed.
**Commit:** not committed

### 2026-09-03 — tt-based attribution verified LIVE after deploy
**What:** User deployed. Verified the whole thing against the deployed API, not locally.
**Verified on https://nadia-api.onrender.com:**
- tt resolution is live: Ads tab returns 229 rows, **135 with revenue, 134 of them named ads**.
- All 7 tabs x 4 filter scenarios **clean** — no empty rows, no NaN, no nulls.
- **Campaign == Ads matches on all 9 scenarios** (outbrain/taboola/all x account 3971 / account 239 x
  feed all/yahoo/flux).
- **Ground truth: live dashboard vs DDC's own `report_type=date` API, day by day — 42 days, 0
  mismatches, $6,811.2761 both sides, exact.**
- DDC unattributed is **$0.00** (was $5,636.99 / 82.8% before migration 043).
**Milestone 3 is functionally complete.** Remaining open items are external, not code: DDC's own
reporting gap on 31 Aug (since recovered), the glance.com loss concentration, and confirmation that
the 03:00 worker picks DDC up on its own.
**Commit:** not committed

### 2026-09-03 — Independent verification (session 2): 5 claims confirmed, 1 refuted, 3 defects fixed
**What:** Dispatched a second independent verifier via Orca orchestration (run `run_1fcdf6ff2a85`,
task `task_ca00ee2fbdac`) to try to break every claim. Report:
`scratchpad/ddc-final-verification.md` (294 lines). It re-derived everything read-only against the
live DB, the deployed API and DDC's own endpoint.
**CONFIRMED independently:** $6,811.2761 ties to DDC's API to the cent on all 42 days; DDC
unattributed $0.00 across 32 campaigns / 135 ads; migration 043 conserved revenue and spend exactly
(MV spend 181,871.4900 equals the exact sum of both cost tables, so nothing fanned); 0 empty / NaN /
null / negative cells across **63 live tab-filter combinations**; allocation shares conserve revenue
exactly; the Ads `-8` branch matches the MV's `ddc_orphan` row for row; the deployed code is the
working tree; and the earlier "worker never redeployed" blocker is resolved.
**REFUTED — Campaign == Ads did NOT hold everywhere.** Two pre-existing defects, neither caused by
DDC but both now sitting under it:
- **D1 (HIGH) — the status filter.** `p.status` was pushed only into `mvWhereParts`, so
  `ads`/`site`/`country`/`device` ignored it entirely; and the subquery read `campaigns`, which holds
  only Taboola rows, so **no Outbrain campaign could ever match** — the Outbrain Campaign tab
  returned $0.00 while Ads returned the full $6,811.28. One click away in the UI.
  Also discovered: **Taboola uses `PAUSED`/`REJECTED` while Outbrain uses `enabled`/`disabled`**, and
  the dropdown only offered the Taboola vocabulary, so the filter was inert on every Outbrain account.
  Fixed: MV clause now checks both tables; the Outbrain Ads branch and all its safety nets take a
  status clause; the Taboola Ads branches (`cf_rep`, `-1`, `-3`) take one keyed on `campaigns.status`;
  `-2` orphans are dropped under a status filter (they have no campaign, and the MV drops them too);
  and `/api/filters/options` now offers both vocabularies. Verified: all 6 status combinations match,
  and `enabled` $3,948.50 + `disabled` $2,862.78 = $6,811.28 exactly.
- **D2 (HIGH) — `ob_cost_all` fanned out on ad-title changes.** It grouped by
  `promoted_link_id, promoted_link_uuid, ad_title, landing_url, gd_param, r_param, campaign_id`, so
  editing an ad's title mid-window split one link into two cost rows and the link-keyed revenue joins
  attached the **full** revenue to **both** — inventing revenue that exists nowhere in
  `partner_stats_hourly`. Measured by the verifier: 32 duplicated uuids and **$3,549.08 of phantom IA
  revenue in 2026-07-15..07-21 alone, $14,082.30 across the year**. Zero DDC impact today (no
  DDC-tagged link has changed title) but DDC sits on the identical join. Fixed by grouping on
  `promoted_link_uuid` alone and taking title/url/params via `MAX()`. Verified: that window now
  reconciles exactly (campaign $17,266.46 == ads $17,266.46, was $3,679.76 apart).
- **D3 (MEDIUM, client-facing) — a Site-tab label stated a date it did not filter on.** `ddc_nopub`
  has no date predicate but rendered as "(DDC - no publisher id before 2026-08-28)", while **$289.12
  across 195 rows arrives on or after that date** without a publisher. Relabelled
  "(DDC - publisher not reported)"; totals were already correct.
**OVERSTATED — claim 7.** The `ad_id`-macro arm is written but **untested in production**: all 10
tags that resolve via `link_id` are also `tt_param`s, so no live row exercises that path alone. It
will matter when Nadia switches new campaigns back to the macro.
**Verified after all three fixes:** Campaign == Ads on all 7 base scenarios plus all 6 status
combinations; all 7 tabs x filter scenarios still **clean**; `tsc` clean.
**Left as documented, not fixed:** D4–D7 (latent, zero rows today) and R1–R6 from the report — most
importantly R1, that only **33.9% ($2,309.86)** of DDC revenue is exact single-candidate attribution
while **62.0% is click-weighted and 4.1% an equal split**. Campaign and account totals are exact;
per-ad splits are modelled. **Nadia must be told this.**
**Commit:** not committed

### 2026-09-04 — Pre-send check: worker confirmed working; nightly false-failure fixed
**Worker redeploy CONFIRMED working.** The 03:00 job ran DDC at 09-04 03:22: three days synced ok
(80 / 101 / 99 rows) and one returned "no stats". DDC data now runs to **2026-09-02, $7,093.41**.
The earlier "worker never redeployed" blocker is fully closed.
**New defect found and fixed — the nightly job was failing every night.** `sync_runs` showed
`cron / daily-backfill` = **error, "steps failed: ddc"** on both 09-03 and 09-04. Cause: DDC's data
lags ~2 days, so the D-4..D-1 window always asks for at least one day they cannot answer, and
`syncDDC` threw on their "No stats for this date" reply. A job that is red every night is a job
nobody reads when it goes red for a real reason — the exact failure mode CLAUDE.md §9 exists to
prevent. Fixed in `sources/ddc/client.ts`: that specific message is now treated as an empty day and
logged; every other error still throws. Verified: 09-03 (no data) logs and returns empty, 09-02
still syncs 80 rows / $282.13, and the full D-4..D-1 range now exits 0.
**Full verification with all fixes (local, against live production data):**
- **Campaign == Ads: 16 of 16 scenarios match**, including both previously-broken cases —
  the D2 fan-out window (campaign $17,266.46 == ads $17,266.46, was $3,679.77 apart) and the D1
  status filter (0.00 == 0.00, was 0.00 vs 6,811.28). Matrix now covers multi-account, both status
  vocabularies, and all three feeds.
- **56 tab/filter combinations all CLEAN** — no empty rows, NaN, nulls or negatives.
- **Ground truth: 43 days, 0 mismatches, $7,093.4095 dashboard == $7,093.4095 DDC API.**
**NOT DEPLOYED.** D1, D2, D3 and this cron fix are all in the working tree only. Verified against
the live API: it still offers only Taboola statuses, still returns campaign $0.00 vs ads $6,811.28
under a status filter, and still shows $20,946.23 vs $17,266.46 on 15–21 Jul. **The user should
deploy before Nadia is told to look.**
**Commit:** not committed

### 2026-09-04 — All four fixes verified LIVE; milestone complete
**Verified on https://nadia-api.onrender.com after deploy:**
- **D1 status filter — DEPLOYED.** Options now offer both vocabularies
  `["disabled","enabled","PAUSED","REJECTED"]`; campaign and ads agree under every status.
- **D2 fan-out — DEPLOYED.** 15–21 Jul now campaign $17,266.46 == ads $17,266.46 (was $20,946.23 on
  the Ads side, $3,679.77 of phantom revenue).
- **D3 Site label — DEPLOYED**, now "(DDC - publisher not reported)".
- **Cron false-failure — DEPLOYED.**
- **Campaign == Ads: 17 of 17 scenarios match on live**, spanning source, multi-account, both status
  vocabularies and all three feeds.
- **56 tab/filter combinations CLEAN** — no empty rows, NaN, nulls or negatives.
- **Ground truth: 43 days, 0 mismatches, $7,093.4095 live dashboard == $7,093.4095 DDC API.**
**Final client-facing numbers (22 Jul – 2 Sep):** SBH_ssm_09 spend **$8,933.03**, revenue
**$7,093.41**, profit **−$1,839.62**, margin **−25.9%**, across **32 campaigns** and **135 ads**.
**Sync freshness:** codefuel and IA current to 2026-09-04; DDC to 2026-09-02 (their reporting runs
~2 days behind, and the nightly job now fills the gap as it publishes); Taboola still stopped at
2026-08-19, the pre-existing upstream issue unrelated to this milestone.
**Client message redrafted** with the live figures and, prominently, the attribution caveat: campaign
and account totals exact, per-ad exact for ~34% and traffic-weighted for the rest, with the `ad_id`
macro as the route to exact per-ad numbers now that DDC raised the tag cap.
**Milestone 3 is complete and verified end to end.** Everything remains uncommitted.
**Commit:** not committed

### 2026-09-04 — Sign-off verification: dashboard PASSED, client message had a WRONG number
**What:** Third independent session (task `task_a6da81f2deac`) as a final confirmation pass.
Report: `scratchpad/ddc-signoff.md`.
**Dashboard: PASSED.** 216 live Campaign-vs-Ads comparisons across source x account x feed x status
x 5 windows; D1 and D2 confirmed fixed and holding (status=PAUSED now 0.00 on both tabs;
2026-07-15..07-21 is $17,266.46 == $17,266.46 with **0 duplicate promoted_link_uuid in all five
windows tested**); DDC ties exactly at **$7,093.41 over 43 days, zero mismatching days**; spend
conserved exactly (MV 184,054.11 == 21,531.56 + 162,522.55); nothing regressed for Codefuel or IA.
204/216 matched to the cent and all 12 exceptions are pre-existing non-DDC cases.
**The client message was WRONG and would have caused a bad decision.** It claimed
"glance.com — $5,377 spent, $71 earned, two-thirds of spend for under 2% of revenue" and told Nadia
to cap it. Live figures for that window are **$5,817.57 / $536.49**, and more importantly **only
17.7% of DDC revenue carries a publisher id at all** — the publisher macro went live 28 August, so
the draft compared six weeks of spend against five days of revenue. Every publisher looked
catastrophic as an artifact of the window mismatch.
**Corrected with a like-for-like window (28 Aug – 2 Sep), and it inverts the conclusion:**
| Publisher | Spend | Revenue | Profit |
|---|---|---|---|
| sportscentralnews | $1,010.55 | $300.18 | **−$710.37** |
| glance.com | $618.76 | $536.49 | −$82.27 |
| Soccer News Reports | $123.55 | $136.29 | +$12.74 |
| Journey Peaks | $112.34 | $128.23 | +$15.89 |
**glance.com is close to break-even; sportscentralnews is the real loss.** Had the draft gone out,
Nadia would likely have blocked a near-break-even publisher and left the costly one running. Message
rewritten with the valid window and an explicit caveat that it is only six days of data.
**Also fixed:** the Daily view lacked the `HAVING` guard the Campaign view has, so a status filter
produced **13 all-zero rows**. Added; verified 42 rows/13 blank on live vs 29 rows/0 blank locally,
with revenue unchanged at $4,178.50 either way.
**Needs deploy:** the Daily `HAVING` fix is uncommitted and not live.
**Commit:** not committed

### 2026-09-04 — Final live verification; message cleared to send
**Daily HAVING fix deployed and confirmed:** status-filtered Daily now 29 rows / 0 blank (was 42 / 13),
revenue unchanged at $4,178.50.
**Every number in the client message re-derived against the deployed API:**
| claim | live | |
|---|---|---|
| DDC revenue $7,093.41 | $7,093.41 | OK |
| spend $8,933.03 | $8,933.03 | OK |
| profit −$1,839.62 | −$1,839.62 | OK |
| margin −25.9% | −25.9% | OK |
| 32 campaigns | 32 | OK |
| 135 ads | 135 | OK |
| 43 days | 43 | OK |
| sportscentralnews 1010.55/300.18/−710.37 | identical | OK |
| glance.com 618.76/536.49/−82.27 | identical | OK |
| Soccer News Reports 123.55/136.29/+12.74 | identical | OK |
| Journey Peaks 112.34/128.23/+15.89 | identical | OK |
**Attribution caveat wording verified:** 37 of 98 matched tags are used on more than one ad and carry
**65.1%** of revenue; 61 tags are single-ad and carry **34.9%**. The message's "about a third of the
TTs" and "exact for roughly a third" are both accurate.
**Final live sweep:** Campaign == Ads **17/17**; **56 tab/filter combinations clean**; ground truth
**43 days, 0 mismatches, $7,093.4095 == $7,093.4095**.
**Milestone 3 complete, deployed and verified end to end. Message cleared to send.**
Everything remains uncommitted on a repo with no remote — the one outstanding risk.
**Commit:** not committed

### 2026-09-05 — Four new Outbrain accounts (SBH_ssm_11..14_Codefuel) added for Codefuel
**What:** Nadia had Outbrain create four accounts and asked for them on the dashboard today, noting
the matching should be "the same as SSM1 to 4". It is — and almost all of it was already working.
**Nothing needed duplicating.** `syncOutbrainCampaigns` had already auto-registered all four as
`ad_accounts` rows (ids 16814–16817), and campaigns, promoted links, gd/r extraction, cost and the
MV all iterate every marketer, so they sync with **no code change**. The single manual step is the
partner tag, deliberately left NULL at registration so an account is never silently mis-assigned.
**Migration 044** tags all four as `codefuel`, explicitly by `external_id`. Deliberately NOT the
`CASE ... ELSE 1` catch-all migration 031 used — that pattern would have mis-tagged SBH_ssm_09 as
Codefuel when it is DDC (CLAUDE.md §10). Idempotent and scoped to `platform_id = 2`.
**Verified live after tagging:**
- All four appear in `/api/filters/options` with `partner_code: 'codefuel'`; Project = Codefuel now
  lists 12 accounts (was 8).
- **The Codefuel join already works on them.** `SBH_ssm_14_Codefuel` — the only one with traffic so
  far — returns **$59.02 spend / $37.22 revenue** across 5 campaigns via the live API, matched
  through the same `(gd, r)` landing-URL pair SSM 1–4 use. 243 `partner_stats_hourly` rows already
  match its pairs.
- ssm_11/12/13 had 0 gd/r pairs at first. **Not a bug:** their landing URLs do carry the params
  (`gd=AP1009377&r=7759120563` etc.) — those campaigns were simply created after the last
  promoted-links sync. Re-ran `syncOutbrainPromotedLinks` to map them ahead of Nadia launching; the
  nightly 03:00 job would have done it anyway.
**Note:** SBH_ssm_08 and SBH_ssm_10 remain untagged — Nadia has never said which partner they feed,
so they stay NULL rather than being guessed at. Worth asking when convenient.
**Commit:** not committed

### 2026-09-05 — VERIFICATION FOUND A REAL DEFECT: outbrain_ads is keyed globally on (gd, r)
**What:** Third-party verification of the new-accounts work (task `task_90e9ddd3a712`, report
`scratchpad/new-accounts-verification.md`) confirmed claims 1, 2, 3, 5, 6 but **refuted claim 4** and
found a HIGH pre-existing defect. I re-derived all of it independently.
**CONFIRMED by the verifier and by me:** all four accounts tagged `codefuel` with no other tag
touched; Project = Codefuel now 12 accounts and exactly additive (628.96+59.02 = 687.98 spend,
509.20+37.22 = 546.42 revenue); **SBH_ssm_14_Codefuel is correct** — $59.02 / $37.22 across 5
campaigns, all 20 of its (gd,r) pairs are genuinely its own; DDC still ties at $7,093.41; migration
044 is idempotent and correctly scoped; all seven tabs at parity with ssm_01/02, no NaN or nulls.
**THE DEFECT — `outbrain_ads` PRIMARY KEY is `(gd_param, r_param)` with no marketer.**
Confirmed: `outbrain_ads_pkey ON outbrain_ads (gd_param, r_param)`, and
`syncOutbrainPromotedLinks` upserts `ON CONFLICT (gd_param, r_param) DO UPDATE SET campaign_id`.
So when two marketers use the same landing pair, **the last sync run silently takes ownership** and
all of that pair's Codefuel revenue is attributed to one account.
Measured from `outbrain_ad_daily` (the authoritative per-link record):
**17 of 777 (gd,r) pairs are reachable from more than one marketer, carrying $2,566.15 of Codefuel
revenue across 3,881 rows — 7.4% of the $34,730.49 Codefuel-Outbrain total.** Collisions are
ssm_01/ssm_04 and ssm_01/ssm_02.
**My re-run of syncOutbrainPromotedLinks moved ownership.** It committed at ~14:58 UTC and handed
ssm_11/12/13 **28 pairs they have never spent a cent on** — 12 / 8 / 8 respectively — pulling
**$49.12** of ssm_01/ssm_02 revenue onto the new accounts. The correction I ran to help Nadia caused
a small production regression. It surfaces at the next MV refresh.
**Also refuted:** my claim that ssm_11/12/13 had 0 pairs because "the campaigns were created after
the last sync" was wrong — all 20 links per marketer were written in the same 03:15:29 run. The
pairs were missing because ssm_01/ssm_02 already owned them, which is the same defect.
**Also wrong in the code:** the comment in `sync/outbrain.ts` claims "r is the promoted-link id so
collisions are rare". It is not — `r_param` 7796123058 vs `promoted_link_id` 581740719.
**NOT FIXED — needs a decision.** Keying `outbrain_ads` on `(marketer_id, gd, r)` alone does not
solve it: Codefuel reports only `(gd, r)` and does not know the marketer, so a genuinely shared pair
is ambiguous **in the source data**. The correct fix is the DDC pattern — resolve the pair to all
candidate campaigns and allocate by click share — which changes historical numbers for ssm_01/02/04
and so is the user's call, not mine.
**Client-facing position:** SBH_ssm_14_Codefuel is correct and safe to show. ssm_11/12/13 are tagged
and visible but currently hold 28 pairs that are not theirs.
**Commit:** not committed

### 2026-09-05 — FIXED the (gd, r) pair-ownership defect (migration 045 + sync change)
**What:** Corrected the cross-account revenue leak found by verification, and closed the hole that
caused it. User approved the production write.
**Two parts:**
- **`045_fix_outbrain_ads_pair_ownership.sql`** — reassigns each `(gd, r)` pair to the campaign with
  the highest actual spend on it, but *only* where the current owner has no spend at all. Pairs
  nobody spends on are left alone rather than guessed at. Idempotent (driven purely by current
  spend) and ends with an MV refresh. First attempt used `UPDATE ... FROM LATERAL` referencing the
  update target, which Postgres rejects ("invalid reference to FROM-clause entry"); rewritten as a
  CTE.
- **`sync/outbrain.ts`** — the `(gd, r)` dedupe now preloads every `(gd, r, campaign)` that has real
  spend and prefers a spending campaign, never displacing one that already spends. Previously it
  kept first-seen, so ownership depended on campaign iteration order and a routine re-sync moved
  revenue between accounts. Also corrected the false comment claiming "r is the promoted-link id so
  collisions are rare" — `r_param` 7796123058 vs `promoted_link_id` 581740719.
**Verified after applying:**
| account | before | after |
|---|---|---|
| SBH_ssm_11_Codefuel | $24.30 rev / $0.00 spend | **$0.00 / $0.00** |
| SBH_ssm_12_Codefuel | $7.35 / $0.00 | **$0.00 / $0.00** |
| SBH_ssm_13_Codefuel | $17.47 / $0.00 | no rows (correct — no activity) |
| SBH_ssm_14_Codefuel | $37.22 / $59.02 | **unchanged** (was always correct) |
| SBH_ssm_01 | $12,337.34 | **$12,398.54** (+$61.20) |
| SBH_ssm_02 | $13,119.64 | **$13,107.56** (−$12.08) |
Net movement +$49.12 back to ssm_01/02 — exactly the amount that had leaked.
**Revenue conserved:** total Codefuel-Outbrain still **$34,730.49**, unchanged. Redistributed, not
invented. **0 pairs remain owned by a campaign with no spend on them** (was 38).
**Still open, deliberately:** 17 pairs carrying $2,566.15 (7.4%) are genuinely used by two accounts
at once. Codefuel reports only `(gd, r)` and does not know the marketer, so those are ambiguous in
the SOURCE data. "Whoever spends most" is the best available signal, not a complete answer; the
complete answer is click-share allocation as done for DDC in 043, which would change historical
figures for ssm_01/02/04 and is the user's decision.
**Deploy status:** migration 045 applied to production and MV refreshed, so the dashboard is already
correct. `sync/outbrain.ts` is uncommitted and NOT deployed — until it is, the nightly
promoted-links sync could re-break the ownership.
**Commit:** not committed

### 2026-09-05 — Post-deploy check; pair fix holding; one pre-existing gap confirmed
**Production state after migration 045, verified live:**
- ssm_11 / ssm_12 = **$0.00 revenue / $0.00 spend** (were showing revenue against zero cost);
  ssm_13 has no rows; ssm_14 unchanged at $37.22 / $59.02.
- ssm_01 **$12,398.54**, ssm_02 **$13,107.56** — the $49.12 stayed returned.
- **0 mis-owned pairs**; Codefuel-Outbrain total still **$34,730.49**.
- Campaign == Ads **17/17**, **56 tab/filter combos clean**, DDC ties **43 days, $7,093.4095 exact**.
**CONFIRMED the verifier's refutation of "Campaign == Ads holds everywhere".** It does not, for the
two accounts that share landing pairs, under an account filter:
| account | window | campaign | ads | delta |
|---|---|---|---|---|
| SBH_ssm_01 | Aug | $2,774.39 | $2,784.30 | **+$9.91** |
| SBH_ssm_02 | Aug | $6,136.25 | $6,126.34 | **−$9.91** |
| SBH_ssm_01 | 1–5 Sep | $297.88 | $287.73 | −$10.15 |
| SBH_ssm_02 | 1–5 Sep | $192.49 | $202.60 | +$10.11 |
The deltas are **offsetting pairs** — the same money assigned to the other account — which is why it
nets to zero at the all-accounts level and why my 17-scenario matrix (accounts 3971 and 239) missed
it. Pre-existing, identical to the cent against the pre-045 measurement, so not caused by 045.
Cause: `cf_rep_link` (`server.ts:897-907`) picks its representative link using the `outbrain_ads`
preference evaluated **only over in-window cost**, so a narrower window or an account filter can
select a different link than the MV. Same root cause as the 17 shared pairs. **FIXED later the same
day — see the `cf_rep_link` entry below.** (The 17 genuinely-shared pairs remain a separate, open
question; only the Campaign-vs-Ads divergence was fixed here.)
**Cannot yet confirm the worker deploy.** `sync/outbrain.ts` runs only inside the 03:00 UTC
`syncOutbrainPromotedLinks` step, so there is no way to observe which version the worker holds until
that job runs. If the old first-seen logic is still deployed it can undo 045 tonight. Check after
03:00: mis-owned pairs should stay 0 and ssm_11/12 should stay at $0.00 / $0.00.
**Commit:** not committed

### 2026-09-05 — FIXED Campaign != Ads for accounts sharing landing pairs (cf_rep_link)
**The bug.** The MV (`043` CTE `ob_cf_rev`) books Codefuel-Outbrain revenue to
`outbrain_ads.campaign_id` **unconditionally**. The Ads tab's `cf_rep_link` only *preferred* that
campaign in an `ORDER BY` and joined `ob_cost_all` on `(gd, r)` with **no campaign constraint**, so
whenever the mapped campaign had no costed link in the window it silently picked a link from a
different campaign — often a **different account**. Symptom: Campaign != Ads under an account filter
for the two accounts that share landing pairs, offsetting between them (+$9.91 / −$9.91 in Aug), so
it netted to zero across all accounts and only surfaced under a filter. Pre-existing; not caused by
the DDC work or by migration 045.
**The fix (`src/api/server.ts`), three parts, mirroring the MV exactly:**
1. `cf_rep_link` now joins `outbrain_ads` and requires `c.ob_camp_id = oa.campaign_id` — the
   representative link must belong to the mapped campaign, never another account's.
2. New `cf_camp_only` CTE + synthetic row **`-9`** surfacing Codefuel revenue whose mapped campaign
   has no costed link in the window. The MV keeps it on that campaign, so dropping it would have
   swapped one mismatch for another.
3. The `-6` unattributed branch's Codefuel member now tests `NOT EXISTS (outbrain_ads match)` rather
   than "no costed link in window", mirroring the MV's `ob_cf_orphan`. The old predicate described a
   different set, so mapped-but-uncosted revenue fell through both branches.
**Verified locally against live production data:**
- All four originally-failing cases now match **to the cent**: ssm_01 Aug $2,774.39 == $2,774.39,
  ssm_01 Sep $297.88, ssm_02 Aug $6,136.25, ssm_02 Sep $192.49.
- **Campaign == Ads 19/19** across source x six individual Outbrain accounts x multi-account x feed x
  status, plus three further windows (15–21 Jul $17,266.46, June $46,561.36, 15–16 Apr $0.00).
- **Revenue conserved:** all-accounts Outbrain Ads total **$146,407.22 — identical to the deployed
  API**. The fix only moves revenue to the correct account; it creates and destroys nothing.
- **56 tab/filter combos clean**; DDC still ties **43 days, $7,093.4095 exact**.
**Not deployed** — working tree only. `CLAUDE.md` §8 needs a `-9` row added when this is committed.
**Commit:** not committed

### 2026-09-05 — cf_rep_link fix deployed and verified live
**Deployed and confirmed on https://nadia-api.onrender.com:**
- The four previously-failing cases now **match to the cent**: ssm_01 Aug $2,774.39, ssm_01 Sep
  $297.88, ssm_02 Aug $6,136.25, ssm_02 Sep $192.49 (were ±$9.91 / ∓$10.1x).
- **Campaign == Ads 17/17**, **56 tab/filter combos clean**, DDC ties **43 days, $7,093.4095 exact**.
- Pair ownership held: **0 mis-owned pairs**; ssm_11/12 still $0.00/$0.00; ssm_14 $37.48/$59.02
  (revenue ticked up from $37.22 as Codefuel reported more against its pairs — expected).
**Still unobservable:** whether the worker carries the new `sync/outbrain.ts`. It only runs inside
the 03:00 UTC promoted-links step. After that job, mis-owned pairs must still read 0 and ssm_11/12
must still read $0.00 / $0.00 — that is the check.
**Commit:** not committed

### 2026-09-05 — DDC: 3-hourly schedule, flap-resistant sync, hourly endpoint proven
**Client correction accepted.** Nadia said DDC is NOT two days behind — her console publishes the
previous day around 11:30 her time. She was right and the earlier TRACK entry was wrong. The real
behaviour: **the API intermittently answers "No stats for this date" for a day that demonstrably has
data.** 2026-09-04 returned no stats on three consecutive single-day calls, then returned
$238.1261 on the next three, with nothing changed in between. A range call returned it throughout.
**Why that was dangerous.** The earlier fix treats "no stats" as an empty day (necessary, or the
nightly job fails forever on unpublished days). Combined with the flap, a transient blip would have
silently written **zero revenue for a real trading day** and nothing would have flagged it.
**Fixes:**
- `sources/ddc/client.ts` — `fetchDDCDetail` now retries an empty result up to 3 times with backoff.
- `sync/ddc.ts` — `syncDDCRange` calls the `date` report FIRST (one call, far more reliable) to
  learn which days actually have revenue; skips days it says are empty, and **fails loudly** when
  the date report shows revenue for a day but `detail` returns nothing. That converts a silent zero
  into a visible failure.
- `workers/cron.ts` — **new DDC job every 3 hours at :45**, window D-3..D-0, plus an MV refresh.
  Eight runs a day means one always lands shortly after DDC publishes, whatever timezone that is in,
  which sidesteps the 11:45 question entirely. Cheap to re-run because the date report gates it.
**Caught up manually:** 09-01 $233.76, 09-02 $282.13, 09-03 $210.01, **09-04 $238.13** — all four
match her console to the cent.
**Hourly endpoint TESTED and it works** (answering her direct question). Token from
`rdp.ddc.com/oauth2/access_token?code=...` (30 min), then `/api/v1/dw/yss_current_day`. Returns
tab-delimited **date, hour, domain, country code, device type, campaign (the tt), searches, clicks,
revenue, TQ, coverage, bidded_searches** — 945 rows covering 3 rolling days, all 24 hours.
Reconciles against the daily report: **09-03 $210.0174 vs $210.01, 09-04 $238.1154 vs $238.13**
(their own note says figures are pending/unaudited, hence the cents). It carries a **device
breakdown the daily report lacks**; TQ still reads 0.00. Not wired in — offered to the client.
**Needs a WORKER deploy** for the 3-hourly job; the sync/client changes ride with it.
**Commit:** not committed

### 2026-09-06 — DDC HOURLY feed integrated (+ device breakdown, hourly tab, hourly cron)
**3-hourly cron CONFIRMED working first:** clean `ddc` runs at 06:45 / 09:45 / 12:45 / 15:45 UTC.
Worker deploy verified.
**Client asked for the hourly report and for device (mobile now, desktop later), and whether today
is available. Today IS available** — checked at 16:17 UTC and the feed held 11 hours of 2026-09-06
($94.62), i.e. ~5 hours behind, matching the vendor's "4-6 hours" note.
**Built:**
- `sources/ddc/client.ts` — `fetchDDCHourly()`. Separate service from dailystats: token from
  `rdp.ddc.com/oauth2/access_token?code=...` (30 min, cached in-process), then
  `/api/v1/dw/yss_current_day`. TAB-DELIMITED, opens with a BLANK LINE before the header. Columns:
  date, hour, domain, country code, **device type**, campaign (the tt), searches, clicks, revenue,
  TQ, coverage, bidded_searches. Rolling ~3 days including today.
- `sync/ddc.ts` — `syncDDCHourly()`, writing `granularity='hourly'` with real hour, country and
  device. Device normalised to the dashboard's existing vocabulary ('Smart Phones' -> mobile,
  'Desktop' -> desktop). Accumulating map, same as the daily sync.
- `config/env.ts` + `.env` — `DDC_HOURLY_API_BASE`, `DDC_HOURLY_AUTH_CODE`.
- `workers/cron.ts` — hourly job at **:50 every hour**, plus the hourly pull added to the existing
  3-hourly DDC job. `run-once.ts` gains `ddc-hourly`.
**THE RISK THIS CREATED, and how it is handled.** DDC now has BOTH grains for the same days. The MV
already drops 'daily' for any (partner, date) with hourly rows, but the Ads / Site / Country tabs
query `partner_stats_hourly` DIRECTLY and would have counted those days **twice** — the single
biggest hazard in this change. Added `ddcGrainDedup(alias)` in `api/server.ts` mirroring the MV's
`ps` rule exactly, applied to all four DDC direct queries.
**Verified no double count:** 09-04 holds daily $238.13 AND hourly $238.12; the MV shows **$238.12
once**. Over 04-05 Sep every tab reports **$403.74** — campaign, daily, ads, site and country alike
— not the $807 a double count would give. Historical 22 Jul – 2 Sep unchanged at **$7,093.41**,
identical to the deployed API. Campaign == Ads **10/10** across source x account x feed x two windows.
**Two gaps found and fixed while testing:**
- The Hourly tab showed **$288.91 instead of $498.37**. `ob_rev_h` resolves an account from
  `campaign_ext_id` via campaign-hex / link-id / (gd,r) — none of which can resolve a DDC tag, since
  it lives in the promoted link's URL. Added the `tt_param` path to that lateral; now $498.37 across
  **24/24 hours**, a real curve rather than an hour-0 lump.
- The Device tab was **empty** under Outbrain (the view is Taboola-only and Outbrain exposes no
  device cost). Added an Outbrain device branch fed by DDC's hourly rows: **$498.37, all mobile**,
  which matches the client saying traffic is mobile-only today. Desktop appears automatically.
  Spend stays 0 rather than being invented; the on-screen note says so.
- `DashboardShell.tsx` notes rewritten — the old ones said DDC was excluded from Hourly and that no
  device data exists, both now false.
**Not deployed.** Needs both an API and a worker deploy.
**Commit:** not committed

### 2026-09-06 — Independent verification of the DDC hourly feed: 3 defects found and fixed
**What:** Adversarial re-verification of the DDC hourly integration against the live DB, the
deployed API and DDC's own two feeds. Every claim in the entry above reproduced. Three defects
fixed, none of them a double count.
- **`ddcGrainDedup` was missing from the `-8` (Unattributed DDC) row's second arm** in
  `api/server.ts`. That arm reads `partner_stats_hourly` directly while the MV's `ddc_orphan` reads
  `ddc_rows` (built on the deduped `ps` CTE), so the two disagreed by construction. Matches 0 rows
  today — the sync always writes an `ob:`/`tb:` prefix — but it is exactly the hazard the hourly
  feed introduced.
- **`ddcGrainDedup` made Country / Site / Ads take ~90s and time out.** `hour_utc::date` is not
  indexable, so the correlated `NOT EXISTS` re-scanned all 236,292 `granularity='hourly'` rows per
  candidate row. Idle-DB measurement: the Country CTE over 22 Jul–6 Sep went **300ms → 97,389ms**;
  the real endpoint took **81,380ms** for 22 Jul–2 Sep against a 2-minute `statement_timeout`, and
  under concurrent load it *did* cancel (57014) and return an empty Country tab. Fixed by bounding
  the inner scan with the same `$1`/`$2` window the outer query already uses — safe because
  `from`/`to` are dates, so a date inside the window has all its hours inside it too. All five call
  sites are in branches whose args start `[p.from, p.to]`; that requirement is now stated in the
  code comment.
- **`syncDDC()`'s docblock still claimed DDC "writes no 'hourly' rows at all, so the MV's
  hourly-wins de-dup can never shadow these"** — the exact invariant this change broke, and the one
  a future session is most likely to act on. Rewritten to name both de-dup sites and the
  incomplete-hourly failure mode.
**Why:** the Ads/Site/Country tabs read `partner_stats_hourly` directly, so `ddcGrainDedup` is the
only thing standing between them and a doubled 09-04/05/06. It had to be checked everywhere, not
just where it was known to be applied.
**Files:** `backend/src/api/server.ts`, `backend/src/sync/ddc.ts`. No migrations, no DB writes.
**Verified:** No double count anywhere. 09-04..09-05 = **$403.74** on campaign, daily, ads, site and
country alike (not $807). The boundary-spanning window 09-01..09-06 = **$1,224.27** on all five, and
equals the sum of its days with each counted once — 09-01/02/03 from the daily feed, 09-04/05/06
from the hourly one. Historical 22 Jul–2 Sep still **$7,093.41** on all five views, identical to the
deployed API including row counts. **Campaign == Ads 96/96** across 4 windows × source × account ×
feed × status, re-run after the fixes. Hourly tab $498.37 over 24/24 hours; Device tab $498.37, all
mobile, spend 0. Stored hourly rows reconcile to DDC's live feed exactly — 1,117 rows,
`valueDiffs: 0`, feedSum == dbSum == **$498.3656** — and to its `report_type=date` totals within a
cent a day. After the perf fix: country 81,380ms → **321ms**, ads ~10s → **3,215ms**. `tsc` clean.
**Deploy condition:** the **worker** must go out too, not just the API. 2026-09-06 currently holds
only 11 frozen hourly hours ($94.62) from a single manual run, and its daily row lands ~09-08 and
will be shadowed by them — a permanent ~$100 under-report for that day unless `syncDDCHourly` is
running before then.
**Report:** `…/d939c585-3123-4ec4-ac0a-10c95e84f45b/scratchpad/ddc-hourly-verification.md`
**Commit:** not committed

### 2026-09-06 — Hourly integration cross-checked; one missed guard found and fixed
**Cross-check session was unreliable** — it hung ~30 min in an `until grep` loop polling a file in a
DIFFERENT session's task directory, and after being interrupted never filed a report. It DID make
one real code fix before that (below). The verification numbers here are my own, re-derived directly.
**The gap it caught, which I had missed.** `ddcGrainDedup` was applied to four DDC reads (ddc_raw,
ddc_pub_rev, ddc_nopub, ddc_country_rev) but NOT to the **second arm of the `-8` branch** — the one
picking up DDC rows with no parseable `ob:` tag. That arm selects revenue without an inline `SUM`,
which is why it slipped past both my edit and my first grep. Now guarded: **5 call sites**.
It matches no rows today (DDC always writes an `ob:`/`tb:` prefix) but it is exactly the hazard the
hourly feed introduced, so leaving it would have been a latent double count.
**Also confirmed as false positives:** three other `code = 'ddc'` hits need no guard — the
`/api/sync-status` freshness query (MAX only), the filter-options country exclusion, and
`DDC_ORPHAN_ACCT` (an account-id lookup). None sum revenue.
**Full re-verification after the fix (tsc clean, 5 guard sites):**
- **Overlap days 04–05 Sep: $403.74 on campaign, daily, ads, site AND country** — one count each,
  not the ~$807 a double count would give.
- **Spanning the grain boundary:** 01–06 Sep = $1,224.27 == the sum of its six individual days.
- **Historical 22 Jul – 2 Sep = $7,093.41**, identical to the deployed API.
- **Hourly tab = $498.37 across 24/24 hours**; **Device tab = $498.37, all mobile, spend $0.00**.
- **Campaign == Ads 16/16** across source x account x feed x status x two windows.
- **56 tab/filter combos clean** — no empty rows, NaN, nulls or negatives.
**Needs an API + worker deploy.**
**Commit:** not committed

### 2026-09-06 — Cross-check report landed: 3 defects fixed, incl. a PERFORMANCE regression I caused
The verification session eventually reported (`scratchpad/ddc-hourly-verification.md`). It found
**three** real defects, two of which I had missed entirely.
**1. Missing guard on the `-8` arm** — already recorded above; it matches no rows today but is the
exact doubling hazard the hourly feed introduced.
**2. PERFORMANCE REGRESSION — my `ddcGrainDedup` made Country / Site / Ads time out.** `hour_utc::date`
is not indexable, so the correlated `NOT EXISTS` re-scanned all **236,292** hourly rows for every
candidate row. Measured on an idle DB: the Country CTE went **300ms -> 97,389ms**, and the real
endpoint took **81,380ms against a 2-minute statement_timeout** — under load it DID cancel and
returned an **empty Country tab**. I never saw it because my checks ran on an idle database and I
measured correctness, not latency.
Fixed by bounding the inner scan with the same `$1`/`$2` window the outer query already uses. That
is logically equivalent (the outer row is by definition inside the window, so any same-date hourly
row is too) and lets it use the `hour_utc` index. **81,380ms -> 321ms, byte-identical output.**
Re-measured end to end after the fix: country **4.5s** (was 81s+), site 0.8s, ads 2.6s, campaign
0.4s, daily 0.2s, device 0.3s, hourly 7.8s — all HTTP 200.
**3. Stale docblock** in `syncDDC()` still asserted DDC "writes no hourly rows at all, so the de-dup
can never shadow these" — precisely the invariant this change broke. Corrected.
**Its verification, independent of mine:** no double count anywhere (09-04..05 = $403.74 on all five
views, not $807; boundary-spanning 09-01..06 = $1,224.27 = sum of days); historical 22 Jul – 2 Sep
still $7,093.41 on all five views **including row counts**, identical to the deployed API;
**Campaign == Ads 96/96** across 4 windows x source x account x feed x status; Hourly $498.37 over
24/24; Device $498.37 all mobile, spend 0; stored hourly rows reconcile to DDC's live feed exactly
(**0 value diffs, feedSum == dbSum == $498.3656**).
**DEPLOY CONDITION — ship the WORKER as well as the API, within ~2 days.** 2026-09-06 currently holds
only **11 frozen hourly hours ($94.62)** from a single manual run. Its daily row lands around 09-08
and will be **shadowed** by those partial hours under the hourly-wins rule, permanently
under-reporting that day by roughly $100 unless `syncDDCHourly` is running on the worker by then.
This is a genuinely new failure mode created by mixing grains, and it is time-boxed.
**Commit:** not committed

### 2026-09-07 — DDC hourly LIVE and self-sustaining
**Root cause of the 14 failed runs: my omission.** I added `DDC_HOURLY_API_BASE` /
`DDC_HOURLY_AUTH_CODE` to `.env` and `.env.example` but **not to `render.yaml`**, and told the user
to deploy without mentioning there were new credentials. Every `:50` run failed with
`DDC_HOURLY_AUTH_CODE not set` from 09-06 18:50 to 09-07 03:50. Now declared on the worker in
`render.yaml`; user set them in Render.
**What that episode proved about the design, though:** the worker deploy itself was fine all along —
the cron fired on schedule every single hour without a miss — and the failure was **loud and
isolated**. `sync_runs` carried the exact message on all 14 runs, and the DAILY sync kept running
`ok` throughout because of the per-step `attempt()` isolation. Exactly the behaviour the
throw-on-real-error handling was built for: no silent zeros, no collateral damage.
**Confirmed working 09-07 04:50:** status `ok`, 883 rows.
**The shadowing risk is closed.** 2026-09-06 went from **13 frozen hours / $96.34** (my manual
top-up) to the **full 24 hours / $168.26**, automatically, on the first successful run. Its daily row
can now land whenever it likes — the hourly figure it shadows is complete.
**Live dashboard vs DDC's own date report, 1–5 Sep:** $233.76 / $282.13 / $210.01 / $238.12 /
$165.63 against DDC's $233.76 / $282.13 / $210.01 / $238.13 / $165.63 — matching, with a single cent
on 09-04 from their pending/unaudited settling. 09-06 ($168.26) is not yet in their date report;
it comes from the hourly feed, which is the point of having it.
**Milestone state: DDC is complete** — daily + hourly, device breakdown, 3-hourly and hourly crons,
all self-sustaining with no manual intervention.
**Commit:** not committed

### 2026-09-08 — FIXED client-reported DDC misattribution: revenue on zero-traffic campaigns (migration 046)
**The complaint, verified exactly.** On 2026-09-07 (account 3971) four campaigns showed revenue with
zero clicks and zero spend, totalling **$40.79 of the day's $276.22** — including the two in her
screenshot: 'US-Mixed KW 21th July V1 - DDC' ($20.80, 0 impressions) and 'US-Mixed KW 5th Aug. V2 -
DDC' ($12.24, 17 impressions, 0 clicks). 11 of the day's 76 earning tags carried $142.65 through the
equal-split fallback. All-time, **$2,073.91 of $8,252.15 (25%)** of DDC revenue had gone through it.
**ROOT CAUSE — two defects compounding, and the equal split was only the second one:**
1. **The tt match was exact, but tt_param is stored RAW.** Since ~2026-08-28 the promoted-link URL
   template appends a literal `_{{publisher_id}}` macro, so `outbrain_ad_links.tt_param` holds
   `<34-hex>_{{publisher_id}}`. Outbrain substitutes the macro at serve time, DDC reports
   `<tag>_<publisher hex>`, and `parseTypeTag` stores only the base tag. Exact equality therefore
   failed for **every post-macro link (191 of 327 tt-carrying links)** — the ads actually taking the
   traffic were invisible to the resolver. The base tag still matched the OLD pre-macro links that
   share it, so nothing orphaned; revenue silently flowed to dead links. Proven on tag `00bb6477…`:
   its active link took **802 clicks on 09-01** while the resolver saw only two dead candidates.
2. **The equal-split fallback then invented attribution.** With the real link invisible, no candidate
   had same-day clicks and `ELSE 1.0/COUNT(*)` split the revenue equally across every candidate
   campaign — including ones that never ran a cent of traffic. On 09-01/09-02, **100% of the day's
   revenue** was equal-split ($233.76 / $282.13) despite ~2,100 real clicks/day.
**THE FIX (migration `046_mv_ddc_tt_normalize_window.sql` + `src/api/server.ts`), three parts:**
1. `ddc_tt_link` matches on **`split_part(tt_param, '_', 1)`** — parseTypeTag splits at the first
   underscore, so the DDC-side tag can never contain one; split-at-first-underscore is exact both
   ways. With this alone, same-day clicks cover **98.7%** of revenue (was 73%).
2. Candidates are weighted by clicks over a **trailing 7-day window** (revenue day D-6..D) instead of
   strictly same-day — DDC revenue comes from searches AFTER the click, so revenue on D often belongs
   to a click on D-1 or earlier, and the window also rides out unsynced cost days. Measured: the
   7-day window covers **100.0%** of revenue; the same-day residue was $108.06 at gap 1 day, $0.55 at
   gap 2, $0.00 beyond. Campaign-id-macro candidates weigh by campaign clicks over the same window.
3. **The equal-split fallback is GONE.** A (tag, day) with zero candidate traffic in the whole window
   routes to `ddc_orphan` / the `-8` row — which is now the **exact complement of `ddc_alloc` by
   construction**, so conservation is structural, not incidental. Today that bucket holds **$0.00**.
Also fixed in passing: the Hourly tab's account-resolution lateral used the same exact `tt_param`
match — a tag whose ONLY link is post-macro would silently vanish under an account filter there.
And `parseTt`'s docblock in `sync/outbrain.ts` now states the stored-raw / match-normalized contract
so exact matching does not creep back.
**Verified (all read-only; migration NOT applied — the new MV was run as a subquery):**
- **Revenue conserved exactly:** new-MV total revenue/spend/flux byte-identical to the live MV
  ($310,448.2836 / $193,468.9000 / $5,054.7185); account-3971 per-day revenue: **0 diffs at 4dp on
  every day**. Non-3971 slice (Codefuel + IA) **byte-identical** ($302,196.1383, 180,920 rows).
  (`ad_clicks`/`sessions` shift by 25 of 613k — the pre-existing per-campaign ROUND(SUM(x*share))
  artifact under a changed distribution; revenue is exact.)
- **Ground truth: 43 days vs DDC's own `report_type=date` API — 0 mismatches, $7,093.4095 both.**
- **The flagged campaigns:** July V1 $20.80 → **$0.00**, 5th Aug V2 $12.24 → **$0.00**; the $40.79
  moved to the campaigns that actually took the traffic (Machinery $20.80→$41.60, Insurance Quotes
  $12.24→$24.47, Business Cloud $7.69→$15.38). Day total conserved at $276.22. Under the new logic
  **zero campaigns receive revenue with no traffic in the window**.
- **Campaign == Ads:** account 3971, 22 Jul–7 Sep, feeds all/yahoo/flux: **$8,151.65 == $8,151.65**
  to the cent (flux $0.00 both); all-sources $162,861.16 == $162,861.16. **Per-campaign lockstep**
  new-MV-sim vs new Ads tab: 57 campaigns, **0 mismatches**; status=enabled $5,402.03, disabled
  $2,749.62, campaign-filter $941.77 — all equal on both sides.
- **No double count:** 09-04..05 = **$403.74** on campaign, daily, ads, site AND country.
- **No perf regression** (local API, 22 Jul–7 Sep, source=outbrain): campaign 1.2s, daily 0.2s,
  hourly 1.4s, ads 4.5s, site 2.0s, country 0.3s, device 0.3s; all-sources ads 3.2s. Deployed
  (buggy) baseline on the same windows: 0.6–4.6s — same band.
- **Clean:** 0 NaN/null/negative/all-zero rows across 11 view×filter scenarios; non-DDC scenarios
  (acct 239 ads, Taboola campaign/ads, all-sources hourly) **byte-identical to the deployed API**.
- `tsc` clean.
**DEPLOY (user):** apply migration **046** (it re-declares and refreshes the MV, ~30s) and deploy the
**API** together — until both are live, a campaign/status-filtered Campaign-vs-Ads comparison can
disagree (unfiltered and account-level totals agree either way, since totals are conserved). No
worker deploy needed (`sync/outbrain.ts` change is comment-only).
**Client-facing note:** per-campaign DDC history will visibly shift — the ~25% that was smeared onto
stale candidates now follows real traffic. Totals per day/account do not move at all.
**Commit:** not committed — awaiting the user's review, consistent with the uncommitted milestone tree.

### 2026-09-08 — CLIENT-REPORTED: revenue on zero-traffic campaigns. Root cause was deeper than thought
**Nadia:** "there is revenue to campaigns that didn't received any traffic … or I will just keep
loosing money instead of making profit." Screenshot showed 09-07 DDC with US-Mixed KW 21th July V1
at $20.80 revenue / 0 impressions / 0 clicks / $0 spend, and 5th Aug V2 at $12.24. She is right.
**My initial diagnosis was only the trigger.** I identified the equal-split fallback in `ddc_alloc`
(`ELSE 1.0 / COUNT(*) OVER w`), which spreads a tag's revenue evenly across every candidate campaign
when none had clicks that day. Real, but a symptom.
**The actual primary defect, found by the fable agent and verified by me:** `outbrain_ad_links.tt_param`
stores the RAW `?tt=` URL value, and since ~2026-08-28 the template appends a literal
`_{{publisher_id}}` macro. Outbrain substitutes it at serve time and DDC reports `<tag>_<pubhex>`,
which `parseTypeTag` reduces to the base tag — but `ddc_tt_link` joined on **exact equality**.
**Independently confirmed: 191 of 327 tt-carrying links (58%) hold the literal macro** and so could
never claim their own revenue. Nothing orphaned, because the base tag still matched OLDER pre-macro
links sharing it — so revenue silently flowed to dead links and then got equal-split onto idle
campaigns. All-time **$2,073.91 of $8,252.15 (25%)** went through that fallback, not the ~4% believed.
**Fix — `db/046_mv_ddc_tt_normalize_window.sql` (NOT applied) + `api/server.ts` mirroring it:**
- `ddc_tt_link` matches on `split_part(tt_param,'_',1)`, exact on both sides (a DDC-side tag can
  never contain `_`).
- Weight by clicks over a **trailing 7-day window** rather than same-day. Measured: same-day covers
  98.7% after normalisation, 7-day covers 100.0%; $108.61 of revenue needs a >0-day lag, all within
  2 days, so 7 is conservative. This is the right shape because DDC revenue comes from SEARCHES,
  which lag the click.
- **Equal-split removed.** An untrafficked (tag, day) now routes to `ddc_orphan`, which is the exact
  complement of `ddc_alloc` by construction, so conservation is structural rather than incidental.
  That bucket holds $0.00 today.
- The Hourly-tab account lateral also gets `split_part` — same defect class, would have made a
  post-macro-only tag vanish under an account filter.
**Verified by me independently:** 046 builds in 18.2s; **totals byte-identical to live**
($310,450.2436 revenue, $193,468.90 spend) — distribution changes, totals do not. Both flagged
campaigns go to $0.00/no row. The $40.79 moves to the campaigns that actually took the traffic
(Machinery $20.80->$41.60, Insurance Quotes $12.24->$24.47, Business Cloud $7.69->$15.38).
**One campaign still shows revenue with no SAME-DAY traffic and it is correct:** Pest Control holds
$0.06 on 09-07 having taken 10 clicks / $1.40 on 09-06 — precisely the click-to-search lag the
trailing window exists for.
**Agent also verified:** ground truth 43 days vs DDC's own API, 0 mismatches, $7,093.4095 both sides;
Codefuel/IA slice byte-identical (180,920 rows); Campaign == Ads per-campaign lockstep across 57
campaigns, 0 mismatches; 09-04..05 still $403.74 (no double count); latency unchanged (campaign 1.2s,
ads 4.5s, site 2.0s, country 0.3s).
**TO APPLY: migration 046 AND the API deploy TOGETHER** — until both are live, campaign/status-filtered
Campaign-vs-Ads can disagree. No worker deploy needed.
**Tell Nadia:** per-campaign DDC history will visibly shift, ~25% of revenue re-following real
traffic. Account and daily totals do not move at all.
**Commit:** not committed

### 2026-09-09 — Independent pre-deploy verification of migration 046 + API: PASSED, deploy YES
**What:** Adversarial re-verification of the DDC tt-normalisation / trailing-window fix, read-only
against the live DB (a temporary MV `jsh046_v` built from 046's SELECT body, dropped afterwards),
the local working-tree API on :4321, the deployed API and DDC's own `report_type=date` API.
**Confirmed:** totals byte-identical to live ($311,418.7887 / $193,468.90 at test time; re-derived
twice); Codefuel + IA slice identical row-for-row (`EXCEPT ALL` both ways = 0, 180,932 rows);
flagged campaigns 'US-Mixed KW 21th July V1' $20.80 and '5th Aug. V2' $12.24 -> $0, money lands on
Machinery/Insurance Quotes/Business Cloud which took the clicks; sweep of all 631 revenue-bearing
campaign-days: **0** without clicks in the trailing window (38 have zero same-day clicks, all lags
1-5 days); ddc_orphan proven the exact complement of ddc_alloc (residual 0, shares sum to exactly 1
on all 1,553 tag-days, 30 junk tag-days = $0); constructed 9-day-gap case -> 100% orphaned, 6-day
case -> 100% to the clicked campaign; Campaign == Ads to the cent in 211/211 unfiltered/feed/account
combos vs the live MV and 90/90 status/feed combos vs the fresh 046 MV, per-campaign lockstep 0
mismatches (58/31/37 campaigns over three windows); grain overlap $403.74 on all five views; DDC
ground truth exact on 44 days (hourly-fed 09-04..07 differ from the audited date report by 1-2c,
identically in live and 046); no NaN/null/negative/empty rows in 215 responses; latency unchanged
(campaign 0.4s, ads 1.0s, site 0.65s, country 0.3s, device 0.26s; account-filtered full-window
Hourly is 10-14s but is 9.7s on the deployed build too - pre-existing, not from split_part).
**Edge cases:** tt_param has exactly two shapes (136 bare 34-hex, 191 `34hex_{{publisher_id}}`);
every TypeTag DDC ever returned is 34hex or 34hex_34hexpub except 16 junk values all at $0; no
stored DDC tag contains `_`; 122 base tags equal a link_id (102 their own) and none equals a
campaign_id; 37 base tags span two campaigns, in all of them the bare link died by 08-30 and the
macro link is the live one, so ownership moves the right way.
**Observations (non-blocking):** (A) DDC rows carrying a publisher suffix can only come from a
macro link but the allocator ignores the suffix; where an old bare link still had window clicks it
took a share it cannot have earned — $12.98 all-time (0.16%), one tag, 08-28..09-03. A
suffix-aware candidate filter would remove it. (B) Pre-existing since 043: MV ddc_orphan routes
Taboola/NULL-platform DDC rows into the DDC account row while the API's -8 arm is Outbrain-only
(today 2 rows, $0). (C) Cent-level spend gaps Campaign vs Ads (6c on acct 3971) exist identically
on the deployed API — Outbrain campaign-level vs ad-level spend tables.
**Deploy note:** migrations run in one transaction on the API build, so 046 auto-applies with the
API deploy and the live MV is never absent. The milestone tree is still uncommitted and 040-046
are untracked — the deploy path must carry them.
**No code changes** (no defect demonstrated). `tsc` clean.
**Report:** `…/d939c585-3123-4ec4-ac0a-10c95e84f45b/scratchpad/ddc-046-verification.md`
**Commit:** not committed

### 2026-09-09 — Migration 046 independently verified with edge cases: PASSED, cleared to deploy
Adversarial pre-deploy verification (task `task_4a95ef64c9e7`, report
`scratchpad/ddc-046-verification.md`, 184 lines). **No code changes were needed** — the fix stood.
**Core checks, all confirmed:** totals byte-identical and the Codefuel/IA slice identical
(`EXCEPT ALL` = 0 rows); both flagged campaigns go to $0 with the money landing on the campaigns
that took the clicks; **0 of 631 revenue-bearing campaign-days lack traffic in the window**;
**Campaign == Ads to the cent in 211/211 live combinations and 90/90 status combinations**, with
per-campaign lockstep; $403.74 on all five views across the daily/hourly grain overlap (no double
count); DDC ground truth exact on 44 days; no bad rows; latency unchanged — the one slow path
(account-filtered full-window Hourly, ~10s) is identical on the deployed build, so not a regression.
**Edge cases specifically covered:** multi-underscore / leading-underscore / malformed `tt_param`
against the real distinct values; the claim "a DDC-side tag can never contain `_`" verified across
every tag DDC has ever returned, not just recent ones; whether normalisation can wrongly collide two
links onto one base tag; trailing-window boundaries (range starting on the first day of data, single
-day queries, ranges with no DDC data, a range spanning the 2026-08-28 macro changeover); and a
**constructed 9-day-gap case, which orphans 100% as designed** rather than landing on a random
campaign. `ddc_orphan` proven to be the exact complement of `ddc_alloc`, and it still carries a real
`ad_account_id` so it survives an account filter.
**Non-blocking observations recorded, not fixed:**
- **A.** A publisher-suffix-aware allocation could refine $12.98 all-time (0.16%).
- **B.** Pre-existing and unchanged by 046: the MV's `ddc_orphan` routes DDC rows with
  `source_platform = 'Taboola'`/NULL into the DDC account row while the API's `-8` arm requires
  `'Outbrain'` and lives only in the Outbrain Ads builder. Today those are 2 rows at $0.00
  (`tb:abc123`), so no numeric effect — but if DDC ever bills real revenue on `tb.startgonow.com`,
  Campaign != Ads under `source=taboola`. Present in 043 too.
- **C.** `migrate.ts` wraps each file in ONE transaction, so 046's DROP/CREATE/REFRESH commits
  atomically and the live MV is never absent mid-deploy. 046 is the only unapplied file.
**State confirmed clean:** temp view dropped, no stray matviews, `_migrations` still tops out at 045.
**CLEARED TO DEPLOY: migration 046 + the API together** (046 auto-applies on the API build). No
worker deploy needed. The deploy path must carry `db/046_*.sql`, `src/api/server.ts` and
`src/sync/outbrain.ts` — 040–046 are all still untracked.
**Commit:** not committed

### 2026-09-09 — Migration 046 + API DEPLOYED and verified live; client's bug is fixed
**046 applied** (`_migrations` tops out at `046_mv_ddc_tt_normalize_window.sql`) and the API is live.
**The client's exact view — 2026-09-07, DDC, SBH_ssm_09 — is now correct:**
- `US-Mixed KW 21th July V1 - DDC` $20.80 -> **gone** (no row; it earned nothing because it ran nothing).
- `US-Mixed KW 5th Aug. V2 - DDC` $12.24 -> **$0.00**.
- The money followed the traffic: Machinery Manufacturers **$41.60 on 171 clicks**, Insurance Quotes
  **$24.47 on 124 clicks**, Legal/Business $22.96 on 90, Online University $17.93 on 69.
- Day total conserved at **$276.22** against $376.88 spend, 36 campaigns.
- Exactly **one** row still shows revenue without same-day traffic — Pest Control at **$0.06**, which
  took 10 clicks and $1.40 the previous day. That is the click-to-search lag the trailing window
  exists for, and it is correct.
**Live verification:** **Campaign == Ads 27/27** across source x account (3971 / 243 / 239) x feed x
status x three windows; grain overlap 09-04..05 = **$403.74 on all five views**; **56 tab/filter
combos clean**; ground truth **43 days, 0 mismatches, $7,093.4095 == $7,093.4095** against DDC's own
`report_type=date` API.
**Milestone 3 (DDC) is complete and correct**: daily + hourly feeds, device split, tt normalisation,
traffic-weighted per-campaign attribution, 3-hourly and hourly crons, all self-sustaining.
**Still uncommitted** — 040-046 and the `src` changes live only in the working tree.
**Commit:** not committed

### 2026-09-09 — DDC pull moved to EVERY HOUR (client request)
**What:** Nadia asked for an hourly DDC API call. Clarified first: the HOURLY feed was already pulled
every hour at `:50`; it was the DAILY pull that ran only every 3 hours (`45 */3 * * *`). So that is
what changed.
**Change:** the two DDC jobs are merged into ONE hourly job at `45 * * * *` running both feeds and
refreshing the MV once. That also removes a duplicate MV refresh — previously `:45` (3-hourly, both
feeds) and `:50` (hourly feed) each refreshed the view.
**Why it is cheap to run hourly:** `syncDDCRange` asks DDC's `date` report once and only fetches
`detail` for days it says actually have revenue, so a run is ~5 calls rather than one per day in the
window. Dry run over 09-06..09-09 confirmed it: 2 days fetched, **2 days skipped** as empty, 0
failures. The upsert is idempotent, so re-running the same days every hour just converges — which
also makes DDC's habit of intermittently answering "No stats for this date" self-healing instead of
a lost day.
**Verified:** `tsc` clean; both feeds dry-run successfully (daily range 0 failures; hourly 615.5642
across its rolling window). Cron list is now taboola :05, codefuel :15, IA :20, outbrain :25,
**DDC :45**, metadata every 2h, backfill 03:00.
**Needs a WORKER deploy** (cron only — no API or migration change).
**Commit:** not committed

### 2026-09-09 — Broken filters: Outbrain missing from dropdowns, GD filter inert (client report)
**Reported:** Nadia — *"when I look for a specific campaigns or Gds, they are not showing on theses
filters"*, with a screenshot: the Campaign tab visibly listing `US-IT Best Management Software`
while typing that exact name into the campaign filter returned **"No matches"**.

**Two independent defects, both confirmed against the live DB.**

**1. The dropdowns only ever offered Taboola.** `/api/filters/options` built its campaign list from
`SELECT id, external_id, name FROM campaigns` — the Taboola-only table — so all **556 Outbrain
campaigns** were unofferable, hers included (it exists only in `outbrain_campaigns`). `gds` had the
same shape (`ads.gd_param` only), hiding **10 Outbrain GDs**. Fixed by unioning both tables in each
query, exactly as the earlier status-vocabulary fix did. Campaigns 3707 → **4263**, GDs 32 → **41**.
The frontend keys on `external_id`, so the synthetic `NULL::int` id is harmless, and the two id
spaces cannot collide (Taboola numeric, Outbrain 34-char hex).

**2. The GD filter did nothing at all on the main tabs.** `gd` was accepted by the zod schema, but
`mvWhereParts` never applied it, so **Campaign / Daily / Hourly returned the UNFILTERED total** under
any GD selection — verified byte-identical: 269 rows / $18,504.84 / $24,043.95 both with and without
a GD. On the Ads tab it reached exactly **one** branch (`${gdClause}` was interpolated once, against
`campClause`'s three), so that total did not move either. Country/Device/Site *did* apply it, and
their dropping of cost there is deliberate and documented (geo cost is account-grain).

**Semantic chosen — GD scopes to CAMPAIGNS**, on the MV views and both Ads branches alike:
- The MV collapses revenue to campaign grain; `gd_param` is **NULL on all 1,581 recent MV rows**, so
  filtering that column was never possible.
- It is the only semantic under which cost can be scoped at all — and it is exact in practice:
  **3315/3375 Taboola and 149/150 Outbrain campaigns carry exactly one GD** (61 span two).
- Filtering revenue by `asset_gid` while cost followed whole campaigns would have produced nonsense
  margins on those 61, and broken Campaign == Ads.
Consequently the single-branch `asset_gid` clause and the `-3` branch's blanket
`AND ${p.gd ? 'FALSE' : 'TRUE'}` suppression were both removed: that Taboola cost IS in scope now,
and leaving it suppressed would have pushed the Ads total below Campaign the moment a GD was picked.

**Verified (local API against the live DB):** her exact campaign now resolves
(`001e45713998339de4317025ace06d9cac`) and returns spent $65.78 / revenue $44.07 / margin −49.2%,
matching the MV row for row. GD now bites: `AP1009380` → 7 campaigns, $1,468.32 / $1,577.16, where it
previously returned the full $42,877.48. **Campaign == Ads: 20/20 matched, 0 mismatched** across
GD × source × feed plus unfiltered / status / source regression checks; a separate sweep of 10
newly-offered Outbrain campaigns and 9 newly-offered GDs was 19/19 with 0 filters returning empty.
`AP1009251` legitimately returns 0 rows — it resolves to 7 campaigns that are all `disabled`.
**Needs an API deploy** (no migration).
**Commit:** not committed

### 2026-09-09 — Codefuel hourly: sync yesterday AND today (client report)
**Reported:** Nadia — Codefuel revenue *"is not pulling 100% real time… Image advantage is the only
one close to real time"*.

**Checked before changing anything, and the headline claim is not the bug.** Codefuel already ran
hourly at `:15`, every run returning `ok`. Asked Codefuel's API directly at 05:09 UTC: it offered
**09-08 hours 0–22 and zero rows for 09-09** — precisely what our DB held. We are not behind
Codefuel; **Codefuel publishes ~6h late**, and no data was ever lost (older days all reach 24 hours).

**The real defect is latency, and it was structural.** `window2Hours()` maps a 2-hour *wall-clock*
window onto **dates**, so from 02:15 UTC onward every run asked for **today only**. Because Codefuel
publishes ~6h late, yesterday's final hours are published *after* yesterday has dropped out of that
window **and** after the 03:00 backfill has run — so they waited for the *next* day's backfill, ~27h
later. Live proof: 09-08 h23 was missing, and no hourly run could ever have collected it.
(Discarded a first metric that appeared to show every hour landing >6h late — `fetched_at` is
rewritten by the upsert, so it measures last-touch, not first-arrival.)

**Change:** the `:15` job now syncs **yesterday and today explicitly, each isolated**, mirroring the
IA job. Two calls/hour against a 60/hour limit; the upsert is idempotent, so re-asking for yesterday
every hour simply converges and also picks up any restatement Codefuel makes to a closed hour.
`window2Hours()` remains for Taboola only — same shape, but Taboola publishes near-real-time so its
late hours land inside the window.
**Verified:** `tsc` clean; ran the new job body against production — 09-08 wrote 1,216 rows (a day
the old code would not have requested at this hour), 09-09 correctly returned 0 (nothing published).
**Needs a WORKER deploy** (cron only).
**Commit:** not committed

### 2026-09-09 — Cross-session adversarial review of 44ac043, and the fixes it forced
**What:** dispatched an independent Orca session to try to FALSIFY the filter/Codefuel work above
(read-only on prod). Its report: `docs/reviews/2026-09-09-adversarial-review-44ac043.md`. It
confirmed C1 (dropdowns) and C2 (GD semantic) with exact numbers, and found three real defects. All
verified myself against the live DB before fixing; two of the three were mine.

**F1 — CRITICAL, introduced by 44ac043. Fixed.** `campWhere.replace('c.ob_camp_id', ...)` at four
sites used a **string** argument, which replaces only the FIRST occurrence. My change built
`campWhere` with `+=` so it can now hold TWO clauses (GD and campaign_id) — the second kept alias
`c`, which is not in scope in the ia/dc/cc/al2 branches. Result: `HTTP 500`, Postgres 42P01
*missing FROM-clause entry for table "c"*, on **exactly the workflow this change was meant to
enable** — pick a GD, then a campaign. The adjacent `obStatusWhere` had always used `/c\.ob_camp_id/g`
correctly. Fixed by using the `/g` regex at all four sites. Verified: the four repro requests that
returned 500 now return 200.

**F3 — MAJOR. Fixed.** On Country/Device the GD filter reached only the mapped branch; the
Codefuel-orphan and IA branches had no GD gate, so those tabs reported the **same unattributed total
for EVERY GD** — `gd=AP1008139` gave $0.00 on Campaign/Ads/Site but **$200.88** on Country/Device.
Each branch now gets the gate matching how it is attributed: orphan rows carry a real `asset_gid`
(filter it directly); IA is campaign-attributed (scope by the campaigns carrying the GD, matching the
MV views). Genuinely unattributed revenue has no GD and correctly drops out. Verified it does not
over-suppress: in a June window `gd=AP1008652` returns **$711.17** on Country and Device, matching its
raw Codefuel revenue to the cent, while $0-revenue GDs return 0.

**F2 — MAJOR, pre-existing. Fixed, needs migration 047.** Campaign != Ads by **$200.88** under any
account filter. `ia_camp` groups unattributed IA revenue to a NULL campaign, so `acc.id` was NULL and
`accClause` dropped it: the MV (Campaign tab) counted it, the Ads tab did not. The `-1` branch now
resolves the account with the same lateral the MV uses.
*(The review attributed this to the `-2`/cf_key bucket; it is actually carried by the `-1` row.)*

**The bigger defect underneath F2 — MV books this revenue to a NONDETERMINISTIC account.**
`ia_orphan` (046 line 154) uses a bare `LIMIT 1` over the IA partner's **six** ad_accounts with **no
ORDER BY**, so which account gets the unattributed revenue is arbitrary and changes on refresh.
**Observed live during this session:** the row was booked to account **239 (SBH_ssm_05, Outbrain)**
at ~06:2x and to account **12 (Lead Gen Affiliates 2 - FLUX, Taboola)** minutes later — same data,
just a worker MV refresh. Under the Project/account filter ~$200/window silently hops between
accounts. `ddc_orphan` (line 299) already did this correctly with `ORDER BY id`.
**Migration `047_mv_ia_orphan_deterministic_account.sql`** re-declares the MV with `ORDER BY id` on
that one lateral — a full copy of 046 with that single change (diffed to confirm nothing else moved).
Deterministic pick is account **10**, revenue **$200.8828** (simulated against live data).
**047 and the API deploy MUST ship together**: pre-047 the MV books 12 and the API books 10, so they
agree only once both are in.

**Verified after all three fixes:** Campaign == Ads **16/16** across source × feed × status × GD ×
multi-value GD × GD+campaign × the F1 repro combinations. No perf regression — the review measured
GD making every view *faster* (campaign 1432→177ms, ads 2404→762ms); worst case anywhere is ads
unfiltered at 6.3s against a 2-minute timeout.

**Also confirmed by the review, not changed:**
- D2/D3 clean: removing the `-3` GD suppression does not double-count, and `obFiltered` suppressing
  `-6` under a GD filter is correct (the MV drops the same money — `IN (...)` cannot match NULL).
- D6: 61 multi-GD campaigns exist but dollar impact is currently **zero**; latent once Taboola resumes.
- C5 correction: Codefuel's publish lag is ~3h, not ~6h. At 05:57 UTC their API had 09-08 h23 and
  09-09 h0–h2 while our DB had none — **$29.78** the old deployed code could not fetch. That is the
  bug this fix removes, and it is still live until the worker is deployed.

**OPEN, not fixed:** spend-only drift Campaign vs Ads (−$2.01 unfiltered, revenue matches to the
cent; looks like share-allocation rounding) — Campaign == Ads is exact on revenue but true only to
~$2 on spend. And `/api/filters/options` is now 341KB (4263 unbounded campaigns).
**Needs: API deploy + migration 047 together, and a WORKER deploy.**
**Commit:** not committed

### 2026-09-10 — Second live audit: inert Country/Device/Status filters, and today's Outbrain cost
**What:** dispatched a second independent session to probe EVERY filter × every tab against LIVE
production (~320 read-only probes). It confirmed the campaign/GD fixes are live, found **zero HTTP
500s**, and **Campaign == Ads 84/84**. It also found defects that had never been reported, all
reproduced by me before fixing.

**1. Country and Device filters were completely INERT — on every tab. Fixed.**
Verified live: `country=AR`, `country=AT`, `device=mobile`, `device=desktop` each returned the
byte-identical unfiltered total ($40,198.46) on Campaign, Daily, Hourly, Ads — *and* on the Country
and Device tabs themselves. Same defect class the client already reported twice.
Two different causes, so two different fixes:
- **On Campaign/Daily/Hourly/Ads it is unfixable by filtering.** The MV is campaign-hour-account
  grain and stores `country`/`device` as **empty strings on all 2,517 rows** — country is a *split
  dimension*, not a campaign attribute (a campaign spans many countries), so unlike GD there is no
  valid campaign-scoping semantic, and revenue-by-country against campaign-grain cost would produce
  meaningless margins. The controls are therefore **no longer rendered on those tabs**, and
  `apply()` no longer emits the params, so a stale value cannot linger in the URL looking applied.
  An honest missing control beats a control that silently does nothing.
- **On the Country/Device tabs they now work.** The dimension filter reached only the mapped branch;
  the Codefuel-orphan and IA branches leaked their totals through unchanged. Orphan rows carry a
  real country/device so they are filtered directly; **IA reports NEITHER (0 of 24,445 rows)** so it
  is excluded outright rather than shown against whatever value was picked. Verified `device=mobile`
  now returns exactly the `mobile` row the tab lists.
- Status is a campaign attribute that does not reach those tabs' branches, so the Status control is
  hidden on Country/Device/Site for the same reason.

**2. Today's Outbrain cost was missing all day — the 100%-margin rows the client reported. FIXED.**
`syncOutbrainCost` (per-campaign daily cost → `outbrain_stats_daily`) ran **only in the 03:00
backfill**, while `outbrain_marketer_hourly` refreshed every hour. The two feed different tabs, so
during the day the Campaign tab showed **$0 Outbrain spend** while the Hourly tab showed the real
number — measured 2026-09-09: campaign-grain **$0.00** vs marketer-hourly **$2,482.29** for the same
day. This is the single root cause of BOTH the reported Today-preset anomaly and the Hourly-vs-
Campaign divergence under `source=outbrain`.
`syncOutbrainCost` now runs in the hourly `:25` Outbrain job over the same 2-day EDT window (~14
calls/hour, same order as the marketer-hourly job already there), followed by an **MV refresh** —
required, because Campaign/Daily read the MV and new cost is invisible without one.
Ran it against production and refreshed: the Today preset went from **$0.00 spend / $1,820.26 profit
/ 100% margin** to **$2,293.74 spend / $75.43 profit / 3.2% margin**. Verified on the live API.
(The ±$140/day differences on older days are the known EDT-vs-UTC day-boundary effect between the
two Outbrain feeds, not a defect.)

**3. Country/Device/Site coverage note added.** Those tabs show $183.79 of $40,752 because IA (~87%
of revenue) reports no country/device at all and Outbrain reports no cost at that grain, so with
Taboola stopped upstream they read as "data missing" rather than "dimension not reported". They now
carry an explicit note. **Not changed:** whether to surface Outbrain-sourced revenue in these tabs —
the data exists (9,837 Codefuel + 4,362 DDC rows carry country) but it would add cost-less rows and
therefore fresh 100%-margin confusion. Flagged for the user's decision rather than done unilaterally.

**Also confirmed:** the Site dropdown is empty because `taboola_geo_cost_daily` has **0 site rows in
14 days** (36,416 all-time) — the upstream Taboola outage, not a code defect.

**Verified after all changes:** every applicable filter × tab now changes its result; the only
remaining "inert" pairs are `source=taboola` on Taboola-only tabs (correct — equals unfiltered) and
Status there (now hidden). **Campaign == Ads 19/19** across source × feed × status × account ×
multi-value × GD × GD+campaign × 4-filter combinations. `tsc` clean, backend and frontend.
**Needs: API deploy + WORKER deploy + Vercel (frontend) deploy.** No migration.
**Commit:** not committed

### 2026-09-10 — Post-deploy verification of 7a18605, and the same gap one level down
**What:** the user deployed API + worker + frontend and asked for a check. Verified everything
against live production, then found and fixed a defect the deploy exposed.

**Verified live (API, Render):**
- Migration `047` is applied (`_migrations`: 2026-09-09 19:31), so the MV and the API agree on the
  IA-orphan account. `/health` 200, `/api/sync-status` fresh for codefuel, IA and DDC.
- The F1 repro is dead: GD + campaign_id together returns **HTTP 200 on all 7 views** (was a 500,
  Postgres 42P01).
- The Country/Device fix is live: `view=device&device=mobile` and `view=country&country=AR` now
  return **0 rows** for a Sept window instead of the byte-identical unfiltered total. Under the old
  code both echoed $121.68.
- Campaign revenue == Ads revenue **to the cent** on every window tested.

**Verified live (worker, Render):** the hourly Outbrain chain is running as deployed — `22:25:00`
marketer-hourly → `22:26:06` **cost** → MV refresh. `outbrain_stats_daily` now carries the current
day intraday ($2,419.25 for 09-09), which is the fix for the 100%-margin Today preset.

**FOUND AND FIXED — the identical gap in `outbrain_ad_daily`.** Closing the campaign-grain hole
exposed that per-promoted-link cost had the same one: `syncOutbrainAds` runs **only** inside
`syncOutbrainBreakdowns` in the 03:00 backfill, and the Ads tab reads `outbrain_ad_daily` directly
(server.ts:941/1003/1150), not the MV. Measured at 22:2x: the table had **0 rows for 2026-09-09**,
so the Ads tab read **$0.00 spend / 100% margin** for today while the Campaign tab — freshly fixed —
read $2,293.74. That is the client's original symptom surviving one tab over, and it broke
**Campaign == Ads for any window containing today** ($2,315 gap on 09-01→09-09).
`syncOutbrainAds` now runs in the same hourly `:25` chain, same 2-day EDT window, between the
campaign-cost pull and the MV refresh. Ran it against production to fill today.
**After:** Ads spend 09-09 **$0.00 → $2,430.72** against Campaign's $2,419.25; the 09-01→09-09 gap
went **$2,315 → $11.38**. Revenue still matches to the cent.
**Correction to my first reading of the residual:** I initially wrote that the leftover ~$11 was the
~4-minute offset between the two pulls on a still-accruing day. It is not — closed days carry the
same kind of gap (09-08: campaign $2,522.35 vs ads $2,500.69; 09-07: $2,402.45 vs $2,402.53), so it
is Outbrain's per-link and per-campaign reports not summing identically upstream, ~0.035% of spend.
Not an attribution defect, and not something a later tick converges away.

**Noted, not fixed:** one `npm run sync:once` produced **two** overlapping `sync_runs` rows for the
same job (22:29:56 and 22:30:41, both 502 rows, idempotent so harmless). Cron jobs show no such
duplication — the 2-3 row groups there are the deliberate yesterday+today / 3-feed splits. Looks
like a tsx/npm double-execution of `run-once.ts`; it doubles API calls on manual runs only.
Also: `backend/node_modules` has been reinstalled, so `tsx` and `npm run` work on this Mac now —
CLAUDE.md §3 and the memory note claiming otherwise are stale.
**Needs: WORKER deploy** (backend only, no migration, no frontend change).
**Commit:** `d36651b`

**Note for future sessions:** the entry immediately below documents the SAME defect and the SAME
fix. Two sessions were running against this working tree at once on 2026-09-10 and found it
independently within minutes of each other; `d36651b` committed both entries and one copy of the
cron change. Nothing was applied twice — the code has a single `syncOutbrainAds` call in the `:25`
job. The dollar figures differ only because the two sessions measured at different minutes while the
manual production sync was still writing (0 rows → $68.38 → $2,430.72 for the day).

### 2026-09-10 — Ad-level Outbrain cost had the same intraday gap, one level down
**Found while re-checking after deploy**, and only because this pass compared **spend** as well as
revenue — the earlier "Campaign == Ads 19/19" sweeps compared **revenue only**, which matched to the
cent the whole time while spend was diverging. Revenue-only was not a sufficient check.

**Defect:** `syncOutbrainAds` (per-promoted-link daily cost → `outbrain_ad_daily`, which the Ads tab
joins directly) ran **only** inside `syncOutbrainBreakdowns` in the 03:00 backfill — exactly the gap
the campaign-grain job closed earlier the same day, one level down. Intraday the table held almost
nothing for the current day, so the Ads tab showed near-$0 Outbrain spend while the Campaign tab
(hourly since this morning) showed the real figure.
Measured live 2026-09-09 22:30: `outbrain_ad_daily` **$68.38** vs `outbrain_stats_daily`
**$2,419.25** for the day; the live API returned Campaign spend **$2,419.25** against Ads spend
**$68.38** for a today-only window — **Campaign != Ads on spend for any window containing today**,
the client's #1 invariant, broken every day until the overnight run.

**Fix:** `syncOutbrainAds` now runs in the hourly `:25` Outbrain job over the same 2-day EDT window.
That job now carries three Outbrain pulls (marketer-hourly, per-campaign cost, per-ad cost) at
7 marketers x 2 days each = **42 calls/hour**, all idempotent upserts.
**Verified:** ran it against production (502 rows); today's spend gap fell from **$2,350.87 to
$11.47**, and revenue still matches to the cent on every combination.

**Residual, quantified, NOT fixed:** ~**$11.57 on $32,808 (0.035%)** spend difference between the
two tabs. Outbrain's per-link and per-campaign reports do not sum identically — visible on closed
days too (09-08 ad-level $2,502.69 vs campaign-level $2,522.35 = -$19.66; 09-07 +$0.08), so it is
upstream reporting, not attribution. This is the same drift the first audit logged as "-$2.01
unfiltered". Campaign == Ads is **exact on revenue** and true to ~$12 on spend.
**Needs a WORKER deploy.**
**Commit:** not committed

### 2026-09-10 — Post-deploy verification: all four fixes confirmed live
Worker deploy of `d36651b` confirmed at the **05:25 UTC** tick, which ran all three Outbrain pulls
(`marketer-hourly` 05:25, `cost` 05:25, `ads` 05:26 / 299 rows). Today's ad-level cost went
**$0.00 → $88.99** against campaign-level **$89.02**.

**Final live state, verified against the deployed API:**
- Today-only window: Campaign vs Ads **Δspend $0.03, Δrevenue $0.00** (was Δspend $2,350.87).
- 14-day window across 15 filter combinations (source × feed × status × account × multi-value ×
  GD × GD+campaign × 4-filter): **15/15 matched**, worst spend Δ **$0.11**, revenue Δ **$0.00**
  everywhere.

**Correction to the previous entry.** That entry recorded a residual "~$11.57 / 0.035% spend
difference … Outbrain's per-link and per-campaign reports do not sum identically … upstream
reporting, not attribution." **That attribution was wrong.** The drift was stale `outbrain_ad_daily`
data, not disagreement between two Outbrain reports. With ad-level cost syncing hourly the residual
across a 14-day window is **$0.11**, and the per-day figures now agree to cents. Campaign == Ads is
exact on revenue and effectively exact on spend.

**Method note worth keeping:** the defect in the previous entry existed for hours while sweeps
reported "Campaign == Ads 19/19", because those sweeps compared **revenue only**. Revenue matched to
the cent throughout while spend diverged by $2,350. **Any future invariant check must compare spend
and revenue.**

**Deploy state:** API, worker and frontend all deployed; migration 047 applied. Frontend
(Country/Device/Status controls hidden where inert, dimension-coverage note) is committed and
typechecks but was **NOT verified by eye** — the dashboard is auth-gated and the browser extension
was not connected. Needs a manual spot-check: on the Campaign tab "All countries" / "All devices"
should be absent; on the Country tab "All countries" should be present.
**Commit:** not committed

### 2026-09-12 — Daily DDC hourly-by-Type-Tag CSV, emailed to the client
**Client ask (Nadia):** an hourly DDC report at Type Tag level, like IA's User Tag view; the raw tag
in DDC's own `<TT>_<publisher_id>` form; columns date + hour + TT + clicks + searches + revenue +
RPC; emailed daily to nadia777solutions@gmail.com around 9–10am UK.

**Answer to the underlying question:** yes, DDC's hourly feed carries the type tag on **100% of rows**
(1,322/1,322 when checked, 159 distinct tags, all 24 hours), plus device and country. Their own
platform UI does not expose it; the API does, because the hourly feed is a **separate service**
(`rdp.ddc.com`) from the reporting host their dashboard uses.

**Built:**
- `src/sources/resend/client.ts` — minimal Resend sender (HTTP only, matching the
  `sources/<name>/client.ts` convention). Resend only delivers to arbitrary recipients from a
  **verified** domain; `aiclarity.online` is the verified domain on this account, hence the
  `REPORT_EMAIL_FROM` default.
- `src/reports/ddc-hourly-csv.ts` — `buildDdcHourlyCsv(date)` + `sendDdcHourlyReport()`.
- `run-once` job `ddc-report [date] [recipient]` for manual sends and rehearsals.
- Cron at **10:00 `Europe/London`**.

**Built from DDC's API, NOT from `partner_stats_hourly` — deliberately.** The sync stores bidded
searches but **discards raw `searches`**, and it splits DDC's tag into a normalized tt + publisher
(`campaign_ext_id` / `item_ext_id`). The client asked for `searches` and for the raw
`<TT>_<publisher_id>`, so sourcing from our own tables would have shipped a file with a missing
column and the wrong tag format. *(Latent gap worth closing separately: we drop `searches` on
ingest.)*

**Send time is set by measured lag, not by guess.** DDC publishes ~**7h** behind: at 18:15 UTC their
freshest hour was 11:00, so the previous day only completes near **07:00 UTC**. The client's first
suggestion of 9am UK (08:00 UTC) left ~1h of margin; **10am UK** leaves ~2h. The schedule is pinned
to `Europe/London` rather than a hardcoded 09:00 UTC so it stays at 10am local when BST ends.
`sendDdcHourlyReport` **refuses to send a row-less file** — silence beats mailing the client a
header-only CSV that reads as a zero-revenue day — and the rolling ~3-day feed means a missed day
can still be produced afterwards.

**Verified end-to-end:** rehearsed to the operator's own address first (Resend id
`3952c2e9-7690-466c-9f66-d889502f9afb`), 2026-09-11 = 24/24 hours, 81 tags, $441.66.
Client file delivered covering three complete days: 09-09 $610.11 / 09-10 $533.57 / 09-11 $441.66,
1,592 rows, 177 raw tags (173 carrying a publisher_id).

**Secrets:** `RESEND_API_KEY`, `REPORT_EMAIL_FROM`, `REPORT_EMAIL_TO` added to `.env` (gitignored),
placeholders in `.env.example`, and declared `sync: false` in **`render.yaml` under the worker** —
the step missed for `DDC_HOURLY_AUTH_CODE`, which then failed 14 runs in a row. Confirmed the live
key appears in no tracked file.
**Needs a WORKER deploy + the three vars set in the Render dashboard.**
**Commit:** not committed

### 2026-09-14 — Daily report had no observability; added sync_runs recording
**Trigger:** tried to answer "did yesterday's client report actually send?" and could not. Resend's
API has **no list endpoint** (retrieval is by id only — the 2026-09-12 rehearsal to the operator
confirms as `delivered`, but only because its id was known), and the cron job used bare `attempt()`
rather than `withSyncRun`, so it wrote **nothing** to `sync_runs`. Every other job records there.
On the one job that goes straight to the client, there was no way after the fact to tell whether a
send ran, failed, or never fired. That was an omission in the 2026-09-12 build, not a new defect.

**Change:** the 10:00 Europe/London job now runs under `withSyncRun('ddc','report',date,date,…)` and
passes the resolved date explicitly, so each day appears in `sync_runs` with status and error text.
Check it with: `SELECT * FROM sync_runs WHERE source='ddc' AND job_type='report' ORDER BY started_at DESC`.

**Still unknown and NOT claimed:** whether the 09-13 and 09-14 sends happened. There is no record to
consult, and the worker deploy of `c6027bc` was never confirmed. The first verifiable send is the
first 10:00 UK run after this change is deployed.
**Needs a WORKER deploy.**
**Commit:** not committed

### 2026-09-14 — Codefuel cost/revenue mismatch: shared (gd,r) pairs owned by PAUSED campaigns
**Reported (Nadia):** *"mismatch between cost and revenue on codefuel feed … some of the ads have the
same R= parameter, in some cases they have been duplicated to other accounts, but when this happen at
least one of them is paused and the other active, so can you please find a way to match revenue with
corresponding ads/campaigns?"* — her diagnosis was correct.

**Confirmed, with numbers.** `outbrain_ads` is keyed on `(gd_param, r_param)` GLOBALLY, so one campaign
owns a pair and all of its Codefuel revenue. The dedup in `syncOutbrainPromotedLinks` preferred a
campaign that had **EVER** spent on the pair — no date window, and **status was never consulted** — so
a campaign that spent months ago and was since paused kept the pair forever while the live duplicate
got nothing.
Measured over 265 recently-active campaigns (raw promoted-links, 2026-09-14): **72 of 368 pairs are
shared**; 50 have every copy paused, **21 have exactly one enabled copy** (Nadia's case), 1 has two.
Of the revenue on those 21 pairs, **$420.33 of $869.82 (48%) sat on a PAUSED campaign** — visible as
paused campaigns carrying 2-6x more revenue than spend while the active duplicates ran short.

**Fix — ownership is now scored, highest wins:**
`4` spent on the pair in the **last 7 days** · `2` campaign **enabled** · `1` has **ever** spent.
Ties keep the **incumbent** owner, and only fall back to `campaign_id` ordering when neither candidate
holds it. Two deliberate choices:
- **Recent spend outranks status**, because a campaign is usually paused *after* it spends: 45
  disabled campaigns still spent **$342.93** in the last 7 days. Ranking status first would have moved
  revenue away from the campaign that actually drove it. Verified on the two largest
  disabled→disabled moves: targets had $6.41 / $6.59 of 7-day spend against the incumbents' $0.00.
- **Incumbent-wins-ties**, because 50 of 72 shared pairs have no qualifying candidate at all; without
  it a re-sync would reshuffle that revenue between equally-unqualified accounts on every run — the
  precise failure this function was burned by before (first-seen ordering once handed three new
  accounts 28 pairs they had never spent on).

**Applied to production** (`outbrain-ads` sync + MV refresh) after a dry run showed exactly 36
ownership changes / $797.49 of 14-day revenue moving, 19 to enabled campaigns and 17 to
recently-spending ones.
**Result:** revenue sitting on disabled campaigns fell **$2,774.19 → $2,116.00 (-$658.19)** with
**spend unchanged at $32,971.39** — proof that revenue moved rather than totals shifting. The MV total
rose $10.29 over the same interval, accounted for by the Codefuel hourly cron firing mid-operation
(841 rows written); no unattributed bucket shrank.
**Verified:** Campaign == Ads **11/11**, revenue exact to the cent across source × feed × status ×
account × multi-account; worst spend delta $0.11.

**Not addressed (deliberate):** the 1 pair where two campaigns are simultaneously enabled, and the 50
where all copies are paused, still assign the whole pair to a single owner. Splitting revenue across
genuinely co-active campaigns needs click-weighted allocation like the DDC `tt` path, which is an MV
change rather than a sync change.
**Needs a WORKER deploy** for the rule to persist; the data fix is already live.
**Commit:** not committed

### 2026-09-15 — Cross-session audit of the pair-ownership fix; two real defects fixed
Independent session, read-only against live prod. Report:
`.../88e6c02f-.../scratchpad/codefuel-ownership-verification.md`.

**Confirmed:** C1 the client's exact `US-Mixed KW 2 Sept. V5 - 9377` case is one row again
(SBH_ssm_11_Codefuel, $42.30 spend / $22.93 revenue); C2 **0** pairs left with a no-recent-spend
owner beside a spending campaign; C3 **Campaign == Ads 34/34 on BOTH spend and revenue**, Δrev
$0.00 everywhere, worst Δspend $0.32 on a $65k window, and 14/14 accounts individually; C4 totals
preserved against the BASE tables, not MV-vs-MV — spend $35,432.38 == `outbrain_stats_daily`,
revenue $54,612.76 == `partner_stats_hourly`, both exact; D3 no double-count; D4 the comparator is
permutation-invariant.

**Defect found in MY change — the incumbent rule was silently inert.** The main dedup map keys on
`` `${gd}\x01${r}` `` (a pre-existing **invisible \x01** separator, present since 230618e), while the
`currentOwner` map I added keyed on `` `${gd}${r}` `` with no separator at all. The two schemes never
matched, so every `currentOwner.get(key)` missed and incumbent-wins-ties never fired — ties fell
through to `campaign_id` ordering instead. The stability guarantee claimed in the 2026-09-14 entry
was not actually in effect. Both maps now use one explicit `|`; the file no longer contains any
control character. *(The audit reported this as "no separator"; that reading was wrong — there was
one, just invisible. The bug it exposed was real and mine.)*

**Defect fixed — a transient Outbrain API failure could move ownership permanently.** A failed
`listPromotedLinks` was caught and `continue`d while the upsert still wrote, so a campaign we simply
could not read dropped out of the contest for every pair it owns and a lower-scored campaign took
them on one flaky HTTP call — and for tied pairs the substitute became the incumbent, locking it in.
Now: failures are tracked, any pair whose **current owner** failed to fetch is left untouched, and
if more than 10% of campaigns fail the ownership upsert is skipped entirely. Both counts are logged.

**Framing corrected.** The residual was reported as "1.96% of September Outbrain spend". True, but
the denominator is 88% IA/DDC spend this rule never touches: only $4,238.81 of the $35,432.29 carries
a (gd,r) pair, so against the spend this rule actually governs it is **16.4%** ($695.41 over 60 pairs
/ 27 campaigns). Residual *revenue* is the smaller and more relevant number: **$26.83 across 3 pairs,
0.87%** of Codefuel-Outbrain revenue. Also: **0** pairs currently have two simultaneously-enabled
campaigns both spending, so the unsplit case has no live exposure.

**Unchanged and still the top risk:** `syncOutbrainPromotedLinks` runs only in the 03:00 backfill,
the repo has **no git remote**, and the worker is **not deployed** — so the next 03:00 run executes
the old ever-spent rule and reverts the whole month again, silently. The current correct state is
hand-applied. *Caveat on my own earlier claim: the 03:16 revert I observed is no longer provable from
`updated_at`, because my 05:33 re-application overwrote it.*

**Also noted, pre-existing, not fixed:** `view=ads` returns HTTP 500 for windows longer than ~2 months.
**Needs a WORKER deploy.**
**Commit:** not committed

### 2026-09-15 — Report sender moved to nadia@revlogicmedia.com
**Why it mattered more than a string change:** checking the Resend account first showed
`aiclarity.online` is **no longer on it at all** — the only verified domain is now
`revlogicmedia.com` (status verified, sending enabled). The committed default still pointed at
`aiclarity.online`, so the daily report would have **failed on its first real run** after deploy.
Resend only delivers to arbitrary recipients from a verified domain.

**Changed:** default in `config/env.ts`, the docblock in `sources/resend/client.ts`, `.env.example`,
and `.env` (plus a stale comment there) — no `aiclarity` reference remains.
`REPORT_EMAIL_FROM = Seven Sphere Reports <nadia@revlogicmedia.com>`.

**Verified end-to-end, not just accepted:** sent the 2026-09-14 report (24/24 hours, 57 tags,
$236.40) to the operator's own address and retrieved it from Resend by id
`56d92ee2-59c0-4362-97bf-e32eedf21d61` — `from` shows the new sender and `last_event` is
**delivered**. A 200 from Resend alone only proves the from-domain was accepted, so the id lookup is
the step that actually confirms delivery.
**Needs the WORKER deploy + `REPORT_EMAIL_FROM` updated in the Render dashboard** (it is
`sync: false`, so the committed default does not reach the running service on its own).
**Commit:** not committed

### 2026-09-15 — Report: multi-day range + fallback to stored rows for aged-out days
**Sent to the client** (nadia777solutions@gmail.com): DDC hourly-by-Type-Tag for **2026-09-12..14**,
734 rows, 115 tags, **$738.74** — per day 09-12 $176.04 / 09-13 $326.31 / 09-14 $236.40, matching
`partner_stats_hourly` exactly.

**Two changes, both prompted by the send going wrong first time:**
1. `sendDdcHourlyReport` now accepts `dates[]` and `buildDdcHourlyCsvRange` emits one file across a
   range; `run-once ddc-report <from> <to> [recipient]` drives it.
2. **`buildDdcHourlyCsv` falls back to `partner_stats_hourly` when a day has aged out of DDC's
   rolling ~3-day feed.** Without this the first attempt at "last 3 days" silently shipped **two** —
   2026-09-12 had already left the feed and was dropped without comment. The fallback leaves the
   `searches` column **EMPTY** rather than writing 0, because the sync retains bidded searches but
   not raw searches, and a fabricated 0 would read as a real measurement. Verified in the delivered
   file: 09-12 has 189 rows with `searches` blank, 09-13/09-14 have it populated.

**Client received two emails as a result** — the incomplete 2-day file, then the complete 3-day one
that supersedes it.

**Recipient policy (operator instruction):** report email goes to **nadia777solutions@gmail.com
only**. Earlier rehearsal sends went to the operator's own company address to avoid mailing untested
output to the client; that is no longer to be used.
**Commit:** not committed

### 2026-09-18 — Outbrain spend stopped: credentials rejected (NOT a code bug)
**Client report:** *"there seems to be an issue with spends, it has not been fully synced"* for
2026-09-17. Correct.

**Diagnosis.** Outbrain cost stops at **2026-09-17 15:00 UTC**: hours 16–23 are absent (09-16 has all
24), leaving 09-17 at **$933.05** against ~$2,600–3,075 on preceding days. All three cost tables
agree (campaign-grain $933.05 / ad-grain $933.26 / marketer-hourly $1,016.01), so this is missing
data, not misattribution.

**Root cause: the Outbrain credentials are no longer valid.**
`GET /login` with the configured username/password returns
`401 {"message":"Unauthorized: Bad credentials"}`. The cached token (written 2026-09-03, 14.9 days
old, inside the 25-day refresh threshold) kept working until Outbrain invalidated it at ~15:25 UTC on
09-17 — the signature of a password change. Every sync since has 401'd: last successful Outbrain run
**09-17 15:25/15:27**, 20 failures in the last 6 hours.
The client's 401 retry path is correct and not at fault — it forces one fresh login on 401, and that
login is itself rejected. **No code fix is possible; new credentials are required.**

**Scope.** Outbrain only. Codefuel, DDC, Image Advantage and Taboola are all syncing normally, so
REVENUE is current (IA to 09-18 05:00) while Outbrain SPEND is frozen at 09-17 15:00 — which is why
the dashboard shows inflated margins for 09-17 evening onward. The daily backfill also fails,
because it contains Outbrain steps.

**Recovery once credentials are replaced:** none needed by hand. The 03:00 backfill window is
**D-4..D-0**, so it re-fetches 09-14..09-18 and closes the gap on its first successful run.

**Fixed what could be fixed — the silence.** This ran broken for ~17 hours and the CLIENT noticed
first. `attempt()` deliberately swallows failures so one bad source cannot kill a tick, and
`sync_runs` recorded all 20 errors, but nothing reads them. Added `reports/sync-health.ts`:
- `findStaleSources()` measures from the last **successful** run, not the last run — a source failing
  hourly looks busy while producing nothing.
- Per-source thresholds (3h for hourly sources, 30h for the daily backfill), emails via the existing
  Resend client, and suppresses repeats to one alert per 6h so a multi-day outage does not send 24
  mails a day and get filtered as noise.
- Cron at `:50`, after every other job has had its turn in the hour; `run-once sync-health [to]
  [--force]` for manual checks.
- Recipient is **`ALERT_EMAIL_TO`**, deliberately separate from the client report address — this is
  operational mail and must not go to the client. Unset for now: with no address it logs at error
  level and sends nothing.
**Verified** against the live database: correctly reports `outbrain, 17.5h since last success, 20
recent failures, last error 401`, and correctly sent no email with `ALERT_EMAIL_TO` unset.
**Needs: new Outbrain credentials (operator/client), then a WORKER deploy for the watchdog, plus
`ALERT_EMAIL_TO` set in Render.**
**Commit:** not committed

### 2026-09-18 — Outbrain outage: gap backfilled by hand; Render still holds the old password
**Password confirmed changed 09-17** (operator). The new one **works**: `/login` with the local
`.env` credentials returns **HTTP 200** and a fresh token.

**But the deployed worker is still 401-ing** — last failure 09-18 09:25, minutes before that test.
So `OUTBRAIN_PASSWORD` on the Render worker either was not saved or the service has not restarted;
the credentials themselves are fine. Until that is corrected no NEW Outbrain data will arrive,
and the day will go stale again.

**Gap closed manually** using the valid local token, rather than waiting for the worker:
`outbrain-cost 09-14..09-18`, `outbrain-marketer-hourly`, `outbrain-ads-breakdown`, then an MV refresh.
- **2026-09-17: $933.05 → $2,145.68** campaign-grain, and the hourly table went **16 → 24 hours**.
- 2026-09-18 partial as expected mid-day ($249.80, 10 hours at 09:52 UTC).
- Three cost tables now agree for 09-17: campaign $2,145.68 / ad-level $2,145.66 / marketer-hourly
  $2,114.18 (the ~$31 is the known EDT-vs-UTC day-boundary difference between the two Outbrain feeds).
- Dashboard 09-17 now reads spend $2,291.10 / revenue $2,921.02 / margin 21.6%, in line with
  09-15 and 09-16, instead of the inflated margin the missing spend produced.

**Verified:** Campaign == Ads over 09-15..09-18 — revenue exact (Δ $0.00) on unfiltered, source=outbrain
and status=enabled.

**Noted, not chased:** unfiltered spend Δ is **-$56.49** against -$4.51 for Outbrain alone, so ~$52
sits on the Taboola side; previous checks ran at ~$0.11. Revenue is unaffected. Pre-existing and
unrelated to this outage, but worth a look once the worker is healthy.

**Open:** fix `OUTBRAIN_PASSWORD` on the Render worker (and confirm it restarted). The `:50` health
watchdog from the previous entry is committed but **not deployed**, so it is not yet watching this.
**Commit:** not committed

### 2026-09-18 — Outbrain recovered after the Render password was corrected
**Worker is healthy.** After `OUTBRAIN_PASSWORD` was fixed on Render the service restarted and all
three Outbrain jobs succeeded at **09:36 / 09:41 / 09:44** (cost 529 rows, marketer-hourly 474, ads
804). Last failure was 09:25 — a clean cutover.

**Dashboard, live API:**
| day | spend | revenue | margin |
|---|---|---|---|
| 09-15 | 3,075.92 | 4,969.99 | 38.1% |
| 09-16 | 3,002.63 | 3,877.69 | 22.6% |
| 09-17 | 2,291.10 | 2,921.02 | **21.6%** |
| 09-18 | 298.64 | 166.85 | −79.0% (mid-day; spend accrues ahead of reported revenue) |

09-17 is back in line with the days either side. Total outage: **09-17 15:25 → 09-18 09:36**, ~18h,
all of it cost-side only.

**Watchdog false positive found and fixed before deploy.** Running it against live flagged
`image_advantage_x` as stale 6.7h after a successful run — it is a **daily-only** job inside the
03:00 backfill, so the 6h default was wrong. Given a 30h threshold alongside `cron`. This mattered:
an alert that fires every day for a healthy source is one nobody reads, which would have made the
watchdog worse than useless.
Now reports exactly one stale source: `cron`, last success 09-17 03:00 — a **true** positive, since
today's backfill failed on the Outbrain steps while the credentials were bad. It clears on its own
at 03:00 tomorrow.

**Still to deploy:** the watchdog itself (`0539544` + this threshold fix) and `ALERT_EMAIL_TO`.
Nothing is watching automatically yet.
**Commit:** not committed

### 2026-09-18 — Sync alerts wired to the client inbox, copy rewritten for that audience
`ALERT_EMAIL_TO = nadia777solutions@gmail.com` (operator's instruction — same inbox as the daily
report). Added to `.env`, `.env.example`, and declared `sync: false` on the worker in `render.yaml`.

**Because these now land in the CLIENT's inbox, the alert body was rewritten.** The first version
emitted raw diagnostics — `outbrain: 20 failures in the last 6h, last error: Request failed with
status code 401` — which reads as a stack trace to the person paying for the dashboard. Now:
- source names are business labels (`Outbrain (cost/spend)`, not `outbrain`),
- HTTP statuses become causes — 401/403 → *"the API login is being rejected — the password or API
  key likely needs updating"*, plus cases for 429, timeouts and 5xx,
- the impact line says what it means for the numbers: *"margins on the dashboard will look higher
  than they really are."*

Replaying yesterday's outage through it produces exactly the message that would have saved the 18
hours: *"Outbrain (cost/spend) — last updated 2026-09-17 15:27 UTC (17.5h ago). Likely cause: the API
login is being rejected…"*

**Two wording bugs caught by previewing against the live state rather than only the replay:**
1. A stale `cron` reported *"Revenue figures will be understated"* — a failed backfill withholds
   **cost** too. Impact is now computed from which sources are actually stale, including the
   both-affected case.
2. Every alert closed with *"the missing days are re-imported automatically by the nightly job"* —
   circular when the nightly job is itself the failure. It now says the gap will **not** close on its
   own in that case.

**Deliberately not sent.** The only currently-stale source is `cron`, a self-clearing consequence of
the outage already fixed; mailing the client an alarm about a handled problem would undermine the
first alert she ever gets from this. Verified by rendering the body instead.
**Needs a WORKER deploy + `ALERT_EMAIL_TO` set in Render.**
**Commit:** not committed

### 2026-09-18 — Post-deploy check: report job live, watchdog had a self-inflicted spam bug
**Deploy confirmed working.**
- All sources healthy: codefuel 10:15, image_advantage 10:20, taboola 10:05, ddc 09:45,
  outbrain 09:44 — **zero failures since Outbrain recovered**.
- **The daily client report is LIVE**: `ddc/report` ran at **09:00 UTC (10:00 London)**, status ok.
  That is the first automated send to the client, and it also proves the new `cron.ts` is deployed.
- Pair ownership intact — both sample pairs still on the **enabled** campaign.
  Caveat: `outbrain_ads.updated_at` is still 09-17 03:15, so the 09-18 backfill never rewrote it
  (it died on the 401). The new ownership rule has therefore **not yet been exercised by cron**;
  the real test is the next successful 03:00 run.

**Bug in the watchdog I shipped yesterday — it would have spammed the client hourly.**
`checkSyncHealth` suppresses repeat alerts by looking for a recent `monitor`/`alert` row in
`sync_runs`, but **nothing ever wrote one**. The lookup could never match, so during an outage it
would email **every hour** — the exact "24 mails a day, gets filtered as noise" failure the
suppression was written to prevent, now aimed at the client's inbox. It now records the alert after
a successful send (after, so a failed send re-alerts rather than going silent).

**Possible live consequence:** `cron` is genuinely stale (last success 09-17 03:00 — yesterday's
backfill died on the bad password), so if the deployed watchdog ran at 09:50 with `ALERT_EMAIL_TO`
set, the client received a "Nightly backfill" alert, and would receive one hourly until 03:00.
Cannot be confirmed from the database: the deployed build has no alert-recording, and Resend exposes
no list endpoint.

**Action taken:** ran `daily-backfill` manually rather than suppressing the symptom — it is a true
positive, and a successful run makes `cron` fresh, stops any hourly alerting, and re-verifies every
source now that Outbrain works.
**Commit:** not committed

### 2026-09-18 — Sync alerting removed (operator decision)
Removed entirely at the operator's instruction: `reports/sync-health.ts` deleted, the `:50` cron job
and the `run-once sync-health` command dropped, and `ALERT_EMAIL_TO` taken out of `config/env.ts`,
`.env`, `.env.example` and `render.yaml`. `tsc` clean; no references remain anywhere.

Cron is back to its pre-watchdog schedule: taboola `:05`, codefuel `:15`, IA `:20`, outbrain `:25`,
DDC `:45`, **client report 10:00 Europe/London**, metadata every 2h, backfill 03:00.

**Consequence, recorded deliberately:** nothing now detects a stalled source. The 2026-09-17 Outbrain
outage ran for ~18 hours and the CLIENT reported it before we noticed; that exposure is back.
`sync_runs` still records every failure, so the check remains a query away —
`SELECT source, MAX(started_at) FILTER (WHERE status='ok') FROM sync_runs GROUP BY 1` — it is simply
no longer automatic.

*(A log-only variant — same staleness check, no email — would restore detection without any risk of
mailing the client. Not implemented; available if wanted.)*
**Commit:** not committed

### 2026-09-18 — Recovery complete and verified
**All seven sources healthy**, zero failures since 11:00: codefuel 11:15, cron 10:23, ddc 11:45,
image_advantage 11:20, image_advantage_x 11:06, **outbrain 11:36**, taboola 11:06.

**2026-09-17 fully restored:** 24/24 hours, spend **$2,291.28**, margin **21.9%** — in line with
09-16 (22.6%) and 09-15 (38.1%). Was $933.05 over 16 hours.

**The ownership rule survived a complete backfill.** `outbrain_ads` was rewritten at **10:53** by the
full `syncOutbrainPromotedLinks` inside the manual backfill, and the sample pair is still owned by
the **enabled** campaign. This is the test that had been outstanding since 09-15 — previous backfills
either failed on the 401 or never reached that step. *(Caveat: that run used the local build; the
deployed worker carries the same commits, and tomorrow's 03:00 is the deployed-code test.)*

**Self-inflicted hiccup, now resolved.** The 10:25 tick failed with `Outbrain /login rate-limited
(2/hour)` — the deploy wiped the worker's on-disk token cache while my manual backfill held the
credential, and between them the 2/hour cap was hit. Exactly the contention risk logged against
running two workers on one Outbrain credential, caused here by my own concurrent backfill. Transient:
the 11:25 tick succeeded on all three jobs.

**Campaign == Ads, 09-14..09-18, live API — 5 of 9 exact, revenue clean:**
- Revenue Δ **$0.00** on eight of nine filters; the exception is `gd=AP1009377` at **$0.23**.
- Spend Δ: outbrain $8.44, accounts $2.16/$5.28, statuses $0.05 — but **source=taboola $51.98**, which
  drags unfiltered to $43.54.
- The Taboola gap is **pre-existing** (logged at ~$52 on 09-15, before this outage) and sits on a
  $194.44 base — Taboola cost has been all but dead since August, so it is 0.45% of the $11.5k window
  in absolute terms while being large proportionally. Revenue is unaffected.

**Open, not chased:** the Taboola Campaign-vs-Ads spend gap ($51.98/$194.44) and the $0.23 revenue
delta under `gd=AP1009377`. Neither relates to the Outbrain outage.
**Commit:** not committed

### 2026-09-22 — CLAUDE.md brought up to date; git workflow changed to commit + push (ask first)
**What:** Rewrote the stale parts of `CLAUDE.md` — §1 (git workflow), §3 (API URL, env notes),
§7 (authoritative MV is `047`), §9 (actual cron table incl. DDC `:45`, the 10:00 London client
report, the three-pull Outbrain `:25` job, and the note that stale-source alerting was removed),
§12 (current state, open issues, next work). No code, migration or data changes.
**Why:** §12 still described a 69-commit local-only `master`, an unapplied `046`, and Milestone 3
as "paused". Reality: the repo was re-initialised on 2026-09-21 on `main` with a GitHub remote
(`origin`), `047` is applied, Milestone 3 is complete and live, and the next planned work is the
second ("Joe") dashboard in `docs/plans/joe-dashboard.md`.
**Operator instructions recorded:**
- Backend API is now served at **`https://nadiaapp.onrender.com`** (older entries in this file
  reference `nadia-api.onrender.com`).
- After any change, **commit everything** and **push to `origin` — but always ask the user first**,
  showing the commits that will go out. Deploys remain the user's job.
**Verified:** documentation only; `git remote -v` shows `origin` → `nauman-chaudhry/NadiaApp`,
`git log` shows `main` at `68bd683` with a clean tree before this change.
**Commit:** uncommitted — awaiting the user's go-ahead (this session was context-loading only).

### 2026-09-22 — README.md rewritten
**What:** Replaced the original phase-1 planning README (Facebook/Google/Media.net/Brightsync as
scope, "days 1–7" build phases, shadcn/Recharts) with a current overview: live URLs, the three
partners and how each attributes, stack, real repo layout (noting the root `db/` folder is a legacy
copy of 001–007), local-dev commands, the actual cron table, and status. Points to `CLAUDE.md` /
`TRACK.md` for depth. Docs only.
**Commit:** uncommitted — awaiting the user's go-ahead

### 2026-09-22 — Performance analysis (client: "dashboard slow to load"); plan written, nothing changed
**What:** Measured the live system end to end (API on Render, production DB, read-only) and wrote
`docs/plans/performance-plan.md`. **No code, migration, config or data change.**
**Measured (2026-09-22 08:50–09:05 UTC, 14-day window, all accounts):**
- Render free instance **cold start 22.8 s** after ~15 min idle; 0.5 s once warm.
- `/api/filters/options` **1.0 s warm → 2.1–6.1 s first hit**, 358 KB, runs on every page; its
  `DISTINCT country/device` scans of 340k `partner_stats_hourly` rows are the 2nd/3rd most expensive
  statements in `pg_stat_statements` history (4,563 + 1,728 + 2,835 calls).
- `/api/sync-status` 0.7 s warm → 3.5 s cold: seq scans `ad_stats_hourly` (1.1 s) and
  `partner_stats_hourly` ×3 — `MAX(fetched_at)` has no index.
- `campaign` 1.3 s; `daily`/`hourly` 0.4–0.6 s (DB exec <10 ms); `device`/`country`/`site` 2.2–2.9 s;
  `ads` **10.2 s** (637 KB); `ads` 90-day **120 s → 500**. pg_stat_statements: filtered Outbrain Ads
  variants average 25–49 s, max 96 s.
- `REFRESH MATERIALIZED VIEW joined_stats_hourly`: **6,789 calls, mean 15.2 s, max 55 s, 28.7 h of
  DB time since 22 May**; non-CONCURRENT (ACCESS EXCLUSIVE lock) and scheduled in 5 hourly jobs.
  EXPLAIN of the MV body: 17.4 s, **96 sort/hash spills** (`work_mem` 2 MB), worst CTE `ddc_cand`
  5.3 s (no index on `outbrain_ad_daily.promoted_link_uuid`).
- The `codefuel_orphan` per-row `LATERAL` (`gid`) costs ~2.1 s on device/country/site/ads-taboola
  and inside the MV: 1,767 iterations, 810,950 `campaigns_pkey` lookups for 14 days.
- Pool `idleTimeoutMillis` 30 s → TLS re-handshake to the Tokyo pooler after any pause; Supabase
  Micro (`shared_buffers` 224 MB) is smaller than the ~315 MB working set, so latency is erratic.
- Sync chatter: `INSERT INTO ads` 6.3 M single-row calls, `campaigns` 3.8 M, `outbrain_campaigns`
  292k — the `:25` Outbrain job runs ~7 min.
**Plan (in the doc):** Phase 0 infra (paid Render instance, warm pool, regions) → Phase 1 indexes +
hashed `gd_owner` CTE + cached options/sync-status + `SET LOCAL work_mem` (migration 048/049) →
Phase 3 frontend (revalidate, lazy campaign list, Suspense streaming, smaller Ads payload) →
Phase 2 non-blocking swap-table refresh, single debounced refresh, last-7-days incremental rebuild,
batched sync writes → Phase 4 daily rollups / partitioning for growth. Estimated: morning open
~30 s → ~2 s; tab switch 2–6 s → ~1 s; Ads 14d 10 s → ~3 s; 90-day Ads from failing to working.
**Not verified:** real browser timings (dashboard is auth-gated), Vercel function region, the
worker's Render plan.
**Commit:** see below — plan + this entry only.

### 2026-09-22 — Joe's accounts: access confirmed; already auto-registered in Nadia's DB (empty)
**What:** Nadia asked to confirm API access to Joe's 5 Outbrain and 5 Taboola accounts. Checked with
the worker's own credentials (read-only `allowed-accounts` / `marketers` calls). **No changes.**
**Confirmed:** Taboola shows a second network `Revlogic Media_4945 - Network` (2106794) with
`TDG - Revlogic Media_4945 - Adv1..Adv4, Adv 5 - SC` (2106795/2106797/2106798/2106799/2108187) —
IDs match her screenshot. Outbrain shows `SBH_rev_01..05`, all enabled. Hostinger not verifiable
from here.
**Found:** all 11 accounts are ALREADY rows in Nadia's `ad_accounts` (auto-registered by the metadata
jobs, `client_partner_id` NULL, visible under "Untagged"). Zero campaigns / zero cost today, so no
contamination yet — but it starts the moment Joe launches. The tenant filter in
`docs/plans/joe-dashboard.md` §A1 must ship before that. Also: Taboola hourly cost is pulled per
network via `TABOOLA_ACCOUNT_ID`, so Joe's deployment needs `revlogicmedia4945-network`.
**Also found:** new marketer `SBH_ssm_15_Codefuel` (id 20307), registered, untagged, no campaigns —
needs tagging like 044 once Nadia confirms it is Codefuel.
**Commit:** docs only.

### 2026-09-24 — DDC moved to a new domain (find247library.com, tmpl C253): verified, no code change needed
**Client:** Nadia paused DDC traffic on `startgonow.com` after an issue and relaunched 2026-09-23 on
`https://find247library.com/…/?amxt=blue&tmpl=C253&tt=…` on the same Outbrain account (SBH_ssm_09),
"same trackings as before"; asked for the dashboard to be updated.
**Checked (read-only, DDC API + our DB):**
- DDC reports the new domain as **`ob.find247library.com`** — the `ob.` prefix `platformForDomain`
  keys on, so it maps to Outbrain with no change. The only new-domain row so far (09-21, tag `null`,
  $0.00) is her own test click (`kw=shoes&ob_click_id=abc`, the exact URL she pasted).
- **27 new promoted links** on the new domain across **21 campaigns**, live from 09-23 ($30.29 spend,
  242 clicks by 09-24 morning), **all 27 carrying `tt=<34-hex>_{{publisher_id}}`** — same shape.
- The 03:00 backfill on 09-24 succeeded and `outbrain_ad_links` holds `tt_param` for **27/27**, so
  the `split_part` match and click-weighted allocation (046) apply to the new links unchanged.
- DDC has not published 09-22/09-23 yet (`report_type=date` shows 09-18..09-21 at $0.00 — the
  pause). The `:45` job is healthy (daily ok / 6 rows; hourly ok / 0 rows — feed empty until they
  publish). Revenue will appear on the same campaigns/ads automatically when it lands.
**Change:** comment in `sync/ddc.ts` documenting the domain history and the prefix-based rule. No
migration, no data change, no deploy needed.
**Also in the same thread, not done here:** (1) ads.txt for Joe's 5 IA sites — files are in
`~/Downloads/untitled folder` (one per domain, each a placeholder line + `subdomain=flux.<domain>`);
all five domains currently return **404** for `/ads.txt`. Uploading is a Hostinger hPanel/FTP action
for the operator, then verify with `curl -I https://<domain>/ads.txt`. (2) Joe's dashboard + admin
access for Nadia and Joe — see `docs/plans/joe-dashboard.md`; the app has no roles, "admin" =
a Supabase Auth user invited to Joe's project.
**Commit:** below.

### 2026-09-24 — Joe's dashboard: Supabase project provisioned and migrated (001–047)
**What:** User created a second Supabase project for Joe (`glrxjjnaogkuahhafgth`, region
**ap-south-1** / Mumbai). Applied all 48 migration files against it with
`DATABASE_URL=<joe> npx tsx src/db/migrate.ts` (host verified as `aws-0-ap-south-1` before running —
Nadia's is `ap-northeast-1`). Credentials live in the gitignored `backend/.env.joe`
(`.gitignore` now excludes `.env.*` except `.env.example`, commit `7f2bf11`).
**Verified on Joe's DB:** `_migrations` = 48, last `047`; 20 tables; `joined_stats_hourly` exists
and is populated (0 rows); `platforms` 4, `client_partners` 6 (codefuel, image_advantage, media_net,
brightsync, outbrain, ddc); `ad_accounts`/`campaigns`/`partner_stats_hourly`/`app_users`/`sync_runs`
all 0; `on_auth_user_created` trigger present. Migrations 031/040/044/045 are UPDATEs and were no-ops
on the empty tables, as intended.
**Notes for the rest of the build:**
- Frontend keys: Supabase issued a new-format `sb_publishable_…` key; the code reads it under
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` — set it in Vercel under that name.
- Render services for Joe should go in **Singapore** (nearest Render region to ap-south-1).
- `app_users.role` (`admin`/`viewer`, migration 003) exists but the app enforces nothing; "make
  Nadia and Joe admins" = invite both in Supabase Auth, then `UPDATE app_users SET role='admin'`.
- Still needed from Nadia: IA affiliate names for his 5 sites, launch date, IA-only confirmation,
  optionally a second Outbrain API user, Joe's email. Message sent 2026-09-24.
**Next:** tenant filter + `ENABLED_SOURCES` code (needs nothing from anyone), dry-run on Nadia's data.
**Commit:** below (TRACK only — no code yet).

### 2026-09-24 — Tenancy built: per-deployment account/affiliate filters + ENABLED_SOURCES (not deployed)
**What:** The mechanism from `docs/plans/joe-dashboard.md` §2/§A1, so one repo can be deployed once
per client without the shared partner credentials leaking accounts across dashboards.
**Files:** NEW `backend/src/config/tenant.ts`, `frontend/lib/brand.ts`. MODIFIED `config/env.ts`
(new vars; Codefuel/IA creds optional but required-at-boot when their source is enabled),
`sync/outbrain.ts` (`tenantMarketers()` replaces all 6 `listMarketers()` calls), `sync/taboola.ts`
(account filter at discovery), `sync/imageadvantage.ts` (affiliate filter on y- and x-metrics rows),
`sources/codefuel/client.ts` + `sources/imageadvantage/client.ts` (clear error if creds missing),
`workers/cron.ts` (`scheduleFor(source, …)` — jobs for disabled sources are not scheduled, logged
at boot), `workers/daily-backfill.ts` (per-step source gate, `skippedSteps` in the done log),
`workers/run-once.ts` (`tenant-check`, `tenant-prune [--apply]`), `render.yaml`, both
`.env.example`s, frontend branding (`NEXT_PUBLIC_APP_NAME` / `_EXPORT_PREFIX` / `_DEFAULT_ACCOUNT`),
`CLAUDE.md` §13.
**Design correction vs the plan:** discovery-only filtering is enough for Taboola (everything keys
off `ad_accounts`) but NOT for Outbrain — `syncOutbrainCost/Ads/Country/Publisher/MarketerHourly`
each list marketers from the API and would have written Joe's spend into Nadia's cost tables. The
rule therefore sits on the marketer listing itself. IA needed its own affiliate rule: the unfiltered
feed would otherwise put the other tenant's revenue in this tenant's "Unattributed — IA" row.
**Verified (read-only against live APIs/DB, both backends `tsc` clean, frontend `tsc` clean):**
- Boot guard: `codefuel` enabled with blank creds → exits 1 with a named message.
- `tenant-check` with Nadia's rule (`EXCLUDE=^SBH_rev_|Revlogic Media`): keeps her 14 Taboola
  accounts + 15 Outbrain marketers (incl. new `SBH_ssm_15_Codefuel`), skips exactly Joe's 11.
- `tenant-check` as Joe's worker (`INCLUDE=…`, `ENABLED_SOURCES=taboola,outbrain,image_advantage`):
  keeps exactly the 11; codefuel/ddc off. IA affiliates all still KEEP because no affiliate rule
  exists yet — **Joe's worker must not run IA until `TENANT_IA_AFFILIATE_INCLUDE` is set** (or IA is
  left out of his `ENABLED_SOURCES`), and Nadia's needs the matching EXCLUDE.
- `tenant-prune` dry run on Nadia's DB: the 11 auto-registered Joe accounts are all empty and
  deletable; nothing with data is touched. **Not applied** — must follow the worker deploy, or the
  old code's 2-hourly metadata job re-registers them.
**Unset rules = allow everything**, so Nadia's deployment is byte-for-byte the old behaviour until
`TENANT_ACCOUNT_EXCLUDE` is set on her worker.
**Deploy sequence:** (1) push; (2) Nadia's WORKER with `TENANT_ACCOUNT_EXCLUDE=^SBH_rev_|Revlogic
Media` (API can redeploy too; no migration); (3) run `tenant-prune --apply` on Nadia's DB; (4) create
Joe's Render API + worker (Singapore) and Vercel project with the env in `CLAUDE.md` §13 + `.env.joe`.
**Commit:** below.

### 2026-09-24 — IA tenant rule settled without affiliate names (`^ssm\.`)
**What:** Nadia has not created Joe's IA affiliates yet, but all 16 IA affiliates ever seen in the
feed are `ssm.<product>.<vertical>.<platform>` and she confirmed Joe's "will be similar build but
different from ssm". So: Nadia's worker `TENANT_IA_AFFILIATE_INCLUDE=^ssm\.`, Joe's worker
`TENANT_IA_AFFILIATE_EXCLUDE=^ssm\.`. No code change; docs/env templates updated. Joe's worker can
therefore run `image_advantage` from the first deploy. Residual risk: a future Nadia affiliate not
prefixed `ssm.` would route to Joe — flagged to her.
**Nadia also confirmed:** Outbrain and Taboola will NOT issue a second API key. Shared credentials
stay; the only consequence is the Outbrain `/login` 2-per-hour limit across two workers
(proposal: DB-backed token cache, not yet approved).
**Commit:** below.

### 2026-09-24 — Outbrain token moved to the database (migration 048); Joe deploy checklist
**Why:** Outbrain will not issue a second API credential (Nadia, 2026-09-24), so Nadia's and Joe's
workers share one. `/login` is limited to 2 calls/hour and the token lived only in
`.cache/outbrain-token.json` on Render's ephemeral disk, so every deploy/restart forced a login —
two redeploys in one hour would 429 the loser's Outbrain jobs (the 2026-09-18 incident was this
with one worker + a manual backfill).
**What:** `048_app_settings.sql` (key/value table). `sources/outbrain/client.ts` gets a pluggable
`OutbrainTokenStore` (stays HTTP-only); `sync/outbrain.ts` installs the DB-backed store at import,
so cron/backfill/run-once are all covered. Lookup: memory → DB → file → login; a token found only in
the file is copied into the DB so an existing deployment migrates without logging in; a missing
table (worker deployed before the API migrated) logs a warning and falls back to the file.
**Applied:** 048 on Nadia's DB and on Joe's DB. **Verified:** first Outbrain call through the sync
path logged `seeded token store from file cache` and `app_settings.outbrain_token` now holds the
2026-09-18 token (508 chars); the second call read it from the DB with no seed and no login. Joe's
DB has the table and no token (his worker logs in once on first boot). `tsc` clean.
**Also:** `docs/plans/joe-deploy-checklist.md` — operator runbook with the final env lists and
`<PLACEHOLDER>`s for Joe's Render/Vercel URLs, both login emails and the Hostinger access.
**Deploy:** ride with the tenancy commit — API (no-op migrate, 048 already applied) + worker.
**Commit:** below.

### 2026-09-24 — Critical review of Joe's dashboard; launch blockers identified, no fixes applied
**What:** Reviewed the tenancy/token-cache build, frontend/auth/reporting flows, ingestion and
onboarding, current MV, configuration, and project history. Report:
`docs/reviews/2026-09-24-joe-dashboard-critical-review.md`.
**Critical live finding:** both databases grant `anon` SELECT/UPDATE on `app_settings`, `app_users`,
`ad_accounts` and `partner_stats_hourly` with RLS disabled; the MV grants anonymous SELECT too.
Public-key REST GETs with no user session returned 200 for setting names/account IDs in both
projects (Nadia returned existing rows; Joe is empty). Token VALUES were not requested; write
privileges were inspected, never exercised. Migration 048's Outbrain token store is consequently
exposed once populated. Existing Express reporting endpoints also have no auth.
**Joe-specific gaps:** Flux fetches only nine hardcoded `ssm.*` affiliates, then Joe's exclude
rule drops all of them; missing IA account tagging hides project/feed UI and causes the MV's
inner-joined Taboola IA orphan path to drop unmatched revenue; missing rules allow all ingestion,
and Joe's IA exclusion accepts unknown/blank affiliates; manual recovery jobs bypass source gates.
**Further findings:** inherited misleading All Sources hourly aggregation, global freshness hiding
partial outages, tab navigation dropping filters, and `ENABLE_CRON='false'` parsing as true.
**Verified:** backend/frontend no-emit TypeScript checks passed. Mocked execution of actual IA
client plus Joe tenant predicate requested nine Nadia affiliates and kept zero rows. Installed
Zod coercion reproduced. READ ONLY SQL confirmed both DBs at 048; Joe has 0 accounts and 0
partner rows, so real Joe financial reconciliation remains unverified. No live sync, migration,
email, deployment or production write; no application changes. User requested analysis/reporting,
so fixes were documented rather than applied.
**Commit:** documentation-only review commit; not pushed.

### 2026-09-25 — Security fixes from the 2026-09-24 critical review (findings 1, 2, 9)
**1. Anonymous DB access closed — migration `049_lock_down_public_schema.sql`.** Revokes ALL on every
table/sequence/function in `public` from `anon` and `authenticated`, and changes the `postgres`
role's DEFAULT PRIVILEGES so future tables and every re-created MV stay closed. The app never used
PostgREST (frontend = Supabase Auth only; data via the Express API + `pg`), so nothing legitimate
loses access. **Applied to both DBs.** Verified live: `GET /rest/v1/{app_settings,ad_accounts,
joined_stats_hourly,app_users}` with the public key → **401 `42501`** on both projects (was 200).
The Outbrain token that sat readable in `app_settings` was NOT rotated — a new login does not
invalidate the old token; only a password change does. Decision for the operator/Nadia (see below).
**2. API authentication — `server.ts`.** Every `/api/*` route now requires `Authorization: Bearer
<Supabase access token>`; verified against THIS deployment's project (`SUPABASE_URL` +
`/auth/v1/user`) and the user must exist in `app_users` (created by the signup trigger = invited).
5-min positive / 1-min negative in-memory cache. Fails CLOSED in production without
`SUPABASE_URL`/`SUPABASE_ANON_KEY`; `API_AUTH_DISABLED=true` for local dev only. Frontend server
components pass the session token (`lib/api.ts` + `getAccessToken()` in `lib/supabase/server.ts`);
no client component calls the API directly. Login now uses `shouldCreateUser: false` (invite-only
regardless of the hosted signup setting). Verified locally: `/health` 200; no token / bogus token /
the anon key as token → 401. A real session was not exercised (needs a browser login) — **the first
deploy must be checked in the browser**, and `SUPABASE_URL`/`SUPABASE_ANON_KEY` must be set on the
API service BEFORE deploying it or it will refuse to start.
**9. `ENABLE_CRON` parsing.** `z.coerce.boolean()` made `'false'` → `true`. Replaced with a strict
true/false/1/0/yes/no parser (also used for `API_AUTH_DISABLED`). Verified: `ENABLE_CRON=false`
now exits with "worker exiting without scheduling jobs".
**Also:** `ENV_FILE=<file>` selects the env file (default `.env`) so a second tenant's local runs
never inherit the first tenant's credentials from `.env` (review finding 6, part 1). `.env.joe`
now carries the full Joe configuration (21 keys, gitignored).
**Deploy:** API (049 already applied; needs the two new env vars first) + worker + frontend.
**Open decision:** rotate the shared Outbrain password (invalidates the previously exposed token;
needs the new password on both workers' env) — recommended, but it is Nadia's credential.
**Commit:** below.

### 2026-09-25 — Tenancy hardening from the critical review (findings 3, 5, 6 + token single-flight)
**3. Joe's Flux revenue is now requested.** `fetchIAXByUsertag(date, affiliates)` takes the list;
`syncXMetricsDaily` builds it as historical `IA_TB_AFFILIATES` ∪ `IA_X_AFFILIATES` (env) ∪ every
`.tb` affiliate seen in that day's unfiltered y-metrics feed, then applies the tenant rule. Joe's
affiliates surface in y-metrics first, so they are picked up without a code change.
**5. No permissive defaults in production.** `tenant.ts`: with `NODE_ENV=production` the process
refuses to start unless an account rule is set (and an IA affiliate rule when image_advantage is
enabled), or `TENANT_ALLOW_ALL=true` states the intent. Rules now match the display name OR the
platform id (Taboola `account_id`, Outbrain marketer id) so accounts can be pinned by id. Blank
affiliates are rejected (quarantined as skipped). `TENANT_DEFAULT_PARTNER` tags newly discovered
accounts on first insert only (Joe = `image_advantage`; unset for Nadia — manual tags untouched);
`run-once tenant-tag <code> [--apply]` tags existing untagged accounts this deployment owns.
**6. Manual commands honour ENABLED_SOURCES.** Every `run-once` job maps to a source and refuses to
run when it is disabled; `refresh-all`/`sync-day` skip disabled sources; `backfill-full` requires
taboola+codefuel. Each run logs a preflight line (target DB host, `ENV_FILE`, tenant rules).
**Token:** concurrent logins are single-flighted in the Outbrain client (the `:25` tick's three
pulls after a cold start share one login).
**Verified:** `tsc` clean. `NODE_ENV=production` without rules → exits with the named message;
`TENANT_ALLOW_ALL=true` runs. `ENV_FILE=.env.joe tenant-check` → preflight names Joe's DB, keeps
exactly his 6 Taboola + 5 Outbrain accounts (ids printed), codefuel/ddc off. `ENV_FILE=.env.joe
codefuel-hourly …` → "source 'codefuel' is disabled … refusing to run". `tenant-tag image_advantage`
dry run on Joe's empty DB → 0. **Consequence for Nadia's deploy:** her worker AND API now need
`TENANT_ACCOUNT_EXCLUDE` + `TENANT_IA_AFFILIATE_INCLUDE` set before the next deploy or it exits at
boot. (The API does not load `tenant.ts` — only the worker and `run-once` do — so the API is not
affected; setting the vars on both services is still recommended for consistency.)
**Commit:** below.

### 2026-09-25 — Migration 050: unmatched IA/DDC revenue survives with no tagged account (review finding 4)
**What:** `050_mv_orphans_survive_without_account.sql` — a copy of 047 with ONE change: the
`ia_orphan` and `ddc_orphan` account laterals are `LEFT JOIN LATERAL`. With the inner join, a
deployment with no account tagged for the partner silently dropped every unmatched IA/DDC row from
the view (revenue vanished rather than showing as unattributed). Now such rows keep
`ad_account_id NULL`, like the Codefuel orphan branch. The API's `-1`/`-8` branches already resolve
the same account via a scalar subquery that yields NULL in that case, so Campaign == Ads holds.
**Applied to both DBs.** Verified on Nadia's (all her IA/DDC accounts are tagged, so no row can
change): totals before/after identical — see the two lines logged in the session (rows, spent,
revenue, flux all equal; 0 orphan rows with a NULL account before and after). Joe's MV rebuilt,
0 rows. Also: onboarding for a single-partner tenant no longer depends on remembering to tag —
`TENANT_DEFAULT_PARTNER` (batch B) tags on discovery, and 050 is the safety net if it is unset.
**Commit:** below.

### 2026-09-25 — Frontend/API semantics from the critical review (findings 7, 8 + product notes)
**Tabs keep filters.** `NavTabs` now carries the query string across tabs (dates, account, source,
feed, campaign, status, GD), dropping only the tab-specific `country`/`device` params; wrapped in
`Suspense` in the layout. Switching Campaign → Ads no longer resets the comparison.
**Hourly is honest.** The MV-backed Hourly view (All Sources, Taboola, or Outbrain + campaign filter)
now excludes the MV's Outbrain rows, which are daily totals stamped at 00:00 and used to appear as
an hour-0 spike. Notes say so and point at Traffic Source = Outbrain (account-level hours) or the
Daily tab. Under Outbrain Hourly the Status and GD controls are hidden (account-level data cannot
honour them). Verified locally over 7 days: all-sources hour-0 share of spend dropped from the
inflated figure to Taboola's normal share; source=outbrain unchanged.
**Freshness per source.** `/api/sync-status` now returns `enabled_sources`, per-source
`last_success` (last run with status ok, from `sync_runs`) and `stale` (> 3 h), and includes
Outbrain, which was missing entirely. The header shows the WORST enabled source and names stale
ones ("… — Outbrain cost behind"); the tooltip lists every source. A healthy metadata tick can no
longer make a 17-hour Outbrain outage look fresh.
**Tenant-aware notes.** DDC-specific explanations render only where a DDC account exists.
**Not done (noted):** server default dates are UTC while browser presets use local dates; FilterBar
does not resync state on navigation. Both minor; logged for later.
**Commit:** below.

### 2026-09-25 — Docs brought to one current state after the review fixes
`CLAUDE.md` §3 (API auth), §12 (050 applied on both DBs; review findings 1–9 fixed, not deployed;
Joe status), §13 (production-required rules, name-or-id matching, default partner, Flux discovery,
`ENV_FILE`); `docs/plans/joe-deploy-checklist.md` rewritten with the final env lists for all four
services, the browser check after deploy, the acceptance gate on real Joe data, and the password
decision; `docs/plans/joe-dashboard.md` header; `render.yaml` comments; resolution status prepended
to the review. **Deploy needed (Nadia): worker + API + frontend together** — the API now requires
`SUPABASE_URL`/`SUPABASE_ANON_KEY` and the worker requires the two `TENANT_*` rules, or they exit at
boot; the frontend sends the token the API now demands.
**Commit:** below.

### 2026-09-25 — Nadia's services deployed with tenancy + API auth; Joe's accounts pruned from her DB
**Deploy verified live (after the user deployed worker, API and frontend together):** `/health` 200;
every `/api/*` route → `401 Unauthorized` without a session token (proves the new API build);
`/dashboard/*` → 307 to `/login` when logged out; user confirmed the dashboard works after login.
Worker: every hourly job ran on schedule through the deploy (Codefuel 08:15, IA 08:20/09:20,
Outbrain 08:25–08:27, DDC 08:45, Taboola 09:05 — all `ok`); the Outbrain token was reused from the
DB store (no login). User confirmed the worker logs the tenant rules.
**Prune applied:** `tenant-prune --apply` with Nadia's rules deleted the **11** empty Joe accounts
(`SBH_rev_01..05`, `Revlogic Media_4945 - Network`, `TDG - Revlogic Media_4945 - Adv1..Adv 5`) from
her `ad_accounts`; 0 remain, 34 accounts total. They cannot come back: the worker's exclude rule
skips them at discovery.
**Found while checking:** DDC's HOURLY feed (`yss_current_day`) has returned 0 rows every tick since
~09-21 — before the domain switch — while the daily report works (09-23 = $16.35 on
find247library.com). The 10:00-London client CSV has therefore refused to send for 4 mornings
(09-22..09-25, "no rows — not sending an empty file", by design). Not a code defect; Nadia asked
to raise it with DDC. Dashboard daily/campaign figures unaffected; Hourly/Device for DDC empty.
**Joe's Render/Vercel:** deliberately left for later (user).
**Commit:** below.

### 2026-09-25 — Joe's stack live: API `https://joeapi.onrender.com`, dashboard `https://joe-dashboard-two.vercel.app`
**Verified live:** API `/health` 200, `/api/*` → 401 without a token, CORS already set to the Vercel
URL; frontend `/login` 200. Worker running the hourly jobs on schedule (all `ok`, 0 rows) and it
had already done its single Outbrain login and stored the token in Joe's `app_settings`.
**First backfill run by hand** (`ENV_FILE=.env.joe … daily-backfill`): 17 steps ok, 1 transient
failure on `taboola-metadata`, which succeeded on an immediate rerun. Result: **11 accounts**
registered (SBH_rev_01..05; Revlogic Media_4945 network + Adv1..Adv 5), **all auto-tagged
`image_advantage`** by `TENANT_DEFAULT_PARTNER`. Codefuel and DDC steps skipped by
`ENABLED_SOURCES`. Tenant filter logs confirm only Joe's marketers/affiliates were requested.
**Why the dashboard is empty:** Joe has **0 campaigns** on every account (Taboola and Outbrain), so
there is no cost, no revenue and an empty MV. Nothing to fix; the 2-hourly metadata job and the
hourly cost/revenue jobs fill it as soon as campaigns exist. `app_users` has 1 row (a first login).
**Local files:** `backend/.env.joe.api` / `.env.joe.worker` (gitignored) hold the uploaded env sets;
checklist updated with both URLs. Still open: Joe's email + admin roles, ads.txt renames, Outbrain
password decision, acceptance gate once he trades.
**Commit:** below.

### 2026-09-25 — Joe: admin role set, ads.txt verified on all five domains
- `app_users` on Joe's DB: `nauman1029@gmail.com` → `admin` (first login was 17:36 UTC — before the
  17:45 backfill, which is why the account dropdown looked empty; a reload shows the 11 accounts).
  `nadia777solutions@gmail.com` is not yet a user on Joe's project — must be invited in Supabase
  Auth (signups are off); role set after her first login.
- ads.txt: all five of Joe's domains now return 200 with the correct `subdomain=flux.<domain>` line.
- Outbrain password rotation: operator decided NOT to rotate (no second key available; shared
  credential stays as is).
**Commit:** below.

### 2026-09-25 — Joe: Nadia invited and made admin; SMTP note; client informed
- Inviting Nadia on Joe's Supabase project first failed with **429** on `/auth/v1/invite`: the
  project was on Supabase's built-in mailer (≈2 emails/hour, unreliable to outside addresses).
  Fixed by the operator enabling **custom SMTP via Resend** (`smtp.resend.com:465`, user `resend`,
  password = `RESEND_API_KEY`, sender `nadia@revlogicmedia.com`) on Joe's project — the same
  Resend account that delivers the DDC report. Invite then succeeded at 18:12 UTC.
- `app_users` on Joe's DB: `nadia777solutions@gmail.com` → **admin** (row created by the signup
  trigger on invite, so the role was set before she accepted). Both admins now set.
- Client told: Joe's dashboard live, both admins set, awaiting Joe's email; ads.txt live on all
  five sites; DDC hourly feed empty since ~21 Sep (raised for her to chase with DDC).
- Worth doing on Nadia's own project too: check Project Settings → Authentication → SMTP; if it is
  on the built-in mailer, her magic-link logins share the same 2/hour limit.
**Commit:** below.
