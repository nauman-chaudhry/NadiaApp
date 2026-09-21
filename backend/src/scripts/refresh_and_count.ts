import { query, pool } from '../db/client.js';

const before = await query<{ count: string }>('SELECT COUNT(*) FROM joined_stats_hourly');
console.log(`Row count before refresh: ${before[0].count}`);

console.log('Refreshing materialized view...');
await query('REFRESH MATERIALIZED VIEW joined_stats_hourly');

const after = await query<{ count: string }>('SELECT COUNT(*) FROM joined_stats_hourly');
console.log(`Row count after refresh:  ${after[0].count}`);

await pool.end();
process.exit(0);
