-- Migration 023: add dim_id to taboola_geo_cost_daily
--
-- For dim_type='site' rows this stores Taboola's numeric publisher site_id.
-- VERIFIED (Jun 1-7, live): Image Advantage's partner_stats_hourly.item_ext_id
-- IS the Taboola site_id — 149/150 ids match, covering 100% of IA revenue
-- ($750.47/$750.47). Joining cost rows (by dim_id) to IA revenue (by
-- item_ext_id) gives the Site tab real per-site revenue/profit/margin.
-- device/country rows leave dim_id NULL.

ALTER TABLE taboola_geo_cost_daily
  ADD COLUMN IF NOT EXISTS dim_id TEXT;
