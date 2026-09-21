import { listAllowedAccounts } from '../sources/taboola/client.js';
import { pool } from '../db/client.js';

const accounts = await listAllowedAccounts();
console.log(`Total accounts from API: ${accounts.length}`);
for (const acc of accounts) {
  console.log(JSON.stringify(acc));
}
await pool.end();
process.exit(0);
