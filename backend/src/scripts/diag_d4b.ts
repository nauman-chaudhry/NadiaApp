import { query } from '../db/client.js';
const r = await query<any>(`SELECT a.id, a.external_id, a.title, a.gd_param FROM ads a JOIN campaigns c ON c.id = a.campaign_id WHERE c.ad_account_id = 12 LIMIT 8`);
console.log('Ads in account 12:'); r.forEach((x: any) => console.log(' ', JSON.stringify(x)));
const ia = await query<any>(`SELECT DISTINCT item_ext_id FROM partner_stats_hourly WHERE campaign_ext_id = '49396876' AND item_ext_id IS NOT NULL LIMIT 8`);
console.log('\nIA item_ext_ids for camp 49396876:'); ia.forEach((x: any) => console.log(' ', x.item_ext_id));
const camp = await query<any>(`SELECT external_id, ad_account_id FROM campaigns WHERE external_id = '49396876'`);
console.log('\nCampaign 49396876:', camp[0]);
process.exit(0);
