import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  FINDING MISSING TABOOLA ASSETS');
console.log('════════════════════════════════════════════════════════════════\n');

// List all the missing asset_gid values
const missingAssets = ['AP1009251', 'AP1009313', 'AP1009280', 'AP1009330'];

console.log('Missing assets from Codefuel that don\'t exist in ads table:');
missingAssets.forEach((asset: string) => {
  console.log(`  - ${asset}`);
});

// Check if ANY Taboola campaigns have external_id starting with these
console.log('\n─ SEARCHING TABOOLA CAMPAIGNS FOR THESE ASSETS ─\n');

const campaigns = await query<any>(`
  SELECT
    c.id, c.external_id, c.name,
    aa.external_id AS account_id,
    aa.name AS account_name
  FROM campaigns c
  JOIN ad_accounts aa ON aa.id = c.ad_account_id
  WHERE aa.platform_id = (SELECT id FROM platforms WHERE code = 'taboola')
  ORDER BY c.external_id
  LIMIT 50
`);

console.log(`Found ${campaigns.length} Taboola campaigns. Sample:`);
campaigns.slice(0, 10).forEach((c: any) => {
  console.log(`  Campaign: ${c.external_id} / ${c.name}`);
  console.log(`    Account: ${c.account_id} (${c.account_name})`);
});

// Check if these missing assets show up in ANY Codefuel revenue breakdown
console.log('\n─ CODEFUEL REVENUE BY ASSET_GID (ALL TIME) ─\n');

const cfByAsset = await query<any>(`
  SELECT
    p.asset_gid,
    COUNT(*) AS rows,
    COUNT(DISTINCT p.channel) AS channels,
    ROUND(SUM(p.revenue)::numeric, 2) AS total_revenue,
    MAX(p.hour_utc) AS latest_date,
    MIN(p.hour_utc) AS earliest_date
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  GROUP BY p.asset_gid
  ORDER BY total_revenue DESC
`);

console.log('All Codefuel asset_gid values (by revenue):');
cfByAsset.forEach((r: any) => {
  const exists = ['AP1008549', 'AP1008652', 'AP1009170'].includes(r.asset_gid) ? '✅' : '❌';
  const date = new Date(r.latest_date).toISOString().split('T')[0];
  console.log(`${exists} ${r.asset_gid}: $${r.total_revenue} (${r.rows} rows, ${r.channels} channels) - latest: ${date}`);
});

// Check Taboola accounts
console.log('\n─ TABOOLA ACCOUNTS IN DATABASE ─\n');
const taboolaAccounts = await query<any>(`
  SELECT
    aa.id, aa.external_id, aa.name,
    COUNT(DISTINCT c.id) AS campaign_count
  FROM ad_accounts aa
  LEFT JOIN campaigns c ON c.ad_account_id = aa.id
  WHERE aa.platform_id = (SELECT id FROM platforms WHERE code = 'taboola')
  GROUP BY aa.id, aa.external_id, aa.name
  ORDER BY aa.name
`);

console.log('Taboola accounts:');
taboolaAccounts.forEach((a: any) => {
  console.log(`  ${a.external_id}: ${a.name} (${a.campaign_count} campaigns)`);
});

// Check for the specific account 1823395 that Nadia mentioned
console.log('\n─ LOOKING FOR ACCOUNT 1823395 ─\n');
const account1823395 = await query<any>(`
  SELECT * FROM ad_accounts
  WHERE external_id LIKE '%1823395%'
     OR external_id LIKE '%leadgenaffiliates%'
     OR name LIKE '%1823395%'
`);

if (account1823395.length > 0) {
  console.log('Found matching accounts:');
  account1823395.forEach((a: any) => {
    console.log(`  ID: ${a.id}, external_id: ${a.external_id}, name: ${a.name}`);
  });
} else {
  console.log('❌ Account 1823395 NOT FOUND in database');
  console.log('\nThis might be the problem! The Taboola account that Nadia is referring to');
  console.log('might not be in the database, or has a different external_id.');
}

// Summary
console.log('\n════════════════════════════════════════════════════════════════');
console.log('\n📊 SUMMARY:\n');
console.log('Missing assets:');
missingAssets.forEach((asset: string) => {
  const cfData = cfByAsset.find((r: any) => r.asset_gid === asset);
  if (cfData) {
    console.log(`  ${asset}: Codefuel reports $${cfData.total_revenue} in revenue`);
    console.log(`           But this asset_gid doesn't exist in Taboola ads table!`);
  }
});

console.log('\nPOSSIBLE CAUSES:');
console.log('1. These Taboola assets don\'t exist (or were deleted)');
console.log('2. These assets exist in Taboola but weren\'t synced to the database');
console.log('3. These assets belong to a Taboola account that isn\'t being synced');
console.log('4. There\'s a data discrepancy between Taboola and Codefuel systems');

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
