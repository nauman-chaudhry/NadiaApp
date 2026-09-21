import { query } from '../db/client.js';

const accounts = await query<any>(`
  SELECT a.id, a.external_id, a.name, a.client_partner_id, cp.code AS partner_code,
    (SELECT COUNT(*) FROM campaigns c WHERE c.ad_account_id = a.id) AS campaign_count
  FROM ad_accounts a
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  ORDER BY a.id
`);

console.log('All ad_accounts:');
for (const r of accounts) {
  console.log(`  id=${r.id} ext=${r.external_id} name="${r.name}" partner=${r.partner_code ?? 'NULL'} campaigns=${r.campaign_count}`);
}

process.exit(0);
