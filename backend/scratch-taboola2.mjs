/**
 * Probe 2: items with correct account + hourly dimension discovery.
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

function save(name, data) {
  fs.mkdirSync('.scratch', { recursive: true });
  fs.writeFileSync(`.scratch/${name}`, JSON.stringify(data, null, 2));
  console.log(`  saved .scratch/${name}`);
}

// The Codefuel sub-account
const CODEFUEL_ACCOUNT = 'tdg-sevenspheremedia4433-adv1-sc';

// --- 1. Get a Codefuel campaign ---
console.log('\n--- 1. Campaigns for Codefuel sub-account ---');
let codefuelCampaignId = null;
try {
  const r = await api.get(`/${CODEFUEL_ACCOUNT}/campaigns`, { params: { page: 1, page_size: 5 } });
  const cams = r.data.results ?? [];
  console.log('Count (this page):', cams.length, '| total:', r.data.count ?? 'N/A');
  if (cams.length > 0) {
    codefuelCampaignId = cams[0].id;
    console.log('First campaign:', cams[0].id, cams[0].name, cams[0].status);
    save('taboola-codefuel-campaigns.json', cams.slice(0, 3));
  }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 200)); }

// --- 2. Items for that Codefuel campaign ---
if (codefuelCampaignId) {
  console.log(`\n--- 2. Items for campaign ${codefuelCampaignId} under ${CODEFUEL_ACCOUNT} ---`);
  try {
    const r = await api.get(`/${CODEFUEL_ACCOUNT}/campaigns/${codefuelCampaignId}/items`, {
      params: { page: 1, page_size: 5 }
    });
    const items = r.data.results ?? r.data;
    console.log('Count:', Array.isArray(items) ? items.length : JSON.stringify(r.data).slice(0, 200));
    if (Array.isArray(items) && items.length > 0) {
      console.log('First item keys:', Object.keys(items[0]).join(', '));
      console.log('First item url:', items[0].url ?? items[0].thumbnail_url ?? 'no url');
      console.log('First item:', JSON.stringify(items[0]).slice(0, 500));
      save('taboola-items.json', items.slice(0, 3));
    }
  } catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 300)); }
}

// --- 3. Try various hourly stat dimensions ---
const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const ymd = yesterday.toISOString().slice(0, 10);

const dimensions = [
  'campaign_site_day_breakdown',
  'campaign_site_hour_breakdown',
  'campaign_day_breakdown',
  'campaign_item_day_breakdown',
  'item_site_day_breakdown',
  'campaign_country_breakdown',
  'campaign_platform_breakdown',
  'campaign_platform_country_breakdown',
  'campaign_country_platform_breakdown',
];

console.log('\n--- 3. Probing dimensions for hourly/daily stats ---');
for (const dim of dimensions) {
  try {
    const r = await api.get(`/${CODEFUEL_ACCOUNT}/reports/campaign-summary/dimensions/${dim}`, {
      params: { start_date: ymd, end_date: ymd, page: 1, page_size: 2 }
    });
    const rows = r.data.results ?? [];
    const keys = rows.length > 0 ? Object.keys(rows[0]).join(', ') : 'no rows';
    console.log(`  ✓ ${dim.padEnd(45)} rows=${rows.length} keys: ${keys.slice(0, 100)}`);
  } catch (e) {
    const msg = e.response?.data?.message ?? e.message;
    console.log(`  ✗ ${dim.padEnd(45)} ${e.response?.status} ${msg?.slice(0, 80)}`);
  }
}

// --- 4. Try the network-level report with site+country+platform ---
console.log('\n--- 4. Network-level report with site_hour_breakdown ---');
const NETWORK = process.env.TABOOLA_ACCOUNT_ID;
try {
  const r = await api.get(`/${NETWORK}/reports/campaign-summary/dimensions/campaign_site_hour_breakdown`, {
    params: { start_date: ymd, end_date: ymd, page: 1, page_size: 3 }
  });
  const rows = r.data.results ?? [];
  console.log('Count:', rows.length, '| keys:', rows.length > 0 ? Object.keys(rows[0]).join(', ') : 'none');
  if (rows.length > 0) { console.log('First row:', JSON.stringify(rows[0]).slice(0, 400)); save('taboola-site-hour-stats.json', rows.slice(0, 3)); }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 200)); }

console.log('\nDone.');
