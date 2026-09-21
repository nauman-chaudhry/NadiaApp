-- Migration 036: Outbrain per-ad, per-country, per-publisher breakdown tables.
--
-- Three new tables for daily Outbrain breakdown data fetched via:
--   /reports/marketers/{id}/promotedContent   -> outbrain_ad_daily
--   /reports/marketers/{id}/geo?breakdown=country -> outbrain_country_daily
--   /reports/marketers/{id}/publishers           -> outbrain_publisher_daily
--
-- Grain: all three are DAILY (the finest grain Outbrain exposes for these dims).
-- day_utc holds Outbrain's reported EDT calendar day — consistent with
-- outbrain_stats_daily which uses the same convention.
--
-- Country and Publisher rows are per-MARKETER (no campaign_id) because the API
-- returns marketer-level aggregates for those dimensions.
-- Ad rows carry campaign_id + gd/r params for Codefuel revenue attribution.

-- ── Outbrain ad (promoted-link) daily cost ──────────────────────────────────
CREATE TABLE IF NOT EXISTS outbrain_ad_daily (
  id                 BIGSERIAL PRIMARY KEY,
  campaign_id        TEXT    NOT NULL REFERENCES outbrain_campaigns(campaign_id) ON DELETE CASCADE,
  promoted_link_id   TEXT    NOT NULL,  -- metadata.identifier (numeric string)
  promoted_link_uuid TEXT,              -- metadata.id (hex UUID)
  ad_title           TEXT,
  landing_url        TEXT,
  gd_param           TEXT,             -- extracted from landing_url; used to join CF revenue
  r_param            TEXT,
  marketer_id        TEXT,             -- hex marketer ID
  day_utc            DATE    NOT NULL,
  impressions        BIGINT  DEFAULT 0,
  clicks             BIGINT  DEFAULT 0,
  spent              NUMERIC(15,4) DEFAULT 0,
  conversions        BIGINT  DEFAULT 0,
  UNIQUE(promoted_link_id, day_utc)
);
CREATE INDEX IF NOT EXISTS idx_ob_ad_daily_day      ON outbrain_ad_daily (day_utc);
CREATE INDEX IF NOT EXISTS idx_ob_ad_daily_campaign ON outbrain_ad_daily (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ob_ad_daily_gdr      ON outbrain_ad_daily (gd_param, r_param);

-- ── Outbrain country daily cost ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbrain_country_daily (
  id           BIGSERIAL PRIMARY KEY,
  marketer_id  TEXT    NOT NULL,   -- hex marketer ID (= outbrain_campaigns.marketer_id = ad_accounts.external_id)
  country_code TEXT    NOT NULL,   -- metadata.code ("US")
  country_name TEXT,               -- metadata.name ("United States")
  day_utc      DATE    NOT NULL,
  impressions  BIGINT  DEFAULT 0,
  clicks       BIGINT  DEFAULT 0,
  spent        NUMERIC(15,4) DEFAULT 0,
  conversions  BIGINT  DEFAULT 0,
  UNIQUE(marketer_id, country_code, day_utc)
);
CREATE INDEX IF NOT EXISTS idx_ob_country_day      ON outbrain_country_daily (day_utc);
CREATE INDEX IF NOT EXISTS idx_ob_country_marketer ON outbrain_country_daily (marketer_id);

-- ── Outbrain publisher (site) daily cost ────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbrain_publisher_daily (
  id             BIGSERIAL PRIMARY KEY,
  marketer_id    TEXT    NOT NULL,
  publisher_id   TEXT    NOT NULL,  -- metadata.identifier (numeric string, e.g. "185361")
  publisher_uuid TEXT,              -- metadata.id (hex UUID)
  publisher_name TEXT,              -- metadata.name ("glance.com")
  publisher_url  TEXT,
  day_utc        DATE    NOT NULL,
  impressions    BIGINT  DEFAULT 0,
  clicks         BIGINT  DEFAULT 0,
  spent          NUMERIC(15,4) DEFAULT 0,
  conversions    BIGINT  DEFAULT 0,
  UNIQUE(marketer_id, publisher_id, day_utc)
);
CREATE INDEX IF NOT EXISTS idx_ob_publisher_day      ON outbrain_publisher_daily (day_utc);
CREATE INDEX IF NOT EXISTS idx_ob_publisher_marketer ON outbrain_publisher_daily (marketer_id);
