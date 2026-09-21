/**
 * Probe 3: Discover item-level and country/platform/site hourly stats dimensions.
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';

const BASE = process.env.TABOOLA_API_BASE;
const tokenRes = await axios.post(
  'https://backstage.taboola.com/backstage/oauth/token',
  new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.TABOOLA_CLIENT_ID,
    client_secret: process.env.TABOOLA_CLIENT_SECRET,
  }),
  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
);
const token = tokenRes.data.access_token;
const api = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });
function save(name, d) { fs.mkdirSync('.scratch', {recursive:true}); fs.writeFileSync(`.scratch/${name}`, JSON.stringify(d,null,2)); }

const ACCOUNT = 'tdg-sevenspheremedia4433-adv1-sc';
const NETWORK = process.env.TABOOLA_ACCOUNT_ID;

// Use a date range we KNOW has data from the earlier probe
const START = '2026-05-21';
const END   = '2026-05-22';

// --- 1. Try item-summary report type ---
console.log('\n--- item-summary report type ---');
const itemDimensions = [
  'campaign_breakdown', 'campaign_day_breakdown', 'campaign_hour_breakdown',
  'item_breakdown', 'item_day_breakdown', 'item_hour_breakdown',
  'item_campaign_breakdown',
];
for (const dim of itemDimensions) {
  try {
    const r = await api.get(`/${ACCOUNT}/reports/item-summary/dimensions/${dim}`, {
      params: { start_date: START, end_date: END, page: 1, page_size: 2 }
    });
    const rows = r.data.results ?? [];
    const keys = rows.length > 0 ? Object.keys(rows[0]).slice(0, 8).join(', ') : '(no rows)';
    console.log(`  ✓ item-summary/${dim.padEnd(40)} rows=${rows.length} | ${keys}`);
    if (rows.length > 0) save(`taboola-item-summary-${dim}.json`, rows.slice(0, 3));
  } catch (e) {
    const msg = (e.response?.data?.message ?? e.message).slice(0, 80);
    console.log(`  ✗ item-summary/${dim.padEnd(40)} ${e.response?.status} ${msg}`);
  }
}

// --- 2. campaign-summary with date range where data exists ---
console.log('\n--- campaign-summary with known date range ---');
const campaignDims = [
  'campaign_hour_breakdown',
  'campaign_site_day_breakdown',
  'campaign_country_day_breakdown',
  'campaign_platform_day_breakdown',
  'campaign_country_hour_breakdown',
  'campaign_platform_hour_breakdown',
  'campaign_site_country_day_breakdown',
];
for (const dim of campaignDims) {
  try {
    const r = await api.get(`/${ACCOUNT}/reports/campaign-summary/dimensions/${dim}`, {
      params: { start_date: START, end_date: END, page: 1, page_size: 2 }
    });
    const rows = r.data.results ?? [];
    const keys = rows.length > 0 ? Object.keys(rows[0]).slice(0, 8).join(', ') : '(no rows)';
    console.log(`  ✓ campaign-summary/${dim.padEnd(40)} rows=${rows.length} | ${keys}`);
    if (rows.length > 0) save(`taboola-camp-${dim}.json`, rows.slice(0, 3));
  } catch (e) {
    const msg = (e.response?.data?.message ?? e.message).slice(0, 80);
    console.log(`  ✗ campaign-summary/${dim.padEnd(40)} ${e.response?.status} ${msg}`);
  }
}

// --- 3. Network-level campaign-summary with data range ---
console.log('\n--- network campaign-summary hour breakdown (all accounts) ---');
try {
  const r = await api.get(`/${NETWORK}/reports/campaign-summary/dimensions/campaign_hour_breakdown`, {
    params: { start_date: START, end_date: END, page: 1, page_size: 5 }
  });
  const rows = r.data.results ?? [];
  console.log('Count:', rows.length, '| total:', r.data.count ?? 'N/A');
  if (rows.length > 0) {
    console.log('Keys:', Object.keys(rows[0]).join(', '));
    console.log('First:', JSON.stringify(rows[0]).slice(0, 300));
    save('taboola-network-hourly.json', rows.slice(0, 5));
  }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 200)); }

// --- 4. Try "top-campaign-content" report or other report types ---
console.log('\n--- try top-campaign-content report ---');
try {
  const r = await api.get(`/${ACCOUNT}/reports/top-campaign-content/dimensions/item_breakdown`, {
    params: { start_date: START, end_date: END, page: 1, page_size: 3 }
  });
  const rows = r.data.results ?? [];
  console.log('✓ top-campaign-content/item_breakdown rows=', rows.length);
  if (rows.length > 0) { console.log('Keys:', Object.keys(rows[0]).join(', ')); save('taboola-top-content.json', rows.slice(0, 3)); }
} catch (e) { console.log('✗', e.response?.status, (e.response?.data?.message ?? e.message).slice(0, 100)); }

console.log('\nDone.');
