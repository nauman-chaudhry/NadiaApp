import { query } from '../db/client.js';
async function main() {
  const r = await query(`
    SELECT id, source, job_type, window_start::text, window_end::text,
           status, rows_written, started_at::text
    FROM sync_runs
    ORDER BY started_at DESC
    LIMIT 20`);
  console.log('RECENT_RUNS=' + JSON.stringify(r));
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
