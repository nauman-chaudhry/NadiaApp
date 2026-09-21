import { query } from '../db/client.js';

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('VERIFICATION AUDIT - All 7 Issues');
console.log('═══════════════════════════════════════════════════════════════\n');

// ISSUE 1: IA Daily revenue on June 2
console.log('ISSUE 1 — IA Daily revenue on June 2:\n');
const ia_june2 = await query<any>(`
  SELECT
    SUM(revenue)   AS revenue,
    SUM(ad_clicks) AS ad_clicks,
    SUM(sessions)  AS sessions
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'image_advantage'
    AND p.hour_utc >= '2026-06-02 00:00:00+00'
    AND p.hour_utc <  '2026-06-03 00:00:00+00'
`);
console.log('Raw partner_stats_hourly for IA June 2:');
console.log(JSON.stringify(ia_june2[0], null, 2));
console.log('');

// ISSUE 2: Device view cost metrics for Codefuel June 1-3
console.log('ISSUE 2 — Device view June 1-3 (Codefuel mapped + orphan):\n');
const device_view = await query<any>(`
  -- Mapped Codefuel (with ads)
  SELECT
    p.device,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device

  UNION ALL

  -- Orphan Codefuel (no ads mapping)
  SELECT
    COALESCE(p.device, '(Unattributed)') as device,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY COALESCE(p.device, '(Unattributed)')

  ORDER BY revenue DESC
`);
console.log('Codefuel by device (mapped + orphan):');
device_view.forEach(row => {
  console.log(`  ${row.device}: revenue=$${row.revenue}, ad_clicks=${row.ad_clicks}, sessions=${row.sessions}`);
});
console.log(`Total rows found: ${device_view.length}\n`);

// ISSUE 3: Country view cost metrics for Codefuel June 1-3
console.log('ISSUE 3 — Country view June 1-3 (Codefuel mapped + orphan):\n');
const country_view = await query<any>(`
  -- Mapped Codefuel (with ads)
  SELECT
    p.country,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  JOIN ad_accounts acc ON acc.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.country IS NOT NULL AND p.country <> ''
  GROUP BY p.country

  UNION ALL

  -- Orphan Codefuel (no ads mapping)
  SELECT
    COALESCE(p.country, '(Unattributed)') as country,
    COUNT(*) as row_count,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY COALESCE(p.country, '(Unattributed)')

  ORDER BY revenue DESC
`);
console.log('Codefuel by country (mapped + orphan, sample):');
country_view.slice(0, 5).forEach(row => {
  console.log(`  ${row.country}: revenue=$${row.revenue}, ad_clicks=${row.ad_clicks}`);
});
console.log(`Total countries found: ${country_view.length}\n`);

// ISSUE 4a: Ads view Codefuel cost
console.log('ISSUE 4a — Ads view Codefuel cost (top 5):\n');
const ads_cf = await query<any>(`
  SELECT
    p.asset_gid,
    p.channel,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks,
    SUM(p.sessions) as sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY p.asset_gid, p.channel
  ORDER BY revenue DESC
  LIMIT 5
`);
console.log('Top 5 Codefuel assets by revenue:');
ads_cf.forEach(row => {
  console.log(`  ${row.asset_gid}/${row.channel}: revenue=$${row.revenue}, ad_clicks=${row.ad_clicks}`);
});
console.log('');

// ISSUE 4b: Ads view IA
console.log('ISSUE 4b — Ads view IA:\n');
const ads_ia = await query<any>(`
  SELECT
    p.asset_gid,
    p.campaign_ext_id,
    COUNT(*) as rows,
    SUM(p.revenue) as revenue,
    SUM(p.ad_clicks) as ad_clicks
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
  GROUP BY p.asset_gid, p.campaign_ext_id
  ORDER BY revenue DESC
  LIMIT 5
`);
console.log(`IA rows found in June 1-3: ${ads_ia.length}`);
if (ads_ia.length > 0) {
  ads_ia.forEach(row => {
    console.log(`  asset_gid=${row.asset_gid}, campaign_ext_id=${row.campaign_ext_id}: revenue=$${row.revenue}, rows=${row.rows}`);
  });
} else {
  console.log('  NO IA DATA FOUND');
}
console.log('');

// ISSUE 5: Taboola has data for June 1-3
console.log('ISSUE 5 — Taboola June 1-3:\n');
const taboola = await query<any>(`
  SELECT
    DATE(s.hour_utc) AS day,
    SUM(s.spent)     AS spent,
    SUM(s.clicks)    AS clicks,
    COUNT(*) as rows
  FROM ad_stats_hourly s
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-04 00:00:00+00'
  GROUP BY day ORDER BY day
`);
console.log('Taboola data by day:');
taboola.forEach(row => {
  console.log(`  ${row.day}: spent=$${row.spent}, clicks=${row.clicks}, rows=${row.rows}`);
});
console.log('');

// ISSUE 6 & 7: Unattributed Codefuel revenue and source-tag split
console.log('ISSUE 6 & 7 — Orphan Codefuel assets (no Taboola match):\n');
const orphan_cf = await query<any>(`
  SELECT
    p.asset_gid,
    SUM(p.revenue) AS revenue,
    COUNT(DISTINCT p.channel) AS channels,
    COUNT(*) as rows
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  LEFT JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE c.code = 'codefuel'
    AND a.id IS NULL
  GROUP BY p.asset_gid
  ORDER BY revenue DESC
`);
console.log('Orphan assets (no ads match):');
const outbrain_assets = ['AP1009251', 'AP1009313', 'AP1009280', 'AP1009330'];
orphan_cf.forEach(row => {
  const isOutbrain = outbrain_assets.some(asset => row.asset_gid?.includes(asset));
  const marker = isOutbrain ? '[OUTBRAIN]' : '';
  console.log(`  ${row.asset_gid} ${marker}: revenue=$${row.revenue}, rows=${row.rows}`);
});

// Check if source-tag split implemented
console.log('\nSource-tag check (do assets have .tb/.ob suffix?):');
const sample_assets = orphan_cf.slice(0, 3);
sample_assets.forEach(row => {
  const has_tb = row.asset_gid?.includes('.tb');
  const has_ob = row.asset_gid?.includes('.ob');
  const has_tag = has_tb || has_ob ? 'YES' : 'NO';
  console.log(`  ${row.asset_gid}: has_platform_tag=${has_tag}`);
});
console.log('');

console.log('═══════════════════════════════════════════════════════════════\n');
process.exit(0);
