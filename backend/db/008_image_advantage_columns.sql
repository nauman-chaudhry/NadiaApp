-- Migration 008: Add Image Advantage join columns to partner_stats_hourly.
--
-- IA rows join via (campaign_ext_id, item_ext_id) instead of (asset_gid, channel).
-- The existing UNIQUE constraint covers all seven columns and requires NOT NULL on
-- asset_gid + channel — which IA rows can't satisfy. Replace it with two partial
-- unique indexes, one per partner type.

-- 1. Add new columns (nullable — Codefuel rows leave these NULL)
ALTER TABLE partner_stats_hourly
  ADD COLUMN IF NOT EXISTS campaign_ext_id TEXT,  -- Taboola campaign_id for IA rows
  ADD COLUMN IF NOT EXISTS item_ext_id     TEXT;  -- Taboola item_id for IA rows

-- 2. Relax NOT NULL on asset_gid / channel so IA rows can omit them
ALTER TABLE partner_stats_hourly
  ALTER COLUMN asset_gid DROP NOT NULL,
  ALTER COLUMN channel   DROP NOT NULL;

-- 3. Drop the existing composite UNIQUE constraint (Postgres truncates the auto-name at 63 chars)
ALTER TABLE partner_stats_hourly
  DROP CONSTRAINT IF EXISTS "partner_stats_hourly_client_partner_id_granularity_asset_gi_key";

-- 4a. Partial unique index for Codefuel/Perion rows (asset_gid + channel key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_psh_codefuel_unique
  ON partner_stats_hourly (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device)
  WHERE campaign_ext_id IS NULL;

-- 4b. Partial unique index for Image Advantage rows (campaign + item key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_psh_ia_unique
  ON partner_stats_hourly (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)
  WHERE campaign_ext_id IS NOT NULL;

-- 5. Speed index for IA join (campaign_ext_id lookup in MV)
CREATE INDEX IF NOT EXISTS idx_psh_campaign_ext
  ON partner_stats_hourly (campaign_ext_id, item_ext_id, hour_utc)
  WHERE campaign_ext_id IS NOT NULL;
