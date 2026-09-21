-- Migration 035: restore Outbrain ad_account_id mapping (regressed by 033/034)
--
-- Bug: migrations 033 (x-metrics) and 034 (IA item-id resolve) were authored by
-- copying the migration-030 MV body, which PREDATES migration 032. Migration 032
-- had populated ad_account_id on Outbrain rows (via the marketer→ad_accounts
-- join); rebuilding the MV from the 030 text silently reverted that, so every
-- Outbrain row went back to ad_account_id = NULL. Consequence: selecting any
-- account (e.g. via the new Project=Image Advantage / Codefuel dropdown, which
-- sets specific account ids) filtered out ALL Outbrain rows → "No data".
--
-- Fix: re-apply the migration-032 Outbrain account mapping on top of the
-- 033/034 logic. The Outbrain per-campaign branch now sets
--   ad_account_id = the marketer's ad_accounts.id
-- (outbrain_campaigns.marketer_id = ad_accounts.external_id, platform=outbrain),
-- so account- and Project-group filters compose with the source filter for
-- Outbrain exactly as they do for Taboola.
--
-- Everything else is carried forward unchanged from 034:
--   • x-daily granularity de-dup exemption (033)
--   • IA Taboola user_tag resolved via campaign id OR item id (034)
--   • Lead Gen 3 already tagged Image Advantage in 034 (data update, not repeated)

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

WITH
-- Granularity de-dup: prefer hourly; keep daily only on (partner, day) pairs
-- that have no hourly row. x-daily is always included — it has no hourly
-- equivalent (x-metrics API has no hourly endpoint).
hourly_days AS (
  SELECT DISTINCT client_partner_id, hour_utc::date AS d
  FROM partner_stats_hourly WHERE granularity = 'hourly'
),
ps AS (
  SELECT p.* FROM partner_stats_hourly p
  WHERE p.granularity = 'hourly'
     OR p.granularity = 'x-daily'   -- x-metrics: daily only, never shadowed by hourly
     OR NOT EXISTS (
       SELECT 1 FROM hourly_days h
       WHERE h.client_partner_id = p.client_partner_id AND h.d = p.hour_utc::date
     )
),
cost AS (
  SELECT s.campaign_id, s.hour_utc, s.ad_account_id,
         SUM(s.impressions)::BIGINT AS impressions,
         SUM(s.clicks)::BIGINT      AS clicks,
         SUM(s.conversions)::BIGINT AS conversions,
         SUM(s.spent)::NUMERIC      AS spent
  FROM ad_stats_hourly s
  GROUP BY s.campaign_id, s.hour_utc, s.ad_account_id
),
ad_key AS (
  SELECT DISTINCT ON (a.gd_param, a.r_param) a.gd_param, a.r_param, a.campaign_id
  FROM ads a ORDER BY a.gd_param, a.r_param, a.id
),
codefuel_attributed AS (
  SELECT a.campaign_id, p.hour_utc, c.ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions, 'Taboola'::TEXT AS source_platform
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN ad_key a    ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  GROUP BY a.campaign_id, p.hour_utc, c.ad_account_id
),
-- Map a Taboola item id -> its campaign (db id + account). IA user_tags set
-- ut={item_id}.{site_id}.{site} for some campaigns (e.g. flux), so the IA
-- campaign_ext_id seg1 is sometimes an item id rather than a campaign id.
ia_item_map AS (
  SELECT DISTINCT ON (a.external_id)
         a.external_id AS item_ext, a.campaign_id, c.ad_account_id
  FROM ads a JOIN campaigns c ON c.id = a.campaign_id
  ORDER BY a.external_id, a.id
),
ia_attributed AS (
  -- Resolve seg1 (campaign_ext_id minus 'tb:') via campaign id FIRST, then fall
  -- back to item id -> campaign. COALESCE prefers the direct campaign match.
  SELECT COALESCE(cc.id, im.campaign_id)              AS campaign_id,
         p.hour_utc,
         COALESCE(cc.ad_account_id, im.ad_account_id) AS ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions, NULL::TEXT AS source_platform
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  LEFT JOIN campaigns cc   ON cc.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
  LEFT JOIN ia_item_map im ON im.item_ext   = regexp_replace(p.campaign_ext_id, '^tb:', '')
  WHERE p.campaign_ext_id IS NOT NULL
    AND p.source_platform IS DISTINCT FROM 'Outbrain'
    AND COALESCE(cc.id, im.campaign_id) IS NOT NULL   -- resolved via campaign OR item
  GROUP BY COALESCE(cc.id, im.campaign_id), p.hour_utc, COALESCE(cc.ad_account_id, im.ad_account_id)
),
all_attributed_revenue AS (
  SELECT campaign_id, hour_utc, ad_account_id,
         SUM(revenue)::NUMERIC AS revenue, SUM(ad_clicks)::BIGINT AS ad_clicks,
         SUM(sessions)::BIGINT AS sessions, MAX(source_platform) AS source_platform
  FROM (SELECT * FROM codefuel_attributed UNION ALL SELECT * FROM ia_attributed) u
  GROUP BY campaign_id, hour_utc, ad_account_id
),
codefuel_orphan AS (
  SELECT p.hour_utc, COALESCE(gid.ad_account_id, ch.ad_account_id) AS ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  LEFT JOIN LATERAL (
    SELECT c.ad_account_id FROM ads a JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.gd_param = p.asset_gid GROUP BY c.ad_account_id
    HAVING COUNT(DISTINCT c.ad_account_id) = 1 LIMIT 1
  ) gid ON TRUE
  LEFT JOIN campaigns ch ON ch.external_id = p.channel
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY p.hour_utc, COALESCE(gid.ad_account_id, ch.ad_account_id)
),
ia_orphan AS (
  -- IA revenue that resolves to NEITHER a campaign id NOR an item id. Lumped to
  -- the first IA account as "(Unattributed revenue — Image Advantage)".
  SELECT p.hour_utc, aia.ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  JOIN LATERAL (SELECT id AS ad_account_id FROM ad_accounts WHERE client_partner_id = cp.id LIMIT 1) aia ON TRUE
  WHERE p.source_platform IS DISTINCT FROM 'Outbrain'
    AND NOT EXISTS (SELECT 1 FROM campaigns cx WHERE cx.external_id = regexp_replace(p.campaign_ext_id, '^tb:', ''))
    AND NOT EXISTS (SELECT 1 FROM ads ax       WHERE ax.external_id = regexp_replace(p.campaign_ext_id, '^tb:', ''))
  GROUP BY p.hour_utc, aia.ad_account_id
),

-- ───────────────────── Outbrain ─────────────────────
ob_cost AS (
  SELECT d.campaign_id, d.day_utc,
         SUM(d.impressions)::BIGINT AS impressions, SUM(d.clicks)::BIGINT AS clicks,
         SUM(d.conversions)::BIGINT AS conversions, SUM(d.spent)::NUMERIC AS spent
  FROM outbrain_stats_daily d
  GROUP BY d.campaign_id, d.day_utc
),
ob_ia_rev AS (
  SELECT COALESCE(ocd.campaign_id, al.campaign_id, raw.hex) AS campaign_id,
         raw.day_utc,
         SUM(raw.revenue)::NUMERIC AS revenue, SUM(raw.ad_clicks)::BIGINT AS ad_clicks,
         SUM(raw.sessions)::BIGINT AS sessions
  FROM (
    SELECT regexp_replace(p.campaign_ext_id, '^ob:', '') AS hex,
           p.hour_utc::date AS day_utc, p.revenue, p.ad_clicks, p.sessions
    FROM ps p
    JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
    WHERE p.source_platform = 'Outbrain' AND p.campaign_ext_id LIKE 'ob:%'
  ) raw
  LEFT JOIN outbrain_campaigns ocd ON ocd.campaign_id = raw.hex
  LEFT JOIN outbrain_ad_links  al  ON al.link_id     = raw.hex
  GROUP BY 1, raw.day_utc
),
ob_cf_rev AS (
  SELECT oa.campaign_id, p.hour_utc::date AS day_utc,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN outbrain_ads oa ON oa.gd_param = p.asset_gid AND oa.r_param = p.channel
  WHERE p.source_platform = 'Outbrain'
  GROUP BY 1, 2
),
ob_rev_by_camp_day AS (
  SELECT campaign_id, day_utc, SUM(revenue)::NUMERIC AS revenue,
         SUM(ad_clicks)::BIGINT AS ad_clicks, SUM(sessions)::BIGINT AS sessions
  FROM (SELECT * FROM ob_ia_rev UNION ALL SELECT * FROM ob_cf_rev) u
  GROUP BY campaign_id, day_utc
),
ob_campaign_days AS (
  SELECT campaign_id, day_utc FROM ob_cost
  UNION
  SELECT campaign_id, day_utc FROM ob_rev_by_camp_day
),
ob_cf_orphan AS (
  SELECT p.hour_utc::date AS day_utc,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.source_platform = 'Outbrain'
    AND NOT EXISTS (SELECT 1 FROM outbrain_ads oa WHERE oa.gd_param = p.asset_gid AND oa.r_param = p.channel)
  GROUP BY 1
),
ob_ia_orphan AS (
  SELECT p.hour_utc::date AS day_utc,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.source_platform = 'Outbrain'
    AND (p.campaign_ext_id IS NULL OR p.campaign_ext_id NOT LIKE 'ob:%')
  GROUP BY 1
)

-- ===== Taboola main (cost FULL OUTER JOIN attributed revenue) =====
SELECT
  NULL::INT AS ad_id, COALESCE(c.hour_utc, r.hour_utc) AS hour_utc,
  ''::TEXT AS country, ''::TEXT AS device, ''::TEXT AS site,
  COALESCE(c.ad_account_id, r.ad_account_id)::INT AS ad_account_id,
  COALESCE(c.campaign_id, r.campaign_id)::INT AS campaign_id,
  ident.external_id::TEXT AS campaign_external_id,
  ident.name::TEXT AS campaign_name,
  NULL::TEXT AS ad_title, NULL::TEXT AS taboola_ad_id, NULL::TEXT AS gd_param,
  NULL::TEXT AS r_param, NULL::TEXT AS asset_gid, NULL::TEXT AS channel,
  NULL::TEXT AS campaign_ext_id, NULL::TEXT AS item_ext_id,
  r.source_platform, NULL::TEXT AS ad_account_name,
  COALESCE(c.impressions,0)::BIGINT AS impressions, COALESCE(c.clicks,0)::BIGINT AS clicks,
  COALESCE(c.conversions,0)::BIGINT AS conversions, COALESCE(c.spent,0)::NUMERIC AS spent,
  COALESCE(r.revenue,0)::NUMERIC AS revenue, COALESCE(r.ad_clicks,0)::BIGINT AS ad_clicks,
  COALESCE(r.sessions,0)::BIGINT AS sessions
FROM cost c
FULL OUTER JOIN all_attributed_revenue r
  ON r.campaign_id = c.campaign_id AND r.hour_utc = c.hour_utc AND r.ad_account_id = c.ad_account_id
LEFT JOIN campaigns ident ON ident.id = COALESCE(c.campaign_id, r.campaign_id)

UNION ALL
SELECT NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT, o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Codefuel)'::TEXT, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Taboola'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions
FROM codefuel_orphan o

UNION ALL
SELECT NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT, o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Image Advantage)'::TEXT, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions
FROM ia_orphan o

-- ===== Outbrain: per-campaign cost + IA revenue =====
UNION ALL
SELECT
  NULL::INT AS ad_id, (cd.day_utc::timestamptz) AS hour_utc,
  ''::TEXT, ''::TEXT, ''::TEXT,
  oa.id::INT AS ad_account_id, NULL::INT AS campaign_id,
  cd.campaign_id::TEXT AS campaign_external_id,
  COALESCE(oc.campaign_name, '(Outbrain campaign ' || cd.campaign_id || ')')::TEXT AS campaign_name,
  NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
  'Outbrain'::TEXT AS source_platform, oc.account_code::TEXT AS ad_account_name,
  COALESCE(oct.impressions,0)::BIGINT, COALESCE(oct.clicks,0)::BIGINT,
  COALESCE(oct.conversions,0)::BIGINT, COALESCE(oct.spent,0)::NUMERIC,
  COALESCE(orv.revenue,0)::NUMERIC, COALESCE(orv.ad_clicks,0)::BIGINT, COALESCE(orv.sessions,0)::BIGINT
FROM ob_campaign_days cd
LEFT JOIN outbrain_campaigns oc ON oc.campaign_id = cd.campaign_id
-- Map the campaign's marketer to its ad_accounts row (migration 032) so account
-- and Project-group filters compose with the source filter for Outbrain.
LEFT JOIN ad_accounts oa ON oa.platform_id = (SELECT id FROM platforms WHERE code = 'outbrain')
                        AND oa.external_id = oc.marketer_id
LEFT JOIN ob_cost oct           ON oct.campaign_id = cd.campaign_id AND oct.day_utc = cd.day_utc
LEFT JOIN ob_rev_by_camp_day orv ON orv.campaign_id = cd.campaign_id AND orv.day_utc = cd.day_utc

UNION ALL
SELECT NULL::INT, (o.day_utc::timestamptz), ''::TEXT, ''::TEXT, ''::TEXT, NULL::INT, NULL::INT,
  NULL::TEXT, '(Outbrain — Codefuel, not mapped to campaign)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Outbrain'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions
FROM ob_cf_orphan o

UNION ALL
SELECT NULL::INT, (o.day_utc::timestamptz), ''::TEXT, ''::TEXT, ''::TEXT, NULL::INT, NULL::INT,
  NULL::TEXT, '(Unattributed — Outbrain Image Advantage)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Outbrain'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions
FROM ob_ia_orphan o;

CREATE INDEX idx_mv_hour_utc      ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id   ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_country       ON joined_stats_hourly (country);
CREATE INDEX idx_mv_source        ON joined_stats_hourly (source_platform);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
