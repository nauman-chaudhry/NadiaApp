-- Migration 024: Outbrain cost schema (campaigns + hourly/daily stats)
--
-- Outbrain REVENUE already flows into partner_stats_hourly with
-- source_platform='Outbrain' (Codefuel side, 14k+ rows). This migration adds
-- the COST side: per-campaign hourly/daily spend pulled from the Outbrain
-- Amplify API.
--
-- TIMEZONE: every hour_utc / day_utc value stored here is TRUE UTC. The
-- Outbrain API reports America/New_York local time; the sync layer
-- (outbrain-tz.ts) converts on ingest. Daily is re-aggregated from the
-- UTC hourly rows, never from Outbrain's EDT day boundary.

INSERT INTO client_partners (code, name)
VALUES ('outbrain', 'Outbrain')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS outbrain_campaigns (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT UNIQUE NOT NULL,        -- Outbrain campaign id
  campaign_name TEXT,
  marketer_id  TEXT NOT NULL,               -- Outbrain marketer id
  account_code TEXT,                        -- SBH_ssm_01 .. 07 (Nadia's label)
  account_name TEXT,
  status       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ob_camp_marketer ON outbrain_campaigns (marketer_id);

CREATE TABLE IF NOT EXISTS outbrain_stats_hourly (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES outbrain_campaigns(campaign_id) ON DELETE CASCADE,
  hour_utc     TIMESTAMPTZ NOT NULL,        -- UTC (converted from NY on ingest)
  impressions  BIGINT  DEFAULT 0,
  clicks       BIGINT  DEFAULT 0,
  conversions  BIGINT  DEFAULT 0,
  spent        NUMERIC(15,4) DEFAULT 0,
  fetched_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, hour_utc)
);
CREATE INDEX IF NOT EXISTS idx_ob_hourly_hour ON outbrain_stats_hourly (hour_utc);

CREATE TABLE IF NOT EXISTS outbrain_stats_daily (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES outbrain_campaigns(campaign_id) ON DELETE CASCADE,
  day_utc      DATE NOT NULL,               -- UTC day (re-aggregated from hourly)
  impressions  BIGINT  DEFAULT 0,
  clicks       BIGINT  DEFAULT 0,
  conversions  BIGINT  DEFAULT 0,
  spent        NUMERIC(15,4) DEFAULT 0,
  UNIQUE (campaign_id, day_utc)
);
