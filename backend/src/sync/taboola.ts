import {
  listAllowedAccounts,
  listCampaigns,
  listItems,
  fetchHourlyStats,
  fetchDailyStats,
  fetchPlatformBreakdown,
  fetchCountryBreakdown,
  fetchSiteBreakdown,
  TaboolaStatRow,
  TaboolaGeoRow,
} from '../sources/taboola/client.js';
import { extractJoinParams } from '../utils/url-params.js';
import { withTx, query } from '../db/client.js';
import { logger } from '../config/logger.js';
import { accountAllowed } from '../config/tenant.js';

const TABOOLA_PLATFORM_CODE = 'taboola';

// ---------- Metadata sync ----------

/**
 * Discover all accounts, campaigns, and ad items from the Taboola network.
 *
 * Accounts:  /users/current/allowed-accounts  (19 sub-accounts + the network itself)
 * Campaigns: /{accountId}/campaigns           (per sub-account, paginated)
 * Items:     top-campaign-content/item_breakdown on the network account
 *            (gives item URLs → extracts gd/r join keys)
 *
 * Note: items that haven't run in the last 30 days won't appear in
 * top-campaign-content. listItems() per campaign can supplement if needed later.
 */
export async function syncTaboolaMetadata(): Promise<void> {
  const platformId = await getPlatformId(TABOOLA_PLATFORM_CODE);
  const codefuelPartnerId = await getCodefuelPartnerId();

  // --- 1. Accounts ---
  // The credential sees every network it was invited to (Nadia's AND Joe's), so
  // keep only this deployment's accounts. Everything downstream — campaigns,
  // items, hourly stats, geo cost — keys off the ad_accounts/campaigns rows
  // created here, so filtering the discovery list is sufficient for Taboola.
  const allAccounts = await listAllowedAccounts();
  const accounts = allAccounts.filter(a => accountAllowed(a.name));
  if (accounts.length !== allAccounts.length) {
    logger.info(
      { kept: accounts.length, skipped: allAccounts.filter(a => !accountAllowed(a.name)).map(a => a.name) },
      'taboola metadata: tenant filter applied to accounts',
    );
  }
  logger.info({ count: accounts.length }, 'taboola metadata: accounts');

  for (const acc of accounts) {
    await query(
      `INSERT INTO ad_accounts (platform_id, external_id, name, status, currency, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform_id, external_id)
       DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
                     currency = EXCLUDED.currency, timezone = EXCLUDED.timezone`,
      [
        platformId,
        acc.account_id,
        acc.name,
        acc.is_active ? 'active' : 'inactive',
        acc.currency ?? 'USD',
        acc.time_zone_name ?? 'UTC',
      ],
    );
  }

  // --- 2. Campaigns — per account (skip the NETWORK account itself) ---
  const accountIdMap = new Map<string, number>(); // account_id → db id
  for (const acc of accounts) {
    const rows = await query<{ id: number }>(
      'SELECT id FROM ad_accounts WHERE platform_id = $1 AND external_id = $2',
      [platformId, acc.account_id],
    );
    if (rows[0]) accountIdMap.set(acc.account_id, rows[0].id);

    if (acc.type === 'NETWORK') continue; // network account has no own campaigns

    let campaigns;
    try {
      campaigns = await listCampaigns(acc.account_id);
    } catch (err: any) {
      // Retry once on timeout (some accounts are flaky)
      if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        logger.warn({ account: acc.account_id }, 'taboola metadata: campaigns timeout, retrying');
        try {
          campaigns = await listCampaigns(acc.account_id);
        } catch (err2) {
          logger.warn({ err: err2, account: acc.account_id }, 'taboola metadata: campaigns fetch failed after retry');
          continue;
        }
      } else {
        logger.warn({ err, account: acc.account_id }, 'taboola metadata: campaigns fetch failed');
        continue;
      }
    }

    const adAccountId = accountIdMap.get(acc.account_id);
    if (!adAccountId) continue;

    for (const c of campaigns) {
      await query(
        `INSERT INTO campaigns (ad_account_id, external_id, name, status, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (ad_account_id, external_id)
         DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = NOW()`,
        [adAccountId, c.id, c.name, c.status],
      );
    }
    logger.info({ account: acc.account_id, campaigns: campaigns.length }, 'taboola metadata: campaigns');
  }

  // Tag Codefuel accounts so the join view can pick them up.
  // Rule: name contains "codefuel" (case-insensitive).
  // LGA accounts must NOT be auto-tagged here — their client_partner_id is set
  // deliberately via setup scripts (e.g. tag_and_check_ia_account.ts).
  const codefuelAccountRows = await query<{ id: number }>(
    `SELECT id FROM ad_accounts WHERE platform_id = $1 AND LOWER(name) LIKE '%codefuel%'`,
    [platformId],
  );
  for (const row of codefuelAccountRows) {
    await query(
      `UPDATE ad_accounts SET client_partner_id = $1 WHERE id = $2 AND client_partner_id IS NULL`,
      [codefuelPartnerId, row.id],
    );
  }
  logger.info({ tagged: codefuelAccountRows.length }, 'taboola metadata: codefuel accounts tagged');

  // --- 3. Items (ads) — listItems per campaign for ALL accounts ---
  // Any account can link to Codefuel landing pages (gd/r params). We must scan
  // all campaigns to build the complete item→campaign mapping for the join.
  const codefuelCampaigns = await query<{
    campaign_db_id: number;
    campaign_ext_id: string;
    account_ext_id: string;
  }>(
    // Include TERMINATED so we pick up gd/r params from historical ads whose
    // revenue is still arriving in Codefuel partner_stats_hourly.
    `SELECT c.id AS campaign_db_id, c.external_id AS campaign_ext_id,
            acc.external_id AS account_ext_id
     FROM campaigns c
     JOIN ad_accounts acc ON acc.id = c.ad_account_id
     WHERE c.status IS NOT NULL`,
  );
  logger.info({ count: codefuelCampaigns.length }, 'taboola metadata: scanning Codefuel campaigns for items');

  let itemsUpserted = 0;
  let campaignsScanned = 0;

  // Process in batches of 10 concurrent requests to stay within rate limits.
  const CONCURRENCY = 10;
  for (let i = 0; i < codefuelCampaigns.length; i += CONCURRENCY) {
    const batch = codefuelCampaigns.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (c) => {
        let items;
        try {
          items = await listItems(c.account_ext_id, c.campaign_ext_id);
        } catch (err) {
          logger.warn({ campaign: c.campaign_ext_id, err }, 'taboola metadata: listItems failed, skipping');
          return;
        }
        for (const item of items) {
          const { gd, r } = extractJoinParams(item.url ?? '');
          await query(
            `INSERT INTO ads (campaign_id, external_id, title, url, gd_param, r_param, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (campaign_id, external_id)
             DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url,
                           gd_param = EXCLUDED.gd_param, r_param = EXCLUDED.r_param,
                           status = EXCLUDED.status`,
            [c.campaign_db_id, item.id, item.title, item.url, gd, r, item.status],
          );
          itemsUpserted++;
        }
        campaignsScanned++;
      }),
    );
    if ((i / CONCURRENCY) % 10 === 0) {
      logger.info({ campaignsScanned, itemsUpserted, total: codefuelCampaigns.length }, 'taboola metadata: items progress');
    }
  }
  logger.info({ campaignsScanned, itemsUpserted }, 'taboola metadata: done');
}

// ---------- Hourly stats sync ----------

/**
 * Pull campaign-level hourly stats from the Taboola network account and upsert
 * into ad_stats_hourly.
 *
 * IMPORTANT: Taboola's reporting API only exposes campaign-level hourly breakdown
 * (no item / site / country / device granularity). Stats are stored with ad_id = NULL
 * and empty strings for site/country/device. The materialized view joins these
 * campaign-level rows to Codefuel revenue via the ads table.
 */
export async function syncTaboolaHourly(opts: {
  startDate: string;
  endDate: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('taboola', 'hourly', opts.startDate, opts.endDate);
  try {
    const rows = await fetchHourlyStats(opts);
    logger.info({ count: rows.length, ...opts }, 'taboola hourly: fetched');
    const written = await upsertStatRows(rows, 'hourly');
    await finishRun(runId, 'ok', written);
    logger.info({ written }, 'taboola hourly: done');
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'taboola hourly: failed');
    throw err;
  }
}

/**
 * Pull campaign-level DAILY stats (for historical backfill beyond the hourly retention window).
 */
export async function syncTaboolaDaily(opts: {
  startDate: string;
  endDate: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('taboola', 'daily', opts.startDate, opts.endDate);
  try {
    const rows = await fetchDailyStats(opts);
    logger.info({ count: rows.length, ...opts }, 'taboola daily: fetched');
    const written = await upsertStatRows(rows, 'daily');
    await finishRun(runId, 'ok', written);
    logger.info({ written }, 'taboola daily: done');
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'taboola daily: failed');
    throw err;
  }
}

// ---------- Per-account device/country cost (daily) ----------

/** Taboola platform code -> partner_stats_hourly.device value. */
function mapPlatformToDevice(platform?: string): string {
  switch ((platform || '').toUpperCase()) {
    case 'DESK': return 'desktop';
    case 'PHON': return 'mobile';
    case 'TBLT': return 'tablet';
    default:     return 'other';
  }
}

/** Inclusive list of 'YYYY-MM-DD' dates between start and end. */
function eachDay(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  const d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Pull real per-account, per-day DEVICE and COUNTRY cost from Taboola's
 * platform_breakdown / country_breakdown reports and store in
 * taboola_geo_cost_daily. This is the cost data the Device and Country report
 * tabs need — Taboola's hourly report has no geo split, so these single-dimension
 * daily rollups are the only source. One API call per (account, day, dimension).
 */
export async function syncTaboolaGeoCost(opts: {
  startDate: string;
  endDate: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('taboola', 'geo-cost', opts.startDate, opts.endDate);
  try {
    const platformId = await getPlatformId(TABOOLA_PLATFORM_CODE);
    // Map Taboola advertiser account_id (external_id) -> our ad_account db id.
    // Skip the NETWORK parent account (its breakdown = sum of all children;
    // including it would double-count). PARTNER sub-accounts only.
    //
    // Only fetch (account, day) pairs that actually have spend in
    // ad_stats_hourly — a day with zero spend has all-zero breakdown rows,
    // which the upsert skips anyway. This cuts the API calls by >90%
    // (e.g. 90 real pairs vs 18 accounts x 73 days = 1,314).
    const pairRows = await query<{ id: number; external_id: string; day: string }>(
      `SELECT a.id, a.external_id, to_char(s.hour_utc::date, 'YYYY-MM-DD') AS day
       FROM ad_accounts a
       JOIN ad_stats_hourly s ON s.ad_account_id = a.id
       WHERE a.platform_id = $1 AND a.external_id NOT LIKE '%-network'
         AND s.hour_utc::date >= $2::date AND s.hour_utc::date <= $3::date
         AND s.spent > 0
       GROUP BY a.id, a.external_id, s.hour_utc::date`,
      [platformId, opts.startDate, opts.endDate],
    );

    let written = 0;
    const CONCURRENCY = 4;
    const queue = [...pairRows];
    const worker = async () => {
      for (;;) {
        const pair = queue.shift();
        if (!pair) return;
        const acc = { id: pair.id, external_id: pair.external_id };
        const day = pair.day;
        // Fetch all three breakdowns for this (account, day) in parallel.
        const grab = async (kind: string, fn: () => Promise<TaboolaGeoRow[]>) => {
          try { return await fn(); } catch (e: any) {
            logger.warn({ acc: acc.external_id, day, err: e.message }, `geo-cost: ${kind} fetch failed`);
            return [] as TaboolaGeoRow[];
          }
        };
        const [plat, ctry, sites] = await Promise.all([
          grab('platform', () => fetchPlatformBreakdown(acc.external_id, { startDate: day, endDate: day })),
          grab('country',  () => fetchCountryBreakdown(acc.external_id,  { startDate: day, endDate: day })),
          grab('site',     () => fetchSiteBreakdown(acc.external_id,     { startDate: day, endDate: day })),
        ]);
        // Aggregate by mapped device (PHON/OTHR can both map to distinct buckets,
        // but two source codes never collide here; still SUM defensively).
        const devAgg = new Map<string, { imp: number; clk: number; conv: number; spent: number }>();
        for (const r of plat) {
          const dev = mapPlatformToDevice(r.platform);
          const cur = devAgg.get(dev) ?? { imp: 0, clk: 0, conv: 0, spent: 0 };
          cur.imp += r.impressions ?? 0;
          cur.clk += r.clicks ?? 0;
          cur.conv += r.cpa_actions_num ?? 0;
          cur.spent += r.spent ?? 0;
          devAgg.set(dev, cur);
        }

        const upsertSql = `INSERT INTO taboola_geo_cost_daily
             (ad_account_id, stat_date, dim_type, dim_value, impressions, clicks, conversions, spent, dim_id, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (ad_account_id, stat_date, dim_type, dim_value)
           DO UPDATE SET impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
                         conversions=EXCLUDED.conversions, spent=EXCLUDED.spent,
                         dim_id=COALESCE(EXCLUDED.dim_id, taboola_geo_cost_daily.dim_id),
                         updated_at=NOW()`;

        const upsertPair = () => withTx(async (client) => {
          let n = 0;
          for (const [dev, v] of devAgg) {
            if (v.imp === 0 && v.clk === 0 && v.spent === 0) continue;
            await client.query(upsertSql, [acc.id, day, 'device', dev, v.imp, v.clk, v.conv, v.spent, null]);
            n++;
          }
          for (const r of ctry) {
            const code = (r.country || '').toUpperCase();
            if (!code) continue;
            if ((r.impressions ?? 0) === 0 && (r.clicks ?? 0) === 0 && (r.spent ?? 0) === 0) continue;
            await client.query(upsertSql,
              [acc.id, day, 'country', code, r.impressions ?? 0, r.clicks ?? 0, r.cpa_actions_num ?? 0, r.spent ?? 0, null]);
            n++;
          }
          for (const r of sites) {
            // Prefer the human-readable name; fall back to the site code.
            const site = (r.site_name || r.site || '').trim();
            if (!site) continue;
            if ((r.impressions ?? 0) === 0 && (r.clicks ?? 0) === 0 && (r.spent ?? 0) === 0) continue;
            // dim_id = Taboola site_id; joins IA revenue (item_ext_id = site_id).
            const siteId = r.site_id != null ? String(r.site_id) : null;
            await client.query(upsertSql,
              [acc.id, day, 'site', site, r.impressions ?? 0, r.clicks ?? 0, r.cpa_actions_num ?? 0, r.spent ?? 0, siteId]);
            n++;
          }
          return n;
        });
        // The transaction is per-pair and the whole job is idempotent, so a
        // dropped connection costs one retry, not the entire run.
        try {
          written += await upsertPair();
        } catch (e: any) {
          logger.warn({ acc: acc.external_id, day, err: e.message }, 'geo-cost: upsert failed, retrying once');
          try {
            written += await upsertPair();
          } catch (e2: any) {
            logger.warn({ acc: acc.external_id, day, err: e2.message }, 'geo-cost: upsert failed twice, pair skipped');
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    await finishRun(runId, 'ok', written);
    logger.info({ written, pairs: pairRows.length }, 'taboola geo-cost: done');
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'taboola geo-cost: failed');
    throw err;
  }
}

// ---------- Materialized view refresh ----------

export async function refreshJoinedView(): Promise<void> {
  await query('REFRESH MATERIALIZED VIEW joined_stats_hourly');
}

// ---------- Helpers ----------

async function upsertStatRows(
  rows: TaboolaStatRow[],
  granularity: 'hourly' | 'daily',
): Promise<number> {
  if (rows.length === 0) return 0;

  const platformId = await getPlatformId(TABOOLA_PLATFORM_CODE);
  const accountRows = await query<{ id: number; external_id: string }>(
    'SELECT id, external_id FROM ad_accounts WHERE platform_id = $1',
    [platformId],
  );

  const campaignMap = await loadCampaignMap(accountRows.map((r) => r.id));

  // Build account map (we need ad_account_id for each campaign)
  const campaignToAccount = new Map<number, number>(); // campaign db id → account db id
  const campAccountRows = await query<{ id: number; ad_account_id: number }>(
    `SELECT id, ad_account_id FROM campaigns WHERE ad_account_id = ANY($1)`,
    [accountRows.map((r) => r.id)],
  );
  for (const r of campAccountRows) campaignToAccount.set(r.id, r.ad_account_id);

  // Build parameter tuples, deduplicated by conflict key (last write wins —
  // matches the per-row DO UPDATE). country/device/site are always '' here, so
  // the conflict key reduces to (ad_account_id, campaign_id, hour_utc).
  // 7 params per row (the rest are literals: ad_id NULL, country/device/site '').
  const tuples = new Map<string, any[]>();
  for (const row of rows) {
    const campaignDbId = campaignMap.get(row.campaign);
    if (!campaignDbId) continue; // unknown campaign, metadata not synced yet
    const adAccountId = campaignToAccount.get(campaignDbId);
    if (!adAccountId) continue;
    const hourUtc = parseTaboolaDate(row.date);
    tuples.set(`${adAccountId}|${campaignDbId}|${hourUtc}`, [
      adAccountId,
      campaignDbId,
      hourUtc,
      // visible_impressions (IAB-viewable, matches Taboola UI); fall back to total.
      row.visible_impressions ?? row.impressions ?? 0,
      row.clicks ?? 0,
      row.spent ?? 0,
      row.cpa_actions_num ?? 0,
    ]);
  }

  // Chunked multi-row upsert: one INSERT per CHUNK rows instead of per row —
  // the row-by-row version was I/O-bound and stalled / hit statement timeouts on
  // the Supabase pooler (same fix as the Image Advantage bulk upsert). 7 cols + NOW().
  const list = [...tuples.values()];
  const CHUNK = 500;
  await withTx(async (client) => {
    for (let i = 0; i < list.length; i += CHUNK) {
      const slice = list.slice(i, i + CHUNK);
      const values = slice.map((_, j) => {
        const b = j * 7;
        return `($${b + 1},$${b + 2},NULL,$${b + 3},''::text,''::text,''::text,$${b + 4},$${b + 5},$${b + 6},$${b + 7},NOW())`;
      }).join(',');
      await client.query(
        `INSERT INTO ad_stats_hourly
           (ad_account_id, campaign_id, ad_id, hour_utc, country, device, site,
            impressions, clicks, spent, conversions, fetched_at)
         VALUES ${values}
         ON CONFLICT (ad_account_id, campaign_id, hour_utc, country, device, site)
         WHERE ad_id IS NULL
         DO UPDATE SET
           impressions = EXCLUDED.impressions,
           clicks      = EXCLUDED.clicks,
           spent       = EXCLUDED.spent,
           conversions = EXCLUDED.conversions,
           fetched_at  = NOW()`,
        slice.flat(),
      );
    }
  });
  return list.length;
}

/**
 * Taboola date format: 'YYYY-MM-DD HH:00:00.0' (hour breakdown)
 * or 'YYYY-MM-DD 00:00:00.0' (day breakdown).
 * Both are UTC (Taboola uses GMT = UTC, confirmed with Nadia).
 */
function parseTaboolaDate(dateStr: string): string {
  // Replace the trailing '.0' and treat as UTC
  return dateStr.replace(/\.0$/, '').replace(' ', 'T') + 'Z';
}

async function loadCampaignMap(accountIds: number[]): Promise<Map<string, number>> {
  if (accountIds.length === 0) return new Map();
  const rows = await query<{ external_id: string; id: number }>(
    `SELECT external_id, id FROM campaigns WHERE ad_account_id = ANY($1)`,
    [accountIds],
  );
  return new Map(rows.map((r) => [r.external_id, r.id]));
}

async function getPlatformId(code: string): Promise<number> {
  const rows = await query<{ id: number }>('SELECT id FROM platforms WHERE code = $1', [code]);
  if (!rows[0]) throw new Error(`Unknown platform: ${code}`);
  return rows[0].id;
}

async function getCodefuelPartnerId(): Promise<number> {
  const rows = await query<{ id: number }>(
    'SELECT id FROM client_partners WHERE code = $1',
    ['codefuel'],
  );
  if (!rows[0]) throw new Error('client_partners row for codefuel not found');
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

async function finishRun(id: number, status: 'ok' | 'error', rowsWritten: number, errMsg?: string) {
  await query(
    `UPDATE sync_runs SET finished_at=NOW(), status=$1, rows_written=$2, error=$3 WHERE id=$4`,
    [status, rowsWritten, errMsg ?? null, id],
  );
}
