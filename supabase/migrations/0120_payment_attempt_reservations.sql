-- 0120_payment_attempt_reservations.sql
-- ============================================================================
-- Codex review of 7daf7ce (connected checkout round 7, 2026-10-31, "next action 2"): the expired-session retry.
-- Forward-only. 0119 is applied on demohub-rebuild-check and is not rewritten. Nothing here is on demohub-prod.
--
-- The defect. api/checkout.js created the Checkout Session BEFORE the ledger had said whether this group may have a
-- new attempt, under an idempotency key derived from the number of attempts the handler could read (falling back to
-- zero when that read failed). A retry while an attempt was open therefore created an unregistered session on Stripe
-- and was only then refused by register_payment_attempt; the next legitimate retry got that same session back from
-- Stripe's idempotent replay and registered it as open without checking whether it could still be paid. Once that
-- session had expired on its own, the brand was handed a dead link.
--
-- The fix. Session creation is based on a database-RESERVED attempt: reserve_payment_attempt, under the group row lock,
-- either hands back the live attempt that already exists (open: the handler then verifies the session's current state
-- on Stripe and reuses, expires or refuses it; reserved: the same reservation, so simultaneous retries share one key)
-- or inserts a new 'reserved' attempt carrying the immutable request hash and the next generation number. The handler
-- creates the session under a key that names that reservation (stable across retries, never random), verifies the
-- session Stripe returned is open and unpaid before anything is registered or returned, and binds it to the reservation
-- through register_payment_attempt. A session that is unusable (expired or complete on replay) or fails the amount
-- reconciliation is recorded as the reservation's TERMINAL outcome (fail_payment_attempt, with the session id and the
-- reason) and only then does the handler advance to a new generation. A failed read of the ledger fails the checkout
-- closed; nothing falls back to "sequence zero".
--
-- One live attempt per group (open or reserved) is enforced by a partial unique index, alongside the 0032 one-open
-- index. register_payment_attempt keeps its five-argument signature and its direct-registration behaviour for the
-- ledger tests and rehearsal fixtures that bind a session without a reservation; checkout.session.expired and
-- expire_payment_attempt are unchanged (a reservation has no session and nothing to expire).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 'reserved' attempts, a generation number, and one live attempt per group
-- ---------------------------------------------------------------------------
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN ('reserved','open','authorized','expired','paid','failed','canceled'));
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS generation integer;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS reserved_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS payment_attempts_one_live ON payment_attempts(payment_group_id) WHERE status IN ('open','reserved');

-- ---------------------------------------------------------------------------
-- 2. reserve_payment_attempt: the ledger decides, under the group lock, whether a session may be created and under which key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_payment_attempt(p_group_id uuid, p_hash text, p_schema integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gstatus text; v_total int; v_sum int; v_live record; v_id uuid; v_gen int;
BEGIN
  IF p_group_id IS NULL OR p_hash IS NULL OR btrim(p_hash) = '' THEN RAISE EXCEPTION 'group_and_hash_required'; END IF;
  SELECT status, total_customer_amount INTO v_gstatus, v_total FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;
  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    -- the immutable request snapshot of the live attempt must be the one the caller computed; a different snapshot
    -- (the store's routing changed after the claim) is refused, never silently forked
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    RETURN jsonb_build_object('outcome', v_live.status, 'attempt_id', v_live.id, 'generation', v_live.generation,
                              'session_id', v_live.stripe_checkout_session_id, 'existing', true);
  END IF;

  SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
  INSERT INTO payment_attempts(payment_group_id, canonical_request_hash, request_schema_version, status, generation, reserved_at)
    VALUES (p_group_id, p_hash, coalesce(p_schema,1), 'reserved', v_gen, now())
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'reserved', 'attempt_id', v_id, 'generation', v_gen, 'session_id', NULL, 'existing', false);
END $$;

-- ---------------------------------------------------------------------------
-- 3. fail_payment_attempt: the terminal outcome of a reservation whose session cannot be paid
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fail_payment_attempt(p_attempt_id uuid, p_session_id text, p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_other int;
BEGIN
  SELECT * INTO v_att FROM payment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_attempt'); END IF;
  IF v_att.status <> 'reserved' THEN RETURN jsonb_build_object('outcome','not_reserved','status',v_att.status); END IF;
  -- the session id is recorded when known (write-once, unique) so the provider object stays traceable; a session id
  -- another attempt already holds is not recorded twice
  IF p_session_id IS NOT NULL AND EXISTS (SELECT 1 FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id) THEN
    UPDATE payment_attempts SET status = 'failed', last_error = left(coalesce(p_error,'failed'), 200) WHERE id = p_attempt_id;
  ELSE
    UPDATE payment_attempts SET status = 'failed', stripe_checkout_session_id = p_session_id, last_error = left(coalesce(p_error,'failed'), 200) WHERE id = p_attempt_id;
  END IF;
  RETURN jsonb_build_object('outcome','failed','attempt_id',p_attempt_id,'generation',v_att.generation);
END $$;

-- ---------------------------------------------------------------------------
-- 4. register_payment_attempt: binds the reservation (or, for a caller without one, registers directly as before)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_payment_attempt(
  p_group_id uuid, p_session_id text, p_payment_intent text, p_hash text, p_schema integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_live record; v_id uuid; v_gstatus text; v_sum int; v_total int; v_gen int;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN RAISE EXCEPTION 'session_required'; END IF;
  SELECT status, total_customer_amount INTO v_gstatus, v_total FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;

  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    IF v_live.status = 'open' THEN
      -- an idempotent retry of the SAME session is reused; a different session against an open attempt is a fork
      IF v_live.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
      RETURN v_live.id;
    END IF;
    -- a reservation: bind the session to it (the session id is write-once; a second caller binding the same replayed
    -- session gets the same row back through the open branch above on its own call)
    UPDATE payment_attempts SET status = 'open', stripe_checkout_session_id = p_session_id,
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent)
      WHERE id = v_live.id;
    v_id := v_live.id;
  ELSE
    SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
    INSERT INTO payment_attempts(payment_group_id, stripe_checkout_session_id, stripe_payment_intent_id, canonical_request_hash, request_schema_version, status, generation)
      VALUES (p_group_id, p_session_id, p_payment_intent, p_hash, coalesce(p_schema,1), 'open', v_gen)
      RETURNING id INTO v_id;
  END IF;
  -- mirror the LATEST session on the group for display; attempts remain authoritative for binding
  UPDATE payment_groups SET status = 'session_created' WHERE id = p_group_id;
  UPDATE payment_groups SET stripe_checkout_session_id = p_session_id
    WHERE id = p_group_id AND stripe_checkout_session_id IS NULL;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION reserve_payment_attempt(uuid,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fail_payment_attempt(uuid,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION register_payment_attempt(uuid,text,text,text,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt(uuid,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION fail_payment_attempt(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION register_payment_attempt(uuid,text,text,text,integer) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname IN ('reserve_payment_attempt','fail_payment_attempt');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: reservation functions: % (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_attempts' AND column_name IN ('generation','reserved_at');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_attempts reservation columns: % (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_indexes WHERE schemaname='public' AND indexname='payment_attempts_one_live';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_attempts_one_live index missing'; END IF;
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname='payment_attempts' AND c.conname='payment_attempts_status_check';
  IF v_def IS NULL OR position('reserved' in v_def) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_attempts_status_check lacks reserved'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='register_payment_attempt';
  IF position('reserved' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: register_payment_attempt does not bind reservations or lost the fork refusal'; END IF;
  IF has_function_privilege('anon', 'reserve_payment_attempt(uuid,text,integer)', 'EXECUTE') OR has_function_privilege('authenticated', 'fail_payment_attempt(uuid,text,text)', 'EXECUTE') THEN RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute a service-only function'; END IF;
  RAISE NOTICE '0120: post-conditions passed';
END $$;
