import { env } from './env.js';

/**
 * Tenancy rules for a deployment. One repo is deployed once per client (Nadia,
 * Joe), each against its own database — see docs/plans/joe-dashboard.md and
 * CLAUDE.md §13.
 *
 * The partner credentials are SHARED and their APIs return every account they
 * can see (Outbrain `listMarketers()` returns all 20 marketers; Taboola
 * `allowed-accounts` returns both networks; IA's feed carries every affiliate).
 * So every place that lists accounts must ask this module which ones belong to
 * this deployment, or Joe's spend lands in Nadia's tables and vice versa.
 *
 * Rules are regexes tested against BOTH the display name and the platform's
 * stable id (Taboola `account_id`, Outbrain marketer id), so an operator can
 * pin an account by id when a name is ambiguous or gets renamed:
 *   Nadia's worker: TENANT_ACCOUNT_EXCLUDE = ^SBH_rev_|Revlogic Media
 *   Joe's worker:   TENANT_ACCOUNT_INCLUDE = ^SBH_rev_|Revlogic Media
 *
 * PRODUCTION REQUIRES EXPLICIT RULES. Unset rules allow everything, which is
 * the pre-tenancy behaviour and fine on a laptop, but in production a
 * deployment that forgot its rules would ingest every client's data. So with
 * NODE_ENV=production the process refuses to start unless an account rule is
 * set (and an IA affiliate rule, when image_advantage is enabled) — or
 * TENANT_ALLOW_ALL=true states the intent explicitly.
 *
 * Nothing here touches the API or the MV: filtering happens at ingestion only,
 * so a mistake shows up as a missing account, never as wrong numbers.
 */

export const SOURCES = ['taboola', 'outbrain', 'codefuel', 'image_advantage', 'ddc'] as const;
export type Source = (typeof SOURCES)[number];

const enabled = new Set(env.ENABLED_SOURCES.split(',').map(s => s.trim()).filter(Boolean));
for (const s of enabled) {
  if (!(SOURCES as readonly string[]).includes(s)) {
    console.error(`ENABLED_SOURCES: unknown source '${s}' (valid: ${SOURCES.join(', ')})`);
    process.exit(1);
  }
}

function compile(name: string, value: string | undefined): RegExp | null {
  if (!value || value.trim() === '') return null;
  try {
    return new RegExp(value, 'i');
  } catch (e: any) {
    console.error(`${name} is not a valid regular expression: ${e.message}`);
    process.exit(1);
  }
}

const accountInclude = compile('TENANT_ACCOUNT_INCLUDE', env.TENANT_ACCOUNT_INCLUDE);
const accountExclude = compile('TENANT_ACCOUNT_EXCLUDE', env.TENANT_ACCOUNT_EXCLUDE);
const affiliateInclude = compile('TENANT_IA_AFFILIATE_INCLUDE', env.TENANT_IA_AFFILIATE_INCLUDE);
const affiliateExclude = compile('TENANT_IA_AFFILIATE_EXCLUDE', env.TENANT_IA_AFFILIATE_EXCLUDE);

if (env.NODE_ENV === 'production' && !env.TENANT_ALLOW_ALL) {
  const problems: string[] = [];
  if (!accountInclude && !accountExclude) problems.push('TENANT_ACCOUNT_INCLUDE or TENANT_ACCOUNT_EXCLUDE');
  if (enabled.has('image_advantage') && !affiliateInclude && !affiliateExclude) {
    problems.push('TENANT_IA_AFFILIATE_INCLUDE or TENANT_IA_AFFILIATE_EXCLUDE (image_advantage is enabled)');
  }
  if (problems.length) {
    console.error(
      `Tenancy: production requires explicit rules — set ${problems.join(' and ')}, ` +
      `or TENANT_ALLOW_ALL=true to run this deployment against every account on the shared credentials.`,
    );
    process.exit(1);
  }
}

/** Is this source (and therefore its cron jobs and backfill steps) on for this deployment? */
export function sourceEnabled(source: Source): boolean {
  return enabled.has(source);
}

/**
 * Taboola account / Outbrain marketer → does it belong to this deployment?
 * Include: passes if the NAME or the ID matches. Exclude: fails if either matches.
 */
export function accountAllowed(name: string, externalId?: string): boolean {
  const keys = [name ?? '', externalId ?? ''].filter(Boolean);
  if (accountInclude && !keys.some(k => accountInclude.test(k))) return false;
  if (accountExclude && keys.some(k => accountExclude.test(k))) return false;
  return true;
}

/**
 * Image Advantage affiliate (e.g. 'ssm.n2s.pro.tb') → does it belong to this
 * deployment? A blank affiliate is never accepted: it cannot be owned by
 * anyone, so it is quarantined (counted as skipped by the sync) rather than
 * ingested as unattributed revenue.
 */
export function iaAffiliateAllowed(affiliate: string): boolean {
  const a = (affiliate ?? '').trim();
  if (!a) return false;
  if (affiliateInclude && !affiliateInclude.test(a)) return false;
  if (affiliateExclude && affiliateExclude.test(a)) return false;
  return true;
}

/**
 * Partner code newly discovered accounts are tagged with (TENANT_DEFAULT_PARTNER).
 * For a single-partner tenant (Joe = image_advantage) this replaces the manual
 * tagging step that otherwise leaves accounts "Untagged" — which hides the
 * Project/Feeds controls and, worse, makes the MV's IA-orphan lateral find no
 * account. Unset for Nadia: her accounts are tagged deliberately by hand.
 */
export const defaultPartnerCode: string | null = env.TENANT_DEFAULT_PARTNER?.trim() || null;

/** One-line summary for boot logs and `run-once tenant-check`. */
export function describeTenant(): string {
  const r = (x: RegExp | null) => (x ? `/${x.source}/i` : '—');
  return `sources=${[...enabled].join(',')} account include=${r(accountInclude)} exclude=${r(accountExclude)} `
       + `ia-affiliate include=${r(affiliateInclude)} exclude=${r(affiliateExclude)} `
       + `default-partner=${defaultPartnerCode ?? '—'} allow-all=${env.TENANT_ALLOW_ALL}`;
}
