-- Fix: Drop the old unique index that doesn't include source_platform

-- Drop old indexes
DROP INDEX IF EXISTS idx_psh_codefuel_unique;
DROP INDEX IF EXISTS idx_psh_ia_unique;
DROP INDEX IF EXISTS partner_stats_hourly_unique;
DROP INDEX IF EXISTS partner_stats_hourly_attributed_unique;
DROP INDEX IF EXISTS partner_stats_hourly_unattr_unique;
DROP INDEX IF EXISTS partner_stats_hourly_attr_unique;

-- Recreate partial unique indexes for unattributed rows (asset_gid based, with source_platform)
CREATE UNIQUE INDEX partner_stats_hourly_unattr_unique
  ON partner_stats_hourly (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform)
  WHERE campaign_ext_id IS NULL;

-- Recreate partial unique indexes for attributed rows (campaign_ext_id based)
CREATE UNIQUE INDEX partner_stats_hourly_attr_unique
  ON partner_stats_hourly (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)
  WHERE campaign_ext_id IS NOT NULL;
