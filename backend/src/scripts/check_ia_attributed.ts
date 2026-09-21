import { query } from '../db/client.js';

console.log('\nChecking IA attributed rows structure:\n');

const iaAttributed = await query<any>(`
  SELECT
    campaign_ext_id,
    item_ext_id,
    COUNT(*) AS rows,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND campaign_ext_id IS NOT NULL
  GROUP BY campaign_ext_id, item_ext_id
  ORDER BY revenue DESC
  LIMIT 20
`);

console.log('IA attributed rows (sample):');
if (iaAttributed.length === 0) {
  console.log('  ℹ️  No attributed rows found');
} else {
  iaAttributed.forEach((r: any) => {
    const hasPlatformTag = r.campaign_ext_id?.includes(':');
    const platform = hasPlatformTag ? '✅' : '❌';
    console.log(`  ${platform} campaign=${r.campaign_ext_id}, item=${r.item_ext_id}: ${r.rows} rows, $${r.revenue}`);
  });
}

process.exit(0);
