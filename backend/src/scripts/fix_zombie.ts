import { query } from '../db/client.js';

const updated = await query<any>(`
  UPDATE ad_accounts
     SET client_partner_id = (SELECT id FROM client_partners WHERE code = 'codefuel')
   WHERE external_id = 'tdg-sevenspheremedia4433-leadgenaffiliates-sc'
     AND client_partner_id IS NULL
  RETURNING id, external_id, name, client_partner_id
`);
console.log(`Rows updated: ${updated.length}`);
if (updated.length) console.log('Updated:', JSON.stringify(updated[0], null, 2));

const nulls = await query<any>(`
  SELECT id, external_id, name, client_partner_id FROM ad_accounts
  WHERE client_partner_id IS NULL ORDER BY name
`);
console.log(`\nAccounts still with null partner: ${nulls.length}`);
nulls.forEach((r: any) => console.log(`  id=${r.id}  ext=${r.external_id}  "${r.name}"`));

process.exit(0);
