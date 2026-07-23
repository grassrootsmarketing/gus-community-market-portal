-- Support sessions audit table.
-- Every owner impersonation event writes one row here.
-- Retailer can see recent support sessions from their admin settings.
--
-- Run this ONCE in Supabase SQL editor.

CREATE TABLE IF NOT EXISTS support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  target_retailer_id UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  target_session_id UUID REFERENCES admin_sessions(session_id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  writes_count INTEGER NOT NULL DEFAULT 0,
  last_action_at TIMESTAMPTZ,
  ip_address TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS support_sessions_retailer_idx
  ON support_sessions (target_retailer_id, started_at DESC);

CREATE INDEX IF NOT EXISTS support_sessions_owner_idx
  ON support_sessions (owner_email, started_at DESC);

-- RLS off — service key only writes here from api/admin-auth.js
-- (matches the pattern of other admin tables)
ALTER TABLE support_sessions DISABLE ROW LEVEL SECURITY;
