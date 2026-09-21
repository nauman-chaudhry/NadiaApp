import axios, { AxiosInstance } from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// Taboola Backstage API — OAuth2 client_credentials.
// Token lasts ~12h; cached and refreshed on expiry.

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await axios.post(
    'https://backstage.taboola.com/backstage/oauth/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.TABOOLA_CLIENT_ID,
      client_secret: env.TABOOLA_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  cachedToken = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in ?? 43200) * 1000,
  };
  logger.info('Refreshed Taboola access token');
  return cachedToken.token;
}

async function makeClient(): Promise<AxiosInstance> {
  const token = await getAccessToken();
  return axios.create({
    baseURL: env.TABOOLA_API_BASE,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60_000,
  });
}

// Paginate through any endpoint that returns { results: T[] }.
// Taboola requires `page` (1-indexed) and `page_size`. Stops when a page
// returns fewer rows than page_size.
async function paginate<T>(
  client: AxiosInstance,
  path: string,
  params: Record<string, any>,
  pageSize = 100,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const { data } = await client.get(path, { params: { ...params, page, page_size: pageSize } });
    const results: T[] = data.results ?? data ?? [];
    all.push(...results);
    if (results.length < pageSize) break;
    page++;
  }
  return all;
}

// ---------- Types ----------

export interface TaboolaAccount {
  id: number;
  account_id: string;    // e.g. 'tdg-sevenspheremedia4433-adv1-sc'
  name: string;
  type: string;          // 'PARTNER' | 'NETWORK'
  is_active: boolean;
  currency: string;
  time_zone_name: string;
}

export interface TaboolaCampaign {
  id: string;
  advertiser_id: string; // the sub-account that owns this campaign
  name: string;
  status: string;        // 'RUNNING' | 'PAUSED' | 'TERMINATED'
  is_active: boolean;
}

export interface TaboolaItem {
  id: string;
  campaign_id: string;
  title: string;
  url: string;
  status: string;
  is_active: boolean;
}

// Row from top-campaign-content/item_breakdown — includes item URL with gd/r.
export interface TaboolaContentItem {
  item: string;                      // item id (= r param)
  item_name: string;
  url: string;                       // landing URL with gd= and r=
  campaign: string;
  campaign_name: string;
  content_provider_id_name: string;  // advertiser account id
  impressions: number;
  clicks: number;
  spent: number;
}

// Row from campaign_hour_breakdown — campaign-level hourly stats.
export interface TaboolaStatRow {
  date: string;       // 'YYYY-MM-DD HH:00:00.0' for hour breakdown
  campaign: string;   // campaign external id
  campaign_name: string;
  clicks: number;
  impressions: number;
  visible_impressions?: number; // IAB-viewable impressions — what Taboola UI calls "Impressions"
  spent: number;
  cpa_actions_num: number;
}

// ---------- Public API methods ----------

/** List all accounts accessible to this API credential. */
export async function listAllowedAccounts(): Promise<TaboolaAccount[]> {
  const client = await makeClient();
  const { data } = await client.get('/users/current/allowed-accounts');
  return (data.results ?? data) as TaboolaAccount[];
}

/** List all campaigns for an account, paginated. */
export async function listCampaigns(accountId: string): Promise<TaboolaCampaign[]> {
  const client = await makeClient();
  return paginate<TaboolaCampaign>(client, `/${accountId}/campaigns`, {});
}

/** List all items (ads) for a campaign, using the campaign's advertiser_id. */
export async function listItems(
  advertiserId: string,
  campaignId: string,
): Promise<TaboolaItem[]> {
  const client = await makeClient();
  return paginate<TaboolaItem>(client, `/${advertiserId}/campaigns/${campaignId}/items`, {});
}

/**
 * Fetch all active items with their landing URLs across the whole network.
 * Uses the top-campaign-content/item_breakdown report, which is the only network-level
 * report that returns item ids + URLs. We pull a rolling window (default 30 days)
 * to catch both currently-running and recently-paused items.
 */
export async function fetchNetworkItems(opts: {
  startDate: string;
  endDate: string;
}): Promise<TaboolaContentItem[]> {
  const client = await makeClient();
  return paginate<TaboolaContentItem>(
    client,
    `/${env.TABOOLA_ACCOUNT_ID}/reports/top-campaign-content/dimensions/item_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    200,
  );
}

/**
 * Pull campaign-level hourly stats from the network account.
 * Returns one row per (campaign, hour). No item / site / country / device breakdown
 * is available at hourly granularity from the Taboola reporting API.
 * Date field format: 'YYYY-MM-DD HH:00:00.0'
 */
export async function fetchHourlyStats(opts: {
  startDate: string;
  endDate: string;
}): Promise<TaboolaStatRow[]> {
  const client = await makeClient();
  return paginate<TaboolaStatRow>(
    client,
    `/${env.TABOOLA_ACCOUNT_ID}/reports/campaign-summary/dimensions/campaign_hour_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    500,
  );
}

/**
 * Pull campaign-level daily stats from the network account.
 * Used for the historical backfill. Date field format: 'YYYY-MM-DD 00:00:00.0'
 */
export async function fetchDailyStats(opts: {
  startDate: string;
  endDate: string;
}): Promise<TaboolaStatRow[]> {
  const client = await makeClient();
  return paginate<TaboolaStatRow>(
    client,
    `/${env.TABOOLA_ACCOUNT_ID}/reports/campaign-summary/dimensions/campaign_day_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    500,
  );
}

// Row from platform_breakdown / country_breakdown / site_breakdown — single-
// dimension rollup. These reports return ONE row per platform (or country, or
// site) aggregated over the whole date range, with NO campaign and NO date
// sub-split. To get a daily breakdown we must call them once per day
// (start_date === end_date).
export interface TaboolaGeoRow {
  platform?: string;      // 'DESK' | 'PHON' | 'TBLT' | 'OTHR'
  platform_name?: string;
  country?: string;       // ISO-2 e.g. 'US'
  country_name?: string;
  site_id?: number;       // numeric publisher id — matches IA partner_stats item_ext_id
  site?: string;          // publisher site code e.g. 'joygamez'
  site_name?: string;     // display name e.g. 'Joy Gamez'
  clicks: number;
  impressions: number;
  spent: number;
  cpa_actions_num?: number; // conversions
}

/**
 * Per-account device(platform) cost breakdown for a single day.
 * `accountId` is the Taboola advertiser account_id (= ad_accounts.external_id).
 * Platform codes: DESK / PHON / TBLT / OTHR.
 */
export async function fetchPlatformBreakdown(
  accountId: string,
  opts: { startDate: string; endDate: string },
): Promise<TaboolaGeoRow[]> {
  const client = await makeClient();
  return paginate<TaboolaGeoRow>(
    client,
    `/${accountId}/reports/campaign-summary/dimensions/platform_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    200,
  );
}

/**
 * Per-account country cost breakdown for a single day.
 * `accountId` is the Taboola advertiser account_id (= ad_accounts.external_id).
 * Country codes are ISO-2 (US, CA, GB, ...).
 */
export async function fetchCountryBreakdown(
  accountId: string,
  opts: { startDate: string; endDate: string },
): Promise<TaboolaGeoRow[]> {
  const client = await makeClient();
  return paginate<TaboolaGeoRow>(
    client,
    `/${accountId}/reports/campaign-summary/dimensions/country_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    300,
  );
}

/**
 * Per-account publisher-site cost breakdown for a single day.
 * `accountId` is the Taboola advertiser account_id (= ad_accounts.external_id).
 * Returns one row per publisher site (site code + display name).
 */
export async function fetchSiteBreakdown(
  accountId: string,
  opts: { startDate: string; endDate: string },
): Promise<TaboolaGeoRow[]> {
  const client = await makeClient();
  return paginate<TaboolaGeoRow>(
    client,
    `/${accountId}/reports/campaign-summary/dimensions/site_breakdown`,
    { start_date: opts.startDate, end_date: opts.endDate },
    500,
  );
}
