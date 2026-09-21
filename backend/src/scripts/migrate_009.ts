import { readFileSync } from 'fs';
import { query } from '../db/client.js';

console.log('Applying migration 009...');
const sql = readFileSync('db/009_ia_revenue_mv.sql', 'utf8');
try {
  await query(sql);
  console.log('Migration 009 applied OK');
} catch (e: any) {
  console.error('FAILED:', e.message);
  process.exit(1);
}

// Quick regression: Windows A and B should still match targets
const windowA = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric, 2)      AS spent,
    SUM(clicks)                         AS clicks,
    SUM(impressions)                    AS impressions,
    SUM(conversions)                    AS conversions,
    ROUND(SUM(revenue)::numeric, 2)     AS revenue,
    SUM(ad_clicks)                      AS ad_clicks,
    SUM(sessions)                       AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-04-08T00:00:00Z'
    AND hour_utc <  '2026-04-13T00:00:00Z'
`);
console.log('\n=== Window A (Apr 8-12) ===');
console.log(JSON.stringify(windowA[0]));
console.log('Expected: spent=4491.56 clicks=45841 impressions=1591813 conversions=40162 revenue=12268.92 ad_clicks=18964 sessions=44538');

const windowB = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric, 2)      AS spent,
    SUM(clicks)                         AS clicks,
    SUM(impressions)                    AS impressions,
    SUM(conversions)                    AS conversions,
    ROUND(SUM(revenue)::numeric, 2)     AS revenue,
    SUM(ad_clicks)                      AS ad_clicks,
    SUM(sessions)                       AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-05-18T00:00:00Z'
    AND hour_utc <  '2026-05-25T00:00:00Z'
    AND ad_account_id IN (
      SELECT id FROM ad_accounts WHERE external_id = '17'
    )
`);
console.log('\n=== Window B (May 18-24, account 17) ===');
console.log(JSON.stringify(windowB[0]));
console.log('Expected: spent=763.87 clicks=9819 impressions=254405 conversions=5843 revenue=807.84 ad_clicks=2829 sessions=9748');

process.exit(0);
