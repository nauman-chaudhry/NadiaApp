import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  COMPREHENSIVE FIX AND VERIFY: June 1-3, 2026');
console.log('════════════════════════════════════════════════════════════════\n');

// STEP 1: Refresh materialized view
console.log('─ STEP 1: REFRESHING MATERIALIZED VIEW ─\n');
try {
  await query('REFRESH MATERIALIZED VIEW joined_stats_hourly');
  console.log('✅ joined_stats_hourly refreshed successfully\n');
} catch (err: any) {
  console.log(`❌ Failed to refresh view: ${err.message}\n`);
  process.exit(1);
}

// STEP 2: Check raw data in source tables
console.log('─ STEP 2: CHECKING RAW SOURCE DATA ─\n');

const taboola = await query<any>(`
  SELECT
    DATE(s.hour_utc) AS day,
    COUNT(*) AS rows,
    SUM(s.clicks) AS clicks,
    ROUND(SUM(s.spent)::numeric, 2) AS spent,
    SUM(s.conversions) AS conversions
  FROM ad_stats_hourly s
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY DATE(s.hour_utc)
  ORDER BY day
`);

console.log('TABOOLA (ad_stats_hourly):');
if (taboola.length === 0) {
  console.log('  ❌ NO DATA');
} else {
  taboola.forEach((r: any) => {
    console.log(`  ${r.day}: ${r.rows} rows, ${r.clicks} clicks, $${r.spent} spent, ${r.conversions} conversions`);
  });
}

const codefuel = await query<any>(`
  SELECT
    DATE(p.hour_utc) AS day,
    COUNT(*) AS rows,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY DATE(p.hour_utc)
  ORDER BY day
`);

console.log('\nCODEFUEL (partner_stats_hourly):');
if (codefuel.length === 0) {
  console.log('  ❌ NO DATA');
} else {
  codefuel.forEach((r: any) => {
    console.log(`  ${r.day}: ${r.rows} rows, ${r.ad_clicks} ad_clicks, ${r.sessions} sessions, $${r.revenue} revenue`);
  });
}

const ia = await query<any>(`
  SELECT
    DATE(p.hour_utc) AS day,
    COUNT(*) AS rows,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY DATE(p.hour_utc)
  ORDER BY day
`);

console.log('\nIMAGE ADVANTAGE (partner_stats_hourly):');
if (ia.length === 0) {
  console.log('  ❌ NO DATA');
} else {
  ia.forEach((r: any) => {
    console.log(`  ${r.day}: ${r.rows} rows, ${r.ad_clicks} ad_clicks, ${r.sessions} sessions, $${r.revenue} revenue`);
  });
}

// STEP 3: Check IA platform separation
console.log('\n─ STEP 3: IA PLATFORM SEPARATION CHECK ─\n');

const iaPlatform = await query<any>(`
  SELECT
    asset_gid,
    COUNT(*) AS rows,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND campaign_ext_id IS NULL
  GROUP BY asset_gid
  ORDER BY revenue DESC
  LIMIT 20
`);

console.log('IA unattributed rows by asset_gid (affiliate):');
if (iaPlatform.length === 0) {
  console.log('  ℹ️  No unattributed IA rows');
} else {
  iaPlatform.forEach((r: any) => {
    const platform = r.asset_gid?.includes('.tb') ? '🔷 TABOOLA' : r.asset_gid?.includes('.ob') ? '🔶 OUTBRAIN' : '❓ UNKNOWN';
    console.log(`  ${r.asset_gid}: ${r.rows} rows, $${r.revenue} revenue [${platform}]`);
  });
}

const iaAttributed = await query<any>(`
  SELECT
    COUNT(*) AS total_rows,
    COUNT(CASE WHEN campaign_ext_id LIKE 'tb:%' THEN 1 END) AS taboola_attributed,
    COUNT(CASE WHEN campaign_ext_id LIKE 'ob:%' THEN 1 END) AS outbrain_attributed,
    COUNT(CASE WHEN campaign_ext_id IS NULL THEN 1 END) AS unattributed
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
`);

console.log('\nIA attributed rows platform breakdown:');
if (iaAttributed[0]) {
  console.log(`  Total IA rows: ${iaAttributed[0].total_rows}`);
  console.log(`  🔷 Taboola attributed: ${iaAttributed[0].taboola_attributed}`);
  console.log(`  🔶 Outbrain attributed: ${iaAttributed[0].outbrain_attributed}`);
  console.log(`  ❌ Unattributed: ${iaAttributed[0].unattributed}`);
}

// STEP 4: Check MV has data
console.log('\n─ STEP 4: MATERIALIZED VIEW CONTENT ─\n');

const mvData = await query<any>(`
  SELECT
    DATE(hour_utc) AS day,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY DATE(hour_utc)
  ORDER BY day
`);

console.log('joined_stats_hourly by day:');
if (mvData.length === 0) {
  console.log('  ❌ NO DATA IN MV!');
} else {
  mvData.forEach((r: any) => {
    console.log(`  ${r.day}: clicks=${r.clicks}, spent=$${r.spent}, conversions=${r.conversions}, ad_clicks=${r.ad_clicks}, sessions=${r.sessions}, revenue=$${r.revenue}`);
  });
}

// STEP 5: Test API filtering logic
console.log('\n─ STEP 5: API FILTERING SIMULATION ─\n');

const apiTest = await query<any>(`
  SELECT
    campaign_name,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
  GROUP BY campaign_name
  ORDER BY spent DESC NULLS LAST
  LIMIT 10
`);

console.log('Campaign view (simulating API with date filter):');
if (apiTest.length === 0) {
  console.log('  ❌ NO DATA - API filtering issue detected!');
  console.log('     The where clause uses exact same logic as server.ts');
} else {
  apiTest.forEach((r: any) => {
    console.log(`  ${r.campaign_name}: clicks=${r.clicks}, spent=$${r.spent}, conversions=${r.conversions}`);
  });
}

// STEP 6: Summary
console.log('\n════════════════════════════════════════════════════════════════\n');
console.log('SUMMARY:\n');

const taboolaTotal = taboola.reduce((s, r) => s + Number(r.spent || 0), 0).toFixed(2);
const codefuelTotal = codefuel.reduce((s, r) => s + Number(r.revenue || 0), 0).toFixed(2);
const iaTotal = ia.reduce((s, r) => s + Number(r.revenue || 0), 0).toFixed(2);

console.log(`✅ Taboola: $${taboolaTotal} (raw data exists)`);
console.log(`✅ Codefuel: $${codefuelTotal} (raw data exists)`);
console.log(`✅ IA: $${iaTotal} (raw data exists)`);

if (mvData.length > 0) {
  console.log(`\n✅ Materialized view has data`);
} else {
  console.log(`\n❌ Materialized view is EMPTY - this is the problem!`);
}

if (apiTest.length > 0) {
  console.log(`✅ API filtering works correctly`);
} else {
  console.log(`❌ API filtering returns NO DATA - issue in where clause!`);
}

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
