import { fetchDDCHourly } from '../sources/ddc/client.js';
import { query } from '../db/client.js';
import { sendEmail } from '../sources/resend/client.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Daily "DDC hourly by Type Tag" CSV for the client.
 *
 * Built from DDC's hourly API rather than partner_stats_hourly on purpose: the
 * sync stores bidded searches but DISCARDS raw `searches`, and it splits DDC's
 * tag into a normalized tt + publisher. The client asked for `searches` and for
 * the tag in DDC's own `<TT>_<publisher_id>` form, so only the raw feed can
 * satisfy the request without losing a column.
 *
 * The feed exposes a rolling ~3 days, so a missed send self-heals on the next
 * run instead of losing a day.
 */
export interface DdcCsvResult {
  date: string;
  filename: string;
  csv: string;
  rows: number;
  tags: number;
  hours: number;
  revenue: number;
}

const CSV_HEADER = 'date,hour,type_tag,clicks,searches,bidded_searches,revenue,rpc';

/** A CSV field is quoted only when it could otherwise break the row. */
function csvField(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function buildDdcHourlyCsv(date: string): Promise<DdcCsvResult> {
  const all = await fetchDDCHourly();
  const rows = all.filter((r) => r.date === date);

  // DDC's hourly feed only exposes a rolling ~3 days. Past that the day is gone
  // from the API but still in our own tables, so fall back rather than silently
  // dropping it from the report — that is how a "last 3 days" request quietly
  // arrived with two.
  //
  // One column is lost in the fallback: the sync stores bidded searches but not
  // raw `searches`, so that field is left EMPTY rather than filled with a stand-in
  // that would read as a real zero.
  if (rows.length === 0) {
    const stored = await query<{ hour: number; tag: string; clicks: number; bidded: number; revenue: number }>(
      `SELECT EXTRACT(HOUR FROM ps.hour_utc)::int AS hour,
              regexp_replace(ps.campaign_ext_id, '^(ob|tb):', '')
                || CASE WHEN COALESCE(ps.item_ext_id,'') <> '' THEN '_' || ps.item_ext_id ELSE '' END AS tag,
              SUM(ps.ad_clicks)::int AS clicks, SUM(ps.sessions)::int AS bidded,
              SUM(ps.revenue)::float AS revenue
         FROM partner_stats_hourly ps
         JOIN client_partners cp ON cp.id = ps.client_partner_id AND cp.code = 'ddc'
        WHERE ps.granularity = 'hourly' AND ps.hour_utc::date = $1::date
        GROUP BY 1, 2 ORDER BY 1, 5 DESC`,
      [date],
    );
    if (stored.length > 0) {
      logger.info({ date, rows: stored.length }, 'ddc report: day aged out of the feed, using stored rows');
      const lines = [CSV_HEADER];
      for (const r of stored) {
        const rpc = r.clicks > 0 ? r.revenue / r.clicks : 0;
        lines.push([date, r.hour, csvField(r.tag), r.clicks, '', r.bidded,
                    r.revenue.toFixed(4), rpc.toFixed(4)].join(','));
      }
      return {
        date, filename: `ddc-hourly-by-typetag_${date}.csv`, csv: lines.join('\n') + '\n',
        rows: stored.length, tags: new Set(stored.map((r) => r.tag)).size,
        hours: new Set(stored.map((r) => r.hour)).size,
        revenue: stored.reduce((a, r) => a + r.revenue, 0),
      };
    }
  }

  // Grain: date + hour + RAW tag. The raw tag is kept exactly as DDC reports it
  // (<TT>_<publisher_id>) — not split, not summed across publishers — because
  // that is the granularity the client matches on.
  type Agg = { hour: number; tag: string; clicks: number; searches: number; bidded: number; revenue: number };
  const acc = new Map<string, Agg>();
  for (const r of rows) {
    const tag = (r.typeTag ?? '').trim();
    if (!tag) continue;
    const k = `${r.hour}|${tag}`;
    const p = acc.get(k) ?? { hour: r.hour, tag, clicks: 0, searches: 0, bidded: 0, revenue: 0 };
    p.clicks += r.clicks;
    p.searches += r.searches;
    p.bidded += r.biddedSearches;
    p.revenue += r.revenue;
    acc.set(k, p);
  }

  const out = [...acc.values()].sort((a, b) => a.hour - b.hour || b.revenue - a.revenue);
  const lines = [CSV_HEADER];
  for (const r of out) {
    const rpc = r.clicks > 0 ? r.revenue / r.clicks : 0;
    lines.push([date, r.hour, csvField(r.tag), r.clicks, r.searches, r.bidded,
                r.revenue.toFixed(4), rpc.toFixed(4)].join(','));
  }

  return {
    date,
    filename: `ddc-hourly-by-typetag_${date}.csv`,
    csv: lines.join('\n') + '\n',
    rows: out.length,
    tags: new Set(out.map((r) => r.tag)).size,
    hours: new Set(out.map((r) => r.hour)).size,
    revenue: out.reduce((a, r) => a + r.revenue, 0),
  };
}

/** Build one CSV covering several days. Days with no rows are skipped, not faked. */
export async function buildDdcHourlyCsvRange(dates: string[]): Promise<DdcCsvResult> {
  const parts: string[] = [];
  let rows = 0, revenue = 0;
  const tags = new Set<string>();
  const covered: string[] = [];
  for (const d of dates) {
    const r = await buildDdcHourlyCsv(d);
    if (r.rows === 0) { logger.warn({ date: d }, 'ddc report: no rows for day, skipping'); continue; }
    for (const l of r.csv.trimEnd().split('\n').slice(1)) {
      parts.push(l);
      tags.add(l.split(',')[2]);
    }
    rows += r.rows; revenue += r.revenue; covered.push(d);
  }
  const first = covered[0] ?? 'empty', last = covered[covered.length - 1] ?? 'empty';
  return {
    date: covered.length ? `${first}_to_${last}` : '',
    filename: `ddc-hourly-by-typetag_${first}_to_${last}.csv`,
    csv: [CSV_HEADER, ...parts].join('\n') + '\n',
    rows, tags: tags.size, hours: 0, revenue,
  };
}

/** Build yesterday's CSV and email it. Throws if the day has no data at all. */
export async function sendDdcHourlyReport(opts?: { date?: string; dates?: string[]; to?: string }): Promise<DdcCsvResult> {
  const date = opts?.date ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = opts?.to ?? env.REPORT_EMAIL_TO;
  if (!to) throw new Error('REPORT_EMAIL_TO is not set — nowhere to send the DDC report');

  const r = opts?.dates?.length
    ? await buildDdcHourlyCsvRange(opts.dates)
    : await buildDdcHourlyCsv(date);
  // Refuse to send an empty file: silence is better than mailing the client a
  // header-only CSV that looks like a day with no revenue.
  if (r.rows === 0) {
    throw new Error(`DDC hourly report: no rows for ${date} — not sending an empty file`);
  }
  if (r.hours < 24) {
    logger.warn({ date, hours: r.hours }, 'ddc report: day is not complete (sending anyway)');
  }

  await sendEmail({
    to,
    subject: `DDC hourly report by Type Tag — ${(r.date || date).replace('_to_', ' to ')}`,
    text: [
      `DDC hourly revenue by Type Tag for ${(r.date || date).replace('_to_', ' to ')}.`,
      '',
      `Rows: ${r.rows}`,
      `Type tags: ${r.tags}`,
      ...(r.hours ? [`Hours covered: ${r.hours}/24`] : []),
      `Total revenue: $${r.revenue.toFixed(2)}`,
      '',
      'Columns: date, hour (UTC), type_tag (<TT>_<publisher_id> as reported by DDC),',
      'clicks, searches, bidded_searches, revenue, rpc.',
    ].join('\n'),
    attachments: [{ filename: r.filename, content: r.csv }],
  });

  logger.info({ ...r, csv: undefined, to }, 'ddc report: sent');
  return r;
}
