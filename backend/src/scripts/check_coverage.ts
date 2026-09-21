import { query } from '../db/client.js';
async function main() {
  const r = await query(`
    SELECT MIN(hour_utc)::text AS min_dt, MAX(hour_utc)::text AS max_dt,
           COUNT(DISTINCT date_trunc('day', hour_utc)) AS days
    FROM ad_stats_hourly`);
  console.log('COVERAGE=' + JSON.stringify(r[0]));

  const winA = await query(`
    SELECT SUM(impressions)::text AS impressions, SUM(clicks)::text AS clicks,
           SUM(spent)::text AS spent, SUM(conversions)::text AS conversions
    FROM ad_stats_hourly
    WHERE hour_utc >= '2026-04-08 00:00:00+00'
      AND hour_utc <  '2026-04-13 00:00:00+00'`);
  console.log('WIN_A_COST=' + JSON.stringify(winA[0]));

  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
