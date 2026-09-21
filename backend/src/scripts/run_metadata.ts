import { syncTaboolaMetadata } from '../sync/taboola.js';
import { query } from '../db/client.js';
import { pool } from '../db/client.js';

console.log('Running Taboola metadata sync...');
await syncTaboolaMetadata();

// Check if account 2037738 appeared
const accs = await query<any>(`
  SELECT id, external_id, name, client_partner_id
  FROM ad_accounts
  ORDER BY id DESC
  LIMIT 10
`);
console.log('\nMost recent ad_accounts:');
for (const r of accs) console.log(`  id=${r.id} ext=${r.external_id} partner=${r.client_partner_id}`);

const cnt = await query<any>('SELECT COUNT(*) FROM ad_accounts');
console.log('Total:', cnt[0].count);

await pool.end();
process.exit(0);
