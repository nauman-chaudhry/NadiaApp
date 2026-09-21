import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  DEEP DIAGNOSIS: WHY CODEFUEL DOESN\'T JOIN');
console.log('════════════════════════════════════════════════════════════════\n');

// 1. Check ads table structure
console.log('─ ADS TABLE STRUCTURE ─\n');
const adsCount = await query<any>(`
  SELECT
    COUNT(*) AS total,
    COUNT(CASE WHEN gd_param IS NOT NULL THEN 1 END) AS with_gd_param,
    COUNT(CASE WHEN r_param IS NOT NULL THEN 1 END) AS with_r_param,
    COUNT(CASE WHEN gd_param IS NOT NULL AND r_param IS NOT NULL THEN 1 END) AS with_both
  FROM ads
`);

if (adsCount[0]) {
  console.log(`Total ads: ${adsCount[0].total}`);
  console.log(`With gd_param: ${adsCount[0].with_gd_param}`);
  console.log(`With r_param: ${adsCount[0].with_r_param}`);
  console.log(`With BOTH: ${adsCount[0].with_both}`);
}

// 2. Check sample gd_param values
console.log('\n─ SAMPLE GD_PARAM VALUES IN ADS TABLE ─\n');
const sampleGDs = await query<any>(`
  SELECT DISTINCT gd_param FROM ads
  WHERE gd_param IS NOT NULL AND gd_param != ''
  ORDER BY gd_param
  LIMIT 20
`);

console.log(`Found ${sampleGDs.length} unique gd_param values:`);
sampleGDs.forEach((r: any) => {
  console.log(`  ${r.gd_param}`);
});

// 3. Check what Codefuel is sending
console.log('\n─ UNIQUE ASSET_GID VALUES FROM CODEFUEL (June 1) ─\n');
const cfAssets = await query<any>(`
  SELECT DISTINCT asset_gid FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
  ORDER BY asset_gid
`);

console.log(`Found ${cfAssets.length} unique asset_gid values from Codefuel:`);
cfAssets.forEach((r: any) => {
  console.log(`  ${r.asset_gid}`);
});

// 4. Check if there's ANY overlap
console.log('\n─ DO CODEFUEL ASSET_GID MATCH ANY ADS.GD_PARAM? ─\n');
const cfAssetIds = cfAssets.map((r: any) => r.asset_gid);
if (cfAssetIds.length > 0) {
  const matches = await query<any>(`
    SELECT DISTINCT gd_param FROM ads
    WHERE gd_param = ANY($1::text[])
  `, [cfAssetIds]);

  console.log(`Codefuel asset_gids: ${cfAssetIds.length}`);
  console.log(`Matching in ads.gd_param: ${matches.length}`);

  if (matches.length > 0) {
    console.log(`\nMatched values:`);
    matches.forEach((r: any) => {
      console.log(`  ✅ ${r.gd_param}`);
    });
  } else {
    console.log(`\n❌ ZERO MATCHES - this is the problem!`);
  }

  // Show which ones DON'T match
  const unmatchedIds = cfAssetIds.filter((id: string) => !matches.map((m: any) => m.gd_param).includes(id));
  console.log(`\nUnmatched (${unmatchedIds.length}):`);
  unmatchedIds.slice(0, 10).forEach((id: string) => {
    console.log(`  ❌ ${id}`);
  });
}

// 5. Check campaigns and accounts
console.log('\n─ DATA STRUCTURE ─\n');
const structure = await query<any>(`
  SELECT
    (SELECT COUNT(*) FROM ad_accounts) AS accounts,
    (SELECT COUNT(*) FROM campaigns) AS campaigns,
    (SELECT COUNT(*) FROM ads) AS ads,
    (SELECT COUNT(*) FROM platforms) AS platforms,
    (SELECT COUNT(*) FROM client_partners) AS partners
`);

if (structure[0]) {
  console.log(`Accounts: ${structure[0].accounts}`);
  console.log(`Campaigns: ${structure[0].campaigns}`);
  console.log(`Ads: ${structure[0].ads}`);
  console.log(`Platforms: ${structure[0].platforms}`);
  console.log(`Partners: ${structure[0].partners}`);
}

// 6. Check if Codefuel data even has campaign_ext_id
console.log('\n─ CODEFUEL DATA ATTRIBUTION STATUS ─\n');
const cfStatus = await query<any>(`
  SELECT
    SUM(CASE WHEN campaign_ext_id IS NOT NULL THEN 1 ELSE 0 END) AS with_campaign,
    SUM(CASE WHEN campaign_ext_id IS NULL THEN 1 ELSE 0 END) AS without_campaign,
    COUNT(*) AS total
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
`);

if (cfStatus[0]) {
  console.log(`Codefuel rows with campaign_ext_id: ${cfStatus[0].with_campaign}`);
  console.log(`Codefuel rows WITHOUT campaign_ext_id: ${cfStatus[0].without_campaign}`);
  console.log(`ATTRIBUTION RATE: ${cfStatus[0].with_campaign}/${cfStatus[0].total} = ${((cfStatus[0].with_campaign / cfStatus[0].total) * 100).toFixed(1)}%`);
}

// 7. Manual join test
console.log('\n─ MANUAL JOIN TEST ─\n');
const manualJoin = await query<any>(`
  SELECT
    p.asset_gid,
    p.channel,
    a.gd_param,
    a.r_param,
    a.title,
    COUNT(*) AS cf_rows,
    SUM(p.revenue) AS cf_revenue
  FROM partner_stats_hourly p
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY p.asset_gid, p.channel, a.gd_param, a.r_param, a.title
  ORDER BY cf_revenue DESC
  LIMIT 10
`);

console.log('Top 10 Codefuel asset_gid/channel with join attempt:');
manualJoin.forEach((r: any) => {
  const matched = r.gd_param ? '✅' : '❌';
  console.log(`${matched} ${r.asset_gid}/${r.channel}: ${r.cf_revenue} (${r.cf_rows} rows)`);
  if (r.gd_param) {
    console.log(`   Found ad: "${r.title}"`);
  }
});

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
