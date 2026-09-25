-- 049_lock_down_public_schema.sql
--
-- Close anonymous/browser access to every table in the public schema.
--
-- Supabase exposes the `public` schema through PostgREST to the `anon` and
-- `authenticated` roles, and its default privileges GRANT those roles ALL on
-- every table the `postgres` user creates. This app never uses PostgREST: the
-- frontend only talks to Supabase Auth, and every read goes through the Express
-- API with a direct `pg` connection. So those grants were pure exposure —
-- confirmed live 2026-09-24: the public key alone could SELECT (and UPDATE)
-- `app_settings`, `app_users`, `ad_accounts`, `partner_stats_hourly` and the
-- materialized view, which made migration 048's Outbrain token store a
-- publicly readable credential.
--
-- Revoke everything from the browser roles, and change the DEFAULT privileges
-- so future tables (and every re-created materialized view — MV migrations
-- DROP/CREATE it) never get the grants back. `service_role` and `postgres`
-- are untouched. The auth trigger (003b) is SECURITY DEFINER owned by
-- postgres, so it keeps working.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Belt and braces for the objects that matter most.
REVOKE ALL ON joined_stats_hourly FROM anon, authenticated;
REVOKE ALL ON app_settings        FROM anon, authenticated;
REVOKE ALL ON app_users           FROM anon, authenticated;
