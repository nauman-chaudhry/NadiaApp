import { query, pool } from '../db/client.js';

// Understand item_ext_id distribution for IA rows on June 1
console.log('=== IA item_ext_id distribution June 1 ===');
const dist = await query<any>(`
  SELECT
    item_ext_id,
    COUNT(*) AS rows,
    COUNT(DISTINCT campaign_ext_id) AS campaigns,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly
  WHERE campaign_ext_id IS NOT NULL
    AND hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
  GROUP BY item_ext_id
  ORDER BY rows DESC
  LIMIT 20
`);
for (const r of dist) console.log(JSON.stringify(r));

// Are there any (campaign_ext_id, hour_utc) combos that have BOTH item_ext_id='0' rows
// AND item_ext_id!='0' rows? (existing double-counting candidates)
console.log('\n=== Combos with both campaign-level (item_ext_id=0) and item-level rows ===');
const dups = await query<any>(`
  SELECT
    campaign_ext_id,
    hour_utc,
    SUM(CASE WHEN item_ext_id = '0' THEN 1 ELSE 0 END) AS campaign_level_cnt,
    SUM(CASE WHEN item_ext_id != '0' THEN 1 ELSE 0 END) AS item_level_cnt,
    ROUND(SUM(CASE WHEN item_ext_id = '0' THEN revenue ELSE 0 END)::numeric, 4) AS campaign_level_rev,
    ROUND(SUM(CASE WHEN item_ext_id != '0' THEN revenue ELSE 0 END)::numeric, 4) AS item_level_rev
  FROM partner_stats_hourly
  WHERE campaign_ext_id IS NOT NULL
    AND hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
  GROUP BY campaign_ext_id, hour_utc
  HAVING SUM(CASE WHEN item_ext_id = '0' THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN item_ext_id != '0' THEN 1 ELSE 0 END) > 0
  ORDER BY campaign_ext_id, hour_utc
  LIMIT 10
`);
console.log(`Found ${dups.length} double-counted combos`);
for (const r of dups) console.log(JSON.stringify(r));

// Sample of one campaign's rows to understand structure
console.log('\n=== Sample rows for campaign 49396875 June 1 (first 5) ===');
const sample = await query<any>(`
  SELECT campaign_ext_id, item_ext_id, hour_utc, ad_clicks, sessions, revenue
  FROM partner_stats_hourly
  WHERE campaign_ext_id = '49396875'
    AND hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
  ORDER BY hour_utc, item_ext_id
  LIMIT 10
`);
for (const r of sample) console.log(JSON.stringify(r));

await pool.end();
process.exit(0);
