import { query, pool } from '../db/client.js';

const result = await query<any>(
  `UPDATE ad_accounts
   SET client_partner_id = 2
   WHERE external_id = 'tdg-sevenspheremedia4433-leadgenaffiliates-2-sc'
   RETURNING id, external_id, name, client_partner_id`,
);

console.log(`Rows affected: ${result.length}`);
if (result.length > 0) {
  const row = result[0];
  const partner = await query<{ code: string }>('SELECT code FROM client_partners WHERE id = $1', [row.client_partner_id]);
  console.log('Updated row:');
  console.log(JSON.stringify({ ...row, partner_code: partner[0]?.code }, null, 2));
}

await pool.end();
process.exit(result.length === 1 ? 0 : 1);
