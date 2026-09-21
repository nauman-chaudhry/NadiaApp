-- Migration 009: Extend joined_stats_hourly MV to include Image Advantage revenue.
--
-- Image Advantage rows in partner_stats_hourly carry campaign_ext_id / item_ext_id
-- (Taboola campaign_id / item_id) instead of asset_gid / channel.
-- The join path is: p.campaign_ext_id → campaigns.external_id,
-- filtered to accounts where client_partner_id = 'image_advantage'.
-- The client_partner_id filter is critical — Taboola campaign external_ids are
-- NOT globally unique across accounts; without it an IA revenue row could
-- accidentally join to a Codefuel-account campaign with the same external_id.
--
-- Strategy: keep existing Codefuel CTEs untouched; add parallel IA CTEs;
-- merge both into combined attributed_hourly / attributed_daily before
-- feeding Parts 1 and 2. Parts 3/4 (unattributed Codefuel) unchanged.

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

-- ── Codefuel attributed revenue (hourly) ──────────────────────────────────────
codefuel_hourly AS (
  SELECT ac.campaign_id, p.hour_utc,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly' AND p.campaign_ext_id IS NULL
  GROUP BY ac.campaign_id, p.hour_utc
),
hourly_covered_days_cf AS (
  SELECT DISTINCT ac.campaign_id, date_trunc('day', p.hour_utc) AS day
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly' AND p.campaign_ext_id IS NULL
),

-- ── Codefuel attributed revenue (daily) ───────────────────────────────────────
codefuel_daily AS (
  SELECT ac.campaign_id, p.hour_utc AS day_start,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  LEFT JOIN hourly_covered_days_cf hcd
    ON hcd.campaign_id = ac.campaign_id AND hcd.day = date_trunc('day', p.hour_utc)
  WHERE p.granularity = 'daily' AND p.campaign_ext_id IS NULL AND hcd.campaign_id IS NULL
  GROUP BY ac.campaign_id, p.hour_utc
),

-- ── Image Advantage attributed revenue (hourly) ───────────────────────────────
ia_hourly AS (
  SELECT c.id AS campaign_id, p.hour_utc,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN campaigns   c   ON c.external_id  = p.campaign_ext_id
  JOIN ad_accounts acc ON acc.id         = c.ad_account_id
  JOIN client_partners cp ON cp.id       = acc.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.granularity = 'hourly' AND p.campaign_ext_id IS NOT NULL
  GROUP BY c.id, p.hour_utc
),
hourly_covered_days_ia AS (
  SELECT DISTINCT c.id AS campaign_id, date_trunc('day', p.hour_utc) AS day
  FROM partner_stats_hourly p
  JOIN campaigns   c   ON c.external_id  = p.campaign_ext_id
  JOIN ad_accounts acc ON acc.id         = c.ad_account_id
  JOIN client_partners cp ON cp.id       = acc.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.granularity = 'hourly' AND p.campaign_ext_id IS NOT NULL
),

-- ── Image Advantage attributed revenue (daily) ────────────────────────────────
ia_daily AS (
  SELECT c.id AS campaign_id, p.hour_utc AS day_start,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN campaigns   c   ON c.external_id  = p.campaign_ext_id
  JOIN ad_accounts acc ON acc.id         = c.ad_account_id
  JOIN client_partners cp ON cp.id       = acc.client_partner_id AND cp.code = 'image_advantage'
  LEFT JOIN hourly_covered_days_ia ihcd
    ON ihcd.campaign_id = c.id AND ihcd.day = date_trunc('day', p.hour_utc)
  WHERE p.granularity = 'daily' AND p.campaign_ext_id IS NOT NULL AND ihcd.campaign_id IS NULL
  GROUP BY c.id, p.hour_utc
),

-- ── Merge Codefuel + IA into combined attributed revenue ──────────────────────
-- GROUP BY re-aggregates in case the same campaign_id ever appears in both
-- (should never happen in practice — campaigns belong to one partner only).
attributed_hourly AS (
  SELECT campaign_id, hour_utc,
    SUM(revenue) AS revenue, SUM(ad_clicks) AS ad_clicks, SUM(sessions) AS sessions
  FROM (
    SELECT campaign_id, hour_utc, revenue, ad_clicks, sessions FROM codefuel_hourly
    UNION ALL
    SELECT campaign_id, hour_utc, revenue, ad_clicks, sessions FROM ia_hourly
  ) sub
  GROUP BY campaign_id, hour_utc
),
attributed_daily AS (
  SELECT campaign_id, day_start,
    SUM(revenue) AS revenue, SUM(ad_clicks) AS ad_clicks, SUM(sessions) AS sessions
  FROM (
    SELECT campaign_id, day_start, revenue, ad_clicks, sessions FROM codefuel_daily
    UNION ALL
    SELECT campaign_id, day_start, revenue, ad_clicks, sessions FROM ia_daily
  ) sub
  GROUP BY campaign_id, day_start
),

-- Campaign-days handled by Part 2 (daily revenue, no hourly).
-- resolved_cost_hourly excludes these to prevent duplicate (campaign_id, hour_utc).
part2_days AS (
  SELECT DISTINCT campaign_id, day_start AS day FROM attributed_daily
),

-- Taboola cost aggregated to day level (for Part 2 joins)
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

-- ── Unattributed Codefuel revenue (no matching ad) ────────────────────────────
unattributed_hourly AS (
  SELECT p.asset_gid, p.channel, p.hour_utc,
    SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  LEFT JOIN ad_canonical ac ON ac.gd_param = p.asset_gid AND ac.r_param = p.channel
  WHERE p.granularity = 'hourly' AND p.campaign_ext_id IS NULL AND ac.campaign_id IS NULL
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
    AND p.campaign_ext_id IS NULL
    AND ac.campaign_id IS NULL
    AND hcu.asset_gid IS NULL
  GROUP BY p.asset_gid, p.channel, p.hour_utc
)

-- ═══ Part 1: Attributed hourly rows (Codefuel + IA) ═══════════════════════════
SELECT
  COALESCE(rc.hour_utc, ah.hour_utc)             AS hour_utc,
  ''::text AS country, ''::text AS device,
  NULL::text AS gd_param, NULL::text AS r_param,
  NULL::int  AS ad_id,   NULL::text AS ad_title,
  COALESCE(rc.campaign_id, ah.campaign_id)        AS campaign_id,
  m.campaign_external_id, m.campaign_name, m.campaign_status,
  COALESCE(rc.ad_account_id, m.ad_account_id)    AS ad_account_id,
  m.ad_account_name, m.platform, ''::text AS site,
  COALESCE(rc.impressions,0) AS impressions,
  COALESCE(rc.clicks,0)      AS clicks,
  COALESCE(rc.spent,0)       AS spent,
  COALESCE(rc.conversions,0) AS conversions,
  COALESCE(ah.revenue,0)     AS revenue,
  COALESCE(ah.ad_clicks,0)   AS ad_clicks,
  COALESCE(ah.sessions,0)    AS sessions,
  COALESCE(ah.revenue,0) - COALESCE(rc.spent,0)  AS profit,
  CASE WHEN COALESCE(ah.revenue,0) = 0 THEN 0
       ELSE (COALESCE(ah.revenue,0) - COALESCE(rc.spent,0))
            / ah.revenue * 100.0 END              AS margin_pct
FROM resolved_cost_hourly rc
FULL OUTER JOIN attributed_hourly ah
  ON ah.campaign_id = rc.campaign_id AND ah.hour_utc = rc.hour_utc
LEFT JOIN campaign_meta m
  ON m.campaign_id = COALESCE(rc.campaign_id, ah.campaign_id)

UNION ALL

-- ═══ Part 2: Attributed daily rows (Codefuel + IA) ════════════════════════════
SELECT
  COALESCE(td.day_start, ad_rev.day_start)        AS hour_utc,
  ''::text, ''::text, NULL::text, NULL::text, NULL::int, NULL::text,
  COALESCE(td.campaign_id, ad_rev.campaign_id)    AS campaign_id,
  m.campaign_external_id, m.campaign_name, m.campaign_status,
  COALESCE(td.ad_account_id, m.ad_account_id)    AS ad_account_id,
  m.ad_account_name, m.platform, ''::text,
  COALESCE(td.impressions,0), COALESCE(td.clicks,0),
  COALESCE(td.spent,0),       COALESCE(td.conversions,0),
  COALESCE(ad_rev.revenue,0), COALESCE(ad_rev.ad_clicks,0),
  COALESCE(ad_rev.sessions,0),
  COALESCE(ad_rev.revenue,0) - COALESCE(td.spent,0) AS profit,
  CASE WHEN COALESCE(ad_rev.revenue,0) = 0 THEN 0
       ELSE (COALESCE(ad_rev.revenue,0) - COALESCE(td.spent,0))
            / ad_rev.revenue * 100.0 END          AS margin_pct
FROM attributed_daily ad_rev
LEFT JOIN taboola_by_day td
  ON td.campaign_id = ad_rev.campaign_id AND td.day_start = ad_rev.day_start
LEFT JOIN campaign_meta m
  ON m.campaign_id = COALESCE(td.campaign_id, ad_rev.campaign_id)

UNION ALL

-- ═══ Part 3: Unattributed hourly Codefuel revenue ═════════════════════════════
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

-- ═══ Part 4: Unattributed daily Codefuel revenue ══════════════════════════════
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
-- Unique index for CONCURRENT refresh (attributed rows only — NULL campaign_id excluded)
CREATE UNIQUE INDEX IF NOT EXISTS idx_joined_unique
  ON joined_stats_hourly(campaign_id, hour_utc)
  WHERE campaign_id IS NOT NULL;
-- Performance index for unattributed rows
CREATE INDEX IF NOT EXISTS idx_joined_unattributed
  ON joined_stats_hourly(gd_param, r_param, hour_utc)
  WHERE campaign_id IS NULL;
