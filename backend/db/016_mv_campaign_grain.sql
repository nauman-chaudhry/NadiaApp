-- Migration 016: MV rebuilt at campaign grain (cost has no ad_id / no geo)
--
-- ROOT CAUSE (confirmed against live DB):
--   * ad_stats_hourly.ad_id is NULL on 100% of rows; campaign_id is always SET.
--   * ad_stats_hourly has NO country/device (always ''); cost is campaign-level only.
--   * Codefuel revenue is geo-split (country/device SET); IA revenue is geo='' .
--
-- FIXES:
--   A) Cost CTE keys on s.campaign_id directly (NOT a.campaign_id via the always-NULL ad_id).
--      -> cost rows now carry campaign_id, eliminating the all-NULL-key collision (117 dups).
--   B) Merge (FULL OUTER JOIN) on (campaign_id, hour, country, device, ad_account_id).
--      -> IA cost+revenue co-locate (both geo=''); Codefuel reconciles at campaign level
--         (its revenue is geo-split, cost has no geo, so they stay on adjacent rows).
--   C) Orphan revenue (no campaign match) attributed to account via channel; campaign_id NULL.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

WITH
-- ============================================================================
-- Cost: campaign-level (ad_id always NULL in source). Key on s.campaign_id.
-- ============================================================================
cost AS (
  SELECT
    s.campaign_id,
    s.hour_utc,
    COALESCE(s.country, '')::TEXT AS country,
    COALESCE(s.device, '')::TEXT  AS device,
    s.site,
    s.ad_account_id,
    c.external_id::TEXT AS campaign_external_id,
    c.name::TEXT        AS campaign_name,
    SUM(s.impressions)::BIGINT AS impressions,
    SUM(s.clicks)::BIGINT      AS clicks,
    SUM(s.conversions)::BIGINT AS conversions,
    SUM(s.spent)::NUMERIC      AS spent
  FROM ad_stats_hourly s
  LEFT JOIN campaigns c ON c.id = s.campaign_id
  GROUP BY s.campaign_id, s.hour_utc, s.country, s.device, s.site, s.ad_account_id,
           c.external_id, c.name
),

-- ============================================================================
-- Codefuel attributed revenue: asset_gid/channel -> ads -> campaign
-- ============================================================================
codefuel_attributed AS (
  SELECT
    a.campaign_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT  AS device,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC   AS revenue,
    SUM(p.ad_clicks)::BIGINT  AS ad_clicks,
    SUM(p.sessions)::BIGINT   AS sessions,
    'Taboola'::TEXT           AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN ads a       ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  GROUP BY a.campaign_id, p.hour_utc, p.country, p.device, c.ad_account_id
),

-- ============================================================================
-- IA attributed revenue: campaign_ext_id -> campaigns
-- ============================================================================
ia_attributed AS (
  SELECT
    c.id AS campaign_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT  AS device,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC   AS revenue,
    SUM(p.ad_clicks)::BIGINT  AS ad_clicks,
    SUM(p.sessions)::BIGINT   AS sessions,
    NULL::TEXT                AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  JOIN campaigns c        ON c.external_id = p.campaign_ext_id
  WHERE p.campaign_ext_id IS NOT NULL
  GROUP BY c.id, p.hour_utc, p.country, p.device, c.ad_account_id
),

all_attributed_revenue AS (
  SELECT campaign_id, hour_utc, country, device, ad_account_id, revenue, ad_clicks, sessions, source_platform
  FROM codefuel_attributed
  UNION ALL
  SELECT campaign_id, hour_utc, country, device, ad_account_id, revenue, ad_clicks, sessions, source_platform
  FROM ia_attributed
),

-- ============================================================================
-- Codefuel orphan: no matching ad. Attribute to account via channel -> campaign.
-- ============================================================================
codefuel_orphan AS (
  SELECT
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT  AS device,
    -- Attribute by asset_gid when it resolves to a single account; else by channel.
    COALESCE(gid.ad_account_id, ch.ad_account_id) AS ad_account_id,
    SUM(p.revenue)::NUMERIC  AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT  AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  LEFT JOIN LATERAL (
    SELECT c.ad_account_id
    FROM ads a JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.gd_param = p.asset_gid
    GROUP BY c.ad_account_id
    HAVING COUNT(DISTINCT c.ad_account_id) = 1
    LIMIT 1
  ) gid ON TRUE
  LEFT JOIN campaigns ch ON ch.external_id = p.channel
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel
    )
  GROUP BY p.hour_utc, p.country, p.device, COALESCE(gid.ad_account_id, ch.ad_account_id)
),

-- ============================================================================
-- IA orphan: campaign_ext_id missing OR unmatched. Image Advantage has exactly
-- ONE ad_account, so all unattributed IA revenue is attributed to that account
-- (resolved via ad_accounts.client_partner_id — not hardcoded).
-- ============================================================================
ia_orphan AS (
  SELECT
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT  AS device,
    aia.ad_account_id,
    SUM(p.revenue)::NUMERIC  AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT  AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  JOIN LATERAL (
    SELECT id AS ad_account_id FROM ad_accounts WHERE client_partner_id = cp.id LIMIT 1
  ) aia ON TRUE
  WHERE NOT EXISTS (
      SELECT 1 FROM campaigns cx WHERE cx.external_id = p.campaign_ext_id
    )
  GROUP BY p.hour_utc, p.country, p.device, aia.ad_account_id
)

-- ============================================================================
-- MERGE: FULL OUTER JOIN cost <-> attributed revenue on campaign grain
-- ============================================================================
SELECT
  NULL::INT AS ad_id,
  COALESCE(c.hour_utc, r.hour_utc)            AS hour_utc,
  COALESCE(c.country, r.country)::TEXT        AS country,
  COALESCE(c.device, r.device)::TEXT          AS device,
  COALESCE(c.site, '')::TEXT                  AS site,
  COALESCE(c.ad_account_id, r.ad_account_id)::INT AS ad_account_id,
  COALESCE(c.campaign_id, r.campaign_id)::INT AS campaign_id,
  c.campaign_external_id,
  c.campaign_name,
  NULL::TEXT AS ad_title,
  NULL::TEXT AS taboola_ad_id,
  NULL::TEXT AS gd_param,
  NULL::TEXT AS r_param,
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  r.source_platform,
  NULL::TEXT AS ad_account_name,
  COALESCE(c.impressions, 0)::BIGINT AS impressions,
  COALESCE(c.clicks, 0)::BIGINT      AS clicks,
  COALESCE(c.conversions, 0)::BIGINT AS conversions,
  COALESCE(c.spent, 0)::NUMERIC      AS spent,
  COALESCE(r.revenue, 0)::NUMERIC    AS revenue,
  COALESCE(r.ad_clicks, 0)::BIGINT   AS ad_clicks,
  COALESCE(r.sessions, 0)::BIGINT    AS sessions
FROM cost c
FULL OUTER JOIN all_attributed_revenue r
  ON  r.campaign_id   = c.campaign_id
  AND r.hour_utc      = c.hour_utc
  AND r.country       = c.country
  AND r.device        = c.device
  AND r.ad_account_id = c.ad_account_id

UNION ALL

-- Codefuel orphan revenue (account-attributed, campaign_id NULL)
SELECT
  NULL::INT, o.hour_utc, o.country, o.device, ''::TEXT,
  o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Codefuel)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Taboola'::TEXT, NULL::TEXT,
  0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
  o.revenue, o.ad_clicks, o.sessions
FROM codefuel_orphan o

UNION ALL

-- IA orphan revenue (account-attributed, campaign_id NULL)
SELECT
  NULL::INT, o.hour_utc, o.country, o.device, ''::TEXT,
  o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Image Advantage)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL::TEXT, NULL::TEXT,
  0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
  o.revenue, o.ad_clicks, o.sessions
FROM ia_orphan o;

-- ============================================================================
-- Indexes
-- ============================================================================
CREATE INDEX idx_mv_hour_utc       ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id    ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id  ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_country        ON joined_stats_hourly (country);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
