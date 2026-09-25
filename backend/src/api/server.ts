import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { query } from '../db/client.js';

const app = express();
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(express.json());

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Auth ----------
// Every /api route requires `Authorization: Bearer <Supabase access token>`.
// The dashboard's server components attach the logged-in user's token; nothing
// else is meant to call this API. The token is verified against THIS
// deployment's Supabase project (so Nadia's session cannot read Joe's API and
// vice versa), then the user must exist in app_users — the signup trigger
// creates that row, so "exists" means "was invited". Until 2026-09-24 the API
// had no auth at all: CORS only restricts browsers, and every endpoint answered
// curl with the full account list.
//
// Fails CLOSED: in production, missing SUPABASE_URL/SUPABASE_ANON_KEY aborts
// startup rather than running open. API_AUTH_DISABLED=true is for local dev.
if (!env.API_AUTH_DISABLED && !(env.SUPABASE_URL && env.SUPABASE_ANON_KEY)) {
  if (env.NODE_ENV === 'production') {
    logger.error('SUPABASE_URL / SUPABASE_ANON_KEY not set — refusing to start the API without auth');
    process.exit(1);
  }
  logger.warn('SUPABASE_URL / SUPABASE_ANON_KEY not set — API auth DISABLED (development only)');
}
const authOff = env.API_AUTH_DISABLED || !(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

type AuthResult = { ok: boolean; userId?: string; until: number };
const authCache = new Map<string, AuthResult>();
const AUTH_TTL_OK_MS = 5 * 60_000;   // re-verify a good token every 5 min
const AUTH_TTL_BAD_MS = 60_000;      // don't hammer Auth with a bad token either

async function verifyBearer(token: string): Promise<AuthResult> {
  const cached = authCache.get(token);
  if (cached && cached.until > Date.now()) return cached;
  let result: AuthResult = { ok: false, until: Date.now() + AUTH_TTL_BAD_MS };
  try {
    const { data } = await axios.get(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY!, Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    const userId: string | undefined = data?.id;
    if (userId) {
      const rows = await query<{ id: string }>('SELECT id FROM app_users WHERE id = $1', [userId]);
      if (rows.length > 0) result = { ok: true, userId, until: Date.now() + AUTH_TTL_OK_MS };
      else logger.warn({ userId }, 'auth: valid session but user is not in app_users');
    }
  } catch (err: any) {
    const status = err?.response?.status;
    if (status !== 401 && status !== 403) logger.error({ err: err?.message, status }, 'auth: verification failed');
  }
  if (authCache.size > 5000) authCache.clear();
  authCache.set(token, result);
  return result;
}

app.use('/api', async (req, res, next) => {
  if (authOff) return next();
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const v = await verifyBearer(token);
    if (!v.ok) return res.status(401).json({ error: 'Unauthorized' });
    next();
  } catch (err) {
    next(err);
  }
});

// ---------- Latest sync run (for the "data updated" timestamp in the UI) ----------
app.get('/api/sync-runs/latest', async (_req, res, next) => {
  try {
    const rows = await query<{ source: string; finished_at: string; status: string }>(
      `SELECT source, finished_at, status
       FROM sync_runs
       WHERE status = 'ok' AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`,
    );
    res.json(rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

// ---------- Sync status — per-source freshness for the "last synced" bar ----------
app.get('/api/sync-status', async (_req, res, next) => {
  try {
    const [overall, sources] = await Promise.all([
      // Most recent successful sync across all sources
      query<{ finished_at: string }>(
        `SELECT MAX(finished_at) AS finished_at FROM sync_runs WHERE status = 'ok'`,
      ),
      // Latest hour_utc and fetched_at per partner
      query<{ source: string; latest_hour: string; last_fetched: string }>(
        `SELECT 'taboola' AS source,
                MAX(hour_utc)   AS latest_hour,
                MAX(fetched_at) AS last_fetched
           FROM ad_stats_hourly
         UNION ALL
         SELECT 'codefuel',
                MAX(p.hour_utc),
                MAX(p.fetched_at)
           FROM partner_stats_hourly p
           JOIN client_partners c ON c.id = p.client_partner_id AND c.code = 'codefuel'
         UNION ALL
         SELECT 'image_advantage',
                MAX(p.hour_utc),
                MAX(p.fetched_at)
           FROM partner_stats_hourly p
           JOIN client_partners c ON c.id = p.client_partner_id AND c.code = 'image_advantage'
         UNION ALL
         SELECT 'ddc',
                MAX(p.hour_utc),
                MAX(p.fetched_at)
           FROM partner_stats_hourly p
           JOIN client_partners c ON c.id = p.client_partner_id AND c.code = 'ddc'`,
      ),
    ]);
    res.json({
      last_sync_at: overall[0]?.finished_at ?? null,
      sources: sources.map(s => ({
        name:         s.source,
        latest_hour:  s.latest_hour,
        last_fetched: s.last_fetched,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Filter options ----------
app.get('/api/filters/options', async (_req, res, next) => {
  try {
    const [accounts, campaigns, statuses, gds, countries, devices] = await Promise.all([
      query<{ id: number; external_id: string; name: string; partner_code: string | null; source: string }>(
        `SELECT a.id, a.external_id, a.name, cp.code AS partner_code,
                pl.code AS source
         FROM ad_accounts a
         LEFT JOIN client_partners cp ON cp.id = a.client_partner_id
         LEFT JOIN platforms pl       ON pl.id = a.platform_id
         WHERE pl.code IN ('taboola','outbrain')
         ORDER BY pl.code, a.name`,
      ),
      // Campaigns live in TWO tables: `campaigns` is Taboola-only, Outbrain's are
      // in `outbrain_campaigns`. Offering only the first meant none of the 556
      // Outbrain campaigns could be filtered — the client searched for one that
      // was visibly IN the table and got "No matches". Same defect class as the
      // status vocabulary. The frontend keys on external_id, so the synthetic
      // NULL id is harmless; the two id spaces cannot collide (Taboola numeric,
      // Outbrain 34-char hex).
      query<{ id: number; external_id: string; name: string }>(
        `SELECT id, external_id, name FROM (
           SELECT c.id, c.external_id, c.name FROM campaigns c
           UNION ALL
           SELECT NULL::int, oc.campaign_id, oc.campaign_name FROM outbrain_campaigns oc
         ) x ORDER BY name`,
      ),
      // Taboola uses PAUSED/REJECTED, Outbrain uses enabled/disabled. Offering
      // only the Taboola vocabulary made the filter inert on Outbrain accounts:
      // every choice matched no Outbrain campaign, so the Campaign tab went to
      // $0.00 with no way to filter Outbrain by status at all.
      query<{ status: string }>(
        `SELECT status FROM (
           SELECT DISTINCT status FROM campaigns WHERE status IS NOT NULL
           UNION
           SELECT DISTINCT status FROM outbrain_campaigns WHERE status IS NOT NULL
         ) s ORDER BY status`,
      ),
      query<{ gd_param: string }>(
        // Same split as campaigns: ads.gd_param is Taboola, outbrain_ads.gd_param
        // is Outbrain. Offering only the former hid 10 Outbrain GDs.
        `SELECT gd_param FROM (
           SELECT DISTINCT gd_param FROM ads WHERE gd_param IS NOT NULL AND gd_param <> ''
           UNION
           SELECT DISTINCT gd_param FROM outbrain_ads WHERE gd_param IS NOT NULL AND gd_param <> ''
         ) g ORDER BY gd_param LIMIT 500`,
      ),
      // Country/device come from Codefuel partner_stats_hourly
      // Note: IA data is stored with empty country/device, so we include "(Unattributed)" as an option
      query<{ country: string }>(
        // DDC is excluded on purpose: it reports Country, but no view can render
        // DDC country rows (the Taboola country view is Codefuel-only via
        // `campaign_ext_id IS NULL`, and the Outbrain country view returns
        // 0::numeric revenue). Including it would add dropdown options that
        // always return an empty table.
        `SELECT DISTINCT p.country FROM partner_stats_hourly p
         WHERE p.country IS NOT NULL AND p.country <> ''
           AND NOT EXISTS (SELECT 1 FROM client_partners cp
                            WHERE cp.id = p.client_partner_id AND cp.code = 'ddc')
         UNION ALL
         SELECT '(Unattributed)' AS country
         WHERE EXISTS (
           SELECT 1 FROM partner_stats_hourly p
           JOIN client_partners cp ON cp.id = p.client_partner_id
           WHERE cp.code = 'image_advantage' AND (p.country IS NULL OR p.country = '')
         )
         ORDER BY country LIMIT 200`,
      ),
      query<{ device: string }>(
        `SELECT DISTINCT device FROM partner_stats_hourly
         WHERE device IS NOT NULL AND device <> ''
         UNION ALL
         SELECT '(Unattributed)' AS device
         WHERE EXISTS (
           SELECT 1 FROM partner_stats_hourly p
           JOIN client_partners cp ON cp.id = p.client_partner_id
           WHERE cp.code = 'image_advantage' AND (p.device IS NULL OR p.device = '')
         )
         ORDER BY device`,
      ),
    ]);
    // sites: Taboola doesn't give site-level hourly data via its reporting API;
    // return empty for now so the filter renders but is inactive.
    res.json({ accounts, campaigns, sites: [], countries, devices, statuses, gds });
  } catch (err) {
    next(err);
  }
});

// ---------- Stats ----------

const STATS_VIEWS = ['campaign', 'device', 'site', 'country', 'ads', 'daily', 'hourly'] as const;

const statsQuerySchema = z.object({
  view: z.enum(STATS_VIEWS),
  from: z.string(),
  to: z.string(),
  account_id:  z.string().optional(),
  campaign_id: z.string().optional(),
  gd:          z.string().optional(),
  site:        z.string().optional(),
  country:     z.string().optional(),
  device:      z.string().optional(),
  status:      z.string().optional(),
  // 'outbrain' shows Outbrain rows; anything else (default) shows Taboola.
  source:      z.string().optional(),
  // IA feed: 'yahoo' (y-metrics search) | 'flux' (x-metrics display) | all.
  feed:        z.string().optional(),
});

app.get('/api/stats', async (req, res, next) => {
  try {
    const params = statsQuerySchema.parse(req.query);
    // Ads tab under "All Traffic Sources": the Taboola-side and Outbrain-side
    // ads live in two separate query branches (different id spaces, different
    // cost tables). Run both and concatenate so the all-sources Ads total
    // reconciles with the Campaign tab. No double count: the generic branch's
    // psSource excludes Outbrain partner rows.
    if (params.view === 'ads' && params.source !== 'outbrain' && params.source !== 'taboola') {
      const tb = buildStatsSql({ ...params, source: 'taboola' });
      const ob = buildStatsSql({ ...params, source: 'outbrain' });
      const [tbRows, obRows] = await Promise.all([query(tb.sql, tb.args), query(ob.sql, ob.args)]);
      const rows = [...tbRows, ...obRows];
      res.json({ rows, totals: computeTotals(rows), view: params.view });
      return;
    }
    const { sql, args } = buildStatsSql(params);
    const rows = await query(sql, args);
    res.json({ rows, totals: computeTotals(rows), view: params.view });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// buildStatsSql
// ---------------------------------------------------------------------------
// The joined_stats_hourly materialized view holds campaign-level rows (no
// item / country / device / site breakdown — Taboola's API limitation at
// hourly granularity). Views that need those dimensions query partner_stats_hourly
// (Codefuel) directly with a campaign join.
// ---------------------------------------------------------------------------

function buildStatsSql(p: z.infer<typeof statsQuerySchema>): { sql: string; args: any[] } {
  const args: any[] = [p.from, p.to];

  // Standard MV-based WHERE (used by campaign/daily/hourly views).
  // source: 'outbrain' -> Outbrain only; 'taboola' -> Taboola only (everything
  // that is not Outbrain); 'all' / absent -> combined (no source filter).
  const mvWhereParts: string[] = [
    `hour_utc >= $1::timestamptz`,
    `hour_utc <  ($2::timestamptz + INTERVAL '1 day')`,
  ];
  if (p.source === 'outbrain')      mvWhereParts.push(`source_platform = 'Outbrain'`);
  else if (p.source === 'taboola')  mvWhereParts.push(`source_platform IS DISTINCT FROM 'Outbrain'`);
  // 'all' / undefined: no source filter (combined Taboola + Outbrain).
  if (p.account_id && p.account_id !== 'all') {
    const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (ids.length === 1) { args.push(ids[0]); mvWhereParts.push(`ad_account_id = $${args.length}::int`); }
    else if (ids.length > 1) { args.push(ids); mvWhereParts.push(`ad_account_id = ANY($${args.length}::int[])`); }
  }
  if (p.campaign_id) { args.push(p.campaign_id); mvWhereParts.push(`campaign_external_id = ANY(string_to_array($${args.length}::text, ','))`); }
  // MV 016 has no campaign_status column; resolve status via the campaigns table.
  // Status. The MV mixes Taboola campaigns (campaigns.external_id) and Outbrain
  // ones (outbrain_campaigns.campaign_id). Checking only `campaigns` meant NO
  // Outbrain campaign could ever match, so the Campaign tab returned $0.00 under
  // any status filter while the Ads tab — which ignored status entirely — showed
  // the full total. That broke Campaign == Ads one click away in the UI.
  let statusArgIdx = 0;
  if (p.status) {
    args.push(p.status);
    statusArgIdx = args.length;
    mvWhereParts.push(
      `(campaign_external_id IN (SELECT external_id FROM campaigns WHERE status = ANY(string_to_array($${statusArgIdx}::text, ',')))
        OR campaign_external_id IN (SELECT campaign_id FROM outbrain_campaigns WHERE status = ANY(string_to_array($${statusArgIdx}::text, ','))))`,
    );
  }
  // GD. Accepted by the schema since day one but never applied to the MV, so
  // Campaign/Daily/Hourly silently returned the UNFILTERED total under any GD
  // selection -- the client picked a GD and the numbers did not move.
  //
  // A GD is an ad-level landing-URL param, but the MV collapses revenue to
  // campaign grain (gd_param is NULL on every MV row), so it is resolved to the
  // campaigns carrying that GD. That is also the only semantic under which cost
  // can be scoped at all, and it is exact in practice: 3315/3375 Taboola and
  // 149/150 Outbrain campaigns carry exactly one GD. Same two-table union as the
  // status filter -- `ads` is Taboola-only, `outbrain_ads` holds Outbrain's.
  if (p.gd) {
    args.push(p.gd);
    mvWhereParts.push(
      `(campaign_external_id IN (SELECT c2.external_id FROM campaigns c2
                                   JOIN ads a2 ON a2.campaign_id = c2.id
                                  WHERE a2.gd_param = ANY(string_to_array($${args.length}::text, ',')))
        OR campaign_external_id IN (SELECT oa2.campaign_id FROM outbrain_ads oa2
                                  WHERE oa2.gd_param = ANY(string_to_array($${args.length}::text, ','))))`,
    );
  }
  const mvWhere = `WHERE ${mvWhereParts.join(' AND ')}`;

  // Source filter for the direct-query DETAIL views (device / country / ads /
  // site). These views break revenue down by Taboola ad/site/geo ids, which
  // Outbrain data does not share — and Outbrain cost is campaign-grain only, so
  // there is no meaningful per-device/country/ad/site Outbrain breakdown. So
  // these tabs are Taboola-only and return NOTHING under source=outbrain
  // (Outbrain detail lives in the Campaign / Daily / Hourly views). Under
  // taboola/all they show Taboola data as before.
  const psSource =
    p.source === 'outbrain'
      ? `FALSE`
      : `(p.source_platform = 'Taboola' OR p.source_platform IS NULL)`;

  // IA Feeds filter (yahoo = y-metrics search, flux = x-metrics display).
  // MV rows carry the flux portion in *_flux columns (migration 037), so the
  // MV-based views select the requested slice; the direct partner_stats_hourly
  // views filter by granularity ('x-daily' = flux). Cost is never feed-scoped.
  const REV = p.feed === 'flux' ? 'revenue_flux'
            : p.feed === 'yahoo' ? '(revenue - revenue_flux)' : 'revenue';
  const ADC = p.feed === 'flux' ? 'ad_clicks_flux'
            : p.feed === 'yahoo' ? '(ad_clicks - ad_clicks_flux)' : 'ad_clicks';
  const SES = p.feed === 'flux' ? 'sessions_flux'
            : p.feed === 'yahoo' ? '(sessions - sessions_flux)' : 'sessions';
  // DDC now has BOTH grains: a rolling ~3-day hourly feed and daily rows going
  // back to 22 July. The MV's `ps` CTE already keeps hourly and drops 'daily'
  // for any (partner, date) that has hourly rows. The tabs below query
  // partner_stats_hourly DIRECTLY and would otherwise count those three days
  // TWICE — the single biggest risk in adding the hourly feed. This mirrors the
  // MV's rule exactly; pass it the alias the query uses.
  //
  // PERFORMANCE: the two `hour_utc` bounds on the inner scan are NOT optional.
  // `hour_utc::date` is not indexable, so without them Postgres re-scans all
  // 236k 'hourly' rows for every candidate row: the Country tab over
  // 22 Jul - 6 Sep went from 0.3s to **97s**, i.e. within 23s of the 2-minute
  // statement_timeout, and it did time out under concurrent load. With them the
  // same query is 0.3s and returns byte-identical rows ($7,801.7851 either way).
  //
  // They are safe because `from`/`to` are dates, so $1 and ($2 + 1 day) both
  // land on midnight: if the outer row's date is inside the window then every
  // hour of that date is too, so no shadowing row can be excluded.
  //
  // This means the helper REQUIRES $1 = from and $2 = to at the call site. All
  // five call sites are in branches whose args start `[p.from, p.to]` — keep it
  // that way if you add another.
  const ddcGrainDedup = (alias: string) => `
    AND (${alias}.granularity <> 'daily' OR NOT EXISTS (
          SELECT 1 FROM partner_stats_hourly _h
           WHERE _h.client_partner_id = ${alias}.client_partner_id
             AND _h.granularity = 'hourly'
             AND _h.hour_utc >= $1::timestamptz
             AND _h.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
             AND _h.hour_utc::date = ${alias}.hour_utc::date))`;

  const iaFeed = p.feed === 'yahoo' ? `AND p.granularity <> 'x-daily'`
               : p.feed === 'flux'  ? `AND p.granularity = 'x-daily'` : '';

  // Shared computed columns for MV-based views — full Nadia spec column set
  const mvTotals = `
    SUM(impressions)                                                           AS impressions,
    SUM(clicks)                                                                AS clicks,
    SUM(spent)                                                                 AS spent,
    SUM(${REV})                                                                AS revenue,
    SUM(conversions)                                                           AS conversions,
    SUM(${ADC})                                                                AS ad_clicks,
    SUM(${SES})                                                                AS sessions,
    SUM(${REV}) - SUM(spent)                                                   AS profit,
    CASE WHEN SUM(impressions) = 0 THEN 0
         ELSE SUM(spent) * 1000.0 / SUM(impressions) END                       AS actual_cpm,
    CASE WHEN SUM(impressions) = 0 THEN 0
         ELSE SUM(clicks) * 100.0 / SUM(impressions) END                       AS ctr_pct,
    CASE WHEN SUM(clicks) = 0 THEN 0
         ELSE SUM(spent) / SUM(clicks) END                                     AS actual_cpc,
    CASE WHEN SUM(clicks) = 0 THEN 0
         ELSE SUM(conversions) * 100.0 / SUM(clicks) END                       AS conversion_rate_pct,
    CASE WHEN SUM(conversions) = 0 THEN 0
         ELSE SUM(spent) / SUM(conversions) END                                AS actual_cpa,
    CASE WHEN SUM(${ADC}) = 0 THEN 0
         ELSE SUM(${REV}) / SUM(${ADC}) END                                    AS rpc,
    CASE WHEN SUM(${REV}) = 0 THEN 0
         ELSE (SUM(${REV}) - SUM(spent)) * 100.0 / SUM(${REV}) END            AS margin_pct,
    CASE WHEN SUM(${ADC}) = 0 THEN 0
         ELSE SUM(spent) / SUM(${ADC}) END                                     AS yahoo_cpa,
    SUM(conversions) - SUM(${ADC})                                             AS conversion_scrub,
    CASE WHEN SUM(conversions) = 0 THEN 0
         ELSE (SUM(conversions) - SUM(${ADC})) * 100.0 / SUM(conversions) END AS scrub_rate_pct
  `;

  // For device/country/site/ads views, query partner_stats_hourly + ad_stats_hourly
  // directly because the MV aggregates those dimensions away.
  // Build lazily — only for the view actually requested — so partnerArgs is
  // mutated exactly once and parameter indices stay correct.

  // ── Outbrain hourly (account-level) ─────────────────────────────────────────
  // Cost comes from outbrain_marketer_hourly (breakdown=hourOfDay, EDT→UTC
  // converted at sync). Revenue comes from the hourly partner rows
  // (source_platform='Outbrain'), account-resolved via campaign-hex / link /
  // (gd,r) mappings. Per-campaign hourly is not exposed by the Amplify API, so
  // a campaign filter falls through to the MV (day-grain) behavior below.
  if (p.view === 'hourly' && p.source === 'outbrain' && !p.campaign_id) {
    const hArgs: any[] = [p.from, p.to];
    let costAcct = '';
    let revAcct = '';
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 1) {
        const i = hArgs.push(ids.length === 1 ? ids[0] : ids);
        const cmp = ids.length === 1 ? `= $${i}::int` : `= ANY($${i}::int[])`;
        costAcct = `AND EXISTS (SELECT 1 FROM ad_accounts _a WHERE _a.platform_id = 2 AND _a.external_id = m.marketer_id AND _a.id ${cmp})`;
        revAcct  = `AND EXISTS (SELECT 1 FROM ad_accounts _a WHERE _a.platform_id = 2 AND _a.external_id = mres.marketer_id AND _a.id ${cmp})`;
      }
    }
    return {
      args: hArgs,
      sql: `
        WITH ob_cost_h AS (
          SELECT EXTRACT(HOUR FROM m.hour_utc)::int AS hour,
                 SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks,
                 SUM(m.spent) AS spent, SUM(m.conversions) AS conversions
          FROM outbrain_marketer_hourly m
          WHERE m.hour_utc >= $1::timestamptz
            AND m.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${costAcct}
          GROUP BY 1
        ),
        ob_rev_h AS (
          SELECT EXTRACT(HOUR FROM p.hour_utc)::int AS hour,
                 SUM(p.revenue) AS revenue, SUM(p.ad_clicks) AS ad_clicks, SUM(p.sessions) AS sessions
          FROM partner_stats_hourly p
          -- DDC now HAS an hourly feed (rolling ~3 days), so it joins this tab
          -- properly. Only its 'hourly' rows are taken: its older 'daily' rows
          -- all sit at 00:00 and would pile a whole day's revenue into hour 0,
          -- painting that hour as wildly profitable and 1-23 as pure loss. So
          -- recent days show a real hourly curve and older days show nothing
          -- here rather than something false.
          JOIN client_partners cp ON cp.id = p.client_partner_id
                                 AND (cp.code <> 'ddc' OR p.granularity = 'hourly')
          LEFT JOIN LATERAL (
            SELECT COALESCE(
              (SELECT ocd.marketer_id FROM outbrain_campaigns ocd
                WHERE ocd.campaign_id = regexp_replace(p.campaign_ext_id, '^ob:', '') LIMIT 1),
              (SELECT oc2.marketer_id FROM outbrain_ad_links al
                 JOIN outbrain_campaigns oc2 ON oc2.campaign_id = al.campaign_id
                WHERE al.link_id = regexp_replace(p.campaign_ext_id, '^ob:', '') LIMIT 1),
              (SELECT oc3.marketer_id FROM outbrain_ads oa
                 JOIN outbrain_campaigns oc3 ON oc3.campaign_id = oa.campaign_id
                WHERE oa.gd_param = p.asset_gid AND oa.r_param = p.channel LIMIT 1),
              -- DDC: its tag is the tt inside the promoted link's landing URL,
              -- not an Outbrain object id, so none of the lookups above can
              -- resolve it. Without this every DDC row resolved to NULL and
              -- vanished under an account filter — the Hourly tab showed $288.91
              -- where the hourly feed actually holds $498.37. split_part strips
              -- the literal '_{{publisher_id}}' macro suffix stored since
              -- ~2026-08-28; the DDC-side tag is always the base value, so a
              -- tag whose ONLY link carries the macro would otherwise resolve
              -- to no marketer and vanish under an account filter here too.
              (SELECT oc4.marketer_id FROM outbrain_ad_links al2
                 JOIN outbrain_campaigns oc4 ON oc4.campaign_id = al2.campaign_id
                WHERE split_part(al2.tt_param, '_', 1) = regexp_replace(p.campaign_ext_id, '^ob:', '') LIMIT 1)
            ) AS marketer_id
          ) mres ON TRUE
          WHERE p.source_platform = 'Outbrain'
            AND p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${iaFeed}
            ${revAcct}
          GROUP BY 1
        )
        SELECT
          h.hour,
          COALESCE(c.impressions,0)  AS impressions,
          COALESCE(c.clicks,0)       AS clicks,
          COALESCE(c.spent,0)        AS spent,
          COALESCE(r.revenue,0)      AS revenue,
          COALESCE(c.conversions,0)  AS conversions,
          COALESCE(r.ad_clicks,0)    AS ad_clicks,
          COALESCE(r.sessions,0)     AS sessions,
          COALESCE(r.revenue,0) - COALESCE(c.spent,0)                           AS profit,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)*1000.0/c.impressions END                AS actual_cpm,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE COALESCE(c.clicks,0)*100.0/c.impressions END                AS ctr_pct,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)/c.clicks END                            AS actual_cpc,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE COALESCE(c.conversions,0)*100.0/c.clicks END                AS conversion_rate_pct,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)/c.conversions END                       AS actual_cpa,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(r.revenue,0)/r.ad_clicks END                       AS rpc,
          CASE WHEN COALESCE(r.revenue,0)=0 THEN 0
               ELSE (COALESCE(r.revenue,0)-COALESCE(c.spent,0))*100.0/r.revenue END AS margin_pct,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)/r.ad_clicks END                         AS yahoo_cpa,
          COALESCE(c.conversions,0) - COALESCE(r.ad_clicks,0)                  AS conversion_scrub,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE (COALESCE(c.conversions,0)-COALESCE(r.ad_clicks,0))*100.0/c.conversions END AS scrub_rate_pct
        FROM generate_series(0,23) AS h(hour)
        LEFT JOIN ob_cost_h c ON c.hour = h.hour
        LEFT JOIN ob_rev_h  r ON r.hour = h.hour
        ORDER BY h.hour`,
    };
  }

  if (p.view === 'campaign' || p.view === 'daily' || p.view === 'hourly') {
    // MV-based views
    const sqlMap = {
      campaign: `
        SELECT campaign_name, campaign_external_id AS campaign_id,
               acc.name AS ad_account_name,
               ${mvTotals}
        FROM joined_stats_hourly
        LEFT JOIN ad_accounts acc ON acc.id = ad_account_id
        ${mvWhere}
        GROUP BY campaign_name, campaign_external_id, acc.name
        HAVING SUM(impressions) > 0 OR SUM(clicks) > 0 OR SUM(spent) > 0
            OR SUM(${REV}) > 0 OR SUM(${ADC}) > 0 OR SUM(${SES}) > 0
        ORDER BY spent DESC NULLS LAST`,
      daily: `
        SELECT date_trunc('day', hour_utc) AS day, ${mvTotals}
        FROM joined_stats_hourly ${mvWhere}
        GROUP BY day
        -- Same guard the campaign view has. Without it a filter that matches no
        -- activity on a given day still emitted that day as an all-zero row —
        -- 13 blank lines appeared under a status filter. Zero rows contribute
        -- nothing to any total, so this only removes blank lines.
        HAVING SUM(impressions) > 0 OR SUM(clicks) > 0 OR SUM(spent) > 0
            OR SUM(${REV}) > 0 OR SUM(${ADC}) > 0 OR SUM(${SES}) > 0
        ORDER BY day`,
      hourly: `
        SELECT
          h.hour,
          COALESCE(d.impressions,0)  AS impressions,
          COALESCE(d.clicks,0)       AS clicks,
          COALESCE(d.spent,0)        AS spent,
          COALESCE(d.revenue,0)      AS revenue,
          COALESCE(d.conversions,0)  AS conversions,
          COALESCE(d.ad_clicks,0)    AS ad_clicks,
          COALESCE(d.sessions,0)     AS sessions,
          COALESCE(d.revenue,0) - COALESCE(d.spent,0)                           AS profit,
          CASE WHEN COALESCE(d.impressions,0)=0 THEN 0
               ELSE COALESCE(d.spent,0)*1000.0/d.impressions END                AS actual_cpm,
          CASE WHEN COALESCE(d.impressions,0)=0 THEN 0
               ELSE COALESCE(d.clicks,0)*100.0/d.impressions END                AS ctr_pct,
          CASE WHEN COALESCE(d.clicks,0)=0 THEN 0
               ELSE COALESCE(d.spent,0)/d.clicks END                            AS actual_cpc,
          CASE WHEN COALESCE(d.clicks,0)=0 THEN 0
               ELSE COALESCE(d.conversions,0)*100.0/d.clicks END                AS conversion_rate_pct,
          CASE WHEN COALESCE(d.conversions,0)=0 THEN 0
               ELSE COALESCE(d.spent,0)/d.conversions END                       AS actual_cpa,
          CASE WHEN COALESCE(d.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(d.revenue,0)/d.ad_clicks END                       AS rpc,
          CASE WHEN COALESCE(d.revenue,0)=0 THEN 0
               ELSE (COALESCE(d.revenue,0)-COALESCE(d.spent,0))*100.0/d.revenue END AS margin_pct,
          CASE WHEN COALESCE(d.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(d.spent,0)/d.ad_clicks END                         AS yahoo_cpa,
          COALESCE(d.conversions,0) - COALESCE(d.ad_clicks,0)                  AS conversion_scrub,
          CASE WHEN COALESCE(d.conversions,0)=0 THEN 0
               ELSE (COALESCE(d.conversions,0)-COALESCE(d.ad_clicks,0))*100.0/d.conversions END AS scrub_rate_pct
        FROM generate_series(0,23) AS h(hour)
        LEFT JOIN (
          SELECT EXTRACT(HOUR FROM hour_utc)::int AS hour,
                 SUM(impressions) AS impressions, SUM(clicks) AS clicks,
                 SUM(spent) AS spent, SUM(${REV}) AS revenue,
                 SUM(conversions) AS conversions, SUM(${ADC}) AS ad_clicks,
                 SUM(${SES}) AS sessions
          FROM joined_stats_hourly ${mvWhere}
          GROUP BY EXTRACT(HOUR FROM hour_utc)
        ) d ON d.hour = h.hour
        ORDER BY h.hour`,
    };
    return { sql: sqlMap[p.view], args };
  }

  // ── Outbrain-specific breakdown paths ───────────────────────────────────────
  // Country, Site, and Ads tabs have Outbrain data now. When source=outbrain,
  // we skip the Taboola/CF/IA logic entirely and query the three new Outbrain
  // breakdown tables directly.

  if (p.source === 'outbrain' && p.view === 'device') {
    // Outbrain exposes no device-level COST via the Amplify API, so this tab was
    // empty under an Outbrain filter. DDC's hourly feed does carry device
    // ('Smart Phones' -> mobile, 'Desktop' -> desktop), so revenue can now be
    // split by device even though spend cannot. The client is mobile-only today
    // and plans to add desktop, so this is what she will use to compare them.
    // Spend stays 0 rather than being invented or borrowed from another
    // breakdown; the on-screen note explains that.
    const dArgs: any[] = [p.from, p.to];
    let ddcAcct = '';
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 1) {
        const i = dArgs.push(ids.length === 1 ? ids[0] : ids);
        const cmp = ids.length === 1 ? `= $${i}::int` : `= ANY($${i}::int[])`;
        ddcAcct = `AND EXISTS (SELECT 1 FROM ad_accounts _da
                                WHERE _da.client_partner_id = cp.id AND _da.id ${cmp})`;
      }
    }
    let devClause = '';
    if (p.device) { const i = dArgs.push(p.device); devClause = `AND p.device = $${i}::text`; }
    return {
      args: dArgs,
      sql: `
        SELECT
          COALESCE(NULLIF(p.device, ''), '(not reported)')  AS device,
          0::numeric AS impressions, 0::numeric AS clicks, 0::numeric AS spent,
          ROUND(SUM(p.revenue)::numeric, 2)                 AS revenue,
          0::numeric AS conversions,
          SUM(p.ad_clicks)::numeric                         AS ad_clicks,
          SUM(p.sessions)::numeric                          AS sessions,
          ROUND(SUM(p.revenue)::numeric, 2)                 AS profit,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct, 0::numeric AS actual_cpc,
          0::numeric AS conversion_rate_pct, 0::numeric AS actual_cpa,
          CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
               ELSE SUM(p.revenue) / SUM(p.ad_clicks) END   AS rpc,
          CASE WHEN SUM(p.revenue) = 0 THEN 0 ELSE 100 END  AS margin_pct,
          0::numeric AS yahoo_cpa,
          -SUM(p.ad_clicks)                                 AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM partner_stats_hourly p
        JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
        WHERE p.source_platform = 'Outbrain'
          AND p.hour_utc >= $1::timestamptz
          AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
          -- Only the hourly feed carries device; the daily rows have device ''.
          -- Without this filter every daily row would collapse into one
          -- "(not reported)" bucket and swamp the real split.
          AND p.granularity = 'hourly'
          ${iaFeed}
          ${ddcAcct}
          ${devClause}
        GROUP BY COALESCE(NULLIF(p.device, ''), '(not reported)')
        HAVING SUM(p.revenue) > 0 OR SUM(p.sessions) > 0
        ORDER BY revenue DESC NULLS LAST`,
    };
  }

  if (p.source === 'outbrain' && p.view === 'country') {
    // Outbrain Country tab. Cost is per-country from outbrain_country_daily.
    //
    // DDC revenue joins here per country: DDC's `detail` report carries a
    // Country column (Codefuel does too; Image Advantage does not), and the sync
    // stores it. Before this, the tab showed Outbrain spend against a hard-coded
    // 0::numeric revenue — so SBH_ssm_09 read as $8,117 spend / $0 revenue even
    // though $6,270 of DDC revenue was sitting in partner_stats_hourly split by
    // country. Same defect the Site tab had.
    const obArgs: any[] = [p.from, p.to];
    let acctJoin  = '';
    let acctWhere = '';
    let ddcAcctWhere = '';
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 1) {
        const single = ids.length === 1;
        const i = obArgs.push(single ? ids[0] : ids);
        const cmp = single ? `= $${i}::int` : `= ANY($${i}::int[])`;
        acctJoin  = `LEFT JOIN ad_accounts _acc ON _acc.platform_id = 2 AND _acc.external_id = ocd.marketer_id`;
        acctWhere = `AND _acc.id ${cmp}`;
        ddcAcctWhere = `AND EXISTS (SELECT 1 FROM ad_accounts _da
                                     WHERE _da.client_partner_id = cp.id AND _da.id ${cmp})`;
      }
    }
    let ddcCountryClause = '';
    if (p.country) { const i = obArgs.push(p.country);
      ddcCountryClause = `AND p.country = ANY(string_to_array($${i}::text, ','))`; }
    return {
      args: obArgs,
      sql: `
        WITH ob_country_cost AS (
          SELECT ocd.country_code            AS country,
                 SUM(ocd.spent)::numeric     AS spent,
                 SUM(ocd.clicks)::bigint     AS clicks,
                 SUM(ocd.impressions)::bigint AS impressions,
                 SUM(ocd.conversions)::bigint AS conversions
          FROM outbrain_country_daily ocd
          ${acctJoin}
          WHERE ocd.day_utc >= $1::date
            AND ocd.day_utc <= $2::date
            ${acctWhere}
            ${p.country ? `AND ocd.country_code = ANY(string_to_array($${obArgs.length}::text, ','))` : ''}
          GROUP BY ocd.country_code
        ),
        ddc_country_rev AS (
          SELECT NULLIF(p.country, '')       AS country,
                 SUM(p.revenue)::numeric     AS revenue,
                 SUM(p.ad_clicks)::numeric   AS ad_clicks,
                 SUM(p.sessions)::numeric    AS sessions
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
          WHERE p.source_platform = 'Outbrain'
            AND p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${iaFeed}
            ${ddcGrainDedup('p')}
            ${ddcAcctWhere}
            ${ddcCountryClause}
          GROUP BY NULLIF(p.country, '')
        )
        SELECT
          COALESCE(c.country, r.country, '(Unattributed)')  AS country,
          COALESCE(c.impressions,0)::bigint                 AS impressions,
          COALESCE(c.clicks,0)::bigint                      AS clicks,
          ROUND(COALESCE(c.spent,0)::numeric, 2)            AS spent,
          COALESCE(r.revenue,0)                             AS revenue,
          COALESCE(c.conversions,0)::bigint                 AS conversions,
          COALESCE(r.ad_clicks,0)                           AS ad_clicks,
          COALESCE(r.sessions,0)                            AS sessions,
          COALESCE(r.revenue,0) - COALESCE(c.spent,0)       AS profit,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE c.spent*1000.0/c.impressions END                        AS actual_cpm,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE c.clicks*100.0/c.impressions END                        AS ctr_pct,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE c.spent/c.clicks END                                    AS actual_cpc,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE c.conversions*100.0/c.clicks END                        AS conversion_rate_pct,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE c.spent/c.conversions END                               AS actual_cpa,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE r.revenue/r.ad_clicks END                               AS rpc,
          CASE WHEN COALESCE(r.revenue,0)=0 THEN 0
               ELSE (r.revenue - COALESCE(c.spent,0))*100.0/r.revenue END   AS margin_pct,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)/r.ad_clicks END                     AS yahoo_cpa,
          COALESCE(c.conversions,0) - COALESCE(r.ad_clicks,0)               AS conversion_scrub,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE (c.conversions - COALESCE(r.ad_clicks,0))*100.0/c.conversions END AS scrub_rate_pct
        FROM ob_country_cost c
        FULL OUTER JOIN ddc_country_rev r ON r.country = c.country
        -- Drop rows with no activity at all. A FULL OUTER JOIN surfaces countries
        -- DDC reports with zero revenue and zero Outbrain cost (CH, AT, ES, NL,
        -- FR, FI, AU); they render as blank lines. Zero rows contribute nothing
        -- to any total, so suppressing them cannot change a number.
        WHERE COALESCE(c.spent,0) <> 0 OR COALESCE(c.impressions,0) <> 0
           OR COALESCE(c.clicks,0) <> 0 OR COALESCE(c.conversions,0) <> 0
           OR COALESCE(r.revenue,0) <> 0 OR COALESCE(r.ad_clicks,0) <> 0
           OR COALESCE(r.sessions,0) <> 0
        ORDER BY spent DESC NULLS LAST`,
    };
  }

  if (p.source === 'outbrain' && p.view === 'site') {
    // Outbrain Site tab. Cost is per-publisher from outbrain_publisher_daily.
    //
    // DDC revenue joins here per publisher: the second half of a DDC type tag is
    // Outbrain's 34-char publisher id, which is ALREADY stored as
    // outbrain_publisher_daily.publisher_uuid (metadata.id from the publishers
    // report). Note that is a DIFFERENT id from publisher_id (metadata.identifier,
    // a 4-6 digit numeric) — comparing those two is what made this look
    // unjoinable at first. Verified: 32 of 34 live DDC publisher hexes match,
    // covering 100.0% of publisher-attributed revenue.
    //
    // This is the first time the Outbrain Site tab shows revenue at all; it
    // previously hard-coded 0::numeric.
    //
    // The publisher macro only went live 2026-08-28, so DDC rows before that
    // carry item_ext_id = '' and are surfaced as one labelled row rather than
    // being dropped — the tab's revenue total still reconciles.
    const obArgs: any[] = [p.from, p.to];
    let acctJoin  = '';
    let acctWhere = '';
    let ddcAcctWhere = '';
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 1) {
        const single = ids.length === 1;
        const i = obArgs.push(single ? ids[0] : ids);
        const cmp = single ? `= $${i}::int` : `= ANY($${i}::int[])`;
        acctJoin  = `LEFT JOIN ad_accounts _acc ON _acc.platform_id = 2 AND _acc.external_id = opd.marketer_id`;
        acctWhere = `AND _acc.id ${cmp}`;
        // DDC rows are partner-scoped, not account-scoped, so resolve the
        // partner's own account(s) and honour the same filter.
        ddcAcctWhere = `AND EXISTS (SELECT 1 FROM ad_accounts _da
                                     WHERE _da.client_partner_id = cp.id AND _da.id ${cmp})`;
      }
    }
    return {
      args: obArgs,
      sql: `
        WITH ob_pub_cost AS (
          SELECT opd.publisher_uuid,
                 MAX(opd.publisher_name)     AS publisher_name,
                 MAX(opd.publisher_id)       AS publisher_id,
                 SUM(opd.spent)::numeric     AS spent,
                 SUM(opd.clicks)::bigint     AS clicks,
                 SUM(opd.impressions)::bigint AS impressions,
                 SUM(opd.conversions)::bigint AS conversions
          FROM outbrain_publisher_daily opd
          ${acctJoin}
          WHERE opd.day_utc >= $1::date
            AND opd.day_utc <= $2::date
            ${acctWhere}
          GROUP BY opd.publisher_uuid
        ),
        ddc_pub_rev AS (
          SELECT p.item_ext_id            AS publisher_uuid,
                 SUM(p.revenue)::numeric  AS revenue,
                 SUM(p.ad_clicks)::numeric AS ad_clicks,
                 SUM(p.sessions)::numeric AS sessions
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
          WHERE p.source_platform = 'Outbrain'
            AND p.item_ext_id IS NOT NULL AND p.item_ext_id <> ''
            AND p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            -- DDC writes granularity='daily', never 'x-daily', and the Outbrain
            -- MV branch emits revenue_flux = 0 — so under feed=flux this tab
            -- must show no DDC revenue, same as every other Outbrain view.
            ${iaFeed}
            ${ddcGrainDedup('p')}
            ${ddcAcctWhere}
          GROUP BY p.item_ext_id
        ),
        ddc_nopub AS (
          SELECT SUM(p.revenue)::numeric   AS revenue,
                 SUM(p.ad_clicks)::numeric AS ad_clicks,
                 SUM(p.sessions)::numeric  AS sessions
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'ddc'
          WHERE p.source_platform = 'Outbrain'
            AND (p.item_ext_id IS NULL OR p.item_ext_id = '')
            AND p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${iaFeed}
            ${ddcGrainDedup('p')}
            ${ddcAcctWhere}
        )
        SELECT
          COALESCE(c.publisher_name, '(publisher ' || COALESCE(c.publisher_id, r.publisher_uuid) || ')') AS site,
          ROUND(COALESCE(c.spent,0)::numeric, 2)     AS spent,
          COALESCE(c.clicks,0)::bigint               AS clicks,
          COALESCE(c.impressions,0)::bigint          AS impressions,
          COALESCE(c.conversions,0)::bigint          AS conversions,
          COALESCE(r.revenue,0)                      AS revenue,
          COALESCE(r.ad_clicks,0)                    AS ad_clicks,
          COALESCE(r.sessions,0)                     AS sessions,
          COALESCE(r.revenue,0) - COALESCE(c.spent,0) AS profit,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE c.spent*1000.0/c.impressions END                        AS actual_cpm,
          CASE WHEN COALESCE(c.impressions,0)=0 THEN 0
               ELSE c.clicks*100.0/c.impressions END                        AS ctr_pct,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE c.spent/c.clicks END                                    AS actual_cpc,
          CASE WHEN COALESCE(c.clicks,0)=0 THEN 0
               ELSE c.conversions*100.0/c.clicks END                        AS conversion_rate_pct,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE c.spent/c.conversions END                               AS actual_cpa,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE r.revenue/r.ad_clicks END                               AS rpc,
          CASE WHEN COALESCE(r.revenue,0)=0 THEN 0
               ELSE (r.revenue - COALESCE(c.spent,0))*100.0/r.revenue END   AS margin_pct,
          CASE WHEN COALESCE(r.ad_clicks,0)=0 THEN 0
               ELSE COALESCE(c.spent,0)/r.ad_clicks END                     AS yahoo_cpa,
          COALESCE(c.conversions,0) - COALESCE(r.ad_clicks,0)               AS conversion_scrub,
          CASE WHEN COALESCE(c.conversions,0)=0 THEN 0
               ELSE (c.conversions - COALESCE(r.ad_clicks,0))*100.0/c.conversions END AS scrub_rate_pct
        FROM ob_pub_cost c
        FULL OUTER JOIN ddc_pub_rev r ON r.publisher_uuid = c.publisher_uuid
        -- Same reason as the country view: suppress no-activity rows only.
        WHERE COALESCE(c.spent,0) <> 0 OR COALESCE(c.impressions,0) <> 0
           OR COALESCE(c.clicks,0) <> 0 OR COALESCE(c.conversions,0) <> 0
           OR COALESCE(r.revenue,0) <> 0 OR COALESCE(r.ad_clicks,0) <> 0
           OR COALESCE(r.sessions,0) <> 0

        UNION ALL

        -- DDC revenue with no publisher id. Mostly pre-2026-08-28, when the
        -- publisher macro went live, but NOT exclusively — $289.12 arrives after
        -- that date without one, so the label must not claim a cut-off date it
        -- does not filter on.
        SELECT
          '(DDC - publisher not reported)', 0, 0, 0, 0,
          n.revenue, n.ad_clicks, n.sessions, n.revenue,
          0, 0, 0, 0, 0,
          CASE WHEN n.ad_clicks = 0 THEN 0 ELSE n.revenue/n.ad_clicks END,
          CASE WHEN n.revenue   = 0 THEN 0 ELSE 100 END,
          0, -n.ad_clicks, 0
        FROM ddc_nopub n
        WHERE n.revenue > 0 OR n.sessions > 0

        ORDER BY spent DESC NULLS LAST`,
    };
  }

  if (p.source === 'outbrain' && p.view === 'ads') {
    const obArgs: any[] = [p.from, p.to];
    let acctWhere = '';
    // Same account filter for the -5 safety-net branch, which resolves its
    // account via oc2.marketer_id (it reads ia_camp_rev, not ob_cost — without
    // this it ignored the account filter and dumped ALL campaign-hex IA revenue
    // into any filtered view whose ob_cost came back empty).
    let acctWhereNet = '';
    let campWhere = '';
    // Account gate for the DDC unattributed row (-8). Unlike the Codefuel and IA
    // Outbrain orphan branches, the MV's ddc_orphan carries a real ad_account_id,
    // resolved with `ORDER BY id LIMIT 1` over the partner's accounts. This
    // reproduces that same pick so the two agree row for row.
    let ddcOrphanAcct = '';
    const DDC_ORPHAN_ACCT = `(SELECT _da.id FROM ad_accounts _da
                                JOIN client_partners _dp ON _dp.id = _da.client_partner_id AND _dp.code = 'ddc'
                               ORDER BY _da.id LIMIT 1)`;
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length === 1) {
        obArgs.push(ids[0]);
        acctWhere = `AND _acc.id = $${obArgs.length}::int`;
        acctWhereNet = `AND EXISTS (SELECT 1 FROM ad_accounts _acc2 WHERE _acc2.platform_id = 2 AND _acc2.external_id = oc2.marketer_id AND _acc2.id = $${obArgs.length}::int)`;
        ddcOrphanAcct = `AND ${DDC_ORPHAN_ACCT} = $${obArgs.length}::int`;
      } else if (ids.length > 1) {
        obArgs.push(ids);
        acctWhere = `AND _acc.id = ANY($${obArgs.length}::int[])`;
        acctWhereNet = `AND EXISTS (SELECT 1 FROM ad_accounts _acc2 WHERE _acc2.platform_id = 2 AND _acc2.external_id = oc2.marketer_id AND _acc2.id = ANY($${obArgs.length}::int[]))`;
        ddcOrphanAcct = `AND ${DDC_ORPHAN_ACCT} = ANY($${obArgs.length}::int[])`;
      }
    }
    if (p.gd) {
      obArgs.push(p.gd);
      // Same campaign scoping as the Taboola side. Written against c.ob_camp_id
      // so the campWhere.replace(...) alias rewrites below carry it too; the
      // subquery deliberately uses its own alias (oa9) so those replaces cannot
      // touch its internals.
      //
      // Those rewrites MUST use the /g regex, not a string argument: campWhere is
      // built with += and can now hold TWO occurrences (this clause and the
      // campaign_id one below). String .replace() rewrites only the FIRST, leaving
      // the second bound to alias `c`, which is not in scope in those branches --
      // "missing FROM-clause entry for table c", a hard 500 on exactly the
      // GD-then-campaign selection this change was meant to enable.
      campWhere += `AND c.ob_camp_id IN (SELECT oa9.campaign_id FROM outbrain_ads oa9
                     WHERE oa9.gd_param = ANY(string_to_array($${obArgs.length}::text, ',')))`;
    }
    if (p.campaign_id) {
      obArgs.push(p.campaign_id);
      campWhere += `AND c.ob_camp_id = ANY(string_to_array($${obArgs.length}::text, ','))`;
    }
    // Status was ignored here while the MV-backed Campaign tab applied it, so
    // the two tabs disagreed whenever Nadia touched the Status filter. Scope it
    // to the same campaigns the MV would keep.
    let obStatusWhere = '';
    if (p.status) {
      obArgs.push(p.status);
      obStatusWhere = `AND c.ob_camp_id IN (SELECT campaign_id FROM outbrain_campaigns
                                             WHERE status = ANY(string_to_array($${obArgs.length}::text, ',')))`;
    }
    const obFiltered = acctWhere !== '' || campWhere !== '' || obStatusWhere !== '';
    return {
      args: obArgs,
      sql: `
        WITH
        -- UNFILTERED cost universe: representative-link selection and the
        -- unattributed bucket must see every marketer's links, or an account
        -- filter would re-attribute another account's revenue to its own links.
        ob_cost_all AS (
          SELECT
            MAX(oad.promoted_link_id) AS promoted_link_id,
            oad.promoted_link_uuid,
            MAX(oad.ad_title)    AS ad_title,
            MAX(oad.landing_url) AS landing_url,
            MAX(oad.gd_param)    AS gd_param,
            MAX(oad.r_param)     AS r_param,
            oad.campaign_id AS ob_camp_id,
            oc.campaign_name, oc.marketer_id,
            SUM(oad.spent)       AS spent,
            SUM(oad.clicks)      AS clicks,
            SUM(oad.impressions) AS impressions,
            SUM(oad.conversions) AS conversions
          FROM outbrain_ad_daily oad
          JOIN outbrain_campaigns oc ON oc.campaign_id = oad.campaign_id
          WHERE oad.day_utc >= $1::date
            AND oad.day_utc <= $2::date
          -- Grouped on promoted_link_uuid ONLY, not on ad_title/landing_url.
          -- Editing an ad's title mid-window used to split one link into two
          -- ob_cost rows, and the link-keyed revenue joins below then attached
          -- the FULL revenue to BOTH — inventing revenue that exists nowhere in
          -- partner_stats_hourly. Measured before this fix: 32 duplicated uuids
          -- and $3,549.08 of phantom IA revenue in 2026-07-15..07-21 alone,
          -- $14,082.30 across the year. Title/url now come from MAX() so one
          -- link yields exactly one row whatever its title history.
          GROUP BY oad.promoted_link_uuid, oad.campaign_id,
                   oc.campaign_name, oc.marketer_id
          HAVING SUM(oad.spent) > 0 OR SUM(oad.impressions) > 0 OR SUM(oad.clicks) > 0
        ),
        -- Account/campaign-filtered slice — the rows this view displays.
        ob_cost AS (
          SELECT c.* FROM ob_cost_all c
          ${acctWhere ? `JOIN ad_accounts _acc ON _acc.platform_id = 2 AND _acc.external_id = c.marketer_id` : ''}
          WHERE TRUE
            ${acctWhere}
            ${campWhere}
            ${obStatusWhere}
        ),
        ob_cf_rev AS (
          SELECT psh.asset_gid AS gd_param, psh.channel AS r_param,
                 SUM(psh.revenue)   AS revenue,
                 SUM(psh.ad_clicks) AS ad_clicks,
                 SUM(psh.sessions)  AS sessions
          FROM partner_stats_hourly psh
          JOIN client_partners cp ON cp.id = psh.client_partner_id AND cp.code = 'codefuel'
          WHERE psh.source_platform = 'Outbrain'
            AND psh.hour_utc >= $1::timestamptz
            AND psh.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            -- Feed filter: Codefuel has no x-daily (Flux) rows, so under
            -- feed=flux this must return nothing. Without it the Ads tab showed
            -- full Codefuel revenue while the Campaign tab (whose MV branch
            -- emits revenue_flux = 0) showed $0 — breaking Campaign == Ads.
            ${iaFeed.replace(/p\.granularity/g, 'psh.granularity')}
          GROUP BY psh.asset_gid, psh.channel
        ),
        -- All IA-Outbrain revenue by user_tag hex (ob:<hex>) for the window.
        ia_raw AS (
          SELECT regexp_replace(psh.campaign_ext_id, '^ob:', '') AS hex,
                 SUM(psh.revenue)   AS revenue,
                 SUM(psh.ad_clicks) AS ad_clicks,
                 SUM(psh.sessions)  AS sessions
          FROM partner_stats_hourly psh
          JOIN client_partners cp ON cp.id = psh.client_partner_id AND cp.code = 'image_advantage'
          WHERE psh.source_platform = 'Outbrain'
            AND psh.campaign_ext_id LIKE 'ob:%'
            AND psh.hour_utc >= $1::timestamptz
            AND psh.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${iaFeed.replace(/p\.granularity/g, 'psh.granularity')}
          GROUP BY 1
        ),
        -- Promoted-link UUIDs that have cost in the window. The IA user_tag hex is
        -- EITHER a promoted-link uuid (→ attribute to that ad) OR a campaign id
        -- (→ campaign-level only). This split lets ~half of IA-Outbrain revenue
        -- land on the SAME row as the ad's cost instead of as orphan rows.
        all_link_uuids AS (
          SELECT DISTINCT promoted_link_uuid FROM outbrain_ad_daily
          WHERE day_utc >= $1::date AND day_utc <= $2::date AND promoted_link_uuid IS NOT NULL
        ),
        -- IA revenue attributable to a specific promoted link (joins to cost below).
        ia_link_rev AS (
          SELECT r.hex AS link_uuid, r.revenue, r.ad_clicks, r.sessions
          FROM ia_raw r
          JOIN all_link_uuids u ON u.promoted_link_uuid = r.hex
        ),
        -- Remaining IA revenue (hex = campaign id, not a promoted link) → pooled per campaign.
        ia_camp_rev AS (
          SELECT COALESCE(ocd.campaign_id, al.campaign_id) AS ob_camp_id,
                 SUM(r.revenue) AS revenue, SUM(r.ad_clicks) AS ad_clicks, SUM(r.sessions) AS sessions
          FROM ia_raw r
          LEFT JOIN all_link_uuids u   ON u.promoted_link_uuid = r.hex
          LEFT JOIN outbrain_campaigns ocd ON ocd.campaign_id = r.hex
          LEFT JOIN outbrain_ad_links  al  ON al.link_id      = r.hex
          WHERE u.promoted_link_uuid IS NULL
            AND COALESCE(ocd.campaign_id, al.campaign_id) IS NOT NULL
          GROUP BY 1
        ),
        -- Per-campaign cost totals, used to spread campaign-level revenue across ads.
        camp_tot AS (
          SELECT ob_camp_id, SUM(clicks) AS tc, SUM(impressions) AS ti, COUNT(*) AS n
          FROM ob_cost GROUP BY ob_camp_id
        ),
        -- Allocate campaign-level IA revenue to each ad of the campaign by its share
        -- of the campaign's Outbrain clicks (→ impressions → equal as fallbacks).
        -- For single-ad campaigns this is exact; for multi-ad it is a traffic-weighted
        -- estimate (the source data has no per-ad breakdown for these).
        ia_camp_alloc AS (
          SELECT c.promoted_link_uuid AS link_uuid,
                 SUM(cr.revenue   * w.share) AS revenue,
                 SUM(cr.ad_clicks * w.share) AS ad_clicks,
                 SUM(cr.sessions  * w.share) AS sessions
          FROM ob_cost c
          JOIN ia_camp_rev cr ON cr.ob_camp_id = c.ob_camp_id
          JOIN camp_tot   ct ON ct.ob_camp_id = c.ob_camp_id
          JOIN LATERAL (
            SELECT CASE WHEN ct.tc > 0 THEN c.clicks::numeric / ct.tc
                        WHEN ct.ti > 0 THEN c.impressions::numeric / ct.ti
                        ELSE 1.0 / ct.n END AS share
          ) w ON TRUE
          GROUP BY c.promoted_link_uuid
        ),
        -- CF revenue lands on ONE representative promoted link per (gd, r):
        -- prefer a link in the campaign that outbrain_ads maps the (gd, r) to
        -- (the MV's attribution rule), then highest spend. Selected from the
        -- UNFILTERED universe: multiple links across accounts can share the
        -- same landing params — choosing within a filtered slice re-attributed
        -- other accounts' revenue, and joining to every match multiplied it.
        cf_rep_link AS (
          -- The MV sends this revenue to outbrain_ads.campaign_id UNCONDITIONALLY
          -- (043 ob_cf_rev). This CTE used to only *prefer* that campaign in its
          -- ORDER BY and would silently fall back to any other costed link for
          -- the same (gd, r) — often in a DIFFERENT ACCOUNT — whenever the mapped
          -- campaign had no cost in the window. That is what made Campaign != Ads
          -- for the two accounts that share landing pairs: +/-$9.91 in August,
          -- offsetting between ssm_01 and ssm_02, so it netted to zero across all
          -- accounts and only appeared under an account filter.
          -- Now the representative link MUST belong to the mapped campaign.
          -- Revenue whose mapped campaign has no costed link in the window is
          -- picked up by the campaign-level row below, not reassigned elsewhere.
          SELECT DISTINCT ON (cf.gd_param, cf.r_param)
                 c.promoted_link_id AS link_key,
                 cf.gd_param, cf.r_param, cf.revenue, cf.ad_clicks, cf.sessions
          FROM ob_cf_rev cf
          JOIN outbrain_ads oa ON oa.gd_param = cf.gd_param AND oa.r_param = cf.r_param
          JOIN ob_cost_all c  ON c.gd_param  = cf.gd_param AND c.r_param  = cf.r_param
                             AND c.ob_camp_id = oa.campaign_id
          ORDER BY cf.gd_param, cf.r_param, c.spent DESC, c.promoted_link_id
        ),
        -- Codefuel revenue whose mapped campaign exists but has no costed link in
        -- this window. The MV still books it to that campaign, so surface it as a
        -- campaign-level row rather than dropping it or moving it to another ad.
        cf_camp_only AS (
          SELECT oa.campaign_id AS ob_camp_id,
                 SUM(cf.revenue) AS revenue, SUM(cf.ad_clicks) AS ad_clicks, SUM(cf.sessions) AS sessions
          FROM ob_cf_rev cf
          JOIN outbrain_ads oa ON oa.gd_param = cf.gd_param AND oa.r_param = cf.r_param
          WHERE NOT EXISTS (
            SELECT 1 FROM ob_cost_all c2
             WHERE c2.gd_param = cf.gd_param AND c2.r_param = cf.r_param
               AND c2.ob_camp_id = oa.campaign_id)
          GROUP BY oa.campaign_id
        ),
        -- ── DDC (third revenue partner) ───────────────────────────────────────
        -- DDC keys revenue by its tt type tag. That tag is NOT an Outbrain id
        -- for most campaigns — the client hand-made ~100 unique 34-char tags
        -- when DDC capped her, and they exist only inside the ad's landing URL
        -- (?tt=...), stored as outbrain_ad_links.tt_param by migration 042.
        -- Older campaigns (and new ones, per the client) use the ad_id macro, so
        -- BOTH shapes must resolve. Mirrors migration 043 exactly.
        ddc_raw AS (
          SELECT regexp_replace(psh.campaign_ext_id, '^ob:', '') AS tt,
                 psh.hour_utc::date AS day_utc,
                 SUM(psh.revenue)   AS revenue,
                 SUM(psh.ad_clicks) AS ad_clicks,
                 SUM(psh.sessions)  AS sessions
          FROM partner_stats_hourly psh
          JOIN client_partners cp ON cp.id = psh.client_partner_id AND cp.code = 'ddc'
          WHERE psh.source_platform = 'Outbrain'
            AND psh.campaign_ext_id LIKE 'ob:%'
            AND psh.hour_utc >= $1::timestamptz
            AND psh.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            ${iaFeed.replace(/p\.granularity/g, 'psh.granularity')}
            ${ddcGrainDedup('psh')}
          GROUP BY 1, 2
        ),
        -- tag -> candidate promoted link. UNION so a tag that is both a
        -- tt_param and a link_id produces a single candidate, not two.
        -- split_part strips the literal '_{{publisher_id}}' macro suffix the
        -- URL template has carried since ~2026-08-28: tt_param is stored RAW
        -- from the landing URL, while the DDC sync stores only the BASE tag
        -- (parseTypeTag splits at the first underscore, and the DDC-side tag
        -- can therefore never contain one). Exact matching missed every
        -- post-macro link, so the ads actually taking the traffic were
        -- invisible and their revenue was equal-split across old links that
        -- share the base tag — campaigns with ZERO traffic showed revenue.
        -- Mirrors migration 046 exactly.
        ddc_tt_link AS (
          SELECT split_part(al.tt_param, '_', 1) AS tt, al.link_id, al.campaign_id
          FROM outbrain_ad_links al
          WHERE al.tt_param IS NOT NULL AND split_part(al.tt_param, '_', 1) <> ''
          UNION
          SELECT al.link_id AS tt, al.link_id, al.campaign_id FROM outbrain_ad_links al
          UNION
          SELECT oc.campaign_id AS tt, NULL::text AS link_id, oc.campaign_id
          FROM outbrain_campaigns oc
        ),
        -- Split each (tag, day) across its candidate links by each link's real
        -- clicks over a trailing 7-day window (revenue day and the 6 days
        -- before it) — DDC revenue comes from searches that happen AFTER the
        -- ad click, so revenue on day D often belongs to a click on D-1 or
        -- earlier, and the window also covers days whose Outbrain cost has
        -- not synced yet. Joining every candidate would multiply revenue;
        -- weighting conserves it. Campaign-id-macro candidates (link_id IS
        -- NULL) weigh by the campaign's own clicks over the same window; the
        -- two LEFT JOIN conditions are mutually exclusive on l.link_id, so
        -- they cannot fan out against each other. Reads the cost tables
        -- directly (not ob_cost), so the window may reach before $1.
        ddc_cand AS (
          SELECT r.tt, r.day_utc, l.link_id,
                 COALESCE(SUM(CASE WHEN l.link_id IS NOT NULL THEN oad.clicks
                                   ELSE osd.clicks END), 0)::numeric AS clicks
          FROM ddc_raw r
          JOIN ddc_tt_link l ON l.tt = r.tt
          LEFT JOIN outbrain_ad_daily oad
                 ON l.link_id IS NOT NULL
                AND oad.promoted_link_uuid = l.link_id
                AND oad.day_utc BETWEEN r.day_utc - 6 AND r.day_utc
          LEFT JOIN outbrain_stats_daily osd
                 ON l.link_id IS NULL
                AND osd.campaign_id = l.campaign_id
                AND osd.day_utc BETWEEN r.day_utc - 6 AND r.day_utc
          GROUP BY r.tt, r.day_utc, l.link_id
        ),
        -- Shares are clicks / total-window-clicks per (tag, day): they sum to
        -- exactly 1 wherever any candidate had traffic. There is NO
        -- equal-split fallback any more — it invented attribution by handing
        -- revenue to candidate campaigns that ran zero traffic (the client
        -- caught $40.79 of phantom revenue on zero-traffic campaigns on
        -- 2026-09-07 alone). A (tag, day) with no candidate traffic in the
        -- whole window routes to the -8 unattributed row below instead.
        -- clicks > 0 drops zero-weight candidates so no zero-revenue ad rows
        -- appear.
        ddc_alloc AS (
          SELECT c.tt, c.day_utc, c.link_id, c.clicks / t.tot AS share
          FROM ddc_cand c
          JOIN (SELECT tt, day_utc, SUM(clicks) AS tot
                FROM ddc_cand GROUP BY tt, day_utc) t
            ON t.tt = c.tt AND t.day_utc = c.day_utc AND t.tot > 0
          WHERE c.clicks > 0
        ),
        -- DDC revenue landed on the promoted link that earned it.
        ddc_link_rev AS (
          SELECT a.link_id AS link_uuid,
                 SUM(r.revenue   * a.share) AS revenue,
                 SUM(r.ad_clicks * a.share) AS ad_clicks,
                 SUM(r.sessions  * a.share) AS sessions
          FROM ddc_alloc a
          JOIN ddc_raw r ON r.tt = a.tt AND r.day_utc = a.day_utc
          WHERE a.link_id IS NOT NULL
          GROUP BY a.link_id
        ),
        -- Tag resolved only to a campaign (campaign_id macro), never to a link.
        ddc_camp_rev AS (
          SELECT l.campaign_id AS ob_camp_id,
                 SUM(r.revenue   * a.share) AS revenue,
                 SUM(r.ad_clicks * a.share) AS ad_clicks,
                 SUM(r.sessions  * a.share) AS sessions
          FROM ddc_alloc a
          JOIN ddc_raw r ON r.tt = a.tt AND r.day_utc = a.day_utc
          JOIN ddc_tt_link l ON l.tt = a.tt AND l.link_id IS NULL
          WHERE a.link_id IS NULL
          GROUP BY l.campaign_id
        ),
        camp_tot_ddc AS (
          SELECT ob_camp_id, SUM(clicks) AS tc, SUM(impressions) AS ti, COUNT(*) AS n
          FROM ob_cost GROUP BY ob_camp_id
        ),
        ddc_camp_alloc AS (
          SELECT c.promoted_link_uuid AS link_uuid,
                 SUM(cr.revenue   * w.share) AS revenue,
                 SUM(cr.ad_clicks * w.share) AS ad_clicks,
                 SUM(cr.sessions  * w.share) AS sessions
          FROM ob_cost c
          JOIN ddc_camp_rev cr ON cr.ob_camp_id = c.ob_camp_id
          JOIN camp_tot_ddc ct ON ct.ob_camp_id = c.ob_camp_id
          JOIN LATERAL (
            SELECT CASE WHEN ct.tc > 0 THEN c.clicks::numeric / ct.tc
                        WHEN ct.ti > 0 THEN c.impressions::numeric / ct.ti
                        ELSE 1.0 / ct.n END AS share
          ) w ON TRUE
          GROUP BY c.promoted_link_uuid
        )
        -- Per-promoted-link rows: cost + CF revenue (gd,r) + IA revenue (link uuid),
        -- so each ad's cost and revenue reconcile on the same row.
        SELECT
          b.ad_id, b.taboola_ad_id, b.ad_title, b.gd_param, b.r_param,
          b.campaign_id, b.campaign_name,
          b.revenue, b.ad_clicks, b.sessions, b.impressions, b.clicks, b.conversions, b.spent,
          CASE WHEN b.impressions=0 THEN 0 ELSE b.spent*1000.0/b.impressions END AS actual_cpm,
          CASE WHEN b.impressions=0 THEN 0 ELSE b.clicks*100.0/b.impressions END AS ctr_pct,
          CASE WHEN b.clicks=0 THEN 0 ELSE b.spent/b.clicks END                  AS actual_cpc,
          CASE WHEN b.clicks=0 THEN 0 ELSE b.conversions*100.0/b.clicks END       AS conversion_rate_pct,
          CASE WHEN b.conversions=0 THEN 0 ELSE b.spent/b.conversions END         AS actual_cpa,
          CASE WHEN b.ad_clicks=0 THEN 0 ELSE b.revenue/b.ad_clicks END           AS rpc,
          CASE WHEN b.revenue=0 THEN 0 ELSE (b.revenue - b.spent)*100.0/b.revenue END AS margin_pct,
          b.revenue - b.spent                                                     AS profit,
          CASE WHEN b.ad_clicks=0 THEN 0 ELSE b.spent/b.ad_clicks END             AS yahoo_cpa,
          b.conversions - b.ad_clicks                                             AS conversion_scrub,
          CASE WHEN b.conversions=0 THEN 0
               ELSE (b.conversions - b.ad_clicks)*100.0/b.conversions END         AS scrub_rate_pct
        FROM (
          SELECT
            -4::int AS ad_id,
            COALESCE(c.promoted_link_uuid, c.promoted_link_id) AS taboola_ad_id,
            c.ad_title, c.gd_param, c.r_param,
            c.ob_camp_id AS campaign_id, c.campaign_name,
            (COALESCE(cf.revenue,0)   + COALESCE(ial.revenue,0)   + COALESCE(ica.revenue,0)
                                      + COALESCE(dl.revenue,0)    + COALESCE(dca.revenue,0))   AS revenue,
            (COALESCE(cf.ad_clicks,0) + COALESCE(ial.ad_clicks,0) + COALESCE(ica.ad_clicks,0)
                                      + COALESCE(dl.ad_clicks,0)  + COALESCE(dca.ad_clicks,0)) AS ad_clicks,
            (COALESCE(cf.sessions,0)  + COALESCE(ial.sessions,0)  + COALESCE(ica.sessions,0)
                                      + COALESCE(dl.sessions,0)   + COALESCE(dca.sessions,0))  AS sessions,
            COALESCE(c.impressions,0) AS impressions,
            COALESCE(c.clicks,0)      AS clicks,
            COALESCE(c.conversions,0) AS conversions,
            COALESCE(c.spent,0)       AS spent
          FROM ob_cost c
          LEFT JOIN cf_rep_link    cf  ON cf.link_key = c.promoted_link_id
          LEFT JOIN ia_link_rev    ial ON ial.link_uuid = c.promoted_link_uuid
          LEFT JOIN ia_camp_alloc  ica ON ica.link_uuid = c.promoted_link_uuid
          LEFT JOIN ddc_link_rev   dl  ON dl.link_uuid  = c.promoted_link_uuid
          LEFT JOIN ddc_camp_alloc dca ON dca.link_uuid = c.promoted_link_uuid
        ) b

        UNION ALL

        -- Safety net: campaign-level IA revenue for campaigns that have NO cost ads
        -- in the window (so it can't be allocated). Normally ~$0; shown as one row
        -- per campaign so the tab total never silently drops revenue.
        SELECT
          -5::int                                                        AS ad_id,
          'IA · OB · ' || COALESCE(ia.ob_camp_id, '?')                 AS taboola_ad_id,
          NULL::text                                                     AS ad_title,
          NULL::text AS gd_param, NULL::text AS r_param,
          ia.ob_camp_id                                                  AS campaign_id,
          COALESCE(oc2.campaign_name, '(Outbrain IA — no ad-level cost)') AS campaign_name,
          ia.revenue, ia.ad_clicks, ia.sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN ia.ad_clicks=0 THEN 0 ELSE ia.revenue/ia.ad_clicks END AS rpc,
          CASE WHEN ia.revenue=0 THEN 0 ELSE 100 END                    AS margin_pct,
          ia.revenue                                                     AS profit,
          0::numeric AS yahoo_cpa, -ia.ad_clicks AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM ia_camp_rev ia
        LEFT JOIN outbrain_campaigns oc2 ON oc2.campaign_id = ia.ob_camp_id
        WHERE (ia.revenue > 0 OR ia.sessions > 0)
          AND ia.ob_camp_id NOT IN (SELECT DISTINCT ob_camp_id FROM ob_cost)
          ${obStatusWhere.replace(/c\.ob_camp_id/g, 'ia.ob_camp_id')}
          ${acctWhereNet}
          ${campWhere.replace(/c\.ob_camp_id/g, 'ia.ob_camp_id')}

        UNION ALL

        -- DDC equivalent of the -5 row: campaign-level DDC revenue for campaigns
        -- with NO cost ads in the window, so it cannot be allocated. One row per
        -- campaign, so the tab total never silently drops revenue.
        SELECT
          -7::int                                                        AS ad_id,
          'DDC - OB - ' || COALESCE(dc.ob_camp_id, '?')                  AS taboola_ad_id,
          NULL::text                                                     AS ad_title,
          NULL::text AS gd_param, NULL::text AS r_param,
          dc.ob_camp_id                                                  AS campaign_id,
          COALESCE(oc3.campaign_name, '(Outbrain DDC - no ad-level cost)') AS campaign_name,
          dc.revenue, dc.ad_clicks, dc.sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN dc.ad_clicks=0 THEN 0 ELSE dc.revenue/dc.ad_clicks END AS rpc,
          CASE WHEN dc.revenue=0 THEN 0 ELSE 100 END                    AS margin_pct,
          dc.revenue                                                     AS profit,
          0::numeric AS yahoo_cpa, -dc.ad_clicks AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM ddc_camp_rev dc
        LEFT JOIN outbrain_campaigns oc3 ON oc3.campaign_id = dc.ob_camp_id
        WHERE (dc.revenue > 0 OR dc.sessions > 0)
          AND dc.ob_camp_id NOT IN (SELECT DISTINCT ob_camp_id FROM ob_cost)
          ${obStatusWhere.replace(/c\.ob_camp_id/g, 'dc.ob_camp_id')}
          ${acctWhereNet.replace(/oc2\./g, 'oc3.').replace(/_acc2/g, '_acc3')}
          ${campWhere.replace(/c\.ob_camp_id/g, 'dc.ob_camp_id')}

        UNION ALL

        -- Codefuel revenue booked to a campaign that has no costed ad in this
        -- window. The MV keeps it on that campaign, so it must appear here too
        -- or Ads sits below Campaign. Uses ad_id -9.
        SELECT
          -9::int                                                        AS ad_id,
          'CF - OB - ' || COALESCE(cc.ob_camp_id, '?')                   AS taboola_ad_id,
          NULL::text                                                     AS ad_title,
          NULL::text AS gd_param, NULL::text AS r_param,
          cc.ob_camp_id                                                  AS campaign_id,
          COALESCE(oc5.campaign_name, '(Outbrain Codefuel - no ad-level cost)') AS campaign_name,
          cc.revenue, cc.ad_clicks, cc.sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN cc.ad_clicks=0 THEN 0 ELSE cc.revenue/cc.ad_clicks END AS rpc,
          CASE WHEN cc.revenue=0 THEN 0 ELSE 100 END                     AS margin_pct,
          cc.revenue                                                     AS profit,
          0::numeric AS yahoo_cpa, -cc.ad_clicks AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM cf_camp_only cc
        LEFT JOIN outbrain_campaigns oc5 ON oc5.campaign_id = cc.ob_camp_id
        WHERE (cc.revenue > 0 OR cc.sessions > 0)
          ${obStatusWhere.replace(/c\.ob_camp_id/g, 'cc.ob_camp_id')}
          ${acctWhereNet.replace(/oc2\./g, 'oc5.').replace(/_acc2/g, '_acc5')}
          ${campWhere.replace(/c\.ob_camp_id/g, 'cc.ob_camp_id')}

        UNION ALL

        -- DDC revenue allocated to a promoted link that has NO cost in this
        -- window (paused or archived ad). The MV keeps it at campaign level, so
        -- without this row the Ads tab would sit below Campaign — it was exactly
        -- $0.48 on a $6,811.28 account before this branch existed.
        SELECT
          -7::int                                                        AS ad_id,
          'DDC - OB - ' || COALESCE(al2.campaign_id, '?')                AS taboola_ad_id,
          NULL::text                                                     AS ad_title,
          NULL::text AS gd_param, NULL::text AS r_param,
          al2.campaign_id                                                AS campaign_id,
          COALESCE(oc4.campaign_name, '(Outbrain DDC - ad has no cost in range)') AS campaign_name,
          SUM(dl.revenue) AS revenue, SUM(dl.ad_clicks) AS ad_clicks, SUM(dl.sessions) AS sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN SUM(dl.ad_clicks)=0 THEN 0 ELSE SUM(dl.revenue)/SUM(dl.ad_clicks) END AS rpc,
          CASE WHEN SUM(dl.revenue)=0 THEN 0 ELSE 100 END                AS margin_pct,
          SUM(dl.revenue)                                                AS profit,
          0::numeric AS yahoo_cpa, -SUM(dl.ad_clicks) AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM ddc_link_rev dl
        JOIN outbrain_ad_links al2 ON al2.link_id = dl.link_uuid
        LEFT JOIN outbrain_campaigns oc4 ON oc4.campaign_id = al2.campaign_id
        WHERE NOT EXISTS (SELECT 1 FROM ob_cost c2 WHERE c2.promoted_link_uuid = dl.link_uuid)
          -- Status must be applied here too. Without it, a status filter that
          -- empties ob_cost makes EVERY link "uncosted" and this branch leaks
          -- the account's whole revenue while the Campaign tab shows $0.00.
          ${obStatusWhere.replace(/c\.ob_camp_id/g, 'al2.campaign_id')}
          ${acctWhereNet.replace(/oc2\./g, 'oc4.').replace(/_acc2/g, '_acc4')}
          ${campWhere.replace(/c\.ob_camp_id/g, 'al2.campaign_id')}
        GROUP BY al2.campaign_id, oc4.campaign_name
        HAVING SUM(dl.revenue) <> 0 OR SUM(dl.sessions) <> 0

        UNION ALL

        -- Unattributable Outbrain revenue: CF rows whose (gd, r) matches no
        -- promoted link with cost in the window, plus IA hexes that resolve to
        -- neither a link nor a campaign (broken tracking templates). One
        -- aggregate row so the tab total reconciles with the Campaign tab.
        -- Cannot be attributed to an account/campaign, so it only shows on the
        -- unfiltered view — same convention as the Codefuel orphan rows.
        SELECT
          -6::int                                                        AS ad_id,
          '(Unattributed - Outbrain)'::text                              AS taboola_ad_id,
          NULL::text AS ad_title, NULL::text AS gd_param, NULL::text AS r_param,
          NULL::text AS campaign_id,
          '(Unattributed - Outbrain)'::text                              AS campaign_name,
          t.revenue, t.ad_clicks, t.sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN t.ad_clicks=0 THEN 0 ELSE t.revenue/t.ad_clicks END  AS rpc,
          CASE WHEN t.revenue=0 THEN 0 ELSE 100 END                      AS margin_pct,
          t.revenue                                                      AS profit,
          0::numeric AS yahoo_cpa, -t.ad_clicks AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM (
          SELECT COALESCE(SUM(x.revenue),0) AS revenue,
                 COALESCE(SUM(x.ad_clicks),0) AS ad_clicks,
                 COALESCE(SUM(x.sessions),0) AS sessions
          FROM (
            -- Mirror the MV's ob_cf_orphan exactly: Codefuel-Outbrain revenue
            -- with NO outbrain_ads mapping at all. Previously this tested for
            -- "no costed link in the window", which is a different set — revenue
            -- that IS mapped but whose campaign had no cost in range fell
            -- through both this branch and cf_rep_link and vanished.
            SELECT cf.revenue, cf.ad_clicks, cf.sessions FROM ob_cf_rev cf
            WHERE NOT EXISTS (SELECT 1 FROM outbrain_ads oa2
                              WHERE oa2.gd_param = cf.gd_param AND oa2.r_param = cf.r_param)
            UNION ALL
            SELECT r.revenue, r.ad_clicks, r.sessions FROM ia_raw r
            LEFT JOIN all_link_uuids u       ON u.promoted_link_uuid = r.hex
            LEFT JOIN outbrain_campaigns ocd ON ocd.campaign_id = r.hex
            LEFT JOIN outbrain_ad_links al   ON al.link_id = r.hex
            WHERE u.promoted_link_uuid IS NULL
              AND ocd.campaign_id IS NULL AND al.campaign_id IS NULL
            UNION ALL
            -- IA-Outbrain rows with NO parseable user_tag at all (broken 'ut'
            -- macro): stored with campaign_ext_id NULL. The MV counts them as
            -- IA orphans; without this they silently vanished from this tab.
            SELECT p.revenue, p.ad_clicks, p.sessions
            FROM partner_stats_hourly p
            JOIN client_partners cp2 ON cp2.id = p.client_partner_id AND cp2.code = 'image_advantage'
            WHERE p.source_platform = 'Outbrain'
              AND p.campaign_ext_id IS NULL
              AND p.hour_utc >= $1::timestamptz
              AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
              ${iaFeed}
          ) x
        ) t
        WHERE (t.revenue > 0 OR t.sessions > 0)
          AND ${obFiltered ? 'FALSE' : 'TRUE'}

        UNION ALL

        -- Unattributed DDC revenue — its OWN row, deliberately NOT folded into
        -- the -6 row above.
        --
        -- The -6 row is suppressed under any account/campaign filter, because the
        -- MV's ob_cf_orphan and ob_ia_orphan branches emit ad_account_id NULL and
        -- so the Campaign tab drops them under a filter too. DDC is different:
        -- migration 041's ddc_orphan branch carries a REAL ad_account_id (DDC is
        -- a single-account partner), so the Campaign tab KEEPS this revenue when
        -- Nadia filters to SBH_ssm_09. It is also the majority path — 86.7% of
        -- DDC revenue over 15/28/29/30 Aug ($782.20 of $902.62) resolves to no
        -- Outbrain object. Suppressing it here would leave the Ads tab ~83% below
        -- the Campaign tab on the one account filter she will actually use.
        --
        -- The account gate reproduces the MV lateral exactly (ORDER BY id LIMIT 1
        -- over the partner's accounts), so the two agree row for row and not just
        -- in aggregate. A campaign filter drops the row, matching the MV where
        -- campaign_external_id is NULL for this branch.
        SELECT
          -8::int                                                        AS ad_id,
          '(Unattributed - DDC)'::text                                   AS taboola_ad_id,
          NULL::text AS ad_title, NULL::text AS gd_param, NULL::text AS r_param,
          NULL::text                                                     AS campaign_id,
          '(Unattributed - DDC)'::text                                   AS campaign_name,
          t.revenue, t.ad_clicks, t.sessions,
          0::numeric AS impressions, 0::numeric AS clicks,
          0::numeric AS conversions, 0::numeric AS spent,
          0::numeric AS actual_cpm, 0::numeric AS ctr_pct,
          0::numeric AS actual_cpc, 0::numeric AS conversion_rate_pct,
          0::numeric AS actual_cpa,
          CASE WHEN t.ad_clicks=0 THEN 0 ELSE t.revenue/t.ad_clicks END  AS rpc,
          CASE WHEN t.revenue=0 THEN 0 ELSE 100 END                      AS margin_pct,
          t.revenue                                                      AS profit,
          0::numeric AS yahoo_cpa, -t.ad_clicks AS conversion_scrub,
          0::numeric AS scrub_rate_pct
        FROM (
          SELECT COALESCE(SUM(x.revenue),0) AS revenue,
                 COALESCE(SUM(x.ad_clicks),0) AS ad_clicks,
                 COALESCE(SUM(x.sessions),0) AS sessions
          FROM (
            -- DDC (tag, day)s that produced NO allocation: the tag resolves to
            -- no promoted link or campaign at all (unsubstituted macros, test
            -- values), OR none of its candidates had a single click in the
            -- trailing window. Exact complement of ddc_alloc, matching the
            -- MV's ddc_orphan rule (migration 046) — revenue is never given to
            -- a campaign that ran no traffic, and never dropped either.
            SELECT r.revenue, r.ad_clicks, r.sessions FROM ddc_raw r
            WHERE NOT EXISTS (SELECT 1 FROM ddc_alloc a
                              WHERE a.tt = r.tt AND a.day_utc = r.day_utc)
            UNION ALL
            -- DDC rows with no parseable 'ob:' tag at all. The MV routes these
            -- to ddc_orphan too; without this they would vanish from this tab.
            SELECT p.revenue, p.ad_clicks, p.sessions
            FROM partner_stats_hourly p
            JOIN client_partners cp3 ON cp3.id = p.client_partner_id AND cp3.code = 'ddc'
            WHERE p.source_platform = 'Outbrain'
              AND (p.campaign_ext_id IS NULL OR p.campaign_ext_id NOT LIKE 'ob:%')
              AND p.hour_utc >= $1::timestamptz
              AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
              ${iaFeed}
              -- Same grain de-dup as ddc_raw above. The MV's ddc_orphan reads
              -- ddc_rows, which is built on the already-deduped ps CTE, so
              -- this arm has to dedup too: without it a day carrying BOTH
              -- grains would be counted twice here while the Campaign tab
              -- counted it once. It matches no rows today (DDC always writes an
              -- 'ob:'/'tb:' prefix), but leaving it out is exactly the hazard
              -- the hourly feed introduced.
              ${ddcGrainDedup('p')}
          ) x
        ) t
        WHERE (t.revenue > 0 OR t.sessions > 0)
          ${campWhere ? 'AND FALSE' : ''}
          ${ddcOrphanAcct}

        ORDER BY revenue DESC NULLS LAST, spent DESC NULLS LAST`,
    };
  }

  if (p.view === 'site') {
    // Publisher-site report. Cost comes from taboola_geo_cost_daily
    // (dim_type='site', dim_id = Taboola site_id). Image Advantage revenue joins
    // per site because IA's item_ext_id IS the Taboola site_id (verified: 100% of
    // IA revenue matches). Codefuel reports no site breakdown, so its revenue is
    // shown as one aggregate row to keep the tab's revenue total reconciling.
    // Site cost is account-grain only: it cannot be scoped to a campaign or gd
    // filter, so those filters return an empty set rather than misleading rows.
    if (p.campaign_id || p.gd) {
      return {
        args: [],
        sql: `SELECT ''::text AS site,
                     0::numeric AS impressions, 0::numeric AS clicks, 0::numeric AS spent,
                     0::numeric AS revenue, 0::numeric AS conversions, 0::numeric AS ad_clicks,
                     0::numeric AS sessions, 0::numeric AS profit, 0::numeric AS actual_cpm,
                     0::numeric AS ctr_pct, 0::numeric AS actual_cpc,
                     0::numeric AS conversion_rate_pct, 0::numeric AS actual_cpa,
                     0::numeric AS rpc, 0::numeric AS margin_pct,
                     0::numeric AS yahoo_cpa, 0::numeric AS conversion_scrub,
                     0::numeric AS scrub_rate_pct
              WHERE FALSE`,
      };
    }
    const siteArgs: any[] = [p.from, p.to];
    let siteAcctClause   = ''; // cost rows, keyed g.ad_account_id
    let siteIaClause     = ''; // IA revenue, account via campaign mapping
    let siteCfMapClause  = ''; // CF mapped revenue, account via ads mapping
    let siteCfOrphClause = ''; // CF orphan revenue, account via gid/ch resolution
    if (p.account_id && p.account_id !== 'all') {
      const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      if (ids.length >= 1) {
        const single = ids.length === 1;
        const i = siteArgs.push(single ? ids[0] : ids);
        const cmp = single ? `= $${i}::int` : `= ANY($${i}::int[])`;
        siteAcctClause   = `AND g.ad_account_id ${cmp}`;
        siteIaClause     = `AND cmap.ad_account_id ${cmp}`;
        siteCfMapClause  = `AND m.acc_id ${cmp}`;
        siteCfOrphClause = `AND COALESCE(gid.ad_account_id, ch.ad_account_id) ${cmp}`;
      }
    }
    return {
      args: siteArgs,
      sql: `
        WITH cost AS (
          SELECT g.dim_id AS site_id,
                 MAX(g.dim_value)            AS site_name,
                 SUM(g.impressions)::numeric AS impressions,
                 SUM(g.clicks)::numeric      AS clicks,
                 SUM(g.conversions)::numeric AS conversions,
                 SUM(g.spent)::numeric       AS spent
          FROM taboola_geo_cost_daily g
          WHERE g.dim_type = 'site'
            AND g.stat_date >= $1::date
            AND g.stat_date <= $2::date
            -- Taboola publisher cost; suppress under the Outbrain-only filter.
            AND ${p.source === 'outbrain' ? 'FALSE' : 'TRUE'}
            ${siteAcctClause}
          GROUP BY g.dim_id
        ),
        ia_rev AS (
          SELECT p.item_ext_id AS site_id,
                 SUM(p.revenue)::numeric   AS revenue,
                 SUM(p.ad_clicks)::numeric AS ad_clicks,
                 SUM(p.sessions)::numeric  AS sessions
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
          LEFT JOIN campaigns cmap ON cmap.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            AND p.item_ext_id IS NOT NULL
            AND ${psSource}
            ${iaFeed}
            ${siteIaClause}
          GROUP BY p.item_ext_id
        ),
        ia_nosite AS (
          -- IA rows without a site id (cannot be matched to a publisher);
          -- surfaced as one row so the tab's revenue total reconciles.
          SELECT SUM(p.revenue)::numeric   AS revenue,
                 SUM(p.ad_clicks)::numeric AS ad_clicks,
                 SUM(p.sessions)::numeric  AS sessions
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
          LEFT JOIN campaigns cmap ON cmap.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
            AND p.item_ext_id IS NULL
            AND ${psSource}
            ${iaFeed}
            ${siteIaClause}
        ),
        cf_rev AS (
          SELECT SUM(u.revenue)::numeric AS revenue,
                 SUM(u.ad_clicks)::numeric AS ad_clicks,
                 SUM(u.sessions)::numeric AS sessions
          FROM (
            -- mapped Codefuel revenue (account via deduped ads mapping)
            SELECT p.revenue, p.ad_clicks, p.sessions
            FROM partner_stats_hourly p
            JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
            JOIN (
              SELECT DISTINCT ON (a.gd_param, a.r_param)
                     a.gd_param, a.r_param, c.ad_account_id AS acc_id
              FROM ads a JOIN campaigns c ON c.id = a.campaign_id
              ORDER BY a.gd_param, a.r_param, a.id
            ) m ON m.gd_param = p.asset_gid AND m.r_param = p.channel
            WHERE p.campaign_ext_id IS NULL
              AND ${psSource}
              AND p.hour_utc >= $1::timestamptz
              AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
              ${siteCfMapClause}
            UNION ALL
            -- orphan Codefuel revenue (account resolved like the other tabs)
            SELECT p.revenue, p.ad_clicks, p.sessions
            FROM partner_stats_hourly p
            JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
            LEFT JOIN LATERAL (
              SELECT c.ad_account_id
              FROM ads a JOIN campaigns c ON c.id = a.campaign_id
              WHERE a.gd_param = p.asset_gid
              GROUP BY c.ad_account_id
              HAVING COUNT(DISTINCT c.ad_account_id) = 1
              LIMIT 1
            ) gid ON TRUE
            LEFT JOIN campaigns ch ON ch.external_id = p.channel
            WHERE p.campaign_ext_id IS NULL
              AND ${psSource}
              AND p.hour_utc >= $1::timestamptz
              AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
              AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
              ${siteCfOrphClause}
          ) u
        )
        SELECT
          COALESCE(c.site_name, '(site ' || r.site_id || ')') AS site,
          COALESCE(c.impressions, 0) AS impressions,
          COALESCE(c.clicks, 0)      AS clicks,
          COALESCE(c.spent, 0)       AS spent,
          COALESCE(r.revenue, 0)     AS revenue,
          COALESCE(c.conversions, 0) AS conversions,
          COALESCE(r.ad_clicks, 0)   AS ad_clicks,
          COALESCE(r.sessions, 0)    AS sessions,
          COALESCE(r.revenue, 0) - COALESCE(c.spent, 0) AS profit,
          CASE WHEN COALESCE(c.impressions,0) = 0 THEN 0
               ELSE c.spent * 1000.0 / c.impressions END             AS actual_cpm,
          CASE WHEN COALESCE(c.impressions,0) = 0 THEN 0
               ELSE c.clicks * 100.0 / c.impressions END             AS ctr_pct,
          CASE WHEN COALESCE(c.clicks,0) = 0 THEN 0
               ELSE c.spent / c.clicks END                           AS actual_cpc,
          CASE WHEN COALESCE(c.clicks,0) = 0 THEN 0
               ELSE c.conversions * 100.0 / c.clicks END             AS conversion_rate_pct,
          CASE WHEN COALESCE(c.conversions,0) = 0 THEN 0
               ELSE c.spent / c.conversions END                      AS actual_cpa,
          CASE WHEN COALESCE(r.ad_clicks,0) = 0 THEN 0
               ELSE r.revenue / r.ad_clicks END                      AS rpc,
          CASE WHEN COALESCE(r.revenue,0) = 0 THEN 0
               ELSE (r.revenue - COALESCE(c.spent,0)) * 100.0 / r.revenue END AS margin_pct,
          CASE WHEN COALESCE(r.ad_clicks,0) = 0 THEN 0
               ELSE COALESCE(c.spent,0) / r.ad_clicks END            AS yahoo_cpa,
          COALESCE(c.conversions,0) - COALESCE(r.ad_clicks,0)        AS conversion_scrub,
          CASE WHEN COALESCE(c.conversions,0) = 0 THEN 0
               ELSE (c.conversions - COALESCE(r.ad_clicks,0)) * 100.0 / c.conversions END AS scrub_rate_pct
        FROM cost c
        FULL OUTER JOIN ia_rev r ON r.site_id = c.site_id
        -- Pre-existing: this FULL OUTER JOIN emitted ~15 all-zero '(site NNN)'
        -- rows. Blank lines in Nadia's table; zero contribution to totals.
        WHERE COALESCE(c.spent,0) <> 0 OR COALESCE(c.impressions,0) <> 0
           OR COALESCE(c.clicks,0) <> 0 OR COALESCE(c.conversions,0) <> 0
           OR COALESCE(r.revenue,0) <> 0 OR COALESCE(r.ad_clicks,0) <> 0
           OR COALESCE(r.sessions,0) <> 0

        UNION ALL

        SELECT
          '(Codefuel — partner reports no site breakdown)',
          0, 0, 0,
          f.revenue, 0, f.ad_clicks, f.sessions,
          f.revenue,
          0, 0, 0, 0, 0,
          CASE WHEN f.ad_clicks = 0 THEN 0 ELSE f.revenue / f.ad_clicks END,
          CASE WHEN f.revenue = 0 THEN 0 ELSE 100 END,
          0,
          -f.ad_clicks,
          0
        FROM cf_rev f
        WHERE f.revenue > 0 OR f.sessions > 0

        UNION ALL

        SELECT
          '(Image Advantage — no site id from partner)',
          0, 0, 0,
          n.revenue, 0, n.ad_clicks, n.sessions,
          n.revenue,
          0, 0, 0, 0, 0,
          CASE WHEN n.ad_clicks = 0 THEN 0 ELSE n.revenue / n.ad_clicks END,
          CASE WHEN n.revenue = 0 THEN 0 ELSE 100 END,
          0,
          -n.ad_clicks,
          0
        FROM ia_nosite n
        WHERE n.revenue > 0 OR n.sessions > 0

        ORDER BY spent DESC NULLS LAST`,
    };
  }

  // Partner-stats views: device | country | ads
  // Build args fresh — only this view's filters, pushed in order.
  const pArgs: any[] = [p.from, p.to]; // $1, $2

  // Device / Country use a flat WHERE against the CF join; ads uses CTEs (built inline below).
  const whereParts: string[] = [
    `p.hour_utc >= $1::timestamptz`,
    `p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')`,
  ];
  // Parallel account clauses reusing the SAME bound param so every branch of the
  // device/country views (cost table, codefuel orphans, IA rows) respects the
  // account filter — otherwise a "Codefuel" account selection still shows IA rows.
  let costAcctClause   = ''; // taboola_geo_cost_daily, keyed g.ad_account_id
  let orphanAcctClause = ''; // codefuel orphans, account resolved via gid/ch laterals
  let iaAcctClause     = ''; // IA rows, account via campaign mapping (cmap)
  if (p.account_id && p.account_id !== 'all') {
    const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (ids.length === 1) {
      pArgs.push(ids[0]); const i = pArgs.length;
      whereParts.push(`m.acc_id = $${i}::int`);
      costAcctClause   = `AND g.ad_account_id = $${i}::int`;
      orphanAcctClause = `AND COALESCE(gid.ad_account_id, ch.ad_account_id) = $${i}::int`;
      iaAcctClause     = `AND cmap.ad_account_id = $${i}::int`;
    } else if (ids.length > 1) {
      pArgs.push(ids); const i = pArgs.length;
      whereParts.push(`m.acc_id = ANY($${i}::int[])`);
      costAcctClause   = `AND g.ad_account_id = ANY($${i}::int[])`;
      orphanAcctClause = `AND COALESCE(gid.ad_account_id, ch.ad_account_id) = ANY($${i}::int[])`;
      iaAcctClause     = `AND cmap.ad_account_id = ANY($${i}::int[])`;
    }
  }
  if (p.campaign_id) { pArgs.push(p.campaign_id); whereParts.push(`m.camp_ext = ANY(string_to_array($${pArgs.length}::text, ','))`); }
  // GD on the detail tabs. The mapped branch filters on the row's own asset_gid,
  // but the Codefuel-orphan and IA branches below have their own WHERE clauses and
  // used to ignore GD entirely -- so Country/Device reported the SAME unattributed
  // total for EVERY GD, including GDs worth $0 on every other tab. Each branch gets
  // the gate that matches how it is attributed:
  //   - orphan rows carry a real asset_gid, so filter on it directly;
  //   - IA is campaign-attributed, so scope by the campaigns carrying the GD, which
  //     matches the campaign scoping used by the MV views. Genuinely unattributed
  //     IA revenue has no campaign and therefore no GD, so it drops out -- which is
  //     correct: it cannot belong to the GD the user picked.
  let orphanGdClause = '';
  let iaGdClause     = '';
  if (p.gd) {
    pArgs.push(p.gd); const gi = pArgs.length;
    whereParts.push(`p.asset_gid = ANY(string_to_array($${gi}::text, ','))`);
    orphanGdClause = `AND p.asset_gid = ANY(string_to_array($${gi}::text, ','))`;
    iaGdClause = `AND cmap.id IN (SELECT c9.id FROM campaigns c9
                                    JOIN ads a9 ON a9.campaign_id = c9.id
                                   WHERE a9.gd_param = ANY(string_to_array($${gi}::text, ',')))`;
  }
  let costDimClause = ''; // optional filter on the cost table's dim_value
  // The dimension filter reached only the mapped branch, so the Codefuel-orphan and
  // IA branches leaked their totals through unchanged and Country/Device reported the
  // SAME number for every value picked. Orphan rows carry a real country/device, so
  // filter them directly. IA reports NEITHER (0 of 24,445 rows carry country or
  // device), so IA revenue cannot belong to a specific country or device and is
  // excluded outright rather than shown against whatever the user picked.
  let orphanDimClause = '';
  let iaDimClause     = '';
  if (p.view === 'device'  && p.device)  {
    pArgs.push(p.device);
    whereParts.push(`p.device = $${pArgs.length}::text`);
    costDimClause   = `AND g.dim_value = $${pArgs.length}::text`;
    orphanDimClause = `AND p.device = $${pArgs.length}::text`;
    iaDimClause     = `AND FALSE`;
  }
  if (p.view === 'country' && p.country) {
    pArgs.push(p.country);
    whereParts.push(`p.country = ANY(string_to_array($${pArgs.length}::text, ','))`);
    costDimClause   = `AND g.dim_value = ANY(string_to_array($${pArgs.length}::text, ','))`;
    orphanDimClause = `AND p.country = ANY(string_to_array($${pArgs.length}::text, ','))`;
    iaDimClause     = `AND FALSE`;
  }
  // CRITICAL: mirror the MV's attribution rules so these tabs reconcile with
  // campaign/daily/hourly. The mapped branch is Codefuel-attributed revenue:
  //  - campaign_ext_id IS NULL  (Codefuel rows; IA rows carry an ext_id)
  //  - source_platform Taboola/NULL only — Codefuel also reports Outbrain / GDN
  //    revenue, which must NOT land on this Taboola dashboard.
  whereParts.push(`p.campaign_ext_id IS NULL`);
  whereParts.push(`${psSource}`);
  const pw = `WHERE ${whereParts.join(' AND ')}`;
  // Reset pArgs for ads view — it builds its own filter clauses from scratch
  // (pArgs is mutated in place inside the ads branch below)

  // Device / Country: revenue-side aggregation via CF partner_stats_hourly.
  // Taboola spend is campaign-level only so spent/cost columns are 0 for these views.
  // IA has no device/country breakdown (stored as ''), so only CF rows appear here.
  // Deduplicate the ads→campaign→account mapping to ONE row per (gd_param, r_param).
  // Multiple ads can share the same (gd_param, r_param); joining ads directly fans
  // out and double-counts partner revenue. DISTINCT ON collapses to a single row.
  const cfJoins = `
    FROM partner_stats_hourly p
    JOIN (
      SELECT DISTINCT ON (a.gd_param, a.r_param)
             a.gd_param,
             a.r_param,
             c.external_id   AS camp_ext,
             c.ad_account_id AS acc_id
      FROM ads a
      JOIN campaigns c ON c.id = a.campaign_id
      ORDER BY a.gd_param, a.r_param, a.id
    ) m ON m.gd_param = p.asset_gid AND m.r_param = p.channel
  `;

  const dimSelect = (dimExpr: string, groupBy: string) => `
    SELECT
      ${dimExpr},
      SUM(p.revenue)                                              AS revenue,
      SUM(p.ad_clicks)                                           AS ad_clicks,
      SUM(p.sessions)                                            AS sessions,
      0::numeric                                                 AS impressions,
      0::numeric                                                 AS clicks,
      0::numeric                                                 AS conversions,
      0::numeric                                                 AS spent,
      0::numeric                                                 AS actual_cpm,
      0::numeric                                                 AS ctr_pct,
      0::numeric                                                 AS actual_cpc,
      0::numeric                                                 AS conversion_rate_pct,
      0::numeric                                                 AS actual_cpa,
      CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
           ELSE SUM(p.revenue) / SUM(p.ad_clicks) END            AS rpc,
      0::numeric                                                 AS margin_pct,
      0::numeric                                                 AS profit,
      0::numeric                                                 AS yahoo_cpa,
      0::numeric                                                 AS conversion_scrub,
      0::numeric                                                 AS scrub_rate_pct
    ${cfJoins}
    ${pw}
    GROUP BY ${groupBy}
    HAVING SUM(p.revenue) > 0 OR SUM(p.ad_clicks) > 0 OR SUM(p.sessions) > 0
    ORDER BY revenue DESC NULLS LAST
  `;

  // Real Taboola cost branch (device | country). Cost lives in
  // taboola_geo_cost_daily at (ad_account_id, stat_date, dim_type, dim_value).
  // It is account-splittable but NOT campaign/asset-splittable, so we omit it
  // when a campaign_id or gd filter is active (cost can't be scoped to those).
  const taboolaCostBranch = (dimType: 'device' | 'country', dimAlias: string): string => {
    // Outbrain has no per-device/country cost feed; under source=outbrain show
    // revenue with zero geo cost rather than mislabelling Taboola cost as Outbrain.
    if (p.campaign_id || p.gd || p.source === 'outbrain') return '';
    return `
          UNION ALL
          SELECT
            g.dim_value AS ${dimAlias},
            0::numeric AS revenue,
            0::numeric AS ad_clicks,
            0::numeric AS sessions,
            SUM(g.impressions)::numeric AS impressions,
            SUM(g.clicks)::numeric AS clicks,
            SUM(g.conversions)::numeric AS conversions,
            SUM(g.spent)::numeric AS spent,
            0::numeric AS actual_cpm,
            0::numeric AS ctr_pct,
            0::numeric AS actual_cpc,
            0::numeric AS conversion_rate_pct,
            0::numeric AS actual_cpa,
            0::numeric AS rpc,
            0::numeric AS margin_pct,
            0::numeric AS profit,
            0::numeric AS yahoo_cpa,
            0::numeric AS conversion_scrub,
            0::numeric AS scrub_rate_pct
          FROM taboola_geo_cost_daily g
          WHERE g.dim_type = '${dimType}'
            AND g.stat_date >= $1::date
            AND g.stat_date <= $2::date
            ${costAcctClause}
            ${costDimClause}
          GROUP BY g.dim_value`;
  };

  if (p.view === 'device') {
    // Device view: aggregate mapped + orphan + IA by device (no duplicates)
    const cfDeviceSql = dimSelect('p.device AS device', 'p.device');
    return {
      args: pArgs,
      sql: `
        SELECT
          device,
          ROUND(SUM(revenue)::numeric, 2) AS revenue,
          SUM(ad_clicks) AS ad_clicks,
          SUM(sessions) AS sessions,
          SUM(impressions) AS impressions,
          SUM(clicks) AS clicks,
          SUM(conversions) AS conversions,
          SUM(spent) AS spent,
          CASE WHEN SUM(impressions) = 0 THEN 0
               ELSE SUM(spent) * 1000.0 / SUM(impressions) END AS actual_cpm,
          CASE WHEN SUM(impressions) = 0 THEN 0
               ELSE SUM(clicks) * 100.0 / SUM(impressions) END AS ctr_pct,
          CASE WHEN SUM(clicks) = 0 THEN 0
               ELSE SUM(spent) / SUM(clicks) END AS actual_cpc,
          CASE WHEN SUM(clicks) = 0 THEN 0
               ELSE SUM(conversions) * 100.0 / SUM(clicks) END AS conversion_rate_pct,
          CASE WHEN SUM(conversions) = 0 THEN 0
               ELSE SUM(spent) / SUM(conversions) END AS actual_cpa,
          CASE WHEN SUM(ad_clicks) = 0 THEN 0
               ELSE SUM(revenue) / SUM(ad_clicks) END AS rpc,
          CASE WHEN SUM(revenue) = 0 THEN 0
               ELSE (SUM(revenue) - SUM(spent)) * 100.0 / SUM(revenue) END AS margin_pct,
          SUM(revenue) - SUM(spent) AS profit,
          CASE WHEN SUM(ad_clicks) = 0 THEN 0
               ELSE SUM(spent) / SUM(ad_clicks) END AS yahoo_cpa,
          SUM(conversions) - SUM(ad_clicks) AS conversion_scrub,
          CASE WHEN SUM(conversions) = 0 THEN 0
               ELSE (SUM(conversions) - SUM(ad_clicks)) * 100.0 / SUM(conversions) END AS scrub_rate_pct
        FROM (
          (${cfDeviceSql})
          UNION ALL
          -- Codefuel orphan assets (no ads mapping)
          SELECT
            COALESCE(p.device, '(Unattributed)') AS device,
            SUM(p.revenue) AS revenue,
            SUM(p.ad_clicks) AS ad_clicks,
            SUM(p.sessions) AS sessions,
            0::numeric AS impressions,
            0::numeric AS clicks,
            0::numeric AS conversions,
            0::numeric AS spent,
            0::numeric AS actual_cpm,
            0::numeric AS ctr_pct,
            0::numeric AS actual_cpc,
            0::numeric AS conversion_rate_pct,
            0::numeric AS actual_cpa,
            CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
                 ELSE SUM(p.revenue) / SUM(p.ad_clicks) END AS rpc,
            0::numeric AS margin_pct,
            0::numeric AS profit,
            0::numeric AS yahoo_cpa,
            0::numeric AS conversion_scrub,
            0::numeric AS scrub_rate_pct
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
          LEFT JOIN LATERAL (
            SELECT c.ad_account_id
            FROM ads a JOIN campaigns c ON c.id = a.campaign_id
            WHERE a.gd_param = p.asset_gid
            GROUP BY c.ad_account_id
            HAVING COUNT(DISTINCT c.ad_account_id) = 1
            LIMIT 1
          ) gid ON TRUE
          LEFT JOIN campaigns ch ON ch.external_id = p.channel
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc < ($2::timestamptz + INTERVAL '1 day')
            AND p.campaign_ext_id IS NULL
            AND ${psSource}
            AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
            ${orphanAcctClause}
            ${orphanGdClause}
            ${orphanDimClause}
          GROUP BY COALESCE(p.device, '(Unattributed)')
          UNION ALL
          -- Image Advantage unattributed (no device breakdown)
          SELECT
            '(Unattributed - IA)' AS device,
            SUM(p.revenue) AS revenue,
            SUM(p.ad_clicks) AS ad_clicks,
            SUM(p.sessions) AS sessions,
            0::numeric AS impressions,
            0::numeric AS clicks,
            0::numeric AS conversions,
            0::numeric AS spent,
            0::numeric AS actual_cpm,
            0::numeric AS ctr_pct,
            0::numeric AS actual_cpc,
            0::numeric AS conversion_rate_pct,
            0::numeric AS actual_cpa,
            CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
                 ELSE SUM(p.revenue) / SUM(p.ad_clicks) END AS rpc,
            0::numeric AS margin_pct,
            0::numeric AS profit,
            0::numeric AS yahoo_cpa,
            0::numeric AS conversion_scrub,
            0::numeric AS scrub_rate_pct
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
          LEFT JOIN campaigns cmap ON cmap.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc < ($2::timestamptz + INTERVAL '1 day')
            AND (p.device IS NULL OR p.device = '')
            AND ${psSource}
            ${iaFeed}
            ${iaAcctClause}
            ${iaGdClause}
            ${iaDimClause}
          HAVING SUM(p.revenue) > 0 OR SUM(p.sessions) > 0
          ${taboolaCostBranch('device', 'device')}
        ) base
        GROUP BY device
        ORDER BY revenue DESC NULLS LAST
      `,
    };
  }
  if (p.view === 'country') {
    // Country view: aggregate mapped + orphan + IA by country (no duplicates)
    const cfCountrySql = dimSelect('p.country AS country', 'p.country');
    return {
      args: pArgs,
      sql: `
        SELECT
          country,
          ROUND(SUM(revenue)::numeric, 2) AS revenue,
          SUM(ad_clicks) AS ad_clicks,
          SUM(sessions) AS sessions,
          SUM(impressions) AS impressions,
          SUM(clicks) AS clicks,
          SUM(conversions) AS conversions,
          SUM(spent) AS spent,
          CASE WHEN SUM(impressions) = 0 THEN 0
               ELSE SUM(spent) * 1000.0 / SUM(impressions) END AS actual_cpm,
          CASE WHEN SUM(impressions) = 0 THEN 0
               ELSE SUM(clicks) * 100.0 / SUM(impressions) END AS ctr_pct,
          CASE WHEN SUM(clicks) = 0 THEN 0
               ELSE SUM(spent) / SUM(clicks) END AS actual_cpc,
          CASE WHEN SUM(clicks) = 0 THEN 0
               ELSE SUM(conversions) * 100.0 / SUM(clicks) END AS conversion_rate_pct,
          CASE WHEN SUM(conversions) = 0 THEN 0
               ELSE SUM(spent) / SUM(conversions) END AS actual_cpa,
          CASE WHEN SUM(ad_clicks) = 0 THEN 0
               ELSE SUM(revenue) / SUM(ad_clicks) END AS rpc,
          CASE WHEN SUM(revenue) = 0 THEN 0
               ELSE (SUM(revenue) - SUM(spent)) * 100.0 / SUM(revenue) END AS margin_pct,
          SUM(revenue) - SUM(spent) AS profit,
          CASE WHEN SUM(ad_clicks) = 0 THEN 0
               ELSE SUM(spent) / SUM(ad_clicks) END AS yahoo_cpa,
          SUM(conversions) - SUM(ad_clicks) AS conversion_scrub,
          CASE WHEN SUM(conversions) = 0 THEN 0
               ELSE (SUM(conversions) - SUM(ad_clicks)) * 100.0 / SUM(conversions) END AS scrub_rate_pct
        FROM (
          (${cfCountrySql})
          UNION ALL
          -- Codefuel orphan assets (no ads mapping)
          SELECT
            COALESCE(p.country, '(Unattributed)') AS country,
            SUM(p.revenue) AS revenue,
            SUM(p.ad_clicks) AS ad_clicks,
            SUM(p.sessions) AS sessions,
            0::numeric AS impressions,
            0::numeric AS clicks,
            0::numeric AS conversions,
            0::numeric AS spent,
            0::numeric AS actual_cpm,
            0::numeric AS ctr_pct,
            0::numeric AS actual_cpc,
            0::numeric AS conversion_rate_pct,
            0::numeric AS actual_cpa,
            CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
                 ELSE SUM(p.revenue) / SUM(p.ad_clicks) END AS rpc,
            0::numeric AS margin_pct,
            0::numeric AS profit,
            0::numeric AS yahoo_cpa,
            0::numeric AS conversion_scrub,
            0::numeric AS scrub_rate_pct
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
          LEFT JOIN LATERAL (
            SELECT c.ad_account_id
            FROM ads a JOIN campaigns c ON c.id = a.campaign_id
            WHERE a.gd_param = p.asset_gid
            GROUP BY c.ad_account_id
            HAVING COUNT(DISTINCT c.ad_account_id) = 1
            LIMIT 1
          ) gid ON TRUE
          LEFT JOIN campaigns ch ON ch.external_id = p.channel
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc < ($2::timestamptz + INTERVAL '1 day')
            AND p.campaign_ext_id IS NULL
            AND ${psSource}
            AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
            ${orphanAcctClause}
            ${orphanGdClause}
            ${orphanDimClause}
          GROUP BY COALESCE(p.country, '(Unattributed)')
          UNION ALL
          -- Image Advantage unattributed (no country breakdown)
          SELECT
            '(Unattributed - IA)' AS country,
            SUM(p.revenue) AS revenue,
            SUM(p.ad_clicks) AS ad_clicks,
            SUM(p.sessions) AS sessions,
            0::numeric AS impressions,
            0::numeric AS clicks,
            0::numeric AS conversions,
            0::numeric AS spent,
            0::numeric AS actual_cpm,
            0::numeric AS ctr_pct,
            0::numeric AS actual_cpc,
            0::numeric AS conversion_rate_pct,
            0::numeric AS actual_cpa,
            CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
                 ELSE SUM(p.revenue) / SUM(p.ad_clicks) END AS rpc,
            0::numeric AS margin_pct,
            0::numeric AS profit,
            0::numeric AS yahoo_cpa,
            0::numeric AS conversion_scrub,
            0::numeric AS scrub_rate_pct
          FROM partner_stats_hourly p
          JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
          LEFT JOIN campaigns cmap ON cmap.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
          WHERE p.hour_utc >= $1::timestamptz
            AND p.hour_utc < ($2::timestamptz + INTERVAL '1 day')
            AND (p.country IS NULL OR p.country = '')
            AND ${psSource}
            ${iaFeed}
            ${iaAcctClause}
            ${iaGdClause}
            ${iaDimClause}
          HAVING SUM(p.revenue) > 0 OR SUM(p.sessions) > 0
          ${taboolaCostBranch('country', 'country')}
        ) base
        GROUP BY country
        ORDER BY revenue DESC NULLS LAST
      `,
    };
  }

  // ── Ads view ──────────────────────────────────────────────────────────────
  // CF revenue attributed by gd_param + r_param. Deduplicated at the
  // (asset_gid, channel) level — multiple ads sharing the same gd_param
  // are merged into one row; the representative ad is chosen as the one
  // in the campaign with the highest spend (most likely the active campaign).
  // IA item_ext_id does not map to ads.external_id (different ID space),
  // so IA revenue cannot be attributed to individual ads.

  // The device/country code above already pushed filters into pArgs; trim back so
  // the ads CTEs can rebuild with their own $N indices.
  pArgs.length = 2; // keep only $1=from, $2=to

  // Build filter clauses reusing pArgs (starting at $3).
  // Array.push() returns the new length which equals the $N parameter index.
  let   accClause  = '';
  if (p.account_id && p.account_id !== 'all') {
    const ids = p.account_id.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    if (ids.length === 1) accClause = `AND acc.id = $${pArgs.push(ids[0])}::int`;
    else if (ids.length > 1) accClause = `AND acc.id = ANY($${pArgs.push(ids)}::int[])`;
  }
  // GD is scoped to CAMPAIGNS here too, matching the MV views above -- folded
  // into campClause so it reaches all three branches this is interpolated into.
  // (The old `gdClause` below filtered p.asset_gid in exactly ONE branch, which
  // is why the Ads tab's total did not change under a GD filter.)
  // Mirrors the MV's ia_orphan account lateral (migration 047). Same shape as
  // DDC_ORPHAN_ACCT in the Outbrain branch.
  const IA_ORPHAN_ACCT = `(SELECT _ia.id FROM ad_accounts _ia
                             JOIN client_partners _ip ON _ip.id = _ia.client_partner_id
                                                     AND _ip.code = 'image_advantage'
                            ORDER BY _ia.id LIMIT 1)`;
  const campClause = (p.campaign_id ? `AND c.external_id = ANY(string_to_array($${pArgs.push(p.campaign_id)}::text, ','))` : '')
    + (p.gd ? `AND c.external_id IN (SELECT c3.external_id FROM campaigns c3
                                       JOIN ads a3 ON a3.campaign_id = c3.id
                                      WHERE a3.gd_param = ANY(string_to_array($${pArgs.push(p.gd)}::text, ',')))` : '');
  // Status was applied to the MV-backed Campaign tab but ignored here, so the
  // two tabs disagreed the moment Nadia touched the Status filter. `c` is the
  // campaigns table in every branch it is interpolated into.
  const statClause = p.status ? `AND c.status = ANY(string_to_array($${pArgs.push(p.status)}::text, ','))` : '';

  return {
    args: pArgs,
    sql: `
      WITH
      -- Campaign-level Taboola metrics over the requested window.
      -- Taboola cost is campaign-grain only (ad_id is always NULL in source), so
      -- impressions/clicks/conversions/spent are attributed to the representative
      -- ad of each campaign — exactly as spent already is.
      cs AS (
        SELECT campaign_id,
               SUM(spent)       AS spent,
               SUM(impressions) AS impressions,
               SUM(clicks)      AS clicks,
               SUM(conversions) AS conversions
        FROM ad_stats_hourly
        WHERE hour_utc >= $1::timestamptz
          AND hour_utc <  ($2::timestamptz + INTERVAL '1 day')
          -- ad_stats is Taboola cost; suppress it under the Outbrain-only filter
          -- (Outbrain has no per-ad cost feed).
          AND ${p.source === 'outbrain' ? 'FALSE' : 'TRUE'}
        GROUP BY campaign_id
      ),
      -- CF revenue keyed at (asset_gid, channel) level — avoids double-counting
      -- when multiple ads share the same gd_param
      cf_key AS (
        SELECT p.asset_gid AS gd_param, p.channel AS r_param,
               SUM(p.revenue)   AS revenue,
               SUM(p.ad_clicks) AS ad_clicks,
               SUM(p.sessions)  AS sessions
        FROM partner_stats_hourly p
        -- COMMIT 2: scope to Codefuel. Without this join cf_key treated EVERY
        -- unattributed row as Codefuel, including Image Advantage's
        -- NULL-source_platform rows ($410.86 across 2,069 rows in August alone).
        -- They were dropped one CTE later by the ads join, so this is a
        -- correction of a latent hazard rather than a change in today's numbers
        -- — proven by the before/after Codefuel totals captured with the change.
        JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
        WHERE p.campaign_ext_id IS NULL
          AND ${psSource}
          AND p.hour_utc >= $1::timestamptz
          AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
          -- Same feed fix as ob_cf_rev above: Codefuel is never Flux.
          ${iaFeed}
        GROUP BY p.asset_gid, p.channel
      ),
      -- Pick ONE representative ad per (gd_param, r_param): prefer the ad
      -- in the campaign with the highest spend (most likely the active campaign)
      cf_rep AS (
        SELECT DISTINCT ON (ck.gd_param, ck.r_param)
          a.id AS ad_db_id, ck.gd_param, ck.r_param,
          ck.revenue, ck.ad_clicks, ck.sessions
        FROM cf_key ck
        JOIN ads a           ON a.gd_param = ck.gd_param AND a.r_param = ck.r_param
        JOIN campaigns c     ON c.id       = a.campaign_id
        JOIN ad_accounts acc ON acc.id     = c.ad_account_id
        LEFT JOIN cs         ON cs.campaign_id = c.id
        WHERE TRUE ${accClause} ${campClause} ${statClause}
        ORDER BY ck.gd_param, ck.r_param, COALESCE(cs.spent, 0) DESC, a.id DESC
      ),
      -- IA item-id → campaign map (mirrors the MV's ia_item_map from migration
      -- 034). IA campaign_ext_id can carry EITHER a Taboola campaign id OR a
      -- Taboola item/ad id — item ids only resolve via ads.external_id. Without
      -- this, item-attributed IA revenue got campaign NULL here and was silently
      -- dropped under any account filter (Ads tab < Campaign tab).
      ia_map AS (
        SELECT DISTINCT ON (a.external_id) a.external_id AS item_ext, a.campaign_id AS campaign_db_id
        FROM ads a
        ORDER BY a.external_id, a.id
      ),
      -- IA revenue aggregated to its RESOLVED campaign (campaign-id match first,
      -- item-id fallback — same precedence as the MV). One row per campaign.
      ia_camp AS (
        SELECT COALESCE(cc.id, im.campaign_db_id) AS campaign_db_id,
               SUM(p.revenue)   AS revenue,
               SUM(p.ad_clicks) AS ad_clicks,
               SUM(p.sessions)  AS sessions
        FROM partner_stats_hourly p
        JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'image_advantage'
        LEFT JOIN campaigns cc ON cc.external_id = regexp_replace(p.campaign_ext_id, '^tb:', '')
        LEFT JOIN ia_map im    ON im.item_ext    = regexp_replace(p.campaign_ext_id, '^tb:', '')
        WHERE p.hour_utc >= $1::timestamptz
          AND p.hour_utc <  ($2::timestamptz + INTERVAL '1 day')
          AND ${psSource}
          ${iaFeed}
        GROUP BY COALESCE(cc.id, im.campaign_db_id)
      )
      SELECT
        a.id            AS ad_id,
        a.external_id   AS taboola_ad_id,
        a.title         AS ad_title,
        r.gd_param,
        r.r_param,
        c.external_id   AS campaign_id,
        c.name          AS campaign_name,
        COALESCE(r.revenue,   0)                                     AS revenue,
        COALESCE(r.ad_clicks, 0)                                     AS ad_clicks,
        COALESCE(r.sessions,  0)                                     AS sessions,
        COALESCE(cs.impressions, 0)                                  AS impressions,
        COALESCE(cs.clicks,      0)                                  AS clicks,
        COALESCE(cs.conversions, 0)                                  AS conversions,
        COALESCE(cs.spent, 0)                                        AS spent,
        CASE WHEN COALESCE(cs.impressions,0) = 0 THEN 0
             ELSE COALESCE(cs.spent,0) * 1000.0 / cs.impressions END AS actual_cpm,
        CASE WHEN COALESCE(cs.impressions,0) = 0 THEN 0
             ELSE COALESCE(cs.clicks,0) * 100.0 / cs.impressions END AS ctr_pct,
        CASE WHEN COALESCE(cs.clicks,0) = 0 THEN 0
             ELSE COALESCE(cs.spent,0) / cs.clicks END               AS actual_cpc,
        CASE WHEN COALESCE(cs.clicks,0) = 0 THEN 0
             ELSE COALESCE(cs.conversions,0) * 100.0 / cs.clicks END AS conversion_rate_pct,
        CASE WHEN COALESCE(cs.conversions,0) = 0 THEN 0
             ELSE COALESCE(cs.spent,0) / cs.conversions END          AS actual_cpa,
        CASE WHEN COALESCE(r.ad_clicks,0) = 0 THEN 0
             ELSE COALESCE(r.revenue,0) / r.ad_clicks END            AS rpc,
        CASE WHEN COALESCE(r.revenue,0) = 0 THEN 0
             ELSE (COALESCE(r.revenue,0) - COALESCE(cs.spent,0))
                  * 100.0 / r.revenue END                            AS margin_pct,
        COALESCE(r.revenue,0) - COALESCE(cs.spent,0)                AS profit,
        CASE WHEN COALESCE(r.ad_clicks,0) = 0 THEN 0
             ELSE COALESCE(cs.spent,0) / r.ad_clicks END             AS yahoo_cpa,
        COALESCE(cs.conversions,0) - COALESCE(r.ad_clicks,0)         AS conversion_scrub,
        CASE WHEN COALESCE(cs.conversions,0) = 0 THEN 0
             ELSE (COALESCE(cs.conversions,0) - COALESCE(r.ad_clicks,0))
                  * 100.0 / cs.conversions END                       AS scrub_rate_pct
      FROM cf_rep r
      JOIN ads a           ON a.id   = r.ad_db_id
      JOIN campaigns c     ON c.id   = a.campaign_id
      JOIN ad_accounts acc ON acc.id = c.ad_account_id
      LEFT JOIN cs         ON cs.campaign_id = c.id
      -- Pre-existing: an ad whose (gd, r) pair earned nothing AND whose campaign
      -- has no cost in the window rendered as an all-zero row. Zero contribution
      -- to totals, so this only removes blank lines.
      WHERE COALESCE(r.revenue,0) <> 0 OR COALESCE(r.ad_clicks,0) <> 0
         OR COALESCE(r.sessions,0) <> 0 OR COALESCE(cs.spent,0) <> 0
         OR COALESCE(cs.impressions,0) <> 0 OR COALESCE(cs.clicks,0) <> 0
         OR COALESCE(cs.conversions,0) <> 0

      UNION ALL

      -- IA revenue PER CAMPAIGN, now WITH its Taboola cost on the same row. IA
      -- reports at the account/campaign level (item_ext_id does not map to
      -- ads.external_id — different ID spaces), so it cannot be split to individual
      -- ads. But its campaign's Taboola cost (impressions/clicks/conv/spend) CAN be
      -- shown alongside the revenue. Cost is suppressed (0) when the campaign already
      -- has a Codefuel representative ad above (cov.has_cf), so campaign spend is
      -- never double-counted. Shown with ad_id = -1 (campaign-level, not a real ad).
      SELECT
        -1::int                                                         AS ad_id,
        COALESCE('IA · ' || c.external_id, '(Image Advantage — unmapped)')::text AS taboola_ad_id,
        NULL::text                                                      AS ad_title,
        NULL::text                                                      AS gd_param,
        NULL::text                                                      AS r_param,
        c.external_id                                                   AS campaign_id,
        c.name                                                          AS campaign_name,
        ia.revenue                                                      AS revenue,
        ia.ad_clicks                                                    AS ad_clicks,
        ia.sessions                                                     AS sessions,
        CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.impressions,0) END AS impressions,
        CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.clicks,0)      END AS clicks,
        CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.conversions,0) END AS conversions,
        CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.spent,0)       END AS spent,
        CASE WHEN cov.has_cf OR COALESCE(cs.impressions,0)=0 THEN 0
             ELSE cs.spent * 1000.0 / cs.impressions END               AS actual_cpm,
        CASE WHEN cov.has_cf OR COALESCE(cs.impressions,0)=0 THEN 0
             ELSE cs.clicks * 100.0 / cs.impressions END               AS ctr_pct,
        CASE WHEN cov.has_cf OR COALESCE(cs.clicks,0)=0 THEN 0
             ELSE cs.spent / cs.clicks END                             AS actual_cpc,
        CASE WHEN cov.has_cf OR COALESCE(cs.clicks,0)=0 THEN 0
             ELSE cs.conversions * 100.0 / cs.clicks END               AS conversion_rate_pct,
        CASE WHEN cov.has_cf OR COALESCE(cs.conversions,0)=0 THEN 0
             ELSE cs.spent / cs.conversions END                        AS actual_cpa,
        CASE WHEN ia.ad_clicks = 0 THEN 0
             ELSE ia.revenue / ia.ad_clicks END                        AS rpc,
        CASE WHEN ia.revenue = 0 THEN 0
             ELSE (ia.revenue - CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.spent,0) END)
                  * 100.0 / ia.revenue END                             AS margin_pct,
        ia.revenue - CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.spent,0) END AS profit,
        CASE WHEN ia.ad_clicks = 0 THEN 0
             ELSE (CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.spent,0) END)
                  / ia.ad_clicks END                                   AS yahoo_cpa,
        (CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.conversions,0) END) - ia.ad_clicks AS conversion_scrub,
        CASE WHEN (CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.conversions,0) END) = 0 THEN 0
             ELSE ((CASE WHEN cov.has_cf THEN 0 ELSE COALESCE(cs.conversions,0) END) - ia.ad_clicks)
                  * 100.0 / (CASE WHEN cov.has_cf THEN 0 ELSE cs.conversions END) END AS scrub_rate_pct
      FROM ia_camp ia
      LEFT JOIN campaigns c ON c.id = ia.campaign_db_id
      -- Unattributed IA revenue (campaign_ext_id resolves to neither a campaign
      -- nor an ad) groups to a NULL campaign, so acc.id was NULL and accClause
      -- dropped it: the Campaign tab (which reads the MV) counted it, the Ads tab
      -- did not, and Campaign == Ads broke by that amount under ANY account
      -- filter -- $200.88 on account 239 in a 2026-08-25..09-08 window.
      -- The MV books it via its ia_orphan lateral, so reproduce that exact pick
      -- here. REQUIRES migration 047: 046's lateral has no ORDER BY and is
      -- genuinely nondeterministic, so the two can only agree once both are in.
      LEFT JOIN ad_accounts acc ON acc.id = COALESCE(c.ad_account_id, ${IA_ORPHAN_ACCT})
      LEFT JOIN cs          ON cs.campaign_id = c.id
      LEFT JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM cf_rep r JOIN ads a ON a.id = r.ad_db_id
          WHERE a.campaign_id = c.id
        ) AS has_cf
      ) cov ON TRUE
      WHERE (ia.revenue > 0 OR ia.sessions > 0)
        ${accClause} ${campClause} ${statClause}

      UNION ALL

      -- Codefuel orphan assets (no ads mapping)
      SELECT
        -2::int                                                         AS ad_id,
        '(Unattributed - Codefuel Orphans)'::text                      AS taboola_ad_id,
        NULL::text                                                      AS ad_title,
        NULL::text                                                      AS gd_param,
        NULL::text                                                      AS r_param,
        NULL::text                                                      AS campaign_id,
        NULL::text                                                      AS campaign_name,
        COALESCE(SUM(p.revenue),   0)                                  AS revenue,
        COALESCE(SUM(p.ad_clicks), 0)                                  AS ad_clicks,
        COALESCE(SUM(p.sessions),  0)                                  AS sessions,
        0::numeric                                                      AS impressions,
        0::numeric                                                      AS clicks,
        0::numeric                                                      AS conversions,
        0::numeric                                                      AS spent,
        0::numeric                                                      AS actual_cpm,
        0::numeric                                                      AS ctr_pct,
        0::numeric                                                      AS actual_cpc,
        0::numeric                                                      AS conversion_rate_pct,
        0::numeric                                                      AS actual_cpa,
        CASE WHEN SUM(p.ad_clicks) = 0 THEN 0
             ELSE SUM(p.revenue) / SUM(p.ad_clicks) END                AS rpc,
        CASE WHEN SUM(p.revenue) = 0 THEN 0
             ELSE (SUM(p.revenue) - 0) * 100.0 / SUM(p.revenue) END    AS margin_pct,
        SUM(p.revenue)                                                  AS profit,
        0::numeric                                                      AS yahoo_cpa,
        0 - COALESCE(SUM(p.ad_clicks), 0)                              AS conversion_scrub,
        0::numeric                                                      AS scrub_rate_pct
      FROM partner_stats_hourly p
      JOIN client_partners cp ON cp.id = p.client_partner_id AND cp.code = 'codefuel'
      -- Resolve the orphan's account (same rules as the MV) so the row respects
      -- the account filter; unresolvable orphans only show on the unfiltered view.
      LEFT JOIN LATERAL (
        SELECT c.ad_account_id
        FROM ads a JOIN campaigns c ON c.id = a.campaign_id
        WHERE a.gd_param = p.asset_gid
        GROUP BY c.ad_account_id
        HAVING COUNT(DISTINCT c.ad_account_id) = 1
        LIMIT 1
      ) gid ON TRUE
      LEFT JOIN campaigns ch ON ch.external_id = p.channel
      LEFT JOIN ad_accounts acc ON acc.id = COALESCE(gid.ad_account_id, ch.ad_account_id)
      WHERE p.campaign_ext_id IS NULL
        AND ${psSource}
        AND p.hour_utc >= $1::timestamptz
        AND p.hour_utc < ($2::timestamptz + INTERVAL '1 day')
        AND NOT EXISTS (SELECT 1 FROM ads a WHERE a.gd_param = p.asset_gid AND a.r_param = p.channel)
        -- Same feed fix as cf_key / ob_cf_rev: Codefuel is never Flux, and the
        -- MV's codefuel_orphan branch emits revenue_flux = 0. Without this the
        -- Campaign tab showed $0 under feed=flux while this row showed the full
        -- orphan amount ($161.50 over all history) — Campaign != Ads.
        ${iaFeed}
        ${accClause}
        -- Orphans belong to no campaign, so no status can match them. The MV
        -- drops them under a status filter (their campaign_external_id is NULL,
        -- which fails the IN test), so match that or the two tabs disagree.
        AND ${p.status ? 'FALSE' : 'TRUE'}
      HAVING SUM(p.revenue) > 0 OR SUM(p.sessions) > 0

      UNION ALL

      -- Taboola cost on campaigns that have NO ad-level revenue mapping.
      -- Taboola spend is campaign-level (no ad_id); a campaign only gets per-ad
      -- rows above if one of its ads earned Codefuel revenue. Image Advantage
      -- revenue is account-level (never per ad), so IA campaigns' cost — which is
      -- the majority of spend — would otherwise vanish from this tab. Surface it
      -- as one aggregate row so the Ads-tab cost total reconciles with the
      -- Daily/Campaign/Country/Device tabs. Respects account/campaign filters.
      SELECT
        -3::int                                                         AS ad_id,
        '(Unattributed Taboola cost — campaigns with no ad-level revenue mapping)'::text AS taboola_ad_id,
        NULL::text                                                      AS ad_title,
        NULL::text                                                      AS gd_param,
        NULL::text                                                      AS r_param,
        NULL::text                                                      AS campaign_id,
        NULL::text                                                      AS campaign_name,
        0::numeric                                                      AS revenue,
        0::numeric                                                      AS ad_clicks,
        0::numeric                                                      AS sessions,
        COALESCE(SUM(cs.impressions), 0)                                AS impressions,
        COALESCE(SUM(cs.clicks), 0)                                     AS clicks,
        COALESCE(SUM(cs.conversions), 0)                                AS conversions,
        COALESCE(SUM(cs.spent), 0)                                      AS spent,
        CASE WHEN COALESCE(SUM(cs.impressions),0) = 0 THEN 0
             ELSE SUM(cs.spent) * 1000.0 / SUM(cs.impressions) END      AS actual_cpm,
        CASE WHEN COALESCE(SUM(cs.impressions),0) = 0 THEN 0
             ELSE SUM(cs.clicks) * 100.0 / SUM(cs.impressions) END      AS ctr_pct,
        CASE WHEN COALESCE(SUM(cs.clicks),0) = 0 THEN 0
             ELSE SUM(cs.spent) / SUM(cs.clicks) END                    AS actual_cpc,
        CASE WHEN COALESCE(SUM(cs.clicks),0) = 0 THEN 0
             ELSE SUM(cs.conversions) * 100.0 / SUM(cs.clicks) END      AS conversion_rate_pct,
        CASE WHEN COALESCE(SUM(cs.conversions),0) = 0 THEN 0
             ELSE SUM(cs.spent) / SUM(cs.conversions) END               AS actual_cpa,
        0::numeric                                                      AS rpc,
        0::numeric                                                      AS margin_pct,
        -COALESCE(SUM(cs.spent), 0)                                     AS profit,
        0::numeric                                                      AS yahoo_cpa,
        COALESCE(SUM(cs.conversions), 0)                               AS conversion_scrub,
        CASE WHEN COALESCE(SUM(cs.conversions),0) = 0 THEN 0 ELSE 100 END AS scrub_rate_pct
      FROM cs
      JOIN campaigns c     ON c.id   = cs.campaign_id
      JOIN ad_accounts acc ON acc.id = c.ad_account_id
      WHERE NOT EXISTS (
              SELECT 1 FROM cf_rep r JOIN ads a ON a.id = r.ad_db_id
              WHERE a.campaign_id = cs.campaign_id
            )
        -- IA campaigns now carry their own cost on the IA (-1) rows above; exclude
        -- them here so campaign spend is not counted twice.
        AND NOT EXISTS (
              SELECT 1 FROM ia_camp ia
              WHERE ia.campaign_db_id = c.id
                AND (ia.revenue > 0 OR ia.sessions > 0)
            )
        ${accClause} ${campClause} ${statClause}
      HAVING COALESCE(SUM(cs.spent), 0) <> 0

      ORDER BY revenue DESC NULLS LAST
    `,
  };
}

// ---------- Totals ----------
// Rates are recomputed from summed numerator/denominator — averaging per-row
// rates is mathematically wrong (each row has different weight).
function computeTotals(rows: any[]): Record<string, number> {
  if (rows.length === 0) return {};
  const s = (k: string) => rows.reduce((acc: number, r: any) => acc + (Number(r[k]) || 0), 0);
  const impressions  = s('impressions');
  const clicks       = s('clicks');
  const spent        = s('spent');
  const revenue      = s('revenue');
  const conversions  = s('conversions');
  const ad_clicks    = s('ad_clicks');
  const sessions     = s('sessions');
  const profit       = revenue - spent;
  const conversion_scrub = conversions - ad_clicks;
  return {
    impressions, clicks, spent, revenue, conversions, ad_clicks, sessions, profit,
    actual_cpm:          impressions > 0  ? spent * 1000 / impressions              : 0,
    ctr_pct:             impressions > 0  ? clicks * 100 / impressions              : 0,
    actual_cpc:          clicks > 0       ? spent / clicks                          : 0,
    conversion_rate_pct: clicks > 0       ? conversions * 100 / clicks              : 0,
    actual_cpa:          conversions > 0  ? spent / conversions                     : 0,
    rpc:                 ad_clicks > 0    ? revenue / ad_clicks                     : 0,
    margin_pct:          revenue > 0      ? (revenue - spent) * 100 / revenue       : 0,
    yahoo_cpa:           ad_clicks > 0    ? spent / ad_clicks                       : 0,
    conversion_scrub,
    scrub_rate_pct:      conversions > 0  ? conversion_scrub * 100 / conversions    : 0,
  };
}

// ---------- Error handler ----------
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error({ err }, 'api error');
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid query', details: err.format() });
  }
  res.status(500).json({ error: 'Internal error' });
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'API server listening');
});
