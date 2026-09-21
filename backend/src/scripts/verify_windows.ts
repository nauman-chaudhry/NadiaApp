import { query } from '../db/client.js';

const targets = {
  A: { spent: 4491.56, clicks: 45841, impressions: 1591813, conversions: 40162, revenue: 12268.92, ad_clicks: 18964, sessions: 44538 },
  B: { spent: 763.87,  clicks: 9819,  impressions: 254405,  conversions: 5843,  revenue: 807.84,   ad_clicks: 2829,  sessions: 9748 },
};

function pct(actual: number, target: number) {
  return (((actual - target) / target) * 100).toFixed(3) + '%';
}

function check(label: string, actual: number, target: number) {
  const diff = Math.abs(actual - target) / target * 100;
  const pass = diff <= 0.5;
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}: actual=${actual} target=${target} diff=${pct(actual, target)}`);
  return pass;
}

// Window A: Apr 8-12, ALL accounts
const a = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric,2)   AS spent,
    SUM(clicks)                    AS clicks,
    SUM(impressions)               AS impressions,
    SUM(conversions)               AS conversions,
    ROUND(SUM(revenue)::numeric,2) AS revenue,
    SUM(ad_clicks)                 AS ad_clicks,
    SUM(sessions)                  AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-04-08T00:00:00Z'
    AND hour_utc <  '2026-04-13T00:00:00Z'
`);

console.log('\n=== Window A (Apr 8-12, ALL accounts) ===');
const aRow = a[0];
let allPass = true;
allPass = check('spent',       +aRow.spent,       targets.A.spent)       && allPass;
allPass = check('clicks',      +aRow.clicks,      targets.A.clicks)      && allPass;
allPass = check('impressions', +aRow.impressions, targets.A.impressions) && allPass;
allPass = check('conversions', +aRow.conversions, targets.A.conversions) && allPass;
allPass = check('revenue',     +aRow.revenue,     targets.A.revenue)     && allPass;
allPass = check('ad_clicks',   +aRow.ad_clicks,   targets.A.ad_clicks)   && allPass;
allPass = check('sessions',    +aRow.sessions,    targets.A.sessions)    && allPass;

// Window B: May 18-24, account 17
const b = await query<any>(`
  SELECT
    ROUND(SUM(spent)::numeric,2)   AS spent,
    SUM(clicks)                    AS clicks,
    SUM(impressions)               AS impressions,
    SUM(conversions)               AS conversions,
    ROUND(SUM(revenue)::numeric,2) AS revenue,
    SUM(ad_clicks)                 AS ad_clicks,
    SUM(sessions)                  AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-05-18T00:00:00Z'
    AND hour_utc <  '2026-05-25T00:00:00Z'
    AND ad_account_id = 17
`);

console.log('\n=== Window B (May 18-24, account 17) ===');
const bRow = b[0];
allPass = check('spent',       +bRow.spent,       targets.B.spent)       && allPass;
allPass = check('clicks',      +bRow.clicks,      targets.B.clicks)      && allPass;
allPass = check('impressions', +bRow.impressions, targets.B.impressions) && allPass;
allPass = check('conversions', +bRow.conversions, targets.B.conversions) && allPass;
allPass = check('revenue',     +bRow.revenue,     targets.B.revenue)     && allPass;
allPass = check('ad_clicks',   +bRow.ad_clicks,   targets.B.ad_clicks)   && allPass;
allPass = check('sessions',    +bRow.sessions,    targets.B.sessions)    && allPass;

console.log(`\n${allPass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}`);
process.exit(allPass ? 0 : 1);
