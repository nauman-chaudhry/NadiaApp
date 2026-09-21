import { query } from '../db/client.js';

// The old constraint name was truncated by Postgres (63-char limit)
const res = await query<any>(`
  ALTER TABLE partner_stats_hourly
  DROP CONSTRAINT IF EXISTS "partner_stats_hourly_client_partner_id_granularity_asset_gi_key"
`);
console.log('Done (no error = success)');

const idx = await query<any>(`
  SELECT indexname FROM pg_indexes WHERE tablename = 'partner_stats_hourly' ORDER BY indexname
`);
console.log('Remaining indexes:', idx.map((r: any) => r.indexname).join(', '));

const cons = await query<any>(`
  SELECT constraint_name, constraint_type FROM information_schema.table_constraints
  WHERE table_name = 'partner_stats_hourly' AND constraint_type = 'UNIQUE'
`);
console.log('UNIQUE constraints:', cons.map((r: any) => r.constraint_name).join(', ') || '(none)');

process.exit(0);
