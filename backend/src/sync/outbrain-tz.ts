// =============================================================================
// Outbrain timezone conversion — EDT/EST (America/New_York) -> UTC.
//
// CRITICAL: Outbrain's Amplify reporting API returns timestamps in the
// marketer's local New York time (EDT in summer = UTC-4, EST in winter =
// UTC-5). Codefuel and Image Advantage revenue are already UTC. If Outbrain
// hours are stored without conversion, the hourly cost↔revenue join lands in
// the wrong bucket (off by 4-5h) and silently corrupts every Outbrain row.
//
// We convert on INGEST, in the sync layer, so every hour_utc column in the DB
// is true UTC and the MV/joins stay apples-to-apples.
//
// HOW THE +4 (EDT) OFFSET WAS VERIFIED — and why NOT to "fix" it to a peak check:
//   Do NOT verify this offset by correlating the hourly Outbrain COST curve
//   against the hourly Codefuel/IA REVENUE curve. That check is INVALID here:
//   Outbrain cost is the moment of the ad click, but search-arbitrage revenue
//   is monetised LATER (the user searches downstream), so the two curves do not
//   align at ANY offset (measured cross-correlation was flat, ~0.05, at every
//   lag). A future engineer "correcting" the timezone via peak-alignment would
//   chase noise and likely break this working +4.
//   The offset was instead confirmed via the DATA-FRESHNESS FRONTIER: at a known
//   UTC wall-clock, the latest COMPLETE Outbrain cost hour sits exactly 4 hours
//   behind UTC (and the in-progress-hour magnitude rules out -5; cost is never
//   4h+ stale, which rules out UTC). That uniquely identifies EDT (-4).
//   Reconcile Outbrain at DAILY grain, not hourly co-location.
//
// Implementation note: rather than hardcode "+4" (only valid during DST), we
// compute the real America/New_York offset for each timestamp via Intl. This
// is correct across the DST boundary automatically and needs no dependency.
// For the current backfill window (Apr–Jun 2026) the offset is always +4, but
// this keeps Nov/Mar-spanning syncs correct too.
// =============================================================================

/**
 * Offset of America/New_York from UTC, in minutes, at the given UTC instant.
 * EDT -> -240, EST -> -300.
 */
function nyOffsetMinutes(at: Date): number {
  // Format the same instant in NY and in UTC, then diff the wall-clock values.
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(at).reduce<Record<string, string>>((o, p) => {
      if (p.type !== 'literal') o[p.type] = p.value;
      return o;
    }, {});
  const ny = fmt('America/New_York');
  const utc = fmt('UTC');
  const asMs = (p: Record<string, string>) =>
    Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? '0' : p.hour), +p.minute, +p.second);
  return Math.round((asMs(ny) - asMs(utc)) / 60000);
}

/**
 * Convert an Outbrain local-time timestamp ("YYYY-MM-DD HH:00:00", New York
 * wall-clock) to the correct UTC Date.
 *
 * Example (EDT, June): "2026-06-10 10:00:00" (NY) -> 2026-06-10T14:00:00Z.
 *
 * Accepts "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DDTHH:mm:ss", or a date-only string
 * (treated as 00:00 local).
 */
export function outbrainLocalToUtc(local: string): Date {
  const m = local.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) throw new Error(`Unparseable Outbrain timestamp: "${local}"`);
  const [, y, mo, d, hh = '00', mi = '00', ss = '00'] = m;
  // Interpret the wall-clock as if it were UTC, then subtract the NY offset to
  // get the true UTC instant. The offset is evaluated at that approximate
  // instant — stable except within the 1h DST-transition window, which the
  // hourly grain tolerates.
  const naiveUtc = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
  const offMin = nyOffsetMinutes(naiveUtc);
  return new Date(naiveUtc.getTime() - offMin * 60000);
}
