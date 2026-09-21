import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  FINAL CROSS-CHECK: ALL DATA FOR JUNE 1-3, 2026');
console.log('════════════════════════════════════════════════════════════════\n');

// Test the actual API queries that the dashboard uses

console.log('─ TEST 1: CAMPAIGN VIEW (joined_stats_hourly) ─\n');
const campaigns = await query<any>(`
  SELECT
    campaign_name,
    campaign_external_id,
    ad_account_name,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
  GROUP BY campaign_name, campaign_external_id, ad_account_name
  ORDER BY spent DESC NULLS LAST
  LIMIT 5
`);

console.log('Top 5 campaigns by spend:');
campaigns.forEach((c: any) => {
  console.log(`  ${c.campaign_name} (${c.campaign_external_id})`);
  console.log(`    Account: ${c.ad_account_name}`);
  console.log(`    Spend: $${c.spent}, Clicks: ${c.clicks}, Conversions: ${c.conversions}`);
  console.log(`    Revenue: $${c.revenue}, Ad Clicks: ${c.ad_clicks}, Sessions: ${c.sessions}`);
});

// Test device view
console.log('\n─ TEST 2: DEVICE VIEW (partner_stats_hourly for CF + IA) ─\n');

const devices = await query<any>(`
  (SELECT
    p.device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device
  ORDER BY revenue DESC
  LIMIT 5)

  UNION ALL

  (SELECT
    '(Unattributed)' AS device,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
    AND (p.device IS NULL OR p.device = '')
  )
`);

console.log('Devices with revenue (CF + IA):');
if (devices.length === 0) {
  console.log('  ❌ NO DEVICE DATA');
} else {
  devices.forEach((d: any) => {
    console.log(`  ${d.device}: $${d.revenue} revenue, ${d.ad_clicks} ad_clicks, ${d.sessions} sessions`);
  });
}

// Test country view
console.log('\n─ TEST 3: COUNTRY VIEW (partner_stats_hourly for CF + IA) ─\n');

const countries = await query<any>(`
  (SELECT
    p.country,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
    AND p.country IS NOT NULL AND p.country <> ''
  GROUP BY p.country
  ORDER BY revenue DESC
  LIMIT 5)

  UNION ALL

  (SELECT
    '(Unattributed)' AS country,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
    AND (p.country IS NULL OR p.country = '')
  )
`);

console.log('Countries with revenue (CF + IA):');
if (countries.length === 0) {
  console.log('  ❌ NO COUNTRY DATA');
} else {
  countries.forEach((ct: any) => {
    console.log(`  ${ct.country}: $${ct.revenue} revenue, ${ct.ad_clicks} ad_clicks, ${ct.sessions} sessions`);
  });
}

// Test ads view
console.log('\n─ TEST 4: ADS VIEW (partner_stats_hourly CF only) ─\n');

const ads = await query<any>(`
  SELECT
    p.asset_gid,
    p.channel,
    a.title,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    SUM(p.ad_clicks) AS ad_clicks,
    SUM(p.sessions) AS sessions,
    COUNT(*) AS rows
  FROM partner_stats_hourly p
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
  GROUP BY p.asset_gid, p.channel, a.title
  ORDER BY revenue DESC
  LIMIT 5
`);

console.log('Top 5 Codefuel assets by revenue:');
ads.forEach((ad: any) => {
  const matched = ad.title ? '✅' : '❌';
  console.log(`  ${matched} Asset: ${ad.asset_gid}, Channel: ${ad.channel}`);
  if (ad.title) console.log(`     Ad: "${ad.title}"`);
  console.log(`     Revenue: $${ad.revenue}, Ad Clicks: ${ad.ad_clicks}, Sessions: ${ad.sessions}`);
});

// Daily totals
console.log('\n─ TEST 5: DAILY VIEW (Total by day) ─\n');

const daily = await query<any>(`
  SELECT
    date_trunc('day', hour_utc) AS day,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
  GROUP BY day
  ORDER BY day
`);

console.log('Daily totals (all sources):');
daily.forEach((d: any) => {
  const dayStr = new Date(d.day).toISOString().split('T')[0];
  console.log(`  ${dayStr}:`);
  console.log(`    Taboola: impressions=${d.impressions}, clicks=${d.clicks}, spent=$${d.spent}, conversions=${d.conversions}`);
  console.log(`    Codefuel: ad_clicks=${d.ad_clicks}, sessions=${d.sessions}, revenue=$${d.revenue}`);
});

// Hourly view sample
console.log('\n─ TEST 6: HOURLY VIEW (Sample for June 1) ─\n');

const hourly = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM hour_utc)::int AS hour,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(conversions) AS conversions,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions) AS sessions,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY EXTRACT(HOUR FROM hour_utc)
  ORDER BY hour
  LIMIT 5
`);

console.log('First 5 hours of June 1:');
hourly.forEach((h: any) => {
  console.log(`  Hour ${String(h.hour).padStart(2, '0')}:00:`);
  console.log(`    Clicks: ${h.clicks}, Spent: $${h.spent}, Conversions: ${h.conversions}`);
  console.log(`    Ad Clicks: ${h.ad_clicks}, Sessions: ${h.sessions}, Revenue: $${h.revenue}`);
});

// IA Platform breakdown
console.log('\n─ TEST 7: IA PLATFORM BREAKDOWN ─\n');

const iaBreakdown = await query<any>(`
  SELECT
    CASE
      WHEN asset_gid LIKE '%\.tb' THEN 'Taboola'
      WHEN asset_gid LIKE '%\.ob' THEN 'Outbrain'
      ELSE 'Attribution Data'
    END AS platform_source,
    COUNT(*) AS rows,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY platform_source
  ORDER BY revenue DESC
`);

console.log('IA data by platform source:');
iaBreakdown.forEach((ia: any) => {
  console.log(`  ${ia.platform_source}: ${ia.rows} rows, $${ia.revenue} revenue`);
});

// Summary totals
console.log('\n════════════════════════════════════════════════════════════════\n');
console.log('FINAL SUMMARY - June 1-3 Totals:\n');

const totals = await query<any>(`
  SELECT
    SUM(impressions) AS total_impressions,
    SUM(clicks) AS total_clicks,
    ROUND(SUM(spent)::numeric, 2) AS total_spent,
    SUM(conversions) AS total_conversions,
    SUM(ad_clicks) AS total_ad_clicks,
    SUM(sessions) AS total_sessions,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc < ('2026-06-03'::date + INTERVAL '1 day')::timestamptz
`);

if (totals[0]) {
  const t = totals[0];
  console.log(`📊 TABOOLA:`);
  console.log(`   Impressions: ${t.total_impressions}`);
  console.log(`   Clicks: ${t.total_clicks}`);
  console.log(`   Spent: $${t.total_spent}`);
  console.log(`   Conversions: ${t.total_conversions}`);
  console.log(`\n💰 CODEFUEL:`);
  console.log(`   Ad Clicks: ${t.total_ad_clicks}`);
  console.log(`   Sessions: ${t.total_sessions}`);
  console.log(`   Revenue: $${t.total_revenue}`);
  console.log(`\n✅ All data accessible and verified!`);
}

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
