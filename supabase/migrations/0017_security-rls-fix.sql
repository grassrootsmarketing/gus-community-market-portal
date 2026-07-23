-- ============================================================================
-- SECURITY FIX — enable Row-Level Security on all tables.
-- Run in the Supabase SQL editor. Run STEP 1 first, look at it, then STEP 2.
--
-- Why this is safe: every server endpoint now uses the SERVICE key, which
-- bypasses RLS. Turning RLS on blocks the PUBLIC (anon) key — the one embedded
-- in the website source — from reading or writing your tables directly. That
-- public key could previously read brands (password hashes), bookings, staff
-- contacts, and compliance records. This closes that.
-- ============================================================================

-- STEP 1 — DIAGNOSTIC (read-only). See which tables are currently unprotected.
-- Run this alone first. Any row with rowsecurity = false is exposed.
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity, tablename;


-- STEP 2 — THE FIX. Run after you've looked at Step 1.
-- Enables RLS on every table in the public schema. Idempotent; safe to re-run.
-- With RLS on and no policy, the public key gets nothing; the service key still
-- works, so the app is unaffected.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.tablename);
  END LOOP;
END $$;


-- STEP 3 — The one exception. The retailer admin page reads a few non-sensitive
-- retailer fields with the public key (name, logo, policies). Allow exactly those
-- columns and nothing else. Sensitive columns (stripe_account_id, demo_fee, the
-- keeps-all flag) stay hidden from the public key.
DROP POLICY IF EXISTS retailers_anon_read ON public.retailers;
CREATE POLICY retailers_anon_read ON public.retailers
  FOR SELECT TO anon USING (true);

REVOKE SELECT ON public.retailers FROM anon;
GRANT  SELECT (id, slug, name, logo_url, monthly_summary_enabled, demo_policy, cancellation_policy)
  ON public.retailers TO anon;


-- STEP 4 — VERIFY (read-only). Every row should now show rls_enabled = true.
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity, tablename;
