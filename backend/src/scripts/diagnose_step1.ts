import { query } from '../db/client.js';

console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║              STEP 1 DIAGNOSIS - PART B & E                  ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

// ─────────────────────────────────────────────────────────────────────────────
// B. Confirm duplicate rows in device view
// ─────────────────────────────────────────────────────────────────────────────
console.log('B. Device view - DUPLICATE ROWS CHECK:\n');

const device_rows = await query<any>(`
  -- Mapped Codefuel
  SELECT
    p.device,
    SUM(p.revenue) as revenue,
    'mapped' as source
  FROM partner_stats_hourly p
  JOIN ads a ON a.gd_param = p.asset_gid AND a.r_param = p.channel
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND p.device IS NOT NULL AND p.device <> ''
  GROUP BY p.device

  UNION ALL

  -- Orphan Codefuel
  SELECT
    COALESCE(p.device, '(Unattributed)'),
    SUM(p.revenue),
    'orphan' as source
  FROM partner_stats_hourly p
  WHERE p.hour_utc >= '2026-06-01 00:00:00+00'
    AND p.hour_utc < '2026-06-04 00:00:00+00'
    AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
  GROUP BY COALESCE(p.device, '(Unattributed)')

  ORDER BY revenue DESC
`);

console.log('Raw UNION ALL result (showing duplicates):');
const deviceCounts: Record<string, number> = {};
device_rows.forEach((row: any) => {
  const dev = row.device || '(null)';
  deviceCounts[dev] = (deviceCounts[dev] || 0) + 1;
  console.log(`  ${(dev).padEnd(15)} $${parseFloat(row.revenue).toFixed(2).padStart(10)} [${row.source}]`);
});

console.log('\nDevice value counts:');
Object.entries(deviceCounts).forEach(([dev, count]) => {
  if (count > 1) {
    console.log(`  ❌ ${dev}: appears ${count} times (DUPLICATE!)`);
  } else {
    console.log(`  ✅ ${dev}: appears ${count} time`);
  }
});
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// E. What Codefuel assets are in the DB? Do they have .tb/.ob tags?
// ─────────────────────────────────────────────────────────────────────────────
console.log('E. Codefuel assets - SOURCE TAG CHECK:\n');

const cf_assets = await query<any>(`
  SELECT DISTINCT asset_gid
  FROM partner_stats_hourly p
  JOIN client_partners c ON c.id = p.client_partner_id
  WHERE c.code = 'codefuel'
    AND asset_gid IS NOT NULL
  ORDER BY asset_gid
  LIMIT 30
`);

console.log('Sample Codefuel assets (first 30):');
const with_tags = cf_assets.filter(r => r.asset_gid?.includes('.tb') || r.asset_gid?.includes('.ob'));
const without_tags = cf_assets.filter(r => !r.asset_gid?.includes('.tb') && !r.asset_gid?.includes('.ob'));

without_tags.forEach(row => {
  console.log(`  ${row.asset_gid}`);
});

if (with_tags.length > 0) {
  console.log('\n✅ Found assets WITH .tb/.ob tags:');
  with_tags.forEach(row => {
    console.log(`  ${row.asset_gid}`);
  });
} else {
  console.log(`\n❌ NO Codefuel assets have .tb/.ob tags`);
  console.log(`   All ${cf_assets.length} sample assets are untagged`);
}
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// C-D. Check CodefuelRow interface and API response structure
// ─────────────────────────────────────────────────────────────────────────────
console.log('C-D. Codefuel API structure check:\n');

try {
  const cfClient = await import('../sources/codefuel/client.js');
  console.log('✅ Codefuel client found');
  console.log('   Checking for source_platform field in API response...\n');
} catch (e) {
  console.log('Note: Could not import client module for inspection\n');
}

// Check what fields are currently being used in sync
const syncFile = await import('fs');
console.log('Checking sync/codefuel.ts for field usage:');
const codefuelSync = await syncFile.promises.readFile(
  'C:/Users/DELL/Desktop/nadia-dashboard/backend/src/sync/codefuel.ts',
  'utf-8'
);

if (codefuelSync.includes('source_platform')) {
  console.log('✅ source_platform is mentioned in sync code');
} else {
  console.log('❌ source_platform is NOT in sync code (not being stored)');
}

if (codefuelSync.includes('row.asset_gid')) {
  const lines = codefuelSync.split('\n');
  const assetLine = lines.find(l => l.includes('row.asset_gid'));
  console.log(`   Asset GID usage: ${assetLine?.trim()}`);
}

console.log();
process.exit(0);
