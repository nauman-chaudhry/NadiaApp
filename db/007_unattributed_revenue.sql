-- Migration 007: Preserve unattributed Codefuel revenue in the MV.
--
-- Also fixes a latent duplicate-row bug introduced in 006:
-- When a campaign has Taboola hourly data AND Codefuel daily data (no hourly)
-- for the same day, Part 1's resolved_cost produces an hourly row at 00:00
-- AND Part 2's codefuel_daily produces a daily row also at 00:00 → duplicate
-- (campaign_id, hour_utc). Fix: filter resolved_cost in Part 1 to exclude
-- campaign-days that are already handled by Part 2.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS
WITH
-- ── Metadata ──────────────────────────────────────────────────────────────────
ad_canonical AS (
  SELECT DISTINCT ON (gd_param, r_param)
    id AS ad_id, external_id AS taboola_ad_id, campaign_id,
    title AS ad_title, gd_param, r_param
  FROM ads
  WHERE gd_param IS NOT NULL AND r_param IS NOT NULL
  ORDER BY gd_param, r_param, id DESC
),
campaign_meta AS (
  SELECT c.id AS campaign_id, c.external_id AS campaign_external_id,
    c.name AS campaign_name, c.status AS campaign_status,
    acc.id AS ad_account_id, acc.name AS ad_account_name, pl.code AS platform
  FROM campaigns c
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  JOIN platforms pl    ON pl.id  = acc.platform_id
),

-- ── Cost side ─────────────────────────────────────────────────────────────────
resolved_cost AS (
  SELECT s.campaign_id, s.ad_account_id, s.hour_utc,
    SUM(s.impressions) AS impressions, SUM(s.clicks) AS clicks,
    SUM(s.spent)       AS spent,       SUM(s.conversions) AS conversions
  FROM ad_stats_hourly s
  GROUP BY s.campaign_id, s.ad_account_id, s.hour_utc
),

-- ── Attributed revenue (hourly) ────────────────────────────────────────────────
codefuel_hourly AS (
  SELECT ac.campaign_id, p.hour_utc,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly'
  GROUP BY ac.campaign_id, p.hour_utc
),

-- Campaign-days covered by Codefuel hourly data (prevent daily double-count)
hourly_covered_days AS (
  SELECT DISTINCT ac.campaign_id, date_trunc('day', p.hour_utc) AS day
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly'
),

-- ── Attributed revenue (daily) ─────────────────────────────────────────────────
-- Only campaign-days without Codefuel hourly coverage (older history)
codefuel_daily AS (
  SELECT ac.campaign_id, p.hour_utc AS day_start,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  LEFT JOIN hourly_covered_days hcd
    ON hcd.campaign_id = ac.campaign_id AND hcd.day = date_trunc('day', p.hour_utc)
  WHERE p.granularity = 'daily' AND hcd.campaign_id IS NULL
  GROUP BY ac.campaign_id, p.hour_utc
),

-- Campaign-days handled by Part 2 (daily Codefuel, no hourly Codefuel).
-- Part 1's resolved_cost must exclude these to prevent duplicate (campaign_id, hour_utc)
-- rows at midnight when Taboola has an hourly row at 00:00 for the same day.
part2_days AS (
  SELECT DISTINCT campaign_id, day_start AS day FROM codefuel_daily
),

-- Taboola cost aggregated to day level (for Part 2 joins and edge cases)
taboola_by_day AS (
  SELECT campaign_id, ad_account_id,
    date_trunc('day', hour_utc) AS day_start,
    SUM(impressions) AS impressions, SUM(clicks) AS clicks,
    SUM(spent)       AS spent,       SUM(conversions) AS conversions
  FROM ad_stats_hourly
  GROUP BY campaign_id, ad_account_id, date_trunc('day', hour_utc)
),

-- resolved_cost filtered to only campaign-hours NOT delegated to Part 2
resolved_cost_hourly AS (
  SELECT rc.*
  FROM resolved_cost rc
  LEFT JOIN part2_days p2
    ON p2.campaign_id = rc.campaign_id AND p2.day = date_trunc('day', rc.hour_utc)
  WHERE p2.campaign_id IS NULL
),

-- ── Unattributed revenue (no matching ad) ─────────────────────────────────────
unattributed_hourly AS (
  SELECT p.asset_gid, p.channel, p.hour_utc,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  LEFT JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly' AND ac.campaign_id IS NULL
  GROUP BY p.asset_gid, p.channel, p.hour_utc
),
hourly_covered_unattributed AS (
  SELECT DISTINCT asset_gid, channel, date_trunc('day', hour_utc) AS day
  FROM unattributed_hourly
),
unattributed_daily AS (
  SELECT p.asset_gid, p.channel, p.hour_utc AS day_start,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  LEFT JOIN ad_canonical ac  ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  LEFT JOIN hourly_covered_unattributed hcu
    ON hcu.asset_gid = p.asset_gid AND hcu.channel = p.channel
   AND hcu.day = date_trunc('day', p.hour_utc)
  WHERE p.granularity = 'daily'
    AND ac.campaign_id IS NULL
    AND hcu.asset_gid IS NULL
  GROUP BY p.asset_gid, p.channel, p.hour_utc
)

-- ═══ Part 1: Attributed hourly rows ═══════════════════════════════════════════
-- Uses resolved_cost_hourly (excludes campaign-days delegated to Part 2)
SELECT
  COALESCE(rc.hour_utc, ch.hour_utc)            AS hour_utc,
  ''::text AS country, ''::text AS device,
  NULL::text AS gd_param, NULL::text AS r_param,
  NULL::int  AS ad_id,   NULL::text AS ad_title,
  COALESCE(rc.campaign_id, ch.campaign_id)       AS campaign_id,
  m.campaign_external_id, m.campaign_name, m.campaign_status,
  COALESCE(rc.ad_account_id, m.ad_account_id)   AS ad_account_id,
  m.ad_account_name, m.platform, ''::text AS site,
  COALESCE(rc.impressions,0) AS impressions,
  COALESCE(rc.clicks,0)      AS clicks,
  COALESCE(rc.spent,0)       AS spent,
  COALESCE(rc.conversions,0) AS conversions,
  COALESCE(ch.revenue,0)     AS revenue,
  COALESCE(ch.ad_clicks,0)   AS ad_clicks,
  COALESCE(ch.sessions,0)    AS sessions,
  COALESCE(ch.revenue,0) - COALESCE(rc.spent,0) AS profit,
  CASE WHEN COALESCE(ch.revenue,0) = 0 THEN 0
       ELSE (COALESCE(ch.revenue,0) - COALESCE(rc.spent,0))
            / ch.revenue * 100.0 END             AS margin_pct
FROM resolved_cost_hourly rc
FULL OUTER JOIN codefuel_hourly ch
  ON ch.campaign_id = rc.campaign_id AND ch.hour_utc = rc.hour_utc
LEFT JOIN campaign_meta m
  ON m.campaign_id = COALESCE(rc.campaign_id, ch.campaign_id)

UNION ALL

-- ═══ Part 2: Attributed daily rows ════════════════════════════════════════════
-- Campaign-days where Codefuel has daily (not hourly) coverage.
-- Taboola cost is aggregated to day level to match the daily revenue granularity.
SELECT
  COALESCE(td.day_start, cd.day_start)           AS hour_utc,
  ''::text, ''::text, NULL::text, NULL::text, NULL::int, NULL::text,
  COALESCE(td.campaign_id, cd.campaign_id)       AS campaign_id,
  m.campaign_external_id, m.campaign_name, m.campaign_status,
  COALESCE(td.ad_account_id, m.ad_account_id)   AS ad_account_id,
  m.ad_account_name, m.platform, ''::text,
  COALESCE(td.impressions,0), COALESCE(td.clicks,0),
  COALESCE(td.spent,0),       COALESCE(td.conversions,0),
  COALESCE(cd.revenue,0),     COALESCE(cd.ad_clicks,0),
  COALESCE(cd.sessions,0),
  COALESCE(cd.revenue,0) - COALESCE(td.spent,0) AS profit,
  CASE WHEN COALESCE(cd.revenue,0) = 0 THEN 0
       ELSE (COALESCE(cd.revenue,0) - COALESCE(td.spent,0))
            / cd.revenue * 100.0 END             AS margin_pct
FROM codefuel_daily cd
LEFT JOIN taboola_by_day td
  ON td.campaign_id = cd.campaign_id AND td.day_start = cd.day_start
LEFT JOIN campaign_meta m
  ON m.campaign_id = COALESCE(td.campaign_id, cd.campaign_id)

UNION ALL

-- ═══ Part 3: Unattributed hourly revenue ══════════════════════════════════════
SELECT
  u.hour_utc,
  ''::text, ''::text,
  u.asset_gid AS gd_param, u.channel AS r_param,
  NULL::int, NULL::text,
  NULL::int  AS campaign_id,
  NULL::text AS campaign_external_id,
  '(Unattributed revenue)'::text AS campaign_name,
  NULL::text AS campaign_status,
  NULL::int  AS ad_account_id,
  NULL::text AS ad_account_name,
  NULL::text AS platform, ''::text AS site,
  0, 0, 0, 0,
  u.revenue, u.ad_clicks, u.sessions,
  u.revenue AS profit,
  100.0      AS margin_pct
FROM unattributed_hourly u

UNION ALL

-- ═══ Part 4: Unattributed daily revenue ═══════════════════════════════════════
SELECT
  u.day_start AS hour_utc,
  ''::text, ''::text,
  u.asset_gid, u.channel,
  NULL::int, NULL::text,
  NULL::int, NULL::text,
  '(Unattributed revenue)'::text,
  NULL::text, NULL::int, NULL::text, NULL::text, ''::text,
  0, 0, 0, 0,
  u.revenue, u.ad_clicks, u.sessions,
  u.revenue AS profit,
  100.0      AS margin_pct
FROM unattributed_daily u;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_joined_hour     ON joined_stats_hourly(hour_utc);
CREATE INDEX IF NOT EXISTS idx_joined_campaign ON joined_stats_hourly(campaign_id);
CREATE INDEX IF NOT EXISTS idx_joined_status   ON joined_stats_hourly(campaign_status);
CREATE INDEX IF NOT EXISTS idx_joined_account  ON joined_stats_hourly(ad_account_id);
-- Unique index for CONCURRENT refresh (attributed rows only — NULL campaign_id rows excluded)
CREATE UNIQUE INDEX IF NOT EXISTS idx_joined_unique
  ON joined_stats_hourly(campaign_id, hour_utc)
  WHERE campaign_id IS NOT NULL;
-- Performance index for unattributed rows
CREATE INDEX IF NOT EXISTS idx_joined_unattributed
  ON joined_stats_hourly(gd_param, r_param, hour_utc)
  WHERE campaign_id IS NULL;
