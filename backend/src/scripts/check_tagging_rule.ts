import { query, pool } from '../db/client.js';

const rows = await query<any>(`
  SELECT external_id, name, client_partner_id
  FROM ad_accounts
  WHERE LOWER(name) LIKE '%codefuel%'
     OR LOWER(name) ~ 'lead gen affiliates[^a-z]*[0-9]*[^a-z]*- sc'
  ORDER BY name
`);
console.log('Accounts matched by new Codefuel tagging rule:');
for (const r of rows) console.log(JSON.stringify(r));

await pool.end();
process.exit(0);
