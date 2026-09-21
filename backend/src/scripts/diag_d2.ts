import axios from 'axios';
import { env } from '../config/env.js';

const tokenRes = await axios.post(
  'https://backstage.taboola.com/backstage/oauth/token',
  new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TABOOLA_CLIENT_ID,
    client_secret: env.TABOOLA_CLIENT_SECRET,
  }),
  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
);
const token = tokenRes.data.access_token;
const client = axios.create({
  baseURL: env.TABOOLA_API_BASE,
  headers: { Authorization: `Bearer ${token}` },
  timeout: 60_000,
});

const SUB_ACCOUNT = 'tdg-sevenspheremedia4433-leadgenaffiliates-sc';

const { data } = await client.get(
  `/${SUB_ACCOUNT}/reports/campaign-summary/dimensions/campaign_hour_breakdown`,
  { params: { start_date: '2026-06-01', end_date: '2026-06-02', page_size: 1000 } },
);
const rows: any[] = data.results ?? data ?? [];
const june1 = rows.filter((r: any) => r.date?.startsWith('2026-06-01'));
console.log(`\nSub-account endpoint rows for June 1: ${june1.length}`);

const sums: Record<string, number> = {};
for (const row of june1) {
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'number') sums[k] = (sums[k] ?? 0) + v;
  }
}

console.log('\nSummed fields from sub-account endpoint:');
for (const [k, v] of Object.entries(sums).sort(([,a],[,b]) => b-a)) {
  const r = Math.round(v);
  const tag =
    (r >= 1590 && r <= 1620) ? ' ← CLICKS TARGET (1605)!' :
    (r >= 770  && r <= 795)  ? ' ← CONV TARGET (782)!' :
    (r >= 740  && r <= 770)  ? ' ← near DB clicks (756)' :
    (r >= 310  && r <= 335)  ? ' ← near DB conv (322)' : '';
  console.log(`  ${k.padEnd(35)} = ${v.toFixed(1)}${tag}`);
}

if (june1.length > 0) {
  console.log('\nFirst sample row:');
  console.log(JSON.stringify(june1[0], null, 2));
}
process.exit(0);
