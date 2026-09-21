/**
 * Daily backfill — shared by the cron worker (03:00 UTC) and run-once
 * (`npm run sync:once -- daily-backfill`).
 *
 * Design constraints (learned the hard way — the Jul 3/4 backfills died
 * silently and left zero trace in sync_runs):
 *   - EVERY step runs in its own try/catch: one source failing must never
 *     abort the others.
 *   - The backfill itself is recorded in sync_runs (source='cron',
 *     job_type='daily-backfill') so a crash is visible, not silent.
 *   - Taboola's hourly report rejects ranges over 48h — sync in 2-day
 *     sub-windows, never one 4-day call.
 *   - The MV refresh runs at the end no matter what failed before it.
 */
import { syncTaboolaMetadata, syncTaboolaHourly, syncTaboolaGeoCost, refreshJoinedView } from '../sync/taboola.js';
import { syncCodefuel } from '../sync/codefuel.js';
import { syncImageAdvantage, syncXMetricsDaily } from '../sync/imageadvantage.js';
import { syncDDCRange } from '../sync/ddc.js';
import { syncOutbrainCampaigns, syncOutbrainPromotedLinks, syncOutbrainCost, syncOutbrainBreakdowns } from '../sync/outbrain.js';
import { query } from '../db/client.js';
import { logger } from '../config/logger.js';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/**
 * Run fn recorded as a sync_runs row so it is visible in /api/sync-status
 * and diagnosable after the fact. Never throws — returns true on success.
 * sync_runs bookkeeping failures are logged and ignored (the sync itself
 * matters more than its audit row).
 */
export async function withSyncRun(
  source: string,
  jobType: string,
  windowStart: string,
  windowEnd: string,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  let runId: number | null = null;
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO sync_runs (source, job_type, window_start, window_end, status)
       VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
      [source, jobType, windowStart, windowEnd],
    );
    runId = rows[0].id;
  } catch (err) {
    logger.warn({ err, source, jobType }, 'withSyncRun: could not record start');
  }
  try {
    await fn();
    if (runId != null) {
      try {
        await query(`UPDATE sync_runs SET finished_at = NOW(), status = 'ok' WHERE id = $1`, [runId]);
      } catch (err) {
        logger.warn({ err, runId }, 'withSyncRun: could not record finish');
      }
    }
    return true;
  } catch (err: any) {
    logger.error({ err, source, jobType }, 'withSyncRun: job failed');
    if (runId != null) {
      try {
        await query(
          `UPDATE sync_runs SET finished_at = NOW(), status = 'error', error = $2 WHERE id = $1`,
          [runId, String(err?.message ?? err).slice(0, 500)],
        );
      } catch (err2) {
        logger.warn({ err: err2, runId }, 'withSyncRun: could not record failure');
      }
    }
    return false;
  }
}

/**
 * Sync the last 4 days across every source. Each step is isolated; the
 * result lists which steps succeeded and which failed. The overall
 * sync_runs row is 'ok' only if every step passed — its error column
 * names the failed steps otherwise.
 */
export async function runDailyBackfill(): Promise<{ ok: string[]; failed: string[] }> {
  const now = new Date();
  const w = { startDate: isoDay(addDays(now, -4)), endDate: isoDay(now) };
  const ok: string[] = [];
  const failed: string[] = [];

  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      ok.push(name);
      logger.info({ step: name }, 'daily-backfill: step ok');
    } catch (err) {
      failed.push(name);
      logger.error({ err, step: name }, 'daily-backfill: step FAILED — continuing with remaining steps');
    }
  };

  await withSyncRun('cron', 'daily-backfill', w.startDate, w.endDate, async () => {
    // 1. Metadata first — new campaigns must exist in the DB before their
    //    stats arrive, or upsertStatRows silently drops the rows.
    await step('taboola-metadata', () => syncTaboolaMetadata());
    await step('outbrain-campaigns', () => syncOutbrainCampaigns());
    await step('outbrain-promoted-links', () => syncOutbrainPromotedLinks());

    // 2. Taboola hourly — 2-day sub-windows (API rejects ranges over 48h).
    for (let off = -4; off <= 0; off += 2) {
      const a = isoDay(addDays(now, off));
      const b = isoDay(addDays(now, Math.min(off + 1, 0)));
      await step(`taboola-hourly ${a}..${b}`, () => syncTaboolaHourly({ startDate: a, endDate: b }));
    }

    await step('codefuel', () => syncCodefuel({ ...w, granularity: 'hourly' }));

    // 3. IA y-metrics + x-metrics: single-day API, bars today — D-4..D-1.
    for (let off = -4; off <= -1; off++) {
      const d = isoDay(addDays(now, off));
      await step(`ia-y ${d}`, () => syncImageAdvantage({ date: d, granularity: 'hourly' }));
    }
    for (let off = -4; off <= -1; off++) {
      const d = isoDay(addDays(now, off));
      await step(`ia-x ${d}`, () => syncXMetricsDaily({ date: d }));
    }

    // 3b. DDC — daily grain, one API call per day (a DDC date range is SUMMED,
    //     not split, so a range call cannot produce per-day rows). Its own
    //     internal per-day isolation means one bad day won't lose the others.
    //
    //     D-4..D-1, NOT D-0: like IA, DDC bars the current day — it answers
    //     `{"error":"No stats for this date"}` until the UTC day closes. Asking
    //     for today would fail this step every single night, and a step that
    //     always fails is a step nobody reads when it fails for a real reason.
    await step('ddc', () => syncDDCRange({
      from: w.startDate,
      to: isoDay(addDays(now, -1)),
    }));

    // 4. Device/Country/Site cost.
    await step('taboola-geo-cost', () => syncTaboolaGeoCost(w));

    // 5. Outbrain cost + breakdowns.
    await step('outbrain-cost', () => syncOutbrainCost({ from: w.startDate, to: w.endDate }));
    await step('outbrain-breakdowns', () => syncOutbrainBreakdowns({ from: w.startDate, to: w.endDate }));

    // 6. MV refresh — always, so whatever DID sync reaches the dashboard.
    await step('refresh-mv', () => refreshJoinedView());

    if (failed.length > 0) throw new Error(`steps failed: ${failed.join(', ')}`);
  });

  logger.info({ okSteps: ok.length, failedSteps: failed }, 'daily-backfill: done');
  return { ok, failed };
}
