import {
  getAccount,
  listCampaigns,
  listAds,
  fetchCampaignHourly,
  MetaHourlyRow,
} from '../sources/meta/client.js';
import { withTx, query } from '../db/client.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { accountAllowed, defaultPartnerCode } from '../config/tenant.js';

/**
 * Meta (Facebook) cost → the SAME core tables Taboola uses:
 *   ad_accounts (platform 'facebook') → campaigns → ads, and campaign-level
 *   hourly cost in ad_stats_hourly (ad_id NULL, like Taboola).
 *
 * Why the Taboola tables and not a separate meta_* set: Image Advantage reports
 * Meta revenue with campaign_ext_id = the Meta CAMPAIGN id and item_ext_id = the
 * Meta AD id, unprefixed, source_platform NULL — i.e. exactly the shape of its
 * Taboola rows. The MV's ia_attributed CTE already resolves campaign_ext_id
 * against campaigns.external_id, and `cost` reads ad_stats_hourly, so storing
 * Meta here joins Meta spend to IA's Meta revenue with NO MV change.
 * Measured 2026-11-19: 100% of IA's attributed Meta revenue since 1 Sep
 * ($1,012.45) carries a real Meta campaign id + ad id.
 *
 * Accounts come from META_AD_ACCOUNT_IDS (a system-user token sees only what it
 * was assigned, but the list is still explicit per deployment).
 */

const META_PLATFORM_CODE = 'facebook';

export function metaAccountIds(): string[] {
  return (env.META_AD_ACCOUNT_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .map(s => (s.startsWith('act_') ? s : `act_${s}`));
}

// ---------- Metadata ----------

/** Upsert the account(s), their campaigns and ads. Cheap (a few calls), so the hourly job runs it every time. */
export async function syncMetaMetadata(): Promise<void> {
  const platformId = await getPlatformId(META_PLATFORM_CODE);
  for (const accountId of metaAccountIds()) {
    const acc = await getAccount(accountId);
    if (!accountAllowed(acc.name, acc.id)) {
      logger.info({ account: acc.id, name: acc.name }, 'meta metadata: account excluded by tenant rules');
      continue;
    }
    // client_partner_id only on first insert (TENANT_DEFAULT_PARTNER); manual tags are never overwritten.
    const [row] = await query<{ id: number }>(
      `INSERT INTO ad_accounts (platform_id, external_id, name, status, currency, timezone, client_partner_id)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT id FROM client_partners WHERE code = $7))
       ON CONFLICT (platform_id, external_id)
       DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status,
                     currency = EXCLUDED.currency, timezone = EXCLUDED.timezone
       RETURNING id`,
      [platformId, acc.id, acc.name, acc.account_status === 1 ? 'active' : 'inactive',
       acc.currency, acc.timezone_name, defaultPartnerCode],
    );
    const adAccountId = row.id;

    const campaigns = await listCampaigns(acc.id);
    const ads = await listAds(acc.id);

    await withTx(async (client) => {
      for (const c of campaigns) {
        await client.query(
          `INSERT INTO campaigns (ad_account_id, external_id, name, status, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (ad_account_id, external_id)
           DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = NOW()`,
          [adAccountId, c.id, c.name, c.effective_status.toLowerCase()],
        );
      }
      const campRows = await client.query<{ id: number; external_id: string }>(
        'SELECT id, external_id FROM campaigns WHERE ad_account_id = $1', [adAccountId]);
      const campMap = new Map(campRows.rows.map(r => [r.external_id, r.id]));
      for (const a of ads) {
        const campaignDbId = campMap.get(a.campaign_id);
        if (!campaignDbId) continue;
        await client.query(
          `INSERT INTO ads (campaign_id, external_id, title, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (campaign_id, external_id)
           DO UPDATE SET title = EXCLUDED.title, status = EXCLUDED.status`,
          [campaignDbId, a.id, a.name, a.effective_status.toLowerCase()],
        );
      }
    });
    logger.info({ account: acc.id, campaigns: campaigns.length, ads: ads.length }, 'meta metadata: synced');
  }
}

// ---------- Hourly cost ----------

/**
 * Campaign-level hourly cost for [startDate, endDate] (advertiser-timezone dates).
 *
 * Replace, not upsert: for each account the window's rows are deleted and
 * re-inserted in one transaction. Meta omits hours with no delivery, so an
 * upsert could never zero an hour Meta later restated to nothing; replacing
 * makes the stored window equal Meta's answer exactly.
 */
export async function syncMetaHourly(opts: { startDate: string; endDate: string }): Promise<void> {
  const runId = await startRun('meta', 'hourly', opts.startDate, opts.endDate);
  let written = 0;
  try {
    const platformId = await getPlatformId(META_PLATFORM_CODE);
    for (const accountId of metaAccountIds()) {
      const accRows = await query<{ id: number; timezone: string }>(
        'SELECT id, timezone FROM ad_accounts WHERE platform_id = $1 AND external_id = $2',
        [platformId, accountId]);
      if (!accRows[0]) {
        logger.warn({ account: accountId }, 'meta hourly: account not registered yet (run meta metadata first) — skipped');
        continue;
      }
      const { id: adAccountId, timezone } = accRows[0];
      const campRows = await query<{ id: number; external_id: string }>(
        'SELECT id, external_id FROM campaigns WHERE ad_account_id = $1', [adAccountId]);
      const campMap = new Map(campRows.map(r => [r.external_id, r.id]));

      const rows = await fetchCampaignHourly(accountId, opts.startDate, opts.endDate);
      // In-memory dedup on the conflict key (campaign, hour) — mandatory before a bulk insert.
      const tuples = new Map<string, any[]>();
      let unknown = 0;
      for (const r of rows) {
        const campaignDbId = campMap.get(r.campaign_id);
        if (!campaignDbId) { unknown++; continue; }
        const hourUtc = toUtcHour(r, timezone);
        const prev = tuples.get(`${campaignDbId}|${hourUtc}`);
        const imp = Number(r.impressions ?? 0), clk = Number(r.inline_link_clicks ?? 0), sp = Number(r.spend ?? 0);
        if (prev) { prev[3] += imp; prev[4] += clk; prev[5] += sp; }
        else tuples.set(`${campaignDbId}|${hourUtc}`, [adAccountId, campaignDbId, hourUtc, imp, clk, sp]);
      }
      if (unknown) logger.warn({ account: accountId, rows: unknown }, 'meta hourly: rows for campaigns not in metadata — skipped');

      // Delete exactly the UTC span the advertiser-timezone dates cover.
      const spanStart = localMidnightUtc(opts.startDate, timezone);
      const spanEnd = localMidnightUtc(addDays(opts.endDate, 1), timezone);
      const list = [...tuples.values()];
      await withTx(async (client) => {
        await client.query(
          `DELETE FROM ad_stats_hourly
            WHERE ad_account_id = $1 AND ad_id IS NULL AND hour_utc >= $2 AND hour_utc < $3`,
          [adAccountId, spanStart, spanEnd]);
        const CHUNK = 500;
        for (let i = 0; i < list.length; i += CHUNK) {
          const slice = list.slice(i, i + CHUNK);
          const values = slice.map((_, j) => {
            const b = j * 6;
            return `($${b + 1},$${b + 2},NULL,$${b + 3},''::text,''::text,''::text,$${b + 4},$${b + 5},$${b + 6},0,NOW())`;
          }).join(',');
          await client.query(
            `INSERT INTO ad_stats_hourly
               (ad_account_id, campaign_id, ad_id, hour_utc, country, device, site,
                impressions, clicks, spent, conversions, fetched_at)
             VALUES ${values}`,
            slice.flat());
        }
      });
      written += list.length;
      logger.info({ account: accountId, ...opts, rows: list.length,
        spend: list.reduce((s, t) => s + t[5], 0).toFixed(2) }, 'meta hourly: synced');
    }
    await finishRun(runId, 'ok', written);
  } catch (err: any) {
    await finishRun(runId, 'error', written, err.message);
    throw err;
  }
}

// ---------- Time helpers ----------

/** Offset (ms) of `tz` from UTC at instant `t`. */
function tzOffsetMs(t: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - t;
}

/** Wall-clock (date, hour) in `tz` → UTC ISO string. */
function localToUtc(date: string, hour: number, tz: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz); // second pass settles DST edges
  return new Date(t).toISOString();
}

function localMidnightUtc(date: string, tz: string): string {
  return localToUtc(date, 0, tz);
}

function toUtcHour(r: MetaHourlyRow, tz: string): string {
  const hour = Number(r.hourly_stats_aggregated_by_advertiser_time_zone.slice(0, 2));
  return localToUtc(r.date_start, hour, tz);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- Helpers (duplicated per sync file by convention — see CLAUDE.md §4) ----------

async function getPlatformId(code: string): Promise<number> {
  const rows = await query<{ id: number }>('SELECT id FROM platforms WHERE code = $1', [code]);
  if (!rows[0]) throw new Error(`Unknown platform: ${code}`);
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
