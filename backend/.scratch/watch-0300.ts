import { appendFileSync } from 'node:fs';
import { query } from '../src/db/client.js';

// Decisive test that the DEPLOYED worker is running commit d63f153.
//
// x-metrics only runs inside runDailyBackfill() at 03:00 UTC, for D-4..D-1,
// each date wrapped in step() so one failure cannot abort the rest. New code
// asks IA's unfiltered x-metrics feed which affiliates have Flux data and gets
// ssm.flux.pro.ob + ssm.flux.s4s.mgid; old code asks the y-metrics feed and
// keeps only `.tb`, so it requests neither. 2026-11-11 has no ob:/mgid: rows
// yet (IA rejected it as "today" during the manual backfill), so that date is
// a clean discriminator: new code fills it, old code leaves it empty.
const LOG = 'C:/Users/DELL/Documents/GitHub/NadiaApp/backend/.scratch/watch-0300.log';
const AFTER = '2026-11-12 02:30:00';
const DEADLINE = Date.now() + 7 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function say(line: string) {
  const msg = '[' + new Date().toISOString().slice(11, 19) + 'Z] ' + line;
  console.log(msg);
  try { appendFileSync(LOG, msg + '\n'); } catch { /* logging must never kill the watch */ }
}

say('watch started; waiting for the 03:00 UTC backfill (deadline ' +
    new Date(DEADLINE).toISOString().slice(11, 16) + 'Z)');

while (Date.now() < DEADLINE) {
  try {
    const runs = await query(
      `SELECT status, rows_written, window_start::date d,
              to_char(started_at AT TIME ZONE 'UTC','MM-DD HH24:MI') t
         FROM sync_runs
        WHERE source = 'image_advantage_x'
          AND started_at AT TIME ZONE 'UTC' > $1::timestamp
        ORDER BY started_at`, [AFTER]);

    if (runs.length) {
      const flux = await query(`
        SELECT round(sum(revenue) FILTER (WHERE campaign_ext_id LIKE 'ob:%')::numeric,2) ob,
               round(sum(revenue) FILTER (WHERE campaign_ext_id LIKE 'mgid:%')::numeric,2) mgid,
               count(*) n
          FROM partner_stats_hourly
         WHERE granularity = 'x-daily' AND hour_utc = DATE '2026-11-11'`);
      const f: any = flux[0] ?? {};
      say('x-metrics runs after cutoff: ' + runs.length +
          ' | 11 Nov x-daily ob=' + f.ob + ' mgid=' + f.mgid + ' rows=' + f.n);
      for (const r of runs) say('   ' + JSON.stringify(r));

      if (Number(f.ob ?? 0) > 0 || Number(f.mgid ?? 0) > 0) {
        say('VERDICT: NEW CODE LIVE - deployed worker pulled ob/mgid Flux for 11 Nov');
        process.exit(0);
      }
      if (runs.length >= 3 && runs.some((r: any) => r.status === 'ok')) {
        say('VERDICT: OLD CODE STILL DEPLOYED - x-metrics ran OK but wrote no ob/mgid rows.');
        say('         Render did not pick up d63f153; the worker needs deploying.');
        process.exit(0);
      }
    } else {
      say('no x-metrics run yet after ' + AFTER);
    }
  } catch (e: any) {
    say('poll error (ignored): ' + e.message);
  }
  await sleep(900_000);
}
say('VERDICT: deadline reached - the 03:00 backfill never produced an x-metrics run');
process.exit(0);
