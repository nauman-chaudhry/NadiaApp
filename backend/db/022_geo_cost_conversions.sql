-- Migration 022: add conversions to taboola_geo_cost_daily
--
-- Taboola's platform/country/site breakdown reports all return cpa_actions_num
-- (conversions). The table previously stored only impressions/clicks/spent, which
-- is why the Device and Country tabs showed Conversions / CVR% / Actual CPA as 0.
-- Site reports (new) use the same table with dim_type='site'.

ALTER TABLE taboola_geo_cost_daily
  ADD COLUMN IF NOT EXISTS conversions BIGINT NOT NULL DEFAULT 0;
