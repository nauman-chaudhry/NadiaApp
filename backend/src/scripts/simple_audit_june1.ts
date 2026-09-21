import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  SIMPLE JUNE 1 AUDIT');
console.log('════════════════════════════════════════════════════════════════\n');

// Check Taboola data by account
console.log('─ TABOOLA DATA BY ACCOUNT ─\n');
const taboolaByAccount = await query<any>(`
  SELECT
    aa.external_id,
    SUM(s.clicks) AS clicks,
    ROUND(SUM(s.spent)::numeric, 2) AS spent,
    SUM(s.conversions) AS conversions,
    COUNT(*) AS rows
  FROM ad_stats_hourly s
  JOIN ad_accounts aa ON aa.id = s.ad_account_id
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY aa.external_id
  ORDER BY aa.external_id
`);

console.log('Accounts with Taboola data:');
taboolaByAccount.forEach((r: any) => {
  console.log(`  ${r.external_id}`);
  console.log(`    Clicks: ${r.clicks}, Spent: $${r.spent}, Conversions: ${r.conversions} (${r.rows} rows)`);
});

// Check Codefuel data
console.log('\n─ CODEFUEL DATA ─\n');
const codefuel = await query<any>(`
  SELECT
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    COUNT(*) AS rows
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
`);

if (codefuel[0]) {
  console.log(`Ad clicks: ${codefuel[0].ad_clicks}`);
  console.log(`Sessions: ${codefuel[0].sessions}`);
  console.log(`Revenue: $${codefuel[0].revenue}`);
  console.log(`Rows: ${codefuel[0].rows}`);
}

// Check Image Advantage data
console.log('\n─ IMAGE ADVANTAGE DATA ─\n');
const ia = await query<any>(`
  SELECT
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    COUNT(*) AS rows
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
`);

if (ia[0]) {
  console.log(`Ad clicks: ${ia[0].ad_clicks}`);
  console.log(`Sessions: ${ia[0].sessions}`);
  console.log(`Revenue: $${ia[0].revenue}`);
  console.log(`Rows: ${ia[0].rows}`);
}

// Total summary
console.log('\n─ DASHBOARD TOTALS (joined_stats_hourly) ─\n');
const dashboard = await query<any>(`
  SELECT
    SUM(clicks) AS total_clicks,
    ROUND(SUM(spent)::numeric, 2) AS total_spent,
    SUM(conversions) AS total_conversions,
    SUM(ad_clicks) AS total_ad_clicks,
    SUM(sessions) AS total_sessions,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < '2026-06-02 00:00:00+00'
`);

if (dashboard[0]) {
  console.log(`Taboola clicks: ${dashboard[0].total_clicks}`);
  console.log(`Taboola spent: $${dashboard[0].total_spent}`);
  console.log(`Taboola conversions: ${dashboard[0].total_conversions}`);
  console.log(`Codefuel ad_clicks: ${dashboard[0].total_ad_clicks}`);
  console.log(`Codefuel sessions: ${dashboard[0].total_sessions}`);
  console.log(`Codefuel revenue: $${dashboard[0].total_revenue}`);
}

console.log('\n════════════════════════════════════════════════════════════════\n');

// Expected vs Actual comparison
console.log('─ EXPECTED vs ACTUAL (from Nadia) ─\n');
console.log('TABOOLA (Account 1823395):');
console.log('  Expected: $51.86 spent, 1,605 clicks, 782 conversions');
console.log(`  Actual in DB: $${taboolaByAccount.reduce((s, r) => s + Number(r.spent), 0).toFixed(2)} spent, ${taboolaByAccount.reduce((s, r) => s + (r.clicks || 0), 0)} clicks`);

console.log('\nCODEFUEL:');
console.log('  Expected: 695 sessions, 106 ad_clicks, $19.67 revenue');
console.log(`  Actual in DB: ${codefuel[0]?.sessions || 0} sessions, ${codefuel[0]?.ad_clicks || 0} ad_clicks, $${codefuel[0]?.revenue || 0}`);

process.exit(0);
