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

  CODEFUEL_CLIENT_ID: z.string().min(1),
  CODEFUEL_CLIENT_SECRET: z.string().min(1),
  CODEFUEL_API_BASE: z.string().url().default('https://search-api.perion.com/api'),

  IMAGE_ADVANTAGE_EMAIL: z.string().email(),
  IMAGE_ADVANTAGE_PASSWORD: z.string().min(1),
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
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
