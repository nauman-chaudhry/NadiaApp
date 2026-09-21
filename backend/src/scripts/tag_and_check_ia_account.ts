import { query } from '../db/client.js';

// Tag account 12 (tdg-sevenspheremedia4433-leadgenaffiliates-2-sc) as image_advantage
const iaPartner = await query<any>(`SELECT id FROM client_partners WHERE code = 'image_advantage'`);
const iaPartnerId = iaPartner[0].id;
console.log(`image_advantage partner id: ${iaPartnerId}`);

const updated = await query<any>(`
  UPDATE ad_accounts SET client_partner_id = $1
  WHERE id = 12 AND (client_partner_id IS NULL OR client_partner_id != $1)
  RETURNING id, external_id, name, client_partner_id
`, [iaPartnerId]);
console.log('Tagged:', updated);

// Show campaigns under account 12
const campaigns = await query<any>(`
  SELECT id, external_id, name, status
  FROM campaigns
  WHERE ad_account_id = 12
  ORDER BY id
  LIMIT 20
`);
console.log(`\nCampaigns under account 12 (first 20):`);
for (const c of campaigns) console.log(`  id=${c.id} ext=${c.external_id} "${c.name}" status=${c.status}`);

// Check cost data for account 12 in May 20-28 window
const cost = await query<any>(`
  SELECT
    date_trunc('day', hour_utc) AS day,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    ROUND(SUM(spent)::numeric, 2) AS spent
  FROM ad_stats_hourly
  WHERE ad_account_id = 12
    AND hour_utc >= '2026-05-20T00:00:00Z'
    AND hour_utc <  '2026-05-29T00:00:00Z'
  GROUP BY 1
  ORDER BY 1
`);
console.log('\nAccount 12 cost data May 20-28:');
for (const r of cost) {
  const d = new Date(r.day).toISOString().slice(0,10);
  console.log(`  ${d}: imp=${r.impressions} clicks=${r.clicks} spent=$${r.spent}`);
}
if (cost.length === 0) console.log('  (no data)');

process.exit(0);
