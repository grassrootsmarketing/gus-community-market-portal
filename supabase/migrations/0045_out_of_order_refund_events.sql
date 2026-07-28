-- 0045_out_of_order_refund_events.sql — Codex R12 scenario 3 (event ordering).
--
-- Stripe does NOT guarantee webhook ordering, so a late non-terminal event (pending /
-- requires_action) arriving AFTER a terminal outcome is completely normal traffic. 0041/0042
-- treated it as a terminal_contradiction and opened an operator reconciliation case, which would
-- bury real incidents under false alarms.
--
-- Correct semantics:
--   * late NON-terminal after terminal  -> benign no-op ('already_terminal'), no case
--   * same terminal repeated            -> no-op ('already_terminal'), no case
--   * CONTRADICTORY terminal (e.g. failed after succeeded) -> durable case, no balance change
BEGIN;

CREATE OR REPLACE FUNCTION _refund_terminal_gate(p_existing text, p_incoming text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  -- returns: 'noop' | 'contradiction'
  IF p_incoming IN ('pending','requires_action') THEN RETURN 'noop'; END IF;          -- late, out-of-order
  IF p_incoming = 'succeeded' AND p_existing = 'succeeded' THEN RETURN 'noop'; END IF;
  IF p_incoming IN ('failed','canceled') AND p_existing IN ('failed','failed_terminal','canceled') THEN RETURN 'noop'; END IF;
  RETURN 'contradiction';
END $$;

CREATE OR REPLACE FUNCTION apply_refund_event(
  p_refund_id text, p_status text, p_amount integer, p_currency text,
  p_pi text, p_charge text, p_meta_request_id uuid, p_event_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_alloc record; v_all boolean; v_case uuid; v_status text; v_found boolean := false; v_gate text;
BEGIN
  IF p_refund_id IS NULL OR p_amount IS NULL OR p_currency IS NULL OR p_pi IS NULL OR p_charge IS NULL THEN
    v_case := _open_case('payment_contradiction','refund-missing-fields:'||coalesce(p_refund_id,p_event_id,'unknown'),
                         'refund_event_missing_required_fields', NULL, NULL, NULL, NULL, p_pi, p_charge, p_refund_id,
                         p_amount, p_currency, jsonb_build_object('event_id',p_event_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;
  v_status := lower(coalesce(p_status,''));
  IF v_status NOT IN ('succeeded','failed','canceled','pending','requires_action') THEN
    v_case := _open_case('payment_contradiction','refund-bad-status:'||p_refund_id, 'unrecognized_refund_status',
                         NULL, NULL, NULL, NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency,
                         jsonb_build_object('status',p_status));
    RETURN jsonb_build_object('outcome','contradiction','reason','unrecognized_status','case_id',v_case);
  END IF;

  IF p_meta_request_id IS NOT NULL THEN
    SELECT * INTO v_req FROM refund_requests WHERE id = p_meta_request_id FOR UPDATE; v_found := FOUND;
  END IF;
  IF NOT v_found THEN
    SELECT * INTO v_req FROM refund_requests WHERE stripe_refund_id = p_refund_id FOR UPDATE; v_found := FOUND;
  END IF;
  IF NOT v_found THEN RETURN jsonb_build_object('outcome','unmatched'); END IF;

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.stripe_charge_id AS charge_id, g.id AS gid
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.id = v_req.payment_allocation_id FOR UPDATE;

  IF v_alloc.pi IS NULL OR p_pi <> v_alloc.pi THEN
    v_case := _open_case('payment_contradiction','refund-pi:'||p_refund_id,'refund_pi_mismatch', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency,
                         jsonb_build_object('event_pi',p_pi,'group_pi',v_alloc.pi));
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','case_id',v_case);
  END IF;
  IF v_alloc.charge_id IS NULL OR p_charge <> v_alloc.charge_id THEN
    v_case := _open_case('payment_contradiction','refund-charge:'||p_refund_id,'refund_charge_mismatch', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency, NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','case_id',v_case);
  END IF;
  IF p_amount <> v_req.amount THEN
    v_case := _open_case('payment_contradiction','refund-amount:'||p_refund_id,'refund_amount_mismatch', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency,
                         jsonb_build_object('expected',v_req.amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','case_id',v_case);
  END IF;
  IF lower(p_currency) <> lower(v_req.currency) THEN
    v_case := _open_case('payment_contradiction','refund-currency:'||p_refund_id,'refund_currency_mismatch', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency, NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','case_id',v_case);
  END IF;
  IF v_req.stripe_refund_id IS NOT NULL AND v_req.stripe_refund_id <> p_refund_id THEN
    v_case := _open_case('payment_contradiction','refund-id-disagree:'||p_refund_id,'refund_id_disagreement', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency, NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','refund_id_disagreement','case_id',v_case);
  END IF;

  -- ---- terminal handling with correct out-of-order semantics ----
  IF v_req.status IN ('succeeded','failed_terminal','failed','canceled') THEN
    v_gate := _refund_terminal_gate(v_req.status, v_status);
    IF v_gate = 'noop' THEN RETURN jsonb_build_object('outcome','already_terminal'); END IF;
    v_case := _open_case('payment_contradiction','refund-terminal:'||p_refund_id,'terminal_contradiction', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency,
                         jsonb_build_object('was',v_req.status,'got',v_status));
    RETURN jsonb_build_object('outcome','contradiction','reason','terminal_contradiction','case_id',v_case);
  END IF;

  IF v_req.stripe_refund_id IS NULL THEN
    UPDATE refund_requests SET stripe_refund_id = p_refund_id WHERE id = v_req.id;
  END IF;

  IF v_status IN ('succeeded','failed','canceled') AND v_alloc.reserved_refund_amount < v_req.amount THEN
    v_case := _open_case('payment_contradiction','refund-underflow:'||p_refund_id,'reservation_underflow', v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, p_amount, p_currency,
                         jsonb_build_object('reserved',v_alloc.reserved_refund_amount,'needed',v_req.amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','reservation_underflow','case_id',v_case);
  END IF;

  IF v_status = 'succeeded' THEN
    UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount - v_req.amount,
                                   refunded_amount = refunded_amount + v_req.amount WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'succeeded', customer_refund_status = 'succeeded' WHERE id = v_req.id;
    UPDATE refund_operations SET status = 'succeeded' WHERE id = v_req.parent_operation_id;
    UPDATE bookings SET payment_status = CASE WHEN (v_alloc.refunded_amount + v_req.amount) >= v_alloc.customer_amount THEN 'refunded' ELSE 'partial_refund' END,
                        refund_id = p_refund_id, refunded_at = now() WHERE id = v_req.booking_id;
  ELSIF v_status IN ('failed','canceled') THEN
    UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount - v_req.amount WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'failed_terminal', customer_refund_status = v_status WHERE id = v_req.id;
    UPDATE refund_operations SET status = 'failed' WHERE id = v_req.parent_operation_id;
    v_case := _open_case('failed_refund','refund-failed:'||p_refund_id,'stripe_refund_'||v_status, v_alloc.gid, v_req.id, v_req.parent_operation_id,
                         NULL, p_pi, p_charge, p_refund_id, v_req.amount, v_req.currency, NULL);
    RETURN jsonb_build_object('outcome','failed','request_id',v_req.id,'case_id',v_case);
  ELSE
    UPDATE refund_requests SET status = CASE WHEN v_status = 'requires_action' THEN 'requires_action' ELSE 'pending' END,
                               customer_refund_status = v_status WHERE id = v_req.id;
    RETURN jsonb_build_object('outcome','pending_persisted','status',v_status);
  END IF;

  SELECT bool_and(refunded_amount >= customer_amount) INTO v_all FROM payment_allocations WHERE payment_group_id = v_alloc.gid;
  UPDATE payment_groups SET status = CASE WHEN v_all THEN 'refunded'
      WHEN EXISTS (SELECT 1 FROM payment_allocations WHERE payment_group_id = v_alloc.gid AND refunded_amount > 0) THEN 'partially_refunded'
      ELSE status END
    WHERE id = v_alloc.gid AND status IN ('paid','partially_refunded');
  RETURN jsonb_build_object('outcome','applied','request_id',v_req.id,'status',v_status);
END $$;

REVOKE ALL ON FUNCTION apply_refund_event(text,text,integer,text,text,text,uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_refund_event(text,text,integer,text,text,text,uuid,text) TO service_role;

COMMIT;
