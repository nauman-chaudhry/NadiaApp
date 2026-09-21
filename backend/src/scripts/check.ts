import { query } from '../db/client.js';

async function main() {
  const [r1, r2, r3, r4] = await Promise.all([
    // Check 2: orphan rows
    query('SELECT COUNT(*)::int AS n FROM joined_stats_hourly WHERE campaign_id IS NULL'),
    // Total MV rows
    query('SELECT COUNT(*)::int AS n FROM joined_stats_hourly'),
    // Check: unique (campaign_id, hour_utc) — should be 0 duplicates
    query(`SELECT COUNT(*) AS dupes FROM (
      SELECT campaign_id, hour_utc, COUNT(*) AS c
      FROM joined_stats_hourly
      GROUP BY campaign_id, hour_utc
      HAVING COUNT(*) > 1
    ) t`),
    // Hourly row count (24 max)
    query(`SELECT COUNT(*)::int AS n FROM (
      SELECT EXTRACT(HOUR FROM hour_utc)::int AS h,
             SUM(spent) AS spent, SUM(revenue) AS revenue
      FROM joined_stats_hourly
      GROUP BY h
    ) t`),
  ]);

  console.log('Check 2 - orphan rows (must be 0):', r1[0].n);
  console.log('Total MV rows:', r2[0].n);
  console.log('Duplicate (campaign_id, hour_utc) rows (must be 0):', r3[0].dupes);
  console.log('Distinct hours (0-23):', r4[0].n);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
