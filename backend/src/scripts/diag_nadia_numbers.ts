import { query, pool } from '../db/client.js';

// LGA-1 db id = 17 (leadgenaffiliates-sc, codefuel)
const LGA1_ID = 17;
const DATE_FROM = '2026-06-01 00:00:00+00';
const DATE_TO   = '2026-06-02 00:00:00+00';

// ── Step 1a: Does any hour range on June 1 for LGA-1 produce clicks≈457? ──
console.log('\n=== Step 1a: Hour-range slices that sum to clicks ~457 ===');
const hourly = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM hour_utc)::int AS hour,
    SUM(clicks)::int       AS clicks,
    SUM(conversions)::int  AS conversions,
    ROUND(SUM(spent)::numeric, 2) AS spent,
    SUM(sessions)::int     AS sessions,
    SUM(ad_clicks)::int    AS ad_clicks,
    ROUND(SUM(revenue)::numeric, 2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2 AND hour_utc < $3
  GROUP BY hour
  ORDER BY hour
`, [LGA1_ID, DATE_FROM, DATE_TO]);

console.log('Hourly breakdown for LGA-1 June 1:');
let cumClicks = 0, cumConv = 0, cumSpent = 0, cumSess = 0;
for (const r of hourly) {
  cumClicks += Number(r.clicks);
  cumConv   += Number(r.conversions);
  cumSpent  += Number(r.spent);
  cumSess   += Number(r.sessions);
  const flagC = Math.abs(cumClicks - 457) <= 5 ? ' ← MATCH clicks' : '';
  const flagS = Math.abs(cumSess   - 467) <= 5 ? ' ← MATCH sessions' : '';
  console.log(`  h${String(r.hour).padStart(2,'0')}: clicks=${r.clicks} conv=${r.conversions} spent=$${r.spent} sessions=${r.sessions} | cum_clicks=${cumClicks} cum_sess=${cumSess}${flagC}${flagS}`);
}

// Also scan trailing windows (last N hours)
console.log('\nTrailing hour windows (last N hours of June 1):');
let trailC = 0, trailS = 0, trailSp = 0;
for (let i = hourly.length - 1; i >= 0; i--) {
  trailC  += Number(hourly[i].clicks);
  trailS  += Number(hourly[i].sessions);
  trailSp += Number(hourly[i].spent);
  const flagC = Math.abs(trailC - 457) <= 5 ? ' ← MATCH clicks' : '';
  const flagS = Math.abs(trailS - 467) <= 5 ? ' ← MATCH sessions' : '';
  if (Math.abs(trailC - 457) <= 15 || Math.abs(trailS - 467) <= 15) {
    console.log(`  last ${hourly.length - i}h (h${hourly[i].hour}-h23): clicks=${trailC} sess=${trailS} spent=$${trailSp.toFixed(2)}${flagC}${flagS}`);
  }
}

// ── Step 1b: Does any account on June 1 sum to clicks≈457? ──
console.log('\n=== Step 1b: All accounts June 1 — does any account sum to clicks≈457? ===');
const allAccts = await query<any>(`
  SELECT
    j.ad_account_id,
    a.external_id,
    SUM(j.clicks)::int       AS clicks,
    SUM(j.conversions)::int  AS conversions,
    ROUND(SUM(j.spent)::numeric,2) AS spent,
    SUM(j.sessions)::int     AS sessions,
    SUM(j.ad_clicks)::int    AS ad_clicks,
    ROUND(SUM(j.revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly j
  LEFT JOIN ad_accounts a ON a.id = j.ad_account_id
  WHERE j.hour_utc >= $1 AND j.hour_utc < $2
  GROUP BY j.ad_account_id, a.external_id
  ORDER BY j.ad_account_id NULLS LAST
`, [DATE_FROM, DATE_TO]);

for (const r of allAccts) {
  const flagC = Math.abs(Number(r.clicks)  - 457) <= 5 ? ' ← MATCH clicks'    : '';
  const flagS = Math.abs(Number(r.sessions)- 467) <= 5 ? ' ← MATCH sessions'  : '';
  const flagSp= Math.abs(Number(r.spent)   - 23.91) <= 0.10 ? ' ← MATCH spent' : '';
  console.log(`  id=${r.ad_account_id} ${r.external_id}: clicks=${r.clicks} conv=${r.conversions} spent=$${r.spent} sess=${r.sessions} adclk=${r.ad_clicks} rev=$${r.revenue}${flagC}${flagS}${flagSp}`);
}

// ── Step 1c: Exact spend match — any row or group summing to $23.91? ──
console.log('\n=== Step 1c: Find $23.91 spent anywhere in MV June 1 ===');
const spentMatch = await query<any>(`
  SELECT
    ad_account_id,
    hour_utc,
    ROUND(SUM(spent)::numeric,2) AS spent,
    SUM(clicks)::int AS clicks,
    SUM(sessions)::int AS sessions
  FROM joined_stats_hourly
  WHERE hour_utc >= $1 AND hour_utc < $2
    AND ad_account_id IS NOT NULL
  GROUP BY ad_account_id, hour_utc
  HAVING ROUND(SUM(spent)::numeric,2) BETWEEN 23.80 AND 24.00
  ORDER BY spent
`, [DATE_FROM, DATE_TO]);
if (spentMatch.length > 0) {
  for (const r of spentMatch) console.log(`  acct=${r.ad_account_id} hour=${new Date(r.hour_utc).toISOString()} clicks=${r.clicks} sessions=${r.sessions} spent=$${r.spent}`);
} else {
  console.log('  No single (account, hour) row with spent=$23.80–$24.00');
}

// ── Step 1d: Check ad_stats_hourly directly for LGA-1 ──
console.log('\n=== Step 1d: ad_stats_hourly raw for LGA-1 June 1 ===');
const raw = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM hour_utc)::int AS hour,
    SUM(clicks)::int AS clicks,
    SUM(conversions)::int AS conversions,
    ROUND(SUM(spent)::numeric,2) AS spent
  FROM ad_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2 AND hour_utc < $3
  GROUP BY hour
  ORDER BY hour
`, [LGA1_ID, DATE_FROM, DATE_TO]);
let rawTotalC = 0, rawTotalSp = 0;
for (const r of raw) { rawTotalC += Number(r.clicks); rawTotalSp += Number(r.spent); }
console.log(`  Total in ad_stats_hourly: clicks=${rawTotalC} spent=$${rawTotalSp.toFixed(2)}`);

// ── Step 2: Check if partner_stats_hourly (revenue side) has a US-only subset ──
console.log('\n=== Step 2: partner_stats_hourly LGA-1 campaigns June 1 — by country? ===');
// LGA-1 campaigns
const cf_campaigns = await query<any>(`
  SELECT DISTINCT c.external_id
  FROM campaigns c
  WHERE c.ad_account_id = $1
`, [LGA1_ID]);
const cfExtIds = cf_campaigns.map((r: any) => r.external_id);
console.log(`  LGA-1 campaign count: ${cfExtIds.length}`);

// Does partner_stats_hourly have country breakdown for CF?
const cfByCountry = await query<any>(`
  SELECT
    p.country,
    SUM(p.ad_clicks)::int AS ad_clicks,
    SUM(p.sessions)::int AS sessions,
    ROUND(SUM(p.revenue)::numeric,2) AS revenue,
    COUNT(*) AS rows
  FROM partner_stats_hourly p
  WHERE p.campaign_ext_id IS NULL
    AND p.hour_utc >= $1 AND p.hour_utc < $2
    AND p.granularity = 'hourly'
  GROUP BY p.country
  ORDER BY sessions DESC
`, [DATE_FROM, DATE_TO]);

console.log('  Codefuel partner_stats_hourly by country June 1:');
for (const r of cfByCountry) {
  const flagS = Math.abs(Number(r.sessions)  - 467) <= 5 ? ' ← MATCH sessions' : '';
  const flagA = Math.abs(Number(r.ad_clicks) - 73)  <= 2 ? ' ← MATCH ad_clicks' : '';
  const flagR = Math.abs(Number(r.revenue)   - 13.33) <= 0.10 ? ' ← MATCH revenue' : '';
  console.log(`    country='${r.country}': ad_clicks=${r.ad_clicks} sessions=${r.sessions} revenue=$${r.revenue} rows=${r.rows}${flagS}${flagA}${flagR}`);
}

await pool.end();
process.exit(0);
