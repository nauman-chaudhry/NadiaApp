import { query } from '../db/client.js';

// 1. What does the MV return for account 17 (leadgenaffiliates-sc) on June 1?
console.log('\n=== MV totals for account 17 (leadgenaffiliates-sc), June 1 ===');
const mv = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric,2)       AS spent,
    SUM(clicks)::int                    AS clicks,
    SUM(conversions)::int               AS conversions,
    ROUND(SUM(revenue)::numeric,2)     AS revenue,
    SUM(ad_clicks)::int                 AS ad_clicks,
    SUM(sessions)::int                  AS sessions
  FROM joined_stats_hourly
  WHERE ad_account_id = 17
    AND hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc <  '2026-06-02 00:00:00+00'
`);
console.log(JSON.stringify(mv[0], null, 2));

// 2. Check what fields the Taboola sync stores — compare metrics for June 1
console.log('\n=== Raw ad_stats_hourly totals for account 17, June 1 ===');
const raw = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric,2)       AS spent,
    SUM(clicks)::int                    AS clicks,
    SUM(impressions)::int               AS impressions,
    SUM(conversions)::int               AS conversions,
    MAX(hour_utc)                       AS latest_hour
  FROM ad_stats_hourly
  WHERE ad_account_id = 17
    AND hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc <  '2026-06-02 00:00:00+00'
`);
console.log(JSON.stringify(raw[0], null, 2));

// 3. Check if account_id mapping is right — does 17 = leadgenaffiliates-sc?
const acc = await query<any>(`SELECT id, external_id, name FROM ad_accounts WHERE id = 17`);
console.log('\n=== Account 17 ===');
console.log(JSON.stringify(acc[0], null, 2));

// 4. Check how many campaigns under account 17 have data on June 1
const camps = await query<any>(`
  SELECT c.external_id AS campaign_id, c.name,
         ROUND(SUM(s.spent)::numeric,2) AS spent, SUM(s.clicks)::int AS clicks
  FROM ad_stats_hourly s
  JOIN campaigns c ON c.id = s.campaign_id
  WHERE s.ad_account_id = 17
    AND s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY c.external_id, c.name
  ORDER BY spent DESC
  LIMIT 10
`);
console.log('\n=== Campaigns in account 17 with June 1 data ===');
camps.forEach((r: any) => console.log(`  ${r.campaign_id}  spent=$${r.spent}  clicks=${r.clicks}  "${r.name}"`));

// 5. Codefuel revenue for account 17 campaigns on June 1 (via MV)
console.log('\n=== CF revenue via MV (campaign view) for account 17 ===');
const cfMv = await query<any>(`
  SELECT
    ROUND(SUM(revenue)::numeric,2) AS revenue,
    SUM(ad_clicks)::int             AS ad_clicks,
    SUM(sessions)::int              AS sessions
  FROM joined_stats_hourly
  WHERE ad_account_id = 17
    AND hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc <  '2026-06-02 00:00:00+00'
`);
console.log(JSON.stringify(cfMv[0], null, 2));

process.exit(0);
