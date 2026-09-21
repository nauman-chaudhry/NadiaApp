import axios from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

// =============================================================================
// DDC Stats API v2 client (Domain Development Corp).
//
//   GET https://<host>/webservices.php
//         ?output=json&service=dailystats
//         &username=&password=
//         &date_start_mm=&date_start_dd=&date_start_yyyy=
//         &date_end_mm=&date_end_dd=&date_end_yyyy=
//         &report_type=<date|domain|detail|device>&domains=<csv>
//
// Auth is username + password as QUERY PARAMS — there is no token. HTTPS is
// supported and is what we use; the vendor's own sample script uses plain http,
// which would put the credentials on the wire in clear text. Never fall back.
//
// ── Landmines, all verified against the live API on 2026-08-31 ───────────────
//
// 1. A DATE RANGE IS SUMMED, NOT SPLIT. `detail` carries no date column, so
//    asking for 27–29 Aug returns ONE aggregated set, not three days. The sync
//    therefore calls one day at a time. Ranges are only useful for totals.
// 2. `Mode` is the DOMAIN, not a mode. ob.startgonow.com / tb.startgonow.com.
//    This is the platform discriminator (Nadia: tmpl C244 -> ob, C245 -> tb).
// 3. Every metric is a STRING ("0.0000"), and `Tq` is null (not 0.00).
// 4. `Visitors` is always 0 and `Searches` has been identical to
//    `BiddedSearches` in every row observed — neither is stored.
// 5. The DDC/Yahoo day ends 5pm PST = midnight UTC, so the reported day IS a
//    UTC day and needs no conversion to our hour_utc convention.
// =============================================================================

export interface DDCDetailRow {
  Mode: string;               // the DOMAIN, e.g. 'ob.startgonow.com'
  Visitors: string;
  Clicks: string;
  'Net Client': string;       // revenue, NET to us (Nadia: no % to apply)
  Searches: string;
  BiddedSearches: string;
  TypeTag: string;            // '<34-hex>' or '<34-hex>_<34-hex publisher>'
  Country: string | null;
  Tq: string | null;
  'Source Tq': string | null;
}

export type DDCReportType = 'date' | 'domain' | 'detail' | 'device';

/**
 * One hour of DDC stats, from the SEPARATE hourly service on rdp.ddc.com.
 * Richer than the daily `detail` report: it carries hour AND device type.
 */
export interface DDCHourlyRow {
  date: string;            // YYYY-MM-DD, UTC (DDC's day ends midnight UTC)
  hour: number;            // 0-23
  domain: string;          // ob.startgonow.com | tb.startgonow.com
  country: string;
  device: string;          // 'Smart Phones' | 'Desktop'
  typeTag: string;         // same tt as the daily report, publisher suffix included
  searches: number;
  clicks: number;
  revenue: number;         // net to us
  tq: number | null;
  biddedSearches: number;
}

function splitDate(day: string): { mm: string; dd: string; yyyy: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`DDC: bad date '${day}', expected YYYY-MM-DD`);
  return { yyyy: m[1], mm: m[2], dd: m[3] };
}

/**
 * Raw report call. `from`/`to` are 'YYYY-MM-DD'; passing from != to returns the
 * SUM over that range (see landmine 1) — only use it for cross-checks.
 */
async function fetchReport<T>(
  reportType: DDCReportType,
  from: string,
  to: string,
): Promise<T[]> {
  const a = splitDate(from);
  const b = splitDate(to);
  const { data } = await axios.get(`${env.DDC_REPORTING_URL}/webservices.php`, {
    params: {
      output: 'json',
      service: 'dailystats',
      username: env.DDC_USERNAME,
      password: env.DDC_PASSWORD,
      date_start_mm: a.mm, date_start_dd: a.dd, date_start_yyyy: a.yyyy,
      date_end_mm:   b.mm, date_end_dd:   b.dd, date_end_yyyy:   b.yyyy,
      report_type: reportType,
      domains: '',
    },
    timeout: 90_000,
  });
  // The service answers HTTP 200 with an {error: ...} object on failure.
  if (data && !Array.isArray(data) && typeof data === 'object' && 'error' in data) {
    const msg = String((data as any).error ?? '').trim();
    // "No stats for this date" is NOT a failure — it is DDC telling us the day
    // is not ready yet. Their data lags ~2 days, so the nightly D-4..D-1 window
    // always asks for at least one day they cannot answer. Throwing on it marked
    // the whole 03:00 backfill `steps failed: ddc` EVERY night, which is exactly
    // the kind of permanent red that stops anyone reading a real failure.
    // Treat it as an empty day; every other error still throws loudly.
    if (/no stats for this date/i.test(msg)) {
      logger.info({ from, to, reportType }, 'ddc: no stats for this date yet - treating as empty');
      return [];
    }
    throw new Error(`DDC API error: ${msg}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`DDC API returned ${typeof data}, expected an array`);
  }
  return data as T[];
}

/**
 * One day of per-(domain, type tag, country) rows — the revenue feed.
 *
 * RETRIES on an empty result. The API intermittently answers "No stats for this
 * date" for a day that demonstrably HAS data — observed on 2026-09-04, which
 * returned no stats three times, then returned $238.1261 on the next three
 * attempts with nothing changed in between. Because a flap is indistinguishable
 * from a genuinely empty day, without this a transient blip would silently
 * record zero revenue for a real trading day.
 */
export async function fetchDDCDetail(day: string): Promise<DDCDetailRow[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const rows = await fetchReport<DDCDetailRow>('detail', day, day);
    if (rows.length > 0) {
      logger.info({ day, rows: rows.length, attempt }, 'ddc: fetched detail');
      return rows;
    }
    if (attempt < 3) {
      logger.warn({ day, attempt }, 'ddc: empty detail, retrying');
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  logger.info({ day }, 'ddc: detail empty after 3 attempts');
  return [];
}

/**
 * Per-day totals. The API's own independent total for a day — used to prove the
 * `detail` rows we store sum to what DDC itself reports. `Mode` holds the DATE
 * on this report, not a domain.
 */
export async function fetchDDCDaily(
  from: string,
  to: string,
): Promise<{ day: string; revenue: number; clicks: number; biddedSearches: number }[]> {
  const rows = await fetchReport<DDCDetailRow>('date', from, to);
  return rows.map(r => ({
    day: r.Mode,
    revenue: Number(r['Net Client']) || 0,
    clicks: Number(r.Clicks) || 0,
    biddedSearches: Number(r.BiddedSearches) || 0,
  }));
}


// =============================================================================
// Hourly feed — a DIFFERENT service from dailystats above.
//
//   GET https://rdp.ddc.com/oauth2/access_token?code=<auth code>  -> 30-min token
//   GET https://rdp.ddc.com/api/v1/dw/yss_current_day?access_token=<token>
//
// Returns TAB-DELIMITED text (not JSON) with a header row, covering a rolling
// ~3 days including today. Verified 2026-09-06: 24 full hours for each closed
// day and 11 hours of the current day, running ~5 hours behind — which matches
// the vendor's "4-6 hours behind" note.
//
// It reconciles with the daily report to the cent (2026-09-03 $210.0174 hourly
// vs $210.01 daily; 2026-09-04 $238.1154 vs $238.13 — their figures are marked
// pending/unaudited, hence the pennies).
//
// There is also /yss_fast_current_day, 2-4 hours behind but WITHOUT TQ. We use
// the slower one because it carries every column.
// =============================================================================

let hourlyToken: { token: string; expires: number } | null = null;

async function getHourlyToken(): Promise<string> {
  // Tokens last 30 minutes. Cache in-process with a minute of headroom rather
  // than fetching one per call.
  if (hourlyToken && Date.now() < hourlyToken.expires - 60_000) return hourlyToken.token;
  if (!env.DDC_HOURLY_AUTH_CODE) throw new Error('DDC_HOURLY_AUTH_CODE not set');
  const { data } = await axios.get(`${env.DDC_HOURLY_API_BASE}/oauth2/access_token`, {
    params: { code: env.DDC_HOURLY_AUTH_CODE },
    timeout: 60_000,
  });
  if (!data?.access_token) throw new Error(`DDC hourly auth failed: ${JSON.stringify(data).slice(0, 120)}`);
  hourlyToken = { token: data.access_token, expires: Date.now() + 30 * 60_000 };
  return hourlyToken.token;
}

const num = (v: string | undefined): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/** The rolling hourly window DDC currently exposes (~3 days, including today). */
export async function fetchDDCHourly(): Promise<DDCHourlyRow[]> {
  const token = await getHourlyToken();
  const { data } = await axios.get<string>(`${env.DDC_HOURLY_API_BASE}/api/v1/dw/yss_current_day`, {
    params: { access_token: token },
    timeout: 120_000,
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  // The response opens with a BLANK LINE before the header — drop empties first.
  const lines = String(data).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    logger.warn({ lines: lines.length }, 'ddc hourly: no data rows');
    return [];
  }
  const hdr = lines[0].split('\t').map((h) => h.trim());
  const at = (name: string) => hdr.indexOf(name);
  const iDate = at('date'), iHour = at('hour'), iDom = at('domain'),
        iCty = at('country code'), iDev = at('device type'), iTag = at('campaign'),
        iSea = at('searches'), iClk = at('clicks'), iRev = at('revenue'),
        iTq = at('TQ'), iBid = at('bidded_searches');
  if (iDate < 0 || iHour < 0 || iRev < 0 || iTag < 0) {
    throw new Error(`DDC hourly: unexpected columns [${hdr.join(', ')}]`);
  }
  const out: DDCHourlyRow[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    if (!f[iDate]) continue;
    out.push({
      date: f[iDate].trim(),
      hour: num(f[iHour]),
      domain: (f[iDom] ?? '').trim(),
      country: (f[iCty] ?? '').trim(),
      device: (f[iDev] ?? '').trim(),
      typeTag: (f[iTag] ?? '').trim(),
      searches: num(f[iSea]),
      clicks: num(f[iClk]),
      revenue: num(f[iRev]),
      tq: iTq >= 0 && String(f[iTq] ?? '').trim() !== '' ? num(f[iTq]) : null,
      biddedSearches: num(f[iBid]),
    });
  }
  const days = [...new Set(out.map((r) => r.date))].sort();
  logger.info({ rows: out.length, days }, 'ddc hourly: fetched');
  return out;
}
