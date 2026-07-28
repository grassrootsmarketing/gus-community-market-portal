-- 0044_operator_refund_review.sql — Codex Round 12 P0-4: operator review → adopt-or-replace.
--
-- Problem at cf9b9df: park_refund_for_review() deliberately KEEPS the reservation (correct — Stripe
-- may still hold an unadopted refund), but create_refund_replacement() computes "remaining" AFTER
-- subtracting that same reservation, so a parked request always returned nothing_refundable. There
-- was no way for a human to resolve a stuck refund, and no production route even called it.
--
-- This adds the two halves of a real review, each atomic and audited:
--   resolve_refund_adopt()   — operator found the refund in Stripe: attach + converge it.
--   resolve_refund_replace() — operator proved Stripe has NO such refund: release exactly the old
--                              reservation (with underflow assertion), mark the old request
--                              'superseded', mint version N+1 with a fresh idempotency key.
-- Both record operator identity + the Stripe lookup evidence, and resolve the reconciliation case.
BEGIN;

-- audit trail for every operator money decision
CREATE TABLE IF NOT EXISTS refund_review_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_operation_id uuid NOT NULL REFERENCES refund_operations(id) ON DELETE RESTRICT,
  refund_request_id uuid,
  action text NOT NULL CHECK (action IN ('adopt','replace')),
  operator_email text NOT NULL,
  retailer_id uuid,
  stripe_evidence jsonb,               -- what the operator saw when they looked Stripe up
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE refund_review_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON refund_review_actions FROM anon, authenticated;

-- allow the superseded terminal state
DO $$ BEGIN ALTER TABLE refund_requests DROP CONSTRAINT IF EXISTS refund_requests_status_check; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_status_check
  CHECK (status IN ('requires_review','reserved','submitted','pending','requires_action',
                    'failed_retryable','failed_terminal','succeeded','failed','canceled','superseded'));

-- ---------------------------------------------------------------- adopt
-- The operator located the refund in Stripe. Attach it and let the normal event path converge it.
CREATE OR REPLACE FUNCTION resolve_refund_adopt(
  p_op_key text, p_operator text, p_retailer_id uuid, p_refund_id text, p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op record; v_req record; v_alloc record;
BEGIN
  IF p_operator IS NULL OR p_refund_id IS NULL THEN RAISE EXCEPTION 'operator_and_refund_required'; END IF;
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_operation'); END IF;

  SELECT a.*, g.retailer_id AS rid INTO v_alloc
    FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
   WHERE a.id = v_op.payment_allocation_id;
  IF p_retailer_id IS NULL OR v_alloc.rid <> p_retailer_id THEN
    RETURN jsonb_build_object('outcome','forbidden','reason','operation_belongs_to_another_retailer');
  END IF;

  SELECT * INTO v_req FROM refund_requests
   WHERE parent_operation_id = v_op.id AND status NOT IN ('superseded','canceled')
   ORDER BY attempt_version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;

  IF v_req.stripe_refund_id IS NOT NULL AND v_req.stripe_refund_id <> p_refund_id THEN
    RETURN jsonb_build_object('outcome','conflict','reason','request_already_bound_to_other_refund');
  END IF;
  UPDATE refund_requests SET stripe_refund_id = p_refund_id,
         status = CASE WHEN status = 'requires_review' THEN 'submitted' ELSE status END,
         next_attempt_at = now()
   WHERE id = v_req.id;
  UPDATE refund_operations SET status = 'open' WHERE id = v_op.id AND status = 'requires_review';

  INSERT INTO refund_review_actions(refund_operation_id, refund_request_id, action, operator_email, retailer_id, stripe_evidence)
    VALUES (v_op.id, v_req.id, 'adopt', p_operator, p_retailer_id, p_evidence);
  UPDATE reconciliation_cases SET status = 'resolved', resolved_by = p_operator, resolved_at = now()
   WHERE refund_request_id = v_req.id AND status <> 'resolved';

  RETURN jsonb_build_object('outcome','adopted','refund_request_id',v_req.id,'stripe_refund_id',p_refund_id);
END $$;

-- ---------------------------------------------------------------- replace
-- The operator proved Stripe holds NO refund for this request. Release exactly the old reservation
-- and create version N+1. This is the ONLY path that may re-reserve money.
CREATE OR REPLACE FUNCTION resolve_refund_replace(
  p_op_key text, p_operator text, p_retailer_id uuid, p_evidence jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op record; v_old record; v_alloc record; v_ver int; v_rid uuid; v_key text; v_amount int; v_keeps boolean; v_fee int;
BEGIN
  IF p_operator IS NULL THEN RAISE EXCEPTION 'operator_required'; END IF;
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_operation'); END IF;
  IF v_op.status NOT IN ('failed','requires_review') THEN
    RETURN jsonb_build_object('outcome','not_replaceable','status',v_op.status);
  END IF;

  SELECT a.*, g.retailer_id AS rid, g.stripe_payment_intent_id AS pi, g.platform_keeps_all AS keeps,
         g.connect_account_id AS connect, g.currency AS gcur
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
   WHERE a.id = v_op.payment_allocation_id FOR UPDATE;
  IF p_retailer_id IS NULL OR v_alloc.rid <> p_retailer_id THEN
    RETURN jsonb_build_object('outcome','forbidden','reason','operation_belongs_to_another_retailer');
  END IF;
  v_keeps := v_alloc.keeps;

  -- the parked request whose reservation we are taking over
  SELECT * INTO v_old FROM refund_requests
   WHERE parent_operation_id = v_op.id AND status IN ('requires_review','failed_retryable','reserved','submitted','pending','requires_action')
   ORDER BY attempt_version DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_parked_request'); END IF;
  IF v_old.stripe_refund_id IS NOT NULL THEN
    RETURN jsonb_build_object('outcome','refused','reason','request_has_stripe_refund_adopt_instead','stripe_refund_id',v_old.stripe_refund_id);
  END IF;

  v_amount := v_old.amount;
  -- release EXACTLY the old reservation, asserting it is actually held (never clamp)
  IF v_alloc.reserved_refund_amount < v_amount THEN
    RETURN jsonb_build_object('outcome','contradiction','reason','reservation_underflow',
                              'reserved',v_alloc.reserved_refund_amount,'expected',v_amount);
  END IF;
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount - v_amount WHERE id = v_alloc.id;
  UPDATE refund_requests SET status = 'superseded', last_error = 'superseded_by_operator_replacement' WHERE id = v_old.id;

  -- re-reserve for the replacement
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + v_amount WHERE id = v_alloc.id;
  SELECT coalesce(max(attempt_version),1) + 1 INTO v_ver FROM refund_requests WHERE parent_operation_id = v_op.id;
  v_fee := round(v_alloc.platform_fee_amount::numeric * v_amount / v_alloc.customer_amount)::int;
  v_rid := gen_random_uuid(); v_key := 'rf-' || v_rid::text;

  INSERT INTO refund_requests(
      id, parent_operation_id, attempt_version, payment_allocation_id, booking_id, amount, currency,
      actor, reason, op_key, status, stripe_idempotency_key, next_attempt_at,
      expected_customer_amount, expected_transfer_reversal_amount, expected_fee_refund_amount,
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version)
    VALUES (v_rid, v_op.id, v_ver, v_alloc.id, v_op.booking_id, v_amount, v_alloc.gcur,
      p_operator, 'operator_authorized_replacement', p_op_key, 'reserved', v_key, now(),
      v_amount, CASE WHEN v_keeps THEN NULL ELSE v_amount END, CASE WHEN v_keeps THEN NULL ELSE v_fee END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_amount || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1);

  UPDATE refund_operations SET status = 'open' WHERE id = v_op.id;
  INSERT INTO refund_review_actions(refund_operation_id, refund_request_id, action, operator_email, retailer_id, stripe_evidence)
    VALUES (v_op.id, v_rid, 'replace', p_operator, p_retailer_id, p_evidence);
  UPDATE reconciliation_cases SET status = 'resolved', resolved_by = p_operator, resolved_at = now()
   WHERE refund_request_id = v_old.id AND status <> 'resolved';

  RETURN jsonb_build_object('outcome','replacement_created','refund_request_id',v_rid,
    'attempt_version',v_ver,'idempotency_key',v_key,'amount',v_amount,'superseded_request_id',v_old.id);
END $$;

REVOKE ALL ON FUNCTION resolve_refund_adopt(text,text,uuid,text,jsonb)   FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION resolve_refund_replace(text,text,uuid,jsonb)      FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_refund_adopt(text,text,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION resolve_refund_replace(text,text,uuid,jsonb)    TO service_role;

COMMIT;
