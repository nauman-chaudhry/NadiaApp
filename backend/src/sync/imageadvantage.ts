import {
  fetchIAHourly,
  fetchIADaily,
  fetchIAXByUsertag,
  resetIAToken,
  IA_TB_AFFILIATES,
  IARow,
  IAXUsertagRow,
} from '../sources/imageadvantage/client.js';
import { withTx, query } from '../db/client.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { iaAffiliateAllowed } from '../config/tenant.js';

const IA_PARTNER_CODE = 'image_advantage';

/**
 * Keep only this deployment's affiliates. IA's y-metrics feed is fetched
 * UNFILTERED (so new affiliates auto-appear), which means it carries every
 * client's affiliates. Without this, another tenant's revenue would resolve to
 * no campaign here and land in the "(Unattributed revenue — Image Advantage)"
 * row — silently inflating this dashboard. Unset rules = keep everything.
 */
/**
 * Affiliates to request from the per-affiliate x-metrics endpoint for a day:
 * historical list ∪ IA_X_AFFILIATES ∪ `.tb` affiliates seen in that day's
 * (unfiltered) y-metrics daily feed — then this deployment's tenant rule.
 */
async function xMetricsAffiliates(date: string): Promise<string[]> {
  const fromEnv = (env.IA_X_AFFILIATES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let discovered: string[] = [];
  try {
    const rows = await fetchIADaily(date);
    discovered = [...new Set(rows.map(r => r.affiliate))].filter(a => /\.tb(-\d+)?$/i.test(a));
  } catch (e: any) {
    logger.warn({ err: e.message, date }, 'x-metrics: could not discover affiliates from y-metrics; using configured list');
  }
  const all = [...new Set([...IA_TB_AFFILIATES, ...fromEnv, ...discovered])];
  return all.filter(a => iaAffiliateAllowed(a)).sort();
}

function tenantRows<T extends { affiliate: string }>(rows: T[], ctx: Record<string, unknown>): T[] {
  const kept = rows.filter(r => iaAffiliateAllowed(r.affiliate));
  if (kept.length !== rows.length) {
    const skipped = [...new Set(rows.filter(r => !iaAffiliateAllowed(r.affiliate)).map(r => r.affiliate))];
    logger.info({ ...ctx, kept: kept.length, dropped: rows.length - kept.length, skippedAffiliates: skipped },
      'image_advantage: tenant filter applied to affiliates');
  }
  return kept;
}

type Granularity = 'hourly' | 'daily';

// Returns {campaignExtId, itemExtId} when user_tag is a valid attribution key.
// Returns null for placeholder tags ("ut", "campaign_id.site_id.site" template, etc.)
// — these rows are written as unattributed instead of being dropped.
//
// Taboola (.tb) user_tag is NUMERIC: '49396874.1376870.slug' -> campaign 49396874.
// Outbrain (.ob) user_tag is HEX:     '0059722...c5.0062811...639' -> the first
//   segment is the Outbrain campaign_id (matches outbrain_campaigns.campaign_id).
// We keep the numeric parser untouched (don't risk regressing Taboola) and add a
// parallel hex parser, selected per-row by the affiliate suffix.
function parseUserTag(tag: string): { campaignExtId: string; itemExtId: string } | null {
  const parts = tag.split('.');
  if (parts.length < 2) return null;
  const [campaignId, itemId] = parts;
  if (!/^\d+$/.test(campaignId) || !/^\d+$/.test(itemId)) return null;
  return { campaignExtId: campaignId, itemExtId: itemId };
}

function parseUserTagOb(tag: string): { campaignExtId: string; itemExtId: string } | null {
  const parts = tag.split('.');
  if (parts.length < 2) return null;
  const [campaignId, itemId] = parts;
  // Outbrain campaign ids are long lowercase-hex strings (e.g. 34 chars, '00…').
  if (!/^[0-9a-f]{16,}$/i.test(campaignId) || !itemId) return null;
  return { campaignExtId: campaignId, itemExtId: itemId };
}

// Affiliate suffix → platform. Suffixes may carry an instance number for
// additional accounts (e.g. ssm.n2s.pro.tb-2 = Yahoo-SSM1's Taboola affiliate),
// so match '.tb' / '.ob' with an optional '-N'.
function affiliatePlatform(affiliate: string): 'tb' | 'ob' | '' {
  if (/\.ob(-\d+)?$/.test(affiliate)) return 'ob';
  if (/\.tb(-\d+)?$/.test(affiliate)) return 'tb';
  return '';
}

// Pick the right parser for a row based on its affiliate (.ob -> hex, else numeric).
function parseTagForRow(row: IARow): { campaignExtId: string; itemExtId: string } | null {
  return affiliatePlatform(row.affiliate) === 'ob' ? parseUserTagOb(row.user_tag) : parseUserTag(row.user_tag);
}

/**
 * Pull one day of Image Advantage stats and upsert into partner_stats_hourly.
 * Idempotent — re-running for the same date overwrites with latest numbers.
 *
 * Attributed rows  → keyed on (campaign_ext_id, item_ext_id) — join via campaigns table.
 * Unattributed rows → keyed on (affiliate, user_tag) using the asset_gid/channel columns;
 *                    they surface in the MV under "(Unattributed revenue)" like Codefuel.
 *
 * Granularity:
 *   - 'hourly' — fetches /y-metrics/revenue/hourly/by-affiliate (rows have y_time)
 *   - 'daily'  — fetches /y-metrics/revenue/daily/by-affiliate  (no y_time, pinned to 00:00)
 *
 * @param date   'YYYY-MM-DD'
 */
export async function syncImageAdvantage(opts: {
  date: string;
  granularity: Granularity;
}): Promise<{ rowsWritten: number; rowsUnattributed: number }> {
  resetIAToken();

  const runId = await startRun('image_advantage', opts.granularity, opts.date, opts.date);

  try {
    const rawRows = tenantRows(
      opts.granularity === 'hourly' ? await fetchIAHourly(opts.date) : await fetchIADaily(opts.date),
      { date: opts.date, granularity: opts.granularity },
    );

    const rows = deduplicateCampaignVsItem(rawRows, opts.granularity);
    const droppedCount = rawRows.length - rows.length;
    if (droppedCount > 0) {
      logger.warn({ dropped: droppedCount, ...opts }, 'image_advantage: dropped campaign-level rows (item-level data present for same campaign+hour)');
    }

    logger.info({ count: rows.length, rawCount: rawRows.length, ...opts }, 'image_advantage: fetched');

    if (rows.length === 0) {
      await finishRun(runId, 'ok', 0);
      return { rowsWritten: 0, rowsUnattributed: 0 };
    }

    const partnerId = await getPartnerId(IA_PARTNER_CODE);
    // Build parameter tuples, deduplicated by conflict key (last write wins —
    // matches the per-row DO UPDATE behaviour) so a chunked multi-row upsert
    // never hits "cannot affect row a second time". 14 values per row (+ NOW()).
    const attr = new Map<string, any[]>();
    const unattr = new Map<string, any[]>();
    for (const row of rows) {
      const parsed = parseTagForRow(row);
      const hourUtc = buildHourUtc(row, opts.granularity);
      const platformTag = affiliatePlatform(row.affiliate);
      const sourcePlatform = platformTag === 'ob' ? 'Outbrain' : platformTag === 'tb' ? 'Taboola' : null;
      const clicks = row.bidded_clicks ?? 0;
      const ses = row.bidded_searches ?? 0;   // bidded_searches = sessions equivalent
      const rev = row.partner_rev_share ?? 0;
      if (parsed) {
        const campExt = platformTag ? `${platformTag}:${parsed.campaignExtId}` : parsed.campaignExtId;
        attr.set(`${campExt}${parsed.itemExtId}${hourUtc}`,
          [partnerId, opts.granularity, campExt, parsed.itemExtId, hourUtc, '', '', clicks, ses, rev, 0, 0, 0, sourcePlatform]);
      } else {
        unattr.set(`${row.affiliate}${row.user_tag}${hourUtc}${sourcePlatform}`,
          [partnerId, opts.granularity, row.affiliate, row.user_tag, hourUtc, '', '', clicks, ses, rev, 0, 0, 0, sourcePlatform]);
      }
    }
    const written = attr.size;
    const unattributed = unattr.size;

    const ATTR_COLS = '(client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)';
    const ATTR_TAIL = `ON CONFLICT (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device) WHERE campaign_ext_id IS NOT NULL
      DO UPDATE SET ad_clicks=EXCLUDED.ad_clicks, sessions=EXCLUDED.sessions, revenue=EXCLUDED.revenue, source_platform=EXCLUDED.source_platform, fetched_at=NOW()`;
    const UNATTR_COLS = '(client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)';
    const UNATTR_TAIL = `ON CONFLICT (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform) WHERE campaign_ext_id IS NULL
      DO UPDATE SET ad_clicks=EXCLUDED.ad_clicks, sessions=EXCLUDED.sessions, revenue=EXCLUDED.revenue, source_platform=EXCLUDED.source_platform, fetched_at=NOW()`;

    await withTx(async (client) => {
      await bulkUpsert(client, ATTR_COLS, ATTR_TAIL, [...attr.values()]);
      await bulkUpsert(client, UNATTR_COLS, UNATTR_TAIL, [...unattr.values()]);
    });

    const totalWritten = written + unattributed;
    await finishRun(runId, 'ok', totalWritten);
    logger.info({ written, unattributed, ...opts }, 'image_advantage: upsert done');
    return { rowsWritten: written, rowsUnattributed: unattributed };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'image_advantage: failed');
    throw err;
  }
}

// ---------- helpers ----------

// Chunked multi-row upsert: one INSERT per CHUNK rows instead of per row, which
// turns thousands of remote round-trips into a handful (the row-by-row version
// was I/O-bound and stalled on the Supabase pooler). 14 columns per row + NOW().
async function bulkUpsert(
  client: { query: (sql: string, params: any[]) => Promise<unknown> },
  cols: string,
  tail: string,
  tuples: any[][],
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const slice = tuples.slice(i, i + CHUNK);
    const values = slice.map((_, j) => {
      const b = j * 14;
      const ph = Array.from({ length: 14 }, (_, k) => `$${b + k + 1}`).join(',');
      return `(${ph},NOW())`;
    }).join(',');
    await client.query(`INSERT INTO partner_stats_hourly ${cols} VALUES ${values} ${tail}`, slice.flat());
  }
}

/**
 * Drop campaign-level aggregate rows (itemExtId = '0') for any (campaign, hour)
 * that already has item-level rows (itemExtId ≠ '0').
 * Applied before upsert to prevent double-counting when IA delivers both
 * campaign-level and ad-level tracking simultaneously.
 */
function deduplicateCampaignVsItem(rows: IARow[], granularity: Granularity): IARow[] {
  // First pass: collect (campaignExtId, hourUtc) keys that have item-level data
  const hasItemLevel = new Set<string>();
  for (const row of rows) {
    const parsed = parseTagForRow(row);
    if (!parsed || parsed.itemExtId === '0') continue;
    hasItemLevel.add(`${parsed.campaignExtId}:${buildHourUtc(row, granularity)}`);
  }
  if (hasItemLevel.size === 0) return rows; // fast path: nothing to deduplicate

  // Second pass: filter out campaign-level rows where item-level data exists
  return rows.filter(row => {
    const parsed = parseTagForRow(row);
    if (!parsed || parsed.itemExtId !== '0') return true;
    return !hasItemLevel.has(`${parsed.campaignExtId}:${buildHourUtc(row, granularity)}`);
  });
}

function buildHourUtc(row: IARow, granularity: Granularity): string {
  if (granularity === 'hourly') {
    const hh = String(row.y_time ?? 0).padStart(2, '0');
    return `${row.y_date}T${hh}:00:00.000Z`;
  }
  return `${row.y_date}T00:00:00.000Z`;
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

// =============================================================================
// x-metrics sync (non-Yahoo display revenue)
// =============================================================================

/**
 * Pull one day of x-metrics (non-Yahoo display) stats and upsert into
 * partner_stats_hourly as granularity='x-daily' rows, attributed PER CAMPAIGN
 * via the by-usertag endpoint (same numeric user_tag join as y-metrics).
 *
 * Storage (attributed rows — the common case):
 *   granularity     = 'x-daily'        — exempt from hourly-wins de-dup in MV
 *   campaign_ext_id = 'tb:<campaign>'  — joins to campaigns.external_id in the MV
 *   item_ext_id     = <item>           — Taboola site/item id
 *   source_platform = 'Taboola'        — all x-metrics affiliates are .tb
 *   ad_clicks = x-metrics clicks, sessions = 0, hour_utc = day start UTC
 *
 * Storage (unattributed rows — placeholder/empty user_tag):
 *   asset_gid = affiliate, channel = user_tag, campaign_ext_id = NULL.
 *
 * Attributed rows whose campaign resolves surface as named campaign rows on the
 * dashboard (ia_attributed in the MV); unresolved ones fall to the IA orphan
 * bucket — no revenue is lost either way. Using by-usertag (not the affiliate
 * -level /daily endpoint) is what lets the flux campaigns appear individually.
 */
export async function syncXMetricsDaily(opts: {
  date: string;
}): Promise<{ rowsWritten: number; rowsUnattributed: number }> {
  resetIAToken();
  const runId = await startRun('image_advantage_x', 'x-daily', opts.date, opts.date);

  try {
    // x-metrics has no unfiltered endpoint: it must be asked per affiliate. The
    // list used to be hardcoded to Nadia's nine `ssm.*.tb` names, so a second
    // tenant's Flux revenue was never requested (review 2026-09-24, finding 3).
    // Now: the historical list ∪ IA_X_AFFILIATES ∪ every `.tb` affiliate that
    // appears in the same day's y-metrics feed (which IS unfiltered, so new
    // affiliates surface there first), then the tenant rule. Requesting an
    // affiliate that has no x-metrics simply returns no rows.
    const affiliates = await xMetricsAffiliates(opts.date);
    logger.info({ date: opts.date, affiliates }, 'x-metrics: affiliates to request');
    const rawRows = tenantRows(await fetchIAXByUsertag(opts.date, affiliates), { date: opts.date, granularity: 'x-daily' });
    // Reuse the same campaign-vs-item de-dup as y-metrics (drop campaign-level
    // aggregate rows when item-level data exists for the same campaign).
    const xRows = deduplicateXCampaignVsItem(rawRows, opts.date);
    logger.info({ count: xRows.length, rawCount: rawRows.length, date: opts.date }, 'x-metrics: fetched');

    if (xRows.length === 0) {
      await finishRun(runId, 'ok', 0);
      return { rowsWritten: 0, rowsUnattributed: 0 };
    }

    const partnerId = await getPartnerId(IA_PARTNER_CODE);
    const hourUtc = `${opts.date}T00:00:00.000Z`;
    // .tb affiliates are numeric user_tags → reuse parseUserTag.
    const attr = new Map<string, any[]>();
    const unattr = new Map<string, any[]>();
    for (const row of xRows) {
      const parsed = parseUserTag(row.user_tag ?? '');
      const sourcePlatform = affiliatePlatform(row.affiliate) === 'tb' ? 'Taboola' : null;
      const clicks = row.clicks ?? 0;
      const rev = row.partner_rev_share ?? 0;
      if (parsed) {
        const campExt = `tb:${parsed.campaignExtId}`;
        attr.set(`${campExt}${parsed.itemExtId}${hourUtc}`,
          [partnerId, 'x-daily', campExt, parsed.itemExtId, hourUtc, '', '', clicks, 0, rev, 0, 0, 0, sourcePlatform]);
      } else {
        unattr.set(`${row.affiliate}${row.user_tag}${hourUtc}${sourcePlatform}`,
          [partnerId, 'x-daily', row.affiliate, row.user_tag || 'x-metrics', hourUtc, '', '', clicks, 0, rev, 0, 0, 0, sourcePlatform]);
      }
    }

    const ATTR_COLS = '(client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)';
    const ATTR_TAIL = `ON CONFLICT (client_partner_id, granularity, campaign_ext_id, item_ext_id, hour_utc, country, device) WHERE campaign_ext_id IS NOT NULL
      DO UPDATE SET ad_clicks=EXCLUDED.ad_clicks, sessions=EXCLUDED.sessions, revenue=EXCLUDED.revenue, source_platform=EXCLUDED.source_platform, fetched_at=NOW()`;
    const UNATTR_COLS = '(client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, ad_clicks, sessions, revenue, rpc, rpm, ctr_pct, source_platform, fetched_at)';
    const UNATTR_TAIL = `ON CONFLICT (client_partner_id, granularity, asset_gid, channel, hour_utc, country, device, source_platform) WHERE campaign_ext_id IS NULL
      DO UPDATE SET ad_clicks=EXCLUDED.ad_clicks, sessions=EXCLUDED.sessions, revenue=EXCLUDED.revenue, source_platform=EXCLUDED.source_platform, fetched_at=NOW()`;

    await withTx(async (client) => {
      await bulkUpsert(client, ATTR_COLS, ATTR_TAIL, [...attr.values()]);
      await bulkUpsert(client, UNATTR_COLS, UNATTR_TAIL, [...unattr.values()]);
    });

    const written = attr.size;
    const unattributed = unattr.size;
    await finishRun(runId, 'ok', written + unattributed);
    logger.info({ written, unattributed, date: opts.date }, 'x-metrics: upsert done');
    return { rowsWritten: written, rowsUnattributed: unattributed };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'x-metrics: failed');
    throw err;
  }
}

// Drop campaign-level x-metrics rows (item '0') when item-level data exists for
// the same campaign+day — mirrors deduplicateCampaignVsItem for y-metrics.
function deduplicateXCampaignVsItem(rows: IAXUsertagRow[], date: string): IAXUsertagRow[] {
  const hasItemLevel = new Set<string>();
  for (const row of rows) {
    const parsed = parseUserTag(row.user_tag ?? '');
    if (!parsed || parsed.itemExtId === '0') continue;
    hasItemLevel.add(parsed.campaignExtId);
  }
  if (hasItemLevel.size === 0) return rows;
  return rows.filter(row => {
    const parsed = parseUserTag(row.user_tag ?? '');
    if (!parsed || parsed.itemExtId !== '0') return true;
    return !hasItemLevel.has(parsed.campaignExtId);
  });
}
