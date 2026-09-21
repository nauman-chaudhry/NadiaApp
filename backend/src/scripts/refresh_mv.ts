import { query } from '../db/client.js';
async function main() {
  console.log('Refreshing joined_stats_hourly...');
  await query('REFRESH MATERIALIZED VIEW joined_stats_hourly');
  console.log('Done.');
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
