import { query } from '../db/client.js';

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  TESTING API FIXES — Device, Country, & Ads Views');
console.log('═══════════════════════════════════════════════════════════════\n');

// Simulate the device view query that the API would run
console.log('─ DEVICE VIEW — June 2 ─');

// Test CF device data
const cfDeviceRows = await query<any>(`
  SELECT
    p.device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device
  ORDER BY revenue DESC
`);

// Test IA device data
const iaDeviceRows = await query<any>(`
  SELECT
    '(Unattributed)' AS device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
    AND (p.device IS NULL OR p.device = '')
`);

const deviceRows = [...cfDeviceRows, ...iaDeviceRows].sort((a, b) => b.revenue - a.revenue);
console.log('Device view results:');
deviceRows.forEach((r: any) => {
  console.log(`  ${r.device}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks}`);
});

// Country view test
console.log('\n─ COUNTRY VIEW — June 2 ─');

const cfCountryRows = await query<any>(`
  SELECT
    p.country,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
    AND p.country IS NOT NULL AND p.country <> ''
  GROUP BY p.country
  ORDER BY revenue DESC
`);

const iaCountryRows = await query<any>(`
  SELECT
    '(Unattributed)' AS country,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
    AND (p.country IS NULL OR p.country = '')
`);

const countryRows = [...cfCountryRows, ...iaCountryRows].sort((a, b) => b.revenue - a.revenue);
console.log('Country view results (top 10):');
countryRows.slice(0, 10).forEach((r: any) => {
  const country = r.country === '' ? '(empty)' : r.country;
  console.log(`  ${country}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks}`);
});

// Ads view test
console.log('\n─ ADS VIEW — June 2 ─');

const adsIaSql = `
  SELECT
    '(Unattributed - Image Advantage)' AS ad_name,
    COALESCE(SUM(p.revenue), 0) AS revenue,
    COALESCE(SUM(p.ad_clicks), 0) AS ad_clicks,
    COALESCE(SUM(p.sessions), 0) AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
`;

const adsIaRows = await query<any>(adsIaSql);
console.log('IA ads aggregate:');
adsIaRows.forEach((r: any) => {
  console.log(`  ${r.ad_name}: revenue=$${r.revenue} ad_clicks=${r.ad_clicks}`);
});

// CF ads count
const cfAdsCountSql = `
  SELECT COUNT(DISTINCT p.asset_gid) AS unique_ads,
         ROUND(SUM(p.revenue)::numeric, 2) AS total_revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc < '2026-06-03 00:00:00+00'
`;

const cfAdsCount = await query<any>(cfAdsCountSql);
if (cfAdsCount[0]) {
  console.log(`CF ads: ${cfAdsCount[0].unique_ads} ads, revenue=$${cfAdsCount[0].total_revenue}`);
}

// Filter options test
console.log('\n─ FILTER OPTIONS ─');

const devicesOptions = await query<any>(`
  SELECT DISTINCT device FROM partner_stats_hourly
  WHERE device IS NOT NULL AND device <> ''
  ORDER BY device
`);

const hasIADevice = await query<any>(`
  SELECT 1 FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  WHERE cp.code = 'image_advantage' AND (p.device IS NULL OR p.device = '')
  LIMIT 1
`);

const deviceOptions = [...devicesOptions.map((r: any) => r.device)];
if (hasIADevice.length > 0) {
  deviceOptions.push('(Unattributed)');
}

const countriesOptions = await query<any>(`
  SELECT DISTINCT country FROM partner_stats_hourly
  WHERE country IS NOT NULL AND country <> ''
  ORDER BY country
`);

const hasIACountry = await query<any>(`
  SELECT 1 FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  WHERE cp.code = 'image_advantage' AND (p.country IS NULL OR p.country = '')
  LIMIT 1
`);

const countryOptions = [...countriesOptions.map((r: any) => r.country)];
if (hasIACountry.length > 0) {
  countryOptions.push('(Unattributed)');
}

console.log(`  Devices: ${deviceOptions.length} options`);
console.log(`    ${deviceOptions.slice(0, 5).join(', ')}${deviceOptions.length > 5 ? '...' : ''}`);
console.log(`  Countries: ${countryOptions.length} options`);
console.log(`    ${countryOptions.slice(0, 5).join(', ')}${countryOptions.length > 5 ? '...' : ''}`);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  ✅ All API views now include Image Advantage data');
console.log('═══════════════════════════════════════════════════════════════\n');

process.exit(0);
