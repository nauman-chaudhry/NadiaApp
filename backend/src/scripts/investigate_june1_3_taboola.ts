import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  INVESTIGATING: Why Taboola data missing for June 1-3?');
console.log('════════════════════════════════════════════════════════════════\n');

// Check if Taboola data exists for June 1-3
console.log('─ TABOOLA DATA BY DAY (June 1-3) ─\n');
const taboolaByday = await query<any>(`
  SELECT
    DATE(s.hour_utc) AS day,
    COUNT(*) AS rows,
    SUM(s.clicks) AS clicks,
    ROUND(SUM(s.spent)::numeric, 2) AS spent,
    SUM(s.impressions) AS impressions,
    SUM(s.conversions) AS conversions
  FROM ad_stats_hourly s
  WHERE DATE(s.hour_utc) >= '2026-06-01'
    AND DATE(s.hour_utc) <= '2026-06-03'
  GROUP BY DATE(s.hour_utc)
  ORDER BY day
`);

console.log('Raw ad_stats_hourly data:');
taboolaByday.forEach((r: any) => {
  console.log(`  ${r.day}: ${r.rows} rows, ${r.clicks} clicks, $${r.spent} spent`);
});

// Check if it's in the materialized view
console.log('\n─ JOINED VIEW DATA (June 1-3) ─\n');
const mvByday = await query<any>(`
  SELECT
    DATE(hour_utc) AS day,
    COUNT(*) AS rows,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(impressions) AS impressions,
    SUM(conversions) AS conversions
  FROM joined_stats_hourly
  WHERE DATE(hour_utc) >= '2026-06-01'
    AND DATE(hour_utc) <= '2026-06-03'
  GROUP BY DATE(hour_utc)
  ORDER BY day
`);

console.log('Joined stats hourly MV:');
mvByday.forEach((r: any) => {
  console.log(`  ${r.day}: ${r.rows} rows, ${r.clicks} clicks, $${r.spent} spent`);
});

// Check if data exists at all for June 1-3
console.log('\n─ ALL DATA SOURCES (June 1-3) ─\n');
const allData = await query<any>(`
  SELECT
    DATE(j.hour_utc) AS day,
    'Taboola' AS source,
    SUM(j.clicks) AS clicks,
    ROUND(SUM(j.spent)::numeric, 2) AS spent,
    SUM(j.conversions) AS conversions
  FROM joined_stats_hourly j
  WHERE DATE(j.hour_utc) >= '2026-06-01'
    AND DATE(j.hour_utc) <= '2026-06-03'
    AND j.ad_account_id IS NOT NULL
  GROUP BY DATE(j.hour_utc)

  UNION ALL

  SELECT
    DATE(j.hour_utc) AS day,
    'Codefuel' AS source,
    SUM(j.ad_clicks)::int AS clicks,
    ROUND(SUM(j.revenue)::numeric, 2) AS spent,
    NULL::int AS conversions
  FROM joined_stats_hourly j
  WHERE DATE(j.hour_utc) >= '2026-06-01'
    AND DATE(j.hour_utc) <= '2026-06-03'
    AND j.campaign_id IS NOT NULL
  GROUP BY DATE(j.hour_utc)

  UNION ALL

  SELECT
    DATE(p.hour_utc) AS day,
    'IA' AS source,
    SUM(p.ad_clicks)::int AS clicks,
    ROUND(SUM(p.revenue)::numeric, 2) AS spent,
    NULL::int AS conversions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE DATE(p.hour_utc) >= '2026-06-01'
    AND DATE(p.hour_utc) <= '2026-06-03'
  GROUP BY DATE(p.hour_utc)

  ORDER BY day, source
`);

console.log('All sources combined:');
allData.forEach((r: any) => {
  console.log(`  ${r.day} - ${r.source}: ${r.clicks} clicks, $${r.spent} spent`);
});

// Check API response for device view (what dashboard shows)
console.log('\n─ DEVICE VIEW (What Dashboard Shows for June 1-3) ─\n');
const deviceView = await query<any>(`
  SELECT
    p.device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device
  ORDER BY revenue DESC

  UNION ALL

  SELECT
    '(Unattributed)' AS device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND (p.device IS NULL OR p.device = '')
`);

console.log('Device view results:');
if (deviceView.length === 0) {
  console.log('  ❌ NO DATA - This explains why dashboard shows nothing!');
} else {
  deviceView.forEach((r: any) => {
    console.log(`  ${r.device}: $${r.revenue} revenue, ${r.ad_clicks} clicks, ${r.sessions} sessions`);
  });
}

// Check why device view might be empty
console.log('\n─ DIAGNOSING DEVICE VIEW ISSUE ─\n');
const diagnosis = await query<any>(`
  SELECT
    'CF with device' AS metric,
    COUNT(*) AS count
  FROM partner_stats_hourly p
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''

  UNION ALL

  SELECT
    'CF total',
    COUNT(*) AS count
  FROM partner_stats_hourly p
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'

  UNION ALL

  SELECT
    'IA (unattributed)',
    COUNT(*) AS count
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND (p.device IS NULL OR p.device = '')
`);

console.log('Data availability:');
diagnosis.forEach((r: any) => {
  console.log(`  ${r.metric}: ${r.count} rows`);
});

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
