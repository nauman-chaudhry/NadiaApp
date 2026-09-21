import { fetchDailyStats } from '../sources/taboola/client.js';
import { query } from '../db/client.js';

const rows = await fetchDailyStats({ startDate: '2026-06-01', endDate: '2026-06-02' });
const campRows = await query<any>(`SELECT external_id FROM campaigns WHERE ad_account_id = 17`);
const acct17 = new Set(campRows.map((r: any) => r.external_id));
const june1 = rows.filter((r: any) => acct17.has(r.campaign) && r.date?.startsWith('2026-06-01'));
console.log(`Daily rows for acct17 June1: ${june1.length}  campaigns: ${new Set(june1.map((r:any)=>r.campaign)).size}`);

const sums: Record<string, number> = {};
for (const row of june1) {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number') sums[k] = (sums[k] ?? 0) + v;
  }
}
for (const [k, v] of Object.entries(sums).sort(([,a],[,b]) => b-a)) {
  const r = Math.round(v);
  const tag =
    (r>=1590&&r<=1620)?' ← CLICKS TARGET!':(r>=770&&r<=795)?' ← CONV TARGET!':
    (r>=740&&r<=770)?' ← near DB clicks(756)':(r>=310&&r<=335)?' ← near DB conv(322)':'';
  console.log(`  ${k.padEnd(35)} = ${v.toFixed(1)}${tag}`);
}
if (june1.length>0) console.log('\nSample:', JSON.stringify(june1[0], null, 2));
process.exit(0);
