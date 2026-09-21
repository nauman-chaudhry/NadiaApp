import {
  listMarketers,
  listCampaigns,
  fetchMarketerHourly,
  listPromotedLinks,
  fetchCampaignCost,
  fetchAdBreakdown,
  fetchCountryBreakdown,
  fetchPublisherBreakdown,
} from '../sources/outbrain/client.js';
import { withTx, query } from '../db/client.js';
import { logger } from '../config/logger.js';

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

/**
 * The DDC type tag lives in the promoted link's landing URL:
 *   startgonow.com/<path>/?amxt=blue&tmpl=C244&tt=<34-hex>&kw=<keywords>
 * DDC reports revenue keyed by this value. It is NOT an Outbrain object id —
 * Outbrain's API rejects these as "Invalid id" — so this URL param is the only
 * bridge between DDC revenue and an Outbrain campaign/ad.
 *
 * STORED RAW, MATCHED NORMALIZED. Since ~2026-08-28 the URL template appends a
 * literal '_' + publisher-id macro, so tt_param can be
 * '<34-hex>_' + two braces + 'publisher_id' + two braces. Outbrain substitutes
 * the macro at serve time and the DDC sync keeps only the base tag
 * (parseTypeTag splits at the FIRST underscore), so every consumer of tt_param
 * MUST compare via split_part(tt_param, '_', 1) — never exact equality.
 * Exact matching made post-macro links invisible to the resolver and put DDC
 * revenue on zero-traffic campaigns (fixed in migration 046 + server.ts).
 */
function parseTt(url: string): string | null {
  if (!url) return null;
  try {
    const v = new URL(url).searchParams.get('tt');
    return v && v.trim() !== '' ? v : null;
  } catch {
    const m = /[?&]tt=([^&#]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

function parseGdR(url: string): { gd: string; r: string } {
  try {
    const u = new URL(url);
    return { gd: u.searchParams.get('gd') ?? '', r: u.searchParams.get('r') ?? '' };
  } catch {
    return { gd: '', r: '' };
  }
}

// =============================================================================
// Outbrain cost sync.
//   1. syncOutbrainCampaigns — marketers + campaigns -> outbrain_campaigns.
//   2. syncOutbrainCost      — per-campaign DAILY cost -> outbrain_stats_daily.
//
// GRAIN / TIMEZONE: Outbrain exposes per-campaign cost only at DAILY grain
// (per-campaign hourly is not available), and cost/revenue do not hour-align
// (search monetisation lags the click — see outbrain-tz.ts). So cost is stored
// per (campaign, day). `day_utc` holds Outbrain's reported day, which is EDT;
// we keep that calendar label as the business day for daily reconciliation. The
// +4 hourly converter (outbrain-tz.ts) stands ready for if/when a true hourly
// cost feed becomes available, but is intentionally NOT used for daily buckets.
// =============================================================================

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/** Pull all marketers + their campaigns into outbrain_campaigns. Run first. */
export async function syncOutbrainCampaigns(): Promise<{ campaigns: number }> {
  const marketers = await listMarketers();
  let total = 0;
  // Register every marketer as an ad_accounts row so the MV can attach
  // ad_account_id to its cost rows and the account appears in the dashboard
  // dropdown. Without this, a NEW marketer (e.g. SBH_ssm_03) synced cost data
  // but had no account row — invisible under any Project filter.
  // client_partner_id is left NULL for new rows; mapping to a project stays
  // a deliberate manual step.
  for (const mk of marketers) {
    await query(
      `INSERT INTO ad_accounts (platform_id, external_id, name, status, currency, timezone)
       SELECT id, $1, $2, 'active', 'USD', 'America/New_York' FROM platforms WHERE code = 'outbrain'
       ON CONFLICT (platform_id, external_id) DO UPDATE SET name = EXCLUDED.name`,
      [mk.id, mk.name],
    );
  }
  for (const mk of marketers) {
    const campaigns = await listCampaigns(mk.id);
    await withTx(async (client) => {
      for (const cp of campaigns) {
        await client.query(
          `INSERT INTO outbrain_campaigns
             (campaign_id, campaign_name, marketer_id, account_code, account_name, status, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (campaign_id) DO UPDATE SET
             campaign_name = EXCLUDED.campaign_name,
             marketer_id   = EXCLUDED.marketer_id,
             account_code  = EXCLUDED.account_code,
             account_name  = EXCLUDED.account_name,
             status        = EXCLUDED.status,
             updated_at    = NOW()`,
          [cp.id, cp.name, mk.id, mk.name, mk.name,
           cp.enabled ? 'enabled' : 'disabled'],
        );
        total++;
      }
    });
    logger.info({ marketer: mk.name, campaigns: campaigns.length }, 'outbrain: campaigns synced');
  }
  return { campaigns: total };
}

/**
 * Promoted-link (gd, r) -> campaign map into outbrain_ads. Their URLs carry the
 * gd/r params that Codefuel-Outbrain revenue is keyed by, so this enables
 * per-campaign Codefuel-Outbrain attribution. Run after syncOutbrainCampaigns.
 */
export async function syncOutbrainPromotedLinks(): Promise<{ pairs: number }> {
  const campaigns = await query<{ campaign_id: string }>(
    'SELECT campaign_id FROM outbrain_campaigns',
  );
  // Dedupe (gd, r) across campaigns.
  //
  // outbrain_ads is keyed on (gd_param, r_param) GLOBALLY — no marketer — so
  // whichever campaign is written last owns the pair and ALL of its Codefuel
  // revenue. 17 of 777 live pairs are reachable from more than one marketer
  // ($2,566.15, 7.4% of Codefuel-Outbrain revenue), so this is not theoretical.
  // (The previous comment here claimed "r is the promoted-link id so collisions
  // are rare". That is wrong: r_param 7796123058 vs promoted_link_id 581740719.)
  //
  // Until shared pairs can be allocated across accounts properly, prefer the
  // campaign that has ACTUALLY SPENT on the pair. First-seen ordering made the
  // owner depend on campaign iteration order, so a routine re-sync silently
  // moved revenue between accounts — it handed three brand-new accounts 28 pairs
  // they had never spent a cent on, showing revenue against $0.00 cost.
  // Ever-spent, and — added because ever-spent alone was not enough — spent
  // RECENTLY, plus which campaigns are currently enabled.
  //
  // Ever-spent has no date window, so a campaign that spent months ago and has
  // since been paused kept the pair forever while the live duplicate got nothing.
  // The client reported the symptom directly: a pair duplicated into another
  // account, one copy paused and one active, with the revenue landing on the
  // paused one. Measured 2026-09-14 over 265 recently-active campaigns: 72 of
  // 368 pairs are shared, 21 of those have exactly one enabled owner, and
  // $420.33 of their $869.82 (48%) sat on a PAUSED campaign.
  const spendPairs = new Set(
    (await query<{ k: string }>(
      `SELECT DISTINCT oad.gd_param || '|' || oad.r_param || '|' || oad.campaign_id AS k
         FROM outbrain_ad_daily oad
        WHERE oad.gd_param IS NOT NULL AND oad.r_param IS NOT NULL AND oad.spent > 0`,
    )).map(r => r.k),
  );
  const recentSpendPairs = new Set(
    (await query<{ k: string }>(
      `SELECT DISTINCT oad.gd_param || '|' || oad.r_param || '|' || oad.campaign_id AS k
         FROM outbrain_ad_daily oad
        WHERE oad.gd_param IS NOT NULL AND oad.r_param IS NOT NULL AND oad.spent > 0
          AND oad.day_utc > (now()::date - 7)`,
    )).map(r => r.k),
  );
  const enabledCampaigns = new Set(
    (await query<{ campaign_id: string }>(
      `SELECT campaign_id FROM outbrain_campaigns WHERE status = 'enabled'`,
    )).map(r => r.campaign_id),
  );
  // Who owns each pair TODAY. Used only to break ties in favour of the incumbent:
  // 50 of the 72 shared pairs have every copy paused, so no candidate qualifies on
  // any signal, and without this a re-sync would reshuffle that revenue between
  // equally-unqualified accounts every time it ran — churn with no benefit, and
  // the precise failure this function was already burned by once.
  const currentOwner = new Map(
    (await query<{ gd_param: string; r_param: string; campaign_id: string }>(
      `SELECT gd_param, r_param, campaign_id FROM outbrain_ads`,
    )).map(r => [`${r.gd_param}|${r.r_param}`, r.campaign_id]),
  );

  /**
   * Rank a candidate owner of a shared (gd, r) pair. Highest wins.
   *   4  spent on this pair in the last 7 days — it is running NOW
   *   2  campaign is enabled — the client's rule for the paused/active duplicate
   *   1  has ever spent on the pair — the original safeguard, kept as a floor
   * Ties break on campaign_id so the owner never depends on iteration order.
   * (First-seen ordering previously let a routine re-sync move revenue between
   * accounts; a deterministic tiebreak is what stops that recurring.)
   */
  const ownerScore = (gd: string, r: string, camp: string): number =>
    (recentSpendPairs.has(`${gd}|${r}|${camp}`) ? 4 : 0) +
    (enabledCampaigns.has(camp) ? 2 : 0) +
    (spendPairs.has(`${gd}|${r}|${camp}`) ? 1 : 0);
  const failedCampaigns = new Set<string>();
  const map = new Map<string, { gd: string; r: string; campaign_id: string }>();
  const linkMap = new Map<string, string>(); // promoted-link id -> campaign_id
  const ttMap   = new Map<string, string | null>(); // promoted-link id -> tt param
  for (const c of campaigns) {
    let links: Awaited<ReturnType<typeof listPromotedLinks>> = [];
    try {
      links = await listPromotedLinks(c.campaign_id);
    } catch (e: any) {
      logger.warn({ campaign: c.campaign_id, err: e.message }, 'outbrain promoted-links: fetch failed');
      // A campaign we could not read contributes no links, so it drops out of the
      // contest for every pair it owns and a lower-scored campaign takes them on a
      // single flaky HTTP call. Worse where candidates tie: the substitute becomes
      // the incumbent and the tie rule then keeps it there for good.
      failedCampaigns.add(c.campaign_id);
      continue;
    }
    for (const l of links) {
      if (l.id) {
        linkMap.set(l.id, (l as any).campaignId || c.campaign_id);
        ttMap.set(l.id, parseTt(l.url));
      }
      const { gd, r } = parseGdR(l.url);
      if (!gd || !r) continue;
      // Separator is explicit and visible on purpose: the table's key is TWO
      // columns, and this map previously used an invisible \x01 while the
      // currentOwner map below used no separator at all — so the two key schemes
      // disagreed and the incumbent lookup never matched.
      const key = `${gd}|${r}`;
      const camp = (l as any).campaignId || c.campaign_id;
      const cur = map.get(key);
      if (!cur) {
        map.set(key, { gd, r, campaign_id: camp });
      } else {
        const mine = ownerScore(gd, r, camp);
        const theirs = ownerScore(cur.gd, cur.r, cur.campaign_id);
        if (mine > theirs) {
          map.set(key, { gd, r, campaign_id: camp });
        } else if (mine === theirs) {
          // Equal on every signal: keep whoever holds the pair now, so ownership
          // (and the revenue that follows it) does not drift on a re-sync. Only
          // when neither candidate is the incumbent does campaign_id decide, and
          // that is a stable ordering rather than API iteration order.
          const held = currentOwner.get(key);
          if (held === camp) {
            map.set(key, { gd, r, campaign_id: camp });
          } else if (held !== cur.campaign_id && camp < cur.campaign_id) {
            map.set(key, { gd, r, campaign_id: camp });
          }
        }
      }
    }
  }
  // Leave a pair alone when we could not fetch its CURRENT owner this run: we
  // cannot know whether that owner would still have won, so preserving the row
  // beats handing the pair to whoever happened to be reachable.
  const protectedPairs = [...map.keys()].filter((k) => {
    const held = currentOwner.get(k);
    return held !== undefined && failedCampaigns.has(held) && map.get(k)!.campaign_id !== held;
  });
  for (const k of protectedPairs) map.delete(k);

  // And a broad outage must never rewrite the table off a partial view.
  if (failedCampaigns.size > campaigns.length * 0.1) {
    logger.error(
      { failed: failedCampaigns.size, campaigns: campaigns.length },
      'outbrain promoted-links: too many fetch failures — skipping the ownership upsert',
    );
    return { pairs: 0 };
  }

  const rows = [...map.values()];
  await withTx(async (client) => {
    for (const row of rows) {
      await client.query(
        `INSERT INTO outbrain_ads (gd_param, r_param, campaign_id, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (gd_param, r_param) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, updated_at = NOW()`,
        [row.gd, row.r, row.campaign_id],
      );
    }
    for (const [linkId, campId] of linkMap) {
      await client.query(
        `INSERT INTO outbrain_ad_links (link_id, campaign_id, tt_param, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (link_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id,
                                             tt_param    = EXCLUDED.tt_param,
                                             updated_at  = NOW()`,
        [linkId, campId, ttMap.get(linkId) ?? null],
      );
    }
  });
  const withTt = [...ttMap.values()].filter(Boolean).length;
  logger.info(
    { pairs: rows.length, links: linkMap.size, withTt,
      fetchFailures: failedCampaigns.size, pairsProtected: protectedPairs.length },
    'outbrain promoted-links: synced',
  );
  return { pairs: rows.length };
}

/** Per-campaign daily cost over [from,to] -> outbrain_stats_daily. */
export async function syncOutbrainCost(opts: {
  from: string;
  to: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('outbrain', 'cost', opts.from, opts.to);
  try {
    const marketers = await listMarketers();
    const days = eachDay(opts.from, opts.to);
    let written = 0;
    for (const mk of marketers) {
      for (const day of days) {
        let rows: Awaited<ReturnType<typeof fetchCampaignCost>> = [];
        try {
          rows = await fetchCampaignCost(mk.id, day);
        } catch (e: any) {
          logger.warn({ marketer: mk.name, day, err: e.message }, 'outbrain cost: fetch failed');
          continue;
        }
        const nonzero = rows.filter((r) => r.spend > 0 || r.clicks > 0 || r.impressions > 0);
        if (nonzero.length === 0) continue;
        await withTx(async (client) => {
          for (const r of nonzero) {
            if (!r.campaignId) continue;
            // Ensure the campaign exists (cost can reference a campaign not yet in
            // outbrain_campaigns if campaigns sync missed it).
            await client.query(
              `INSERT INTO outbrain_campaigns (campaign_id, campaign_name, marketer_id, account_code, account_name, updated_at)
               VALUES ($1,$2,$3,$4,$4,NOW())
               ON CONFLICT (campaign_id) DO UPDATE SET campaign_name = EXCLUDED.campaign_name, updated_at = NOW()`,
              [r.campaignId, r.campaignName, mk.id, mk.name],
            );
            await client.query(
              `INSERT INTO outbrain_stats_daily
                 (campaign_id, day_utc, impressions, clicks, conversions, spent)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (campaign_id, day_utc) DO UPDATE SET
                 impressions = EXCLUDED.impressions,
                 clicks      = EXCLUDED.clicks,
                 conversions = EXCLUDED.conversions,
                 spent       = EXCLUDED.spent`,
              [r.campaignId, day, r.impressions, r.clicks, r.conversions, r.spend],
            );
            written++;
          }
        });
      }
      logger.info({ marketer: mk.name, days: days.length }, 'outbrain cost: marketer done');
    }
    await finishRun(runId, 'ok', written);
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'outbrain cost: failed');
    throw err;
  }
}

// =============================================================================
// Outbrain breakdown syncs (Ads, Country, Publisher).
// All three are daily-grain. Outbrain /geo and /publishers endpoints return
// marketer-level totals (no campaign breakdown); /promotedContent carries a
// campaignId so ads can be attributed per campaign.
//
// Day label convention: same as outbrain_stats_daily — the Outbrain EDT
// reporting day. For daily grain the ±4h offset between EDT and UTC does not
// shift the calendar day label, so no conversion is needed.
// =============================================================================

/** Per-promoted-link daily cost → outbrain_ad_daily. */
export async function syncOutbrainAds(opts: {
  from: string;
  to: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('outbrain', 'ads', opts.from, opts.to);
  try {
    const marketers = await listMarketers();
    const days = eachDay(opts.from, opts.to);
    let written = 0;
    for (const mk of marketers) {
      for (const day of days) {
        let rows: Awaited<ReturnType<typeof fetchAdBreakdown>> = [];
        try {
          rows = await fetchAdBreakdown(mk.id, day);
        } catch (e: any) {
          logger.warn({ marketer: mk.name, day, err: e.message }, 'outbrain ads: fetch failed');
          continue;
        }
        if (rows.length === 0) continue;
        await withTx(async (client) => {
          for (const r of rows) {
            if (!r.promotedLinkId || !r.campaignId) continue;
            // Ensure the campaign exists before inserting (FK guard).
            await client.query(
              `INSERT INTO outbrain_campaigns (campaign_id, campaign_name, marketer_id, account_code, account_name, updated_at)
               VALUES ($1,$2,$3,$4,$4,NOW())
               ON CONFLICT (campaign_id) DO UPDATE SET campaign_name = EXCLUDED.campaign_name, updated_at = NOW()`,
              [r.campaignId, r.campaignName, mk.id, mk.name],
            );
            const { gd, r: rp } = parseGdR(r.url);
            await client.query(
              `INSERT INTO outbrain_ad_daily
                 (campaign_id, promoted_link_id, promoted_link_uuid, ad_title, landing_url,
                  gd_param, r_param, marketer_id, day_utc,
                  impressions, clicks, spent, conversions)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               ON CONFLICT (promoted_link_id, day_utc) DO UPDATE SET
                 campaign_id        = EXCLUDED.campaign_id,
                 promoted_link_uuid = EXCLUDED.promoted_link_uuid,
                 ad_title           = EXCLUDED.ad_title,
                 landing_url        = EXCLUDED.landing_url,
                 gd_param           = EXCLUDED.gd_param,
                 r_param            = EXCLUDED.r_param,
                 marketer_id        = EXCLUDED.marketer_id,
                 impressions        = EXCLUDED.impressions,
                 clicks             = EXCLUDED.clicks,
                 spent              = EXCLUDED.spent,
                 conversions        = EXCLUDED.conversions`,
              [
                r.campaignId, r.promotedLinkId, r.promotedLinkUuid || null,
                r.title || null, r.url || null,
                gd || null, rp || null, mk.id, day,
                r.impressions, r.clicks, r.spend, r.conversions,
              ],
            );
            written++;
          }
        });
      }
      logger.info({ marketer: mk.name, days: days.length }, 'outbrain ads: marketer done');
    }
    await finishRun(runId, 'ok', written);
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'outbrain ads: failed');
    throw err;
  }
}

/** Per-country daily cost → outbrain_country_daily. */
export async function syncOutbrainCountry(opts: {
  from: string;
  to: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('outbrain', 'country', opts.from, opts.to);
  try {
    const marketers = await listMarketers();
    const days = eachDay(opts.from, opts.to);
    let written = 0;
    for (const mk of marketers) {
      for (const day of days) {
        let rows: Awaited<ReturnType<typeof fetchCountryBreakdown>> = [];
        try {
          rows = await fetchCountryBreakdown(mk.id, day);
        } catch (e: any) {
          logger.warn({ marketer: mk.name, day, err: e.message }, 'outbrain country: fetch failed');
          continue;
        }
        if (rows.length === 0) continue;
        await withTx(async (client) => {
          for (const r of rows) {
            if (!r.countryCode) continue;
            await client.query(
              `INSERT INTO outbrain_country_daily
                 (marketer_id, country_code, country_name, day_utc,
                  impressions, clicks, spent, conversions)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (marketer_id, country_code, day_utc) DO UPDATE SET
                 country_name = EXCLUDED.country_name,
                 impressions  = EXCLUDED.impressions,
                 clicks       = EXCLUDED.clicks,
                 spent        = EXCLUDED.spent,
                 conversions  = EXCLUDED.conversions`,
              [mk.id, r.countryCode, r.countryName || null, day,
               r.impressions, r.clicks, r.spend, r.conversions],
            );
            written++;
          }
        });
      }
      logger.info({ marketer: mk.name, days: days.length }, 'outbrain country: marketer done');
    }
    await finishRun(runId, 'ok', written);
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'outbrain country: failed');
    throw err;
  }
}

/** Per-publisher daily cost → outbrain_publisher_daily. */
export async function syncOutbrainPublisher(opts: {
  from: string;
  to: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('outbrain', 'publisher', opts.from, opts.to);
  try {
    const marketers = await listMarketers();
    const days = eachDay(opts.from, opts.to);
    let written = 0;
    for (const mk of marketers) {
      for (const day of days) {
        let rows: Awaited<ReturnType<typeof fetchPublisherBreakdown>> = [];
        try {
          rows = await fetchPublisherBreakdown(mk.id, day);
        } catch (e: any) {
          logger.warn({ marketer: mk.name, day, err: e.message }, 'outbrain publisher: fetch failed');
          continue;
        }
        if (rows.length === 0) continue;
        await withTx(async (client) => {
          for (const r of rows) {
            if (!r.publisherId) continue;
            await client.query(
              `INSERT INTO outbrain_publisher_daily
                 (marketer_id, publisher_id, publisher_uuid, publisher_name, publisher_url,
                  day_utc, impressions, clicks, spent, conversions)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
               ON CONFLICT (marketer_id, publisher_id, day_utc) DO UPDATE SET
                 publisher_uuid = EXCLUDED.publisher_uuid,
                 publisher_name = EXCLUDED.publisher_name,
                 publisher_url  = EXCLUDED.publisher_url,
                 impressions    = EXCLUDED.impressions,
                 clicks         = EXCLUDED.clicks,
                 spent          = EXCLUDED.spent,
                 conversions    = EXCLUDED.conversions`,
              [
                mk.id, r.publisherId, r.publisherUuid || null,
                r.publisherName || null, r.publisherUrl || null, day,
                r.impressions, r.clicks, r.spend, r.conversions,
              ],
            );
            written++;
          }
        });
      }
      logger.info({ marketer: mk.name, days: days.length }, 'outbrain publisher: marketer done');
    }
    await finishRun(runId, 'ok', written);
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'outbrain publisher: failed');
    throw err;
  }
}

/**
 * Account-level HOURLY cost → outbrain_marketer_hourly.
 * Outbrain reports in EDT; hours convert EDT→UTC (+4h) so the Hourly tab
 * lines up with the rest of the dashboard. One API call per (marketer, day).
 */
export async function syncOutbrainMarketerHourly(opts: {
  from: string;
  to: string;
}): Promise<{ rowsWritten: number }> {
  const runId = await startRun('outbrain', 'marketer-hourly', opts.from, opts.to);
  try {
    const marketers = await listMarketers();
    const days = eachDay(opts.from, opts.to);
    let written = 0;
    for (const mk of marketers) {
      for (const day of days) {
        let rows: Awaited<ReturnType<typeof fetchMarketerHourly>> = [];
        try {
          rows = await fetchMarketerHourly(mk.id, day);
        } catch (e: any) {
          logger.warn({ marketer: mk.name, day, err: e.message }, 'outbrain marketer-hourly: fetch failed');
          continue;
        }
        const nonZero = rows.filter(r => r.impressions > 0 || r.clicks > 0 || r.spend > 0);
        if (nonZero.length === 0) continue;
        await withTx(async (client) => {
          for (const r of nonZero) {
            // EDT hour → UTC (+4h). `day` is the EDT calendar day.
            const hourUtc = new Date(new Date(`${day}T00:00:00Z`).getTime() + (r.hour + 4) * 3_600_000).toISOString();
            await client.query(
              `INSERT INTO outbrain_marketer_hourly
                 (marketer_id, hour_utc, impressions, clicks, spent, conversions, fetched_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW())
               ON CONFLICT (marketer_id, hour_utc) DO UPDATE SET
                 impressions = EXCLUDED.impressions,
                 clicks      = EXCLUDED.clicks,
                 spent       = EXCLUDED.spent,
                 conversions = EXCLUDED.conversions,
                 fetched_at  = NOW()`,
              [mk.id, hourUtc, r.impressions, r.clicks, r.spend, r.conversions],
            );
            written++;
          }
        });
      }
      logger.info({ marketer: mk.name, days: days.length }, 'outbrain marketer-hourly: marketer done');
    }
    await finishRun(runId, 'ok', written);
    return { rowsWritten: written };
  } catch (err: any) {
    await finishRun(runId, 'error', 0, err.message);
    logger.error({ err }, 'outbrain marketer-hourly: failed');
    throw err;
  }
}

/** Convenience wrapper: runs ads + country + publisher + marketer-hourly in sequence. */
export async function syncOutbrainBreakdowns(opts: {
  from: string;
  to: string;
}): Promise<{ ads: number; country: number; publisher: number; hourly: number }> {
  // Sequential to avoid tripling the per-marketer request rate and hitting 429s.
  const a = await syncOutbrainAds(opts);
  const c = await syncOutbrainCountry(opts);
  const p = await syncOutbrainPublisher(opts);
  const h = await syncOutbrainMarketerHourly(opts);
  return { ads: a.rowsWritten, country: c.rowsWritten, publisher: p.rowsWritten, hourly: h.rowsWritten };
}
