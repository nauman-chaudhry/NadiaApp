import { query } from '../db/client.js';

const r = await query(`
  SELECT SUM(impressions) AS imp, SUM(clicks) AS clk, COUNT(*) AS rows
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-08T00:00:00Z'
    AND hour_utc <  '2026-04-09T00:00:00Z'
`);
console.log('Apr 8:', JSON.stringify(r[0]));

const r2 = await query(`
  SELECT SUM(impressions) AS imp, SUM(clicks) AS clk
  FROM ad_stats_hourly
  WHERE hour_utc >= '2026-04-08T00:00:00Z'
    AND hour_utc <  '2026-04-13T00:00:00Z'
`);
console.log('Window A:', JSON.stringify(r2[0]));

process.exit(0);
