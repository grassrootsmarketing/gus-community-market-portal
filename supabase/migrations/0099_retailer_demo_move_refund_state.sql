-- 0099_retailer_demo_move_refund_state.sql
-- ============================================================================
-- Codex revision 2 review of the retailer demo moves, R2-1 (2026-10-17): reserved money is not completed
-- refund money. 0094 .. 0096 are applied to the test project and are left byte-for-byte; this is forward.
-- (0097 and 0098 belong to the brand booker branch, so this file takes 0099.)
--
-- finalize_move_settlement (re-declared, same signature as 0096) now requires the refund label to agree
-- with persisted accounting:
--   already_refunded  only when the allocation's completed refunds cover the customer amount
--                     (payment_allocations.refunded_amount >= customer_amount), or the booking is
--                     recorded 'refunded' by the verified ledger path; a reservation is never completed
--                     money, and one succeeded request does not prove the full entitlement;
--   succeeded         the named request's persisted status is 'succeeded';
--   submitted         the named request is 'submitted', 'pending' or 'requires_action' (with the provider);
--   pending_worker    the named request is 'reserved', 'failed_retryable', 'submitted', 'pending' or
--                     'requires_action' (owned by the refund worker);
--   a request in 'requires_review', 'failed_terminal', 'failed' or 'canceled' can only be represented as
--   review_required with the move_refund case (never as submitted / succeeded / pending_worker).
-- Every refusal writes nothing. The C4 rollback hook, the C1 case checks and the rest of the 0096 body
-- are unchanged.
-- Forward-only. Idempotent. No row rewrites.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.finalize_move_settlement(
  p_move_id uuid, p_owner text, p_settled boolean, p_refund_status text DEFAULT NULL, p_refund_request_id uuid DEFAULT NULL,
  p_case_id uuid DEFAULT NULL, p_error text DEFAULT NULL, p_event_payload jsonb DEFAULT NULL, p_refund_case_id uuid DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, event_written boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE; v_b bookings%ROWTYPE; v_n integer := 0; v_now timestamptz; v_env text;
  v_req refund_requests%ROWTYPE; v_case reconciliation_cases%ROWTYPE; v_alloc payment_allocations%ROWTYPE;
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
    -- R2-1: the label must agree with the request's persisted state.
    IF p_refund_status = 'succeeded' AND v_req.status <> 'succeeded' THEN RETURN QUERY SELECT false, 'request_state_mismatch'::text, false; RETURN; END IF;
    IF p_refund_status = 'submitted' AND v_req.status NOT IN ('submitted', 'pending', 'requires_action', 'succeeded') THEN RETURN QUERY SELECT false, 'request_state_mismatch'::text, false; RETURN; END IF;
    IF p_refund_status = 'pending_worker' AND v_req.status NOT IN ('reserved', 'failed_retryable', 'submitted', 'pending', 'requires_action', 'succeeded') THEN RETURN QUERY SELECT false, 'request_state_mismatch'::text, false; RETURN; END IF;
  ELSIF p_refund_status = 'review_required' THEN
    IF p_refund_case_id IS NULL THEN RETURN QUERY SELECT false, 'case_required'::text, false; RETURN; END IF;
    SELECT * INTO v_case FROM reconciliation_cases c WHERE c.id = p_refund_case_id;
    IF NOT FOUND OR v_case.dedupe_key IS DISTINCT FROM ('move_refund:' || p_move_id::text) THEN RETURN QUERY SELECT false, 'case_invalid'::text, false; RETURN; END IF;
  ELSIF p_refund_status = 'not_paid' THEN
    IF NOT (v_b.fee_waived IS TRUE OR (v_b.payment_intent_id IS NULL AND coalesce(v_b.payment_status, 'unpaid') NOT IN ('paid', 'refund_pending', 'authorized'))) THEN
      RETURN QUERY SELECT false, 'not_paid_inconsistent'::text, false; RETURN;
    END IF;
  ELSIF p_refund_status = 'already_refunded' THEN
    -- R2-1: completed money only. A reservation (reserved_refund_amount) is never completion; a succeeded
    -- request is not proof of the full entitlement; the allocation's refunded_amount is.
    SELECT * INTO v_alloc FROM payment_allocations a WHERE a.booking_id = v_m.booking_id ORDER BY a.created_at LIMIT 1;
    IF NOT (coalesce(v_b.payment_status, '') = 'refunded'
            OR (v_alloc.id IS NOT NULL AND v_alloc.refunded_amount >= v_alloc.customer_amount)) THEN
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
  IF coalesce(p_event_payload->>'_inject_failure', '') = 'true' THEN
    SELECT environment INTO v_env FROM get_deployment_identity();
    IF v_env IS DISTINCT FROM 'production' THEN RAISE EXCEPTION 'injected_failure_after_finalize' USING errcode = 'check_violation'; END IF;
  END IF;
  RETURN QUERY SELECT true, NULL::text, v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef('public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb, uuid)'::regprocedure) INTO v_def;
  IF position('request_state_mismatch' IN v_def) = 0 THEN RAISE EXCEPTION '0099 postcondition: request state check missing'; END IF;
  IF position('refunded_amount >= v_alloc.customer_amount' IN v_def) = 0 THEN RAISE EXCEPTION '0099 postcondition: completed-refund accounting check missing'; END IF;
  IF position('reserved_refund_amount) <= 0' IN v_def) > 0 THEN RAISE EXCEPTION '0099 postcondition: the 0096 reservation-as-completion clause is still present'; END IF;
  IF position('case_required' IN v_def) = 0 OR position('booking_still_active' IN v_def) = 0 THEN RAISE EXCEPTION '0099 postcondition: 0096 invariants lost'; END IF;
END $$;
