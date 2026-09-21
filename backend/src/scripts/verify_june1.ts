/**
 * verify_june1.ts — June 1 2026 reconciliation check.
 *
 * Usage:
 *   npx tsx src/scripts/verify_june1.ts [--scope codefuel|image_advantage|combined]
 *
 * Scopes:
 *   codefuel        LGA-1 (leadgenaffiliates-sc) only
 *   image_advantage LGA-2 (leadgenaffiliates-2-sc) only
 *   combined        Both accounts + unattributed revenue (default)
 */

import { query, pool } from '../db/client.js';

const args = process.argv.slice(2);
const scopeIdx = args.indexOf('--scope');
const scope: 'codefuel' | 'image_advantage' | 'combined' =
  scopeIdx !== -1 && args[scopeIdx + 1]
    ? (args[scopeIdx + 1] as any)
    : 'combined';

const VALID_SCOPES = ['codefuel', 'image_advantage', 'combined'];
if (!VALID_SCOPES.includes(scope)) {
  console.error(`Unknown scope "${scope}". Use: codefuel | image_advantage | combined`);
  process.exit(1);
}

// ── Targets ──────────────────────────────────────────────────────────────────
const TARGETS = {
  codefuel: {
    account_ext_id: 'tdg-sevenspheremedia4433-leadgenaffiliates-sc',
    spent:      51.83,
    clicks:     756,
    revenue:    19.68,
    ad_clicks:  106,
    sessions:   695,
  },
  image_advantage: {
    account_ext_id: 'tdg-sevenspheremedia4433-leadgenaffiliates-2-sc',
    spent:   48.41,
    clicks:  849,
    revenue: 45.37,
  },
  combined: {
    spent:   100.24,
    clicks:  1605,
    // Combined revenue includes unattributed Codefuel rows (ad_account_id IS NULL)
    revenue: 667.87,
  },
};

let failures = 0;
function check(label: string, pass: boolean, detail = '') {
  const mark = pass ? '✅' : '❌';
  console.log(`  ${mark} ${label}${detail ? ' — ' + detail : ''}`);
  if (!pass) failures++;
}
function near(a: number, b: number, pctTol = 0.1) {
  if (b === 0) return Math.abs(a) < 0.01;
  return Math.abs((a - b) / b * 100) <= pctTol;
}

const DATE_FROM = '2026-06-01 00:00:00+00';
const DATE_TO   = '2026-06-02 00:00:00+00';

// ── Per-account breakdown (always printed) ────────────────────────────────────
console.log('\n=== June 1 per-account breakdown ===');
const perAcct = await query<any>(`
  SELECT
    aa.external_id,
    cp.code                            AS partner,
    SUM(j.clicks)                      AS clicks,
    SUM(j.conversions)                 AS conversions,
    ROUND(SUM(j.spent)::numeric,  2)   AS spent,
    ROUND(SUM(j.revenue)::numeric, 2)  AS revenue,
    SUM(j.ad_clicks)                   AS ad_clicks,
    SUM(j.sessions)                    AS sessions
  FROM joined_stats_hourly j
  JOIN ad_accounts aa   ON aa.id = j.ad_account_id
  JOIN client_partners cp ON cp.id = aa.client_partner_id
  WHERE j.hour_utc >= $1 AND j.hour_utc < $2
  GROUP BY aa.external_id, cp.code
  ORDER BY aa.external_id
`, [DATE_FROM, DATE_TO]);

for (const r of perAcct) {
  console.log(
    `  ${r.external_id} (${r.partner}): ` +
    `clicks=${r.clicks} spent=$${r.spent} revenue=$${r.revenue} ` +
    `ad_clicks=${r.ad_clicks} sessions=${r.sessions}`,
  );
}

const unattrRow = await query<any>(`
  SELECT ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= $1 AND hour_utc < $2 AND ad_account_id IS NULL
`, [DATE_FROM, DATE_TO]);
const unattrRevenue = Number(unattrRow[0]?.revenue ?? 0);
console.log(`  (Unattributed revenue): $${unattrRevenue.toFixed(2)}`);

// ── Scope-specific checks ─────────────────────────────────────────────────────
console.log(`\n=== Validation — scope: ${scope} ===`);

if (scope === 'codefuel') {
  const t = TARGETS.codefuel;
  const r = perAcct.find((x: any) => x.external_id === t.account_ext_id);
  if (!r) { console.log('  ❌ Account not found in MV'); failures++; }
  else {
    check(`spent ≈ $${t.spent}`,        near(Number(r.spent),    t.spent),    `actual=$${r.spent}`);
    check(`clicks = ${t.clicks}`,       Number(r.clicks) === t.clicks,         `actual=${r.clicks}`);
    check(`revenue ≈ $${t.revenue}`,    near(Number(r.revenue),  t.revenue),  `actual=$${r.revenue}`);
    check(`ad_clicks = ${t.ad_clicks}`, Number(r.ad_clicks) === t.ad_clicks,  `actual=${r.ad_clicks}`);
    check(`sessions ≈ ${t.sessions}`,   near(Number(r.sessions), t.sessions), `actual=${r.sessions}`);
  }
} else if (scope === 'image_advantage') {
  const t = TARGETS.image_advantage;
  const r = perAcct.find((x: any) => x.external_id === t.account_ext_id);
  if (!r) { console.log('  ❌ Account not found in MV'); failures++; }
  else {
    check(`spent ≈ $${t.spent}`,     near(Number(r.spent),   t.spent),   `actual=$${r.spent}`);
    check(`clicks = ${t.clicks}`,    Number(r.clicks) === t.clicks,       `actual=${r.clicks}`);
    check(`revenue ≈ $${t.revenue}`, near(Number(r.revenue), t.revenue), `actual=$${r.revenue}`);
  }
} else {
  // combined
  const t = TARGETS.combined;
  const totSpent   = perAcct.reduce((s: number, r: any) => s + Number(r.spent),  0);
  const totClicks  = perAcct.reduce((s: number, r: any) => s + Number(r.clicks), 0);
  const totRevenue = perAcct.reduce((s: number, r: any) => s + Number(r.revenue), 0) + unattrRevenue;
  check(`combined spent ≈ $${t.spent}`,    near(totSpent,    t.spent),   `actual=$${totSpent.toFixed(2)}`);
  check(`combined clicks = ${t.clicks}`,   totClicks === t.clicks,        `actual=${totClicks}`);
  check(`combined revenue ≈ $${t.revenue}`, near(totRevenue, t.revenue, 0.5), `actual=$${totRevenue.toFixed(2)}`);
}

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
await pool.end();
process.exit(failures > 0 ? 1 : 0);
