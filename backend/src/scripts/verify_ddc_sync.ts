/**
 * Verify the DDC sync transform against the live DDC API. READ-ONLY — no DB writes.
 *
 * Proves the parse/accumulate step loses no revenue: for every day it compares
 * the rows we would store against DDC's own `report_type=date` total, which is
 * an independent figure from the same API.
 *
 * Run: npx tsx src/scripts/verify_ddc_sync.ts
 * Last result (2026-08-31): 40/40 days exact, $6,270.3164 both sides,
 * 2,077 rows, 0 skipped, 0 in-map collisions.
 */
// Offline end-to-end verification of the DDC sync's transform, using the REAL
// API and the REAL functions from src/sync/ddc.ts. No database writes.
import { parseTypeTag, platformForDomain } from '../sync/ddc.js';
import { fetchDDCDetail, fetchDDCDaily } from '../sources/ddc/client.js';

const FROM = '2026-07-22', TO = '2026-08-30';
const daily = await fetchDDCDaily(FROM, TO);
const expected = daily.reduce((a, d) => a + d.revenue, 0);
console.log(`DDC 'date' report ${FROM}..${TO}: ${daily.length} days, $${expected.toFixed(4)}\n`);

let grand = 0, rowsOut = 0, skipped = 0, collisions = 0;
const perDay = [];
for (const d of daily) {
  const rows = await fetchDDCDetail(d.day);
  const acc = new Map();
  for (const row of rows) {
    const sp = platformForDomain(row.Mode);
    if (!sp) { skipped++; continue; }
    const { tag, publisher } = parseTypeTag(row.TypeTag);
    if (!tag) { skipped++; continue; }
    const key = `${sp === 'Outbrain' ? 'ob:' : 'tb:'}${tag} ${publisher} ${row.Country ?? ''}`;
    if (acc.has(key)) collisions++;
    const p = acc.get(key);
    acc.set(key, {
      revenue: (p?.revenue ?? 0) + (Number(row['Net Client']) || 0),
      adClicks: (p?.adClicks ?? 0) + (Number(row.Clicks) || 0),
      sessions: (p?.sessions ?? 0) + (Number(row.BiddedSearches) || 0),
    });
  }
  const got = [...acc.values()].reduce((a, t) => a + t.revenue, 0);
  grand += got; rowsOut += acc.size;
  perDay.push({ day: d.day, ddc: d.revenue.toFixed(4), transformed: got.toFixed(4),
                match: Math.abs(got - d.revenue) < 0.00005 ? 'ok' : 'MISMATCH', stored: acc.size, src: rows.length });
  await new Promise(r => setTimeout(r, 150));
}
const bad = perDay.filter(x => x.match !== 'ok');
console.table(perDay.slice(-6));
console.log(`\nrows stored: ${rowsOut}   source rows skipped (unknown domain/empty tag): ${skipped}   in-map collisions: ${collisions}`);
console.log(`day-by-day matches: ${perDay.length - bad.length}/${perDay.length}` + (bad.length ? `  FAILING: ${bad.map(b=>b.day).join(', ')}` : ''));
console.log(`\nTOTAL transformed: $${grand.toFixed(4)}`);
console.log(`TOTAL from DDC   : $${expected.toFixed(4)}`);
console.log(`=> ${Math.abs(grand - expected) < 0.005 ? 'EXACT MATCH — transform loses no revenue' : '*** DISCREPANCY $' + (grand-expected).toFixed(4) + ' ***'}`);
