-- Migration 041: add DDC as a third revenue partner (Outbrain side).
--
-- Full re-declaration of joined_stats_hourly. Every MV migration re-declares the
-- whole view; there is no incremental path. This is 037 carried forward verbatim
-- plus the DDC branches. (038 added a table, 039 rebuilt an index, 040 added the
-- partner row — none of them touched the view.)
--
-- ── What DDC adds ───────────────────────────────────────────────────────────
--
-- DDC monetizes Outbrain marketer SBH_ssm_09. Its type tag is a 34-char hex in
-- the same ID space as outbrain_campaigns.campaign_id / outbrain_ad_links.link_id,
-- stored as campaign_ext_id = 'ob:<hex>' — the same convention IA-Outbrain uses.
--
-- TWO RULES THIS MIGRATION MUST NOT BREAK:
--
--   1. DDC revenue joins into ob_rev_by_camp_day, the Outbrain-side collapse
--      point, NEVER as a new top-level UNION ALL. Revenue is collapsed to one
--      row per campaign-day BEFORE cost is joined; a separate top-level branch
--      would fan out and double-count Outbrain cost.
--   2. All branches are positional across 29 columns. DDC emits literal zeros
--      for the three flux columns (x-metrics has no DDC equivalent).
--
-- ── ob_ddc_rev and ddc_orphan are DISJOINT BY CONSTRUCTION ──────────────────
--
-- This is the part that is easy to get wrong. ob_ia_rev keeps unresolvable rows
-- via COALESCE(..., raw.hex), so ob_ia_orphan has to exclude them by predicate
-- (campaign_ext_id IS NULL OR NOT LIKE 'ob:%'). Writing a DDC orphan CTE the
-- natural way ("revenue that did not resolve") would OVERLAP that fallback and
-- count every unresolved dollar twice.
--
-- So DDC does it the other way round, deliberately:
--   * ob_ddc_rev  keeps ONLY rows that resolve to a real Outbrain campaign
--                 (WHERE COALESCE(ocd.campaign_id, al.campaign_id) IS NOT NULL)
--   * ddc_orphan  keeps EXACTLY the complement — the negation of that same
--                 predicate. No row can satisfy both; every row satisfies one.
--
-- ── The orphan branch carries a REAL ad_account_id ──────────────────────────
--
-- This matters more for DDC than for any existing partner: 91 of 101 live DDC
-- type tags (82.8% of revenue, $5,190.95 over 22 Jul–30 Aug) resolve to no
-- Outbrain object at all, so the orphan branch is the MAJORITY path, not an
-- edge case. Both existing Outbrain orphan branches emit NULL::INT for
-- ad_account_id; if DDC did the same, that revenue would vanish the moment
-- Nadia filters to SBH_ssm_09 while the cost stayed — showing the account as a
-- far bigger loss than it is. The lateral below resolves the partner's own
-- account instead (the ia_orphan pattern), which is exact because DDC is a
-- single-account partner.
--
-- Taboola-side DDC (tb.startgonow.com, tmpl C245) has no live traffic and its
-- tag format is unknown, so it routes to the orphan bucket rather than guessing.
-- Revenue is surfaced, never dropped.

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
-- All DDC rows for the window, resolved once so both branches below read the
-- same set. DDC writes only granularity='daily' and never 'hourly', so the ps
-- CTE's hourly-wins de-dup can never shadow it.
ddc_rows AS (
  SELECT p.*
  FROM ps p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
),
-- ATTRIBUTED DDC: type tag resolves to an Outbrain campaign, directly or via a
-- promoted link. Note there is NO raw.hex fallback here (unlike ob_ia_rev) —
-- that is what makes this disjoint from ddc_orphan below.
ob_ddc_rev AS (
  SELECT COALESCE(ocd.campaign_id, al.campaign_id) AS campaign_id,
         raw.day_utc,
         SUM(raw.revenue)::NUMERIC AS revenue, SUM(raw.ad_clicks)::BIGINT AS ad_clicks,
         SUM(raw.sessions)::BIGINT AS sessions
  FROM (
    SELECT regexp_replace(p.campaign_ext_id, '^ob:', '') AS hex,
           p.hour_utc::date AS day_utc, p.revenue, p.ad_clicks, p.sessions
    FROM ddc_rows p
    WHERE COALESCE(p.source_platform, '') = 'Outbrain'
      AND p.campaign_ext_id LIKE 'ob:%'
  ) raw
  LEFT JOIN outbrain_campaigns ocd ON ocd.campaign_id = raw.hex
  LEFT JOIN outbrain_ad_links  al  ON al.link_id      = raw.hex
  WHERE COALESCE(ocd.campaign_id, al.campaign_id) IS NOT NULL
  GROUP BY 1, raw.day_utc
),
-- UNATTRIBUTED DDC: the exact complement of ob_ddc_rev's predicate. Carries a
-- real ad_account_id (see header) so it survives the account filter.
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
    AND (   EXISTS (SELECT 1 FROM outbrain_campaigns c
                     WHERE c.campaign_id = regexp_replace(p.campaign_ext_id, '^ob:', ''))
         OR EXISTS (SELECT 1 FROM outbrain_ad_links l
                     WHERE l.link_id      = regexp_replace(p.campaign_ext_id, '^ob:', '')))
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
