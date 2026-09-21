import 'dotenv/config';
import { query } from './src/db/client.js';
import { listItems } from './src/sources/taboola/client.js';

// Get 5 sample campaigns from the main Codefuel account
const campaigns = await query(`
  SELECT c.external_id, c.name, acc.external_id AS account_ext_id
  FROM campaigns c
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE LOWER(acc.name) LIKE '%yahoo codefuel - sc%'
    AND c.status = 'PAUSED'
  LIMIT 5
`);

console.log('Testing listItems on 5 campaigns...\n');
let totalItems = 0;
for (const c of campaigns) {
  try {
    const items = await listItems(c.account_ext_id, c.external_id);
    console.log(`Campaign ${c.external_id} (${c.name.slice(0, 40)}): ${items.length} items`);
    for (const item of items.slice(0, 2)) {
      console.log(`  item.id=${item.id}  url=${item.url?.slice(0, 80)}`);
    }
    totalItems += items.length;
  } catch (e) {
    console.log(`Campaign ${c.external_id}: ERROR ${e.message}`);
  }
}
console.log('\nTotal items from 5 campaigns:', totalItems);
process.exit(0);
