import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  WHAT DASHBOARD API RETURNS for June 1 DAILY VIEW');
console.log('════════════════════════════════════════════════════════════════\n');

// Simulate the daily view API query
const dailySql = `
  SELECT
    date_trunc('day', hour_utc) AS day,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    SUM(spent) AS spent,
    SUM(revenue) AS revenue,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions,
    SUM(revenue) - SUM(spent) AS profit,
    CASE WHEN SUM(impressions) = 0 THEN 0
         ELSE SUM(spent) * 1000.0 / SUM(impressions) END AS actual_cpm,
    CASE WHEN SUM(impressions) = 0 THEN 0
         ELSE SUM(clicks) * 100.0 / SUM(impressions) END AS ctr_pct,
    CASE WHEN SUM(clicks) = 0 THEN 0
         ELSE SUM(spent) / SUM(clicks) END AS actual_cpc,
    CASE WHEN SUM(clicks) = 0 THEN 0
         ELSE SUM(conversions) * 100.0 / SUM(clicks) END AS conversion_rate_pct,
    CASE WHEN SUM(conversions) = 0 THEN 0
         ELSE SUM(spent) / SUM(conversions) END AS actual_cpa,
    CASE WHEN SUM(ad_clicks) = 0 THEN 0
         ELSE SUM(revenue) / SUM(ad_clicks) END AS rpc,
    CASE WHEN SUM(revenue) = 0 THEN 0
         ELSE (SUM(revenue) - SUM(spent)) * 100.0 / SUM(revenue) END AS margin_pct
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY date_trunc('day', hour_utc)
  ORDER BY day
`;

const daily = await query<any>(dailySql);

console.log('Daily view result:');
if (daily[0]) {
  const r = daily[0];
  console.log(`  Day: ${r.day}`);
  console.log(`  Clicks: ${r.clicks}`);
  console.log(`  Spent: $${r.spent}`);
  console.log(`  Conversions: ${r.conversions}`);
  console.log(`  Ad Clicks: ${r.ad_clicks}`);
  console.log(`  Sessions: ${r.sessions}`);
  console.log(`  Revenue: $${r.revenue}`);
}

// Now check the campaign view
console.log('\n─ CAMPAIGN VIEW (what dashboard shows per campaign) ─\n');

const campaignView = `
  SELECT
    campaign_name,
    campaign_external_id AS campaign_id,
    ad_account_name,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    SUM(spent) AS spent,
    SUM(revenue) AS revenue,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY campaign_name, campaign_external_id, ad_account_name
  ORDER BY spent DESC NULLS LAST
`;

const campaigns = await query<any>(campaignView);

console.log('Campaigns with June 1 data:');
campaigns.forEach((c: any) => {
  const acct = c.ad_account_name || '(Unattributed)';
  const camp = c.campaign_name || '(Unattributed revenue)';
  console.log(`  ${camp} [${acct}]`);
  console.log(`    Clicks: ${c.clicks}, Spent: $${c.spent}, Revenue: $${c.revenue}`);
  console.log(`    Ad Clicks: ${c.ad_clicks}, Sessions: ${c.sessions}`);
});

// Summary
console.log('\n════════════════════════════════════════════════════════════════');
console.log('\n⚠️  ANALYSIS:\n');
console.log('The joined_stats_hourly MV includes:');
console.log('  - Attributed revenue (Taboola cost + CF/IA revenue)');
console.log('  - UNATTRIBUTED revenue (CF revenue with no matching ads)');
console.log('\nThis is why the numbers don\'t match:');
console.log('  - Nadia sees only her ATTRIBUTED traffic in Taboola/Codefuel APIs');
console.log('  - Dashboard shows attributed + UNATTRIBUTED Codefuel revenue');
console.log('\n');

process.exit(0);
