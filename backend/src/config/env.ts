import 'dotenv/config';
import { z } from 'zod';

// Validate env once at boot. Fail loud if anything's missing.
const schema = z.object({
  DATABASE_URL: z.string().url(),

  TABOOLA_CLIENT_ID: z.string().min(1),
  TABOOLA_CLIENT_SECRET: z.string().min(1),
  TABOOLA_ACCOUNT_ID: z.string().min(1),
  TABOOLA_API_BASE: z.string().url().default('https://backstage.taboola.com/backstage/api/1.0'),

  // Outbrain optional for now (creds pending)
  OUTBRAIN_USERNAME: z.string().optional(),
  OUTBRAIN_PASSWORD: z.string().optional(),
  OUTBRAIN_API_BASE: z.string().url().default('https://api.outbrain.com/amplify/v0.1'),

  // Codefuel / IA credentials are required only when their source is enabled
  // (checked below, after parsing) — a tenant that runs IA only must not have
  // to invent Codefuel credentials to boot.
  CODEFUEL_CLIENT_ID: z.string().optional(),
  CODEFUEL_CLIENT_SECRET: z.string().optional(),
  CODEFUEL_API_BASE: z.string().url().default('https://search-api.perion.com/api'),

  IMAGE_ADVANTAGE_EMAIL: z.string().email().optional(),
  IMAGE_ADVANTAGE_PASSWORD: z.string().optional(),
  IMAGE_ADVANTAGE_ACCOUNT_ID: z.coerce.number().default(398),
  IMAGE_ADVANTAGE_API_BASE: z.string().url().default('https://api.vpptechia.com/v1'),

  // DDC (Domain Development Corp) — Stats API v2. Credentials travel as query
  // params, so DDC_REPORTING_URL must stay https.
  DDC_REPORTING_URL: z.string().url().default('https://24223-c9mazdp.ddcxlayer.com'),
  DDC_USERNAME: z.string().optional(),
  DDC_PASSWORD: z.string().optional(),
  // Hourly feed is a separate DDC service with its own auth (an authorization
  // code exchanged for a 30-minute token), not the reporting host above.
  DDC_HOURLY_API_BASE: z.string().url().default('https://rdp.ddc.com'),
  DDC_HOURLY_AUTH_CODE: z.string().optional(),

  // Client report delivery (Resend). The `from` domain must be VERIFIED on the
  // Resend account or delivery is restricted to the account owner's own address;
  // revlogicmedia.com is the verified domain on this account; a from-address on
  // any other domain is rejected or silently restricted to the account owner.
  RESEND_API_KEY: z.string().optional(),
  REPORT_EMAIL_FROM: z.string().default('Seven Sphere Reports <nadia@revlogicmedia.com>'),
  REPORT_EMAIL_TO: z.string().optional(),

  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  ENABLE_CRON: z.coerce.boolean().default(false),

  // ── Tenancy: one repo, deployed once per client (Nadia, Joe), each with its
  // own database. The partner APIs are shared credentials that return EVERY
  // account, so each deployment must say which accounts are its own. See
  // config/tenant.ts and docs/plans/joe-dashboard.md.
  //   ENABLED_SOURCES         comma list of taboola,outbrain,codefuel,image_advantage,ddc
  //   TENANT_ACCOUNT_INCLUDE  regex on the Taboola account / Outbrain marketer NAME;
  //                           when set, only matching accounts are synced
  //   TENANT_ACCOUNT_EXCLUDE  regex; matching accounts are skipped (applied after INCLUDE)
  //   TENANT_IA_AFFILIATE_*   same pair for Image Advantage affiliate names
  ENABLED_SOURCES: z.string().default('taboola,outbrain,codefuel,image_advantage,ddc'),
  TENANT_ACCOUNT_INCLUDE: z.string().optional(),
  TENANT_ACCOUNT_EXCLUDE: z.string().optional(),
  TENANT_IA_AFFILIATE_INCLUDE: z.string().optional(),
  TENANT_IA_AFFILIATE_EXCLUDE: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Per-source credentials are only mandatory for enabled sources. Fail at boot,
// loudly, rather than at the first cron tick hours later.
const enabledSources = new Set(env.ENABLED_SOURCES.split(',').map(s => s.trim()).filter(Boolean));
const missing: string[] = [];
if (enabledSources.has('codefuel') && !(env.CODEFUEL_CLIENT_ID && env.CODEFUEL_CLIENT_SECRET)) {
  missing.push('CODEFUEL_CLIENT_ID / CODEFUEL_CLIENT_SECRET (codefuel is enabled)');
}
if (enabledSources.has('image_advantage') && !(env.IMAGE_ADVANTAGE_EMAIL && env.IMAGE_ADVANTAGE_PASSWORD)) {
  missing.push('IMAGE_ADVANTAGE_EMAIL / IMAGE_ADVANTAGE_PASSWORD (image_advantage is enabled)');
}
if (missing.length) {
  console.error('Invalid environment configuration: missing ' + missing.join('; '));
  process.exit(1);
}
