// Per-deployment branding. One repo is deployed once per client (Nadia, Joe);
// each Vercel project sets these, and the defaults keep Nadia's build unchanged.
// NEXT_PUBLIC_* values are inlined at build time, so they are safe in client
// components.

/** Shown in the header, the login card and the browser title. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? 'Seven Sphere Media';

/** Prefix for exported .xlsx filenames. */
export const EXPORT_PREFIX = process.env.NEXT_PUBLIC_EXPORT_PREFIX ?? 'seven-sphere';

/**
 * The account pre-selected on first load (empty string = all accounts). Nadia's
 * baseline sub-account; a deployment whose accounts don't include it simply
 * starts on "All accounts".
 */
export const DEFAULT_ACCOUNT_NAME =
  process.env.NEXT_PUBLIC_DEFAULT_ACCOUNT ?? 'TDG - Seven Sphere Media_4433 - Lead Gen Affiliates - SC';
