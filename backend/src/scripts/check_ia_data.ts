import { query } from '../db/client.js';

// Check IA data in partner_stats_hourly
const summary = await query<any>(`
  SELECT
    date_trunc('day', hour_utc) AS day,
    COUNT(*) AS rows,
    ROUND(SUM(revenue)::numeric, 4) AS revenue,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions
  FROM partner_stats_hourly
  WHERE client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
    AND hour_utc >= '2026-05-20T00:00:00Z'
    AND hour_utc <  '2026-05-29T00:00:00Z'
  GROUP BY 1
  ORDER BY 1
`);

console.log('IA revenue data May 20-28:');
let totalRev = 0, totalClicks = 0, totalSessions = 0;
for (const r of summary) {
  const d = new Date(r.day).toISOString().slice(0,10);
  console.log(`  ${d}: rows=${r.rows} rev=$${r.revenue} clicks=${r.ad_clicks} sessions=${r.sessions}`);
  totalRev += parseFloat(r.revenue);
  totalClicks += parseInt(r.ad_clicks);
  totalSessions += parseInt(r.sessions);
}
console.log(`\nTotal: rev=$${totalRev.toFixed(4)} clicks=${totalClicks} sessions=${totalSessions}`);
console.log('Targets: rev=$193.61 clicks=567 sessions=1908');

process.exit(0);
