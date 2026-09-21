import { query } from '../db/client.js';

// A. Cron health
console.log('\n=== A. Cron health (last 3 days) ===');
const cronHealth = await query<any>(`
  SELECT source, job_type, status, COUNT(*)::int AS count, MAX(finished_at) AS last_run
  FROM sync_runs
  WHERE started_at > NOW() - INTERVAL '3 days'
  GROUP BY source, job_type, status
  ORDER BY source, last_run DESC
`);
if (cronHealth.length === 0) {
  console.log('  NO ROWS — no sync runs in the last 3 days');
} else {
  for (const r of cronHealth) {
    console.log(`  ${r.source} | ${r.job_type} | ${r.status} | count=${r.count} | last=${r.last_run}`);
  }
}

// B. Most recent hour with data per source
console.log('\n=== B. Latest data per source ===');
const latest = await query<any>(`
  SELECT 'ad_stats_hourly' AS tbl, MAX(hour_utc) AS latest, MAX(fetched_at) AS last_sync
    FROM ad_stats_hourly
  UNION ALL
  SELECT 'partner_stats_hourly (codefuel)', MAX(hour_utc), MAX(fetched_at)
    FROM partner_stats_hourly p
    JOIN client_partners c ON c.id = p.client_partner_id
   WHERE c.code = 'codefuel'
  UNION ALL
  SELECT 'partner_stats_hourly (ia)', MAX(hour_utc), MAX(fetched_at)
    FROM partner_stats_hourly p
    JOIN client_partners c ON c.id = p.client_partner_id
   WHERE c.code = 'image_advantage'
`);
for (const r of latest) {
  console.log(`  ${r.tbl}`);
  console.log(`    latest hour_utc : ${r.latest}`);
  console.log(`    last fetched_at : ${r.last_sync}`);
}

// E. Hours behind per source
console.log('\n=== E. Hours behind NOW ===');
const behind = await query<any>(`
  SELECT
    'taboola' AS source,
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hour_utc)))/3600, 1) AS hours_behind
  FROM ad_stats_hourly
  UNION ALL
  SELECT 'codefuel',
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hour_utc)))/3600, 1)
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id AND c.code = 'codefuel'
  UNION ALL
  SELECT 'image_advantage',
    ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(hour_utc)))/3600, 1)
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id AND c.code = 'image_advantage'
`);
for (const r of behind) {
  const flag = parseFloat(r.hours_behind) > 6 ? ' ← STALE' : '';
  console.log(`  ${r.source}: ${r.hours_behind}h behind${flag}`);
}

// Most recent 5 sync runs
console.log('\n=== Most recent 5 sync runs ===');
const recent = await query<any>(`
  SELECT source, job_type, status, rows_written, finished_at, error
  FROM sync_runs
  ORDER BY finished_at DESC NULLS LAST
  LIMIT 5
`);
for (const r of recent) {
  console.log(`  ${r.finished_at} | ${r.source} | ${r.job_type} | ${r.status} | rows=${r.rows_written}${r.error ? ' | ERR:'+r.error : ''}`);
}

process.exit(0);
