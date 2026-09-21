# Milestone 3 — DDC as a third revenue partner

**Status: PLAN, awaiting Nauman's line-by-line approval. No code written, no migration applied.**
Date: 2026-08-31 · Target account: Outbrain marketer **SBH_ssm_09**
(`005f9aba0aa397a39cb174bc7b69c1e1fa`, `ad_accounts.id = 3971`)
**Credentials received and the API has been called live — every assumption below is now verified.**

This plan was drafted, then reviewed adversarially by a separate agent session against the actual
source (all 1742 lines of `server.ts`, migration `037`, `imageadvantage.ts`, both partial unique
indexes, cron/backfill, both frontend partner maps). Its findings are folded in below, and the two
questions the reviewer could not settle — it had no DB access — were then verified against the live
production database. Points where the review **overturned** the first draft are marked
**[REVISED]**; where it added something the draft missed, **[ADDED]**.

---

## 0. Live API testing — what is now settled

Nadia's earlier message carried the credentials (`https://24223-c9mazdp.ddcxlayer.com`,
`nadia@revlogicmedia.com`). The API has been called directly. Everything the earlier draft listed as
an unverified assumption is now answered, and two design decisions changed as a result.

| Question | Answer (verified 2026-08-31) |
|---|---|
| HTTPS? | **Yes.** No plaintext-credential fallback needed. |
| Does `date_start != date_end` work? | **Yes — but it SUMS the range.** `detail` returns no date column, so a 3-day call returns one aggregated set. **The backfill must loop day by day.** |
| Retention back to 22 July? | **Yes.** A 40-day `date` call returned all 40 days. |
| JSON field names | `Mode` (this is the **domain**, not a mode), `Visitors`, `Clicks`, `Net Client`, `Searches`, `BiddedSearches`, `TypeTag`, `Country`, `Tq`, `Source Tq` |
| Is `detail` consistent with `date`? | **Exactly.** 27–29 Aug: `detail` = $965.3843; `date` = 388.2823 + 299.1712 + 277.9308 = $965.3843. Free per-day reconciliation check, built in. |
| Is the source data duplicated? | **No.** `(Mode, TypeTag, Country)` is unique — 0 collisions in 359 rows. |
| Is `tb.startgonow.com` live? | **No.** Only `ob.startgonow.com` returns rows. |
| `Tq` | **`null`**, not `0.00` as July's probe recorded. The column must be nullable and the "hide until populated" rule must test for null. |
| `Source Tq` | **Populated** (`4.00` / `0.00`) even though `Tq` is not. |
| `Visitors` | Always `0`. Don't store it. |
| `Searches` vs `BiddedSearches` | Identical in every row observed (2,028 = 2,028 on 29 Aug). Store both anyway; don't assume the equality holds. |

### The finding that settles §5.3

**One base tag fans out across multiple publisher IDs, on the same day, in the same country.**
Collapsing `TypeTag` to its base and keying on `(baseTag, Country)` produces **47 collisions across
166 keys** in a single day's data. So storing the publisher part in `item_ext_id` is **required, not
optional** — without it roughly a third of the keys collide and last-write-wins silently deletes
real revenue. With it, our key `(campaign_ext_id=ob:<base>, item_ext_id=<publisher>, hour_utc,
country, device)` is exactly as unique as the source's own `(Mode, TypeTag, Country)`.

### The type tag: a clean cutover on 2026-08-28

Corrected from an earlier reading. Per-day sampling:

| Day | bare $ | suffixed $ | publishers |
|---|---|---|---|
| 24 Jul – 27 Aug | 100% | $0.00 | 0 |
| **28 Aug** | $288.90 | $10.27 | 12 |
| 29 Aug | $0.00 | $277.93 | 23 |
| 30 Aug | $0.22 | $147.56 | 30 |

The publisher macro went live **28 August**. Everything before is bare; everything after is
suffixed; 28 Aug is the single transition day carrying both.

**The two sets are disjoint — verified.** On 28 Aug, bare $288.9035 + suffixed $10.2677 =
**$299.1712**, exactly the `date` report's total for that day. The bare row is *not* a rollup that
contains the suffixed portion, so summing both is correct and does not double-count.

**Consequence:** the ~5 weeks of history from 24 Jul to 27 Aug carry **no publisher attribution**
(`item_ext_id = ''`). The Site report for DDC therefore starts 28 August, not 22 July. Nadia should
know that.

**Key uniqueness holds on every day type.** Our storage key
`(campaign_ext_id, item_ext_id, hour_utc, country)` produced **0 collisions** on an all-bare day
(27 Aug, 110 rows), the transition day (28 Aug, 203 rows) and both all-suffixed days
(29–30 Aug, 359 / 278 rows) — matching the source's own `(Mode, TypeTag, Country)` uniqueness.

**Also: the 69-character tag is fine.** Nadia confirmed the 50-character limit applies only to the
first part; the macro-appended publisher ID is not counted. No truncation risk.

---

## 1. Why this matters — and what the numbers actually say

SBH_ssm_09 has spent on Outbrain since **2026-07-22**, the date Nadia named:
**$8,103.93 across 32 campaigns through 2026-08-30**, with **zero revenue recorded**. The dashboard
currently shows the account as a pure $8.1k loss.

It is not an $8.1k loss. Pulling the full DDC history and joining it to the cost we already hold:

| | 22 Jul – 30 Aug | Last 7 closed days |
|---|---|---|
| Outbrain cost | $8,103.93 | $3,286.66 |
| DDC net revenue | **$6,270.32** | $2,370.01 |
| **Profit** | **−$1,833.61** | **−$916.65** |
| **Margin** | **−29%** | **−39%** |

First revenue lands **2026-07-24** (22–23 July are $0.00 — consistent with Nadia's note that the
earliest data was link testing).

**This is worth telling Nadia now, ahead of any dashboard work.** The account is genuinely
unprofitable, and it is getting worse as spend scales: the first half of August ran −30% to −80% on
small volume, three days around 13–21 August turned positive (+36% on 20 Aug), and the last week has
settled at −39% on the largest spend of the period. Only 2 of 40 days were meaningfully profitable.

## 2. The attachments changed the picture: this is a different API

July's investigation probed `yss_current_day` — token auth, tab-delimited, a fixed rolling 3-day
window that ignored every date parameter. That is why 22–27 July was declared unreachable. The
attachments describe **DDC Stats API v2**, a different service:

```
GET http(s)://<unique_host_id>.ddcxlayer.com/webservices.php
      ?output=json&service=dailystats
      &username=<u>&password=<p>
      &date_start_mm=&date_start_dd=&date_start_yyyy=
      &date_end_mm=&date_end_dd=&date_end_yyyy=
      &report_type=<date|domain|detail|device>
      &domains=<csv>
```

| | yss_current_day (July) | **dailystats (this one)** |
|---|---|---|
| Grain | hourly | daily |
| Date control | none | **explicit start + end** |
| History | unreachable | **reachable** |
| Dimensions | domain, country, device, campaign | domain, type tag, country, TQ, Source TQ |
| Auth | token | username + password as query params |

**This resolves the July blocker.** 22–27 July is reachable because this endpoint takes a real date
range. `report_type=detail` (per-domain rows carrying Type Tag, Country, TQ, Source TQ, Visitors,
Clicks, Net Client, Searches, BiddedSearches) is our revenue feed.

### Also available, and deferred: the hourly API

Nadia's notes also carry hourly access — auth code `f8e5b851f07dd87337ff4f925f32bdae` at
`https://rdp.ddc.com/oauth2/access_token?code=…` (30-minute token), then
`/api/v1/dw/yss_current_day`. There is a second variant, `yss_fast_current_day`, which lags 2–4
hours instead of 4–6 but **returns no TQ**. This is the endpoint July's investigation probed and
found to be a fixed rolling window.

Phase 1 does not use it — see §5.4. It is credentialed and ready whenever intraday DDC is wanted.

Two further notes from her setup instructions, both now confirmed against the data:
- `tmpl=C244` → `ob.startgonow.com` (Outbrain), `tmpl=C245` → `tb.startgonow.com` (Taboola). This is
  the domain → platform mapping §5.1 relies on, straight from the client.
- The DDC/Yahoo day ends at **5pm PST = midnight UTC**, so the reporting day is a **UTC day** and
  lines up with our `hour_utc` with no conversion. Reporting is usually final before 8am PST.

---

## 3. Nadia's answers, applied

| Question | Her answer | Consequence |
|---|---|---|
| History for 22–27 July | Stats API attached | Backfill 2026-07-22 → today |
| Is revenue net? | **"all net revenue, no % to add"** — column is literally *Net Client* | Store as-is. No split factor. |
| Surface TQ? | **Yes.** Populates only after 3–6+ weeks of volume | Store from day one; **hide the column until a non-zero value exists** |
| Type-tag cap | Raised 50 → **~2,000** | July's scaling concern is closed |
| Is SBH_ssm_09 DDC-only? | **Yes — one partner per account.** She'll flag any new DDC accounts | Tag 3971 `ddc`; SBH_ssm_08 / _10 are **not** DDC |
| Publisher IDs | Sent the Outbrain publishers export | **Mismatch resolved — see §4** |
| TQ | **"Not available right now — leave it for now, we'll add it when we have it"** | **Dropped from scope.** No `tq` column, no weighted-average work |
| Restatement window | "Last 4 days should be fine" | The existing 4-day backfill window is correct, unchanged |
| 50-char tag limit | Applies to the **first part only**; the macro is not counted | Non-issue |

---

## 4. The Type Tag format change

```
configured:  tt=00c73a9e51bd482f60e18fc394a6257db1_{{publisher_id}}
appears as:  0007ce48ab61d39f52bc14ea873fd92651_002527c9a719db612ebcef30e28f7788ab
             └─────── 34 chars: ad/campaign ───────┘ └────── 34 chars: publisher ──────┘
```

Part 1 is a 34-char hex in the same ID space as `outbrain_campaigns.campaign_id`,
`outbrain_ad_links.link_id` and `outbrain_ad_daily.promoted_link_uuid` — all verified 34 chars in
the live DB. Resolve with the same chain IA already uses for Outbrain.

The parser must accept **both** shapes: split on `_`, take `[0]` as the attribution key and
`[1] ?? ''` as the publisher key. **Verified: both shapes appear on the same day for the same base
tag** — this is not a date cutover, so no date-based branching anywhere. On 29 Aug all revenue was
on suffixed rows and every bare row was $0.00.

### ✅ The publisher IDs DO join — resolved, and the data is already in our database

The earlier concern was that DDC's 34-char hex publisher would not join to the 4–6 digit numerics we
store. Nadia's export settles it: **Outbrain publishes three identifiers per publisher**, and we had
been comparing two different ones.

| CSV column | Example | What it is |
|---|---|---|
| `Publisher ID` | `00735641f857ca40b4433cd3ed84b568a1` | 34-char hex — **this is what DDC's `{{publisher_id}}` macro emits** |
| `Publisher Name` | `glance.com` | display name |
| `Publisher Identifier` | `185361` | numeric — what `outbrain_publisher_daily.publisher_id` stores |

**Verified against the live DDC API: 32 of 34 DDC publisher hexes match the export, covering 100.0%
of suffixed revenue.** (The 2 unmatched carry $0.00.)

**And no new sync work is needed.** `fetchPublisherBreakdown` already returns
`publisherUuid` (`metadata.id`, the hex) and `syncOutbrainPublisher` already writes it to
`outbrain_publisher_daily.publisher_uuid`. Confirmed in production: **545 rows for SBH_ssm_09, all
populated, all 34 chars, 129 distinct.** Nadia's CSV confirmed the mapping but we never needed it —
the join key has been syncing daily all along.

So the DDC Site report is:

```sql
partner_stats_hourly.item_ext_id = outbrain_publisher_daily.publisher_uuid
```

which yields publisher **name, cost and DDC revenue on one row** — the first time the Outbrain Site
tab will show revenue at all (it currently hard-codes `0::numeric`, `server.ts:496`).

**This is where the account's loss lives.** Joining DDC revenue to Outbrain publisher spend:
`glance.com` took **$5,376.99 of spend and returned $71.02** — roughly two-thirds of the account's
total spend against about 1.6% of its revenue. `sportscentralnews` returned $175.24 on $1,100.34.
Nadia has had no way to see this, which is exactly why she wants the dashboard. Worth building the
Site tab in phase 1 rather than deferring it.

---

## 5. Design

### 5.1 Storage — reuse `partner_stats_hourly`, attributed row shape

Reuse is right for `revenue`/`ad_clicks`/`sessions`: the entire orphan, attribution and MV
machinery is keyed off that table. A separate table would mean re-implementing all of it.

| DDC field | Column | Note |
|---|---|---|
| Net Client | `revenue` | net, per Nadia |
| BiddedSearches | `sessions` | matches the existing "sessions = bidded searches" convention |
| Clicks | `ad_clicks` | |
| Country | `country` | DDC reports it; IA does not |
| Type Tag part 1 | `campaign_ext_id` = `ob:<hex>` | same convention as IA-Outbrain |
| Type Tag part 2 | `item_ext_id` | **required for key uniqueness** (see §0); opaque in phase 1; `''` when absent, never NULL |
| domain `ob.*` / `tb.*` | `source_platform` = `Outbrain` / `Taboola` | same role as IA's affiliate suffix |
| TQ / Source TQ | **not stored** | Nadia: "not available right now — leave it for now". `Tq` is `null` in every live row. Because the stats API retains 40+ days, TQ can be added *and backfilled* whenever it starts populating — nothing is lost by waiting. |
| Searches | **not stored** | identical to `BiddedSearches` in every row observed; adds a column for no information |
| Visitors | **not stored** | always `0` |

**Hard constraint:** the *attributed* unique index has no `NULLS NOT DISTINCT`, so `item_ext_id`
must be `''`, never NULL, or every re-sync appends a duplicate (the migration-039 bug).
`country` and `device` are `NOT NULL DEFAULT ''`, so `item_ext_id` is the only NULL risk.

### 5.2 Granularity: use `'daily'` — **[REVISED]**

The draft argued for a new `'ddc-daily'` value, "never shadowed, exactly how `x-daily` works". That
reasoning is wrong. Read `037:25-33`:

```sql
ps AS (
  SELECT p.* FROM partner_stats_hourly p
  WHERE p.granularity = 'hourly'
     OR p.granularity = 'x-daily'        -- x-daily is never shadowed because this line NAMES it
     OR NOT EXISTS (SELECT 1 FROM hourly_days h ...)   -- everything else falls here
)
```

`'ddc-daily'` would match neither of the first two arms and fall into the *same fallback arm as
`'daily'`*. It buys nothing today, and the moment an hourly DDC feed is added it inverts to the
opposite of the intended guarantee. It also costs an `ALTER TABLE … CHECK` — an `ACCESS EXCLUSIVE`
lock plus full validation scan on the largest table in the schema, on a live production DB — and it
silently files DDC under "Yahoo" in the feed filter, since `feed=yahoo` is `granularity <> 'x-daily'`.

**Use `'daily'`.** Identical behavior, no ALTER, no lock. If never-shadowed semantics are wanted
later, the correct change is adding `OR p.granularity = 'ddc-daily'` to the `ps` CTE *in the same
migration* — not shipping the value alone.

With TQ dropped (§5.1), migration `040` now adds **no columns at all** — it is one
`client_partners` INSERT plus one `ad_accounts` UPDATE. The only schema-level change in this
milestone is the MV rebuild in `041`.

### 5.3 Deduplication: accumulate, and keep the publisher in the key — **[REVISED]**

The draft said "copy the IA sync's dedup Map". That copies a data-loss bug. IA does:

```ts
attr.set(`${campExt}${parsed.itemExtId}${hourUtc}`, [...]);   // last write wins
```

Last-write-wins is correct for IA, which emits one row per key. The hazard for DDC is that
`source_platform` is **absent from the attributed unique index** — the index is
`(client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)` — so
anything that collapses onto one key silently overwrites instead of summing.

**Live testing narrowed this precisely:**
- `(Mode, TypeTag, Country)` is **unique in the source** — 0 collisions. DDC does not send duplicates.
- Dropping the publisher suffix causes **47 collisions across 166 keys in one day**. So the publisher
  part is what keeps our key unique; it must go in `item_ext_id` (§0).
- Only one `Mode` is live today, so the cross-domain collision the review warned about is not yet
  reachable. It becomes reachable the moment `tb.startgonow.com` goes live — but the `ob:`/`tb:`
  prefix on `campaign_ext_id` separates those, so the key stays safe.

**Therefore:** with the publisher in `item_ext_id` and the platform prefix on `campaign_ext_id`, our
key is exactly as unique as the source's. Build the Map to **accumulate anyway**
(`const prev = attr.get(k); attr.set(k, prev ? sum(prev,row) : row)`) — it costs nothing, and it
means a future extra domain or a DDC-side grain change degrades into a correct sum rather than
silent deletion. State the guarantee in a comment.

### 5.4 Scope: daily only; the `device` report is NOT persisted — **[ADDED]**

DDC lives on Outbrain, and Outbrain cost is already daily-grain in the MV, so a daily DDC feed
lines up exactly. Adding `yss_current_day` on top would introduce a second grain for one partner
and re-open the double-counting class of bug that dominates this project's history. Defer it.

The `device` report covers the **same underlying traffic** as `detail`, sliced differently. If both
were written to `partner_stats_hourly`, DDC revenue would **double** — and it would not collide on
the unique key, so nothing would stop it. **`fetchDevice` is metrics-only and never persisted in
phase 1**, or it is dropped entirely.

### 5.5 MV changes (migration 041 — copy all of 037 and edit)

- New `ob_ddc_rev` CTE resolving hex → campaign → link, **folded into `ob_rev_by_camp_day`**, never
  as a new top-level `UNION ALL` — otherwise Outbrain cost fans out and double-counts.
- New `ob_ddc_orphan` CTE with one top-level `UNION ALL` branch.
- **[REVISED] The disjointness between those two must be written down and enforced.** The IA pair it
  mirrors is disjoint only *by construction*: `ob_ia_rev` takes every row `LIKE 'ob:%'` and keeps
  unresolvable ones via `COALESCE(…, raw.hex)`, while `ob_ia_orphan` takes only `IS NULL OR NOT
  LIKE 'ob:%'`. Writing `ob_ddc_orphan` the natural way ("revenue that didn't resolve") would
  overlap the `raw.hex` fallback and **double-count every unresolved dollar**.
  → Drop the `raw.hex` fallback from `ob_ddc_rev` (end it with
  `WHERE COALESCE(ocd.campaign_id, al.campaign_id) IS NOT NULL`, matching `ia_attributed` at
  `037:81`) and let the orphan CTE own everything unresolved.
- **[REVISED] The DDC orphan branch must carry a real `ad_account_id`.** Both existing Outbrain
  orphan branches emit `NULL::INT` (`037:253`, `037:261`), and a phantom hex in the main branch
  resolves its account through `outbrain_campaigns → ad_accounts`, so it also lands NULL. Either
  way, the moment Nadia filters to SBH_ssm_09 that revenue **disappears while the $8.1k of cost
  stays**. Copy the `ia_orphan` lateral at `037:120`:
  `JOIN LATERAL (SELECT id AS ad_account_id FROM ad_accounts WHERE client_partner_id = cp.id LIMIT 1)`.
  DDC is a single-account partner, so this is exact.
- All branches are **positional across 29 columns**; DDC emits literal zeros for the three flux columns.
- Taboola side (`tb.startgonow.com`, tmpl C245): no live traffic and the tt format there is unknown.
  Route to the orphan bucket rather than guessing. Revenue is never dropped.

### 5.6 `server.ts` — the Outbrain Ads tab needs THREE DDC branches, not "safety nets" — **[REVISED]**

The draft assumed the existing `-5`/`-6` rows would catch leftover DDC revenue. **They will not.**
Both are hard-wired to IA and Codefuel: `-5` (`server.ts:723-745`) reads `FROM ia_camp_rev` only,
and `-6` (`756-802`) is a three-member UNION of `ob_cf_rev` (Codefuel-joined), `ia_raw` (IA-joined),
and a third member explicitly joining `cp2.code = 'image_advantage'`.

So a DDC hex resolving to neither a promoted link with cost nor a campaign/ad-link row falls
through **every** branch and is silently dropped — while the MV keeps it. Ads < Campaign, in the
direction Nadia notices. This is not hypothetical: broken tracking templates have already happened
twice on IA.

All three are **mandatory**:
1. `ddc_link_rev` + `ddc_camp_rev` + `ddc_camp_alloc` (mirroring `ia_camp_alloc`, `647-667`), added
   into the `-4` row's revenue sum at `704-706`.
2. A DDC equivalent of `-5` for campaign-level revenue on campaigns with no cost ads in the window.
3. A **fourth UNION member inside `-6`** for DDC hexes resolving to nothing.

**Outbrain Hourly — decided: exclude. [REVISED]** `ob_rev_h` (`299-324`) joins `client_partners`
with no `cp.code` predicate and no granularity filter, so DDC's daily rows pinned to `00:00` would
**all pile into hour 0**, painting it wildly profitable and hours 1–23 as pure loss. Add
`AND cp.code <> 'ddc'` and surface the excluded amount as a labelled footer row. Reason: Nadia's
named #1 invariant is Campaign == Ads, not Campaign == Hourly, and a visible hour-0 spike is worse
than a documented gap. The draft left this open; a plan that ships it open ships a bug either way.

Also required: a DDC row in `/api/sync-status` (`40-56`, a literal UNION ALL of hardcoded codes).

**Country filter is a regression, not a win. [REVISED]** The draft called "DDC countries appear
automatically" a benefit. The dropdown pulls `DISTINCT country FROM partner_stats_hourly` with no
partner scope (`99-110`), while the Country *view* is Codefuel-only and the Outbrain country view
returns `0::numeric AS revenue`. Result: dozens of new country options that return an empty table.
Either scope the dropdown or add a DDC branch to the Outbrain country view.

### 5.7 Frontend

- `FilterBar.tsx`: add `ddc` to `PARTNER_COLORS`, `PARTNER_LABELS`, `PARTNER_FULL` (17-28) and the
  Project `<option>` list (484-485). An unmapped code degrades silently to a grey chip.
- `StatsTable.tsx`: add `ddc` to `ACCT_BADGE` (203-206).
- **TQ work is now out of scope entirely. [REVISED]** Nadia deferred TQ, which removes the whole
  weighted-average problem: no SQL aggregate, no `computeTotals` special case
  (`server.ts:1704`), and no `computeTotalsClient` special case (`StatsTable.tsx:11-33`, the second
  totals implementation that takes over whenever an inline column filter is active — which the
  first draft had missed). This was the single largest source of subtle-correctness risk in the
  plan and it is gone. Revisit when she asks for TQ; the API retains history, so it can be backfilled.
- **[ADDED] Site tab:** add a DDC branch to the Outbrain site view (`server.ts:477-524`), joining
  `item_ext_id → outbrain_publisher_daily.publisher_uuid` so publisher name, cost and revenue land
  on one row. Note the tab currently returns `0::numeric AS revenue` for Outbrain.
- `bulkUpsert` hardcodes `14` columns in three places. Adding `tq`/`source_tq`/`searches` makes it
  17; a copy-paste with a stale `14` produces a silently misaligned INSERT.

### 5.8 Account tagging, cron, and manual runs

```sql
UPDATE ad_accounts SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'ddc')
 WHERE external_id = '005f9aba0aa397a39cb174bc7b69c1e1fa';
```

Add an isolated `step('ddc', …)` to `daily-backfill.ts` over its 4-day window — never collapse the
per-step isolation, that structure exists because the 03:00 job once died silently for days.
**[ADDED]** Add a matching `run-once.ts` job name; every other source has one, and without it there
is no manual re-run path.

### 5.9 Files

```
backend/src/sources/ddc/client.ts   HTTP only — URL build, fetchDetail, JSON parse
backend/src/sync/ddc.ts             DB only — parse tt, resolve platform, ACCUMULATING Map, bulk upsert
backend/db/040_ddc_partner.sql      client_partners row + account tagging (no new columns, no CHECK change)
backend/db/041_mv_ddc.sql           full MV re-declaration (copy 037 + DDC CTEs)
```

`getPartnerId` / `startRun` / `finishRun` are duplicated verbatim per sync file in this codebase.
Follow that; do not refactor mid-task.

---

## 6. Sequencing — three separate commits, in this order

**Commit 1 — fix the live `feed=flux` bug on the Outbrain Ads tab. [ADDED — do this first]**

Campaign != Ads is **already broken today**, before any DDC work. Under `feed=flux` the MV's
Outbrain branch emits zero flux columns, so the Campaign tab shows **$0** Outbrain revenue — while
the Ads tab's `ob_cf_rev` (`server.ts:585`) has **no feed filter at all** and returns the full
amount. Verified live: Codefuel-Outbrain revenue was **$8,877.06 in August alone** across 17,236
rows. Whoever runs the §7 invariant check without fixing this first will lose a day blaming DDC.

**Commit 2 — the `cf_key` fix, with its own before/after numbers. [REVISED]**

`cf_key` (`1428-1442`) has no `client_partners` join, so it treats every `campaign_ext_id IS NULL`
row as Codefuel — including IA's NULL-`source_platform` rows from the `ssm.flux.pro.fb` affiliate
(verified live: **$410.86** across 2,069 rows in August).

**Correction to the draft:** the draft claimed DDC orphans would inflate Codefuel revenue here.
Under this plan's own storage design they cannot — DDC rows are attributed (`campaign_ext_id NOT
NULL`, failing `cf_key`'s first predicate) and carry `source_platform = 'Outbrain'` (failing
`psSource`). **`cf_key` is not a DDC blocker.** Fix it anyway, as its own commit, because bundling
an independent behavior-affecting SQL change into the DDC migration makes it impossible to attribute
any number movement to one cause — which is exactly this project's historical failure mode.

The `-3` guard needs a third `NOT EXISTS` too, but it is on the *Taboola* Ads branch and is dead
code until DDC produces Taboola-side campaign revenue. Add it for the future; don't count it as
DDC-critical.

**Commit 3 — DDC itself**, per §5.

---

## 7. Backfill and verification

1. Backfill 2026-07-22 → today **one call per day** — a date range sums rather than splitting (§0),
   so a range call cannot produce per-day rows. 40 days = 40 calls; see the rate-limit note in §8.
   Then refresh the MV.
2. Reconcile with **real numbers, not "should be correct now"**:
   - **The expected total is known: $6,270.32 for 2026-07-22..08-30.** After the backfill, DDC
     revenue in `partner_stats_hourly` must equal that to the cent, and each day must match the
     per-day figures already pulled (see §1). Any drift means the sync is losing or duplicating rows.
   - Cross-check each day with `report_type=date`, which is a free independent total from the same
     API (§0). Confirmed exact on 27–29 Aug.
   - DDC's day boundary is UTC (§2) and needs no conversion — but verify day by day rather than on
     the period total, since a whole-period match can hide a systematic one-day shift.
   - SBH_ssm_09 margin becomes plausible instead of −$8,103.93.
   - **Campaign tab total == Ads tab total** under every source × account × feed. Nadia's single
     most important requirement.
   - Codefuel revenue **unchanged** before vs after — proof the `cf_key` fix and the DDC orphan rows
     did not leak into it.

**Tolerance note. [ADDED]** The Ads tab reads `outbrain_ad_daily` while the Campaign tab reads
`outbrain_stats_daily`. Verified live for SBH_ssm_09 over 22 Jul–30 Aug: **$8,104.98 vs $8,103.93**,
a $1.05 (0.013%) delta from link-grain rounding, and the same small positive skew exists for every
marketer. Campaign == Ads on Outbrain will never match to the cent. Expect cents, not zero.
*(The review flagged the risk that promoted-link cost might be missing entirely for this marketer,
which would have made the invariant unreachable. Checked against production: it is not — 1,296 rows,
full date coverage. Precondition cleared.)*

---

## 8. Risks and operational notes — **[ADDED]**

- **The MV rebuild blocks the dashboard.** Migration 041 is `DROP MATERIALIZED VIEW … CASCADE` +
  `CREATE` + `REFRESH` in one transaction, holding `ACCESS EXCLUSIVE` for the whole refresh — and
  the API service runs `migrate:prod` on **every Render build**. Time the refresh first
  (`npm run sync:once -- refresh-view`) and tell Nauman the expected outage window before deploying.
- **Migration order matters.** 040 must land the `client_partners` row and account tagging before
  041 rebuilds the MV; DDC CTEs join `cp.code = 'ddc'`, and a missing row returns zero rows
  **silently**, not an error. Filename order gives this, but state it. If 040 succeeds and 041
  fails, the build exits 1 with the partner row created and the MV intact — recoverable.
- **Rollback path.** `DELETE FROM partner_stats_hourly WHERE client_partner_id = (SELECT id FROM
  client_partners WHERE code='ddc')` is clean and safe; nothing else references those rows. This is
  what makes a live-DB backfill reversible, and it is a large part of why reusing the shared table
  is the right call.
- **Rate limiting: no limit hit in testing**, but only ~6 calls were made. The backfill is 40
  sequential calls; each single-day `detail` response was ~85 KB and returned in ~1.5 s. Add a small
  delay between calls and stop on the first non-200 rather than hammering. Outbrain's 2/hour login
  limit cost this project real debugging time — don't discover DDC's at 03:00.
- **Housekeeping:** `026/028/030/032` currently show as modified but are line-ending-only changes
  (`git diff --ignore-all-space` is empty). Editing an already-applied migration is inert anyway —
  the runner skips by filename. Don't commit them alongside DDC work.

---

## 9. Open with Nadia — nothing blocking

Every question is answered. Her second reply closed the last four:

1. **SBH_ssm_09 is DDC-only** — one partner per account, and she'll flag new DDC accounts as they
   come. So tag `ad_accounts.id = 3971` as `ddc`; **SBH_ssm_08 and SBH_ssm_10 are not DDC** and stay
   untagged.
2. **Publisher IDs resolved** (§4) — and the join key was already in our database.
3. **TQ deferred** at her request. Dropped from scope; can be added and backfilled later.
4. **Restatement: 4 days is fine** — the existing backfill window is already correct.
5. **The 50-char tag limit** applies to the first part only. Non-issue.

Worth telling her, not asking:

- **The Site report will start 28 August, not 22 July** — the publisher macro went live that day, so
  the five weeks of history before it carry no publisher attribution (§0). Revenue and cost totals
  are unaffected; only the per-publisher split is.
- **`glance.com` is where the loss is concentrated**: $5,376.99 spend against $71.02 of DDC revenue
  (§4). She may want to act on that before the dashboard ships.

### Deferred by decision, not by blocker

- **Feeds:** DDC will group under "Yahoo" by default, since the Outbrain MV branch emits
  `revenue_flux = 0`. Ship that default; revisit only if she asks for DDC as its own feed.
- **Hourly:** credentialed and available (§2), not used in phase 1 (§5.4).
- **TQ:** above.
