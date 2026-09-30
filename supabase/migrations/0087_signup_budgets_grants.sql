-- 0087_signup_budgets_grants.sql
-- ============================================================================
-- Explicit privileges for the sign-up budget objects (Codex RA acceptance, item 1, 2026-09-30).
--
-- 0086 created signup_budgets and signup_budget_take() and REVOKED them from PUBLIC / anon / authenticated, but it
-- relied on the project's default privileges for the service role's EXECUTE. Default privileges are a property of
-- the database the migration happens to run in, not of the migration, so the production project's effective
-- permissions were not proven. This migration states them and asserts them:
--   * service_role CAN execute signup_budget_take (the only caller: api/retailer-signup.js and the owner resend
--     action, both through the service key);
--   * anon and authenticated CANNOT execute it and CANNOT read or write signup_budgets;
--   * RLS is enabled on signup_budgets and its composite primary key exists.
-- 0086 is left untouched (applied on production 2026-09-30; applied migrations are never edited).
--
-- Idempotent.
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.signup_budget_take(text, timestamptz, integer) TO service_role;
REVOKE ALL ON FUNCTION public.signup_budget_take(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.signup_budgets FROM PUBLIC, anon, authenticated;
ALTER TABLE public.signup_budgets ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE fn text := 'public.signup_budget_take(text, timestamptz, integer)';
BEGIN
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN RAISE EXCEPTION '0087 postcondition: service_role cannot execute signup_budget_take'; END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') THEN RAISE EXCEPTION '0087 postcondition: anon can execute signup_budget_take'; END IF;
  IF has_function_privilege('authenticated', fn, 'EXECUTE') THEN RAISE EXCEPTION '0087 postcondition: authenticated can execute signup_budget_take'; END IF;
  IF has_table_privilege('anon', 'public.signup_budgets', 'SELECT, INSERT, UPDATE, DELETE') THEN RAISE EXCEPTION '0087 postcondition: anon has table privileges on signup_budgets'; END IF;
  IF has_table_privilege('authenticated', 'public.signup_budgets', 'SELECT, INSERT, UPDATE, DELETE') THEN RAISE EXCEPTION '0087 postcondition: authenticated has table privileges on signup_budgets'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signup_budgets'::regclass) THEN RAISE EXCEPTION '0087 postcondition: RLS is not enabled on signup_budgets'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.signup_budgets'::regclass AND contype = 'p' AND array_length(conkey, 1) = 2) THEN RAISE EXCEPTION '0087 postcondition: signup_budgets composite primary key missing'; END IF;
END $$;
