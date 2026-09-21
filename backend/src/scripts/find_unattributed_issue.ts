import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  WHY IS CODEFUEL REVENUE UNATTRIBUTED? ($602.82)');
console.log('════════════════════════════════════════════════════════════════\n');

// Check unattributed Codefuel rows
console.log('─ UNATTRIBUTED CODEFUEL REVENUE (June 1) ─\n');
const unattributed = await query<any>(`
  SELECT
    p.asset_gid,
    p.channel,
    COUNT(*) AS rows,
    SUM(p.ad_clicks) AS ad_clicks,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
    AND p.campaign_ext_id IS NULL
  GROUP BY p.asset_gid, p.channel
  ORDER BY revenue DESC NULLS LAST
  LIMIT 20
`);

console.log('Top unattributed gd_param/channel pairs:');
unattributed.forEach((r: any) => {
  console.log(`  GD=${r.asset_gid}, Channel=${r.channel}: $${r.revenue} (${r.ad_clicks} clicks, ${r.rows} rows)`);
});

// Check if these gd_param/channel exist in ads table
console.log('\n─ DO THESE ADS EXIST IN ADS TABLE? ─\n');
const unattribGDs = unattributed.map((r: any) => r.asset_gid);
if (unattribGDs.length > 0) {
  const matchedAds = await query<any>(`
    SELECT
      a.gd_param, a.r_param, a.external_id, a.title,
      c.external_id AS campaign_id,
      COUNT(*) AS count
    FROM ads a
    JOIN campaigns c ON c.id = a.campaign_id
    WHERE a.gd_param = ANY($1::text[])
    GROUP BY a.gd_param, a.r_param, a.external_id, a.title, c.external_id
    ORDER BY a.gd_param
  `, [unattribGDs]);

  if (matchedAds.length > 0) {
    console.log(`Found ${matchedAds.length} matching ads:`);
    matchedAds.forEach((a: any) => {
      console.log(`  ${a.gd_param}/${a.r_param}: "${a.title}"`);
    });
  } else {
    console.log('❌ NO MATCHING ADS FOUND in database!');
    console.log('\nThis means Codefuel is sending revenue for gd_params that are not in the Taboola ads table.');
    console.log('Possible causes:');
    console.log('  1. Taboola ads sync hasn\'t run / is incomplete');
    console.log('  2. Codefuel is sending data for paused/old Taboola ads');
    console.log('  3. Taboola ads were deleted but Codefuel still reports them');
  }
}

// Total unattributed vs attributed
console.log('\n─ ATTRIBUTION BREAKDOWN ─\n');
const cfBreakdown = await query<any>(`
  SELECT
    'attributed' AS type,
    COUNT(*) AS rows,
    SUM(ad_clicks) AS ad_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
    AND p.campaign_ext_id IS NOT NULL

  UNION ALL

  SELECT
    'unattributed' AS type,
    COUNT(*) AS rows,
    SUM(ad_clicks) AS ad_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
    AND p.campaign_ext_id IS NULL
`);

cfBreakdown.forEach((r: any) => {
  console.log(`${r.type.toUpperCase()}: ${r.rows} rows, ${r.ad_clicks} clicks, $${r.revenue} revenue`);
});

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
