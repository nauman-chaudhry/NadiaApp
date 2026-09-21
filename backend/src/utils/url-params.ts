/**
 * Extract the `gd` and `r` query params from a Taboola/Outbrain landing URL.
 * These are the join keys to Codefuel/Perion's asset_gid and channel.
 *
 * Example:
 *   https://www.mysearch4you.com/Search?q=...&gd=AP1008549&r=4268019316
 *   → { gd: 'AP1008549', r: '4268019316' }
 *
 * Returns nulls if the URL is malformed or the params are missing.
 */
export function extractJoinParams(url: string | null | undefined): {
  gd: string | null;
  r: string | null;
} {
  if (!url) return { gd: null, r: null };
  try {
    const u = new URL(url);
    return {
      gd: u.searchParams.get('gd'),
      r: u.searchParams.get('r'),
    };
  } catch {
    // Some ads may use non-standard URLs; fall back to a regex pull
    const gdMatch = url.match(/[?&]gd=([^&#]+)/);
    const rMatch  = url.match(/[?&]r=([^&#]+)/);
    return {
      gd: gdMatch ? decodeURIComponent(gdMatch[1]) : null,
      r:  rMatch  ? decodeURIComponent(rMatch[1])  : null,
    };
  }
}
