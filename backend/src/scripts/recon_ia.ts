import { query } from '../db/client.js';

// Reconciliation for IA window May 20-28
// Targets:
const TARGETS = {
  revenue: 193.61,
  ad_clicks: 567,
  sessions: 1908,
  spent: 435.60,
  impressions: 192400,
  clicks: 6455,
};
const TOLERANCES = {
  revenue: 0.97,
  ad_clicks: 3,
  sessions: 10,
  spent: 2.18,
  impressions: 962,
  clicks: 32,
};

// 1. IA partner revenue from partner_stats_hourly
const iaRows = await query<any>(`
  SELECT
    ROUND(SUM(p.revenue)::numeric, 2)    AS revenue,
    SUM(p.ad_clicks)::int                AS ad_clicks,
    SUM(p.sessions)::int                 AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-05-20'
    AND p.hour_utc <  '2026-05-29'
`);
const ia = iaRows[0];

// 2. Taboola cost for account 12 (2037738)
const costRows = await query<any>(`
  SELECT
    ROUND(SUM(h.spent)::numeric, 2)      AS spent,
    SUM(h.impressions)::int              AS impressions,
    SUM(h.clicks)::int                   AS clicks
  FROM ad_stats_hourly h
  JOIN campaigns c ON c.id = h.campaign_id
  WHERE c.ad_account_id = 12
    AND h.hour_utc >= '2026-05-20'
    AND h.hour_utc <  '2026-05-29'
`);
const cost = costRows[0];

const actuals = {
  revenue:     parseFloat(ia.revenue ?? 0),
  ad_clicks:   ia.ad_clicks ?? 0,
  sessions:    ia.sessions ?? 0,
  spent:       parseFloat(cost.spent ?? 0),
  impressions: cost.impressions ?? 0,
  clicks:      cost.clicks ?? 0,
};

console.log('\n=== IA Reconciliation (May 20-28) ===\n');
console.log('Metric        | Target      | Actual      | Drift       | Status');
console.log('--------------|-------------|-------------|-------------|-------');

let allPass = true;
for (const [key, target] of Object.entries(TARGETS)) {
  const actual = actuals[key as keyof typeof actuals];
  const tol = TOLERANCES[key as keyof typeof TOLERANCES];
  const diff = actual - target;
  const driftPct = target !== 0 ? (diff / target * 100) : 0;
  const pass = Math.abs(diff) <= tol;
  if (!pass) allPass = false;
  const status = pass ? 'PASS' : 'FAIL';
  const targetStr = typeof target === 'number' && !Number.isInteger(target) ? target.toFixed(2) : String(target);
  const actualStr = typeof actual === 'number' && !Number.isInteger(actual) ? actual.toFixed(2) : String(actual);
  console.log(
    `${key.padEnd(13)} | ${targetStr.padStart(11)} | ${actualStr.padStart(11)} | ${(driftPct >= 0 ? '+' : '') + driftPct.toFixed(3).padStart(7)}%  | ${status}`
  );
}

console.log(`\n${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);

// 3. Account metadata check
const accRows = await query<any>(`
  SELECT a.id, a.external_id, a.name, cp.code AS partner_code
  FROM ad_accounts a
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  WHERE a.id = 12
`);
console.log('=== Account 12 metadata ===');
console.log(JSON.stringify(accRows[0], null, 2));

// 4. IA sync summary
const syncRows = await query<any>(`
  SELECT date_trunc('day', hour_utc)::date AS day,
         SUM(p.ad_clicks)::int AS ad_clicks,
         SUM(p.sessions)::int AS sessions,
         ROUND(SUM(p.revenue)::numeric,4) AS revenue,
         COUNT(*) AS rows
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-05-20' AND p.hour_utc < '2026-05-29'
  GROUP BY 1 ORDER BY 1
`);
console.log('\n=== IA daily breakdown ===');
console.log('Day        | AdClicks | Sessions | Revenue    | Rows');
for (const r of syncRows) {
  const day = new Date(r.day).toISOString().slice(0,10);
  console.log(`${day} | ${String(r.ad_clicks).padStart(8)} | ${String(r.sessions).padStart(8)} | $${String(r.revenue).padStart(9)} | ${r.rows}`);
}

process.exit(0);
