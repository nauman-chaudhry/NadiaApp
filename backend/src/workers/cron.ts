import cron from 'node-cron';
import { syncTaboolaHourly, syncTaboolaMetadata, refreshJoinedView } from '../sync/taboola.js';
import { syncCodefuel } from '../sync/codefuel.js';
import { syncImageAdvantage } from '../sync/imageadvantage.js';
import { syncOutbrainMarketerHourly, syncOutbrainCost, syncOutbrainAds } from '../sync/outbrain.js';
import { syncDDCRange, syncDDCHourly } from '../sync/ddc.js';
import { sendDdcHourlyReport } from '../reports/ddc-hourly-csv.js';
import { runDailyBackfill, withSyncRun } from './daily-backfill.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { sourceEnabled, describeTenant, type Source } from '../config/tenant.js';

if (!env.ENABLE_CRON) {
  logger.warn('ENABLE_CRON=false — worker exiting without scheduling jobs');
  process.exit(0);
}

logger.info({ tenant: describeTenant() }, 'cron: tenant rules for this deployment');

// Schedule a job only when its source is enabled for this deployment
// (ENABLED_SOURCES). Joe's worker runs taboola + outbrain + image_advantage;
// Nadia's runs everything. A disabled source is logged once at boot so a
// missing job is visible in the Render logs rather than a mystery.
function scheduleFor(
  source: Source,
  expr: string,
  fn: () => Promise<void>,
  opts?: Parameters<typeof cron.schedule>[2],
): void {
  if (!sourceEnabled(source)) {
    logger.info({ source, expr }, 'cron: source disabled for this deployment — job not scheduled');
    return;
  }
  cron.schedule(expr, fn, opts);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

function window2Hours() {
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

/** Log-and-continue wrapper: a cron job body must never throw. */
async function attempt(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, job: name }, `cron: ${name} failed`);
  }
}

// Guards against overlapping heavyweight runs (single process, so a plain
// module flag is enough). The 2h metadata tick skips while the daily
// backfill (which starts with its own metadata pass) is in flight.
let dailyBackfillRunning = false;
let metadataRunning = false;

// ---------- Taboola hourly: HH:05 ----------
scheduleFor('taboola', '5 * * * *', async () => {
  const w = window2Hours();
  logger.info({ ...w }, 'cron: taboola hourly start');
  await attempt('taboola hourly', () => syncTaboolaHourly(w));
  await attempt('mv refresh (taboola)', () => refreshJoinedView());
});

// ---------- Codefuel hourly: HH:15 ----------
// Sync YESTERDAY and TODAY explicitly, exactly as the IA job below does, rather
// than the 2h wall-clock window this used to use.
//
// Why: window2Hours() maps a 2-hour clock window onto DATES, so from 02:15 UTC
// onward every run asked for today only. Codefuel publishes roughly 6h late, so
// yesterday's final hours are published AFTER yesterday has dropped out of that
// window -- and after the 03:00 backfill has already run -- leaving them to wait
// for the NEXT day's backfill, ~27h later. (Observed: at 05:09 UTC on 09-09 we
// held 09-08 h0..h22, matching Codefuel's API exactly, with h23 unpublished and
// no hourly run able to collect it once it appeared.)
//
// No data was ever lost -- the backfill always filled the hole eventually -- but
// the last hours of each day showed up a day late, which is what the client saw
// as Codefuel "not being real time". Two calls/hour against a 60/hour limit, and
// the upsert is idempotent, so re-asking for yesterday every hour simply
// converges and also picks up any restatement Codefuel makes to a closed hour.
scheduleFor('codefuel', '15 * * * *', async () => {
  const now = new Date();
  const yesterday = isoDay(addDaysUtc(now, -1));
  const today = isoDay(now);
  logger.info({ dates: [yesterday, today] }, 'cron: codefuel hourly start');
  // Each day isolated: a failure on yesterday must not block today's data.
  await attempt('codefuel hourly (yesterday)', () =>
    syncCodefuel({ startDate: yesterday, endDate: yesterday, granularity: 'hourly' }));
  await attempt('codefuel hourly (today)', () =>
    syncCodefuel({ startDate: today, endDate: today, granularity: 'hourly' }));
  await attempt('mv refresh (codefuel)', () => refreshJoinedView());
});

// ---------- Image Advantage hourly: HH:20 ----------
// IA API is single-day only — sync both yesterday and today to cover the 2h window.
scheduleFor('image_advantage', '20 * * * *', async () => {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  logger.info({ dates: [isoDay(yesterday), isoDay(today)] }, 'cron: image_advantage hourly start');
  // Each day isolated: a failure on yesterday must not block today's data.
  await attempt('ia hourly (yesterday)', () => syncImageAdvantage({ date: isoDay(yesterday), granularity: 'hourly' }));
  await attempt('ia hourly (today)', () => syncImageAdvantage({ date: isoDay(today), granularity: 'hourly' }));
  await attempt('mv refresh (ia)', () => refreshJoinedView());
});

// ---------- Outbrain account-level hourly cost: HH:25 ----------
// EDT day boundaries: sync both the current and previous EDT day so the UTC
// hours around midnight EDT are always covered. Three Outbrain pulls now share
// that window -- marketer-hourly, per-campaign cost and per-promoted-link cost --
// each one call per marketer per day. The tick runs ~7 minutes end to end.
scheduleFor('outbrain', '25 * * * *', async () => {
  const nowEdt = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const prevEdt = new Date(nowEdt.getTime() - 24 * 60 * 60 * 1000);
  const w = { from: isoDay(prevEdt), to: isoDay(nowEdt) };
  logger.info({ ...w }, 'cron: outbrain hourly start');
  await attempt('outbrain marketer-hourly', () => syncOutbrainMarketerHourly(w));
  // Per-CAMPAIGN daily cost, which used to run ONLY in the 03:00 backfill. That left
  // outbrain_stats_daily empty for the current day while outbrain_marketer_hourly was
  // refreshed every hour, and the two feed different tabs -- so during the day the
  // Campaign tab showed $0 Outbrain spend (hence 100% margin and inflated profit on
  // the Today preset, which the client reported) while the Hourly tab showed the real
  // number. Measured 2026-09-09: campaign-grain $0.00 vs marketer-hourly $2,482.29 for
  // the same day. Same 2-day EDT window and the same ~14 calls/hour as the job above;
  // the upsert is idempotent, so re-running the window each hour just converges.
  await attempt('outbrain campaign cost', () => syncOutbrainCost(w));
  // Per-PROMOTED-LINK daily cost -> outbrain_ad_daily, which the Ads tab reads
  // directly (server.ts joins outbrain_ad_daily, not the MV). It had the exact same
  // gap the campaign-grain job above just closed, one level down: it ran ONLY inside
  // syncOutbrainBreakdowns in the 03:00 backfill, so intraday the table held nothing
  // for the current day and the Ads tab showed $0 Outbrain spend / 100% margin while
  // the Campaign tab (now hourly) showed the real number. Measured 2026-09-09 22:2x:
  // outbrain_ad_daily had 0 rows for the day, Ads read $0.00 against Campaign's
  // $2,293.74 -- i.e. Campaign != Ads for any window containing today.
  // Same 2-day window, same idempotent upsert; ~5 min, the slowest of the three.
  await attempt('outbrain ad-level cost', () => syncOutbrainAds(w));
  // Required: the Campaign/Daily tabs read the MV, so new cost is invisible until a
  // refresh. The marketer-hourly job never needed one because the Hourly tab reads
  // outbrain_marketer_hourly directly.
  await attempt('mv refresh (outbrain)', () => refreshJoinedView());
});

// ---------- DDC: EVERY HOUR at :45 ----------
// One job pulls both DDC feeds and refreshes the MV once.
//
// The client asked for an hourly API call. The hourly feed was already pulled
// hourly; the DAILY pull ran every 3 hours, so that is what changed. Merging the
// two into a single job also removes a duplicate MV refresh — previously :45
// (3-hourly, both feeds) and :50 (hourly feed) each refreshed the view.
//
// Cost per run is small and bounded: syncDDCRange asks DDC's `date` report once
// and only fetches `detail` for days it says actually have revenue, so a typical
// run is ~5 calls rather than one per day in the window. The upsert is
// idempotent, so re-running the same days every hour simply converges — which is
// what makes DDC's habit of intermittently answering "No stats for this date"
// self-healing rather than a lost day.
//
// Window D-3..D-0 for the daily feed; the hourly feed exposes its own rolling
// ~3 days including today. Hourly rows take precedence over daily ones for the
// same day (ps CTE in the MV, ddcGrainDedup in api/server.ts).
scheduleFor('ddc', '45 * * * *', async () => {
  const now = new Date();
  const w = { from: isoDay(addDaysUtc(now, -3)), to: isoDay(now) };
  logger.info({ ...w }, 'cron: ddc start');
  await attempt('ddc daily', () => syncDDCRange(w));
  await attempt('ddc hourly', () => syncDDCHourly());
  await attempt('mv refresh (ddc)', () => refreshJoinedView());
});

// ---------- Daily client report: 10:00 Europe/London ----------
// Emails the previous day's DDC hourly-by-Type-Tag CSV to the client.
//
// Timing is set by DDC's publish lag, which measured ~7h: at 18:15 UTC their
// freshest hour was 11:00, so the previous day only completes around 07:00 UTC.
// 09:00 UTC leaves ~2h of margin; 08:00 (the client's first suggestion) left ~1h.
//
// The timezone is pinned to Europe/London rather than hardcoding 09:00 UTC so
// the send stays at 10am local when BST ends and the UTC offset changes.
//
// A failed or skipped send is not lost: DDC's hourly feed keeps a rolling ~3
// days, so the next day's run can still produce the missed date on request.
scheduleFor('ddc', '0 10 * * *', async () => {
  const date = isoDay(addDaysUtc(new Date(), -1));
  logger.info({ date }, 'cron: ddc daily report start');
  // Recorded in sync_runs like every other job. Without this the report left NO
  // trace anywhere: Resend's API has no list endpoint, so after the fact there
  // was no way to tell whether a send had run, failed, or never fired -- on the
  // one job that goes straight to the client.
  await withSyncRun('ddc', 'report', date, date, () => sendDdcHourlyReport({ date }));
}, { timezone: 'Europe/London' });

// ---------- Metadata: every 2 hours ----------
// Discovers new sub-accounts, campaigns, and ads from Taboola automatically,
// so campaigns created between daily backfills are picked up within 2h.
// Recorded in sync_runs (source='taboola', job_type='metadata') for visibility.
scheduleFor('taboola', '0 */2 * * *', async () => {
  if (dailyBackfillRunning || metadataRunning) {
    logger.info('cron: taboola metadata skipped (backfill or previous metadata run still in progress)');
    return;
  }
  metadataRunning = true;
  logger.info('cron: taboola metadata start');
  try {
    const today = isoDay(new Date());
    await withSyncRun('taboola', 'metadata', today, today, () => syncTaboolaMetadata());
  } finally {
    metadataRunning = false;
  }
});

// ---------- Daily backfill: 03:00 UTC, last 4 days ----------
// All sources, each step individually isolated + recorded in sync_runs —
// see daily-backfill.ts. One failing source can no longer abort the rest,
// and the run itself is visible in sync_runs (source='cron').
cron.schedule('0 3 * * *', async () => {
  if (dailyBackfillRunning) {
    logger.warn('cron: daily backfill skipped (previous run still in progress)');
    return;
  }
  dailyBackfillRunning = true;
  logger.info('cron: daily backfill start');
  try {
    const { ok, failed } = await runDailyBackfill();
    logger.info({ okSteps: ok.length, failedSteps: failed }, 'cron: daily backfill done');
  } catch (err) {
    // runDailyBackfill never throws by design, but belt and braces:
    logger.error({ err }, 'cron: daily backfill crashed');
  } finally {
    dailyBackfillRunning = false;
  }
});

logger.info('Cron worker started');
