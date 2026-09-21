import { query } from '../db/client.js';

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║        VERIFY API RESPONSES (Simulating UNION ALL)      ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// Simulate the API device view query with UNION ALL
console.log('3.2b Device view with UNION ALL (simulating API response):');
const device_api_response = await query<any>(`
  -- Mapped Codefuel
  SELECT
    p.device,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions,
    '(mapped)' as source
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device

  UNION ALL

  -- Orphan Codefuel (NEW)
  SELECT
    COALESCE(p.device, '(Unattributed)'),
    SUM(p.revenue),
    SUM(p.ad_clicks),
    SUM(p.sessions),
    '(orphan)' as source
  FROM partner_stats_hourly p
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY COALESCE(p.device, '(Unattributed)')

  ORDER BY revenue DESC
`);

console.log('Device breakdown (mapped + orphan - as API would return):');
device_api_response.forEach(row => {
  const device_label = row.device || '(null)';
  console.log(`  ${device_label.padEnd(15)} $${parseFloat(row.revenue).toFixed(2).padStart(10)} [${row.source}]`);
});
console.log();

// Check Ads view with orphan Codefuel
console.log('3.4 Ads view (top 5 by revenue):');
const ads_view = await query<any>(`
  SELECT
    p.asset_gid,
    p.channel,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    CASE WHEN NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
         THEN '(orphan)'
         ELSE '(mapped)'
    END as status
  FROM partner_stats_hourly p
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY p.asset_gid, p.channel
  ORDER BY revenue DESC
  LIMIT 5
`);

console.log('Top 5 Codefuel assets by revenue:');
ads_view.forEach(row => {
  console.log(`  ${row.asset_gid.padEnd(15)}/${row.channel.padEnd(10)} $${parseFloat(row.revenue).toFixed(2).padStart(10)} [${row.status}]`);
});
console.log();

// Check if IA data appears in ads view
console.log('3.5 Ads view - IA data:');
const ia_ads = await query<any>(`
  SELECT
    SUM(p.revenue) as total_revenue,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
`);

if (ia_ads[0]?.rows > 0) {
  console.log(`✅ IA data found: ${ia_ads[0].rows} rows, $${parseFloat(ia_ads[0].total_revenue).toFixed(2)} revenue`);
} else {
  console.log(`❌ NO IA data found in date range`);
}
console.log();

// Check unattributed revenue aggregates
console.log('3.8 Check for (Unattributed) row in campaign view:');
const unattributed = await query<any>(`
  SELECT
    SUM(p.revenue) as total_orphan_revenue
  FROM partner_stats_hourly p
  WHERE p.campaign_ext_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
`);

console.log(`Total orphan/unattributed Codefuel revenue: $${parseFloat(unattributed[0]?.total_orphan_revenue || 0).toFixed(2)}`);
console.log('(This would appear as "(Unattributed - Codefuel Orphans)" in the dashboard)');
console.log();

process.exit(0);
