import { query } from '../db/client.js';
const r = await query<any>(`
  SELECT p.asset_gid, p.channel, COUNT(DISTINCT a.id) AS ad_count, COUNT(DISTINCT c.id) AS camp_count
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  JOIN campaigns c ON c.id = a.campaign_id
  WHERE p.campaign_ext_id IS NULL
    AND p.hour_utc >= '2026-05-25' AND p.hour_utc < '2026-05-30'
  GROUP BY p.asset_gid, p.channel
  HAVING COUNT(DISTINCT a.id) > 1
  ORDER BY ad_count DESC LIMIT 5
`);
console.log('Multi-ad (gd+channel) pairs:', r.length);
r.forEach((x: any) => console.log(' ', JSON.stringify(x)));
process.exit(0);
