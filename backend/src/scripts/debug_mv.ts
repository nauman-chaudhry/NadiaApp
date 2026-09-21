import { query } from '../db/client.js';

// 1. Does the Window B account exist?
const accs = await query<any>(`SELECT id, external_id, name FROM ad_accounts WHERE external_id = '17'`);
console.log('Account external_id=17:', accs);

// 2. Distinct ad_account_ids in MV for May 18-24
const accounts = await query<any>(`
  SELECT DISTINCT ad_account_id, COUNT(*) AS rows
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-05-18T00:00:00Z' AND hour_utc < '2026-05-25T00:00:00Z'
  GROUP BY ad_account_id
  ORDER BY rows DESC
  LIMIT 20
`);
console.log('\nMV accounts in May 18-24:', accounts);

// 3. Total MV rows and revenue for May 18-24 (no account filter)
const total = await query<any>(`
  SELECT COUNT(*) AS rows, ROUND(SUM(revenue)::numeric,2) AS revenue,
    ROUND(SUM(spent)::numeric,2) AS spent
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-05-18T00:00:00Z' AND hour_utc < '2026-05-25T00:00:00Z'
`);
console.log('\nMV totals May 18-24 (all accounts):', total[0]);

// 4. How many partner_stats_hourly rows exist for May 18-24?
const psh = await query<any>(`
  SELECT granularity, COUNT(*) AS rows, ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM partner_stats_hourly
  WHERE hour_utc >= '2026-05-18T00:00:00Z' AND hour_utc < '2026-05-25T00:00:00Z'
  GROUP BY granularity
`);
console.log('\npartner_stats_hourly May 18-24:', psh);

process.exit(0);
