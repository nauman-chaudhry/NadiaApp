-- Fix joined_stats_hourly: migration 004 accidentally used an ad-level FULL
-- OUTER JOIN with an EXISTS(ax.id = s.ad_id) guard that always fails for
-- Taboola's campaign-level rows (ad_id IS NULL), leaving campaign_name /
-- campaign_status NULL for all spend rows.
--
-- This migration replaces it with the correct campaign-level design from
-- migration 002, now extended with campaign_status in campaign_meta.
-- Safe to re-run — DROP … CASCADE removes the old indexes too.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS
WITH

campaign_meta AS (
  SELECT
    c.id                 AS campaign_id,
    c.external_id        AS campaign_external_id,
    c.name               AS campaign_name,
    c.status             AS campaign_status,
    acc.id               AS ad_account_id,
    acc.name             AS ad_account_name,
    pl.code              AS platform
  FROM campaigns c
  JOIN ad_accounts  acc ON acc.id  = c.ad_account_id
  JOIN platforms    pl  ON pl.id   = acc.platform_id
),

codefuel_hourly AS (
  SELECT
    a.campaign_id,
    p.hour_utc,
    SUM(p.revenue)    AS revenue,
    SUM(p.ad_clicks)  AS ad_clicks,
    SUM(p.sessions)   AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE p.granularity = 'hourly'
  GROUP BY a.campaign_id, p.hour_utc
),

codefuel_daily AS (
  SELECT
    a.campaign_id,
    p.hour_utc        AS day_start,
    SUM(p.revenue)    AS revenue,
    SUM(p.ad_clicks)  AS ad_clicks,
    SUM(p.sessions)   AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE p.granularity = 'daily'
  GROUP BY a.campaign_id, p.hour_utc
),

taboola_by_day AS (
  SELECT
    campaign_id,
    ad_account_id,
    date_trunc('day', hour_utc) AS day_start,
    SUM(impressions)            AS impressions,
    SUM(clicks)                 AS clicks,
    SUM(spent)                  AS spent,
    SUM(conversions)            AS conversions
  FROM ad_stats_hourly
  GROUP BY campaign_id, ad_account_id, date_trunc('day', hour_utc)
)

-- Part 1: Hourly rows
SELECT
  COALESCE(s.hour_utc,      ch.hour_utc)        AS hour_utc,
  ''::text                                        AS country,
  ''::text                                        AS device,
  NULL::text                                      AS gd_param,
  NULL::text                                      AS r_param,
  NULL::int                                       AS ad_id,
  NULL::text                                      AS ad_title,
  COALESCE(s.campaign_id,   ch.campaign_id)       AS campaign_id,
  m.campaign_external_id,
  m.campaign_name,
  m.campaign_status,
  COALESCE(s.ad_account_id, m.ad_account_id)     AS ad_account_id,
  m.ad_account_name,
  m.platform,
  ''::text                                        AS site,
  COALESCE(s.impressions, 0)                      AS impressions,
  COALESCE(s.clicks, 0)                           AS clicks,
  COALESCE(s.spent, 0)                            AS spent,
  COALESCE(s.conversions, 0)                      AS conversions,
  COALESCE(ch.revenue, 0)                         AS revenue,
  COALESCE(ch.ad_clicks, 0)                       AS ad_clicks,
  COALESCE(ch.sessions, 0)                        AS sessions,
  COALESCE(ch.revenue, 0) - COALESCE(s.spent, 0)  AS profit,
  CASE WHEN COALESCE(ch.revenue, 0) = 0 THEN 0
       ELSE (COALESCE(ch.revenue, 0) - COALESCE(s.spent, 0)) / ch.revenue * 100.0
  END                                             AS margin_pct
FROM ad_stats_hourly s
FULL OUTER JOIN codefuel_hourly ch
  ON  ch.campaign_id = s.campaign_id
  AND ch.hour_utc    = s.hour_utc
LEFT JOIN campaign_meta m
  ON  m.campaign_id  = COALESCE(s.campaign_id, ch.campaign_id)

UNION ALL

-- Part 2: Daily rows (historical backfill)
SELECT
  cd.day_start                                    AS hour_utc,
  ''::text                                        AS country,
  ''::text                                        AS device,
  NULL::text                                      AS gd_param,
  NULL::text                                      AS r_param,
  NULL::int                                       AS ad_id,
  NULL::text                                      AS ad_title,
  COALESCE(td.campaign_id,   cd.campaign_id)      AS campaign_id,
  m.campaign_external_id,
  m.campaign_name,
  m.campaign_status,
  COALESCE(td.ad_account_id, m.ad_account_id)    AS ad_account_id,
  m.ad_account_name,
  m.platform,
  ''::text                                        AS site,
  COALESCE(td.impressions, 0)                     AS impressions,
  COALESCE(td.clicks, 0)                          AS clicks,
  COALESCE(td.spent, 0)                           AS spent,
  COALESCE(td.conversions, 0)                     AS conversions,
  COALESCE(cd.revenue, 0)                         AS revenue,
  COALESCE(cd.ad_clicks, 0)                       AS ad_clicks,
  COALESCE(cd.sessions, 0)                        AS sessions,
  COALESCE(cd.revenue, 0) - COALESCE(td.spent, 0) AS profit,
  CASE WHEN COALESCE(cd.revenue, 0) = 0 THEN 0
       ELSE (COALESCE(cd.revenue, 0) - COALESCE(td.spent, 0)) / cd.revenue * 100.0
  END                                             AS margin_pct
FROM codefuel_daily cd
LEFT JOIN taboola_by_day td
  ON  td.campaign_id = cd.campaign_id
  AND td.day_start   = cd.day_start
LEFT JOIN campaign_meta m
  ON  m.campaign_id  = COALESCE(td.campaign_id, cd.campaign_id);

CREATE INDEX IF NOT EXISTS idx_joined_hour     ON joined_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_joined_campaign ON joined_stats_hourly(campaign_id);
CREATE INDEX IF NOT EXISTS idx_joined_country  ON joined_stats_hourly(country);
CREATE INDEX IF NOT EXISTS idx_joined_device   ON joined_stats_hourly(device);
CREATE INDEX IF NOT EXISTS idx_joined_status   ON joined_stats_hourly(campaign_status);
