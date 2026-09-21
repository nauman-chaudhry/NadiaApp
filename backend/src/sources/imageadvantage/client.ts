import axios from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// =============================================================================
// Image Advantage (AMOS) client
//
// Auth: POST https://api.vpptechia.com/v1/auth/login  (form-encoded)
//   → { token: "{id}|{hash}", ... }  (Laravel Sanctum personal access token)
//   Token lifetime unknown — re-auth each sync run (token cached per process).
//
// Revenue endpoints (account 398, Taboola affiliates only):
//   GET /v1/y-metrics/revenue/hourly/by-affiliate?account_id=398&affiliate=...&date=YYYY-MM-DD&page=N
//   GET /v1/y-metrics/revenue/daily/by-affiliate?account_id=398&affiliate=...&date=YYYY-MM-DD&page=N
//   Single-day only, paginated at 5000 rows/page.
//
// Affiliates in scope (all under account 398):
//   Taboola (.tb): ssm.n2s.{hpc,pro,s4s}.tb | ssm.flux.{pro,s4s,hpc}.tb
//   Outbrain (.ob): ssm.n2s.pro.ob | ssm.n2s.s4s.ob | ssm.n2s.hpc.ob
// The sync tags source_platform from the affiliate suffix (.tb→Taboola, .ob→Outbrain).
// ssm.flux.*.tb (added 2026-06: new IA affiliates, Taboola traffic from 2026-06-02).
// =============================================================================

const BASE_URL = env.IMAGE_ADVANTAGE_API_BASE;
const ACCOUNT_ID = env.IMAGE_ADVANTAGE_ACCOUNT_ID;

// Taboola affiliates. ssm.flux.*.tb are new IA affiliates (Taboola traffic from
// 2026-06-02); they carry the same .tb suffix so source_platform tags as Taboola
// and they reuse the existing numeric user_tag join logic — no new code needed.
// ssm.n2s.*.tb-2 (added 2026-07: Yahoo-SSM1's affiliates, traffic from Jul 1).
// NOTE: y-metrics now uses the UNFILTERED endpoints (all affiliates in one call),
// so this list only drives the x-metrics per-affiliate by-usertag fetches.
export const IA_TB_AFFILIATES = [
  'ssm.n2s.hpc.tb', 'ssm.n2s.pro.tb', 'ssm.n2s.s4s.tb',
  'ssm.flux.pro.tb', 'ssm.flux.s4s.tb', 'ssm.flux.hpc.tb',
  'ssm.n2s.hpc.tb-2', 'ssm.n2s.pro.tb-2', 'ssm.n2s.s4s.tb-2',
] as const;
// Outbrain affiliates — live under the SAME account (398). ssm_07 (hpc.ob) may be
// paused but is kept here so it resumes automatically when reactivated.
export const IA_OB_AFFILIATES = ['ssm.n2s.pro.ob', 'ssm.n2s.s4s.ob', 'ssm.n2s.hpc.ob'] as const;
// All affiliates fetched each run.
export const IA_ALL_AFFILIATES = [...IA_TB_AFFILIATES, ...IA_OB_AFFILIATES] as const;

let cachedToken: string | null = null;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const params = new URLSearchParams({
    email: env.IMAGE_ADVANTAGE_EMAIL,
    password: env.IMAGE_ADVANTAGE_PASSWORD,
  });
  const res = await axios.post(`${BASE_URL}/auth/login`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    decompress: true,
  });
  cachedToken = res.data.token as string;
  logger.info('Refreshed Image Advantage access token');
  return cachedToken!;
}

// Call at the start of each sync run so we don't reuse a potentially expired token.
export function resetIAToken() {
  cachedToken = null;
}

// ---------- Types ----------

export interface IARow {
  y_date:            string;   // 'YYYY-MM-DD'
  y_time?:           number;   // 0-23 UTC (hourly endpoint only)
  affiliate:         string;   // e.g. 'ssm.n2s.hpc.tb'
  user_tag:          string;   // '{campaign_id}.{item_id}.{site_slug}' or placeholder
  searches:          number;   // total searches triggered (broader)
  bidded_searches:   number;   // searches returning bidded results ← SESSIONS equivalent
  bidded_clicks:     number;   // clicks on bidded results ← AD CLICKS equivalent
  partner_rev_share: number;   // revenue in USD
  coverage?:        number;
  ctr?:             number;
  tq_score?:        number;
  account_id:       number;
}

interface PaginatedResponse {
  current_page: number;
  last_page:    number;
  total:        number;
  data:         IARow[];
}

// ---------- Request helper (retry on 401 + 429) ----------

async function iaRequest(path: string, params: Record<string, any>): Promise<PaginatedResponse> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = await getToken();
    try {
      const { data } = await axios.get<PaginatedResponse>(`${BASE_URL}${path}`, {
        params,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        decompress: true,
        timeout: 30_000,
      });
      return data;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401 && attempt === 1) {
        cachedToken = null;
        logger.warn({ path }, 'Image Advantage 401 — forcing token refresh');
        continue;
      }
      if (status === 429) {
        const waitMs = 60_000 * attempt;
        logger.warn({ path, attempt, waitMs }, 'Image Advantage 429 — backing off');
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Image Advantage ${path}: exceeded retry budget`);
}

// ---------- Fetch all pages for one (affiliate, date) pair ----------

async function fetchAllPages(path: string, affiliate: string, date: string): Promise<IARow[]> {
  const rows: IARow[] = [];
  let page = 1;
  while (true) {
    const res = await iaRequest(path, { account_id: ACCOUNT_ID, affiliate, date, page });
    rows.push(...res.data);
    if (page >= res.last_page) break;
    page++;
  }
  return rows;
}

// =============================================================================
// Public fetchers — y-metrics (Yahoo search) and x-metrics (non-Yahoo display).
// =============================================================================

// Fetch all pages of an UNFILTERED endpoint (no affiliate param) — the API
// returns every affiliate under the account, including ones created after the
// hardcoded list above was written. This is what makes new affiliates (e.g.
// ssm.n2s.*.tb-2, live Jul 1) appear automatically without a code change.
async function fetchAllPagesAllAffiliates(path: string, date: string): Promise<IARow[]> {
  const rows: IARow[] = [];
  let page = 1;
  while (true) {
    const res = await iaRequest(path, { account_id: ACCOUNT_ID, date, page });
    rows.push(...res.data);
    if (page >= res.last_page) break;
    page++;
  }
  return rows;
}

/**
 * Fetch hourly revenue for a single day across ALL affiliates (unfiltered
 * endpoint — auto-discovers new affiliates). Returns rows with y_time (0-23 UTC).
 */
export async function fetchIAHourly(date: string): Promise<IARow[]> {
  return fetchAllPagesAllAffiliates('/y-metrics/revenue/hourly', date);
}

/**
 * Fetch daily revenue for a single day across ALL affiliates (unfiltered
 * endpoint). One aggregated row per user_tag (no y_time field).
 */
export async function fetchIADaily(date: string): Promise<IARow[]> {
  return fetchAllPagesAllAffiliates('/y-metrics/revenue/daily', date);
}

// ---------- x-metrics (non-Yahoo display revenue) ----------

export interface IAXRow {
  date:              string;   // 'YYYY-MM-DD'
  account_id:        number;   // 398
  affiliate:         string;   // e.g. 'ssm.n2s.pro.tb'
  partner_rev_share: number;   // revenue in USD
  impressions:       number;
  clicks:            number;   // ad clicks equivalent
  ctr:               number;
  rpc:               number;
  rpi:               number;
  rpm:               number;
}

/**
 * Fetch x-metrics (non-Yahoo display) daily revenue for a single day.
 * All affiliates come back from one call (no per-affiliate filtering needed).
 * Returns daily totals at affiliate level (no user_tag breakdown).
 * NOTE: x-metrics has no hourly endpoint — daily only.
 */
export async function fetchIAXDaily(date: string): Promise<IAXRow[]> {
  const rows: IAXRow[] = [];
  let page = 1;
  while (true) {
    const res = await iaRequest('/x-metrics/revenue/daily', { account_id: ACCOUNT_ID, date, page });
    rows.push(...(res.data as unknown as IAXRow[]));
    if (page >= res.last_page) break;
    page++;
  }
  return rows;
}

// Per-user_tag x-metrics row — adds user_tag (campaign/item join key) to IAXRow.
export interface IAXUsertagRow extends IAXRow {
  user_tag: string;   // '{campaign_id}.{item_id}.{site_slug}' or placeholder
}

/**
 * Fetch x-metrics (non-Yahoo display) daily revenue broken out per user_tag,
 * for a single day across all Taboola affiliates. The user_tag carries the
 * Taboola campaign/item id so revenue can be attributed per campaign — same
 * format as the y-metrics by-affiliate user_tag. x-metrics has no .ob
 * affiliates, so we only iterate the Taboola (.tb) list.
 */
export async function fetchIAXByUsertag(date: string): Promise<IAXUsertagRow[]> {
  const all: IAXUsertagRow[] = [];
  for (const affiliate of IA_TB_AFFILIATES) {
    let page = 1;
    while (true) {
      const res = await iaRequest('/x-metrics/revenue/daily/by-usertag', { account_id: ACCOUNT_ID, affiliate, date, page });
      for (const r of res.data as unknown as IAXUsertagRow[]) {
        all.push({ ...r, affiliate });   // ensure affiliate present even if API omits it
      }
      if (page >= res.last_page) break;
      page++;
    }
  }
  return all;
}
