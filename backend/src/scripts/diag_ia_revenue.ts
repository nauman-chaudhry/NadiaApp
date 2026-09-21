import { query, pool } from '../db/client.js';

// All account partner tags
console.log('=== All account partner tags ===');
const accts = await query<any>(`
  SELECT a.id, a.external_id, cp.code AS partner_code
  FROM ad_accounts a
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  WHERE cp.code IS NOT NULL
  ORDER BY a.id
`);
for (const r of accts) console.log(JSON.stringify(r));

// IA revenue rows in partner_stats_hourly — what campaign_ext_ids appear on June 1?
console.log('\n=== IA revenue rows June 1 (campaign_ext_id IS NOT NULL) ===');
const ia = await query<any>(`
  SELECT
    p.campaign_ext_id,
    COUNT(*) AS cnt,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue,
    c.id AS campaign_db_id,
    c.name AS campaign_name,
    a.external_id AS account_ext_id,
    a.id AS account_db_id,
    cp.code AS account_partner
  FROM partner_stats_hourly p
  LEFT JOIN campaigns   c   ON c.external_id = p.campaign_ext_id
  LEFT JOIN ad_accounts a   ON a.id = c.ad_account_id
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  WHERE p.campaign_ext_id IS NOT NULL
    AND p.hour_utc >= '2026-06-01'
    AND p.hour_utc <  '2026-06-02'
  GROUP BY p.campaign_ext_id, c.id, c.name, a.external_id, a.id, cp.code
  ORDER BY revenue DESC
  LIMIT 20
`);
for (const r of ia) console.log(JSON.stringify(r));

// How much total IA revenue exists on June 1 (all time)?
const totals = await query<any>(`
  SELECT
    p.granularity,
    COUNT(*) AS rows,
    ROUND(SUM(p.revenue)::numeric, 2) AS revenue
  FROM partner_stats_hourly p
  WHERE p.campaign_ext_id IS NOT NULL
    AND p.hour_utc >= '2026-06-01'
    AND p.hour_utc <  '2026-06-02'
  GROUP BY p.granularity
`);
console.log('\n=== Total IA revenue rows June 1 ===');
for (const r of totals) console.log(JSON.stringify(r));

// What happened to that $648 — where is IA revenue attributed now?
console.log('\n=== joined_stats_hourly revenue June 1 (all sources) ===');
const jrev = await query<any>(`
  SELECT
    ad_account_id,
    a.external_id,
    ROUND(SUM(revenue)::numeric,2) AS revenue,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric,2) AS spent
  FROM joined_stats_hourly j
  JOIN ad_accounts a ON a.id = j.ad_account_id
  WHERE hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
  GROUP BY ad_account_id, a.external_id
  ORDER BY revenue DESC
`);
for (const r of jrev) console.log(JSON.stringify(r));

const unattr = await query<any>(`
  SELECT ROUND(SUM(revenue)::numeric,2) AS revenue
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01' AND hour_utc < '2026-06-02'
    AND ad_account_id IS NULL
`);
console.log('Unattributed (ad_account_id IS NULL):', JSON.stringify(unattr[0]));

await pool.end();
process.exit(0);
