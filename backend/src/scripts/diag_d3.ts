import { fetchHourlyStats } from '../sources/taboola/client.js';
import { query } from '../db/client.js';

const rows = await fetchHourlyStats({ startDate: '2026-06-01', endDate: '2026-06-02' });
console.log(`\nAPI rows returned: ${rows.length}`);

const campRows = await query<any>(`SELECT external_id FROM campaigns WHERE ad_account_id = 17`);
const acct17 = new Set(campRows.map((r: any) => r.external_id));
const june1 = rows.filter(r => acct17.has(r.campaign) && r.date.startsWith('2026-06-01'));
console.log(`API rows for account 17 June 1: ${june1.length}`);
console.log(`Distinct campaigns: ${new Set(june1.map(r => r.campaign)).size}`);

const sums: Record<string, number> = {};
for (const row of june1) {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number') sums[k] = (sums[k] ?? 0) + v;
  }
}

console.log('\nAll summed numeric fields (sorted desc):');
for (const [k, v] of Object.entries(sums).sort(([,a],[,b]) => b-a)) {
  const r = Math.round(v);
  const tag =
    (r >= 1590 && r <= 1620) ? ' ← CLICKS TARGET (1605)' :
    (r >= 770  && r <= 795)  ? ' ← CONV TARGET (782)' :
    (r >= 740  && r <= 770)  ? ' ← near DB clicks (756)' :
    (r >= 310  && r <= 335)  ? ' ← near DB conv (322)' : '';
  console.log(`  ${k.padEnd(35)} = ${v.toFixed(1)}${tag}`);
}

const db = await query<any>(`
  SELECT SUM(clicks)::int AS db_clicks, SUM(conversions)::int AS db_conversions,
         ROUND(SUM(spent)::numeric,2) AS db_spent
  FROM ad_stats_hourly WHERE ad_account_id=17
    AND hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
`);
console.log('\nDB totals:', db[0]);

if (june1.length > 0) {
  console.log('\nFirst sample row:');
  console.log(JSON.stringify(june1[0], null, 2));
}
process.exit(0);
