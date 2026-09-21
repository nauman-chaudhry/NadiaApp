import { query, pool } from '../db/client.js';

const before = await query<{ count: string }>('SELECT COUNT(*) FROM joined_stats_hourly');
console.log(`Row count before: ${before[0].count}`);

console.log('Refreshing...');
await query('REFRESH MATERIALIZED VIEW joined_stats_hourly');

const after = await query<{ count: string }>('SELECT COUNT(*) FROM joined_stats_hourly');
console.log(`Row count after:  ${after[0].count}`);

// Sanity check — June 1 per account (MV uses ad_account_id + hour_utc, not account_id + date)
console.log('\n=== June 1 sanity check ===');
const rows = await query<any>(`
  SELECT
    aa.external_id,
    cp.code AS partner,
    ROUND(SUM(j.spent)::numeric, 2)   AS spent,
    SUM(j.clicks)                      AS clicks,
    ROUND(SUM(j.revenue)::numeric, 2)  AS revenue
  FROM joined_stats_hourly j
  JOIN ad_accounts aa   ON aa.id = j.ad_account_id
  JOIN client_partners cp ON cp.id = aa.client_partner_id
  WHERE j.hour_utc >= '2026-06-01 00:00:00+00'
    AND j.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY aa.external_id, cp.code
  ORDER BY aa.external_id
`);

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  const mark = pass ? '✅' : '❌';
  console.log(`  ${mark} ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}
function near(a: number, b: number, pct = 0.1) {
  if (b === 0) return Math.abs(a) < 0.01;
  return Math.abs((a - b) / b * 100) <= pct;
}

for (const r of rows) {
  console.log(`\n  ${r.external_id} / ${r.partner}`);
  if (r.external_id === 'tdg-sevenspheremedia4433-leadgenaffiliates-sc') {
    check('spent ≈ $51.83',  near(Number(r.spent),   51.83), `actual=$${r.spent}`);
    check('clicks = 756',    Number(r.clicks) === 756,       `actual=${r.clicks}`);
    check('revenue ≈ $19.68', near(Number(r.revenue), 19.68), `actual=$${r.revenue}`);
  } else if (r.external_id === 'tdg-sevenspheremedia4433-leadgenaffiliates-2-sc') {
    check('spent ≈ $48.41',  near(Number(r.spent),   48.41), `actual=$${r.spent}`);
    check('clicks = 849',    Number(r.clicks) === 849,       `actual=${r.clicks}`);
    check('revenue ≈ $45.37', near(Number(r.revenue), 45.37), `actual=$${r.revenue}`);
  }
}

// Combined
const totSpent   = rows.reduce((s: number, r: any) => s + Number(r.spent),   0);
const totClicks  = rows.reduce((s: number, r: any) => s + Number(r.clicks),  0);
const totRevenue = rows.reduce((s: number, r: any) => s + Number(r.revenue), 0);
// Also include unattributed revenue in combined total
const unattrRow = await query<any>(`
  SELECT ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc <  '2026-06-02 00:00:00+00'
    AND ad_account_id IS NULL
`);
const unattrRevenue = Number(unattrRow[0]?.revenue ?? 0);
const combinedRevenue = totRevenue + unattrRevenue;

console.log(`\n  Combined (attributed accounts): spent=$${totSpent.toFixed(2)} clicks=${totClicks}`);
console.log(`  Unattributed revenue: $${unattrRevenue.toFixed(2)}`);
console.log(`  Combined total revenue (incl. unattributed): $${combinedRevenue.toFixed(2)}`);
check('combined spent ≈ $100.24',  near(totSpent,        100.24), `actual=$${totSpent.toFixed(2)}`);
check('combined clicks = 1605',    totClicks === 1605,            `actual=${totClicks}`);
check('combined revenue ≈ $667.87', near(combinedRevenue, 667.87, 0.5), `actual=$${combinedRevenue.toFixed(2)}`);

console.log(`\n${failures === 0 ? '✅ All checks passed' : `❌ ${failures} check(s) failed`}`);

await pool.end();
process.exit(failures > 0 ? 1 : 0);
