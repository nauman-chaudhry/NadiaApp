-- =============================================================================
-- Nadia Solutions Dashboard — Schema v1
-- Phase 1: Taboola + Outbrain (cost) × Codefuel/Perion (revenue)
-- =============================================================================

-- ---------- Reference tables ----------

CREATE TABLE IF NOT EXISTS platforms (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,     -- 'taboola' | 'outbrain' | 'facebook' | 'google'
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO platforms (code, name) VALUES
  ('taboola',  'Taboola'),
  ('outbrain', 'Outbrain'),
  ('facebook', 'Facebook'),
  ('google',   'Google Ads')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS client_partners (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,     -- 'codefuel' | 'image_advantage' | 'media_net' | 'brightsync'
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO client_partners (code, name) VALUES
  ('codefuel',         'Codefuel / Perion'),
  ('image_advantage',  'Image Advantage'),
  ('media_net',        'Media.net'),
  ('brightsync',       'Brightsync')
ON CONFLICT (code) DO NOTHING;

-- ---------- Ad-platform accounts ----------
-- One row per Taboola/Outbrain account. Maps to the client partner monetizing it.
-- New sub-accounts under the parent Taboola network are discovered automatically
-- by the metadata cron and inserted here; client_partner_id stays NULL until
-- Nadia tags them (one-line UPDATE in the admin UI, later).

CREATE TABLE IF NOT EXISTS ad_accounts (
  id                 SERIAL PRIMARY KEY,
  platform_id        INT NOT NULL REFERENCES platforms(id),
  external_id        TEXT NOT NULL,            -- Taboola account_id / Outbrain marketer_id
  name               TEXT NOT NULL,
  client_partner_id  INT REFERENCES client_partners(id),  -- which monetizer this feeds
  status             TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'inactive'
  currency           TEXT DEFAULT 'USD',
  timezone           TEXT DEFAULT 'UTC',
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_accounts_platform ON ad_accounts(platform_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_status   ON ad_accounts(status);

-- ---------- Campaigns ----------

CREATE TABLE IF NOT EXISTS campaigns (
  id            SERIAL PRIMARY KEY,
  ad_account_id INT NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,    -- Taboola campaign_id (e.g. 48658214)
  name          TEXT NOT NULL,
  status        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ad_account_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(ad_account_id);

-- ---------- Ads (item / creative level) ----------
-- The ad row carries the gd + r URL params that join to Codefuel.

CREATE TABLE IF NOT EXISTS ads (
  id           SERIAL PRIMARY KEY,
  campaign_id  INT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,         -- Taboola item_id
  title        TEXT,
  url          TEXT,                  -- full landing URL containing gd= and r=
  gd_param     TEXT,                  -- extracted from url, joins to Codefuel asset_gid
  r_param      TEXT,                  -- extracted from url, joins to Codefuel channel
  status       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_gd_r     ON ads(gd_param, r_param);

-- ---------- Hourly cost stats from ad platforms ----------
-- Granularity: (ad, hour, country, device, site)
-- COALESCE on NULL fields avoids ON CONFLICT issues since Postgres treats NULL != NULL.

CREATE TABLE IF NOT EXISTS ad_stats_hourly (
  id              BIGSERIAL PRIMARY KEY,
  ad_account_id   INT NOT NULL REFERENCES ad_accounts(id),
  campaign_id     INT NOT NULL REFERENCES campaigns(id),
  ad_id           INT REFERENCES ads(id),
  hour_utc        TIMESTAMPTZ NOT NULL,          -- bucket start, top of hour UTC
  country         TEXT NOT NULL DEFAULT '',      -- ISO-2; '' if absent
  device          TEXT NOT NULL DEFAULT '',      -- 'desktop' | 'mobile' | 'tablet' | ''
  site            TEXT NOT NULL DEFAULT '',
  impressions     BIGINT  DEFAULT 0,
  clicks          BIGINT  DEFAULT 0,
  spent           NUMERIC(14,4) DEFAULT 0,
  conversions     BIGINT  DEFAULT 0,
  fetched_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (ad_account_id, ad_id, hour_utc, country, device, site)
);

CREATE INDEX IF NOT EXISTS idx_ad_stats_hour     ON ad_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_ad_stats_campaign ON ad_stats_hourly(campaign_id, hour_utc);
CREATE INDEX IF NOT EXISTS idx_ad_stats_ad       ON ad_stats_hourly(ad_id, hour_utc);

-- ---------- Hourly/daily revenue stats from client partner (Codefuel) ----------
-- Granularity: (asset_gid, channel, hour, country, device)
-- Codefuel DOES NOT report impressions / clicks / conversions on the IO endpoints —
-- those metrics live on the ad-platform side. Codefuel reports revenue, ad_clicks,
-- sessions, rpc, rpm, ctr.
--
-- granularity column distinguishes 'hourly' rows (last 14 days) from 'daily'
-- rows (older). For daily, hour_utc is set to 00:00 of that day.

CREATE TABLE IF NOT EXISTS partner_stats_hourly (
  id                  BIGSERIAL PRIMARY KEY,
  client_partner_id   INT NOT NULL REFERENCES client_partners(id),
  granularity         TEXT NOT NULL CHECK (granularity IN ('hourly', 'daily')),
  asset_gid           TEXT NOT NULL,             -- ↔ ads.gd_param
  channel             TEXT NOT NULL,             -- ↔ ads.r_param
  hour_utc            TIMESTAMPTZ NOT NULL,      -- top of hour, or 00:00 for daily rows
  country             TEXT NOT NULL DEFAULT '',
  device              TEXT NOT NULL DEFAULT '',
  ad_clicks           BIGINT  DEFAULT 0,
  sessions            BIGINT  DEFAULT 0,
  revenue             NUMERIC(14,4) DEFAULT 0,
  rpc                 NUMERIC(14,4) DEFAULT 0,
  rpm                 NUMERIC(14,4) DEFAULT 0,
  ctr_pct             NUMERIC(8,4)  DEFAULT 0,
  fetched_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device)
);

CREATE INDEX IF NOT EXISTS idx_partner_stats_hour    ON partner_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_partner_stats_gid_ch  ON partner_stats_hourly(asset_gid, channel, hour_utc);

-- ---------- Sync run log ----------

CREATE TABLE IF NOT EXISTS sync_runs (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,              -- 'taboola' | 'outbrain' | 'codefuel'
  job_type     TEXT NOT NULL,              -- 'hourly' | 'daily' | 'daily_backfill' | 'metadata'
  window_start TIMESTAMPTZ,
  window_end   TIMESTAMPTZ,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT DEFAULT 'running',     -- 'running' | 'ok' | 'error'
  rows_written INT DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source_time ON sync_runs(source, started_at DESC);

-- =============================================================================
-- Joined view: cost ⨝ revenue at (ad, hour, country, device)
-- =============================================================================
-- Note: for daily-granularity Codefuel rows (older than 14 days) the hour_utc
-- is the day at 00:00, so they join to the SUM of that day's hourly Taboola
-- rows at day level. The dashboard's "Daily" tab will work correctly across
-- the whole April→today range; the "Hourly" tab only has data for the last
-- 14 days (as Codefuel only provides hourly for that window).

CREATE MATERIALIZED VIEW IF NOT EXISTS joined_stats_hourly AS
WITH ad_meta AS (
  SELECT a.id AS ad_id, a.gd_param, a.r_param, a.title AS ad_title,
         c.id AS campaign_id, c.external_id AS campaign_external_id, c.name AS campaign_name,
         acc.id AS ad_account_id, acc.name AS ad_account_name,
         pl.code AS platform
    FROM ads a
    JOIN campaigns    c   ON c.id   = a.campaign_id
    JOIN ad_accounts  acc ON acc.id = c.ad_account_id
    JOIN platforms    pl  ON pl.id  = acc.platform_id
)
SELECT
  COALESCE(s.hour_utc, p.hour_utc)  AS hour_utc,
  COALESCE(s.country,  p.country)   AS country,
  COALESCE(s.device,   p.device)    AS device,
  m.gd_param,
  m.r_param,
  m.ad_id,
  m.ad_title,
  m.campaign_id,
  m.campaign_external_id,
  m.campaign_name,
  m.ad_account_id,
  m.ad_account_name,
  m.platform,
  s.site,
  COALESCE(s.impressions, 0)        AS impressions,
  COALESCE(s.clicks, 0)             AS clicks,
  COALESCE(s.spent, 0)              AS spent,
  COALESCE(s.conversions, 0)        AS conversions,
  COALESCE(p.revenue, 0)            AS revenue,
  COALESCE(p.ad_clicks, 0)          AS ad_clicks,
  COALESCE(p.sessions, 0)           AS sessions,
  COALESCE(p.revenue, 0) - COALESCE(s.spent, 0)                                 AS profit,
  CASE WHEN COALESCE(p.revenue, 0) = 0 THEN 0
       ELSE (COALESCE(p.revenue, 0) - COALESCE(s.spent, 0)) / p.revenue * 100.0
  END                                                                            AS margin_pct
FROM ad_stats_hourly s
FULL OUTER JOIN partner_stats_hourly p
       ON p.granularity = 'hourly'
      AND p.hour_utc    = s.hour_utc
      AND p.country     = s.country
      AND p.device      = s.device
      AND EXISTS (
            SELECT 1 FROM ads ax
             WHERE ax.id = s.ad_id
               AND ax.gd_param = p.asset_gid
               AND ax.r_param  = p.channel
          )
LEFT JOIN ad_meta m
       ON m.ad_id = s.ad_id
       OR (s.ad_id IS NULL AND m.gd_param = p.asset_gid AND m.r_param = p.channel);

CREATE INDEX IF NOT EXISTS idx_joined_hour     ON joined_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_joined_campaign ON joined_stats_hourly(campaign_id);
CREATE INDEX IF NOT EXISTS idx_joined_country  ON joined_stats_hourly(country);
CREATE INDEX IF NOT EXISTS idx_joined_device   ON joined_stats_hourly(device);

-- Refresh helper
-- REFRESH MATERIALIZED VIEW joined_stats_hourly;
-- (For CONCURRENTLY refresh we'd need a unique index; v1 uses plain refresh.)
