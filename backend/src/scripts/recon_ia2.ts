import { query } from '../db/client.js';

// Check DB timezone and exact session counts with explicit UTC bounds
const tzRows = await query<any>(`SHOW timezone`);
console.log('DB timezone:', tzRows[0].TimeZone);

// Count all IA rows and their hour_utc range
const rangeRows = await query<any>(`
  SELECT
    MIN(hour_utc) AS min_ts,
    MAX(hour_utc) AS max_ts,
    COUNT(*) AS total_rows,
    SUM(sessions)::int AS total_sessions,
    SUM(ad_clicks)::int AS total_ad_clicks,
    ROUND(SUM(revenue)::numeric,4) AS total_revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
`);
console.log('\nAll IA data range:');
console.log(JSON.stringify(rangeRows[0], null, 2));

// Check with explicit UTC bounds
const utcRows = await query<any>(`
  SELECT
    SUM(p.sessions)::int AS sessions,
    SUM(p.ad_clicks)::int AS ad_clicks,
    ROUND(SUM(p.revenue)::numeric,2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-05-20T00:00:00Z'
    AND p.hour_utc <  '2026-05-29T00:00:00Z'
`);
console.log('\nWith explicit UTC bounds (May 20 00:00Z to May 29 00:00Z):');
console.log(JSON.stringify(utcRows[0], null, 2));

// Count by exact UTC day
const dayRows = await query<any>(`
  SELECT
    date_trunc('day', hour_utc AT TIME ZONE 'UTC')::date AS utc_day,
    SUM(sessions)::int AS sessions,
    SUM(ad_clicks)::int AS ad_clicks,
    ROUND(SUM(revenue)::numeric,4) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  GROUP BY 1 ORDER BY 1
`);
console.log('\nBy UTC day:');
for (const r of dayRows) {
  console.log(`  ${r.utc_day}: sessions=${r.sessions} ad_clicks=${r.ad_clicks} revenue=${r.revenue}`);
}

process.exit(0);
