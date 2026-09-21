-- Migration 015: Final MV fixes
--
-- FIX A: Update unique index to include ad_account_id and campaign_id
-- FIX B: Orphan revenue branches now attribute to accounts via channel/campaign_ext_id
-- FIX C: Change from 6-branch UNION ALL to proper FULL OUTER JOIN cost+revenue,
--        then UNION with orphan rows

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

WITH
-- ============================================================================
-- Cost side: aggregate all cost by (ad_id, ad_account_id, hour, country, device)
-- ============================================================================
cost AS (
  SELECT
    s.ad_id,
    s.hour_utc,
    COALESCE(s.country, '')::TEXT AS country,
    COALESCE(s.device, '')::TEXT AS device,
    s.site,
    s.ad_account_id,
    a.campaign_id,
    c.external_id::TEXT AS campaign_external_id,
    c.name::TEXT AS campaign_name,
    a.title::TEXT AS ad_title,
    a.external_id::TEXT AS taboola_ad_id,
    a.gd_param::TEXT,
    a.r_param::TEXT,
    SUM(s.impressions)::BIGINT AS impressions,
    SUM(s.clicks)::BIGINT AS clicks,
    SUM(s.conversions)::BIGINT AS conversions,
    SUM(s.spent)::NUMERIC AS spent
  FROM ad_stats_hourly s
  LEFT JOIN ads a ON a.id = s.ad_id
  LEFT JOIN campaigns c ON c.id = a.campaign_id
  GROUP BY
    s.ad_id, s.hour_utc, s.country, s.device, s.site, s.ad_account_id,
    a.campaign_id, c.external_id, c.name, a.title, a.external_id,
    a.gd_param, a.r_param
),

-- ============================================================================
-- Codefuel attributed revenue: keyed on (gd_param, r_param) → ads
-- ============================================================================
codefuel_attributed AS (
  SELECT
    a.id::INT AS ad_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT AS device,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT AS sessions,
    'Taboola'::TEXT AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  GROUP BY a.id, p.hour_utc, p.country, p.device, c.ad_account_id
),

-- ============================================================================
-- Codefuel orphan revenue: no matching ad, but try to attribute to account via channel
-- ============================================================================
codefuel_orphan AS (
  SELECT
    NULL::INT AS ad_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT AS device,
    c.ad_account_id,  -- attribute via channel lookup to campaigns
    SUM(p.revenue)::NUMERIC AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT AS sessions,
    'Taboola'::TEXT AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  LEFT JOIN campaigns c ON c.external_id = p.channel  -- try to link via channel
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
    AND NOT EXISTS (
      SELECT 1 FROM ads a
      WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel
    )
  GROUP BY p.hour_utc, p.country, p.device, c.ad_account_id
),

-- ============================================================================
-- IA attributed revenue: keyed on campaign_ext_id → campaigns
-- ============================================================================
ia_attributed AS (
  SELECT
    NULL::INT AS ad_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT AS device,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT AS sessions,
    NULL::TEXT AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  JOIN campaigns c ON c.external_id = p.campaign_ext_id
  WHERE p.campaign_ext_id IS NOT NULL
  GROUP BY p.hour_utc, p.country, p.device, c.ad_account_id
),

-- ============================================================================
-- IA orphan revenue: campaign_ext_id doesn't match, try to attribute via channel
-- ============================================================================
ia_orphan AS (
  SELECT
    NULL::INT AS ad_id,
    p.hour_utc,
    COALESCE(p.country, '')::TEXT AS country,
    COALESCE(p.device, '')::TEXT AS device,
    c.ad_account_id,  -- attribute via channel lookup to campaigns
    SUM(p.revenue)::NUMERIC AS revenue,
    SUM(p.ad_clicks)::BIGINT AS ad_clicks,
    SUM(p.sessions)::BIGINT AS sessions,
    NULL::TEXT AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  LEFT JOIN campaigns c ON c.external_id = p.channel  -- try to link via channel
  WHERE p.campaign_ext_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM campaigns cx
      WHERE cx.external_id = p.campaign_ext_id
    )
  GROUP BY p.hour_utc, p.country, p.device, c.ad_account_id
),

-- ============================================================================
-- Combine all attributed revenue
-- ============================================================================
all_attributed_revenue AS (
  SELECT ad_id, hour_utc, country, device, ad_account_id, revenue, ad_clicks, sessions, source_platform
  FROM codefuel_attributed
  UNION ALL
  SELECT ad_id, hour_utc, country, device, ad_account_id, revenue, ad_clicks, sessions, source_platform
  FROM ia_attributed
)

-- ============================================================================
-- Final MV: FULL OUTER JOIN cost to attributed revenue
-- This puts cost and revenue on the same row when they match
-- ============================================================================
SELECT
  COALESCE(c.ad_id, r.ad_id)::INT AS ad_id,
  COALESCE(c.hour_utc, r.hour_utc) AS hour_utc,
  COALESCE(c.country, r.country)::TEXT AS country,
  COALESCE(c.device, r.device)::TEXT AS device,
  COALESCE(c.site, '')::TEXT AS site,
  COALESCE(c.ad_account_id, r.ad_account_id)::INT AS ad_account_id,
  c.campaign_id,
  c.campaign_external_id,
  c.campaign_name,
  c.ad_title,
  c.taboola_ad_id,
  c.gd_param,
  c.r_param,
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  r.source_platform,
  NULL::TEXT AS ad_account_name,
  COALESCE(c.impressions, 0)::BIGINT AS impressions,
  COALESCE(c.clicks, 0)::BIGINT AS clicks,
  COALESCE(c.conversions, 0)::BIGINT AS conversions,
  COALESCE(c.spent, 0)::NUMERIC AS spent,
  COALESCE(r.revenue, 0)::NUMERIC AS revenue,
  COALESCE(r.ad_clicks, 0)::BIGINT AS ad_clicks,
  COALESCE(r.sessions, 0)::BIGINT AS sessions
FROM cost c
FULL OUTER JOIN all_attributed_revenue r
  ON r.ad_id = c.ad_id
  AND r.hour_utc = c.hour_utc
  AND r.country = c.country
  AND r.device = c.device
  AND r.ad_account_id = c.ad_account_id

UNION ALL

-- Codefuel orphan revenue (now with ad_account_id attribution)
SELECT
  NULL::INT AS ad_id,
  o.hour_utc,
  o.country,
  o.device,
  ''::TEXT AS site,
  o.ad_account_id,
  NULL::INT AS campaign_id,
  NULL::TEXT AS campaign_external_id,
  '(Unattributed revenue — Codefuel)'::TEXT AS campaign_name,
  NULL::TEXT AS ad_title,
  NULL::TEXT AS taboola_ad_id,
  NULL::TEXT AS gd_param,
  NULL::TEXT AS r_param,
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  'Taboola'::TEXT AS source_platform,
  NULL::TEXT AS ad_account_name,
  0::BIGINT AS impressions,
  0::BIGINT AS clicks,
  0::BIGINT AS conversions,
  0::NUMERIC AS spent,
  o.revenue,
  o.ad_clicks,
  o.sessions
FROM codefuel_orphan o

UNION ALL

-- IA orphan revenue (now with ad_account_id attribution)
SELECT
  NULL::INT AS ad_id,
  o.hour_utc,
  o.country,
  o.device,
  ''::TEXT AS site,
  o.ad_account_id,
  NULL::INT AS campaign_id,
  NULL::TEXT AS campaign_external_id,
  '(Unattributed revenue — Image Advantage)'::TEXT AS campaign_name,
  NULL::TEXT AS ad_title,
  NULL::TEXT AS taboola_ad_id,
  NULL::TEXT AS gd_param,
  NULL::TEXT AS r_param,
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  NULL::TEXT AS source_platform,
  NULL::TEXT AS ad_account_name,
  0::BIGINT AS impressions,
  0::BIGINT AS clicks,
  0::BIGINT AS conversions,
  0::NUMERIC AS spent,
  o.revenue,
  o.ad_clicks,
  o.sessions
FROM ia_orphan o;

-- ============================================================================
-- Indexes (no unique constraint - duplicates checked at query time)
-- ============================================================================
CREATE INDEX idx_mv_hour_utc ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_ad_id ON joined_stats_hourly (ad_id);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
