import { query } from '../db/client.js';

console.log('═══════════════════════════════════════════════════════════════\n');
console.log('CHECKING FOR DUPLICATES IN DATA\n');
console.log('═══════════════════════════════════════════════════════════════\n');

// Simple duplicate check - just on hour_utc and account_id
const dupes = await query<any>(`
  SELECT
    ad_account_id,
    hour_utc,
    COUNT(*) as record_count,
    SUM(clicks) as total_clicks
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-01' AND hour_utc < '2026-06-07'
  GROUP BY ad_account_id, hour_utc
  HAVING COUNT(*) > 1
  ORDER BY record_count DESC
`);

console.log(`Found ${dupes.length} hour/account combinations with duplicates\n`);

if (dupes.length > 0) {
  console.log('Top 10 duplicate sets:');
  dupes.slice(0, 10).forEach((d: any, idx: number) => {
    console.log(`  ${idx + 1}. Account ${d.ad_account_id}, Hour: ${new Date(d.hour_utc).toISOString()}`);
    console.log(`     Records: ${d.record_count}, Total Clicks: ${d.total_clicks}\n`);
  });

  console.log('\n⚠️  DUPLICATES DETECTED!\n');
  console.log('These are records for the SAME account and SAME hour that appear multiple times.');
  console.log('This could be due to:');
  console.log('  1. Multiple syncs of the same data');
  console.log('  2. Data from different campaigns aggregated incorrectly\n');

  // Check if it's campaign data (multiple rows per hour per account)
  console.log('Checking if these are campaign-level records...\n');

  const examplRow = await query<any>(`
    SELECT * FROM ad_stats_hourly
    WHERE ad_account_id = $1 AND hour_utc = $2
    LIMIT 3
  `, [dupes[0].ad_account_id, dupes[0].hour_utc]);

  console.log('Sample records from first duplicate set:');
  examplRow.forEach((row: any, idx: number) => {
    console.log(`  Record ${idx + 1}:`);
    Object.keys(row).forEach(key => {
      if (key !== 'id' && key !== 'created_at' && key !== 'fetched_at') {
        console.log(`    ${key}: ${row[key]}`);
      }
    });
    console.log('');
  });

} else {
  console.log('✅ NO DUPLICATES FOUND\n');
}

// Check total vs unique
const totals = await query<any>(`
  SELECT
    COUNT(*) as total_rows,
    COUNT(DISTINCT ad_account_id, hour_utc) as unique_hours,
    COUNT(DISTINCT ad_account_id) as unique_accounts
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-01' AND hour_utc < '2026-06-07'
`);

if (totals[0]) {
  console.log('Total Data Summary:');
  console.log(`  Total rows: ${totals[0].total_rows}`);
  console.log(`  Unique account/hour combinations: ${totals[0].unique_hours}`);
  console.log(`  Unique accounts: ${totals[0].unique_accounts}\n`);
}

console.log('═══════════════════════════════════════════════════════════════\n');

process.exit(0);
