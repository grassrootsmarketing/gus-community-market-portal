-- 0124_new_store_defaults.sql (2026-11-22)
-- ============================================================================
-- Codex brand-walk review and work order of 2026-11-21, item 5: new store defaults inside the provisioning transaction.
-- Forward-only. 0068 is not rewritten.
--
-- provision_verified_retailer (0068) created a store with a $30 fee, 60 days' notice and, through the column default,
-- a 48-hour cancellation sentence that contradicts the 72-hour refund rule (0104). api/retailer-signup.js corrected
-- the three values with two best-effort PATCHes AFTER the transaction had committed, so a failure left a store with
-- the old values and a retried sign-up (already = true) never repaired it. The values now come from the function
-- itself: a store either exists with all of them or does not exist. The post-commit patch is removed from the route in
-- the same change.
--
-- The $20 is only the example a new store starts from: the fee is the store's choice and $0 is allowed. A new location
-- takes its fee from what the owner enters in Add Location, which is pre-filled from settings.demo_fee.
--
-- Existing stores are not touched: no UPDATE of retailers or settings appears in this file. The column default for
-- retailers.cancellation_policy changes for FUTURE inserts only.
-- ============================================================================

ALTER TABLE public.retailers ALTER COLUMN cancellation_policy
  SET DEFAULT 'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.';

CREATE OR REPLACE FUNCTION public.provision_verified_retailer(
  p_email text,
  p_store_name text,
  p_phone text DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_store_count integer DEFAULT NULL
)
RETURNS TABLE(retailer_id uuid, slug text, session_id uuid, already boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_base  text;
  v_slug  text;
  v_rid   uuid;
  v_sid   uuid;
  v_try   int := 0;
  v_ex_id uuid;
  v_ex_slug text;
  -- clamp the store count to the same 1..999 range the signup stepper allows
  v_count int := CASE
                   WHEN p_store_count IS NULL THEN NULL
                   WHEN p_store_count < 1   THEN 1
                   WHEN p_store_count > 999 THEN 999
                   ELSE p_store_count
                 END;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN RAISE EXCEPTION 'email required'; END IF;

  -- Idempotency: this email already owns a retailer -> return it (no session minted here)
  SELECT r.id, r.slug INTO v_ex_id, v_ex_slug
  FROM retailers r WHERE lower(btrim(r.billing_email)) = v_email LIMIT 1;
  IF FOUND THEN
    retailer_id := v_ex_id; slug := v_ex_slug; session_id := NULL; already := true; RETURN NEXT; RETURN;
  END IF;

  -- Unique slug
  v_base := regexp_replace(lower(coalesce(nullif(btrim(p_store_name), ''), split_part(v_email, '@', 1))), '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  IF v_base = '' THEN v_base := 'store'; END IF;
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM retailers WHERE retailers.slug = v_slug) AND v_try < 50 LOOP
    v_try := v_try + 1;
    v_slug := v_base || '-' || (floor(random() * 900) + 100)::int;
  END LOOP;

  -- 0124: the refund setting and the sentence brands read are written together, in this transaction
  INSERT INTO retailers (slug, name, billing_tier, billing_email, phone, expected_locations, cancellation_mode, cancellation_policy)
    VALUES (v_slug, coalesce(nullif(btrim(p_store_name), ''), v_slug), 'solo', v_email,
            nullif(btrim(coalesce(p_phone, '')), ''), v_count, 'refundable',
            'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.')
    RETURNING id INTO v_rid;
  INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days)
    VALUES (v_rid, 20, 180, 14);   -- 0124: $20 example fee (the store's to change, $0 allowed), 14 days' notice
  -- owner membership (canonical source of authority) — now carries the owner's name
  INSERT INTO retailer_admins (retailer_id, email, email_normalized, role, name)
    VALUES (v_rid, v_email, v_email, 'admin', nullif(btrim(coalesce(p_contact_name, '')), ''));
  v_sid := gen_random_uuid();
  INSERT INTO admin_sessions (session_id, retailer_id, email, expires_at)
    VALUES (v_sid, v_rid, v_email, now() + interval '30 days');

  retailer_id := v_rid; slug := v_slug; session_id := v_sid; already := false; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.provision_verified_retailer(text, text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_verified_retailer(text, text, text, text, integer) TO service_role;

DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'provision_verified_retailer';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: provision_verified_retailer has % overloads (expected 1)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'provision_verified_retailer';
  IF position('VALUES (v_rid, 20, 180, 14)' in v_def) = 0 OR position('at least 72 hours' in v_def) = 0 OR position('already := true' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: provision_verified_retailer does not carry the new defaults or lost its idempotent return';
  END IF;
  SELECT column_default INTO v_def FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'retailers' AND column_name = 'cancellation_policy';
  IF v_def IS NULL OR position('at least 72 hours' in v_def) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: retailers.cancellation_policy default is not the 72-hour sentence'; END IF;
  IF has_function_privilege('anon', 'public.provision_verified_retailer(text, text, text, text, integer)', 'EXECUTE') THEN RAISE EXCEPTION 'POST-CONDITION FAILED: anon can execute provision_verified_retailer'; END IF;
  RAISE NOTICE '0124: post-conditions passed';
END $$;
