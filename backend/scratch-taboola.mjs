/**
 * Taboola API probe — discovers real endpoint shapes.
 * Saves raw responses to backend/.scratch/ for reference.
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';

const BASE = process.env.TABOOLA_API_BASE;
const CLIENT_ID = process.env.TABOOLA_CLIENT_ID;
const CLIENT_SECRET = process.env.TABOOLA_CLIENT_SECRET;
const NETWORK_ID = process.env.TABOOLA_ACCOUNT_ID;

// --- Token ---
const tokenRes = await axios.post(
  'https://backstage.taboola.com/backstage/oauth/token',
  new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
);
const token = tokenRes.data.access_token;
console.log('✓ Token OK, expires_in:', tokenRes.data.expires_in);
const api = axios.create({ baseURL: BASE, headers: { Authorization: `Bearer ${token}` }, timeout: 60000 });

function save(name, data) {
  fs.mkdirSync('.scratch', { recursive: true });
  fs.writeFileSync(`.scratch/${name}`, JSON.stringify(data, null, 2));
  console.log(`  → saved .scratch/${name}`);
}

// --- 1. List sub-accounts (try both URL patterns) ---
console.log('\n--- Probe 1a: /{network}/accounts ---');
try {
  const r = await api.get(`/${NETWORK_ID}/accounts`, { params: { page: 1, page_size: 50 } });
  const accs = r.data.results ?? r.data;
  console.log('Count:', Array.isArray(accs) ? accs.length : JSON.stringify(r.data).slice(0,200));
  if (Array.isArray(accs) && accs.length > 0) { console.log('First:', JSON.stringify(accs[0]).slice(0,300)); save('taboola-accounts.json', accs); }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }

console.log('\n--- Probe 1b: /users/current/allowed-accounts ---');
try {
  const r = await api.get('/users/current/allowed-accounts');
  const accs = r.data.results ?? r.data;
  console.log('Count:', Array.isArray(accs) ? accs.length : JSON.stringify(r.data).slice(0,300));
  if (Array.isArray(accs) && accs.length > 0) { console.log('First:', JSON.stringify(accs[0]).slice(0,300)); save('taboola-allowed-accounts.json', accs); }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }

// --- 2. Campaigns with required page param ---
console.log('\n--- Probe 2: /{network}/campaigns?page=1 ---');
try {
  const r = await api.get(`/${NETWORK_ID}/campaigns`, { params: { page: 1, page_size: 100 } });
  const cams = r.data.results ?? r.data;
  console.log('Total reported:', r.data.count ?? 'N/A', '| This page:', Array.isArray(cams) ? cams.length : 'N/A');
  if (Array.isArray(cams) && cams.length > 0) {
    console.log('First:', JSON.stringify(cams[0]).slice(0,400));
    save('taboola-campaigns.json', cams.slice(0, 5));
  }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }

// --- 3. Items (ads) for first campaign found ---
let firstCampaignId = null;
try {
  const r = await api.get(`/${NETWORK_ID}/campaigns`, { params: { page: 1, page_size: 5 } });
  const cams = r.data.results ?? [];
  if (cams.length > 0) firstCampaignId = cams[0].id;
} catch (_) {}

if (firstCampaignId) {
  console.log(`\n--- Probe 3: Items for campaign ${firstCampaignId} ---`);
  try {
    const r = await api.get(`/${NETWORK_ID}/campaigns/${firstCampaignId}/items`, { params: { page: 1, page_size: 5 } });
    const items = r.data.results ?? r.data;
    console.log('Count:', Array.isArray(items) ? items.length : JSON.stringify(r.data).slice(0,200));
    if (Array.isArray(items) && items.length > 0) {
      console.log('First item:', JSON.stringify(items[0]).slice(0,400));
      save('taboola-items.json', items.slice(0, 3));
    }
  } catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }
}

// --- 4. Campaign summary report with page param ---
console.log('\n--- Probe 4: campaign-summary report yesterday ---');
try {
  const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const ymd = yesterday.toISOString().slice(0, 10);
  // Try dimension that includes hour breakdown
  const r = await api.get(`/${NETWORK_ID}/reports/campaign-summary/dimensions/campaign_hour_breakdown`, {
    params: { start_date: ymd, end_date: ymd, page: 1, page_size: 5 }
  });
  const rows = r.data.results ?? r.data;
  console.log('Count this page:', Array.isArray(rows) ? rows.length : 'N/A', '| total:', r.data.count);
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('First row keys:', Object.keys(rows[0]).join(', '));
    console.log('First row:', JSON.stringify(rows[0]).slice(0,400));
    save('taboola-hourly-stats.json', rows.slice(0, 3));
  }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }

// --- 5. Try item-level hourly breakdown ---
console.log('\n--- Probe 5: item-day-breakdown report yesterday ---');
try {
  const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const ymd = yesterday.toISOString().slice(0, 10);
  const r = await api.get(`/${NETWORK_ID}/reports/campaign-summary/dimensions/item_breakdown`, {
    params: { start_date: ymd, end_date: ymd, page: 1, page_size: 5 }
  });
  const rows = r.data.results ?? r.data;
  console.log('Count this page:', Array.isArray(rows) ? rows.length : 'N/A', '| total:', r.data.count);
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('First row keys:', Object.keys(rows[0]).join(', '));
    console.log('First row:', JSON.stringify(rows[0]).slice(0,400));
    save('taboola-item-stats.json', rows.slice(0, 3));
  }
} catch (e) { console.error('Failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0,300)); }

console.log('\nAll probes done.');
