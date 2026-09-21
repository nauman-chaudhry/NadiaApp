import { query } from '../db/client.js';

console.log('Checking Codefuel data with device breakdown (June 1-3):\n');

// Direct query to partner_stats_hourly, no joins
const rawData = await query<any>(`
  SELECT
    p.device,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device
  ORDER BY revenue DESC
`);

console.log('Raw Codefuel by device (direct from partner_stats_hourly):');
rawData.forEach(r => {
  console.log(`  ${r.device}: revenue=$${r.revenue}, rows=${r.row_count}`);
});
console.log(`Total: ${rawData.length} devices\n`);

// Now try the device view query (with ads JOIN)
const withJoin = await query<any>(`
  SELECT
    p.device,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device
  ORDER BY revenue DESC
`);

console.log('Codefuel by device (WITH ads JOIN):');
withJoin.forEach(r => {
  console.log(`  ${r.device}: revenue=$${r.revenue}, rows=${r.row_count}`);
});
console.log(`Total: ${withJoin.length} devices\n`);

process.exit(0);
