import { readFileSync } from 'fs';
import { query } from '../db/client.js';

const sql = readFileSync('db/008_image_advantage_columns.sql', 'utf8');
try {
  await query(sql);
  console.log('Migration 008 applied OK');
} catch (e: any) {
  console.error('FAILED:', e.message);
  process.exit(1);
}

const cols = await query<any>(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'partner_stats_hourly'
    AND column_name IN ('asset_gid','channel','campaign_ext_id','item_ext_id')
  ORDER BY column_name
`);
console.log('\nColumns:');
for (const r of cols) console.log(`  ${r.column_name}: ${r.data_type}, nullable=${r.is_nullable}`);

const idx = await query<any>(`
  SELECT indexname FROM pg_indexes
  WHERE tablename = 'partner_stats_hourly'
  ORDER BY indexname
`);
console.log('\nIndexes:', idx.map((r: any) => r.indexname).join(', '));

process.exit(0);
