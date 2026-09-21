-- Migration 045: reassign (gd, r) pairs to the account that actually spends on them.
--
-- THE DEFECT. outbrain_ads is keyed on (gd_param, r_param) GLOBALLY — the
-- primary key carries no marketer:
--     outbrain_ads_pkey ON outbrain_ads (gd_param, r_param)
-- and syncOutbrainPromotedLinks upserts ON CONFLICT ... DO UPDATE SET campaign_id.
-- So when two marketers use the same landing pair, whichever campaign the sync
-- happened to iterate LAST silently owns the pair and all of its Codefuel
-- revenue. Ownership depended on iteration order, not on reality.
--
-- Measured from outbrain_ad_daily, the authoritative per-link record: 17 of 777
-- live pairs are reachable from more than one marketer, carrying $2,566.15 of
-- Codefuel revenue — 7.4% of the $34,730.49 Codefuel-Outbrain total. Not theoretical.
--
-- It fired for real: a routine promoted-links re-sync handed the three new
-- accounts (SBH_ssm_11/12/13_Codefuel) 28 pairs they had never spent a cent on,
-- so the dashboard showed them with revenue against $0.00 cost — infinite margin
-- on brand-new accounts. A further 13 pairs had already drifted from ssm_01 to
-- ssm_02 before this milestone.
--
-- THE CORRECTION. Give each pair to the campaign with the highest actual spend
-- on it. Codefuel reports only (gd, r) and does not know the marketer, so a
-- genuinely shared pair is ambiguous in the SOURCE DATA — "whoever spends" is
-- the best available signal, not a complete answer. The complete answer is
-- click-share allocation across candidate campaigns (the pattern used for DDC in
-- migration 043); that changes historical figures for ssm_01/02/04 and is
-- deliberately left as a separate decision.
--
-- Idempotent: driven entirely by current spend, so re-running is a no-op. Pairs
-- nobody has spent on are left alone rather than guessed at.
--
-- sync/outbrain.ts has been changed in the same commit so the dedupe prefers a
-- campaign that spends on the pair and never displaces one that does — without
-- that, the next sync would undo this.

WITH best AS (
  SELECT oa.gd_param,
         oa.r_param,
         (SELECT d.campaign_id
            FROM outbrain_ad_daily d
           WHERE d.gd_param = oa.gd_param
             AND d.r_param  = oa.r_param
             AND d.spent    > 0
           GROUP BY d.campaign_id
           ORDER BY SUM(d.spent) DESC, d.campaign_id
           LIMIT 1) AS campaign_id
    FROM outbrain_ads oa
   -- only pairs whose current owner has no spend on them
   WHERE NOT EXISTS (
     SELECT 1 FROM outbrain_ad_daily d2
      WHERE d2.gd_param = oa.gd_param
        AND d2.r_param  = oa.r_param
        AND d2.campaign_id = oa.campaign_id
        AND d2.spent > 0
   )
)
UPDATE outbrain_ads t
   SET campaign_id = b.campaign_id,
       updated_at  = NOW()
  FROM best b
 WHERE t.gd_param = b.gd_param
   AND t.r_param  = b.r_param
   AND b.campaign_id IS NOT NULL          -- nobody spends on it: leave it alone
   AND t.campaign_id IS DISTINCT FROM b.campaign_id;

REFRESH MATERIALIZED VIEW joined_stats_hourly;
