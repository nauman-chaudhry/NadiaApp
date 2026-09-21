-- Migration 020: put cost and revenue on the SAME physical row
--
-- HARD DATA FACTS (verified live, Jun 4):
--   * ad_stats_hourly.ad_id     is 100% NULL  (Taboola cost is campaign-level only)
--   * ad_stats_hourly.country   is 100% blank
--   * ad_stats_hourly.device    is 100% blank
--   * partner_stats revenue HAS country='US' and a real device
--   * ads table has NO campaign_ext_id column (it is external_id)
--
--   => Cost and revenue share EXACTLY three dimensions: campaign_id, hour_utc,
--      ad_account_id. Any join key that also includes ad_id / country / device
--      can never match (cost is blank on all three), which is why prior MVs left
--      every cost row with revenue=0.
--
-- FIX: join cost LEFT/FULL against attributed revenue on (campaign_id, hour_utc,
--   ad_account_id) ONLY. Geo is dropped from the key (cost has none); country and
--   device are emitted as '' because cost — the row driver — is geoless. The
--   per-geo breakdown tabs (device/country) do NOT read this MV; they query
--   partner_stats directly in the API. This MV backs campaign / daily / hourly,
--   all of which are geo-agnostic.
--
--   Codefuel revenue is mapped to a campaign via a deduped ad_key (gd_param,
--   r_param) -> campaign_id (prevents fan-out double count, preserved from 018).
--   IA revenue maps via campaigns.external_id = campaign_ext_id.
--   Revenue with no mappable campaign is emitted as separate orphan rows.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

WITH
-- Cost per (campaign_id, hour_utc, ad_account_id). Geoless by nature.
cost AS (
  SELECT
    s.campaign_id,
    s.hour_utc,
    s.ad_account_id,
    SUM(s.impressions)::BIGINT AS impressions,
    SUM(s.clicks)::BIGINT      AS clicks,
    SUM(s.conversions)::BIGINT AS conversions,
    SUM(s.spent)::NUMERIC      AS spent
  FROM ad_stats_hourly s
  GROUP BY s.campaign_id, s.hour_utc, s.ad_account_id
),

-- One representative ad per (gd_param, r_param) -> prevents fan-out double-count.
ad_key AS (
  SELECT DISTINCT ON (a.gd_param, a.r_param)
    a.gd_param, a.r_param, a.campaign_id
  FROM ads a
  ORDER BY a.gd_param, a.r_param, a.id
),

-- Codefuel revenue attributed to a campaign (Taboola/NULL source only).
codefuel_attributed AS (
  SELECT
    a.campaign_id,
    p.hour_utc,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC   AS revenue,
    SUM(p.ad_clicks)::BIGINT  AS ad_clicks,
    SUM(p.sessions)::BIGINT   AS sessions,
    'Taboola'::TEXT           AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN ad_key a    ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  GROUP BY a.campaign_id, p.hour_utc, c.ad_account_id
),

-- Image Advantage revenue attributed via campaign external id.
ia_attributed AS (
  SELECT
    c.id AS campaign_id,
    p.hour_utc,
    c.ad_account_id,
    SUM(p.revenue)::NUMERIC   AS revenue,
    SUM(p.ad_clicks)::BIGINT  AS ad_clicks,
    SUM(p.sessions)::BIGINT   AS sessions,
    NULL::TEXT                AS source_platform
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  JOIN campaigns c        ON c.external_id = p.campaign_ext_id
  WHERE p.campaign_ext_id IS NOT NULL
  GROUP BY c.id, p.hour_utc, c.ad_account_id
),

all_attributed_revenue AS (
  SELECT campaign_id, hour_utc, ad_account_id,
         SUM(revenue)::NUMERIC  AS revenue,
         SUM(ad_clicks)::BIGINT AS ad_clicks,
         SUM(sessions)::BIGINT  AS sessions,
         MAX(source_platform)   AS source_platform
  FROM (
    SELECT * FROM codefuel_attributed
    UNION ALL
    SELECT * FROM ia_attributed
  ) u
  GROUP BY campaign_id, hour_utc, ad_account_id
),

-- Codefuel revenue with NO mappable ad/campaign.
codefuel_orphan AS (
  SELECT
    p.hour_utc,
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
  GROUP BY p.hour_utc, COALESCE(gid.ad_account_id, ch.ad_account_id)
),

-- IA revenue with no mappable campaign.
ia_orphan AS (
  SELECT
    p.hour_utc,
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
  GROUP BY p.hour_utc, aia.ad_account_id
)

-- MAIN: cost FULL OUTER JOIN revenue on the three shared dimensions only.
-- Cost and revenue now land on the SAME row. rowsWithBoth > 0.
SELECT
  NULL::INT AS ad_id,
  COALESCE(c.hour_utc, r.hour_utc)                 AS hour_utc,
  ''::TEXT  AS country,
  ''::TEXT  AS device,
  ''::TEXT  AS site,
  COALESCE(c.ad_account_id, r.ad_account_id)::INT  AS ad_account_id,
  COALESCE(c.campaign_id, r.campaign_id)::INT      AS campaign_id,
  ident.external_id::TEXT AS campaign_external_id,
  ident.name::TEXT        AS campaign_name,
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
  AND r.ad_account_id = c.ad_account_id
LEFT JOIN campaigns ident ON ident.id = COALESCE(c.campaign_id, r.campaign_id)

UNION ALL

SELECT
  NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT,
  o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Codefuel)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Taboola'::TEXT, NULL::TEXT,
  0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
  o.revenue, o.ad_clicks, o.sessions
FROM codefuel_orphan o

UNION ALL

SELECT
  NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT,
  o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Image Advantage)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL::TEXT, NULL::TEXT,
  0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
  o.revenue, o.ad_clicks, o.sessions
FROM ia_orphan o;

CREATE INDEX idx_mv_hour_utc       ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id    ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id  ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_country        ON joined_stats_hourly (country);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
