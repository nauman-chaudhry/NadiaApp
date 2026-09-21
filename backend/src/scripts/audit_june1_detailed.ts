import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  DETAILED JUNE 1 AUDIT — Account Mapping & Data');
console.log('════════════════════════════════════════════════════════════════\n');

// 1. List all accounts with June 1 data
console.log('─ ALL ACCOUNTS WITH JUNE 1 DATA ─');
const allAccounts = await query<any>(`
  SELECT
    aa.id, aa.external_id, aa.name,
    pl.code AS platform,
    cp.code AS partner,
    SUM(CASE WHEN asth.hour_utc >= '2026-06-01 00:00:00+00' AND asth.hour_utc < '2026-06-02 00:00:00+00' THEN asth.clicks ELSE 0 END) AS taboola_clicks,
    SUM(CASE WHEN psh.hour_utc >= '2026-06-01 00:00:00+00' AND psh.hour_utc < '2026-06-02 00:00:00+00' THEN psh.ad_clicks ELSE 0 END) AS partner_clicks,
    COUNT(DISTINCT CASE WHEN asth.hour_utc >= '2026-06-01 00:00:00+00' AND asth.hour_utc < '2026-06-02 00:00:00+00' THEN asth.id END) AS taboola_rows,
    COUNT(DISTINCT CASE WHEN psh.hour_utc >= '2026-06-01 00:00:00+00' AND psh.hour_utc < '2026-06-02 00:00:00+00' THEN psh.id END) AS partner_rows
  FROM ad_accounts aa
  LEFT JOIN platforms pl ON pl.id = aa.platform_id
  LEFT JOIN client_partners cp ON cp.id = aa.client_partner_id
  LEFT JOIN ad_stats_hourly asth ON asth.ad_account_id = aa.id
  LEFT JOIN partner_stats_hourly psh ON psh.campaign_ext_id IS NOT NULL AND psh.hour_utc >= '2026-06-01 00:00:00+00' AND psh.hour_utc < '2026-06-02 00:00:00+00'
  WHERE asth.hour_utc >= '2026-06-01 00:00:00+00' AND asth.hour_utc < '2026-06-02 00:00:00+00'
     OR psh.hour_utc >= '2026-06-01 00:00:00+00' AND psh.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY aa.id, aa.external_id, aa.name, pl.code, cp.code
  ORDER BY aa.external_id
`);

allAccounts.forEach((a: any) => {
  console.log(`\n  ${a.external_id}`);
  console.log(`    Platform: ${a.platform}, Partner: ${a.partner}`);
  console.log(`    Taboola: ${a.taboola_clicks} clicks (${a.taboola_rows} rows)`);
  console.log(`    Partner: ${a.partner_clicks} clicks (${a.partner_rows} rows)`);
});

// 2. Check account ID 1823395 in Taboola external_id
console.log('\n─ LOOKING FOR ACCOUNT 1823395 ─');
const account1823395 = await query<any>(`
  SELECT * FROM ad_accounts
  WHERE external_id LIKE '%1823395%' OR external_id LIKE '%leadgenaffiliates%' OR external_id LIKE '%leadgenaffiliates-sc%'
`);

if (account1823395.length > 0) {
  account1823395.forEach((a: any) => {
    console.log(`  Found: ${a.external_id} (ID: ${a.id})`);
  });
} else {
  console.log('  ❌ NOT FOUND with external_id search');
}

// 3. Get detailed breakdown per account for June 1
console.log('\n─ DETAILED JUNE 1 BREAKDOWN ─');

const june1Detail = await query<any>(`
  SELECT
    aa.id,
    aa.external_id,
    aa.name,
    'taboola' AS source,
    SUM(s.clicks) AS clicks,
    SUM(s.spent) AS spent,
    SUM(s.conversions) AS conversions,
    SUM(s.impressions) AS impressions,
    COUNT(*) AS rows,
    MAX(s.hour_utc) AS latest_hour
  FROM ad_stats_hourly s
  JOIN ad_accounts aa ON aa.id = s.ad_account_id
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY aa.id, aa.external_id, aa.name

  UNION ALL

  SELECT
    c.ad_account_id,
    aa.external_id,
    aa.name,
    'partner_' || cp.code AS source,
    SUM(p.ad_clicks) AS clicks,
    NULL::numeric AS spent,
    NULL::int AS conversions,
    NULL::int AS impressions,
    COUNT(*) AS rows,
    MAX(p.hour_utc) AS latest_hour
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id
  JOIN campaigns c ON c.external_id = p.campaign_ext_id
  JOIN ad_accounts aa ON aa.id = c.ad_account_id
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY c.ad_account_id, aa.external_id, aa.name, cp.code
  ORDER BY external_id, source
`);

const byAccount = new Map<string, any[]>();
june1Detail.forEach((r: any) => {
  const key = r.external_id;
  if (!byAccount.has(key)) byAccount.set(key, []);
  byAccount.get(key)!.push(r);
});

byAccount.forEach((rows: any[], acctId: string) => {
  console.log(`\n  ${acctId}:`);
  rows.forEach((r: any) => {
    const source = r.source === 'taboola'
      ? `Taboola: ${r.clicks} clicks, $${r.spent} spent, ${r.conversions} conversions`
      : `${r.source}: ${r.clicks} clicks (${r.rows} rows)`;
    console.log(`    ${source}`);
  });
});

// 4. Check if there's a mismatch in campaign tagging
console.log('\n─ CAMPAIGN TAGGING CHECK ─');
const campaigns = await query<any>(`
  SELECT
    c.id, c.external_id, c.name,
    aa.external_id AS account_external_id,
    c.ad_account_id,
    COUNT(DISTINCT s.id) AS taboola_rows,
    SUM(s.clicks) AS taboola_clicks,
    COUNT(DISTINCT p.id) AS partner_rows,
    SUM(p.ad_clicks) AS partner_clicks
  FROM campaigns c
  JOIN ad_accounts aa ON aa.id = c.ad_account_id
  LEFT JOIN ad_stats_hourly s ON s.campaign_id = c.id AND s.hour_utc >= '2026-06-01 00:00:00+00' AND s.hour_utc < '2026-06-02 00:00:00+00'
  LEFT JOIN partner_stats_hourly p ON p.campaign_ext_id = c.external_id AND p.hour_utc >= '2026-06-01 00:00:00+00' AND p.hour_utc < '2026-06-02 00:00:00+00'
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00' AND s.hour_utc < '2026-06-02 00:00:00+00'
     OR p.hour_utc >= '2026-06-01 00:00:00+00' AND p.hour_utc < '2026-06-02 00:00:00+00'
  GROUP BY c.id, c.external_id, c.name, aa.external_id, c.ad_account_id
  ORDER BY c.external_id
  LIMIT 20
`);

if (campaigns.length > 0) {
  console.log('\n  Campaigns with June 1 data:');
  campaigns.forEach((c: any) => {
    if (c.taboola_clicks || c.partner_clicks) {
      console.log(`    ${c.external_id}: Taboola=${c.taboola_clicks} clicks, Partner=${c.partner_clicks} clicks`);
    }
  });
}

// 5. Summary comparison
console.log('\n─ SUMMARY COMPARISON ─');
const taboola = await query<any>(`
  SELECT
    SUM(clicks) AS total_clicks,
    ROUND(SUM(spent)::numeric, 2) AS total_spent,
    SUM(conversions) AS total_conversions,
    COUNT(DISTINCT campaign_id) AS campaigns
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00' AND hour_utc < '2026-06-02 00:00:00+00'
`);

const codefuel = await query<any>(`
  SELECT
    SUM(ad_clicks) AS total_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue,
    SUM(sessions) AS total_sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00' AND p.hour_utc < '2026-06-02 00:00:00+00'
`);

const ia = await query<any>(`
  SELECT
    SUM(ad_clicks) AS total_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue,
    SUM(sessions) AS total_sessions
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00' AND p.hour_utc < '2026-06-02 00:00:00+00'
`);

console.log('\n  TABOOLA (Spend-side):');
if (taboola[0]) {
  console.log(`    Total clicks: ${taboola[0].total_clicks}`);
  console.log(`    Total spent: $${taboola[0].total_spent}`);
  console.log(`    Total conversions: ${taboola[0].total_conversions}`);
  console.log(`    Campaigns: ${taboola[0].campaigns}`);
}

console.log('\n  CODEFUEL (Revenue-side):');
if (codefuel[0]) {
  console.log(`    Total ad_clicks: ${codefuel[0].total_clicks}`);
  console.log(`    Total revenue: $${codefuel[0].total_revenue}`);
  console.log(`    Total sessions: ${codefuel[0].total_sessions}`);
}

console.log('\n  IMAGE ADVANTAGE (Revenue-side):');
if (ia[0]) {
  console.log(`    Total ad_clicks: ${ia[0].total_clicks}`);
  console.log(`    Total revenue: $${ia[0].total_revenue}`);
  console.log(`    Total sessions: ${ia[0].total_sessions}`);
}

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
