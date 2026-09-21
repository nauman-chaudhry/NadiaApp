-- 047_mv_ia_orphan_deterministic_account.sql
--
-- Supersedes 046. Full re-declaration of joined_stats_hourly (there is no
-- incremental path -- every MV migration re-declares the view in full).
--
-- ONE change from 046: the ia_orphan account lateral gains ORDER BY id. See the
-- comment at that lateral. Everything else is byte-identical to 046.
--
-- MUST be applied together with the matching API deploy: api/server.ts resolves
-- the same account for the -1 IA branch so the Ads tab keeps that revenue under
-- an account filter (Campaign == Ads). Applying only one of the two leaves the
-- pair disagreeing.
-- Migration 046: fix DDC revenue misattribution — normalize the tt match and
-- replace the equal-split fallback with trailing-window traffic weighting.
--
-- Supersedes 043's DDC resolution. Full re-declaration of joined_stats_hourly
-- (copy of 043 with ONLY the DDC CTEs changed; every other branch is verbatim).
--
-- == THE BUG (client-reported: revenue on campaigns with zero traffic) ========
-- Two defects compounded:
--
-- 1. EXACT tt MATCH vs the publisher macro. outbrain_ad_links.tt_param stores
--    the RAW ?tt= value from the landing URL. Since ~2026-08-28 the URL
--    template appends a literal '_{{publisher_id}}' macro, so tt_param is
--    '<34-hex>_{{publisher_id}}'. Outbrain substitutes the macro at serve
--    time, DDC reports '<tag>_<publisher hex>', and sync/ddc.ts parseTypeTag
--    stores only the base tag (split at the FIRST underscore). ddc_tt_link
--    joined on exact equality, so every post-macro link failed to match its
--    own revenue: the ads actually taking the traffic were invisible to the
--    resolver. The base tag still matched the OLD (pre-macro) links that
--    share it, so revenue silently flowed to dead links instead of orphaning.
--
-- 2. THE EQUAL-SPLIT FALLBACK. With the real link invisible, no candidate had
--    same-day clicks, and the CASE fell back to 1/COUNT(*) — splitting the
--    revenue EQUALLY across every candidate campaign, including campaigns
--    with zero traffic. Measured 2026-09-07 (account 3971): 11 of 76 earning
--    tags hit the fallback ($142.65), and 4 campaigns ended the day with
--    revenue but zero spend and zero clicks ($40.79 of $276.22) — e.g.
--    'US-Mixed KW 21th July V1 - DDC' showed $20.80 revenue on 0 impressions.
--    All-time, $2,073.91 of $8,252.15 had gone through the fallback.
--
-- == THE FIX ==================================================================
-- 1. ddc_tt_link matches on split_part(tt_param, '_', 1). The DDC-side tag can
--    never contain '_' (parseTypeTag splits there), so this is exact both ways.
-- 2. Candidates are weighted by their REAL clicks over a trailing 7-day window
--    (revenue day D and the 6 days before it) instead of strictly same-day.
--    DDC revenue comes from searches that happen AFTER the ad click, so
--    revenue on D often belongs to a click on D-1 or earlier; the window also
--    covers days where Outbrain cost has not synced yet. Measured 2026-09-08:
--    with the normalized match, same-day clicks cover 98.7% of revenue and
--    the 7-day window covers 100.0%.
-- 3. NO equal-split fallback. A (tag, day) with zero candidate traffic in the
--    whole window routes to ddc_orphan (the '(Unattributed revenue - DDC)'
--    row) — revenue is conserved but never invented onto a zero-traffic
--    campaign. ddc_orphan is now the exact complement of ddc_alloc by
--    construction.
--
-- src/api/server.ts (Outbrain Ads branch + hourly-tab lateral) mirrors this
-- exactly; deploy the API together with this migration or a campaign/status
-- filter can disagree between the Campaign and Ads tabs until both are live.

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
  -- ORDER BY id is REQUIRED, not cosmetic. Without it this is a bare LIMIT 1 over
  -- the IA partner's SIX ad_accounts, so which account the unattributed IA revenue
  -- is booked to is chosen arbitrarily and can CHANGE on any refresh: the row this
  -- migration replaces was stored against account 239 (SBH_ssm_05) while
  -- re-evaluating the same lateral returned 12. Under the Project/account filter
  -- that makes ~$200/window hop between accounts with no data change. ddc_orphan
  -- (below) already uses ORDER BY id; this now matches it.
  JOIN LATERAL (SELECT id AS ad_account_id FROM ad_accounts WHERE client_partner_id = cp.id
                 ORDER BY id LIMIT 1) aia ON TRUE
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
-- split_part strips the literal '_{{publisher_id}}' macro suffix that the URL
-- template has carried since ~2026-08-28 (see the header); the stored DDC tag
-- is always the base value, so split-at-first-underscore matches exactly.
ddc_tt_link AS (
  SELECT split_part(al.tt_param, '_', 1) AS tt, al.link_id, al.campaign_id
  FROM outbrain_ad_links al
  WHERE al.tt_param IS NOT NULL AND split_part(al.tt_param, '_', 1) <> ''
  UNION
  SELECT al.link_id AS tt, al.link_id, al.campaign_id
  FROM outbrain_ad_links al
  UNION
  SELECT oc.campaign_id AS tt, NULL::TEXT AS link_id, oc.campaign_id
  FROM outbrain_campaigns oc
),
-- Weight each candidate campaign by the clicks its links actually took over a
-- trailing 7-day window (revenue day and the 6 days before). Campaign-id-macro
-- candidates (link_id IS NULL) weigh by the campaign's own clicks over the
-- same window. The two LEFT JOIN conditions are mutually exclusive on
-- l.link_id, so they cannot fan out against each other.
ddc_cand AS (
  SELECT r.tt, r.day_utc, l.campaign_id,
         COALESCE(SUM(CASE WHEN l.link_id IS NOT NULL THEN oad.clicks
                           ELSE osd.clicks END), 0)::NUMERIC AS clicks
  FROM ddc_raw r
  JOIN ddc_tt_link l ON l.tt = r.tt
  LEFT JOIN outbrain_ad_daily oad
         ON l.link_id IS NOT NULL
        AND oad.promoted_link_uuid = l.link_id
        AND oad.day_utc BETWEEN r.day_utc - 6 AND r.day_utc
  LEFT JOIN outbrain_stats_daily osd
         ON l.link_id IS NULL
        AND osd.campaign_id = l.campaign_id
        AND osd.day_utc BETWEEN r.day_utc - 6 AND r.day_utc
  GROUP BY r.tt, r.day_utc, l.campaign_id
),
-- Shares are clicks / total-window-clicks per (tag, day): they sum to exactly
-- 1 wherever any candidate had traffic, so revenue is conserved. There is NO
-- equal-split fallback: it invented attribution by handing revenue to
-- candidate campaigns that ran zero traffic. A (tag, day) with no candidate
-- traffic in the whole window routes to ddc_orphan instead. clicks > 0 drops
-- zero-weight candidates so no zero-revenue campaign-day rows appear.
ddc_alloc AS (
  SELECT c.tt, c.day_utc, c.campaign_id, c.clicks / t.tot AS share
  FROM ddc_cand c
  JOIN (SELECT tt, day_utc, SUM(clicks) AS tot
        FROM ddc_cand GROUP BY tt, day_utc) t
    ON t.tt = c.tt AND t.day_utc = c.day_utc AND t.tot > 0
  WHERE c.clicks > 0
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
-- Exact complement of ob_ddc_rev, so DDC revenue is conserved by construction:
--   (a) rows with no parseable 'ob:' tag (unsubstituted macros, test values);
--   (b) tagged (tag, day)s that produced NO allocation — the tag resolves to
--       no Outbrain object, or none of its candidates had a single click in
--       the trailing window. Revenue is never given to a campaign that ran no
--       traffic, and never dropped either.
ddc_orphan AS (
  SELECT o.day_utc, o.source_platform, addc.ad_account_id,
         SUM(o.revenue)::NUMERIC AS revenue, SUM(o.ad_clicks)::BIGINT AS ad_clicks,
         SUM(o.sessions)::BIGINT AS sessions
  FROM (
    SELECT p.hour_utc::date AS day_utc,
           COALESCE(p.source_platform, 'Outbrain') AS source_platform,
           p.revenue, p.ad_clicks, p.sessions
    FROM ddc_rows p
    WHERE NOT (COALESCE(p.source_platform, '') = 'Outbrain'
               AND p.campaign_ext_id LIKE 'ob:%')
    UNION ALL
    SELECT r.day_utc, 'Outbrain'::TEXT, r.revenue, r.ad_clicks, r.sessions
    FROM ddc_raw r
    WHERE NOT EXISTS (SELECT 1 FROM ddc_alloc a
                       WHERE a.tt = r.tt AND a.day_utc = r.day_utc)
  ) o
  JOIN LATERAL (
    SELECT id AS ad_account_id FROM ad_accounts
    WHERE client_partner_id = (SELECT id FROM client_partners WHERE code = 'ddc')
    ORDER BY id LIMIT 1
  ) addc ON TRUE
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
