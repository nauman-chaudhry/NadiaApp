# SSM16 "Unattributed revenue — no account": findings and plan (2026-11-27)

This was read-only work. All queries ran inside `BEGIN READ ONLY` against the live DB. I made no writes and ran no syncs, Outbrain calls, Codefuel calls or edits. Query files: `q1.sql` … `q6.sql` in this scratchpad (runner `q.cjs`). Days below are UTC.

## Findings

### Q1. What is unattributed, and where it lands
The Codefuel rows with `source_platform='Outbrain'` that have no `outbrain_ads (gd,r)` match:

| day | unmatched $ | total CF-Outbrain $ |
|---|---|---|
| 11-20..11-23 | 0.00 | 26.24 / 5.88 / 0 / 27.42 |
| 11-24 | 0.26 | 115.51 |
| 11-25 | **279.15** | 348.60 |
| 11-26 | **473.80** | 478.35 |
| 11-27 (partial) | **121.29** | 121.29 |
| **Total** | **$874.50** | |

The MV shows the same totals. They land in the `ob_cf_orphan` branch, labelled **"(Outbrain — Codefuel, not mapped to campaign)"**, with `ad_account_id NULL` and `source_platform 'Outbrain'`. The Accounts tab renders that as "(Unattributed revenue - no account)".

By gd:
- AP1009512: $854.68 (85 channels)
- AP1009669: $7.57
- AP1009670: $6.65
- AP1009668: $4.59
- AP1009667: $1.01

Taboola-side Codefuel orphans (`codefuel_orphan`) are $0. SSM16's own MV revenue for the last 30 days is **$1.22 against $1,187.35 spend**.

### Q2. Root cause per gd
- **AP1009512 ($854.68): the gd in the URL does not match the gd Codefuel reports.**
  - The URL gd is wrong; r is fine.
  - SSM16's new campaigns ("US-Mixed KW Vxx -25 Nov - FTD-9513") have 83 foundthatdeal.com links, all with `gd=AP1009513` in the URL. Their spend is $1,143.69 from 11-25 to 11-27.
  - Codefuel reports this traffic under **AP1009512**. In every earlier link, gd and domain map one-to-one, and AP1009512 = foundthatdeal.com (Oct links had `gd=AP1009512`). So Codefuel attributes by the domain's GID.
  - The channels Codefuel reports for AP1009512 (7700353878, 7710892926, 7708833970, …) are exactly the `r` values of SSM16's links, which are stored as `(AP1009513, r)` in `outbrain_ads` and were refreshed 11-27 03:17.
  - The r values are not a macro: 84 of 85 channels match a stored r. The exception is `ftd-direct`, $2.90.
  - So this is not a latency problem and not a tenant-filter problem.
  - Nadia quoted GID AP1009513, which is what's in her URLs. Either she fixes the URLs to `gd=AP1009512`, or Codefuel confirms it maps by domain.
- **AP1009667–670 ($19.82): Codefuel mislabels these as Outbrain.**
  - They are **Taboola** campaigns 50924660–64 ("US-Mixed KW 24 Nov -96xx") in the Taboola account "TDG … Lead Gen Affiliates - SC", which is Codefuel-tagged. Their spend is $77.43.
  - `(gd,r)` matches Taboola `ads` exactly, but Codefuel reports `source_platform='Outbrain'`. The MV routes on that field, so the revenue falls into the Outbrain orphan.
  - AP1009671 is labelled `Taboola` and attributes correctly. This is probably a mis-configured asset on Codefuel's side.
  - No `(gd,r)` pair exists in both `ads` and `outbrain_ads` (0 pairs), so re-routing on the pair is safe.

### Q3. Is gd alone unique?
**No.**
- Outbrain: all 16 gds span more than one campaign, and 15 span more than one marketer. In the last 14 days, 8 of 9 do (AP1009513 is on SSM16, SSM15, SSM01 and SSM21).
- Taboola: 17 of 37 gds span more than one account.
- r alone is not unique either: 223 of 1,213 Outbrain r values appear under more than one marketer, because ads are copied between accounts. 11 SSM16 r values are shared with SSM21's searchmetoday, searchme-now and getitsearched links.
- **What does work: r restricted to links that spent on day D-1..D, plus the domain of the reported gd.**
  - Since 11-20 this resolves **$849.53 to exactly one campaign**, and $5.15 more to one account by domain. That is all of AP1009512.
  - For October onward it also recovers $93.83 of older orphans, leaving $62.50 unresolved.
  - Across all Codefuel-Outbrain revenue since October, r-with-spend alone is single-campaign for $24,742 and multi-campaign for $1,545. So the domain filter is needed.

### Q4. Why it shows "no account"
The `ob_cf_orphan` CTE (migration 052, line 376) groups by day only. It has no account resolution, and its top-level branch hardcodes `NULL::INT` for `ad_account_id` (around line 463). This differs from the Taboola `codefuel_orphan`, which has a gd→account lateral, and from the IA/DDC orphans (050 LEFT JOIN LATERAL). The API's Accounts view labels NULL as "(Unattributed revenue - no account)". The Ads tab uses `-6`.

### Q5. How fast a new promoted link becomes attributable
- `outbrain_ads` is written **only** by `syncOutbrainPromotedLinks`, in the 03:00 backfill (`daily-backfill.ts:122`). It is not recorded as its own `sync_runs` job type. `updated_at` = 11-27 03:17Z.
- `outbrain_ad_daily` holds gd/r/landing_url per link and **is synced hourly at :25** (`cron.ts:148`).
- Best case, a link launched just after 03:00 sits unattributed for about 24 hours. On average it's about 12 hours plus Codefuel's 3–6 hour lag.
- The MV recomputes over full history on refresh. Once a mapping exists, **past days re-attribute automatically, with no data rewrite.**

### Q6. Untagged accounts (`client_partner_id NULL`) active in the last 30 days

| account | spend | revenue | name/URLs imply |
|---|---|---|---|
| SBH_ssm_10 | 546.41 | 448.91 | no gd (healthprenium/promoswirl): IA or DDC, unknown |
| SBH_ssm_15_Codefuel | 2,721.55 | 3,107.38 | Codefuel (gd URLs) |
| SBH_ssm_16_Codefuel | 1,187.35 | 1.22 | Codefuel (gd URLs) |
| SBH_ssm_18_IA | 522.63 | 189.31 | IA (promoswirl) |
| SBH_ssm_19_IA | 660.44 | 145.27 | IA (seek4save) |
| SBH_ssm_20_DDC | 87.36 | 1.49 | DDC (startgohub) |
| SBH_ssm_21 | 337.52 | 215.45 | Codefuel by URLs (gd params); no suffix |
| SBH_ssm_22 | 246.67 | 47.02 | no gd (promoswirl): IA likely; no suffix |

SBH_ssm_17_Codefuel is untagged but had no activity. Eleven Taboola accounts are also untagged (legacy, created 05-22). SSM16 has a startgohub.com link with no gd ($29.23), so one account can serve more than one partner.

## Plan (priority order)

**P0. Current data (no code).**
1. Ask Nadia to change SSM16's foundthatdeal URLs to `gd=AP1009512`, or to confirm with Codefuel that the GID is per-domain.
2. Ask her to have Codefuel re-label AP1009667–670 as Taboola.
3. Ask her to confirm tags for SSM15/16/21 → codefuel, 18/19/22 → image_advantage, 20 → ddc, and ssm_10.
4. Apply the confirmed tags as migration `054` (idempotent `UPDATE … WHERE external_id=… AND client_partner_id IS NULL`).

Invariant risk: none, because tags only feed the Project filter.
Verify: the Project=Codefuel total rises by the SSM15/16/21 rows.

**P1. Alias resolution in `outbrain_ads`. This fixes the current data and future domains/GDs.**
- New step `resolveOutbrainCodefuelAliases()` in `sync/outbrain.ts`, run hourly in `cron.ts` after `syncOutbrainAds`, and in the backfill.
- For every Codefuel-Outbrain `(gd,r)` with no `outbrain_ads` row in the last 14 days:
  - candidates = `outbrain_ad_daily` links with `r_param=r`, `spent>0` on D-1..D;
  - keep only those on a domain historically paired with that gd in a URL (gd→domain from `outbrain_ad_daily`);
  - if exactly one campaign remains, insert `(gd, r, campaign_id, origin='alias')` with `ON CONFLICT DO NOTHING`.
- Migration `054`/`055`: add `outbrain_ads.origin TEXT DEFAULT 'url'`.
- `syncOutbrainPromotedLinks` must not overwrite or delete alias rows.

The MV and `server.ts` (`:1269`, `:1281`, `-6` at `:1629`) already join `outbrain_ads`, so **both read the same mapping and Campaign == Ads holds by construction.** No MV change is needed.

Verify: after the next MV refresh, `ob_cf_orphan` since 11-20 falls from $874.50 to about $25. SSM16 revenue rises by about $849. Check Campaign == Ads == Accounts for source=outbrain and account=SSM16 under all/yahoo/flux.

**P2. Insert-if-absent URL pairs hourly.**
In the same hourly step, insert `outbrain_ad_daily (gd_param, r_param, campaign_id)` pairs with `ON CONFLICT DO NOTHING`. Nightly scoring still decides shared-pair ownership. This cuts new-link latency from about 24 hours to about 1 hour.
Risk: an incumbent is never changed hourly, so there is no churn.

**P3. MV `054`: give `ob_cf_orphan` an account, and re-route mislabelled Taboola rows.**
- Copy 052 into the new migration.
  - (a) `ob_cf_orphan` gains a LEFT JOIN LATERAL. It resolves the account from the gd's domain: campaigns that spent on that domain that day, kept only when `COUNT(DISTINCT marketer)=1`. Otherwise NULL.
  - (b) In `codefuel_attributed` and `codefuel_orphan`, also accept `source_platform='Outbrain'` rows whose `(gd,r)` exists in `ads` but not in `outbrain_ads`. Exclude those rows from `ob_cf_rev`/`ob_cf_orphan`.
- Mirror both in `server.ts`: the `-6` account resolution and the Taboola `-1`/`-2`/`-3` arms (the `cf_key` landmine). This is **the high-risk item** for Campaign == Ads.

Verify: the $19.82 moves to campaigns 50924660–64. Check Campaign == Ads for source=taboola and source=outbrain.

**P4. Auto-tag by name suffix.**
In `sync/outbrain.ts` and `sync/taboola.ts`, tag on first insert only: `_Codefuel$`→codefuel, `_IA$`→image_advantage, `_DDC$`→ddc. Never overwrite an existing tag, and log each one.
Needs Nadia's OK on the convention. SSM21/22 have no suffix, so this does not catch everything; P5 covers the rest.

**P5. Health check.**
New `run-once`/cron step `health-unattributed` (daily, plus once in the backfill). It writes a `sync_runs` row with `source='health'` and status `warn` when either of these holds:
- yesterday's unattributed revenue (all orphan branches) is over $10 or over 2%;
- any account active in the last 7 days is untagged.

Its `error` text lists the top gds and accounts. Surface it in `/api/sync-status` (FilterBar freshness) as a red badge. This is read-only for the data, so there is no invariant risk.

**Nadia's confirmation needed for:** P0 (URL gd, Codefuel labels, every account tag) and P4 (the naming convention).
