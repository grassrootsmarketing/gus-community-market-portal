-- 0086_signup_budgets.sql
-- ============================================================================
-- Atomic hourly budgets for the public retailer sign-up (Codex RA-1, 2026-09-30).
--
-- The previous limiter in api/retailer-signup.js read a counter, compared, then wrote it back. Under
-- concurrency every request in a parallel batch reads the same value and all pass (Codex reproduced
-- 20 of 20 admitted at cap 5). A public abuse control that fails exactly when it is attacked is not a
-- control, so the counter moves into one statement the database serialises.
--
-- signup_budgets: one row per (bucket, hour window). signup_budget_take() is the ONLY writer: an
-- INSERT ... ON CONFLICT DO UPDATE whose UPDATE is conditional on count < p_max. Postgres takes the
-- row lock inside that statement, so concurrent hits on one bucket queue behind each other and at most
-- p_max are ever admitted per bucket and window. Nothing else in the application touches the table.
--
-- Independent of 0085 (booking codes, still pending on production): different objects, no shared
-- dependency. The 0085 paste kit's ledger-head guard must be regenerated to expect 0086 once this is
-- applied first. Ordering note recorded in the handoff.
--
-- Retention: hourly windows are meaningless after a day. The function trims rows older than two days
-- on a small fraction of calls (the table is tiny; a full scan is cheap).
--
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.signup_budgets (
  bucket_key   text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_key, window_start)
);

ALTER TABLE public.signup_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.signup_budgets FROM PUBLIC, anon, authenticated;
-- No policies: only the service role (which bypasses RLS) and the function below can reach the table.

CREATE OR REPLACE FUNCTION public.signup_budget_take(p_bucket_key text, p_window_start timestamptz, p_max integer)
RETURNS TABLE (admitted boolean, count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_max IS NULL OR p_max < 1 THEN RAISE EXCEPTION 'signup_budget_take: p_max must be >= 1'; END IF;
  IF p_bucket_key IS NULL OR length(p_bucket_key) < 1 OR length(p_bucket_key) > 200 THEN RAISE EXCEPTION 'signup_budget_take: bad bucket key'; END IF;
  IF p_window_start IS NULL THEN RAISE EXCEPTION 'signup_budget_take: window required'; END IF;

  -- First hit inserts count = 1. Later hits increment only while under the cap. One statement, one row
  -- lock, so a parallel batch on the same bucket is admitted exactly up to p_max and no further.
  INSERT INTO public.signup_budgets AS b (bucket_key, window_start, count)
  VALUES (p_bucket_key, p_window_start, 1)
  ON CONFLICT (bucket_key, window_start) DO UPDATE
    SET count = b.count + 1, updated_at = now()
    WHERE b.count < p_max
  RETURNING b.count INTO v_count;

  IF v_count IS NULL THEN
    SELECT b.count INTO v_count FROM public.signup_budgets b WHERE b.bucket_key = p_bucket_key AND b.window_start = p_window_start;
    admitted := false; count := coalesce(v_count, p_max);
  ELSE
    admitted := true; count := v_count;
  END IF;
  RETURN NEXT;

  IF random() < 0.05 THEN
    DELETE FROM public.signup_budgets WHERE window_start < now() - interval '2 days';
  END IF;
  RETURN;
END $$;

REVOKE ALL ON FUNCTION public.signup_budget_take(text, timestamptz, integer) FROM PUBLIC, anon, authenticated;

-- Postcondition: the objects exist with the intended shape.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.signup_budgets'::regclass AND contype = 'p') THEN
    RAISE EXCEPTION '0086 postcondition: signup_budgets has no primary key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'signup_budget_take' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION '0086 postcondition: signup_budget_take missing';
  END IF;
END $$;
