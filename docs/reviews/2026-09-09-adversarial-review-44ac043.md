# Adversarial verification of commit 44ac043 — 2026-09-09

Independent review. Read-only against live prod (SELECTs + one read-only Codefuel API call).
Local API (`npm run dev:api`) against the live DB. Window used throughout: **2026-08-25 .. 2026-09-08**.
Migration state confirmed: `_migrations` tops out at `046_mv_ddc_tt_normalize_window.sql` (046 IS applied).

---

## Verdicts

### C1 — dropdowns now offer Outbrain campaigns/GDs; target campaign resolves — **CONFIRMED**
`GET /api/filters/options`: campaigns **4263** (556 of them 34-char hex = Outbrain), gds **41**,
accounts 33, statuses 4. `001e45713998339de4317025ace06d9cac` ("US-IT Best Management Software- 3 Sept")
is present with `id: null, external_id` set.
MV cross-check for that campaign over the window: `spent 65.7800`, `revenue 44.0741`, 6 rows —
**matches the claimed 65.78 / 44.07 exactly**.

### C2 — GD filter was inert, now bites, campaign-scoped — **CONFIRMED (semantic defensible, but not applied consistently — see F3)**
- MV `gd_param` is NULL on **2791/2791** rows since 2026-08-25, so filtering `gd_param` on the MV was
  genuinely impossible. Campaign-scoping is the only workable semantic. Justified.
- Multi-GD campaign counts reproduce **exactly**: Taboola 3315 one-GD / **60** two-GD;
  Outbrain 149 one-GD / **1** two-GD. (61 total, as claimed.)
- GD now filters: campaign view `AP1009380` → 15 rows / $494.38 / $447.85 vs unfiltered
  321 rows / $35,911.66 / $45,548.13.
- **BUT** the semantic is campaign-scoped on campaign/daily/hourly/ads and `asset_gid`-scoped on
  country/device/site (`server.ts:1763`). Those two do not agree — see **F3**.

### C3 — Campaign total == Ads total under GD × source × feed × account × status — **REFUTED**
28 combinations run comparing `totals.spent` / `totals.revenue` from `view=campaign` vs `view=ads`.
**4 matched, 24 did not** (tolerance $0.005). Three distinct failure classes — F1, F2, F4 below.
The claimed "20/20" does not survive stricter comparison or harder combinations.

### C4 — no regression — **PARTIAL**
Unfiltered / account / status / source / feed totals are all self-consistent with the MV and no
query regressed. But country/device/site are now reachable with a GD filter that changes the row
count without changing the money (F3), and `sites` comes back as an **empty array** from
`/api/filters/options` (pre-existing, not caused by this commit, but the Site tab's filter is unusable).

### C5 — Codefuel cron fix — **PARTIAL (diagnosis right, two numbers wrong)**
- The cron change is exactly as described (`workers/cron.ts:72-83`): yesterday + today, each in its
  own `attempt()`, then one MV refresh. Correct and mirrors the IA job.
- "Nothing was ever lost" — **holds historically**: 09-02..09-06 each have all 24 hourly rows.
- "We hold exactly what Codefuel offers" — **REFUTED as of now.** Read-only
  `fetchHourlyPerformance('2026-09-08'..'2026-09-09')` at **05:57 UTC** returned
  09-07 = 24h, **09-08 = 24h (h0..h23)**, **09-09 = 3h (h0..h2)**.
  Our DB holds 09-08 = **23h (max h22)** and **zero rows for 09-09**.
  **$29.78 of Codefuel revenue is offered by their API and absent from our DB right now**
  (09-08 h23 = $4.83; 09-09 h00 = $10.54, h01 = $7.67, h02 = $6.74).
  This is the OLD code's behaviour — `sync_runs` shows the live worker's 05:15 run wrote 0 rows —
  so it validates that the fix is needed; it does not validate "nothing is behind".
- "Codefuel publishes ~6h late" — **measured ~3h**, not ~6h. At 05:57 UTC hour 02:00-03:00 was
  already published. The fix is still correct at 3h latency; only the stated figure is off ~2x.

---

## Defects

### F1 — CRITICAL — 500 error on the Ads tab whenever GD **and** Campaign are both selected (Outbrain)
`backend/src/api/server.ts:1283, 1314, 1344, 1379`

`campWhere` is now built with `+=` (`:896` for gd, `:901` for campaign_id), so it can contain **two**
occurrences of `c.ob_camp_id`. All four consumers rewrite it with a **non-global string** replace —
`campWhere.replace('c.ob_camp_id', 'ia.ob_camp_id')` — which replaces only the **first** occurrence.
The second clause is emitted still referring to alias `c`, which does not exist in the `ia_camp_rev` /
`ddc_camp_rev` / `cf_camp_only` / `al2` subqueries.

Note the adjacent `obStatusWhere` lines correctly use a **global regex** (`/c\.ob_camp_id/g`). Only
`campWhere` uses the string form. Before this commit `campWhere` was assigned with `=` and could hold
at most one occurrence, so **this commit introduced the bug**.

Reproduction (live, local API):
```
GET /api/stats?view=ads&source=outbrain&from=2026-08-25&to=2026-09-08
    &gd=AP1009380&campaign_id=001e45713998339de4317025ace06d9cac
-> HTTP 500 {"error":"Internal error"}
API log: DatabaseError 42P01 'missing FROM-clause entry for table "c"' (position 21547)
```
Also fails without `source` (all-sources Ads runs both builders):
```
GET /api/stats?view=ads&from=...&gd=AP1009380&campaign_id=00444207ead78f630ba0290c9d22300e2a -> 500
```
Impact: this is precisely the workflow Nadia reported — pick a GD, then pick a campaign. The Campaign
tab returns $138.64 / $149.84; the Ads tab hard-errors. Fix: use `/c\.ob_camp_id/g` in all four places.

### F2 — MAJOR — Campaign ≠ Ads by $200.88 under an account filter (pre-existing, not introduced here)
Isolated to **account 239 (SBH_ssm_05, image_advantage)**:
```
&account_id=239  -> Campaign $15,423.75 / $23,163.26 ; Ads $15,424.00 / $22,962.38   (Δrev -200.88)
&account_id=243  -> Δrev 0.00
&account_id=3971 -> Δrev 0.00
&account_id=243,239,3971 -> Δrev -200.89
&account_id=243,239,3971&source=taboola -> Campaign 2 rows / $200.88 ; Ads 0 rows / $0.00
```
The money is the MV row `campaign_external_id = NULL`, `campaign_name = '(Unattributed revenue — Image
Advantage)'`, `ad_account_id = 239`, `source_platform = NULL`, 340 rows, $200.8828. Unfiltered the Ads
tab picks it up via the `cf_key` orphan bucket (-2) — the documented "cf_key has no client_partners
join" landmine — but under an account filter that bucket is excluded and the revenue vanishes.
Not caused by 44ac043 (no GD involved; the diff's only no-GD change is `AND FALSE`→`AND TRUE`), but it
breaks Nadia's #1 invariant today and was missed by the 20/20 check.

### F3 — MAJOR — Country/Device tabs report the SAME $200.88 for **every** GD, including GDs worth $0
`backend/src/api/server.ts:1763` still scopes GD as `p.asset_gid = ANY(...)`, while the MV views and
Ads scope it to campaigns. Because the whole current content of those tabs is the IA-unattributed
orphan bucket (which carries no GD), the filter changes the row count but never the money:
```
gd=AP1008139 -> campaign 0 rows/$0.00 | ads 0/$0.00 | country 1 row/$200.88 | device 1/$200.88 | site 0/$0.00
gd=AP1009251 -> campaign 0 rows/$0.00 | ads 0/$0.00 | country 1 row/$200.88 | device 1/$200.88 | site 0/$0.00
gd=AP1009380 -> campaign 15/$447.85  | ads 47/$447.85 | country 1/$200.88   | device 1/$200.88   | site 0/$0.00
```
So Nadia can pick a GD that shows $0.00 on Campaign and $200.88 on Country. Site behaves differently
again (drops it to $0.00), so the three "detail" tabs do not even agree with each other. Two GD
semantics in one product is the underlying defect; at minimum it should be documented and made
consistent.

### F4 — MINOR — persistent $0.19–$2.01 spend gap between Campaign and Ads (pre-existing)
```
unfiltered       Campaign $35,911.66  Ads $35,913.67   Δ -2.01  (0.0056%)
gd=AP1009380     Campaign    $494.38  Ads    $494.57   Δ -0.19
gd × 3           Campaign  $2,155.42  Ads  $2,156.04   Δ -0.62
status=enabled   Campaign $24,498.44  Ads $24,500.44   Δ -2.00
```
Revenue matches to the cent in all of these; only spend drifts, consistent with share-based allocation
rounding in the Ads builder. Present unfiltered, so it is not introduced by the GD change — but it
means "Campaign == Ads" is only true to ~$2, and the GD-filtered cases inherit it.

### F5 — MINOR — `/api/filters/options` payload is 341 KB, campaigns unbounded
Measured **341,217 bytes**, 4263 campaigns with no LIMIT. The `gds` LIMIT 500 is not a problem today
(41 rows) and won't be soon. The campaign list is the real growth risk; it is fetched on every
dashboard load. Not urgent, but a typeahead endpoint would be the right shape.

---

## Things I checked and found NOTHING wrong with

- **D1 parameter indices (Taboola side).** `pArgs.push()` returns the new length, which *is* the `$N`
  index for the value just pushed, so placement order inside the template literal is irrelevant.
  `accClause` → `campClause` (campaign_id then gd) → `statClause` all bind correctly. `pArgs.length = 2`
  at `:2113` is reached only on the ads path (every other view returns earlier). Verified empirically:
  `gd=AP1009380` returns $494.38 and `gd=AP1008139` returns $0.00 — different GDs give different
  answers, so no off-by-one silently filtering the wrong value.
- **D1 (Outbrain `oa9` aliasing).** The `oa9` alias does protect the subquery internals from the
  `.replace()` rewrites. That part of the design is sound; the bug (F1) is the non-global replace,
  not the alias.
- **D2 double-counting after removing `AND ${p.gd ? 'FALSE' : 'TRUE'}` from the -3 branch.** No
  double-count. With no GD it was always `AND TRUE`; with a GD it is now scoped by the same
  `campClause` as the other two branches, and the branch's `NOT EXISTS` guards still exclude
  cf/ia-covered campaigns. Revenue matches to the cent under every GD combination; the only residual
  drift is the pre-existing spend rounding of F4.
- **D3 `obFiltered` becoming TRUE under a GD-only filter.** Correct. It suppresses the -6 unattributed
  Outbrain branch, and the MV side suppresses the same money because those rows have
  `campaign_external_id IS NULL` and the new GD predicate is an `IN (...)` that cannot match NULL.
  Both sides drop it together, so nothing is lost relative to the Campaign tab. (For scale: 367 MV
  rows / $742.38 revenue / $0 spend in the window sit behind a NULL `campaign_external_id`.)
- **D4 performance.** No regression — the GD filter makes every view *faster*, and every view is far
  under the 2-minute statement timeout:

  | view | no filter | gd × 1 | gd × 5 |
  |---|---|---|---|
  | campaign | 1432 ms | 177 ms | 184 ms |
  | daily | 220 ms | 178 ms | 187 ms |
  | hourly | 198 ms | 176 ms | 179 ms |
  | ads | 2404 ms | 762 ms | 737 ms |
  | device | 353 ms | 322 ms | 402 ms |
  | country | 293 ms | 236 ms | 242 ms |
  | site | 299 ms | 171 ms | 170 ms |

  Slowest observed anywhere in the whole sweep: `view=ads` unfiltered at **6.3 s** (feed=flux run).
  No 97-s-style regression.
- **D6 multi-GD campaigns.** 61 campaigns (60 Taboola + 1 Outbrain) carry two GDs, and under
  campaign-scoping selecting one GD does show the other's revenue for those campaigns. But the
  *dollar impact is presently zero*: Taboola has had no cost/stat rows since 2026-07-07 (known
  upstream issue), and the single two-GD Outbrain campaign contributes nothing to the window's
  totals — the sum over each GD in isolation reconciles against the multi-GD queries
  (AP1009380 $447.85 + AP1009379 → AP1009380,AP1009379 $1,064.36, no inflation).
  **Acceptable as designed**, but it is latent: it will start double-showing revenue the moment
  Taboola resumes and a two-GD campaign earns. Worth a note in the UI or in CLAUDE.md, not a blocker.

---

## Not verified / out of scope

- **Whether F2 and F4 pre-date 44ac043 was established by reading the diff, not by running the parent
  commit.** The reasoning is solid (with `p.gd` absent the new code emits byte-identical SQL apart from
  `AND FALSE` → `AND TRUE`), but I did not rebuild and run `230618e` to prove it empirically.
- **The DDC / Milestone-3 work bundled into this commit** (migrations 040-046, `sources/ddc`,
  `sync/ddc`, the -7/-8/-9 branches). Out of the stated scope; I only exercised it incidentally.
- **Frontend behaviour.** `FilterBar.tsx` / `StatsTable.tsx` were not exercised in a browser; F1 is
  reachable from the UI only if the frontend permits GD + Campaign simultaneously — worth confirming.
- **`sites: []` in `/api/filters/options`.** Noted as broken, root cause not investigated.
- **Whether the Codefuel gap closes after a worker deploy.** The fix is not deployed
  (`sync_runs` 05:15 run wrote 0 rows), so I could only verify the code, not the deployed behaviour.
