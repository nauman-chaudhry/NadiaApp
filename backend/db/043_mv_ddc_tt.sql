-- Migration 043: resolve DDC revenue through the type tag in the promoted
-- link's URL, and allocate it by real per-ad traffic.
--
-- Supersedes 041's DDC resolution. Full re-declaration of joined_stats_hourly.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- 041 tried to resolve DDC's `tt` against Outbrain object ids. The client has
-- since confirmed what the data already showed: she began with the `ad_id`
-- macro (those DO match a promoted-link id) and then, when DDC capped her type
-- tags, she hand-made ~100 unique 34-char tags that correspond to no Outbrain
-- id at all. Those live only in the ad's landing URL:
--
--   startgonow.com/<path>/?amxt=blue&tmpl=C244&tt=<34-hex>&kw=<keywords>
--
-- Outbrain's API rejects them outright ("Invalid id"), which is why 82.8% of
-- DDC revenue was stuck at account level. Migration 042 stores that URL
-- parameter as outbrain_ad_links.tt_param.
--
-- ── BOTH PATHS MUST KEEP WORKING ────────────────────────────────────────────
-- Old campaigns use the ad_id macro, the manual tags use the URL param, and the
-- client intends to go back to ad_id for new campaigns. ddc_tt_link resolves
-- all three shapes at once:
--   1. tt = outbrain_ad_links.tt_param   (manual tags — the majority today)
--   2. tt = outbrain_ad_links.link_id    (ad_id macro — old and future)
--   3. tt = outbrain_campaigns.campaign_id (campaign_id macro, if ever used)
--
-- ── ALLOCATION, AND WHY IT CANNOT BE A PLAIN JOIN ───────────────────────────
-- 158 of 196 tags map to exactly one promoted link, but 38 are reused across
-- several links and campaigns. Joining revenue to every match would MULTIPLY it
-- — the fan-out bug this project has hit repeatedly. Instead each (tag, day) is
-- split across its candidate links by that link's real Outbrain clicks on that
-- day (equal split when a day has no clicks), so the shares always sum to
-- exactly 1 and revenue is conserved.

DROP MATERIALIZED VIEW IF EXISTS joined_stats_hourly CASCADE;

CREATE MATERIALIZED VIEW joined_stats_hourly AS

WITH
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
         SUM(p.sessions)::BIGINT AS sessions, 'Taboola'::TEXT AS source_platform,
         0::NUMERIC AS revenue_flux, 0::BIGINT AS ad_clicks_flux, 0::BIGINT AS sessions_flux
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  JOIN ad_key a    ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND (p.source_platform = 'Taboola' OR p.source_platform IS NULL)
  GROUP BY a.campaign_id, p.hour_utc, c.ad_account_id
),
ia_item_map AS (
  SELECT DISTINCT ON (a.external_id)
         a.external_id AS item_ext, a.campaign_id, c.ad_account_id
  FROM ads a JOIN campaigns c ON c.id = a.campaign_id
  ORDER BY a.external_id, a.id
),
ia_attributed AS (
  SELECT COALESCE(cc.id, im.campaign_id)              AS campaign_id,
         p.hour_utc,
         COALESCE(cc.ad_account_id, im.ad_account_id) AS ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions, NULL::TEXT AS source_platform,
         COALESCE(SUM(p.revenue)   FILTER (WHERE p.granularity = 'x-daily'), 0)::NUMERIC AS revenue_flux,
         COALESCE(SUM(p.ad_clicks) FILTER (WHERE p.granularity = 'x-daily'), 0)::BIGINT  AS ad_clicks_flux,
         COALESCE(SUM(p.sessions)  FILTER (WHERE p.granularity = 'x-daily'), 0)::BIGINT  AS sessions_flux
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  LEFT JOIN campaigns cc   ON cc.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
  LEFT JOIN ia_item_map im ON im.item_ext   = regexp_replace(p.campaign_ext_id, '^tb:', '')
  WHERE p.campaign_ext_id IS NOT NULL
    AND p.source_platform IS DISTINCT FROM 'Outbrain'
    AND COALESCE(cc.id, im.campaign_id) IS NOT NULL
  GROUP BY COALESCE(cc.id, im.campaign_id), p.hour_utc, COALESCE(cc.ad_account_id, im.ad_account_id)
),
all_attributed_revenue AS (
  SELECT campaign_id, hour_utc, ad_account_id,
         SUM(revenue)::NUMERIC AS revenue, SUM(ad_clicks)::BIGINT AS ad_clicks,
         SUM(sessions)::BIGINT AS sessions, MAX(source_platform) AS source_platform,
         SUM(revenue_flux)::NUMERIC AS revenue_flux,
         SUM(ad_clicks_flux)::BIGINT AS ad_clicks_flux,
         SUM(sessions_flux)::BIGINT AS sessions_flux
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
  SELECT p.hour_utc, aia.ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions,
         COALESCE(SUM(p.revenue)   FILTER (WHERE p.granularity = 'x-daily'), 0)::NUMERIC AS revenue_flux,
         COALESCE(SUM(p.ad_clicks) FILTER (WHERE p.granularity = 'x-daily'), 0)::BIGINT  AS ad_clicks_flux,
         COALESCE(SUM(p.sessions)  FILTER (WHERE p.granularity = 'x-daily'), 0)::BIGINT  AS sessions_flux
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
-- ── DDC (third revenue partner) ─────────────────────────────────────────────
ddc_rows AS (
  SELECT p.*
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
),
-- Every DDC row for the window, keyed by its type tag and day.
ddc_raw AS (
  SELECT regexp_replace(p.campaign_ext_id, '^ob:', '') AS tt,
         p.hour_utc::date AS day_utc,
         SUM(p.revenue)::NUMERIC AS revenue,
         SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ddc_rows p
  WHERE COALESCE(p.source_platform, '') = 'Outbrain'
    AND p.campaign_ext_id LIKE 'ob:%'
  GROUP BY 1, 2
),
-- tag -> candidate (link, campaign). All three tag shapes at once; UNION (not
-- UNION ALL) so a tag that is both a tt_param and a link_id yields one row.
ddc_tt_link AS (
  SELECT al.tt_param AS tt, al.link_id, al.campaign_id
  FROM outbrain_ad_links al
  WHERE al.tt_param IS NOT NULL AND al.tt_param <> ''
  UNION
  SELECT al.link_id AS tt, al.link_id, al.campaign_id
  FROM outbrain_ad_links al
  UNION
  SELECT oc.campaign_id AS tt, NULL::TEXT AS link_id, oc.campaign_id
  FROM outbrain_campaigns oc
),
-- Weight each candidate campaign by the clicks its links actually took that day.
ddc_cand AS (
  SELECT r.tt, r.day_utc, l.campaign_id,
         COALESCE(SUM(oad.clicks), 0)::NUMERIC AS clicks
  FROM ddc_raw r
  JOIN ddc_tt_link l ON l.tt = r.tt
  LEFT JOIN outbrain_ad_daily oad
         ON oad.promoted_link_uuid = l.link_id
        AND oad.day_utc = r.day_utc
  GROUP BY r.tt, r.day_utc, l.campaign_id
),
-- Shares sum to exactly 1 per (tag, day): by clicks when there are any, else
-- split evenly. This is what keeps revenue conserved instead of multiplied.
ddc_alloc AS (
  SELECT c.tt, c.day_utc, c.campaign_id,
         CASE WHEN SUM(c.clicks) OVER w > 0
              THEN c.clicks / SUM(c.clicks) OVER w
              ELSE 1.0 / COUNT(*) OVER w END AS share
  FROM ddc_cand c
  WINDOW w AS (PARTITION BY c.tt, c.day_utc)
),
ob_ddc_rev AS (
  SELECT a.campaign_id, a.day_utc,
         SUM(r.revenue   * a.share)::NUMERIC AS revenue,
         ROUND(SUM(r.ad_clicks * a.share))::BIGINT AS ad_clicks,
         ROUND(SUM(r.sessions  * a.share))::BIGINT AS sessions
  FROM ddc_alloc a
  JOIN ddc_raw r ON r.tt = a.tt AND r.day_utc = a.day_utc
  GROUP BY 1, 2
),
-- Exact complement: DDC rows whose tag resolves to no candidate at all
-- (unsubstituted macros, the vendor's `abc123` example, literal 'null').
ddc_orphan AS (
  SELECT p.hour_utc::date AS day_utc,
         COALESCE(p.source_platform, 'Outbrain') AS source_platform,
         addc.ad_account_id,
         SUM(p.revenue)::NUMERIC AS revenue, SUM(p.ad_clicks)::BIGINT AS ad_clicks,
         SUM(p.sessions)::BIGINT AS sessions
  FROM ddc_rows p
  JOIN LATERAL (
    SELECT id AS ad_account_id FROM ad_accounts
    WHERE client_partner_id = p.client_partner_id ORDER BY id LIMIT 1
  ) addc ON TRUE
  WHERE NOT (
        COALESCE(p.source_platform, '') = 'Outbrain'
    AND p.campaign_ext_id LIKE 'ob:%'
    AND EXISTS (SELECT 1 FROM ddc_tt_link l
                 WHERE l.tt = regexp_replace(p.campaign_ext_id, '^ob:', ''))
  )
  GROUP BY 1, 2, 3
),
ob_rev_by_camp_day AS (
  SELECT campaign_id, day_utc, SUM(revenue)::NUMERIC AS revenue,
         SUM(ad_clicks)::BIGINT AS ad_clicks, SUM(sessions)::BIGINT AS sessions
  FROM (SELECT * FROM ob_ia_rev UNION ALL SELECT * FROM ob_cf_rev
        UNION ALL SELECT * FROM ob_ddc_rev) u
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
  COALESCE(r.sessions,0)::BIGINT AS sessions,
  COALESCE(r.revenue_flux,0)::NUMERIC AS revenue_flux,
  COALESCE(r.ad_clicks_flux,0)::BIGINT AS ad_clicks_flux,
  COALESCE(r.sessions_flux,0)::BIGINT AS sessions_flux
FROM cost c
FULL OUTER JOIN all_attributed_revenue r
  ON r.campaign_id = c.campaign_id AND r.hour_utc = c.hour_utc AND r.ad_account_id = c.ad_account_id
LEFT JOIN campaigns ident ON ident.id = COALESCE(c.campaign_id, r.campaign_id)

UNION ALL
SELECT NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT, o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Codefuel)'::TEXT, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Taboola'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions,
  0::NUMERIC, 0::BIGINT, 0::BIGINT
FROM codefuel_orphan o

UNION ALL
SELECT NULL::INT, o.hour_utc, ''::TEXT, ''::TEXT, ''::TEXT, o.ad_account_id, NULL::INT, NULL::TEXT,
  '(Unattributed revenue — Image Advantage)'::TEXT, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions,
  o.revenue_flux, o.ad_clicks_flux, o.sessions_flux
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
  COALESCE(orv.revenue,0)::NUMERIC, COALESCE(orv.ad_clicks,0)::BIGINT, COALESCE(orv.sessions,0)::BIGINT,
  0::NUMERIC, 0::BIGINT, 0::BIGINT
FROM ob_campaign_days cd
LEFT JOIN outbrain_campaigns oc ON oc.campaign_id = cd.campaign_id
LEFT JOIN ad_accounts oa ON oa.platform_id = (SELECT id FROM platforms WHERE code = 'outbrain')
                        AND oa.external_id = oc.marketer_id
LEFT JOIN ob_cost oct           ON oct.campaign_id = cd.campaign_id AND oct.day_utc = cd.day_utc
LEFT JOIN ob_rev_by_camp_day orv ON orv.campaign_id = cd.campaign_id AND orv.day_utc = cd.day_utc

UNION ALL
SELECT NULL::INT, (o.day_utc::timestamptz), ''::TEXT, ''::TEXT, ''::TEXT, NULL::INT, NULL::INT,
  NULL::TEXT, '(Outbrain — Codefuel, not mapped to campaign)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Outbrain'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions,
  0::NUMERIC, 0::BIGINT, 0::BIGINT
FROM ob_cf_orphan o

UNION ALL
SELECT NULL::INT, (o.day_utc::timestamptz), ''::TEXT, ''::TEXT, ''::TEXT, NULL::INT, NULL::INT,
  NULL::TEXT, '(Unattributed — Outbrain Image Advantage)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  'Outbrain'::TEXT, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC, o.revenue, o.ad_clicks, o.sessions,
  0::NUMERIC, 0::BIGINT, 0::BIGINT
FROM ob_ia_orphan o
UNION ALL
-- DDC revenue that resolves to no Outbrain object. The MAJORITY of DDC revenue
-- today (82.8%). Carries a real ad_account_id, unlike the other Outbrain orphan
-- branches, so account-filtered margin for SBH_ssm_09 stays correct.
SELECT NULL::INT, (o.day_utc::timestamptz), ''::TEXT, ''::TEXT, ''::TEXT,
  o.ad_account_id, NULL::INT,
  NULL::TEXT, '(Unattributed revenue - DDC)'::TEXT,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  o.source_platform, NULL::TEXT, 0::BIGINT, 0::BIGINT, 0::BIGINT, 0::NUMERIC,
  o.revenue, o.ad_clicks, o.sessions,
  0::NUMERIC, 0::BIGINT, 0::BIGINT
FROM ddc_orphan o;

CREATE INDEX idx_mv_hour_utc      ON joined_stats_hourly (hour_utc DESC);
CREATE INDEX idx_mv_campaign_id   ON joined_stats_hourly (campaign_id);
CREATE INDEX idx_mv_ad_account_id ON joined_stats_hourly (ad_account_id);
CREATE INDEX idx_mv_country       ON joined_stats_hourly (country);
CREATE INDEX idx_mv_source        ON joined_stats_hourly (source_platform);

REFRESH MATERIALIZED VIEW joined_stats_hourly;
