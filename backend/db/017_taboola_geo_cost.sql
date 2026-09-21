-- Migration 017: real per-account daily device/country cost from Taboola.
--
-- WHY: Taboola's hourly reporting API exposes NO device/country/site breakdown
--   (ad_stats_hourly stores those columns empty). The Device and Country report
--   tabs therefore showed ZERO cost ("blue columns always zero"). Taboola DOES
--   expose single-dimension rollups via campaign-summary/dimensions/
--   platform_breakdown and country_breakdown — but only daily (no hour split) and
--   only one dimension at a time (no campaign sub-split). We pull those per
--   advertiser account, per day, and store them here. The Device/Country API
--   queries UNION this cost in alongside the partner revenue.
--
-- GRAIN: (ad_account_id, stat_date, dim_type, dim_value).
--   dim_type = 'device' | 'country'
--   dim_value(device)  = mobile | desktop | tablet | other  (matches partner_stats_hourly.device)
--   dim_value(country) = ISO-2 e.g. US, CA                  (matches partner_stats_hourly.country)

CREATE TABLE IF NOT EXISTS taboola_geo_cost_daily (
  ad_account_id INTEGER     NOT NULL,
  stat_date     DATE        NOT NULL,
  dim_type      TEXT        NOT NULL,   -- 'device' | 'country'
  dim_value     TEXT        NOT NULL,
  impressions   BIGINT      NOT NULL DEFAULT 0,
  clicks        BIGINT      NOT NULL DEFAULT 0,
  spent         NUMERIC     NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ad_account_id, stat_date, dim_type, dim_value)
);

CREATE INDEX IF NOT EXISTS idx_geo_cost_date ON taboola_geo_cost_daily (stat_date);
CREATE INDEX IF NOT EXISTS idx_geo_cost_dim  ON taboola_geo_cost_daily (dim_type, dim_value);
