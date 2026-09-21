import {
  fetchHourlyPerformance,
  fetchDailyPerformance,
  CodefuelRow,
} from '../sources/codefuel/client.js';
import { query } from '../db/client.js';
import { logger } from '../config/logger.js';

const CODEFUEL_PARTNER_CODE = 'codefuel';

type Granularity = 'hourly' | 'daily';

/**
 * Pull a window of Codefuel stats and upsert into partner_stats_hourly.
 * Idempotent — re-running for the same window overwrites with latest numbers.
 *
 * Granularity:
 *   - 'hourly' uses /io/getHourlyPerformanceData (only available last 14 days)
 *   - 'daily'  uses /io/getDailyPerformanceData (available last 3 months)
 *
 * For daily rows, hour_utc is set to 00:00 of the date so the same table can
 * hold both and the joined view works uniformly.
 */
export async function syncCodefuel(opts: {
  startDate: string;   // 'YYYY-MM-DD'
  endDate: string;
  granularity: Granularity;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('codefuel', opts.granularity, opts.startDate, opts.endDate);

  try {
    const rows = opts.granularity === 'hourly'
      ? await fetchHourlyPerformance(opts)
      : await fetchDailyPerformance(opts);

    logger.info({ count: rows.length, ...opts }, 'codefuel: fetched');

    if (rows.length === 0) {
      await finishRun(runId, 'ok', 0);
      return { rowsWritten: 0 };
    }

    const partnerId = await getPartnerId(CODEFUEL_PARTNER_CODE);

    const validRows = rows.filter(r => r.asset_gid && r.channel && r.date);
    const BATCH = 100;
    let written = 0;

    for (let i = 0; i < validRows.length; i += BATCH) {
      const batch = validRows.slice(i, i + BATCH);
      const placeholders = batch.map((_, j) => {
        const b = j * 14;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},NOW())`;
      }).join(',');
      const args = batch.flatMap(row => [
        partnerId,
        opts.granularity,
        row.asset_gid,
        row.channel,
        buildHourUtc(row, opts.granularity),
        row.country_code ?? '',
        normalizeDevice(row.device) ?? '',
        row.ad_clicks ?? 0,
        row.sessions ?? 0,
        row.revenue ?? 0,
        row.rpc ?? 0,
        row.rpm ?? 0,
        row.ctr ?? 0,
        row.source_platform ?? null,
      ]);
      await query(
        `INSERT INTO partner_stats_hourly
           (client_partner_id, granularity, asset_gid, channel, hour_utc,
            country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)
         VALUES ${placeholders}
         ON CONFLICT (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform)
         WHERE campaign_ext_id IS NULL
         DO UPDATE SET
           ad_clicks  = EXCLUDED.ad_clicks,
           sessions   = EXCLUDED.sessions,
           revenue    = EXCLUDED.revenue,
           rpc        = EXCLUDED.rpc,
           rpm        = EXCLUDED.rpm,
           ctr_pct    = EXCLUDED.ctr_pct,
           source_platform = EXCLUDED.source_platform,
           fetched_at = NOW()`,
        args,
      );
      written += batch.length;
    }

    await finishRun(runId, 'ok', written);
    logger.info({ written, ...opts }, 'codefuel: upsert done');
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'codefuel: failed');
    throw err;
  }
}

// ---------- helpers ----------

function buildHourUtc(row: CodefuelRow, granularity: Granularity): string {
  // For hourly granularity Codefuel returns date + hour as separate fields.
  // For daily we pin to 00:00 so the row sits at the start of the day.
  // Both Taboola (GMT, no DST) and Codefuel (UTC) timezones are identical
  // per Nadia's confirmation.
  if (granularity === 'hourly') {
    const hh = String(row.hour ?? 0).padStart(2, '0');
    return `${row.date}T${hh}:00:00.000Z`;
  }
  return `${row.date}T00:00:00.000Z`;
}

function normalizeDevice(d?: string): string | null {
  if (!d) return null;
  const v = d.toLowerCase();
  if (v.includes('desk')) return 'desktop';
  if (v.includes('mob')) return 'mobile';
  if (v.includes('tab')) return 'tablet';
  if (v.includes('other')) return 'other';
  return v;
}

async function getPartnerId(code: string): Promise<number> {
  const rows = await query<{ id: number }>(
    'SELECT id FROM client_partners WHERE code = $1',
    [code],
  );
  if (!rows[0]) throw new Error(`Unknown client_partner code: ${code}`);
  return rows[0].id;
}

async function startRun(
  source: string,
  jobType: string,
  start: string,
  end: string,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO sync_runs (source, job_type, window_start, window_end, status)
     VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
    [source, jobType, start, end],
  );
  return rows[0].id;
}

async function finishRun(
  id: number,
  status: 'ok' | 'error',
  rows: number,
  errMsg?: string,
) {
  await query(
    `UPDATE sync_runs SET finished_at = NOW(), status = $1, rows_written = $2, error = $3 WHERE id = $4`,
    [status, rows, errMsg ?? null, id],
  );
}
