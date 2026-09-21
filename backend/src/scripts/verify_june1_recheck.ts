import { query, pool } from '../db/client.js';

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  const mark = pass ? '✓' : '✗';
  console.log(`  ${mark} ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}
function near(a: number, b: number, pctTolerance = 0.1) {
  if (b === 0) return Math.abs(a) < 0.01;
  return Math.abs((a - b) / b * 100) <= pctTolerance;
}

console.log('\n=== June 1 per-account breakdown (joined_stats_hourly) ===');
const perAcct = await query<any>(`
  SELECT
    a.external_id,
    a.id AS db_id,
    SUM(j.clicks)                        AS clicks,
    SUM(j.conversions)                   AS conversions,
    ROUND(SUM(j.spent)::numeric,2)       AS spent,
    ROUND(SUM(j.revenue)::numeric,2)     AS revenue,
    SUM(j.impressions)                   AS impressions
  FROM joined_stats_hourly j
  JOIN ad_accounts a ON a.id = j.ad_account_id
  WHERE j.hour_utc >= '2026-06-01 00:00:00+00'
    AND j.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY a.external_id, a.id
  ORDER BY a.id
`);

let totalClicks = 0, totalConv = 0, totalSpent = 0, totalRevenue = 0;
for (const r of perAcct) {
  console.log(`  ${r.external_id} (id=${r.db_id}): clicks=${r.clicks} conv=${r.conversions} spent=$${r.spent} revenue=$${r.revenue}`);
  totalClicks   += Number(r.clicks);
  totalConv     += Number(r.conversions);
  totalSpent    += Number(r.spent);
  totalRevenue  += Number(r.revenue);
}

console.log(`\n  Combined: clicks=${totalClicks} conv=${totalConv} spent=$${totalSpent.toFixed(2)} revenue=$${totalRevenue.toFixed(2)}`);

console.log('\n=== Validation ===');

// Per-account checks
const lga1 = perAcct.find((r: any) => r.external_id === 'tdg-sevenspheremedia4433-leadgenaffiliates-sc');
const lga2 = perAcct.find((r: any) => r.external_id === 'tdg-sevenspheremedia4433-leadgenaffiliates-2-sc');

check('LGA-1 clicks = 756',         lga1 && Number(lga1.clicks) === 756,      `actual=${lga1?.clicks}`);
check('LGA-1 spent ≈ $51.83',       lga1 && near(Number(lga1.spent), 51.83),  `actual=$${lga1?.spent}`);
check('LGA-2 clicks = 849',         lga2 && Number(lga2.clicks) === 849,      `actual=${lga2?.clicks}`);
check('LGA-2 spent ≈ $48.41',       lga2 && near(Number(lga2.spent), 48.41),  `actual=$${lga2?.spent}`);

// Combined checks (network targets)
check('Combined clicks = 1605',     totalClicks === 1605,                           `actual=${totalClicks}`);
check('Combined conv = 782',        totalConv === 782,                              `actual=${totalConv}`);
check('Combined spent ≈ $100.24',   near(totalSpent, 100.24),                       `actual=$${totalSpent.toFixed(2)}`);
check('Combined revenue ≈ $667.87', near(totalRevenue, 667.87, 0.5),               `actual=$${totalRevenue.toFixed(2)}`);

// LGA-2 revenue should now be non-zero (previously it was attributed to IA and invisible here)
check('LGA-2 revenue > 0 (now joining CF)',  lga2 && Number(lga2.revenue) > 0,     `actual=$${lga2?.revenue}`);

console.log(`\n${failures === 0 ? '✓ ALL CHECKS PASSED' : `✗ ${failures} CHECK(S) FAILED`}`);

await pool.end();
process.exit(failures > 0 ? 1 : 0);
