-- 0043_staging_rls_parity.sql — close the Supabase "table publicly accessible" advisories.
--
-- WHY: on staging the public (anon/publishable) key could READ admin_sessions and
-- brand_account_sessions — i.e. live session tokens — plus email_verifications (login codes),
-- retailer_admins, brands, bookings and demos. On a production-shaped database that is account
-- takeover. Production already has RLS enabled with no policies (verified: anon reads return zero
-- rows); this brings staging to the SAME posture so security testing measures the real system.
--
-- Model: every table below is service-role-only. RLS ENABLED + NO POLICIES => anon/authenticated
-- get nothing, while the server's service_role key (which bypasses RLS) keeps working. No app code
-- change is needed because all reads/writes already go through server endpoints.
--
-- Safe to run on production too: it only *removes* public access. Verify each table is not read
-- directly by browser code before applying there (Demohub's pages call /api/*, not PostgREST).
BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- auth/session material — the critical ones
    'admin_sessions','brand_account_sessions','admin_tokens','email_verifications','retailer_admins',
    -- tenant + customer data
    'bookings','brands','demos',
    -- operational
    'processed_stripe_events'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
      RAISE NOTICE 'secured: %', t;
    ELSE
      RAISE NOTICE 'skipped (absent): %', t;
    END IF;
  END LOOP;
END $$;

-- retailers/venues stay publicly READABLE on purpose: the public booking page lists stores, venues
-- and prices. Keep them read-only for the public key — never writable.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['retailers','venues'] LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM anon, authenticated', t);
      RAISE NOTICE 'public-read, write-revoked: %', t;
    END IF;
  END LOOP;
END $$;

COMMIT;
