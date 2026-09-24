import { fetchDDCDetail, fetchDDCDaily, fetchDDCHourly, DDCDetailRow } from '../sources/ddc/client.js';
import { withTx, query } from '../db/client.js';
import { logger } from '../config/logger.js';

const DDC_PARTNER_CODE = 'ddc';

// Domain -> platform, keyed on the subdomain PREFIX DDC reports in `Mode`, not on
// the domain itself — so a domain change needs no code change. History:
//   tmpl C244 -> ob.startgonow.com (Outbrain), tmpl C245 -> tb.startgonow.com
//   (Taboola); 2026-09-23 the client moved Outbrain traffic to tmpl C253 ->
//   ob.find247library.com after pausing the first domain. Verified 2026-09-24:
//   DDC reports the new domain WITH the `ob.` prefix, the 27 new promoted links
//   all carry `tt=<tag>_{{publisher_id}}`, and the 03:00 job had already stored
//   their tt_param — so attribution continued unchanged.
// Only ob.* has traffic today; the tb path is built so it works the moment she
// switches it on. A `Mode` with neither prefix is skipped (never guessed) and
// counted in `skipped` — watch that number if DDC ever changes the convention.
export function platformForDomain(mode: string): 'Outbrain' | 'Taboola' | null {
  const d = (mode ?? '').toLowerCase();
  if (d.startsWith('ob.')) return 'Outbrain';
  if (d.startsWith('tb.')) return 'Taboola';
  return null;
}

/**
 * Split a DDC type tag into its attribution key and its publisher key.
 *
 *   '00f81d3a...651'                 -> { tag: '00f81d3a...651', publisher: '' }
 *   '00f81d3a...651_00ede943...637'  -> { tag: '00f81d3a...651', publisher: '00ede943...637' }
 *
 * The publisher macro went live 2026-08-28: everything before is bare,
 * everything after is suffixed, and 28 Aug carries BOTH — verified disjoint
 * (bare $288.9035 + suffixed $10.2677 = $299.1712, exactly DDC's own daily
 * total for that day), so summing both is correct and does not double count.
 *
 * The publisher part is NOT decoration: dropping it collapses distinct rows onto
 * one key (47 collisions across 166 keys in a single day's data), which the
 * upsert would then resolve by overwriting — silently deleting real revenue.
 */
export function parseTypeTag(raw: string): { tag: string; publisher: string } {
  const s = String(raw ?? '');
  const i = s.indexOf('_');
  if (i < 0) return { tag: s, publisher: '' };
  return { tag: s.slice(0, i), publisher: s.slice(i + 1) };
}

interface DDCTuple {
  campaignExtId: string;
  itemExtId: string;
  country: string;
  sourcePlatform: 'Outbrain' | 'Taboola';
  adClicks: number;
  sessions: number;
  revenue: number;
}

/**
 * Pull one day of DDC stats and upsert into partner_stats_hourly.
 * Idempotent — re-running a date overwrites with the latest numbers.
 *
 * Storage (all rows are the ATTRIBUTED shape, campaign_ext_id NOT NULL):
 *   granularity     = 'daily'            The `detail` report has no hour. Since
 *                                        syncDDCHourly() was added, DDC DOES
 *                                        write 'hourly' rows for a rolling ~3
 *                                        days, so these daily rows ARE shadowed
 *                                        for any date that has hourly rows —
 *                                        both by the MV's `ps` CTE and by
 *                                        ddcGrainDedup() in api/server.ts. That
 *                                        is deliberate (the day must be counted
 *                                        once), but it means a day whose hourly
 *                                        rows are INCOMPLETE will under-report
 *                                        until syncDDCHourly() fills it in, so
 *                                        the hourly cron must keep running while
 *                                        a day is still inside DDC's rolling
 *                                        window. Older days keep their daily rows.
 *   campaign_ext_id = 'ob:<tag>' | 'tb:<tag>'
 *   item_ext_id     = publisher hex, or '' — NEVER NULL. The attributed unique
 *                     index has no NULLS NOT DISTINCT, so a NULL here means
 *                     ON CONFLICT never matches and every re-sync appends a
 *                     duplicate. That is exactly the migration-039 bug.
 *   hour_utc        = <date>T00:00:00Z   DDC's reporting day IS a UTC day
 *                                        (Yahoo day ends 5pm PST = midnight UTC).
 *   revenue         = Net Client         net to us; Nadia confirmed no % applies
 *   ad_clicks       = Clicks
 *   sessions        = BiddedSearches
 *   country         = Country
 *   source_platform = 'Outbrain' | 'Taboola'
 *
 * TQ / Source TQ / Searches / Visitors are deliberately NOT stored — Nadia:
 * "TQ is not available right now, leave it for now". The stats API retains 40+
 * days, so TQ can be added AND backfilled whenever it starts populating.
 */
export async function syncDDC(opts: { date: string }): Promise<{
  rowsWritten: number; revenue: number; skipped: number;
}> {
  const runId = await startRun('ddc', 'daily', opts.date, opts.date);

  try {
    const rows = await fetchDDCDetail(opts.date);
    if (rows.length === 0) {
      await finishRun(runId, 'ok', 0);
      return { rowsWritten: 0, revenue: 0, skipped: 0 };
    }

    const partnerId = await getPartnerId(DDC_PARTNER_CODE);
    const hourUtc = `${opts.date}T00:00:00.000Z`;

    // ACCUMULATE, never overwrite. IA's sync uses last-write-wins because its
    // feed emits one row per key; DDC collapses a report dimension (domain ->
    // source_platform) into a stored value, so two source rows CAN share a key.
    // Overwriting would delete real revenue before it ever reached Postgres.
    // Verified: with the publisher in the key this does not currently collide
    // (0 collisions on bare, transition and suffixed days) — accumulating keeps
    // it correct anyway if DDC adds a domain or changes grain.
    const acc = new Map<string, DDCTuple>();
    let skipped = 0;

    for (const row of rows as DDCDetailRow[]) {
      const sourcePlatform = platformForDomain(row.Mode);
      if (!sourcePlatform) { skipped++; continue; }   // unknown domain: never guess

      const { tag, publisher } = parseTypeTag(row.TypeTag);
      if (!tag) { skipped++; continue; }

      const prefix = sourcePlatform === 'Outbrain' ? 'ob:' : 'tb:';
      const campaignExtId = `${prefix}${tag}`;
      const itemExtId = publisher;                    // '' when bare, never null
      const country = row.Country ?? '';

      const key = `${campaignExtId} ${itemExtId} ${country}`;
      const prev = acc.get(key);
      acc.set(key, {
        campaignExtId, itemExtId, country, sourcePlatform,
        adClicks: (prev?.adClicks ?? 0) + (Number(row.Clicks) || 0),
        sessions: (prev?.sessions ?? 0) + (Number(row.BiddedSearches) || 0),
        revenue:  (prev?.revenue  ?? 0) + (Number(row['Net Client']) || 0),
      });
    }

    const tuples = [...acc.values()].map(t => [
      partnerId, 'daily', t.campaignExtId, t.itemExtId, hourUtc,
      t.country, '', t.adClicks, t.sessions, t.revenue, 0, 0, 0, t.sourcePlatform,
    ]);

    await withTx(async (client) => { await bulkUpsert(client, tuples); });

    const revenue = [...acc.values()].reduce((a, t) => a + t.revenue, 0);
    await finishRun(runId, 'ok', tuples.length);
    logger.info(
      { date: opts.date, written: tuples.length, revenue: revenue.toFixed(4), skipped, sourceRows: rows.length },
      'ddc: upsert done',
    );
    return { rowsWritten: tuples.length, revenue, skipped };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err, date: opts.date }, 'ddc: failed');
    throw err;
  }
}

/** Sync an inclusive range, one call per day — a DDC date range is SUMMED, not split. */
export async function syncDDCRange(opts: { from: string; to: string }): Promise<{
  days: number; rowsWritten: number; revenue: number; failed: string[];
}> {
  // Ask the `date` report FIRST which days actually have revenue. It is one call,
  // it is far more reliable than the per-day `detail` call, and it gives an
  // independent expected total to check ourselves against.
  //
  // This matters because DDC answers "No stats for this date" both for a day
  // that genuinely has nothing AND, intermittently, for a day that does have
  // data. Treating that reply as an empty day (which we must, or the nightly job
  // fails forever on not-yet-published days) would otherwise let a flap silently
  // write zero revenue for a real trading day.
  let expected: Record<string, number> | null = null;
  try {
    const daily = await fetchDDCDaily(opts.from, opts.to);
    expected = Object.fromEntries(daily.map(d => [d.day, d.revenue]));
    logger.info(
      { ...opts, daysWithData: Object.keys(expected).length },
      'ddc: date report says which days have revenue',
    );
  } catch (err: any) {
    logger.warn({ err: err.message, ...opts }, 'ddc: date report unavailable, syncing every day blind');
  }

  const days = eachDay(opts.from, opts.to);
  let rowsWritten = 0;
  let revenue = 0;
  const failed: string[] = [];
  for (const day of days) {
    // Skip days the date report says have nothing — saves a call and, more
    // importantly, stops a flap on an empty day looking like a failure.
    if (expected && !(day in expected)) {
      logger.info({ day }, 'ddc: no revenue for this day per the date report, skipping');
      continue;
    }
    let lastDayRevenue = 0;
    try {
      const r = await syncDDC({ date: day });
      rowsWritten += r.rowsWritten;
      revenue += r.revenue;
      lastDayRevenue = r.revenue;
    } catch (err: any) {
      // Isolate per day: one bad day must not abort the rest of the backfill.
      failed.push(day);
      logger.error({ day, err: err.message }, 'ddc: day failed, continuing');
    }
    // The date report said this day has revenue but we stored none — that is a
    // flap, not an empty day, and it must be loud rather than silently zero.
    if (expected && expected[day] > 0 && !failed.includes(day)) {
      const got = lastDayRevenue;
      if (got === 0) {
        failed.push(day);
        logger.error(
          { day, expected: expected[day] },
          'ddc: date report shows revenue but detail returned nothing — treating as a failure',
        );
      }
    }
    await new Promise(r => setTimeout(r, 250));   // be polite; rate limits unknown
  }
  logger.info(
    { ...opts, days: days.length, rowsWritten, revenue: revenue.toFixed(2), failed },
    'ddc: range done',
  );
  // Isolate per day, then THROW naming what failed — the same shape as
  // daily-backfill's own step()/failed[] contract. Without this a range where
  // every day failed (bad credentials, DDC down) returns normally, the backfill
  // records step 'ddc' as ok, and DDC silently stops updating for days. That is
  // the exact failure mode the 03:00 job's per-step isolation exists to prevent.
  if (failed.length > 0) throw new Error(`ddc: days failed: ${failed.join(', ')}`);
  return { days: days.length, rowsWritten, revenue, failed };
}

// ---------- helpers ----------

const COLS = 14;

// Chunked multi-row upsert — one INSERT per CHUNK rows rather than per row,
// which is what keeps this off the Supabase statement timeout.
async function bulkUpsert(
  client: { query: (sql: string, params: any[]) => Promise<unknown> },
  tuples: any[][],
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const slice = tuples.slice(i, i + CHUNK);
    const values = slice.map((_, j) => {
      const b = j * COLS;
      return `(${Array.from({ length: COLS }, (_, k) => `$${b + k + 1}`).join(',')},NOW())`;
    }).join(',');
    await client.query(
      `INSERT INTO partner_stats_hourly
         (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc,
          country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)
       VALUES ${values}
       ON CONFLICT (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device)
       WHERE campaign_ext_id IS NOT NULL
       DO UPDATE SET
         ad_clicks       = EXCLUDED.ad_clicks,
         sessions        = EXCLUDED.sessions,
         revenue         = EXCLUDED.revenue,
         source_platform = EXCLUDED.source_platform,
         fetched_at      = NOW()`,
      slice.flat(),
    );
  }
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function getPartnerId(code: string): Promise<number> {
  const rows = await query<{ id: number }>('SELECT id FROM client_partners WHERE code = $1', [code]);
  if (!rows[0]) throw new Error(`Unknown client_partner code: ${code}`);
  return rows[0].id;
}

async function startRun(source: string, jobType: string, start: string, end: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO sync_runs (source, job_type, window_start, window_end, status)
     VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
    [source, jobType, start, end],
  );
  return rows[0].id;
}

async function finishRun(id: number, status: 'ok' | 'error', rows: number, errMsg?: string) {
  await query(
    `UPDATE sync_runs SET finished_at = NOW(), status = $1, rows_written = $2, error = $3 WHERE id = $4`,
    [status, rows, errMsg ?? null, id],
  );
}


/**
 * Sync DDC's hourly feed (the rolling ~3-day window it exposes, including today).
 *
 * Stored as `granularity = 'hourly'`, which is what makes this safe to run
 * alongside the daily sync: the MV's `ps` CTE keeps every hourly row and drops a
 * 'daily' row for any (partner, date) that has hourly rows, so a day covered by
 * both is counted ONCE, from the hourly feed. Older days keep their daily rows.
 * The direct-query tabs (Ads / Site / Country) apply the same rule explicitly —
 * see DDC_GRAIN_DEDUP in api/server.ts. Getting that wrong would double every
 * DDC figure for the last three days.
 *
 * What the hourly feed adds over the daily one:
 *   - a real hour, so DDC finally appears on the Hourly tab
 *   - DEVICE ('Smart Phones' -> mobile, 'Desktop' -> desktop), which the daily
 *     `detail` report does not carry at all. The client is mobile-only today and
 *     plans to add desktop, so this is stored from the start.
 *
 * TQ is present in the feed but still reads 0.00, so it stays unstored (the
 * client asked to defer it); the API retains ~3 days, and the daily report much
 * longer, so it can be backfilled whenever it starts populating.
 */
export async function syncDDCHourly(): Promise<{
  rowsWritten: number; revenue: number; days: string[]; skipped: number;
}> {
  const runId = await startRun('ddc', 'hourly', isoToday(), isoToday());
  try {
    const rows = await fetchDDCHourly();
    if (rows.length === 0) {
      await finishRun(runId, 'ok', 0);
      return { rowsWritten: 0, revenue: 0, days: [], skipped: 0 };
    }
    const partnerId = await getPartnerId(DDC_PARTNER_CODE);
    const acc = new Map<string, any[]>();
    let skipped = 0;

    for (const r of rows) {
      const sourcePlatform = platformForDomain(r.domain);
      if (!sourcePlatform) { skipped++; continue; }
      const { tag, publisher } = parseTypeTag(r.typeTag);
      if (!tag) { skipped++; continue; }

      const campaignExtId = `${sourcePlatform === 'Outbrain' ? 'ob:' : 'tb:'}${tag}`;
      const hourUtc = `${r.date}T${String(r.hour).padStart(2, '0')}:00:00.000Z`;
      const device = normalizeDevice(r.device);
      const key = `${campaignExtId} ${publisher} ${hourUtc} ${r.country} ${device}`;
      const prev = acc.get(key);
      // Accumulate, never overwrite — same reasoning as the daily sync.
      acc.set(key, [
        partnerId, 'hourly', campaignExtId, publisher, hourUtc, r.country, device,
        (prev ? prev[7] : 0) + r.clicks,
        (prev ? prev[8] : 0) + r.biddedSearches,
        (prev ? prev[9] : 0) + r.revenue,
        0, 0, 0, sourcePlatform,
      ]);
    }

    const tuples = [...acc.values()];
    await withTx(async (client) => { await bulkUpsert(client, tuples); });

    const revenue = tuples.reduce((a, t) => a + t[9], 0);
    const days = [...new Set(rows.map(r => r.date))].sort();
    await finishRun(runId, 'ok', tuples.length);
    logger.info(
      { written: tuples.length, revenue: revenue.toFixed(4), days, skipped, sourceRows: rows.length },
      'ddc hourly: upsert done',
    );
    return { rowsWritten: tuples.length, revenue, days, skipped };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'ddc hourly: failed');
    throw err;
  }
}

function isoToday(): string { return new Date().toISOString().slice(0, 10); }

/** Match the device vocabulary the rest of the dashboard already uses. */
function normalizeDevice(d: string): string {
  const v = (d ?? '').toLowerCase();
  if (v.includes('phone') || v.includes('mobile')) return 'mobile';
  if (v.includes('desktop')) return 'desktop';
  if (v.includes('tablet')) return 'tablet';
  return v.trim();
}
