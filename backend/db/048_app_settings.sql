-- 048_app_settings.sql
--
-- Small key/value store for per-deployment runtime state. First use: the
-- Outbrain API token.
--
-- Why: Outbrain's /login is rate-limited to 2 calls per hour per credential,
-- and the token (valid ~30 days) was cached only on local disk
-- (.cache/outbrain-token.json). Render's disk is ephemeral, so EVERY deploy or
-- restart forced a fresh login. With two deployments (Nadia, Joe) sharing one
-- credential — Outbrain will not issue a second key — two redeploys in the same
-- hour exhaust the limit and the loser's Outbrain jobs 429 until the window
-- clears (this already happened once on 2026-09-18 with a single worker plus a
-- manual backfill). Keeping the token in the deployment's own database means a
-- redeploy reuses it and each deployment logs in roughly once a month.
--
-- Not a secret store: the token is a bearer credential with a 30-day life, same
-- sensitivity as the file it replaces, and the DB is already the trust boundary.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
