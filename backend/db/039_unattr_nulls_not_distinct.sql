-- Migration 039: stop unattributed rows duplicating on every re-sync.
--
-- Bug: partner_stats_hourly_unattr_unique includes source_platform, but that
-- column is NULL for IA rows whose affiliate suffix isn't .tb/.ob (e.g. the new
-- Facebook affiliate ssm.flux.pro.fb). Postgres treats NULL <> NULL in unique
-- indexes, so the upsert's ON CONFLICT never matched those rows — every hourly
-- sync INSERTed another copy. One broken-template affiliate had accumulated 26
-- copies of the same hour, inflating the "(Unattributed — …)" buckets.
--
-- Fix: rebuild the partial unique index with NULLS NOT DISTINCT (PG15+, we run
-- 17), so NULL source_platform rows collide and the existing ON CONFLICT DO
-- UPDATE fires. MV logic that keys on `source_platform IS NULL` is unaffected —
-- the column value stays NULL, only the index's NULL-equality changes.

-- 1. Collapse existing duplicates: keep the most-recently-fetched row per
--    logical key (source_platform NULL and '' treated as the same key).
DELETE FROM partner_stats_hourly p
USING (
  SELECT client_partner_id, granularity, asset_gid, channel, hour_utc, country, device,
         COALESCE(source_platform, '') AS sp, MAX(id) AS keep_id
  FROM partner_stats_hourly
  WHERE campaign_ext_id IS NULL
  GROUP BY client_partner_id, granularity, asset_gid, channel, hour_utc, country, device,
           COALESCE(source_platform, '')
  HAVING COUNT(*) > 1
) dup
WHERE p.campaign_ext_id IS NULL
  AND p.client_partner_id = dup.client_partner_id
  AND p.granularity       = dup.granularity
  AND p.asset_gid IS NOT DISTINCT FROM dup.asset_gid
  AND p.channel   IS NOT DISTINCT FROM dup.channel
  AND p.hour_utc  = dup.hour_utc
  AND p.country   = dup.country
  AND p.device    = dup.device
  AND COALESCE(p.source_platform, '') = dup.sp
  AND p.id <> dup.keep_id;

-- 2. Rebuild the unique index with NULLS NOT DISTINCT.
DROP INDEX IF EXISTS partner_stats_hourly_unattr_unique;
CREATE UNIQUE INDEX partner_stats_hourly_unattr_unique
  ON partner_stats_hourly
     (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform)
  NULLS NOT DISTINCT
  WHERE campaign_ext_id IS NULL;

-- 3. Refresh the MV so the over-counted unattributed buckets drop immediately.
REFRESH MATERIALIZED VIEW joined_stats_hourly;
