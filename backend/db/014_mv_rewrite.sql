-- Migration 014: Rewrite joined_stats_hourly MV with proper aggregation
--
-- Key design: 5 separate aggregated branches that are UNION ALL'd.
-- Each branch is self-contained with its own aggregation, eliminating duplicates
-- while preserving all data sources. This avoids the need for cross-branch JOINs
-- which fail when ad_id is NULL in cost rows.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

-- ============================================================================
-- BRANCH 1a: Taboola cost WITH ad_id
-- ============================================================================
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
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  NULL::TEXT AS source_platform,
  acc.name::TEXT AS ad_account_name,
  SUM(s.impressions)::BIGINT AS impressions,
  SUM(s.clicks)::BIGINT AS clicks,
  SUM(s.conversions)::BIGINT AS conversions,
  SUM(s.spent)::NUMERIC AS spent,
  0::NUMERIC AS revenue,
  0::BIGINT AS ad_clicks,
  0::BIGINT AS sessions
FROM ad_stats_hourly s
JOIN ads a ON a.id = s.ad_id
JOIN campaigns c ON c.id = a.campaign_id
JOIN ad_accounts acc ON acc.id = c.ad_account_id
WHERE s.ad_id IS NOT NULL
GROUP BY
  s.ad_id, s.hour_utc, s.country, s.device, s.site, s.ad_account_id,
  a.campaign_id, c.external_id, c.name, a.title, a.external_id,
  a.gd_param, a.r_param, acc.id, acc.name

UNION ALL

-- ============================================================================
-- BRANCH 1b: Taboola cost WITHOUT ad_id (aggregate within each account/campaign)
-- ============================================================================
SELECT
  NULL::INT AS ad_id,
  s.hour_utc,
  COALESCE(s.country, '')::TEXT AS country,
  COALESCE(s.device, '')::TEXT AS device,
  s.site,
  s.ad_account_id,
  s.campaign_id,
  NULL::TEXT AS campaign_external_id,
  NULL::TEXT AS campaign_name,
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
  SUM(s.impressions)::BIGINT AS impressions,
  SUM(s.clicks)::BIGINT AS clicks,
  SUM(s.conversions)::BIGINT AS conversions,
  SUM(s.spent)::NUMERIC AS spent,
  0::NUMERIC AS revenue,
  0::BIGINT AS ad_clicks,
  0::BIGINT AS sessions
FROM ad_stats_hourly s
WHERE s.ad_id IS NULL
GROUP BY
  s.hour_utc, s.country, s.device, s.site, s.ad_account_id, s.campaign_id

UNION ALL

-- ============================================================================
-- BRANCH 2: Codefuel revenue attributed to an ad (asset_gid/channel → ads join)
-- ============================================================================
SELECT
  a.id::INT AS ad_id,
  p.hour_utc,
  COALESCE(p.country, '')::TEXT AS country,
  COALESCE(p.device, '')::TEXT AS device,
  ''::TEXT AS site,
  c.ad_account_id,
  a.campaign_id,
  c.external_id::TEXT AS campaign_external_id,
  c.name::TEXT AS campaign_name,
  a.title::TEXT AS ad_title,
  a.external_id::TEXT AS taboola_ad_id,
  a.gd_param::TEXT,
  a.r_param::TEXT,
  NULL::TEXT AS asset_gid,
  NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id,
  NULL::TEXT AS item_ext_id,
  'Taboola'::TEXT AS source_platform,
  acc.name::TEXT AS ad_account_name,
  0::BIGINT AS impressions,
  0::BIGINT AS clicks,
  0::BIGINT AS conversions,
  0::NUMERIC AS spent,
  SUM(p.revenue)::NUMERIC AS revenue,
  SUM(p.ad_clicks)::BIGINT AS ad_clicks,
  SUM(p.sessions)::BIGINT AS sessions
FROM partner_stats_hourly p
JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
JOIN campaigns c ON c.id = a.campaign_id
JOIN ad_accounts acc ON acc.id = c.ad_account_id
WHERE p.campaign_ext_id IS NULL
  AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
GROUP BY
  a.id, p.hour_utc, p.country, p.device, c.ad_account_id, a.campaign_id,
  c.external_id, c.name, a.title, a.external_id, a.gd_param, a.r_param,
  acc.id, acc.name

UNION ALL

-- ============================================================================
-- BRANCH 3: Codefuel revenue orphan (no matching ad)
-- Aggregate ALL orphan revenue by (hour, country, device) — don't break out by asset_gid/channel
-- ============================================================================
SELECT
  NULL::INT AS ad_id,
  p.hour_utc,
  COALESCE(p.country, '')::TEXT AS country,
  COALESCE(p.device, '')::TEXT AS device,
  ''::TEXT AS site,
  NULL::INT AS ad_account_id,
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
  SUM(p.revenue)::NUMERIC AS revenue,
  SUM(p.ad_clicks)::BIGINT AS ad_clicks,
  SUM(p.sessions)::BIGINT AS sessions
FROM partner_stats_hourly p
JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
WHERE p.campaign_ext_id IS NULL
  AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM ads a
    WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel
  )
GROUP BY
  p.hour_utc, p.country, p.device

UNION ALL

-- ============================================================================
-- BRANCH 4: IA revenue attributed to a campaign (campaign_ext_id → campaigns join)
-- ============================================================================
SELECT
  NULL::INT AS ad_id,
  p.hour_utc,
  COALESCE(p.country, '')::TEXT AS country,
  COALESCE(p.device, '')::TEXT AS device,
  ''::TEXT AS site,
  c.ad_account_id,
  c.id AS campaign_id,
  c.external_id::TEXT AS campaign_external_id,
  c.name::TEXT AS campaign_name,
  NULL::TEXT AS ad_title,
  NULL::TEXT AS taboola_ad_id,
  NULL::TEXT AS gd_param,
  NULL::TEXT AS r_param,
  p.asset_gid::TEXT,
  p.channel::TEXT,
  p.campaign_ext_id::TEXT,
  p.item_ext_id::TEXT,
  NULL::TEXT AS source_platform,
  acc.name::TEXT AS ad_account_name,
  0::BIGINT AS impressions,
  0::BIGINT AS clicks,
  0::BIGINT AS conversions,
  0::NUMERIC AS spent,
  SUM(p.revenue)::NUMERIC AS revenue,
  SUM(p.ad_clicks)::BIGINT AS ad_clicks,
  SUM(p.sessions)::BIGINT AS sessions
FROM partner_stats_hourly p
JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
JOIN campaigns c ON c.external_id = p.campaign_ext_id
JOIN ad_accounts acc ON acc.id = c.ad_account_id
WHERE p.campaign_ext_id IS NOT NULL
GROUP BY
  p.hour_utc, p.country, p.device, c.ad_account_id, c.id, c.external_id,
  c.name, p.asset_gid, p.channel, p.campaign_ext_id, p.item_ext_id,
  acc.id, acc.name

UNION ALL

-- ============================================================================
-- BRANCH 5: IA revenue orphan (campaign_ext_id doesn't match any campaign)
-- Aggregate ALL orphan revenue by (hour, country, device) — don't break out by asset_gid/channel
-- ============================================================================
SELECT
  NULL::INT AS ad_id,
  p.hour_utc,
  COALESCE(p.country, '')::TEXT AS country,
  COALESCE(p.device, '')::TEXT AS device,
  ''::TEXT AS site,
  NULL::INT AS ad_account_id,
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
  SUM(p.revenue)::NUMERIC AS revenue,
  SUM(p.ad_clicks)::BIGINT AS ad_clicks,
  SUM(p.sessions)::BIGINT AS sessions
FROM partner_stats_hourly p
JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
WHERE p.campaign_ext_id IS NULL
  OR NOT EXISTS (
    SELECT 1 FROM campaigns c
    WHERE c.external_id = p.campaign_ext_id
  )
GROUP BY
  p.hour_utc, p.country, p.device;

-- ============================================================================
-- Indexes for query performance
-- ============================================================================
CREATE INDEX idx_mv_hour_utc ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_ad_id ON joined_stats_hourly (ad_id);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
