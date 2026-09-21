import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const tables = [
  'platforms', 'client_partners', 'ad_accounts', 'campaigns',
  'ads', 'ad_stats_hourly', 'partner_stats_hourly', 'sync_runs'
];

for (const t of tables) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
  console.log(t.padEnd(25), rows[0].n);
}

const mv = await pool.query('SELECT COUNT(*) AS n FROM joined_stats_hourly');
console.log('joined_stats_hourly (MV) '.padEnd(25), mv.rows[0].n);

const mig = await pool.query('SELECT filename, applied_at FROM _migrations ORDER BY applied_at');
console.log('\n_migrations:');
for (const r of mig.rows) console.log(' ', r.filename, r.applied_at.toISOString());

await pool.end();
