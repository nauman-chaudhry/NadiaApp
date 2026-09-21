/**
 * Asserts that no (campaign_ext_id, hour_utc) combination has BOTH
 * campaign-level rows (item_ext_id='0') AND item-level rows (item_ext_id≠'0').
 *
 * Run after any IA sync to confirm deduplication is working.
 */
import { query, pool } from '../db/client.js';

const date = process.argv[2] ?? '2026-06-01';
const dateEnd = (() => {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
})();

console.log(`Checking IA dedup for ${date}...`);

const dups = await query<any>(`
  SELECT
    campaign_ext_id,
    hour_utc,
    SUM(CASE WHEN item_ext_id = '0' THEN 1 ELSE 0 END) AS campaign_level_rows,
    SUM(CASE WHEN item_ext_id != '0' THEN 1 ELSE 0 END) AS item_level_rows,
    ROUND(SUM(CASE WHEN item_ext_id = '0' THEN revenue ELSE 0 END)::numeric, 4) AS campaign_level_rev,
    ROUND(SUM(CASE WHEN item_ext_id != '0' THEN revenue ELSE 0 END)::numeric, 4) AS item_level_rev
  FROM partner_stats_hourly
  WHERE campaign_ext_id IS NOT NULL
    AND hour_utc >= $1::timestamptz
    AND hour_utc <  $2::timestamptz
  GROUP BY campaign_ext_id, hour_utc
  HAVING SUM(CASE WHEN item_ext_id = '0' THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN item_ext_id != '0' THEN 1 ELSE 0 END) > 0
`, [`${date}T00:00:00Z`, `${dateEnd}T00:00:00Z`]);

if (dups.length === 0) {
  console.log(`✅ Zero double-counted (campaign+item) combos for ${date}`);
} else {
  console.log(`❌ Found ${dups.length} double-counted combos:`);
  for (const r of dups) console.log(`  ${JSON.stringify(r)}`);
}

await pool.end();
process.exit(dups.length > 0 ? 1 : 0);
