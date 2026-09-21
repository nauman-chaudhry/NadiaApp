/**
 * Investigates the click-count discrepancy:
 *   - Network endpoint total for June 1 = 1605 clicks (matches Nadia's target)
 *   - Advertiser endpoint for account 1823395 alone = 756 clicks
 *
 * Hypothesis: Nadia's "1605" is the ALL-ACCOUNTS total, not per-account.
 * Test: sum advertiser-level clicks across ALL sub-accounts and compare.
 *
 * Also: check what the network endpoint returns, filtered to campaigns
 * belonging ONLY to account 1823395.
 */

import axios from 'axios';
import { query, pool } from '../db/client.js';
import 'dotenv/config';

const CLIENT_ID     = process.env.TABOOLA_CLIENT_ID!;
const CLIENT_SECRET = process.env.TABOOLA_CLIENT_SECRET!;
const BASE          = process.env.TABOOLA_API_BASE ?? 'https://backstage.taboola.com/backstage/api/1.0';
const NETWORK_ID    = process.env.TABOOLA_ACCOUNT_ID!;

const tokenRes = await axios.post(
  'https://backstage.taboola.com/backstage/oauth/token',
  new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
);
const token = tokenRes.data.access_token;
const http = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` } });

const START = '2026-06-01';
const END   = '2026-06-01';
const PAGE_SIZE = 500;

async function fetchAllPages(accountId: string): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  while (true) {
    const res: any = await http.get(`/${accountId}/reports/campaign-summary/dimensions/campaign_hour_breakdown`, {
      params: { start_date: START, end_date: END, page, page_size: PAGE_SIZE },
    });
    const rows: any[] = res.data.results ?? res.data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    page++;
  }
  return all;
}

function sum(rows: any[], field: string): number {
  return rows.reduce((s, r) => s + (r[field] ?? 0), 0);
}

// ── 1. Network endpoint (current code path) ─────────────────────────────────
console.log('\n=== 1. Network endpoint (current code path) ===');
const netRows = await fetchAllPages(NETWORK_ID);
console.log(`  Rows: ${netRows.length}`);
console.log(`  Clicks: ${sum(netRows, 'clicks')}`);
console.log(`  Conversions: ${sum(netRows, 'cpa_actions_num')}`);
console.log(`  Spent: $${sum(netRows, 'spent').toFixed(2)}`);

// Campaign IDs in the network response
const netCampaignIds = new Set(netRows.map(r => r.campaign));
console.log(`  Unique campaign IDs: ${netCampaignIds.size}`);

// ── 2. Get campaigns for account 1823395 from DB ─────────────────────────────
console.log('\n=== 2. Campaigns in DB for account 1823395 (leadgenaffiliates-sc) ===');
const dbCampaigns = await query<{ external_id: string }>(`
  SELECT c.external_id
  FROM campaigns c
  JOIN ad_accounts a ON a.id = c.ad_account_id
  WHERE a.external_id = 'tdg-sevenspheremedia4433-leadgenaffiliates-sc'
`);
const accountCampaignIds = new Set(dbCampaigns.map(r => r.external_id));
console.log(`  Campaigns in DB for this account: ${accountCampaignIds.size}`);

// Filter network rows to only this account's campaigns
const netRowsForAccount = netRows.filter(r => accountCampaignIds.has(r.campaign));
console.log(`  Network rows matching these campaigns: ${netRowsForAccount.length}`);
console.log(`  → Clicks (network, account 1823395 campaigns): ${sum(netRowsForAccount, 'clicks')}`);
console.log(`  → Conv:  ${sum(netRowsForAccount, 'cpa_actions_num')}`);
console.log(`  → Spent: $${sum(netRowsForAccount, 'spent').toFixed(2)}`);

// ── 3. Advertiser endpoint for account 1823395 ───────────────────────────────
console.log('\n=== 3. Advertiser endpoint for account 1823395 ===');
const advRows = await fetchAllPages('tdg-sevenspheremedia4433-leadgenaffiliates-sc');
console.log(`  Rows: ${advRows.length}`);
console.log(`  Clicks: ${sum(advRows, 'clicks')}`);
console.log(`  Conversions: ${sum(advRows, 'cpa_actions_num')}`);
console.log(`  Spent: $${sum(advRows, 'spent').toFixed(2)}`);

// Campaign IDs in advertiser response — check for mismatches
const advCampaignIds = new Set(advRows.map(r => r.campaign));
console.log(`  Unique campaign IDs: ${advCampaignIds.size}`);
const inAdvNotNet = [...advCampaignIds].filter(id => !netCampaignIds.has(id));
const inNetNotAdv = [...accountCampaignIds].filter(id => !advCampaignIds.has(id));
console.log(`  Campaigns in adv-endpoint but NOT in network response: ${inAdvNotNet.length}`);
console.log(`  Campaigns in DB for this account but NOT in adv-endpoint response: ${inNetNotAdv.length}`);

// ── 4. All sub-accounts summed ────────────────────────────────────────────────
console.log('\n=== 4. All sub-accounts summed via advertiser endpoint ===');

// Sub-accounts from the DB (exclude the NETWORK account)
const allAccounts = await query<{ external_id: string; name: string }>(`
  SELECT a.external_id, a.name
  FROM ad_accounts a
  JOIN platforms p ON p.id = a.platform_id AND p.code = 'taboola'
  WHERE a.status = 'active'
    AND a.external_id != $1
  ORDER BY a.external_id
`, [NETWORK_ID]);

console.log(`  Fetching advertiser-level data for ${allAccounts.length} sub-accounts...`);
let totalClicks = 0, totalConv = 0, totalSpent = 0, totalRows = 0;
for (const acc of allAccounts) {
  try {
    const rows = await fetchAllPages(acc.external_id);
    const c = sum(rows, 'clicks');
    const v = sum(rows, 'cpa_actions_num');
    const s = sum(rows, 'spent');
    totalClicks += c; totalConv += v; totalSpent += s; totalRows += rows.length;
    if (c > 0 || s > 0) {
      console.log(`    ${acc.external_id}: rows=${rows.length} clicks=${c} conv=${v} spent=$${s.toFixed(2)}`);
    }
  } catch (err: any) {
    console.log(`    ${acc.external_id}: ERROR ${err.response?.status} ${err.response?.data?.message ?? err.message}`);
  }
}
console.log(`\n  TOTAL across all sub-accounts:`);
console.log(`    Rows:   ${totalRows}`);
console.log(`    Clicks: ${totalClicks}    (Nadia's target: 1605)`);
console.log(`    Conv:   ${totalConv}    (Nadia's target: 782)`);
console.log(`    Spent:  $${totalSpent.toFixed(2)}  (Nadia's target: $51.86 for ONE account / $100.24 network)`);

// ── 5. DB current state for comparison ───────────────────────────────────────
console.log('\n=== 5. Current DB state for June 1 (what dashboard shows now) ===');
const dbTotals = await query<any>(`
  SELECT
    a.external_id,
    ROUND(SUM(s.spent)::numeric,2) AS spent,
    SUM(s.clicks)::int AS clicks,
    SUM(s.conversions)::int AS conversions
  FROM ad_stats_hourly s
  JOIN ad_accounts a ON a.id = s.ad_account_id
  JOIN platforms p ON p.id = a.platform_id AND p.code = 'taboola'
  WHERE s.hour_utc >= '2026-06-01 00:00:00+00'
    AND s.hour_utc <  '2026-06-02 00:00:00+00'
  GROUP BY a.external_id
  ORDER BY spent DESC
`);
let dbTotalClicks = 0, dbTotalConv = 0, dbTotalSpent = 0;
for (const r of dbTotals) {
  dbTotalClicks += r.clicks; dbTotalConv += r.conversions; dbTotalSpent += Number(r.spent);
  if (r.clicks > 0 || Number(r.spent) > 0) {
    console.log(`  ${r.external_id}: spent=$${r.spent} clicks=${r.clicks} conv=${r.conversions}`);
  }
}
console.log(`\n  DB TOTALS June 1: clicks=${dbTotalClicks} conv=${dbTotalConv} spent=$${dbTotalSpent.toFixed(2)}`);

await pool.end();
process.exit(0);
