import { query } from '../db/client.js';

console.log('\n════════════════════════════════════════════════════════════════');
console.log('  CHECKING IA TAGS FOR PLATFORM IDENTIFICATION');
console.log('════════════════════════════════════════════════════════════════\n');

// Check IA data structure
console.log('─ IA CAMPAIGN_EXT_ID VALUES (How IA identifies campaigns) ─\n');
const iaCampaigns = await query<any>(`
  SELECT DISTINCT
    campaign_ext_id,
    COUNT(*) AS rows,
    SUM(revenue) AS revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE campaign_ext_id IS NOT NULL
  GROUP BY campaign_ext_id
  ORDER BY revenue DESC
  LIMIT 10
`);

console.log('IA campaign_ext_id values (should have platform tags):');
if (iaCampaigns.length === 0) {
  console.log('  ❌ NO campaign_ext_id found - IA data has NO platform identification!');
  console.log('     This is the problem - we can\'t distinguish Taboola vs Outbrain IA revenue');
} else {
  iaCampaigns.forEach((r: any) => {
    console.log(`  ${r.campaign_ext_id}: $${r.revenue} (${r.rows} rows)`);
  });
}

// Check what data we have
console.log('\n─ IA DATA VOLUME ─\n');
const iaVolume = await query<any>(`
  SELECT
    COUNT(*) AS total_rows,
    COUNT(DISTINCT campaign_ext_id) AS unique_campaign_ids,
    COUNT(CASE WHEN campaign_ext_id IS NOT NULL THEN 1 END) AS with_campaign_id,
    COUNT(CASE WHEN campaign_ext_id IS NULL THEN 1 END) AS without_campaign_id,
    ROUND(SUM(revenue)::numeric, 2) AS total_revenue
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
`);

if (iaVolume[0]) {
  console.log(`Total IA rows: ${iaVolume[0].total_rows}`);
  console.log(`With campaign_ext_id: ${iaVolume[0].with_campaign_id}`);
  console.log(`WITHOUT campaign_ext_id: ${iaVolume[0].without_campaign_id}`);
  console.log(`Total IA revenue: $${iaVolume[0].total_revenue}`);

  if (iaVolume[0].without_campaign_id > 0) {
    console.log(`\n⚠️  ${iaVolume[0].without_campaign_id} IA rows have NO platform identification!`);
  }
}

// Check item_ext_id (might contain the tag info)
console.log('\n─ IA ITEM_EXT_ID VALUES (Alternative identifier) ─\n');
const iaItems = await query<any>(`
  SELECT DISTINCT
    item_ext_id,
    COUNT(*) AS rows
  FROM partner_stats_hourly p
  JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
  WHERE item_ext_id IS NOT NULL
  GROUP BY item_ext_id
  ORDER BY rows DESC
  LIMIT 15
`);

console.log('IA item_ext_id values (sample):');
if (iaItems.length === 0) {
  console.log('  ❌ NO item_ext_id - no platform tags here either');
} else {
  iaItems.forEach((r: any) => {
    // Check if tag indicates platform
    const isPlatformTag = r.item_ext_id.includes('.tb') || r.item_ext_id.includes('.ob');
    const platform = r.item_ext_id.includes('.tb') ? 'TABOOLA' : r.item_ext_id.includes('.ob') ? 'OUTBRAIN' : 'UNKNOWN';
    const marker = isPlatformTag ? '✅' : '❌';
    console.log(`  ${marker} ${r.item_ext_id}: ${r.rows} rows [${platform}]`);
  });
}

// Summary
console.log('\n════════════════════════════════════════════════════════════════\n');
console.log('KEY FINDINGS:\n');

if (iaCampaigns.length === 0 && iaItems.some((r: any) => r.item_ext_id.includes('.tb') || r.item_ext_id.includes('.ob'))) {
  console.log('✅ Platform tags ARE in item_ext_id!');
  console.log('   Solution: Parse item_ext_id to identify platform (Taboola vs Outbrain)');
} else if (iaCampaigns.length > 0) {
  console.log('✅ Platform might be in campaign_ext_id!');
} else {
  console.log('❌ NO platform identification found in IA data!');
  console.log('   This is why we can\'t separate Taboola IA from Outbrain IA');
}

console.log('\n════════════════════════════════════════════════════════════════\n');

process.exit(0);
