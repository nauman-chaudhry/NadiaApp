-- =============================================================================
-- Migration 006: Fix MV join semantics + enable CONCURRENT refresh
-- =============================================================================
--
-- Problem: when Codefuel reports revenue for a (gd, r) pair at an hour where
-- Taboola has no cost row, the old MV created orphan rows with NULL
-- campaign_id/campaign_name. Root cause: the join resolved the campaign only
-- when there was a matching cost row; revenue-only hours fell through.
--
-- Additionally, the full historical backfill writes both 'daily' and 'hourly'
-- Codefuel rows for the same campaign-day (the last 14 days). The old UNION ALL
-- picked up both, doubling revenue for those days.
--
-- Fixes:
--   1. ad_canonical CTE (DISTINCT ON gd_param, r_param) ensures each Codefuel
--      row resolves to exactly one campaign, even if the same (gd, r) appears
--      on multiple ads across campaigns (picks the most recently created ad).
--   2. hourly_covered_days CTE tracks which campaign-days already have hourly
--      data, and codefuel_daily excludes those days → no double-counting.
--   3. Both FULL OUTER JOINs are now on campaign_id + hour_utc, so every row
--      resolves to a campaign regardless of whether cost and revenue overlap at
--      the same hour.
--   4. Unique index on (campaign_id, hour_utc) enables CONCURRENT refresh.
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS
WITH

-- Canonical ad lookup: one row per (gd_param, r_param).
-- Most-recently-created ad wins when there are duplicates across campaigns.
ad_canonical AS (
  SELECT DISTINCT ON (gd_param, r_param)
    id          AS ad_id,
    external_id AS taboola_ad_id,
    campaign_id,
    title       AS ad_title,
    gd_param,
    r_param
  FROM ads
  WHERE gd_param IS NOT NULL AND r_param IS NOT NULL
  ORDER BY gd_param, r_param, id DESC
),

-- Campaign metadata with status (one row per campaign)
campaign_meta AS (
  SELECT
    c.id               AS campaign_id,
    c.external_id      AS campaign_external_id,
    c.name             AS campaign_name,
    c.status           AS campaign_status,
    acc.id             AS ad_account_id,
    acc.name           AS ad_account_name,
    pl.code            AS platform
  FROM campaigns c
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  JOIN platforms   pl  ON pl.id  = acc.platform_id
),

-- Taboola cost at campaign + hour level (ad_id is always NULL in raw data)
resolved_cost AS (
  SELECT
    s.campaign_id,
    s.ad_account_id,
    s.hour_utc,
    SUM(s.impressions) AS impressions,
    SUM(s.clicks)      AS clicks,
    SUM(s.spent)       AS spent,
    SUM(s.conversions) AS conversions
  FROM ad_stats_hourly s
  GROUP BY s.campaign_id, s.ad_account_id, s.hour_utc
),

-- Codefuel hourly revenue resolved to campaign (last ~14 days)
codefuel_hourly AS (
  SELECT
    ac.campaign_id,
    p.hour_utc,
    SUM(p.revenue)   AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions)  AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly'
  GROUP BY ac.campaign_id, p.hour_utc
),

-- Campaign-days that have hourly Codefuel data — daily rows for these will be
-- excluded to prevent revenue double-counting after a full backfill.
hourly_covered_days AS (
  SELECT DISTINCT ac.campaign_id, date_trunc('day', p.hour_utc) AS day
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly'
),

-- Codefuel daily revenue — only for days outside the hourly window
codefuel_daily AS (
  SELECT
    ac.campaign_id,
    p.hour_utc  AS day_start,
    SUM(p.revenue)   AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions)  AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  LEFT JOIN hourly_covered_days hcd
         ON hcd.campaign_id = ac.campaign_id
        AND hcd.day          = date_trunc('day', p.hour_utc)
  WHERE p.granularity = 'daily'
    AND hcd.campaign_id IS NULL
  GROUP BY ac.campaign_id, p.hour_utc
),

-- Taboola cost aggregated to day level (for joining with daily Codefuel)
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

-- ── Part 1: Hourly rows ────────────────────────────────────────────────────────
SELECT
  COALESCE(rc.hour_utc,     ch.hour_utc)        AS hour_utc,
  ''::text                                        AS country,
  ''::text                                        AS device,
  NULL::text                                      AS gd_param,
  NULL::text                                      AS r_param,
  NULL::int                                       AS ad_id,
  NULL::text                                      AS ad_title,
  COALESCE(rc.campaign_id,  ch.campaign_id)       AS campaign_id,
  m.campaign_external_id,
  m.campaign_name,
  m.campaign_status,
  COALESCE(rc.ad_account_id, m.ad_account_id)    AS ad_account_id,
  m.ad_account_name,
  m.platform,
  ''::text                                        AS site,
  COALESCE(rc.impressions, 0)                     AS impressions,
  COALESCE(rc.clicks, 0)                          AS clicks,
  COALESCE(rc.spent, 0)                           AS spent,
  COALESCE(rc.conversions, 0)                     AS conversions,
  COALESCE(ch.revenue, 0)                         AS revenue,
  COALESCE(ch.ad_clicks, 0)                       AS ad_clicks,
  COALESCE(ch.sessions, 0)                        AS sessions,
  COALESCE(ch.revenue, 0) - COALESCE(rc.spent, 0) AS profit,
  CASE WHEN COALESCE(ch.revenue, 0) = 0 THEN 0
       ELSE (COALESCE(ch.revenue, 0) - COALESCE(rc.spent, 0)) / ch.revenue * 100.0
  END                                             AS margin_pct
FROM resolved_cost rc
FULL OUTER JOIN codefuel_hourly ch
  ON  ch.campaign_id = rc.campaign_id
  AND ch.hour_utc    = rc.hour_utc
LEFT JOIN campaign_meta m
  ON  m.campaign_id = COALESCE(rc.campaign_id, ch.campaign_id)

UNION ALL

-- ── Part 2: Daily rows (pre-14-day historical window) ─────────────────────────
SELECT
  COALESCE(td.day_start,    cd.day_start)        AS hour_utc,
  ''::text                                        AS country,
  ''::text                                        AS device,
  NULL::text                                      AS gd_param,
  NULL::text                                      AS r_param,
  NULL::int                                       AS ad_id,
  NULL::text                                      AS ad_title,
  COALESCE(td.campaign_id,  cd.campaign_id)       AS campaign_id,
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
  ON  m.campaign_id = COALESCE(td.campaign_id, cd.campaign_id);

-- Regular indexes for query performance
CREATE INDEX IF NOT EXISTS idx_joined_hour     ON joined_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_joined_campaign ON joined_stats_hourly(campaign_id);
CREATE INDEX IF NOT EXISTS idx_joined_status   ON joined_stats_hourly(campaign_status);
CREATE INDEX IF NOT EXISTS idx_joined_account  ON joined_stats_hourly(ad_account_id);

-- Unique index enables REFRESH MATERIALIZED VIEW CONCURRENTLY (no downtime on refresh)
CREATE UNIQUE INDEX IF NOT EXISTS idx_joined_unique
  ON joined_stats_hourly(campaign_id, hour_utc)
  WHERE campaign_id IS NOT NULL;
