import { query } from '../db/client.js';

console.log('Investigating duplicate data...\n');

// Check if duplicates are at campaign level or hour level
const campaignDupes = await query<any>(`
  SELECT
    ad_account_id, hour_utc, campaign_external_id,
    COUNT(*) as count
  FROM ad_stats_hourly
  WHERE ad_account_id = 14
    AND hour_utc >= '2026-04-01' AND hour_utc < '2026-06-07'
  GROUP BY ad_account_id, hour_utc, campaign_external_id
  HAVING COUNT(*) > 1
  ORDER BY hour_utc
  LIMIT 10
`);

console.log('Duplicates at campaign level:');
if (campaignDupes.length === 0) {
  console.log('  None found\n');
} else {
  console.log(`  Found ${campaignDupes.length} duplicate sets\n`);
  campaignDupes.forEach((d: any) => {
    console.log(`  Hour: ${d.hour_utc}, Campaign: ${d.campaign_external_id}`);
    console.log(`    Duplicate count: ${d.count} records\n`);
  });
}

// Check the structure of these duplicate records
console.log('Examining specific duplicate records:\n');

const examplDupes = await query<any>(`
  SELECT
    campaign_external_id,
    clicks, spent, conversions,
    fetched_at
  FROM ad_stats_hourly
  WHERE ad_account_id = 14
    AND hour_utc = '2026-04-02T01:00:00+00'
  ORDER BY campaign_external_id
  LIMIT 10
`);

console.log(`Found ${examplDupes.length} records for 2026-04-02T01:00:00`);
examplDupes.forEach((r: any, idx: number) => {
  console.log(`  ${idx + 1}. Campaign: ${r.campaign_external_id}, Clicks: ${r.clicks}, Spent: ${r.spent}, Fetched: ${r.fetched_at}`);
});

// Check overall data completeness
console.log('\nData completeness check:\n');

const totalRecords = await query<any>(`
  SELECT
    COUNT(*) as total,
    COUNT(DISTINCT ad_account_id) as accounts,
    COUNT(DISTINCT hour_utc) as hours
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-01' AND hour_utc < '2026-06-07'
`);

if (totalRecords[0]) {
  console.log(`Total records: ${totalRecords[0].total}`);
  console.log(`Unique accounts: ${totalRecords[0].accounts}`);
  console.log(`Unique hours: ${totalRecords[0].hours}`);

  // Calculate expected records
  const expectedHours = totalRecords[0].hours;
  const expectedRecords = expectedHours * totalRecords[0].accounts;
  console.log(`\nExpected (if complete): ${expectedRecords} records`);
  console.log(`Actual: ${totalRecords[0].total} records`);
  console.log(`Extra records (duplicates): ${totalRecords[0].total - expectedRecords}`);
}

console.log('\n✅ Duplicate investigation complete');

process.exit(0);
