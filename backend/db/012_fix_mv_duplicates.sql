-- Migration 012: Reset MV to working baseline
-- Revert to migration 011 structure (confirmed working)

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS
  -- Taboola (cost side)
  SELECT
    s.hour_utc,
    s.ad_account_id,
    (SELECT name FROM ad_accounts WHERE id = s.ad_account_id) AS ad_account_name,
    c.id AS campaign_id,
    c.external_id AS campaign_external_id,
    c.name AS campaign_name,
    ROUND(s.impressions::numeric, 2) AS impressions,
    ROUND(s.clicks::numeric, 2) AS clicks,
    s.conversions,
    ROUND(s.spent::numeric, 2) AS spent,
    0::numeric AS revenue,
    0::numeric AS ad_clicks,
    0::numeric AS sessions,
    NULL::text AS asset_gid,
    NULL::text AS channel,
    NULL::text AS device,
    NULL::text AS country,
    NULL::text AS campaign_ext_id,
    NULL::text AS item_ext_id,
    NULL::text AS source_platform
  FROM ad_stats_hourly s
  LEFT JOIN campaigns c ON c.id = s.campaign_id

  UNION ALL

  -- Codefuel (revenue side) — ONLY Taboola-sourced
  SELECT
    p.hour_utc,
    c.ad_account_id,
    acc.name AS ad_account_name,
    c.id AS campaign_id,
    c.external_id AS campaign_external_id,
    c.name AS campaign_name,
    0::numeric AS impressions,
    0::numeric AS clicks,
    0::numeric AS conversions,
    0::numeric AS spent,
    ROUND(p.revenue::numeric, 2) AS revenue,
    p.ad_clicks,
    p.sessions,
    p.asset_gid,
    p.channel,
    p.device,
    p.country,
    NULL::text AS campaign_ext_id,
    NULL::text AS item_ext_id,
    p.source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  LEFT JOIN campaigns c ON c.id = a.campaign_id
  LEFT JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)

  UNION ALL

  -- Image Advantage (attributed) — keyed on campaign_ext_id + item_ext_id
  SELECT
    p.hour_utc,
    c.ad_account_id,
    acc.name AS ad_account_name,
    c.id AS campaign_id,
    c.external_id AS campaign_external_id,
    c.name AS campaign_name,
    0::numeric AS impressions,
    0::numeric AS clicks,
    0::numeric AS conversions,
    0::numeric AS spent,
    ROUND(p.revenue::numeric, 2) AS revenue,
    p.ad_clicks,
    p.sessions,
    NULL::text AS asset_gid,
    NULL::text AS channel,
    NULL::text AS device,
    NULL::text AS country,
    p.campaign_ext_id,
    p.item_ext_id,
    NULL::text AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  LEFT JOIN campaigns c ON c.external_id = p.campaign_ext_id
  LEFT JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.campaign_ext_id IS NOT NULL

  UNION ALL

  -- Image Advantage (unattributed) — keyed on asset_gid (affiliate) + channel (user_tag)
  SELECT
    p.hour_utc,
    NULL::int AS ad_account_id,
    NULL::text AS ad_account_name,
    NULL::int AS campaign_id,
    NULL::text AS campaign_external_id,
    NULL::text AS campaign_name,
    0::numeric AS impressions,
    0::numeric AS clicks,
    0::numeric AS conversions,
    0::numeric AS spent,
    ROUND(p.revenue::numeric, 2) AS revenue,
    p.ad_clicks,
    p.sessions,
    p.asset_gid,
    p.channel,
    p.device,
    p.country,
    NULL::text AS campaign_ext_id,
    NULL::text AS item_ext_id,
    NULL::text AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.campaign_ext_id IS NULL;

CREATE INDEX idx_mv_hour_utc ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id ON joined_stats_hourly (ad_account_id);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
