/**
 * Codefuel API probe — confirm auth + response shape.
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';

const yesterday = new Date(); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const ymd = yesterday.toISOString().slice(0, 10);
const twoDaysAgo = new Date(); twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
const ymd2 = twoDaysAgo.toISOString().slice(0, 10);

// Auth
const tokenRes = await axios.post(
  'https://search-auth.perion.com/oauth/token',
  {
    client_id: process.env.CODEFUEL_CLIENT_ID,
    client_secret: process.env.CODEFUEL_CLIENT_SECRET,
    audience: 'codefuel-api',
    grant_type: 'client_credentials',
  },
  { headers: { 'Content-Type': 'application/json' } }
);
const token = tokenRes.data.access_token;
console.log('✓ Codefuel token OK');
console.log('Token type:', tokenRes.data.token_type);
// Peek at exp from JWT
try {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  console.log('Token exp:', new Date(payload.exp * 1000).toISOString());
} catch (e) { console.log('(could not decode JWT exp)'); }

const api = axios.create({
  baseURL: process.env.CODEFUEL_API_BASE,
  headers: { Authorization: `Bearer ${token}` },
  timeout: 30000,
});

function save(name, d) { fs.mkdirSync('.scratch', {recursive:true}); fs.writeFileSync(`.scratch/${name}`, JSON.stringify(d,null,2)); }

// --- 1. Hourly performance ---
console.log(`\n--- Hourly: ${ymd2} → ${ymd} ---`);
try {
  const res = await api.get('/io/getHourlyPerformanceData', {
    params: {
      start_date: ymd2,
      end_date: ymd,
      breakdowns: 'date,hour,country_code,asset_gid,channel,device',
      metrics: 'all',
      asset_gids: 'all',
      channels: 'all',
      format: 'JSON',
    }
  });
  const rows = res.data?.results ?? res.data;
  console.log('Status:', res.status);
  console.log('Type of data:', typeof res.data, Array.isArray(res.data) ? 'array' : '');
  console.log('Results count:', Array.isArray(rows) ? rows.length : 'N/A');
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('Keys:', Object.keys(rows[0]).join(', '));
    console.log('First row:', JSON.stringify(rows[0]).slice(0, 400));
    save('codefuel-hourly.json', rows.slice(0, 5));
    console.log('  → saved .scratch/codefuel-hourly.json');
  } else {
    console.log('Raw response:', JSON.stringify(res.data).slice(0, 400));
  }
} catch (e) {
  console.error('Hourly failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 400));
}

// --- 2. Daily performance ---
const thirtyDaysAgo = new Date(); thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
const startDay = thirtyDaysAgo.toISOString().slice(0, 10);
console.log(`\n--- Daily: ${startDay} → ${ymd} ---`);
try {
  const res = await api.get('/io/getDailyPerformanceData', {
    params: {
      start_date: startDay,
      end_date: ymd,
      breakdowns: 'date,country_code,asset_gid,channel,device',
      metrics: 'all',
      asset_gids: 'all',
      channels: 'all',
      format: 'JSON',
    }
  });
  const rows = res.data?.results ?? res.data;
  console.log('Results count:', Array.isArray(rows) ? rows.length : 'N/A');
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('Keys:', Object.keys(rows[0]).join(', '));
    console.log('First row:', JSON.stringify(rows[0]).slice(0, 400));
    save('codefuel-daily.json', rows.slice(0, 5));
    console.log('  → saved .scratch/codefuel-daily.json');
  } else {
    console.log('Raw:', JSON.stringify(res.data).slice(0, 400));
  }
} catch (e) {
  console.error('Daily failed:', e.message, e.response?.status, JSON.stringify(e.response?.data ?? '').slice(0, 400));
}

console.log('\nDone.');
