import { query } from '../db/client.js';

// A. Hour-by-hour cost coverage for June 1, account 1823395
console.log('\n=== A. Taboola hourly — June 1, account 1823395 ===');
const A = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM s.hour_utc)::int AS hour,
    ROUND(SUM(s.spent)::numeric,2)   AS spent,
    SUM(s.clicks)::int                AS clicks,
    SUM(s.impressions)::int           AS impressions,
    SUM(s.conversions)::int           AS conversions,
    COUNT(*)::int                     AS rows_
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  WHERE (a.external_id = '1823395' OR a.external_id LIKE '%1823395%')
    AND s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY hour ORDER BY hour
`);
if (A.length === 0) console.log('  NO ROWS');
else A.forEach((r: any) => console.log(`  h${String(r.hour).padStart(2,'0')}  spent=${r.spent}  clicks=${r.clicks}  impr=${r.impressions}  conv=${r.conversions}  rows=${r.rows_}`));
console.log(`  Total hours: ${A.length}`);

// B. Codefuel revenue hour-by-hour for June 1
console.log('\n=== B. Codefuel hourly — June 1 ===');
const B = await query<any>(`
  SELECT
    EXTRACT(HOUR FROM p.hour_utc)::int AS hour,
    p.granularity,
    ROUND(SUM(p.revenue)::numeric,4)  AS revenue,
    SUM(p.ad_clicks)::int              AS ad_clicks,
    SUM(p.sessions)::int               AS sessions,
    COUNT(*)::int                      AS rows_
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'codefuel'
    AND p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY hour, p.granularity ORDER BY hour
`);
if (B.length === 0) console.log('  NO ROWS');
else B.forEach((r: any) => console.log(`  h${String(r.hour).padStart(2,'0')}  [${r.granularity}]  rev=${r.revenue}  ad_clicks=${r.ad_clicks}  sessions=${r.sessions}  rows=${r.rows_}`));
console.log(`  Total hours: ${B.length}`);

// C. Sync_runs covering June 1
console.log('\n=== C. sync_runs covering June 1 ===');
const C = await query<any>(`
  SELECT id, source, job_type, window_start, window_end, status,
         rows_written, started_at, finished_at, error
  FROM sync_runs
  WHERE (window_start <= '2026-06-01' AND window_end >= '2026-06-01')
     OR (window_start <= '2026-06-02' AND window_end >= '2026-06-01')
  ORDER BY started_at DESC
  LIMIT 30
`);
if (C.length === 0) console.log('  NO ROWS');
else C.forEach((r: any) => console.log(`  ${String(r.finished_at).slice(0,24)} | ${r.source} | ${r.job_type} | ${r.status} | rows=${r.rows_written} | ${r.window_start}→${r.window_end}${r.error ? ' | '+r.error : ''}`));

// D. Total June 1 data + latest hour, account 1823395
console.log('\n=== D. June 1 totals + latest hour, account 1823395 ===');
const D = await query<any>(`
  SELECT
    ROUND(SUM(s.spent)::numeric,2)  AS june1_spent,
    SUM(s.clicks)::int               AS june1_clicks,
    SUM(s.conversions)::int          AS june1_conversions,
    MAX(s.hour_utc)                  AS latest_hour
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  WHERE (a.external_id = '1823395' OR a.external_id LIKE '%1823395%')
    AND s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
`);
console.log(`  spent=${D[0].june1_spent}  clicks=${D[0].june1_clicks}  conv=${D[0].june1_conversions}  latest_hour=${D[0].latest_hour}`);

// E. All accounts with Taboola activity on June 1
console.log('\n=== E. All accounts — June 1 ===');
const E = await query<any>(`
  SELECT
    a.external_id, a.name,
    cp.code AS partner_code,
    ROUND(SUM(s.spent)::numeric,2)  AS spent,
    SUM(s.clicks)::int               AS clicks
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY a.external_id, a.name, cp.code
  ORDER BY spent DESC
`);
if (E.length === 0) console.log('  NO ROWS');
else E.forEach((r: any) => console.log(`  ${r.external_id}  [${r.partner_code ?? 'null'}]  spent=${r.spent}  clicks=${r.clicks}  "${r.name}"`));

process.exit(0);
