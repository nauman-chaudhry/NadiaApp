import { query } from '../db/client.js';

// Check recent sync_runs
const runs = await query<any>(`
  SELECT id, source, job_type, status, rows_written,
    started_at, finished_at,
    EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int AS duration_sec
  FROM sync_runs
  ORDER BY id DESC
  LIMIT 10
`);
console.log('Recent sync_runs:');
for (const r of runs) {
  const fin = r.finished_at ? new Date(r.finished_at).toISOString().slice(11,19) : 'running';
  console.log(`  id=${r.id} ${r.source}/${r.job_type} status=${r.status} rows=${r.rows_written} dur=${r.duration_sec}s fin=${fin}`);
}

// Check if account 2037738 appeared
const accs = await query<any>(`
  SELECT id, external_id, name, client_partner_id
  FROM ad_accounts
  WHERE external_id LIKE '%2037738%' OR external_id = '2037738'
`);
console.log('\nAccounts matching 2037738:', accs.length ? accs : 'NOT FOUND');

// Total account count
const cnt = await query<any>('SELECT COUNT(*) FROM ad_accounts');
console.log('Total ad_accounts:', cnt[0].count);

process.exit(0);
