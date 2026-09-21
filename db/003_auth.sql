-- =============================================================================
-- Migration 003: app_users — role-based access control
-- Rows are inserted here after a user first logs in via Supabase Auth.
-- The middleware checks this table to verify the user is approved.
-- =============================================================================

CREATE TABLE IF NOT EXISTS app_users (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast email lookup (also handy for the admin list view later)
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_email ON app_users(email);
