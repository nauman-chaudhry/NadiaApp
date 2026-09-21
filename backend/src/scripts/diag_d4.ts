import { query } from '../db/client.js';

const ia = await query<any>(`SELECT item_ext_id, campaign_ext_id, revenue FROM partner_stats_hourly WHERE item_ext_id IS NOT NULL LIMIT 5`);
console.log('IA item_ext_id samples:');
ia.forEach((r: any) => console.log(' ', JSON.stringify(r)));

const ads = await query<any>(`SELECT external_id, title FROM ads LIMIT 5`);
console.log('\nads.external_id samples:');
ads.forEach((r: any) => console.log(' ', JSON.stringify(r)));

const overlap = await query<any>(`
  SELECT COUNT(*) AS cnt FROM partner_stats_hourly p
  JOIN ads a ON a.external_id = p.item_ext_id
  WHERE p.item_ext_id IS NOT NULL
`);
console.log('\nitem_ext_id / external_id overlap count:', overlap[0].cnt);

process.exit(0);
