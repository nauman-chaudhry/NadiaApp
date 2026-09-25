const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';

export type StatsView = 'campaign' | 'device' | 'site' | 'country' | 'ads' | 'daily' | 'hourly';

export interface StatsFilters {
  view: StatsView;
  from: string;            // 'YYYY-MM-DD'
  to: string;
  account_id?: string;
  campaign_id?: string;
  gd?: string;
  site?: string;
  country?: string;
  device?: string;
  status?: string;
  source?: string;         // 'all' | 'taboola' | 'outbrain'
  feed?: string;           // 'all' | 'yahoo' | 'flux' (IA feeds)
}

export interface StatsRow {
  // Dynamic shape — depends on view. Common columns:
  impressions: number;
  clicks: number;
  spent: number;
  revenue: number;
  conversions: number;
  profit: number;
  margin_pct: number;
  actual_cpm: number;
  ctr_pct: number;
  actual_cpc: number;
  conversion_rate_pct: number;
  actual_cpa: number;
  rpc: number;
  [key: string]: any;
}

export interface FilterOptions {
  accounts:  { id: number; external_id: string; name: string; partner_code: string | null; source?: string }[];
  campaigns: { id: number; external_id: string; name: string }[];
  sites:     { site: string }[];
  countries: { country: string }[];
  devices:   { device: string }[];
  statuses:  { status: string }[];
  gds:       { gd_param: string }[];
}

// The API requires the logged-in user's Supabase access token on every call
// (Authorization: Bearer). These functions run in server components, which
// obtain it from the session cookie via getAccessToken() in lib/supabase/server.
function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchStats(f: StatsFilters, token?: string): Promise<{ rows: StatsRow[]; totals: Record<string, number>; view: StatsView }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const res = await fetch(`${API_BASE}/api/stats?${qs}`, { cache: 'no-store', headers: authHeaders(token) });
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}

export async function fetchFilterOptions(token?: string): Promise<FilterOptions> {
  const res = await fetch(`${API_BASE}/api/filters/options`, { cache: 'no-store', headers: authHeaders(token) });
  if (!res.ok) throw new Error(`fetchFilterOptions failed: ${res.status}`);
  return res.json();
}

export interface SyncStatus {
  last_sync_at: string | null;
  /** Per source: newest data hour, last write, and last SUCCESSFUL sync run. */
  sources: { name: string; latest_hour: string | null; last_fetched: string | null; last_success?: string | null }[];
  /** Sources this deployment runs (ENABLED_SOURCES). */
  enabled_sources?: string[];
  /** Enabled sources whose last successful run is older than their threshold. */
  stale?: string[];
}

export async function fetchSyncStatus(token?: string): Promise<SyncStatus> {
  const res = await fetch(`${API_BASE}/api/sync-status`, { cache: 'no-store', headers: authHeaders(token) });
  if (!res.ok) throw new Error(`fetchSyncStatus failed: ${res.status}`);
  return res.json();
}
