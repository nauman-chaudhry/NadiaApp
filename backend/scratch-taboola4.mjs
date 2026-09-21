/**
 * Probe 4: Discover item-level stats via top-campaign-content + other approaches.
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

const NETWORK = process.env.TABOOLA_ACCOUNT_ID;
const CODEFUEL_1 = 'tdg-sevenspheremedia4433-adv1-sc';
const CODEFUEL_2 = 'tdg-sevenspheremedia4433-yahoocodefuel2-sc';

// Date range where we know there's spend from the campaign_hour_breakdown probe
const START = '2026-05-20';
const END   = '2026-05-22';

// --- 1. top-campaign-content on network ---
console.log('\n--- 1. top-campaign-content dimensions (network) ---');
const topContentDims = ['item_breakdown', 'campaign_breakdown', 'campaign_day_breakdown', 'campaign_hour_breakdown'];
for (const dim of topContentDims) {
  try {
    const r = await api.get(`/${NETWORK}/reports/top-campaign-content/dimensions/${dim}`, {
      params: { start_date: START, end_date: END, page: 1, page_size: 5 }
    });
    const rows = r.data.results ?? [];
    const keys = rows.length > 0 ? Object.keys(rows[0]).slice(0, 10).join(', ') : '(no rows)';
    console.log(`  ✓ top-campaign-content/${dim.padEnd(30)} rows=${rows.length} | ${keys}`);
    if (rows.length > 0) { console.log('    First:', JSON.stringify(rows[0]).slice(0, 300)); save(`taboola-tcc-${dim}.json`, rows.slice(0, 5)); }
  } catch (e) {
    const msg = (e.response?.data?.message ?? e.message).slice(0, 100);
    console.log(`  ✗ top-campaign-content/${dim.padEnd(30)} ${e.response?.status} ${msg}`);
  }
}

// --- 2. Try the Codefuel2 sub-account for the campaign-summary report ---
console.log('\n--- 2. Campaign-hour-breakdown on Codefuel2 account ---');
try {
  const r = await api.get(`/${CODEFUEL_2}/reports/campaign-summary/dimensions/campaign_hour_breakdown`, {
    params: { start_date: START, end_date: END, page: 1, page_size: 5 }
  });
  const rows = r.data.results ?? [];
  console.log('Rows:', rows.length);
  if (rows.length > 0) { console.log('First:', JSON.stringify(rows[0]).slice(0, 300)); save('taboola-codefuel2-hourly.json', rows.slice(0, 5)); }
} catch (e) { console.error('Failed:', e.message, e.response?.status); }

// --- 3. Try different sub-accounts' campaign_hour_breakdown to find active spend ---
console.log('\n--- 3. Which sub-accounts have spend data (2026-05-20/22)? ---');
const accounts = [
  'tdg-sevenspheremedia4433-adv1-sc',
  'tdg-sevenspheremedia4433-yahoocodefuel2-sc',
  'tdg-sevenspheremedia4433-yahoo-codefuel-whitelisted-sc',
  'tdg-sevenspheremedia4433-yahoorsoc-sc',
  'tdg-sevenspheremedia4433-yahoo-ssm1',
  'tdg-sevenspheremedia4433-yahoo-ssm2',
  'tdg-sevenspheremedia4433-yahoo-ssm3',
  'tdg-sevenspheremedia4433-yahoo-ssm4',
  'tdg-sevenspheremedia4433-yahoo-ssm5',
];
for (const acc of accounts) {
  try {
    const r = await api.get(`/${acc}/reports/campaign-summary/dimensions/campaign_hour_breakdown`, {
      params: { start_date: START, end_date: END, page: 1, page_size: 1 }
    });
    const rows = r.data.results ?? [];
    const spend = rows.length > 0 ? rows[0].spent : 0;
    console.log(`  ${acc.slice(0, 50).padEnd(50)}  rows=${rows.length}  sample_spend=${spend}`);
  } catch (e) { console.log(`  ${acc.slice(0, 50).padEnd(50)}  ${e.response?.status ?? e.message.slice(0, 30)}`); }
}

// --- 4. Try getting top-campaign-content with item_breakdown on a specific sub-account ---
console.log('\n--- 4. top-campaign-content/item_breakdown on sub-accounts with data ---');
for (const acc of [CODEFUEL_2, 'tdg-sevenspheremedia4433-yahoo-codefuel-whitelisted-sc', 'tdg-sevenspheremedia4433-yahoo-ssm1']) {
  try {
    const r = await api.get(`/${acc}/reports/top-campaign-content/dimensions/item_breakdown`, {
      params: { start_date: START, end_date: END, page: 1, page_size: 3 }
    });
    const rows = r.data.results ?? [];
    if (rows.length > 0) {
      console.log(`  ✓ ${acc}  rows=${rows.length}`);
      console.log('    Keys:', Object.keys(rows[0]).join(', '));
      console.log('    First:', JSON.stringify(rows[0]).slice(0, 400));
      save(`taboola-tcc-item-${acc.slice(-10)}.json`, rows.slice(0, 5));
    } else {
      console.log(`  - ${acc}  rows=0`);
    }
  } catch (e) { console.log(`  ✗ ${acc}  ${e.response?.status}`); }
}

console.log('\nDone.');
