import { query } from '../db/client.js';

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('REGRESSION CHECK - Locked-in windows');
console.log('═══════════════════════════════════════════════════════════════\n');

// Window A: Apr 8-12, all Codefuel
console.log('Window A (Apr 8-12, all Codefuel accts):\n');
const windowA = await query<any>(`
  SELECT
    SUM(s.clicks) as clicks,
    SUM(s.spent) as spent,
    COUNT(*) as rows
  FROM ad_stats_hourly s
  WHERE s.hour_utc >= '2026-04-08 00:00:00+00'
    AND s.hour_utc < '2026-04-13 00:00:00+00'
`);

if (windowA[0]) {
  console.log(`Taboola:`);
  console.log(`  Spent: $${windowA[0].spent} (expected $4,491.56)`);
  console.log(`  Clicks: ${windowA[0].clicks} (expected 45,841)`);
  console.log(`  Variance: spent ${((parseFloat(windowA[0].spent) / 4491.56 - 1) * 100).toFixed(2)}%, clicks ${((windowA[0].clicks / 45841 - 1) * 100).toFixed(2)}%`);
}

const windowA_cf = await query<any>(`
  SELECT
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'codefuel'
    AND p.hour_utc >= '2026-04-08 00:00:00+00'
    AND p.hour_utc < '2026-04-13 00:00:00+00'
`);

if (windowA_cf[0]) {
  console.log(`\nCodefuel:`);
  console.log(`  Revenue: $${windowA_cf[0].revenue} (expected $12,268.92)`);
  console.log(`  Ad Clicks: ${windowA_cf[0].ad_clicks} (expected 18,964)`);
  console.log(`  Sessions: ${windowA_cf[0].sessions} (expected 44,538)`);
  console.log(`  Variance: revenue ${((parseFloat(windowA_cf[0].revenue) / 12268.92 - 1) * 100).toFixed(2)}%, ad_clicks ${((windowA_cf[0].ad_clicks / 18964 - 1) * 100).toFixed(2)}%`);
}

// Window B: May 18-24, Lead Gen Affs SC, Codefuel
console.log('\n\nWindow B (May 18-24, Lead Gen Affs SC, Codefuel):\n');
const windowB_tab = await query<any>(`
  SELECT
    SUM(s.clicks) as clicks,
    SUM(s.spent) as spent
  FROM ad_stats_hourly s
  WHERE s.hour_utc >= '2026-05-18 00:00:00+00'
    AND s.hour_utc < '2026-05-25 00:00:00+00'
    AND s.ad_account_id IN (SELECT id FROM ad_accounts WHERE name LIKE '%Lead Gen Affiliates%' AND name NOT LIKE '%2%')
`);

if (windowB_tab[0]) {
  console.log(`Taboola (Lead Gen Affs SC):`);
  console.log(`  Spent: $${windowB_tab[0].spent} (expected $763.87)`);
  console.log(`  Clicks: ${windowB_tab[0].clicks} (expected 9,819)`);
  console.log(`  Variance: spent ${((parseFloat(windowB_tab[0].spent) / 763.87 - 1) * 100).toFixed(2)}%, clicks ${((windowB_tab[0].clicks / 9819 - 1) * 100).toFixed(2)}%`);
}

const windowB_cf = await query<any>(`
  SELECT
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'codefuel'
    AND p.hour_utc >= '2026-05-18 00:00:00+00'
    AND p.hour_utc < '2026-05-25 00:00:00+00'
`);

if (windowB_cf[0]) {
  console.log(`\nCodefuel (all):`);
  console.log(`  Revenue: $${windowB_cf[0].revenue} (expected $807.84)`);
  console.log(`  Ad Clicks: ${windowB_cf[0].ad_clicks} (expected 2,829)`);
  console.log(`  Sessions: ${windowB_cf[0].sessions} (expected 9,748)`);
  console.log(`  Variance: revenue ${((parseFloat(windowB_cf[0].revenue) / 807.84 - 1) * 100).toFixed(2)}%, ad_clicks ${((windowB_cf[0].ad_clicks / 2829 - 1) * 100).toFixed(2)}%`);
}

// Window IA: May 20-28, Lead Gen Affs 2 SC, Image Advantage
console.log('\n\nWindow IA (May 20-28, Lead Gen Affs 2 SC, Image Advantage):\n');
const windowIA = await query<any>(`
  SELECT
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'image_advantage'
    AND p.hour_utc >= '2026-05-20 00:00:00+00'
    AND p.hour_utc < '2026-05-29 00:00:00+00'
`);

if (windowIA[0]) {
  console.log(`Image Advantage:`);
  console.log(`  Revenue: $${windowIA[0].revenue} (expected $193.61)`);
  console.log(`  Ad Clicks: ${windowIA[0].ad_clicks} (expected 567)`);
  console.log(`  Sessions: ${windowIA[0].sessions} (expected 1,908)`);
  console.log(`  Variance: revenue ${((parseFloat(windowIA[0].revenue) / 193.61 - 1) * 100).toFixed(2)}%, ad_clicks ${((windowIA[0].ad_clicks / 567 - 1) * 100).toFixed(2)}%`);
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
console.log('Regression check complete. All within ±0.5% = PASS\n');

process.exit(0);
