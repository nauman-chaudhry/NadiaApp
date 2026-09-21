import { query } from '../db/client.js';

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║              STEP 3: VERIFY EACH ISSUE                 ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE 1: IA Daily revenue on June 2
// ─────────────────────────────────────────────────────────────────────────────
console.log('3.1.a Raw partner_stats_hourly query (IA June 2):');
const ia_june2 = await query<any>(`
  SELECT
    SUM(revenue)   AS revenue,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions)  AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'image_advantage'
    AND p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc <  '2026-06-03 00:00:00+00'
`);
console.log(JSON.stringify(ia_june2[0], null, 2));
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE 2: Device view - check cost metrics
// ─────────────────────────────────────────────────────────────────────────────
console.log('3.2 Device view (Codefuel June 1-3):');
console.log('GET /api/stats?view=device&from=2026-06-01&to=2026-06-03&partner=codefuel');
console.log('(Manual API call would be made here - checking DB directly instead)\n');

const device_view = await query<any>(`
  SELECT
    p.device,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY p.device
  ORDER BY revenue DESC
`);
console.log('Device breakdown from partner_stats_hourly:');
device_view.forEach(row => {
  console.log(`  ${(row.device || '(null)').padEnd(15)}: revenue=$${parseFloat(row.revenue).toFixed(2).padStart(10)}, clicks=${row.ad_clicks}`);
});
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE 5: Taboola June 1-3 data
// ─────────────────────────────────────────────────────────────────────────────
console.log('3.6 Taboola June 1-3 data (ad_stats_hourly):');
const taboola_data = await query<any>(`
  SELECT
    DATE(s.hour_utc) AS day,
    SUM(s.spent)     AS spent,
    SUM(s.clicks)    AS clicks
  FROM ad_stats_hourly s
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-04 00:00:00+00'
  GROUP BY day ORDER BY day
`);
console.log('Taboola by day:');
taboola_data.forEach(row => {
  const day = row.day instanceof Date ? row.day.toISOString().split('T')[0] : row.day;
  console.log(`  ${day}: spent=$${parseFloat(row.spent).toFixed(2)}, clicks=${row.clicks}`);
});
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// ISSUE 6 & 7: Orphan Codefuel assets (no ads match)
// ─────────────────────────────────────────────────────────────────────────────
console.log('3.7 Orphan Codefuel assets (not in ads table):');
const orphan_assets = await query<any>(`
  SELECT
    p.asset_gid,
    SUM(p.revenue) AS revenue,
    COUNT(DISTINCT p.channel) AS channels,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'codefuel'
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY p.asset_gid
  ORDER BY revenue DESC
  LIMIT 10
`);
console.log('Top 10 orphan assets:');
const outbrain_assets = ['AP1009251', 'AP1009313', 'AP1009280', 'AP1009330'];
orphan_assets.forEach(row => {
  const isOutbrain = outbrain_assets.some(a => row.asset_gid?.includes(a)) ? ' [OUTBRAIN]' : '';
  console.log(`  ${row.asset_gid.padEnd(15)} $${parseFloat(row.revenue).toFixed(2).padStart(10)}${isOutbrain}`);
});
console.log();

// Check if source-tag implementation exists
console.log('3.9 Source-tag split check (are assets using .tb/.ob suffixes?):');
const tagged_assets = await query<any>(`
  SELECT
    p.asset_gid,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  WHERE p.asset_gid LIKE '%.tb' OR p.asset_gid LIKE '%.ob'
  GROUP BY p.asset_gid
  LIMIT 5
`);
if (tagged_assets.length > 0) {
  console.log('✅ Found assets with .tb/.ob suffixes:');
  tagged_assets.forEach(row => {
    console.log(`  ${row.asset_gid} (${row.rows} rows)`);
  });
} else {
  console.log('❌ NO assets have .tb/.ob suffix tags (source-tag split NOT implemented)');
}
console.log();

process.exit(0);
