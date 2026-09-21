import { query } from '../db/client.js';

// Raw IA rows for May 20 — check what got written
const rows = await query<any>(`
  SELECT campaign_ext_id, item_ext_id, revenue, ad_clicks, sessions
  FROM partner_stats_hourly
  WHERE client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
    AND hour_utc >= '2026-05-20T00:00:00Z'
    AND hour_utc <  '2026-05-21T00:00:00Z'
  ORDER BY revenue DESC
  LIMIT 20
`);
console.log('May 20 IA rows (top by revenue):');
for (const r of rows) {
  console.log(`  camp=${r.campaign_ext_id} item=${r.item_ext_id} rev=$${r.revenue} clicks=${r.ad_clicks} sessions=${r.sessions}`);
}

// Also check what the daily IA API is returning for May 20 totals
// vs the psh data to see if there's a data availability issue
const total = await query<any>(`
  SELECT COUNT(*) AS rows, ROUND(SUM(revenue)::numeric,4) AS rev,
    SUM(ad_clicks) AS clicks, SUM(sessions) AS sessions
  FROM partner_stats_hourly
  WHERE client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
    AND hour_utc >= '2026-05-20T00:00:00Z' AND hour_utc < '2026-05-21T00:00:00Z'
`);
console.log('\nMay 20 totals:', total[0]);

// Check May 25 (also low)
const may25 = await query<any>(`
  SELECT COUNT(*) AS rows, ROUND(SUM(revenue)::numeric,4) AS rev,
    SUM(ad_clicks) AS clicks, SUM(sessions) AS sessions
  FROM partner_stats_hourly
  WHERE client_partner_id = (SELECT id FROM client_partners WHERE code = 'image_advantage')
    AND hour_utc >= '2026-05-25T00:00:00Z' AND hour_utc < '2026-05-26T00:00:00Z'
`);
console.log('May 25 totals:', may25[0]);

process.exit(0);
