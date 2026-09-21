-- Migration 038: Outbrain account-level HOURLY cost.
--
-- The Amplify API rejects breakdown=hourly on /periodic, but breakdown=hourOfDay
-- with from=to=<single day> returns that day's 24 hourly buckets at the
-- MARKETER (account) level — which is exactly the account-level hourly cost
-- Nadia asked for. Per-campaign hourly remains unavailable.
--
-- hour_utc: Outbrain reports in the marketer's timezone (EDT). We convert
-- EDT -> UTC (+4h) at sync time so the Hourly tab lines up with the rest of
-- the dashboard (which is UTC).
CREATE TABLE IF NOT EXISTS outbrain_marketer_hourly (
  id          BIGSERIAL PRIMARY KEY,
  marketer_id TEXT        NOT NULL,   -- hex marketer ID (= ad_accounts.external_id, platform=outbrain)
  hour_utc    TIMESTAMPTZ NOT NULL,
  impressions BIGINT  DEFAULT 0,
  clicks      BIGINT  DEFAULT 0,
  spent       NUMERIC(15,4) DEFAULT 0,
  conversions BIGINT  DEFAULT 0,
  fetched_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(marketer_id, hour_utc)
);
CREATE INDEX IF NOT EXISTS idx_ob_mkt_hourly_hour ON outbrain_marketer_hourly (hour_utc);
