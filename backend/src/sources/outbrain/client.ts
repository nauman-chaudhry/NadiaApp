import axios, { AxiosInstance } from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// =============================================================================
// Outbrain Amplify API client.
//   - Auth: GET /login with Basic auth -> { "OB-TOKEN-V1": token }.
//   - Token is valid ~30 days, but /login is rate-limited to 2 req/hour, so the
//     token is PERSISTED to disk and reused across runs/processes. Logging in on
//     every sync trips the rate limit (HTTP 429) — never do it.
//   - Subsequent calls send the token in the OB-TOKEN-V1 header.
// =============================================================================

const TOKEN_FILE = path.resolve(process.cwd(), '.cache', 'outbrain-token.json');
const TOKEN_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000; // refresh well before 30d expiry

export interface CachedToken { token: string; savedAt: number }

/**
 * Pluggable durable cache for the token. This file stays HTTP-only (repo
 * convention), so it does not know about the database; `sync/outbrain.ts`
 * installs a store backed by the `app_settings` table (migration 048).
 *
 * Why a durable store matters: /login is limited to 2 calls/hour per
 * credential, Outbrain will not issue a second credential, and the on-disk
 * cache below is wiped on every Render deploy. With two deployments (Nadia,
 * Joe) on one credential, two redeploys in the same hour used to exhaust the
 * limit. Lookup order: memory → store → file → login. A token found only in the
 * file is copied into the store so an existing deployment migrates without a
 * login.
 */
export interface OutbrainTokenStore {
  load(): Promise<CachedToken | null>;
  save(t: CachedToken): Promise<void>;
}

let store: OutbrainTokenStore | null = null;
export function setOutbrainTokenStore(s: OutbrainTokenStore): void { store = s; }

let mem: CachedToken | null = null;

const fresh = (t: CachedToken | null | undefined): t is CachedToken =>
  !!t && typeof t.token === 'string' && t.token.length > 0 && Date.now() - t.savedAt < TOKEN_MAX_AGE_MS;

async function readFileToken(): Promise<CachedToken | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8')) as CachedToken;
    return fresh(parsed) ? parsed : null;
  } catch { return null; }
}

async function readCachedToken(): Promise<string | null> {
  if (fresh(mem)) return mem!.token;
  if (store) {
    try {
      const t = await store.load();
      if (fresh(t)) { mem = t; return t.token; }
    } catch (e: any) {
      // e.g. app_settings not migrated yet on this DB — fall through to the file.
      logger.warn({ err: e.message }, 'Outbrain: token store unavailable, using file cache');
    }
  }
  const f = await readFileToken();
  if (f) {
    mem = f;
    if (store) {
      try { await store.save(f); logger.info('Outbrain: seeded token store from file cache'); }
      catch (e: any) { logger.warn({ err: e.message }, 'Outbrain: could not seed token store'); }
    }
    return f.token;
  }
  return null;
}

async function writeCachedToken(token: string): Promise<void> {
  mem = { token, savedAt: Date.now() };
  if (store) {
    try { await store.save(mem); }
    catch (e: any) { logger.warn({ err: e.message }, 'Outbrain: could not persist token to store'); }
  }
  try {
    await fs.mkdir(path.dirname(TOKEN_FILE), { recursive: true });
    await fs.writeFile(TOKEN_FILE, JSON.stringify(mem), 'utf8');
  } catch (e: any) {
    logger.warn({ err: e.message }, 'Outbrain: could not write token file cache');
  }
}

async function login(): Promise<string> {
  if (!env.OUTBRAIN_USERNAME || !env.OUTBRAIN_PASSWORD) {
    throw new Error('Outbrain credentials not set');
  }
  try {
    const res = await axios.get(`${env.OUTBRAIN_API_BASE}/login`, {
      auth: { username: env.OUTBRAIN_USERNAME, password: env.OUTBRAIN_PASSWORD },
      timeout: 30_000,
    });
    const token = res.data['OB-TOKEN-V1'];
    if (!token) throw new Error('login returned no OB-TOKEN-V1');
    await writeCachedToken(token);
    logger.info('Outbrain: obtained and cached new token');
    return token;
  } catch (e: any) {
    if (e.response?.status === 429) {
      throw new Error('Outbrain /login rate-limited (2/hour). Reuse the cached token; do not re-login.');
    }
    throw e;
  }
}

async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await readCachedToken();
    if (cached) return cached;
  }
  return login();
}

async function makeClient(forceRefresh = false): Promise<AxiosInstance> {
  const token = await getToken(forceRefresh);
  return axios.create({
    baseURL: env.OUTBRAIN_API_BASE,
    headers: { 'OB-TOKEN-V1': token },
    timeout: 60_000,
  });
}

// Wrap a call so that a 401 (expired token) triggers exactly ONE re-login+retry,
// and a 429 (reporting rate limit) backs off using the documented header.
async function withClient<T>(fn: (c: AxiosInstance) => Promise<T>): Promise<T> {
  let client = await makeClient();
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(client);
    } catch (e: any) {
      const status = e.response?.status;
      if (status === 401 && attempt === 0) {
        client = await makeClient(true); // token expired -> one fresh login
        continue;
      }
      if (status === 429 && attempt < 3) {
        const waitMs = Number(e.response?.headers?.['rate-limit-msec-left']) || 5000;
        logger.warn({ waitMs }, 'Outbrain: reporting rate limit, backing off');
        await new Promise((r) => setTimeout(r, waitMs + 250));
        continue;
      }
      throw e;
    }
  }
}

// ---------- Types ----------

export interface OutbrainMarketer {
  id: string;
  name: string;        // 'SBH_ssm_01' .. 'SBH_ssm_07'
  enabled: boolean;
}

export interface OutbrainCampaign {
  id: string;
  name: string;        // e.g. 'US-Laboratory Equipment-9251' (suffix = GID)
  marketerId: string;
  enabled: boolean;
  liveStatus?: { campaignOnAir?: boolean; onAirStatus?: string };
  suffixTrackingCode?: string;
  prefixTrackingCode?: string;
}

export interface OutbrainPromotedLink {
  id: string;
  url: string;         // landing URL — carries gd= and r= params
  text?: string;
  enabled?: boolean;
}

// Per-campaign cost for one day. Outbrain's reporting API exposes per-campaign
// metrics at DAILY grain (the campaigns report); per-campaign HOURLY is not
// available (only marketer-level hourOfDay), and cost/revenue do not hour-align
// anyway (search monetisation lags the click), so daily is the right grain.
// The `day` is Outbrain's reported day, which is EDT — see outbrain-tz.ts.
export interface OutbrainCampaignCost {
  campaignId: string;   // Outbrain campaign id (hex)
  campaignName: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

// ---------- Public API ----------

export async function listMarketers(): Promise<OutbrainMarketer[]> {
  return withClient(async (c) => (await c.get('/marketers')).data.marketers ?? []);
}

/** All campaigns for a marketer (paginated). */
export async function listCampaigns(marketerId: string): Promise<OutbrainCampaign[]> {
  return withClient(async (c) => {
    const out: OutbrainCampaign[] = [];
    let offset = 0;
    const limit = 50;
    for (;;) {
      const { data } = await c.get(`/marketers/${marketerId}/campaigns`, {
        params: { limit, offset, extraFields: 'Locations' },
      });
      const batch: OutbrainCampaign[] = data.campaigns ?? [];
      out.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return out;
  });
}

/**
 * Per-campaign cost for a single day, for one marketer. Uses the campaigns
 * performance report (campaign-grain, no time sub-split). `day` is 'YYYY-MM-DD'
 * in Outbrain's reporting calendar (EDT). Pass from===to===day.
 */
export async function fetchCampaignCost(
  marketerId: string,
  day: string,
): Promise<OutbrainCampaignCost[]> {
  return withClient(async (c) => {
    const out: OutbrainCampaignCost[] = [];
    let offset = 0;
    const limit = 50;
    for (;;) {
      const { data } = await c.get(`/reports/marketers/${marketerId}/campaigns`, {
        params: { from: day, to: day, limit, offset },
      });
      const results: any[] = data.results ?? [];
      for (const r of results) {
        const m = r.metadata ?? {};
        const x = r.metrics ?? {};
        out.push({
          campaignId: m.id,
          campaignName: m.name ?? '',
          impressions: Number(x.impressions || 0),
          clicks: Number(x.clicks || 0),
          conversions: Number(x.conversions || 0),
          spend: Number(x.spend || 0),
        });
      }
      if (results.length < limit) break;
      offset += limit;
    }
    return out;
  });
}

// ---------- Marketer-level hourly cost ----------

export interface OutbrainHourRow {
  hour: number;         // 0-23, in Outbrain's reporting timezone (EDT)
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

/**
 * Account-level HOURLY cost for a single day. The API rejects
 * breakdown=hourly on /periodic, but breakdown=hourOfDay with from=to=<day>
 * returns that day's 24 hourly buckets aggregated across the marketer's
 * campaigns (per-campaign hourly is not exposed). Hours are in Outbrain's
 * reporting timezone (EDT) — the sync converts to UTC.
 */
export async function fetchMarketerHourly(
  marketerId: string,
  day: string,
): Promise<OutbrainHourRow[]> {
  return withClient(async (c) => {
    // limit: /periodic defaults to 10 result rows — without it only the first
    // 10 hours of the day come back (found the hard way: totals were ~30% of
    // the daily report). A day has at most 24 buckets.
    const { data } = await c.get(`/reports/marketers/${marketerId}/periodic`, {
      params: { from: day, to: day, breakdown: 'hourOfDay', limit: 24 },
    });
    const out: OutbrainHourRow[] = [];
    for (const r of (data.results ?? [])) {
      const hh = String(r.metadata?.hourOfDay ?? '');   // "00:00" .. "23:00"
      const hour = parseInt(hh.slice(0, 2), 10);
      if (isNaN(hour)) continue;
      const x = r.metrics ?? {};
      out.push({
        hour,
        impressions: Number(x.impressions || 0),
        clicks: Number(x.clicks || 0),
        conversions: Number(x.conversions || 0),
        spend: Number(x.spend || 0),
      });
    }
    return out;
  });
}

// ---------- Breakdown report row types ----------

export interface OutbrainAdRow {
  promotedLinkId: string;    // metadata.identifier (numeric string)
  promotedLinkUuid: string;  // metadata.id (hex)
  campaignId: string;        // metadata.campaignId (hex)
  campaignName: string;
  title: string;
  url: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

export interface OutbrainCountryRow {
  countryCode: string;  // metadata.code ("US")
  countryName: string;  // metadata.name
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

export interface OutbrainPublisherRow {
  publisherId: string;    // metadata.identifier (numeric)
  publisherUuid: string;  // metadata.id (hex)
  publisherName: string;
  publisherUrl: string;
  impressions: number;
  clicks: number;
  conversions: number;
  spend: number;
}

/** Per-promoted-link daily cost for a marketer on a single day (paginated). */
export async function fetchAdBreakdown(
  marketerId: string,
  day: string,
): Promise<OutbrainAdRow[]> {
  return withClient(async (c) => {
    const out: OutbrainAdRow[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data } = await c.get(`/reports/marketers/${marketerId}/promotedContent`, {
        params: { from: day, to: day, limit, offset },
      });
      const results: any[] = data.results ?? [];
      for (const r of results) {
        const m = r.metadata ?? {};
        const x = r.metrics ?? {};
        if ((Number(x.spend) || 0) === 0 && (Number(x.clicks) || 0) === 0) continue;
        out.push({
          promotedLinkId:   String(m.identifier ?? ''),
          promotedLinkUuid: m.id ?? '',
          campaignId:       m.campaignId ?? '',
          campaignName:     m.campaignName ?? '',
          title:            m.title ?? '',
          url:              m.url ?? '',
          impressions:      Number(x.impressions || 0),
          clicks:           Number(x.clicks      || 0),
          conversions:      Number(x.totalConversions || x.conversions || 0),
          spend:            Number(x.spend        || 0),
        });
      }
      if (results.length < limit) break;
      offset += limit;
    }
    return out;
  });
}

/** Per-country daily cost for a marketer on a single day. */
export async function fetchCountryBreakdown(
  marketerId: string,
  day: string,
): Promise<OutbrainCountryRow[]> {
  return withClient(async (c) => {
    const out: OutbrainCountryRow[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data } = await c.get(`/reports/marketers/${marketerId}/geo`, {
        params: { from: day, to: day, breakdown: 'country', limit, offset },
      });
      const results: any[] = data.results ?? [];
      for (const r of results) {
        const m = r.metadata ?? {};
        const x = r.metrics ?? {};
        if ((Number(x.spend) || 0) === 0 && (Number(x.clicks) || 0) === 0) continue;
        out.push({
          countryCode:  m.code  ?? m.id ?? '',
          countryName:  m.name  ?? '',
          impressions:  Number(x.impressions || 0),
          clicks:       Number(x.clicks      || 0),
          conversions:  Number(x.totalConversions || x.conversions || 0),
          spend:        Number(x.spend        || 0),
        });
      }
      if (results.length < limit) break;
      offset += limit;
    }
    return out;
  });
}

/** Per-publisher daily cost for a marketer on a single day (paginated). */
export async function fetchPublisherBreakdown(
  marketerId: string,
  day: string,
): Promise<OutbrainPublisherRow[]> {
  return withClient(async (c) => {
    const out: OutbrainPublisherRow[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data } = await c.get(`/reports/marketers/${marketerId}/publishers`, {
        params: { from: day, to: day, limit, offset },
      });
      const results: any[] = data.results ?? [];
      for (const r of results) {
        const m = r.metadata ?? {};
        const x = r.metrics ?? {};
        if ((Number(x.spend) || 0) === 0 && (Number(x.clicks) || 0) === 0) continue;
        out.push({
          publisherId:   String(m.identifier ?? ''),
          publisherUuid: m.id   ?? '',
          publisherName: m.name ?? '',
          publisherUrl:  m.url  ?? '',
          impressions:   Number(x.impressions || 0),
          clicks:        Number(x.clicks      || 0),
          conversions:   Number(x.totalConversions || x.conversions || 0),
          spend:         Number(x.spend        || 0),
        });
      }
      if (results.length < limit) break;
      offset += limit;
    }
    return out;
  });
}

/** Promoted links (ads) for a campaign — their URLs carry the gd/r params. */
export async function listPromotedLinks(campaignId: string): Promise<OutbrainPromotedLink[]> {
  return withClient(async (c) => {
    const out: OutbrainPromotedLink[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const { data } = await c.get(`/campaigns/${campaignId}/promotedLinks`, {
        params: { limit, offset },
      });
      const batch: OutbrainPromotedLink[] = data['promoted-links'] ?? data.promotedLinks ?? [];
      out.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return out;
  });
}
