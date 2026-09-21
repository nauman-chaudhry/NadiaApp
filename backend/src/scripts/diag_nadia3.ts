import { query, pool } from '../db/client.js';

const LGA1_ID   = 17;
const DATE_FROM = '2026-06-01 00:00:00+00';
const DATE_TO   = '2026-06-02 00:00:00+00';

// ── Confirm: MV totals for LGA-1, h00–h08 only (what Codefuel sync captured on June 1) ──
console.log('=== MV totals for LGA-1 June 1, h00–h08 only ===');
const h0_8 = await query<any>(`
  SELECT
    SUM(clicks)::int       AS clicks,
    SUM(conversions)::int  AS conversions,
    ROUND(SUM(spent)::numeric,2)   AS spent,
    SUM(sessions)::int     AS sessions,
    SUM(ad_clicks)::int    AS ad_clicks,
    ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2
    AND hour_utc <  '2026-06-01 09:00:00+00'
`, [LGA1_ID, DATE_FROM]);
const r08 = h0_8[0];
console.log(`  clicks=${r08.clicks} conv=${r08.conversions} spent=$${r08.spent} sessions=${r08.sessions} ad_clicks=${r08.ad_clicks} revenue=$${r08.revenue}`);
console.log(`  Nadia saw: clicks=457 conv=191 spent=$23.91 sessions=467 ad_clicks=73 revenue=$13.33`);

// ── MV totals for LGA-1, h00–h09 (including full h09) ──
console.log('\n=== MV totals for LGA-1 June 1, h00–h09 (full) ===');
const h0_9 = await query<any>(`
  SELECT
    SUM(clicks)::int       AS clicks,
    SUM(conversions)::int  AS conversions,
    ROUND(SUM(spent)::numeric,2)   AS spent,
    SUM(sessions)::int     AS sessions,
    SUM(ad_clicks)::int    AS ad_clicks,
    ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc >= $2
    AND hour_utc <  '2026-06-01 10:00:00+00'
`, [LGA1_ID, DATE_FROM]);
const r09 = h0_9[0];
console.log(`  clicks=${r09.clicks} conv=${r09.conversions} spent=$${r09.spent} sessions=${r09.sessions} ad_clicks=${r09.ad_clicks} revenue=$${r09.revenue}`);

// ── Summary: what partial-h09 Taboola data would produce clicks=457, conv=191, spent=$23.91 ──
console.log('\n=== Implied partial h09 Taboola data (sync captured at ~11:32 UTC June 1) ===');
const h09full = await query<any>(`
  SELECT clicks, conversions, ROUND(spent::numeric,2) AS spent
  FROM ad_stats_hourly
  WHERE ad_account_id = $1
    AND hour_utc = '2026-06-01 09:00:00+00'
`, [LGA1_ID]);
if (h09full.length > 0) {
  // Multiple campaign rows for h09; sum them
  const h09 = await query<any>(`
    SELECT SUM(clicks)::int AS clicks, SUM(conversions)::int AS conv, ROUND(SUM(spent)::numeric,2) AS spent
    FROM ad_stats_hourly
    WHERE ad_account_id = $1 AND hour_utc = '2026-06-01 09:00:00+00'
  `, [LGA1_ID]);
  const h09row = h09[0];
  const h08cumClicks = 449; // from step B
  const h08cumConv   = 185;
  const h08cumSpent  = 23.26;
  console.log(`  h09 final (re-synced June 3): clicks=${h09row.clicks} conv=${h09row.conv} spent=$${h09row.spent}`);
  console.log(`  h00-h08 cumulative:           clicks=${h08cumClicks} conv=${h08cumConv} spent=$${h08cumSpent}`);
  console.log(`  For Nadia's 457/191/$23.91, partial h09 would have needed:`);
  console.log(`    clicks=${457 - h08cumClicks}  conv=${191 - h08cumConv}  spent=$${(23.91 - h08cumSpent).toFixed(2)}`);
  console.log(`  Actual h09 final:  clicks=${h09row.clicks}  conv=${h09row.conv}  spent=$${h09row.spent}`);
  console.log(`  → Partial/stale h09 at sync-time: plausible (sync ran 11:32 UTC; h09=09:00-10:00 UTC → partial)`);
}

// ── sync_runs: confirm the timeline ──
console.log('\n=== Sync timeline for June 1 data ===');
const runs = await query<any>(`
  SELECT source, job_type,
    window_start AT TIME ZONE 'UTC' AS window_start_utc,
    window_end   AT TIME ZONE 'UTC' AS window_end_utc,
    status, rows_written,
    finished_at  AT TIME ZONE 'UTC' AS finished_utc
  FROM sync_runs
  WHERE (window_start >= '2026-05-31' AND window_end <= '2026-06-03')
     OR (window_start = '2026-06-01')
  ORDER BY finished_at
`);
for (const r of runs) {
  const start = r.window_start_utc ? new Date(r.window_start_utc).toISOString().slice(0,16) : '?';
  const end   = r.window_end_utc   ? new Date(r.window_end_utc).toISOString().slice(0,16)   : '?';
  const fin   = r.finished_utc     ? new Date(r.finished_utc).toISOString().slice(0,16)      : '?';
  console.log(`  ${fin}Z  ${r.source}/${r.job_type}  window=[${start}→${end}]  rows=${r.rows_written}  status=${r.status}`);
}

await pool.end();
process.exit(0);
