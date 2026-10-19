-- 0096_retailer_demo_move_finalizer_invariants.sql
-- ============================================================================
-- Codex closure response on the retailer demo moves (C1, C2, C4; 2026-10-16). 0094 and 0095 are applied
-- to the test project and are left byte-for-byte; every correction is forward, here.
--
-- C1  A settlement may complete ONLY with its financial handoff persisted. finalize_move_settlement now
--     refuses (no side effect) unless: the booking has actually reached an inactive state; the refund
--     status is one of the known words; a submitted / succeeded / pending_worker status names a
--     refund_requests row for THIS booking; a review_required status names a reconciliation_cases row
--     whose dedupe_key is 'move_refund:<move id>' (the transition-error case is a different case and
--     is kept in a different column); not_paid and already_refunded are checked against the booking's
--     payment state and the ledger. booking_moves.refund_case_id records the refund handoff case;
--     reconciliation_case_id keeps recording the settlement-error case.
-- C2  booking_moves.notice_case_id and notice_checked_at let the worker's notice scan make progress
--     (one examination per pending move per sweep, oldest first) and record the operator case it opened.
-- C4  The deadline is judged on the clock AFTER the locks are held (clock_timestamp()), not the
--     transaction start (now()), in respond_booking_move and lapse_booking_moves. A non-production
--     database honours p_event_payload->>'_inject_failure' in the finalizer AFTER the stamp and the event
--     insert, to prove in a test that the function's effects roll back as one transaction.
-- Forward-only. Idempotent. No row rewrites.
-- ============================================================================

ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS refund_case_id uuid;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS notice_case_id uuid;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS notice_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS booking_moves_notice_scan ON public.booking_moves (notice_checked_at NULLS FIRST, moved_at) WHERE status = 'pending' AND notice_case_id IS NULL;

-- ---------------------------------------------------------------------------------------------
-- finalize_move_settlement (C1 invariants; C4 rollback proof hook outside production).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb);
CREATE OR REPLACE FUNCTION public.finalize_move_settlement(
  p_move_id uuid, p_owner text, p_settled boolean, p_refund_status text DEFAULT NULL, p_refund_request_id uuid DEFAULT NULL,
  p_case_id uuid DEFAULT NULL, p_error text DEFAULT NULL, p_event_payload jsonb DEFAULT NULL, p_refund_case_id uuid DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, event_written boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE; v_b bookings%ROWTYPE; v_n integer := 0; v_now timestamptz; v_env text;
  v_req refund_requests%ROWTYPE; v_case reconciliation_cases%ROWTYPE; v_refundable integer;
BEGIN
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, false; RETURN; END IF;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id FOR UPDATE;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id FOR UPDATE;
  v_now := clock_timestamp();
  IF v_m.settle_lease_owner IS DISTINCT FROM p_owner THEN RETURN QUERY SELECT false, 'lease_lost'::text, false; RETURN; END IF;
  IF v_m.settled_at IS NOT NULL THEN RETURN QUERY SELECT false, 'already_settled'::text, false; RETURN; END IF;
  IF v_m.status NOT IN ('declined', 'lapsed') THEN RETURN QUERY SELECT false, ('move_' || v_m.status)::text, false; RETURN; END IF;

  IF NOT coalesce(p_settled, false) THEN
    UPDATE booking_moves
       SET settle_attempts = settle_attempts + 1, settle_last_error = left(coalesce(p_error, 'unknown'), 300),
           refund_request_id = coalesce(p_refund_request_id, refund_request_id),
           reconciliation_case_id = coalesce(p_case_id, reconciliation_case_id),
           refund_case_id = coalesce(p_refund_case_id, refund_case_id),
           refund_status = coalesce(p_refund_status, refund_status),
           settle_lease_owner = NULL, settle_lease_until = NULL, updated_at = v_now
     WHERE id = p_move_id;
    RETURN QUERY SELECT true, NULL::text, false; RETURN;
  END IF;

  -- C1: the invariants. Every refusal below leaves the row exactly as it was (the lease stays with the
  -- caller, which records the failure through the p_settled = false path).
  IF v_b.id IS NULL THEN RETURN QUERY SELECT false, 'booking_missing'::text, false; RETURN; END IF;
  IF coalesce(v_b.status, 'pending') NOT IN ('cancelled', 'declined', 'expired', 'auth_canceled') THEN
    RETURN QUERY SELECT false, 'booking_still_active'::text, false; RETURN;
  END IF;
  IF p_refund_status IS NULL OR p_refund_status NOT IN ('not_paid', 'already_refunded', 'submitted', 'succeeded', 'pending_worker', 'review_required') THEN
    RETURN QUERY SELECT false, 'refund_status_unknown'::text, false; RETURN;
  END IF;
  IF p_refund_status IN ('submitted', 'succeeded', 'pending_worker') THEN
    IF p_refund_request_id IS NULL THEN RETURN QUERY SELECT false, 'request_required'::text, false; RETURN; END IF;
    SELECT * INTO v_req FROM refund_requests r WHERE r.id = p_refund_request_id;
    IF NOT FOUND OR v_req.booking_id IS DISTINCT FROM v_m.booking_id THEN RETURN QUERY SELECT false, 'request_invalid'::text, false; RETURN; END IF;
  ELSIF p_refund_status = 'review_required' THEN
    IF p_refund_case_id IS NULL THEN RETURN QUERY SELECT false, 'case_required'::text, false; RETURN; END IF;
    SELECT * INTO v_case FROM reconciliation_cases c WHERE c.id = p_refund_case_id;
    IF NOT FOUND OR v_case.dedupe_key IS DISTINCT FROM ('move_refund:' || p_move_id::text) THEN RETURN QUERY SELECT false, 'case_invalid'::text, false; RETURN; END IF;
  ELSIF p_refund_status = 'not_paid' THEN
    IF NOT (v_b.fee_waived IS TRUE OR (v_b.payment_intent_id IS NULL AND coalesce(v_b.payment_status, 'unpaid') NOT IN ('paid', 'refund_pending', 'authorized'))) THEN
      RETURN QUERY SELECT false, 'not_paid_inconsistent'::text, false; RETURN;
    END IF;
  ELSIF p_refund_status = 'already_refunded' THEN
    SELECT (a.customer_amount - a.refunded_amount - a.reserved_refund_amount) INTO v_refundable FROM payment_allocations a WHERE a.booking_id = v_m.booking_id LIMIT 1;
    IF NOT (coalesce(v_b.payment_status, '') = 'refunded' OR coalesce(v_refundable, 0) <= 0 AND v_refundable IS NOT NULL
            OR EXISTS (SELECT 1 FROM refund_requests r WHERE r.booking_id = v_m.booking_id AND r.status = 'succeeded')) THEN
      RETURN QUERY SELECT false, 'already_refunded_inconsistent'::text, false; RETURN;
    END IF;
  END IF;

  UPDATE booking_moves
     SET settled_at = v_now, refund_status = p_refund_status, refund_request_id = coalesce(p_refund_request_id, refund_request_id),
         reconciliation_case_id = coalesce(p_case_id, reconciliation_case_id), refund_case_id = coalesce(p_refund_case_id, refund_case_id),
         settle_last_error = NULL, settle_lease_owner = NULL, settle_lease_until = NULL, updated_at = v_now
   WHERE id = p_move_id;
  UPDATE bookings SET pending_move_settlement = NULL WHERE id = v_m.booking_id AND pending_move_settlement = p_move_id;
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_m.retailer_id, v_m.booking_id, coalesce(v_m.brand_id, v_b.brand_id), 'demo_move_cancelled', p_move_id::text || ':cancelled',
          (coalesce(p_event_payload, '{}'::jsonb) - '_inject_failure') || jsonb_build_object('move_id', p_move_id, 'outcome', v_m.status, 'refund_status', p_refund_status,
                                                                      'refund_request_id', coalesce(p_refund_request_id, v_m.refund_request_id),
                                                                      'refund_case_id', coalesce(p_refund_case_id, v_m.refund_case_id),
                                                                      'to_date', v_m.to_date, 'to_time', v_m.to_time, 'from_date', v_m.from_date, 'from_time', v_m.from_time, 'note', v_m.note))
  ON CONFLICT (kind, transition_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- C4 (test projects only): prove that a failure after the stamp and the event insert rolls everything back.
  IF coalesce(p_event_payload->>'_inject_failure', '') = 'true' THEN
    SELECT environment INTO v_env FROM get_deployment_identity();
    IF v_env IS DISTINCT FROM 'production' THEN RAISE EXCEPTION 'injected_failure_after_finalize' USING errcode = 'check_violation'; END IF;
  END IF;
  RETURN QUERY SELECT true, NULL::text, v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- respond_booking_move (0095 body; C4: the clock is read AFTER the locks).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_booking_move(p_move_id uuid, p_brand_id uuid, p_decision text, p_actor text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, booking_id uuid, retailer_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE;
  v_b bookings%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_decision NOT IN ('confirm', 'decline') THEN
    RETURN QUERY SELECT false, 'invalid_decision'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id FOR UPDATE;
  v_now := clock_timestamp();   -- C4: the moment the locks are held, not the transaction's start
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_m.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF v_m.status <> 'pending' THEN
    RETURN QUERY SELECT false, ('move_' || v_m.status)::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') THEN
    RETURN QUERY SELECT false, 'booking_not_active'::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF v_b.schedule_revision IS DISTINCT FROM v_m.schedule_revision THEN
    UPDATE booking_moves SET status = 'superseded', updated_at = v_now WHERE id = p_move_id;
    RETURN QUERY SELECT false, 'move_superseded'::text, v_m.booking_id, v_m.retailer_id, 'superseded'::text; RETURN;
  END IF;
  IF v_now >= v_m.reconfirm_due_at THEN
    UPDATE booking_moves SET status = 'lapsed', lapsed_at = v_now, responded_at = v_now, responded_by = p_actor, updated_at = v_now WHERE id = p_move_id;
    UPDATE bookings SET pending_move_settlement = p_move_id WHERE id = v_m.booking_id AND pending_move_settlement IS NULL;
    IF p_decision = 'confirm' THEN
      RETURN QUERY SELECT false, 'move_lapsed'::text, v_m.booking_id, v_m.retailer_id, 'lapsed'::text; RETURN;
    END IF;
    RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'lapsed'::text; RETURN;
  END IF;
  IF p_decision = 'confirm' THEN
    UPDATE booking_moves SET status = 'confirmed', responded_at = v_now, responded_by = p_actor, updated_at = v_now WHERE id = p_move_id;
    RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'confirmed'::text; RETURN;
  END IF;
  UPDATE booking_moves SET status = 'declined', responded_at = v_now, responded_by = p_actor, updated_at = v_now WHERE id = p_move_id;
  UPDATE bookings SET pending_move_settlement = p_move_id WHERE id = v_m.booking_id AND pending_move_settlement IS NULL;
  RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'declined'::text;
END $$;

-- ---------------------------------------------------------------------------------------------
-- lapse_booking_moves (0095 body; C4: the clock is read AFTER the locks, per row).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lapse_booking_moves(p_limit integer DEFAULT 25)
RETURNS SETOF public.booking_moves
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; v_b bookings%ROWTYPE; v_m booking_moves%ROWTYPE; v_now timestamptz;
BEGIN
  FOR r IN
    SELECT m.id, m.booking_id FROM booking_moves m
     WHERE m.status = 'pending' AND m.reconfirm_due_at <= clock_timestamp()
     ORDER BY m.reconfirm_due_at ASC
     LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    SELECT * INTO v_b FROM bookings b WHERE b.id = r.booking_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_m FROM booking_moves m WHERE m.id = r.id FOR UPDATE SKIP LOCKED;
    v_now := clock_timestamp();
    IF NOT FOUND OR v_m.status <> 'pending' OR v_m.reconfirm_due_at > v_now THEN CONTINUE; END IF;
    IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR v_b.schedule_revision IS DISTINCT FROM v_m.schedule_revision OR v_b.pending_move_settlement IS NOT NULL THEN
      UPDATE booking_moves SET status = 'superseded', updated_at = v_now WHERE id = v_m.id;
      CONTINUE;
    END IF;
    UPDATE booking_moves SET status = 'lapsed', lapsed_at = v_now, updated_at = v_now WHERE id = v_m.id RETURNING * INTO v_m;
    UPDATE bookings SET pending_move_settlement = v_m.id WHERE id = v_b.id;
    RETURN NEXT v_m;
  END LOOP;
  RETURN;
END $$;

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_moves' AND column_name = 'refund_case_id') THEN RAISE EXCEPTION '0096 postcondition: refund_case_id missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_moves' AND column_name = 'notice_case_id') THEN RAISE EXCEPTION '0096 postcondition: notice_case_id missing'; END IF;
  IF to_regprocedure('public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid)') IS NULL THEN RAISE EXCEPTION '0096 postcondition: finalize_move_settlement (9 args) missing'; END IF;
  IF to_regprocedure('public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb)') IS NOT NULL THEN RAISE EXCEPTION '0096 postcondition: the 0095 finalizer signature still exists'; END IF;
  SELECT pg_get_functiondef('public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid)'::regprocedure) INTO v_def;
  IF position('case_required' IN v_def) = 0 OR position('booking_still_active' IN v_def) = 0 OR position('request_invalid' IN v_def) = 0 THEN RAISE EXCEPTION '0096 postcondition: finalizer invariants missing'; END IF;
  SELECT pg_get_functiondef('public.respond_booking_move(uuid, uuid, text, text)'::regprocedure) INTO v_def;
  IF position('clock_timestamp()' IN v_def) = 0 THEN RAISE EXCEPTION '0096 postcondition: respond_booking_move does not read the clock after the lock'; END IF;
  SELECT pg_get_functiondef('public.lapse_booking_moves(integer)'::regprocedure) INTO v_def;
  IF position('clock_timestamp()' IN v_def) = 0 THEN RAISE EXCEPTION '0096 postcondition: lapse_booking_moves does not read the clock after the lock'; END IF;
END $$;
