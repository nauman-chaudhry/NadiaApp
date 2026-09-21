import { query, pool } from '../db/client.js';

const LGA1_ID   = 17;
const DATE_FROM = '2026-06-01 00:00:00+00';
const DATE_TO   = '2026-06-02 00:00:00+00';

// ── A: What hours have CF revenue rows (sessions > 0) for LGA-1 campaigns? ──
// This reveals the CF hourly coverage separately from the Taboola coverage.
console.log('\n=== A. CF hourly coverage for LGA-1 campaigns June 1 ===');
const cfHours = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM p.hour_utc)::int AS hour,
    SUM(p.ad_clicks)::int  AS ad_clicks,
    SUM(p.sessions)::int   AS sessions,
    ROUND(SUM(p.revenue)::numeric,4) AS revenue,
    COUNT(DISTINCT p.asset_gid) AS distinct_gds
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id AND c.ad_account_id = $1
  WHERE p.granularity = 'hourly'
    AND p.campaign_ext_id IS NULL
    AND p.hour_utc >= $2 AND p.hour_utc < $3
  GROUP BY hour
  ORDER BY hour
`, [LGA1_ID, DATE_FROM, DATE_TO]);

let cumSess = 0, cumAdClk = 0, cumRev = 0;
for (const r of cfHours) {
  cumSess  += Number(r.sessions);
  cumAdClk += Number(r.ad_clicks);
  cumRev   += Number(r.revenue);
  const flagS = Math.abs(cumSess  - 467) <= 2 ? ' ← MATCH sessions=467' : '';
  const flagA = Math.abs(cumAdClk - 73)  <= 1 ? ' ← MATCH ad_clicks=73' : '';
  const flagR = Math.abs(cumRev   - 13.33) <= 0.05 ? ' ← MATCH revenue=13.33' : '';
  console.log(`  h${String(r.hour).padStart(2,'0')}: ad_clicks=${r.ad_clicks} sessions=${r.sessions} rev=$${Number(r.revenue).toFixed(4)} | cum_sess=${cumSess} cum_adclk=${cumAdClk} cum_rev=$${cumRev.toFixed(2)}${flagS}${flagA}${flagR}`);
}
console.log(`  CF total: sessions=${cumSess} ad_clicks=${cumAdClk} revenue=$${cumRev.toFixed(2)}`);

// ── B: What Taboola hours have cost rows for LGA-1? ──
console.log('\n=== B. Taboola hourly cost for LGA-1 June 1 ===');
const tbHours = await query<any>(`
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

let cumClk = 0, cumConv = 0, cumSp = 0;
for (const r of tbHours) {
  cumClk  += Number(r.clicks);
  cumConv += Number(r.conversions);
  cumSp   += Number(r.spent);
  const flagC  = Math.abs(cumClk  - 457) <= 3 ? ' ← MATCH clicks=457' : '';
  const flagCv = Math.abs(cumConv - 191) <= 2 ? ' ← MATCH conv=191' : '';
  const flagSp = Math.abs(cumSp   - 23.91) <= 0.05 ? ' ← MATCH spent=23.91' : '';
  console.log(`  h${String(r.hour).padStart(2,'0')}: clicks=${r.clicks} conv=${r.conversions} spent=$${r.spent} | cum=${cumClk} cum_conv=${cumConv} cum_spent=$${cumSp.toFixed(2)}${flagC}${flagCv}${flagSp}`);
}

// ── C: Check recent sync_runs — was June 1 synced multiple times? ──
console.log('\n=== C. sync_runs for June 1 ===');
const runs = await query<any>(`
  SELECT source, job_type, window_start, window_end, status, rows_written, finished_at
  FROM sync_runs
  WHERE window_start <= '2026-06-01'
    AND (window_end >= '2026-06-01' OR window_end IS NULL)
  ORDER BY finished_at DESC
  LIMIT 20
`);
for (const r of runs) {
  console.log(`  ${r.source}/${r.job_type} [${r.window_start}→${r.window_end}] status=${r.status} rows=${r.rows_written} finished=${r.finished_at ? new Date(r.finished_at).toISOString() : 'null'}`);
}

// ── D: Does the MV produce 457 for any campaign_id filter? ──
console.log('\n=== D. Campaign-level breakdown for LGA-1 June 1 (top 20 by clicks) ===');
const campBkd = await query<any>(`
  SELECT
    campaign_external_id,
    campaign_name,
    SUM(clicks)::int      AS clicks,
    SUM(conversions)::int AS conversions,
    ROUND(SUM(spent)::numeric,2)   AS spent,
    SUM(sessions)::int    AS sessions,
    SUM(ad_clicks)::int   AS ad_clicks,
    ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2 AND hour_utc < $3
  GROUP BY campaign_external_id, campaign_name
  ORDER BY clicks DESC
  LIMIT 20
`, [LGA1_ID, DATE_FROM, DATE_TO]);

let cumCampClk = 0, cumCampSess = 0, cumCampSp = 0;
for (const r of campBkd) {
  cumCampClk  += Number(r.clicks);
  cumCampSess += Number(r.sessions);
  cumCampSp   += Number(r.spent);
  const flag = Math.abs(cumCampClk - 457) <= 3 ? ' ← cum MATCH clicks=457' : '';
  const flagS = Math.abs(cumCampSess - 467) <= 3 ? ' ← cum MATCH sessions=467' : '';
  console.log(`  ${r.campaign_external_id} "${r.campaign_name.slice(0,40)}": clk=${r.clicks} sess=${r.sessions} sp=$${r.spent} rev=$${r.revenue}${flag}${flagS}`);
}
console.log(`  Total top-20 campaigns: clicks=${cumCampClk} sessions=${cumCampSess} spent=$${cumCampSp.toFixed(2)}`);

// ── E: Does the MV have Part 1 vs Part 2 rows for LGA-1 on June 1? ──
// Part 2 rows have hour_utc = midnight exactly (daily aggregates)
console.log('\n=== E. MV row types for LGA-1 June 1 (hourly vs daily) ===');
const mvTypes = await query<any>(`
  SELECT
    CASE WHEN EXTRACT(MINUTE FROM hour_utc) = 0 AND EXTRACT(SECOND FROM hour_utc) = 0
              AND EXTRACT(HOUR FROM hour_utc) = 0
         THEN 'midnight (could be daily)'
         ELSE 'intra-day hour'
    END AS row_type,
    COUNT(*) AS cnt,
    SUM(clicks)::int AS clicks,
    SUM(conversions)::int AS conv,
    ROUND(SUM(spent)::numeric,2) AS spent,
    SUM(sessions)::int AS sessions,
    SUM(ad_clicks)::int AS ad_clicks,
    ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2 AND hour_utc < $3
  GROUP BY row_type
`, [LGA1_ID, DATE_FROM, DATE_TO]);
for (const r of mvTypes) {
  console.log(`  ${r.row_type}: cnt=${r.cnt} clicks=${r.clicks} conv=${r.conv} spent=$${r.spent} sessions=${r.sessions} ad_clicks=${r.ad_clicks} revenue=$${r.revenue}`);
}

// ── F: What does the MV show if we exclude midnight (h00) rows? ──
console.log('\n=== F. MV totals for LGA-1 June 1 excluding h00 ===');
const noMidnight = await query<any>(`
  SELECT
    SUM(clicks)::int AS clicks,
    SUM(conversions)::int AS conversions,
    ROUND(SUM(spent)::numeric,2) AS spent,
    SUM(sessions)::int AS sessions,
    SUM(ad_clicks)::int AS ad_clicks,
    ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= '2026-06-01 01:00:00+00'
    AND hour_utc < $3
`, [LGA1_ID, DATE_TO]);
const nm = noMidnight[0];
console.log(`  Excluding h00: clicks=${nm.clicks} conv=${nm.conversions} spent=$${nm.spent} sess=${nm.sessions} adclk=${nm.ad_clicks} rev=$${nm.revenue}`);

await pool.end();
process.exit(0);
