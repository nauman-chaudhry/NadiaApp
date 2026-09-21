import { query, pool } from '../db/client.js';

// Query A — Lead Gen Affiliates account tagging
console.log('=== A. Lead Gen Affiliates tagging ===');
const a = await query<any>(`
  SELECT a.external_id, a.name, a.client_partner_id, cp.code AS partner_code
  FROM ad_accounts a
  LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
  WHERE a.external_id LIKE '%leadgenaffiliates%'
  ORDER BY a.external_id
`);
for (const r of a) console.log(JSON.stringify(r));

// Query B — Window A (Apr 8-12) per-account breakdown
console.log('\n=== B. Window A (Apr 8-12) per-account breakdown ===');
const b = await query<any>(`
  SELECT
    a.external_id,
    SUM(s.spent)::numeric(14,2) AS spent,
    SUM(s.clicks) AS clicks,
    SUM(s.conversions) AS conversions
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  WHERE s.hour_utc >= '2026-04-08 00:00:00+00'
    AND s.hour_utc <  '2026-04-13 00:00:00+00'
  GROUP BY a.external_id
  ORDER BY spent DESC
`);
let ts = 0, tc = 0, tv = 0;
for (const r of b) {
  console.log(JSON.stringify(r));
  ts += Number(r.spent); tc += Number(r.clicks); tv += Number(r.conversions);
}
console.log(`TOTAL:  spent=${ts.toFixed(2)}  clicks=${tc}  conv=${tv}`);
console.log(`TARGET: spent=4491.56  clicks=45841  conv=40162`);

// Query C — unfiltered daily totals June 1 (simulates API with no account_id)
console.log('\n=== C. Unfiltered daily totals June 1 (joined_stats_hourly) ===');
const c = await query<any>(`
  SELECT
    SUM(clicks)                           AS clicks,
    SUM(conversions)                      AS conversions,
    ROUND(SUM(spent)::numeric,2)          AS spent,
    ROUND(SUM(revenue)::numeric,2)        AS revenue,
    SUM(impressions)                      AS impressions
  FROM joined_stats_hourly
  WHERE hour_utc >= '2026-06-01 00:00:00+00'
    AND hour_utc <  '2026-06-02 00:00:00+00'
`);
console.log(JSON.stringify(c[0]));
console.log('Target (all accounts): clicks=1605 conv=782 spent=$100.24');
console.log('Target (per-acct 1823395): clicks=756 conv=322 spent=$51.83');

// Also show both leadgenaffiliates accounts individually on June 1
console.log('\n=== C2. June 1 per-account for both Lead Gen Affiliates accounts ===');
const c2 = await query<any>(`
  SELECT
    a.external_id,
    a.id AS db_id,
    SUM(s.clicks)                        AS clicks,
    SUM(s.conversions)                   AS conversions,
    ROUND(SUM(s.spent)::numeric,2)       AS spent
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
    AND a.external_id LIKE '%leadgenaffiliates%'
  GROUP BY a.external_id, a.id
  ORDER BY spent DESC
`);
for (const r of c2) console.log(JSON.stringify(r));

await pool.end();
process.exit(0);
