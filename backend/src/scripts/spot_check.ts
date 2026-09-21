import { query } from '../db/client.js';

// Check daily totals across the full backfill range
const rows = await query<any>(`
  SELECT
    date_trunc('day', hour_utc)            AS day,
    SUM(impressions)                        AS impressions,
    SUM(clicks)                             AS clicks,
    ROUND(SUM(spent)::numeric, 2)           AS spent,
    ROUND(SUM(clicks)::numeric * 100.0 / NULLIF(SUM(impressions),0), 3) AS ctr_pct,
    ROUND(SUM(spent)::numeric * 1000.0 / NULLIF(SUM(impressions),0), 4) AS cpm
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-01T00:00:00Z'
    AND hour_utc <  '2026-05-27T00:00:00Z'
  GROUP BY 1
  ORDER BY 1
`);

let issues = 0;
console.log('Day          | Impressions | Clicks | Spent    | CTR%  | CPM');
console.log('-------------|-------------|--------|----------|-------|------');
for (const r of rows) {
  const day = new Date(r.day).toISOString().slice(0,10);
  const ctr = parseFloat(r.ctr_pct);
  const cpm = parseFloat(r.cpm);
  // Flag anything with CTR > 15% or CPM > $20 as suspicious (likely total impressions leaked back)
  const flag = (ctr > 15 || cpm > 20) ? ' ← SUSPICIOUS' : '';
  if (flag) issues++;
  console.log(`${day} | ${String(r.impressions).padStart(11)} | ${String(r.clicks).padStart(6)} | $${String(r.spent).padStart(7)} | ${String(r.ctr_pct).padStart(5)} | $${r.cpm}${flag}`);
}
console.log(`\nTotal days: ${rows.length}, Suspicious: ${issues}`);
process.exit(0);
