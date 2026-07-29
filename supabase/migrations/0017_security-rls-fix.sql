
-- [R1 clean-build] removed interactive verification query — a bare SELECT is a runbook step,
-- not a migration statement, and it aborts an automated chain.
-- SELECT tablename, rowsecurity AS rls_enabled FROM pg_tables WHERE schemaname = 'public' ORDER BY rowsecurity, tablename ...;


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
-- P1-3: three columns only. find-retailer.js's anonymous path needs id (health ping),
-- slug (lookup) and name (existence response). logo_url / policies / summary flag are
-- returned by fixed server routes and do not require direct anon table access.
GRANT  SELECT (id, slug, name) ON public.retailers TO anon;
-- [R1 clean-build] removed interactive verification query — a bare SELECT is a runbook step,
-- not a migration statement, and it aborts an automated chain.
-- SELECT tablename, rowsecurity AS rls_enabled FROM pg_tables WHERE schemaname = 'public' ORDER BY rowsecurity, tablename ...;
