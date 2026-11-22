-- 0125_attempt_request_snapshot.sql (2026-11-22)
-- ============================================================================
-- Codex brand-walk review and work order of 2026-11-21, item 4: the provider request of a payment attempt is frozen.
-- Forward-only. 0120 and 0123 are not rewritten.
--
-- The defect. A reserved attempt creates its Checkout Session under the key co-<group>-<attempt>. Stripe API v1 keeps
-- the first request for a key and refuses a later request with the same key and different parameters. The handler
-- rebuilt the request on every call from live data: the store and venue names, the brand name, and since 96b323c a
-- description that names the two parts of the amount. The canonical request HASH (0036) covers the money only, so a
-- changed description passed the ledger and then failed at the provider: if the session had been created and the bind
-- then failed, a retry after a deploy, a venue rename or a brand rename could never reach that session again.
--
-- The fix. The complete request body is stored on the attempt when it is RESERVED, before the first provider call,
-- and is write-once. reserve_payment_attempt hands the stored body back for a live attempt and the handler sends
-- exactly that. Recovery therefore reproduces the original request whatever has been renamed or redeployed since.
-- provider_request_version says which builder made it (2 = the first stored version).
--
-- Reservations made before this file have no stored request (NULL). The handler recovers those by replaying the two
-- request shapes that were ever deployed for them; if neither is the original, it refuses another payable attempt
-- (attempt_needs_review) and the unpaid sweep (0123) settles the reservation with the provider within its deadline.
-- Nothing here assumes that such a reservation has no session.
--
-- The three-argument form is dropped so PostgREST sees one candidate; the new fourth argument defaults to NULL, so a
-- caller that still sends three named arguments resolves to this function and behaves as before.
-- ============================================================================

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_request text;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS provider_request_version integer;

-- write-once: a stored request is never replaced or cleared
CREATE OR REPLACE FUNCTION payment_attempts_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provider_request IS NOT NULL THEN
    NEW.provider_request := OLD.provider_request;
    NEW.provider_request_version := OLD.provider_request_version;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_payment_attempts_request_immutable ON payment_attempts;
CREATE TRIGGER trg_payment_attempts_request_immutable BEFORE UPDATE OF provider_request, provider_request_version ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_request_immutable();

DROP FUNCTION IF EXISTS reserve_payment_attempt(uuid, text, integer);

CREATE OR REPLACE FUNCTION reserve_payment_attempt(p_group_id uuid, p_hash text, p_schema integer, p_request text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gstatus text; v_total int; v_sum int; v_live record; v_id uuid; v_gen int; v_started timestamptz;
BEGIN
  IF p_group_id IS NULL OR p_hash IS NULL OR btrim(p_hash) = '' THEN RAISE EXCEPTION 'group_and_hash_required'; END IF;
  SELECT status, total_customer_amount, unpaid_expiry_started_at INTO v_gstatus, v_total, v_started FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;
  -- 0123: once expiry has begun for this group, no attempt is created and no existing attempt is handed back
  IF v_started IS NOT NULL THEN RAISE EXCEPTION 'unpaid_expired group'; END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
             WHERE a.payment_group_id = p_group_id AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= now()) THEN
    RAISE EXCEPTION 'unpaid_expired group';
  END IF;
  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    -- the immutable request snapshot of the live attempt must be the one the caller computed; a different snapshot
    -- (the store's routing changed after the claim) is refused, never silently forked
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    -- 0125: the request this attempt was FIRST created with is handed back; the caller sends that, never a rebuilt one.
    -- NULL means a reservation made before 0125, whose original request the ledger never held.
    RETURN jsonb_build_object('outcome', v_live.status, 'attempt_id', v_live.id, 'generation', v_live.generation,
                              'session_id', v_live.stripe_checkout_session_id, 'existing', true,
                              'request', v_live.provider_request, 'request_version', v_live.provider_request_version);
  END IF;

  SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
  INSERT INTO payment_attempts(payment_group_id, canonical_request_hash, request_schema_version, status, generation, reserved_at, provider_request, provider_request_version)
    VALUES (p_group_id, p_hash, coalesce(p_schema,1), 'reserved', v_gen, now(), nullif(p_request, ''), CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END)
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'reserved', 'attempt_id', v_id, 'generation', v_gen, 'session_id', NULL, 'existing', false,
                            'request', nullif(p_request, ''), 'request_version', CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END);
END $$;

REVOKE ALL ON FUNCTION reserve_payment_attempt(uuid,text,integer,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION payment_attempts_request_immutable() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt(uuid,text,integer,text) TO service_role;

DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_attempts' AND column_name IN ('provider_request','provider_request_version');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_attempts request snapshot columns: % (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='reserve_payment_attempt';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: reserve_payment_attempt has % overloads (expected 1)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='reserve_payment_attempt';
  IF position('provider_request' in v_def) = 0 OR position('unpaid_expired' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 OR position('group_sum_mismatch' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: reserve_payment_attempt lacks the snapshot or lost an earlier refusal';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname='payment_attempts' AND t.tgname='trg_payment_attempts_request_immutable' AND NOT t.tgisinternal;
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: request immutability trigger missing'; END IF;
  IF has_function_privilege('anon', 'reserve_payment_attempt(uuid,text,integer,text)', 'EXECUTE') OR has_function_privilege('authenticated', 'reserve_payment_attempt(uuid,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute reserve_payment_attempt';
  END IF;
  RAISE NOTICE '0125: post-conditions passed';
END $$;
