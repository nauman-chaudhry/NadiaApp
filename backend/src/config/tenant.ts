import { env } from './env.js';

/**
 * Tenancy rules for a deployment. One repo is deployed once per client (Nadia,
 * Joe), each against its own database — see docs/plans/joe-dashboard.md.
 *
 * The partner credentials are SHARED and their APIs return every account they
 * can see (Outbrain `listMarketers()` returns all 20 marketers; Taboola
 * `allowed-accounts` returns both networks; IA's feed carries every affiliate).
 * So every place that lists accounts must ask this module which ones belong to
 * this deployment, or Joe's spend lands in Nadia's tables and vice versa.
 *
 * Rules are regexes on NAMES because that is the only field both platforms
 * share and the only one the operator can read in the dashboards:
 *   Nadia's worker: TENANT_ACCOUNT_EXCLUDE = ^SBH_rev_|Revlogic Media
 *   Joe's worker:   TENANT_ACCOUNT_INCLUDE = ^SBH_rev_|Revlogic Media
 * Unset = allow everything (the pre-tenancy behaviour).
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

function allowed(name: string, include: RegExp | null, exclude: RegExp | null): boolean {
  if (include && !include.test(name)) return false;
  if (exclude && exclude.test(name)) return false;
  return true;
}

/** Is this source (and therefore its cron jobs and backfill steps) on for this deployment? */
export function sourceEnabled(source: Source): boolean {
  return enabled.has(source);
}

/** Taboola account name or Outbrain marketer name → does it belong to this deployment? */
export function accountAllowed(name: string): boolean {
  return allowed(name ?? '', accountInclude, accountExclude);
}

/** Image Advantage affiliate (e.g. 'ssm.n2s.pro.tb') → does it belong to this deployment? */
export function iaAffiliateAllowed(affiliate: string): boolean {
  return allowed(affiliate ?? '', affiliateInclude, affiliateExclude);
}

/** One-line summary for boot logs and `run-once tenant-check`. */
export function describeTenant(): string {
  const r = (x: RegExp | null) => (x ? `/${x.source}/i` : '—');
  return `sources=${[...enabled].join(',')} account include=${r(accountInclude)} exclude=${r(accountExclude)} `
       + `ia-affiliate include=${r(affiliateInclude)} exclude=${r(affiliateExclude)}`;
}
