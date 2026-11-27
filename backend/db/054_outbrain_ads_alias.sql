-- 054: outbrain_ads can hold ALIAS rows (TRACK 2026-11-27).
--
-- outbrain_ads maps a Codefuel (gd, r) pair to the Outbrain campaign whose
-- landing URL carries it. Until now every row came from a URL (written nightly by
-- syncOutbrainPromotedLinks). Two gaps left Codefuel-Outbrain revenue in the
-- "(Unattributed — no account)" row:
--   * a new link's pair only appeared after the 03:00 backfill (up to ~24h);
--   * Codefuel can report a GID different from the one in the URL — SSM16's
--     foundthatdeal.com links carry gd=AP1009513 but Codefuel reports the
--     domain's GID AP1009512 ($854.68, 2026-11-25..27).
-- resolveOutbrainCodefuelPairs() (sync/outbrain.ts, hourly) now inserts the
-- missing URL pairs (origin 'url') and, when a reported pair matches EXACTLY one
-- campaign by r + recent spend + the GID's known domain, an alias row
-- (origin 'alias') recording the GID actually in the link's URL (link_gd) so the
-- API's Ads view can still land the revenue on the real promoted link.
-- A URL pair always wins: the nightly upsert resets origin/link_gd.
-- Additive and idempotent; existing rows become origin 'url'.

ALTER TABLE outbrain_ads ADD COLUMN IF NOT EXISTS origin  TEXT NOT NULL DEFAULT 'url';
ALTER TABLE outbrain_ads ADD COLUMN IF NOT EXISTS link_gd TEXT;
