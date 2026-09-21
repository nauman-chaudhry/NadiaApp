-- Migration 010: Add source_platform column to track Codefuel source (Taboola vs Outbrain)

-- Add source_platform column (nullable for backward compat with older rows)
ALTER TABLE partner_stats_hourly
  ADD COLUMN IF NOT EXISTS source_platform TEXT;

-- Create index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_partner_source_platform
  ON partner_stats_hourly (source_platform)
  WHERE source_platform IS NOT NULL;

-- Drop the old unique constraints (they exist without source_platform)
-- We'll recreate them as partial unique indexes that include source_platform
DO $$
BEGIN
  -- Drop constraints if they exist
  BEGIN
    ALTER TABLE partner_stats_hourly DROP CONSTRAINT IF EXISTS partner_stats_hourly_unique;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  BEGIN
    ALTER TABLE partner_stats_hourly DROP CONSTRAINT IF EXISTS partner_stats_hourly_attributed_unique;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END $$;

-- Create partial unique index for unattributed rows (asset_gid based, with source_platform)
CREATE UNIQUE INDEX IF NOT EXISTS partner_stats_hourly_unattr_unique
  ON partner_stats_hourly (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform)
  WHERE campaign_ext_id IS NULL;

-- Create partial unique index for attributed rows (campaign_ext_id based, without source_platform since IA doesn't have it)
CREATE UNIQUE INDEX IF NOT EXISTS partner_stats_hourly_attr_unique
  ON partner_stats_hourly (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)
  WHERE campaign_ext_id IS NOT NULL;
