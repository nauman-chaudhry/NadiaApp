import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// =============================================================================
// Codefuel/Perion client — confirmed from API docs screenshots
//
// Auth flow (OAuth2 client_credentials):
//   POST https://search-auth.perion.com/oauth/token
//   Content-Type: application/json
//   { client_id, client_secret, audience: "codefuel-api", grant_type: "client_credentials" }
//   → { access_token, token_type: "Bearer" }
//
// Then on every API call:
//   GET https://search-api.perion.com/api/io/...
//   Authorization: Bearer <access_token>
//
// Rate limit: 60 req/hour/account, sliding window, 429 = back off
// =============================================================================

const AUTH_URL = 'https://search-auth.perion.com/oauth/token';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  // Optional in env.ts since tenancy (a deployment may not run Codefuel at
  // all); env.ts already refuses to boot if codefuel is ENABLED without them.
  if (!env.CODEFUEL_CLIENT_ID || !env.CODEFUEL_CLIENT_SECRET) {
    throw new Error('Codefuel credentials not set (CODEFUEL_CLIENT_ID / CODEFUEL_CLIENT_SECRET)');
  }
  const res = await axios.post(
    AUTH_URL,
    {
      client_id: env.CODEFUEL_CLIENT_ID,
      client_secret: env.CODEFUEL_CLIENT_SECRET,
      audience: 'codefuel-api',
      grant_type: 'client_credentials',
    },
    { headers: { 'Content-Type': 'application/json' } },
  );

  // The screenshot shows access_token + token_type but no expires_in field.
  // JWTs typically last 24h for Auth0-style flows; we read the actual exp from
  // the JWT payload and fall back to 1h if it's missing.
  const token: string = res.data.access_token;
  const expiresAt = readJwtExp(token) ?? Date.now() + 60 * 60 * 1000;

  cachedToken = { token, expiresAt };
  logger.info({ expiresAt: new Date(expiresAt).toISOString() }, 'Refreshed Codefuel access token');
  return token;
}

function readJwtExp(jwt: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function makeClient(): Promise<AxiosInstance> {
  const token = await getAccessToken();
  return axios.create({
    baseURL: env.CODEFUEL_API_BASE,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  });
}

// ---------- Rate-limit-aware request helper ----------
// On 429, wait 60s before retry (one request slot recovers per minute).

export async function codefuelRequest<T = any>(
  path: string,
  params: Record<string, any>,
): Promise<T> {
  const client = await makeClient();
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { data } = await client.get<T>(path, { params });
      return data;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401 && attempt === 1) {
        // Token may have expired earlier than tracked — force refresh
        cachedToken = null;
        logger.warn({ path }, 'Codefuel 401 — forcing token refresh');
        continue;
      }
      if (status === 429) {
        const waitMs = 60_000 * attempt;
        logger.warn({ path, attempt, waitMs }, 'Codefuel 429 — backing off');
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Codefuel ${path}: exceeded retry budget`);
}

// =============================================================================
// Types — confirmed from getHourlyPerformanceData docs
// =============================================================================

export interface CodefuelRow {
  // Identification fields (present when requested as breakdowns)
  date?: string;            // 'YYYY-MM-DD'
  hour?: number;            // 0-23 (only on hourly endpoint with hour breakdown)
  country_code?: string;
  country_name?: string;
  asset_gid?: string;
  source_platform?: string;
  device?: string;          // 'Desktop' | 'Mobile' | 'Tablet' | 'Other'
  channel?: string;
  wallet?: string;

  // Metrics (when requested via metrics=all or a specific list)
  revenue?: number;
  ad_clicks?: number;
  ctr?: number;
  rpc?: number;
  sessions?: number;
  rpm?: number;
}

// =============================================================================
// Public fetchers
// =============================================================================

/**
 * Hourly performance — only available for the last 14 days.
 * We pass `hour` as a breakdown so we get one row per hour bucket.
 */
export async function fetchHourlyPerformance(opts: {
  startDate: string;   // 'YYYY-MM-DD'
  endDate: string;
  assetGids?: string;  // comma-separated, default 'all'
  channels?: string;   // comma-separated, default 'all'
}): Promise<CodefuelRow[]> {
  const data = await codefuelRequest<CodefuelRow[] | { results: CodefuelRow[] }>(
    '/io/getHourlyPerformanceData',
    {
      start_date: opts.startDate,
      end_date: opts.endDate,
      breakdowns: 'date,hour,country_code,asset_gid,channel,device,source_platform',
      metrics: 'all',
      asset_gids: opts.assetGids ?? 'all',
      channels: opts.channels ?? 'all',
      format: 'JSON',
    },
  );
  return Array.isArray(data) ? data : (data as any).results ?? [];
}

/**
 * Daily performance — available for the last 3 months. Used for older backfill
 * before the 14-day hourly window opens up.
 */
export async function fetchDailyPerformance(opts: {
  startDate: string;
  endDate: string;
  assetGids?: string;
  channels?: string;
}): Promise<CodefuelRow[]> {
  const data = await codefuelRequest<CodefuelRow[] | { results: CodefuelRow[] }>(
    '/io/getDailyPerformanceData',
    {
      start_date: opts.startDate,
      end_date: opts.endDate,
      breakdowns: 'date,country_code,asset_gid,channel,device,source_platform',
      metrics: 'all',
      asset_gids: opts.assetGids ?? 'all',
      channels: opts.channels ?? 'all',
      format: 'JSON',
    },
  );
  return Array.isArray(data) ? data : (data as any).results ?? [];
}

/**
 * Yahoo GCLID revenue breakdown — last 7 days only.
 * Used to attribute revenue back to specific click IDs.
 */
export async function fetchGclidBreakdown(opts: {
  startDate: string;
  endDate: string;
}): Promise<any[]> {
  const data = await codefuelRequest<{ results: any[] }>(
    '/io/getClickIdRevenueBreakdown',
    {
      start_date: opts.startDate,
      end_date: opts.endDate,
      breakdowns: 'date,gid,click_id,conversion_name,conversion_time,conversion_currency,asset_gid',
      metrics: 'conversion_value',
      format: 'JSON',
    },
  );
  return data.results ?? [];
}
