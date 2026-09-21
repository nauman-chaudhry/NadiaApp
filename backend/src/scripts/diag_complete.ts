import { query } from '../db/client.js';

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║          COMPREHENSIVE DATA DIAGNOSTIC — JUNE 2                 ║');
console.log('╚════════════════════════════════════════════════════════════════╝');

// ── 1. DAILY REPORT — June 2 IA Revenue ──────────────────────────────────────
console.log('\n─── 1. DAILY REPORT — June 2 IA Revenue Issue ───');

const dailyJune2 = await query<any>(`
  SELECT
    DATE(j.hour_utc) AS day,
    aa.external_id,
    cp.code AS partner,
    ROUND(SUM(j.revenue)::numeric, 2) AS revenue,
    SUM(j.ad_clicks) AS ad_clicks,
    SUM(j.sessions) AS sessions
  FROM joined_stats_hourly j
  LEFT JOIN ad_accounts aa ON aa.id = j.ad_account_id
  LEFT JOIN client_partners cp ON cp.id = aa.client_partner_id
  WHERE DATE(j.hour_utc) = '2026-06-02'
  GROUP BY DATE(j.hour_utc), aa.external_id, cp.code
  ORDER BY partner, aa.external_id
`);
console.log('  Joined view data for June 2:');
dailyJune2.forEach((r: any) => {
  console.log(`    ${r.partner}/${r.external_id}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks} sessions=${r.sessions}`);
});

// Raw IA partner_stats_hourly for June 2
const iaRaw = await query<any>(`
  SELECT
    DATE(p.hour_utc) AS day,
    cp.code,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    COUNT(*) AS row_count
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  WHERE DATE(p.hour_utc) = '2026-06-02' AND cp.code = 'image_advantage'
  GROUP BY DATE(p.hour_utc), cp.code
`);
console.log('\n  Raw partner_stats_hourly for IA on June 2:');
if (iaRaw.length) {
  iaRaw.forEach((r: any) => {
    console.log(`    revenue=$${r.revenue} ad_clicks=${r.ad_clicks} sessions=${r.sessions} rows=${r.row_count}`);
  });
} else {
  console.log('    ❌ NO DATA FOUND');
}

// ── 2. DEVICE REPORT — Data Missing ──────────────────────────────────────────
console.log('\n─── 2. DEVICE REPORT — Data Missing Issue ───');

const deviceData = await query<any>(`
  SELECT
    p.device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    COUNT(*) AS row_count
  FROM partner_stats_hourly p
  WHERE DATE(p.hour_utc) = '2026-06-02'
  GROUP BY p.device
  ORDER BY revenue DESC NULLS LAST
`);
console.log('  Device breakdown for June 2:');
if (deviceData.length) {
  deviceData.forEach((r: any) => {
    const dev = r.device === '' ? '(empty string)' : r.device;
    console.log(`    ${dev}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks} rows=${r.row_count}`);
  });
} else {
  console.log('    ❌ NO DATA FOUND');
}

// ── 3. COUNTRY REPORT — Data Missing ─────────────────────────────────────────
console.log('\n─── 3. COUNTRY REPORT — Data Missing Issue ───');

const countryData = await query<any>(`
  SELECT
    p.country,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    COUNT(*) AS row_count
  FROM partner_stats_hourly p
  WHERE DATE(p.hour_utc) >= '2026-05-22' AND DATE(p.hour_utc) <= '2026-06-02'
  GROUP BY p.country
  ORDER BY revenue DESC NULLS LAST
  LIMIT 15
`);
console.log('  Country breakdown (May 22 - June 2):');
if (countryData.length) {
  countryData.forEach((r: any) => {
    const c = r.country === '' ? '(empty string)' : r.country;
    console.log(`    ${c}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks} rows=${r.row_count}`);
  });
} else {
  console.log('    ❌ NO DATA FOUND');
}

// ── 4. ADS REPORT — Codefuel and IA Data Missing ──────────────────────────────
console.log('\n─── 4. ADS REPORT — Missing Data Issue ───');

// Check CF ads for June 2
const cfAds = await query<any>(`
  SELECT
    COUNT(*) AS total_ads,
    COUNT(DISTINCT p.asset_gid) AS unique_gds,
    COUNT(DISTINCT p.channel) AS unique_channels,
    ROUND(SUM(p.revenue)::numeric, 2) AS total_revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  WHERE cp.code = 'codefuel'
    AND DATE(p.hour_utc) = '2026-06-02'
`);
console.log('  Codefuel (CF) data for June 2:');
if (cfAds[0]?.total_revenue) {
  console.log(`    ${cfAds[0].total_ads} rows, ${cfAds[0].unique_gds} unique gd_params, ${cfAds[0].unique_channels} channels`);
  console.log(`    Total revenue: $${cfAds[0].total_revenue}`);
} else {
  console.log('    ❌ NO DATA FOUND');
}

// Check IA ads attribution via joined view
const iaAds = await query<any>(`
  SELECT
    COUNT(*) AS total_rows,
    ROUND(SUM(j.revenue)::numeric, 2) AS total_revenue,
    SUM(CASE WHEN j.ad_account_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed_rows,
    SUM(CASE WHEN j.ad_account_id IS NULL THEN 1 ELSE 0 END) AS unattributed_rows
  FROM joined_stats_hourly j
  WHERE DATE(j.hour_utc) = '2026-06-02'
`);
console.log('\n  Image Advantage data for June 2 (via joined view):');
if (iaAds[0]) {
  console.log(`    Total rows: ${iaAds[0].total_rows}`);
  console.log(`    Attributed: ${iaAds[0].attributed_rows}, Unattributed: ${iaAds[0].unattributed_rows}`);
  console.log(`    Total revenue: $${iaAds[0].total_revenue}`);
}

// IA raw partner_stats for ad-level visibility
const iaAdDetail = await query<any>(`
  SELECT
    COUNT(*) AS rows,
    COUNT(DISTINCT campaign_ext_id) AS campaigns,
    COUNT(DISTINCT item_ext_id) AS items,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  WHERE cp.code = 'image_advantage' AND DATE(p.hour_utc) = '2026-06-02'
`);
console.log('\n  IA partner_stats detail for June 2:');
if (iaAdDetail[0]?.rows > 0) {
  console.log(`    Rows: ${iaAdDetail[0].rows}, Campaigns: ${iaAdDetail[0].campaigns}, Items: ${iaAdDetail[0].items}`);
  console.log(`    Revenue: $${iaAdDetail[0].revenue}`);
} else {
  console.log('    ❌ NO DATA FOUND');
}

// ── 5. SYNC STATUS & RECENT RUNS ─────────────────────────────────────────────
console.log('\n─── 5. SYNC STATUS & Recent Runs ───');

const syncRuns = await query<any>(`
  SELECT
    id, source, job_type, status,
    started_at, finished_at,
    rows_written,
    EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int AS duration_sec
  FROM sync_runs
  WHERE DATE(started_at) >= '2026-06-01'
  ORDER BY id DESC
  LIMIT 20
`);
console.log('  Recent sync runs (June 1+):');
if (syncRuns.length) {
  syncRuns.forEach((r: any) => {
    const fin = r.finished_at ? new Date(r.finished_at).toISOString().slice(11,16) : 'running';
    const status = r.status === 'ok' ? '✅' : '❌';
    console.log(`    ${status} ${r.source}/${r.job_type} rows=${r.rows_written} dur=${r.duration_sec}s fin=${fin}`);
  });
} else {
  console.log('    ❌ NO SYNC RUNS FOUND');
}

// ── 6. MATERIALIZED VIEW STATUS ──────────────────────────────────────────────
console.log('\n─── 6. Materialized View Status ───');

const mvStats = await query<any>(`
  SELECT
    COUNT(*) AS total_rows,
    MIN(hour_utc)::date AS earliest_date,
    MAX(hour_utc)::date AS latest_date,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue
  FROM joined_stats_hourly
`);
console.log('  Joined stats hourly MV:');
if (mvStats[0]) {
  console.log(`    Rows: ${mvStats[0].total_rows}, Date range: ${mvStats[0].earliest_date} to ${mvStats[0].latest_date}`);
  console.log(`    Total revenue: $${mvStats[0].total_revenue}`);
}

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║                        SUMMARY                                  ║');
console.log('╚════════════════════════════════════════════════════════════════╝');

if (dailyJune2.length === 0) {
  console.log('❌ CRITICAL: June 2 has NO data in joined view');
} else {
  console.log('✅ June 2 has data in joined view');
}

if (deviceData.length === 0 || deviceData.every((d: any) => d.device === '')) {
  console.log('❌ CRITICAL: Device report has no device breakdown (all empty)');
} else {
  console.log('✅ Device report has breakdown data');
}

if (countryData.length === 0 || countryData.every((c: any) => c.country === '')) {
  console.log('❌ CRITICAL: Country report has no country breakdown (all empty)');
} else {
  console.log('✅ Country report has breakdown data');
}

if (iaAdDetail[0]?.rows === 0) {
  console.log('❌ CRITICAL: IA partner_stats is empty for June 2');
} else {
  console.log('✅ IA has data in partner_stats');
}

console.log('\n');
process.exit(0);
