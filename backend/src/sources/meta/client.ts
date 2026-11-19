import axios, { AxiosError } from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Meta (Facebook) Marketing API — HTTP only, no DB.
 *
 * Auth: a non-expiring SYSTEM-USER token (NADIA_DASHBOARD_API in Nadia's business
 * portfolio "SSM", issued against "Campaigns App", scope ads_read). There is no
 * login/refresh flow — the token is static in META_ACCESS_TOKEN.
 *
 * Meta answers old versions by redirecting `paging.next` to the current one
 * (observed: v23.0 request → v25.0 next links), so the version is configurable
 * and `next` URLs are followed verbatim.
 */

const http = axios.create({ timeout: 60_000 });

function base(): string {
  return `https://graph.facebook.com/${env.META_API_VERSION}`;
}

function token(): string {
  if (!env.META_ACCESS_TOKEN) throw new Error('META_ACCESS_TOKEN is not set');
  return env.META_ACCESS_TOKEN;
}

/** GET with retry on Meta's transient/rate-limit codes (1, 2, 4, 17, 32, 613) and 5xx. */
async function get<T>(url: string, params?: Record<string, string>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await http.get<T>(url, { params: params ? { ...params, access_token: token() } : undefined });
      return res.data;
    } catch (e) {
      const err = e as AxiosError<{ error?: { code?: number; message?: string } }>;
      const code = err.response?.data?.error?.code;
      const status = err.response?.status ?? 0;
      const transient = status >= 500 || [1, 2, 4, 17, 32, 613].includes(code ?? -1);
      if (!transient || attempt >= 4) {
        const msg = err.response?.data?.error?.message ?? err.message;
        throw new Error(`meta: GET ${url.split('?')[0]} failed (${status} code=${code}): ${msg}`);
      }
      const waitMs = 2_000 * attempt * attempt;
      logger.warn({ code, status, attempt, waitMs }, 'meta: transient error, retrying');
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

/** Follow `paging.next` until exhausted. */
async function getAll<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let page = await get<{ data: T[]; paging?: { next?: string } }>(`${base()}/${path}`, { limit: '500', ...params });
  out.push(...page.data);
  while (page.paging?.next) {
    // `next` already carries every param, including the token.
    page = await get(page.paging.next);
    out.push(...page.data);
  }
  return out;
}

export interface MetaAccount {
  id: string;               // 'act_<n>'
  name: string;
  account_status: number;   // 1 = active
  currency: string;
  timezone_name: string;
}

export interface MetaCampaign { id: string; name: string; effective_status: string }
export interface MetaAd { id: string; name: string; campaign_id: string; adset_id: string; effective_status: string }

export interface MetaHourlyRow {
  campaign_id: string;
  date_start: string;                 // advertiser-timezone date, YYYY-MM-DD
  hourly_stats_aggregated_by_advertiser_time_zone: string; // 'HH:00:00 - HH:59:59'
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
}

export function getAccount(accountId: string): Promise<MetaAccount> {
  return get<MetaAccount>(`${base()}/${accountId}`, { fields: 'id,name,account_status,currency,timezone_name' });
}

export function listCampaigns(accountId: string): Promise<MetaCampaign[]> {
  return getAll<MetaCampaign>(`${accountId}/campaigns`, { fields: 'id,name,effective_status' });
}

export function listAds(accountId: string): Promise<MetaAd[]> {
  return getAll<MetaAd>(`${accountId}/ads`, { fields: 'id,name,campaign_id,adset_id,effective_status' });
}

/**
 * Campaign-level hourly cost for an advertiser-timezone date range (inclusive).
 * Meta omits hours with no delivery, exactly like Taboola.
 */
export function fetchCampaignHourly(accountId: string, since: string, until: string): Promise<MetaHourlyRow[]> {
  return getAll<MetaHourlyRow>(`${accountId}/insights`, {
    level: 'campaign',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
    fields: 'campaign_id,spend,impressions,inline_link_clicks',
  });
}

/** Account-level daily spend — used only to reconcile the stored hourly rows. */
export function fetchAccountDaily(accountId: string, since: string, until: string):
  Promise<{ date_start: string; spend: string }[]> {
  return getAll(`${accountId}/insights`, {
    level: 'account',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    fields: 'spend',
  });
}
