const BASE = 'http://localhost:4000';
const FROM = '2026-05-12';
const TO   = '2026-05-25';

async function get(view: string, extra = '') {
  const res = await fetch(`${BASE}/api/stats?view=${view}&from=${FROM}&to=${TO}${extra}`);
  return res.json() as Promise<any>;
}

async function main() {
  // Check 4: campaign — no duplicate campaign_ids
  const camp = await get('campaign');
  const campIds = camp.rows.map((r: any) => r.campaign_id);
  const campDupes = campIds.filter((id: any, i: number) => campIds.indexOf(id) !== i);
  console.log('Check 4 - campaign rows:', camp.rows.length, '| dupes:', JSON.stringify(campDupes));

  // Check 8: totals present and basic math check
  const t = camp.totals ?? {};
  const rowSpentSum = camp.rows.reduce((a: number, r: any) => a + Number(r.spent), 0);
  const rowRevSum   = camp.rows.reduce((a: number, r: any) => a + Number(r.revenue), 0);
  const spentMatch  = Math.abs(Number(t.spent) - rowSpentSum) < 0.01;
  const calcMargin  = rowRevSum > 0 ? (rowRevSum - rowSpentSum) * 100 / rowRevSum : 0;
  const marginMatch = Math.abs(Number(t.margin_pct) - calcMargin) < 0.01;
  console.log('Check 8 - totals.spent matches row sum:', spentMatch, `(${t.spent?.toFixed(4)} vs ${rowSpentSum.toFixed(4)})`);
  console.log('Check 8 - margin_pct is weighted avg (not avg of rows):', marginMatch, `(${Number(t.margin_pct).toFixed(4)} vs ${calcMargin.toFixed(4)})`);
  console.log('Check 8 - totals keys:', Object.keys(t).join(', '));

  // Check 5: ads view has taboola_ad_id and campaign_external_id
  const ads = await get('ads');
  const adsKeys = Object.keys(ads.rows[0] ?? {});
  console.log('Check 5 - ads row keys include taboola_ad_id:', adsKeys.includes('taboola_ad_id'));
  console.log('Check 5 - ads row keys include campaign_id:', adsKeys.includes('campaign_id'));
  if (ads.rows[0]) console.log('Check 5 - sample taboola_ad_id:', ads.rows[0].taboola_ad_id);

  // Check 6: hourly — ≤ 24 rows
  const hourly = await get('hourly');
  console.log('Check 6 - hourly rows (must be ≤ 24):', hourly.rows.length);
  const hours = hourly.rows.map((r: any) => r.hour);
  console.log('Check 6 - hour values:', JSON.stringify(hours));

  // Check 7: device — ≤ 5 rows
  const device = await get('device');
  console.log('Check 7 - device rows (must be ≤ 5):', device.rows.length);
  console.log('Check 7 - devices:', device.rows.map((r: any) => r.device).join(', '));

  // Country - one row per country code
  const country = await get('country');
  const countries = country.rows.map((r: any) => r.country);
  const countryDupes = countries.filter((c: any, i: number) => countries.indexOf(c) !== i);
  console.log('Country rows:', country.rows.length, '| dupes:', JSON.stringify(countryDupes));

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
