import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  DIAGNOSING JOIN FAILURE IN MATERIALIZED VIEW');
console.log('════════════════════════════════════════════════════════════════\n');

// Check if any Codefuel rows match ads
console.log('─ DO CODEFUEL asset_gid/channel MATCH ads.gd_param/r_param? ─\n');

const match = await query<any>(`
  SELECT
    COUNT(DISTINCT p.asset_gid, p.channel) AS cf_unique_keys,
    COUNT(DISTINCT a.gd_param, a.r_param) AS ads_unique_keys,
    COUNT(DISTINCT CASE WHEN a.gd_param IS NOT NULL THEN p.asset_gid, p.channel END) AS matched_keys
  FROM partner_stats_hourly p
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
`);

if (match[0]) {
  console.log(`CF unique asset_gid/channel pairs: ${match[0].cf_unique_keys}`);
  console.log(`Ads unique gd_param/r_param pairs: ${match[0].ads_unique_keys}`);
  console.log(`Matched pairs: ${match[0].matched_keys}`);
}

// Check sample of unmatched Codefuel rows
console.log('\n─ SAMPLE UNMATCHED CODEFUEL ROWS ─\n');
const unmatched = await query<any>(`
  SELECT
    p.asset_gid, p.channel,
    a.gd_param, a.r_param,
    COUNT(*) AS count
  FROM partner_stats_hourly p
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
    AND a.gd_param IS NULL
  GROUP BY p.asset_gid, p.channel, a.gd_param, a.r_param
  ORDER BY count DESC
  LIMIT 10
`);

console.log('Codefuel asset_gid/channel with NO matching ads:');
unmatched.forEach((r: any) => {
  console.log(`  ${r.asset_gid}/${r.channel} (${r.count} rows)`);
});

// Check if these asset_gid exist in ads at all
console.log('\n─ DO THESE asset_gid VALUES EXIST IN ADS TABLE AT ALL? ─\n');
const unmatchedGDs = unmatched.slice(0, 5).map((r: any) => r.asset_gid);
if (unmatchedGDs.length > 0) {
  const adsCheck = await query<any>(`
    SELECT DISTINCT gd_param FROM ads WHERE gd_param = ANY($1::text[])
  `, [unmatchedGDs]);

  console.log(`Checked ${unmatchedGDs.length} asset_gid values`);
  console.log(`Found in ads table: ${adsCheck.map((r: any) => r.gd_param).join(', ')}`);

  const missing = unmatchedGDs.filter((gd: string) => !adsCheck.map((r: any) => r.gd_param).includes(gd));
  if (missing.length > 0) {
    console.log(`\n⚠️  MISSING from ads table: ${missing.join(', ')}`);
    console.log('\nPossible causes:');
    console.log('  1. Taboola metadata sync hasn\'t been run or incomplete');
    console.log('  2. Taboola ads with these gd_params were never created');
    console.log('  3. Data synced out of order (Codefuel before Taboola)');
  }
}

// Check total counts
console.log('\n─ TOTAL DATA COUNTS ─\n');
const totals = await query<any>(`
  SELECT
    'codefuel_cf_total' AS metric, COUNT(*) AS count
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'

  UNION ALL

  SELECT 'ads_total' AS metric, COUNT(*) AS count
  FROM ads

  UNION ALL

  SELECT 'ads_with_gd_r_param' AS metric, COUNT(*) AS count
  FROM ads
  WHERE gd_param IS NOT NULL AND r_param IS NOT NULL

  UNION ALL

  SELECT 'campaigns_total' AS metric, COUNT(*) AS count
  FROM campaigns

  UNION ALL

  SELECT 'campaigns_with_taboola_account' AS metric, COUNT(*) AS count
  FROM campaigns c
  JOIN ad_accounts aa ON aa.id = c.ad_account_id
  WHERE aa.platform_id = (SELECT id FROM platforms WHERE code = 'taboola')
`);

totals.forEach((r: any) => {
  console.log(`${r.metric}: ${r.count}`);
});

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
