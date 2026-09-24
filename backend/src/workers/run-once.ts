/**
 * Manual sync runner — first-time backfill and debugging.
 *
 * Usage:
 *   npm run sync:once -- taboola-metadata
 *   npm run sync:once -- taboola-hourly 2026-05-20 2026-05-22
 *   npm run sync:once -- codefuel-hourly 2026-05-20 2026-05-22
 *   npm run sync:once -- codefuel-daily 2026-04-01 2026-05-08
 *   npm run sync:once -- image-advantage-hourly 2026-05-26
 *   npm run sync:once -- image-advantage-daily 2026-05-20
 *   npm run sync:once -- image-advantage-backfill 2026-05-20 2026-05-29
 *     ↑ loops day-by-day using daily granularity (single-day IA API constraint)
 *   npm run sync:once -- xmetrics-daily 2026-06-22
 *     ↑ x-metrics (non-Yahoo display) for one day
 *   npm run sync:once -- xmetrics-backfill 2026-06-02 2026-06-23
 *     ↑ loops day-by-day for x-metrics (daily only, no hourly endpoint)
 *   npm run sync:once -- ddc 2026-08-29
 *     ^ DDC (Domain Development Corp) revenue for one day
 *   npm run sync:once -- ddc-backfill 2026-07-22 2026-08-31
 *     ^ DDC over a range, ONE CALL PER DAY (a DDC date range is summed, not split)
 *   npm run sync:once -- ddc-report 2026-09-11 someone@example.com
 *     ^ build and EMAIL the client's hourly-by-Type-Tag CSV for a date
 *       (date defaults to yesterday; recipient defaults to REPORT_EMAIL_TO)
 *   npm run sync:once -- refresh-view
 *   npm run sync:once -- tenant-check
 *     ^ READ-ONLY: which Taboola accounts / Outbrain marketers / IA affiliates this
 *       deployment's TENANT_* rules keep or skip (set the env vars on the command line)
 *   npm run sync:once -- tenant-prune [--apply]
 *     ^ delete ad_accounts rows the rules exclude that hold NO data (dry-run by default)
 *   npm run sync:once -- backfill-full 2026-04-01
 *     ↑ does a full Apr-1-to-now backfill across all sources, handling the
 *       Codefuel 14-day hourly limit automatically.
 *
 * ── Auto-windowed (no dates needed) ─────────────────────────────────────────
 *   npm run sync:once -- taboola-hourly-auto
 *     ↑ Taboola: yesterday + today (2-day window)
 *   npm run sync:once -- codefuel-hourly-auto
 *     ↑ Codefuel: yesterday + today (2-day window)
 *   npm run sync:once -- image-advantage-hourly-auto
 *     ↑ Image Advantage: day-before-yesterday + yesterday (IA API bars today)
 *   npm run sync:once -- refresh-all
 *     ↑ 48-hour window: yesterday (full, closed day) + today up to now.
 *       Self-heals any earlier partial-day gaps. Run before every Nadia demo.
 *   npm run sync:once -- sync-day 2026-06-01
 *     ↑ Explicit single-day backfill across all 3 sources + MV refresh.
 *       Use the NEXT day to get a fully-closed previous day, e.g. run
 *       "sync-day 2026-06-01" on June 2 for clean final numbers.
 */
import { syncTaboolaMetadata, syncTaboolaHourly, syncTaboolaGeoCost, refreshJoinedView } from '../sync/taboola.js';
import { runDailyBackfill } from './daily-backfill.js';
import { syncCodefuel } from '../sync/codefuel.js';
import { syncImageAdvantage, syncXMetricsDaily } from '../sync/imageadvantage.js';
import { syncDDC, syncDDCRange, syncDDCHourly } from '../sync/ddc.js';
import { sendDdcHourlyReport } from '../reports/ddc-hourly-csv.js';
import { syncOutbrainCampaigns, syncOutbrainCost, syncOutbrainPromotedLinks, syncOutbrainBreakdowns, syncOutbrainAds, syncOutbrainCountry, syncOutbrainPublisher, syncOutbrainMarketerHourly } from '../sync/outbrain.js';
import { logger } from '../config/logger.js';
import { pool, query } from '../db/client.js';
import { accountAllowed, describeTenant, iaAffiliateAllowed, sourceEnabled } from '../config/tenant.js';
import { listAllowedAccounts } from '../sources/taboola/client.js';
import { listMarketers } from '../sources/outbrain/client.js';
import { fetchIAHourly } from '../sources/imageadvantage/client.js';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

/**
 * Full backfill from a chosen start date through "now".
 *
 * Taboola:
 *   - campaign_hour_breakdown allows max 48 hours per request and retains ~14 days.
 *   - We pull only the last 14 days in 2-day chunks.
 *   - Historical Taboola cost beyond 14 days is unavailable; those MV rows will
 *     show revenue with spent=0.
 *
 * Codefuel:
 *   - Daily endpoint covers the full historical window from startDate.
 *   - Hourly endpoint covers the last 14 days for finer granularity.
 */
async function backfillFull(startDate: string) {
  logger.info({ startDate }, 'backfill-full: start');

  // 1. Metadata first so we have accounts/campaigns/ads to attach stats to.
  await syncTaboolaMetadata();

  const today = new Date();
  const start = new Date(`${startDate}T00:00:00Z`);
  // Taboola hourly: max 48h per request (inclusive dates), ~14-day retention.
  // Use 13 days back to stay safely within the retention window.
  const taboolaHourlyStart = addDays(today, -13);
  // Codefuel hourly: last 14 days
  const codefuelHourlyStart = addDays(today, -14);

  // 2. Taboola hourly — last 14 days in 1-day chunks.
  // Taboola dates are inclusive on both ends: start=D, end=D+1 = 48h (the max).
  for (let cursor = new Date(taboolaHourlyStart); cursor < today; cursor = addDays(cursor, 1)) {
    const chunkEnd = new Date(Math.min(addDays(cursor, 1).getTime(), today.getTime()));
    await syncTaboolaHourly({
      startDate: isoDay(cursor),
      endDate: isoDay(chunkEnd),
    });
  }

  // 3. Codefuel daily for the full historical window (startDate → today)
  await syncCodefuel({
    startDate: isoDay(start),
    endDate: isoDay(today),
    granularity: 'daily',
  });

  // 4. Codefuel hourly for the last 14 days (finer granularity overlaying daily data)
  const hourlyStart = start > codefuelHourlyStart ? start : codefuelHourlyStart;
  await syncCodefuel({
    startDate: isoDay(hourlyStart),
    endDate: isoDay(today),
    granularity: 'hourly',
  });

  // 5. Refresh the joined view
  await refreshJoinedView();

  logger.info('backfill-full: done');
}

async function main() {
  const [, , job, startDate, endDate] = process.argv;
  if (!job) {
    console.error('Usage: sync:once <job> [startDate] [endDate]');
    process.exit(1);
  }

  switch (job) {
    case 'taboola-metadata':
      await syncTaboolaMetadata();
      break;
    case 'taboola-hourly':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncTaboolaHourly({ startDate, endDate });
      break;
    case 'codefuel-hourly':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncCodefuel({ startDate, endDate, granularity: 'hourly' });
      break;
    case 'codefuel-daily':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncCodefuel({ startDate, endDate, granularity: 'daily' });
      break;
    case 'image-advantage-hourly':
      if (!startDate) throw new Error('Need date as first arg');
      await syncImageAdvantage({ date: startDate, granularity: 'hourly' });
      break;
    case 'image-advantage-daily':
      if (!startDate) throw new Error('Need date as first arg');
      await syncImageAdvantage({ date: startDate, granularity: 'daily' });
      break;
    case 'image-advantage-backfill': {
      // Single-day IA API — loop day by day over the range
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      let cursor = new Date(`${startDate}T00:00:00Z`);
      const stop  = new Date(`${endDate}T00:00:00Z`);
      while (cursor <= stop) {
        await syncImageAdvantage({ date: isoDay(cursor), granularity: 'daily' });
        cursor = addDays(cursor, 1);
      }
      break;
    }
    case 'taboola-geo':
      // Per-account daily device + country cost. Loops day-by-day internally.
      //   npm run sync:once -- taboola-geo 2026-06-01 2026-06-08
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncTaboolaGeoCost({ startDate, endDate });
      break;
    case 'outbrain-campaigns':
      // Marketers + campaigns -> outbrain_campaigns. Run before outbrain-cost.
      await syncOutbrainCampaigns();
      break;
    case 'outbrain-ads':
      // Promoted-link (gd,r) -> campaign map -> outbrain_ads.
      await syncOutbrainPromotedLinks();
      break;
    case 'outbrain-cost':
      // Per-campaign daily Outbrain cost -> outbrain_stats_daily.
      //   npm run sync:once -- outbrain-cost 2026-05-04 2026-06-16
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainCost({ from: startDate, to: endDate });
      break;
    case 'outbrain-breakdowns':
      // All three Outbrain breakdowns (ads, country, publisher) -> new tables.
      //   npm run sync:once -- outbrain-breakdowns 2026-05-04 2026-06-28
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainBreakdowns({ from: startDate, to: endDate });
      break;
    case 'outbrain-ads-breakdown':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainAds({ from: startDate, to: endDate });
      break;
    case 'outbrain-country-breakdown':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainCountry({ from: startDate, to: endDate });
      break;
    case 'outbrain-publisher-breakdown':
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainPublisher({ from: startDate, to: endDate });
      break;
    case 'outbrain-marketer-hourly':
      // Account-level hourly cost (breakdown=hourOfDay, one day at a time).
      //   npm run sync:once -- outbrain-marketer-hourly 2026-06-01 2026-07-04
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      await syncOutbrainMarketerHourly({ from: startDate, to: endDate });
      break;
    case 'xmetrics-daily':
      if (!startDate) throw new Error('Need date as first arg');
      await syncXMetricsDaily({ date: startDate });
      break;
    case 'xmetrics-backfill': {
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      let cursor = new Date(`${startDate}T00:00:00Z`);
      const stop  = new Date(`${endDate}T00:00:00Z`);
      while (cursor <= stop) {
        await syncXMetricsDaily({ date: isoDay(cursor) });
        cursor = addDays(cursor, 1);
      }
      break;
    }
    case 'ddc': {
      const d = process.argv[3] ?? isoDay(addDays(new Date(), -1));
      await syncDDC({ date: d });
      break;
    }
    // Manual send of the client's daily DDC report. Second arg overrides the
    // date (defaults to yesterday), third overrides the recipient — use that to
    // rehearse against your own address before mailing the client.
    case 'ddc-report': {
      // `ddc-report <from> <to> [recipient]` sends one file covering the range;
      // `ddc-report [date] [recipient]` sends a single day.
      const a = process.argv[3], b = process.argv[4], c = process.argv[5];
      const isDate = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
      let r;
      if (isDate(a) && isDate(b)) {
        const dates: string[] = [];
        for (let t = new Date(a + 'T00:00:00Z'); isoDay(t) <= b!; t = addDays(t, 1)) dates.push(isoDay(t));
        r = await sendDdcHourlyReport({ dates, ...(c ? { to: c } : {}) });
      } else {
        const d = isDate(a) ? a! : isoDay(addDays(new Date(), -1));
        const to = isDate(a) ? b : a;
        r = await sendDdcHourlyReport({ date: d, ...(to ? { to } : {}) });
      }
      logger.info({ ...r, csv: undefined }, 'ddc-report sent');
      break;
    }
    case 'ddc-backfill': {
      const a = process.argv[3], b = process.argv[4] ?? isoDay(new Date());
      if (!a) throw new Error('usage: ddc-backfill <from> [to]');
      const r = await syncDDCRange({ from: a, to: b });
      logger.info(r, 'ddc-backfill done');
      break;
    }
    case 'ddc-hourly': {
      const r = await syncDDCHourly();
      logger.info(r, 'ddc-hourly done');
      break;
    }
    case 'refresh-view':
      await refreshJoinedView();
      break;

    // ── Tenancy ─────────────────────────────────────────────────────────────
    case 'tenant-check': {
      // READ-ONLY. Shows what THIS deployment's rules keep and skip, against the
      // live partner APIs, so an env change can be checked before it is deployed.
      //   TENANT_ACCOUNT_EXCLUDE='^SBH_rev_|Revlogic Media' npm run sync:once -- tenant-check
      console.log(`rules: ${describeTenant()}`);
      const tb = await listAllowedAccounts();
      console.log('\nTaboola accounts:');
      for (const a of tb) console.log(`  ${accountAllowed(a.name) ? 'KEEP' : 'skip'}  ${a.type.padEnd(8)} ${a.name}`);
      const ob = await listMarketers();
      console.log('\nOutbrain marketers:');
      for (const m of ob) console.log(`  ${accountAllowed(m.name) ? 'KEEP' : 'skip'}  ${m.name}`);
      if (sourceEnabled('image_advantage')) {
        const rows = await fetchIAHourly(isoDay(addDays(new Date(), -1)));
        const affiliates = [...new Set(rows.map(r => r.affiliate))].sort();
        console.log(`\nImage Advantage affiliates seen yesterday (${affiliates.length}):`);
        for (const a of affiliates) console.log(`  ${iaAffiliateAllowed(a) ? 'KEEP' : 'skip'}  ${a}`);
      }
      console.log(`\nSources: ${['taboola','outbrain','codefuel','image_advantage','ddc'].map(s => `${s}=${sourceEnabled(s as any) ? 'on' : 'off'}`).join('  ')}`);
      break;
    }
    case 'tenant-prune': {
      // Remove ad_accounts rows that the tenant rules now exclude AND that hold
      // no data (no campaigns, no Outbrain campaigns, no cost rows). Anything
      // with data is listed but left alone — that is a decision, not a cleanup.
      // Dry-run by default; pass --apply to delete.
      //   TENANT_ACCOUNT_EXCLUDE='…' npm run sync:once -- tenant-prune [--apply]
      const apply = process.argv.includes('--apply');
      const rows = await query<{ id: number; name: string; platform: string; campaigns: string; ob_campaigns: string; stats: string }>(
        `SELECT a.id, a.name, p.code AS platform,
                (SELECT COUNT(*) FROM campaigns c WHERE c.ad_account_id = a.id)                    AS campaigns,
                (SELECT COUNT(*) FROM outbrain_campaigns oc WHERE oc.marketer_id = a.external_id) AS ob_campaigns,
                (SELECT COUNT(*) FROM ad_stats_hourly s WHERE s.ad_account_id = a.id)             AS stats
           FROM ad_accounts a JOIN platforms p ON p.id = a.platform_id
          ORDER BY p.code, a.name`,
      );
      const excluded = rows.filter(r => !accountAllowed(r.name));
      const empty = excluded.filter(r => r.campaigns === '0' && r.ob_campaigns === '0' && r.stats === '0');
      const withData = excluded.filter(r => !empty.includes(r));
      console.log(`rules: ${describeTenant()}`);
      console.log(`\n${excluded.length} account(s) excluded by the rules; ${empty.length} empty (deletable), ${withData.length} with data (left alone):`);
      for (const r of empty) console.log(`  delete  ${r.platform.padEnd(8)} ${r.name}`);
      for (const r of withData) console.log(`  KEEP    ${r.platform.padEnd(8)} ${r.name}  (campaigns=${r.campaigns} ob_campaigns=${r.ob_campaigns} stats=${r.stats})`);
      if (!apply) { console.log('\nDry run — nothing deleted. Re-run with --apply to delete the empty ones.'); break; }
      if (empty.length === 0) { console.log('\nNothing to delete.'); break; }
      const deleted = await query<{ id: number }>(`DELETE FROM ad_accounts WHERE id = ANY($1::int[]) RETURNING id`, [empty.map(r => r.id)]);
      console.log(`\nDeleted ${deleted.length} empty excluded account(s).`);
      break;
    }
    case 'daily-backfill': {
      // Same code path as the 03:00 UTC cron job: metadata + all sources,
      // last 4 days, per-step isolation, recorded in sync_runs.
      const { ok, failed } = await runDailyBackfill();
      logger.info({ ok, failed }, 'daily-backfill (manual): result');
      if (failed.length > 0) process.exitCode = 1;
      break;
    }

    // ── Auto-windowed commands (no dates required) ──────────────────────────
    case 'taboola-hourly-auto': {
      const yesterday = isoDay(addDays(new Date(), -1));
      const tod       = isoDay(new Date());
      logger.info({ yesterday, today: tod }, 'taboola-hourly-auto: syncing 2-day window');
      await syncTaboolaHourly({ startDate: yesterday, endDate: tod });
      break;
    }
    case 'codefuel-hourly-auto': {
      const yesterday = isoDay(addDays(new Date(), -1));
      const tod       = isoDay(new Date());
      logger.info({ yesterday, today: tod }, 'codefuel-hourly-auto: syncing 2-day window');
      await syncCodefuel({ startDate: yesterday, endDate: tod, granularity: 'hourly' });
      break;
    }
    case 'image-advantage-hourly-auto': {
      // IA API requires dates strictly before today — sync day-2 and day-1.
      const d2 = isoDay(addDays(new Date(), -2));
      const d1 = isoDay(addDays(new Date(), -1));
      logger.info({ d2, d1 }, 'image-advantage-hourly-auto: syncing 2 days');
      await syncImageAdvantage({ date: d2, granularity: 'hourly' });
      await syncImageAdvantage({ date: d1, granularity: 'hourly' });
      break;
    }
    case 'refresh-all': {
      // Rolling 4-day window (D-3 .. today). A 48h window left days that were
      // partial when first synced (e.g. synced mid-day, or a transient failure)
      // permanently incomplete once they aged out — which made daily totals not
      // match the providers' own reports. Re-syncing the last 4 days every run
      // self-heals partial days and picks up the providers' revenue revisions.
      logger.info('refresh-all: starting (4-day window)');
      const raStart = isoDay(addDays(new Date(), -3));
      const raEnd   = isoDay(new Date());              // today UTC
      // Taboola's hourly report rejects wide ranges — sync in 2-day sub-windows.
      for (let off = -3; off <= 0; off += 2) {
        const a = isoDay(addDays(new Date(), off));
        const b = isoDay(addDays(new Date(), Math.min(off + 1, 0)));
        await syncTaboolaHourly({ startDate: a, endDate: b });
      }
      await syncCodefuel({ startDate: raStart, endDate: raEnd, granularity: 'hourly' });
      // IA y-metrics (Yahoo): bars today — sync D-3 .. D-1.
      for (let off = -3; off <= -1; off++) {
        await syncImageAdvantage({ date: isoDay(addDays(new Date(), off)), granularity: 'hourly' });
      }
      // IA x-metrics (non-Yahoo display): also bars today — sync D-3 .. D-1.
      for (let off = -3; off <= -1; off++) {
        await syncXMetricsDaily({ date: isoDay(addDays(new Date(), off)) });
      }
      // Real device/country cost (daily) over the window.
      await syncTaboolaGeoCost({ startDate: raStart, endDate: raEnd });
      // Outbrain: refresh campaign list + per-campaign daily cost + breakdowns.
      // Revenue arrives via the Codefuel/IA syncs above (source_platform='Outbrain').
      await syncOutbrainCampaigns();
      await syncOutbrainPromotedLinks();
      await syncOutbrainCost({ from: raStart, to: raEnd });
      await syncOutbrainBreakdowns({ from: raStart, to: raEnd });
      await refreshJoinedView();
      logger.info({ window: `${raStart}..${raEnd}` }, 'refresh-all: done');
      break;
    }

    case 'sync-day': {
      // Full single-day backfill across all 3 sources + MV refresh.
      // For fully-closed numbers run on the NEXT day:
      //   npm run sync:once -- sync-day 2026-06-01
      if (!startDate) throw new Error('Need date, e.g. sync-day 2026-06-01');
      const sdStart = startDate;
      const sdEnd   = isoDay(addDays(new Date(`${startDate}T00:00:00Z`), 1));
      logger.info({ date: startDate, window: `${sdStart}→${sdEnd}` }, 'sync-day: starting');
      await syncTaboolaHourly({ startDate: sdStart, endDate: sdEnd });
      await syncCodefuel({ startDate: sdStart, endDate: sdEnd, granularity: 'hourly' });
      // IA API bars today; skip if date is today or future
      const today = isoDay(new Date());
      if (sdStart < today) {
        await syncImageAdvantage({ date: sdStart, granularity: 'hourly' });
      } else {
        logger.info({ date: sdStart }, 'sync-day: skipping IA (date is today or future)');
      }
      // Real device/country cost for the day.
      await syncTaboolaGeoCost({ startDate: sdStart, endDate: sdStart });
      await refreshJoinedView();
      logger.info({ date: startDate }, 'sync-day: done');
      break;
    }

    case 'taboola-all-hourly': {
      // Backfill any date range in 1-day (48-h inclusive) chunks — safe for Taboola API.
      if (!startDate || !endDate) throw new Error('Need startDate and endDate');
      let cursor = new Date(`${startDate}T00:00:00Z`);
      const stop   = new Date(`${endDate}T00:00:00Z`);
      while (cursor < stop) {
        const chunkEnd = addDays(cursor, 1);
        const actual   = chunkEnd < stop ? chunkEnd : stop;
        await syncTaboolaHourly({ startDate: isoDay(cursor), endDate: isoDay(actual) });
        cursor = actual;
      }
      break;
    }
    case 'backfill-full':
      if (!startDate) throw new Error('Need startDate, e.g. 2026-04-01');
      await backfillFull(startDate);
      break;
    default:
      throw new Error(`Unknown job: ${job}`);
  }

  logger.info({ job }, 'done');
  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'run-once crashed');
  process.exit(1);
});
