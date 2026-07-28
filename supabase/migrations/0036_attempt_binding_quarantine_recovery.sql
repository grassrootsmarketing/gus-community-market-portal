-- 0036_attempt_binding_quarantine_recovery.sql — Codex Round 11: P0-2, P0-3, P0-4.
-- Forward-only (never edits 0029–0035).
--
--   R11-P0-2  payment_attempts becomes AUTHORITATIVE for Session binding, so an expired Session no
--             longer locks the cart: expiry closes only the attempt and leaves the unpaid group
--             eligible for a brand-new Session/attempt (unique attempt id -> unique idempotency key).
--   R11-P0-3  every non-applied PAID outcome opens a durable reconciliation case (returns case_id)
--             so the webhook can only complete the Stripe event after quarantine exists.
--   R11-P0-4  atomic park-for-review (request + parent operation + deduped case, reservation kept)
--             and an authorization-gated replacement path.
BEGIN;

-- ---------------------------------------------------------------- P0-3 plumbing
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE reconciliation_cases ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_cases_dedupe_uidx ON reconciliation_cases(dedupe_key) WHERE dedupe_key IS NOT NULL;
-- allow the unknown-session kind
DO $$ BEGIN ALTER TABLE reconciliation_cases DROP CONSTRAINT IF EXISTS reconciliation_cases_kind_check; EXCEPTION WHEN undefined_object THEN NULL; END $$;
ALTER TABLE reconciliation_cases ADD CONSTRAINT reconciliation_cases_kind_check
  CHECK (kind IN ('frozen_payment','failed_refund','settlement_exception','unmatched_refund',
                  'payment_contradiction','expiry_conflict','unknown_session','refund_requires_review'));

-- helper: open-or-return a deduped case, always returning its id
CREATE OR REPLACE FUNCTION _open_case(
  p_kind text, p_dedupe text, p_reason text, p_group uuid, p_request uuid, p_operation uuid,
  p_session text, p_pi text, p_charge text, p_refund text, p_amount integer, p_currency text, p_details jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM reconciliation_cases WHERE dedupe_key = p_dedupe;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  INSERT INTO reconciliation_cases(kind, dedupe_key, reason, payment_group_id, refund_request_id, refund_operation_id,
      stripe_checkout_session_id, stripe_payment_intent_id, stripe_charge_id, stripe_refund_id, amount, currency, details)
    VALUES (p_kind, p_dedupe, p_reason, p_group, p_request, p_operation, p_session, p_pi, p_charge, p_refund, p_amount, p_currency, p_details)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM reconciliation_cases WHERE dedupe_key = p_dedupe; END IF;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- P0-2: attempt-authoritative binding
-- Resolve the group THROUGH payment_attempts (not payment_groups.stripe_checkout_session_id), so any
-- number of sequential attempts can exist for one group. Also returns case_id on every non-applied
-- permanent outcome (P0-3).
CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  -- a paid card Session must carry both ids and exact money fields (P0-3 #5/#6)
  IF p_payment_intent IS NULL OR p_charge IS NULL OR p_amount IS NULL OR p_currency IS NULL THEN
    v_case := _open_case('payment_contradiction','pi-missing:'||p_session_id,'missing_pi_charge_amount_or_currency',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;

  -- bind through the ATTEMPT (authoritative), then lock the group (lock order: group, then attempt)
  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id;
  IF NOT FOUND THEN
    v_case := _open_case('unknown_session','unknown-session:'||p_session_id,'paid_session_not_bound_to_any_attempt',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','unknown_session','session_id',p_session_id,'case_id',v_case);
  END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;

  IF p_amount <> v_grp.total_customer_amount THEN
    v_case := _open_case('payment_contradiction','amount:'||p_session_id,'amount_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('expected',v_grp.total_customer_amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF lower(p_currency) <> lower(v_grp.currency) THEN
    v_case := _open_case('payment_contradiction','currency:'||p_session_id,'currency_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  -- keeps-all pilot: NO Connect field may be present (P0-3 #9)
  IF v_grp.platform_keeps_all THEN
    IF p_connect_dest IS NOT NULL OR p_on_behalf_of IS NOT NULL OR p_application_fee IS NOT NULL
       OR p_transfer_id IS NOT NULL OR p_fee_id IS NOT NULL THEN
      v_case := _open_case('payment_contradiction','connect-on-keepsall:'||p_session_id,'unexpected_connect_fields_on_keeps_all',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                           jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'fee',p_application_fee,'transfer',p_transfer_id,'fee_id',p_fee_id));
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_fields','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  ELSE
    v_case := _open_case('payment_contradiction','connected-not-in-pilot:'||p_session_id,'connected_payment_not_in_pilot',
                         v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','connected_not_in_pilot','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  -- write-once identity
  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.status = 'paid' THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  IF v_grp.status NOT IN ('pending','session_created','failed') THEN
    v_case := _open_case('payment_contradiction','status:'||p_session_id,'group_not_payable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- the paying attempt itself must still be live
  IF v_att.status NOT IN ('open') THEN
    v_case := _open_case('payment_contradiction','attempt-not-open:'||p_session_id,'attempt_not_open',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('attempt_status',v_att.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','attempt_not_open','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  -- allocation invariants (P0-3 #8)
  SELECT count(*), coalesce(sum(customer_amount),0) INTO v_alloc_count, v_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
  IF v_alloc_count = 0 OR v_sum <> v_grp.total_customer_amount THEN
    UPDATE payment_groups SET status = 'frozen' WHERE id = v_grp.id;
    v_case := _open_case('frozen_payment','sum:'||p_session_id,'allocation_sum_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'alloc_sum',v_sum,'group_total',v_grp.total_customer_amount));
    RETURN jsonb_build_object('outcome','frozen','reason','allocation_sum_mismatch','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id AND b.payment_status = 'unpaid' AND b.status = 'pending_payment';
  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen',
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
           stripe_charge_id = coalesce(stripe_charge_id, p_charge) WHERE id = v_grp.id;
    UPDATE payment_attempts SET status = 'failed', last_error = 'group_frozen_incomplete_apply' WHERE id = v_att.id;
    v_case := _open_case('frozen_payment','frozen:'||p_session_id,'captured_but_not_all_bookings_applyable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'flippable',v_flippable));
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  UPDATE payment_groups SET status = 'paid',
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE id = v_att.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,'booking_ids',to_jsonb(v_ids));
END $$;

-- P0-2: expiry closes ONLY the attempt; an unpaid group returns to 'pending' so a new Session can bind.
CREATE OR REPLACE FUNCTION expire_payment_attempt(p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_other int;
BEGIN
  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_attempt'); END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;
  IF v_att.status <> 'open' THEN RETURN jsonb_build_object('outcome','not_open','status',v_att.status); END IF;

  IF v_grp.status = 'paid' THEN
    UPDATE payment_attempts SET status = 'expired', expired_at = now(), last_error = 'superseded_by_paid' WHERE id = v_att.id;
    RETURN jsonb_build_object('outcome','superseded_group_paid');
  END IF;

  UPDATE payment_attempts SET status = 'expired', expired_at = now() WHERE id = v_att.id;
  SELECT count(*) INTO v_other FROM payment_attempts WHERE payment_group_id = v_grp.id AND status = 'open';
  IF v_other = 0 AND v_grp.status IN ('pending','session_created') THEN
    -- release the group's session binding so a FRESH attempt can be created (P0-2)
    UPDATE payment_groups SET status = 'pending' WHERE id = v_grp.id;
    RETURN jsonb_build_object('outcome','attempt_expired_group_reopened','payment_group_id',v_grp.id);
  END IF;
  RETURN jsonb_build_object('outcome','attempt_expired','payment_group_id',v_grp.id);
END $$;

-- P0-2: a new attempt may bind even when the group already has an older (expired) session id.
CREATE OR REPLACE FUNCTION register_payment_attempt(
  p_group_id uuid, p_session_id text, p_payment_intent text, p_hash text, p_schema integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_open record; v_id uuid; v_gstatus text; v_sum int; v_total int;
BEGIN
  SELECT status, total_customer_amount INTO v_gstatus, v_total FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;

  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_open FROM payment_attempts WHERE payment_group_id = p_group_id AND status = 'open' FOR UPDATE;
  IF FOUND THEN
    IF v_open.stripe_checkout_session_id IS DISTINCT FROM p_session_id OR v_open.canonical_request_hash IS DISTINCT FROM p_hash THEN
      RAISE EXCEPTION 'attempt_in_progress';
    END IF;
    RETURN v_open.id;
  END IF;

  INSERT INTO payment_attempts(payment_group_id, stripe_checkout_session_id, stripe_payment_intent_id, canonical_request_hash, request_schema_version, status)
    VALUES (p_group_id, p_session_id, p_payment_intent, p_hash, coalesce(p_schema,1), 'open')
    RETURNING id INTO v_id;
  -- mirror the LATEST session on the group for display; attempts remain authoritative for binding
  UPDATE payment_groups SET status = 'session_created' WHERE id = p_group_id;
  UPDATE payment_groups SET stripe_checkout_session_id = p_session_id
    WHERE id = p_group_id AND stripe_checkout_session_id IS NULL;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- P0-4: park for review (atomic)
CREATE OR REPLACE FUNCTION park_refund_for_review(p_request_id uuid, p_owner text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_case uuid;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_request'); END IF;
  -- reservation is intentionally PRESERVED: Stripe may still hold an unadopted refund
  UPDATE refund_requests SET status = 'requires_review', lease_owner = NULL, lease_expires_at = NULL,
         last_error = coalesce(p_reason, last_error) WHERE id = p_request_id;
  IF v_req.parent_operation_id IS NOT NULL THEN
    UPDATE refund_operations SET status = 'requires_review' WHERE id = v_req.parent_operation_id;
  END IF;
  v_case := _open_case('refund_requires_review','park:'||p_request_id::text,coalesce(p_reason,'retry_cap_exhausted'),
                       NULL, p_request_id, v_req.parent_operation_id, NULL, NULL, NULL, v_req.stripe_refund_id,
                       v_req.amount, v_req.currency, jsonb_build_object('attempts',v_req.attempts,'owner',p_owner));
  RETURN jsonb_build_object('outcome','parked','case_id',v_case,'refund_request_id',p_request_id);
END $$;

-- P0-4: replacement is allowed for a failed OR requires_review operation, and never while another
-- live (non-terminal) request exists for that operation.
CREATE OR REPLACE FUNCTION create_refund_replacement(p_op_key text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_op record; v_alloc record; v_ver int; v_remaining int; v_rid uuid; v_key text; v_keeps boolean; v_fee int; v_live int;
BEGIN
  SELECT * INTO v_op FROM refund_operations WHERE op_key = p_op_key FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_operation'); END IF;
  IF v_op.status NOT IN ('failed','requires_review') THEN RETURN jsonb_build_object('outcome','not_replaceable','status',v_op.status); END IF;

  SELECT count(*) INTO v_live FROM refund_requests
    WHERE parent_operation_id = v_op.id AND status IN ('reserved','submitted','pending','requires_action','failed_retryable');
  IF v_live > 0 THEN RETURN jsonb_build_object('outcome','live_request_exists','live',v_live); END IF;

  SELECT a.*, g.stripe_payment_intent_id AS pi, g.platform_keeps_all AS keeps, g.connect_account_id AS connect, g.currency AS gcur
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.id = v_op.payment_allocation_id FOR UPDATE;
  v_keeps := v_alloc.keeps;
  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF v_remaining <= 0 THEN RETURN jsonb_build_object('outcome','nothing_refundable'); END IF;
  v_fee := round(v_alloc.platform_fee_amount::numeric * v_remaining / v_alloc.customer_amount)::int;

  SELECT coalesce(max(attempt_version),1) + 1 INTO v_ver FROM refund_requests WHERE parent_operation_id = v_op.id;
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + v_remaining WHERE id = v_alloc.id;
  UPDATE refund_operations SET status = 'open' WHERE id = v_op.id;

  v_rid := gen_random_uuid(); v_key := 'rf-' || v_rid::text;
  INSERT INTO refund_requests(
      id, parent_operation_id, attempt_version, payment_allocation_id, booking_id, amount, currency,
      actor, reason, op_key, status, stripe_idempotency_key, next_attempt_at,
      expected_customer_amount, expected_transfer_reversal_amount, expected_fee_refund_amount,
      customer_refund_status, settlement_status, canonical_request_hash, request_schema_version)
    VALUES (v_rid, v_op.id, v_ver, v_alloc.id, v_op.booking_id, v_remaining, v_alloc.gcur,
      p_actor, 'authorized_replacement', p_op_key, 'reserved', v_key, now(),
      v_remaining, CASE WHEN v_keeps THEN NULL ELSE v_remaining END, CASE WHEN v_keeps THEN NULL ELSE v_fee END,
      'pending', CASE WHEN v_keeps THEN 'not_required' ELSE 'pending' END,
      md5(coalesce(v_alloc.pi,'') || ':' || v_remaining || ':' || v_alloc.gcur || ':' || coalesce(v_alloc.connect,'keepsall')), 1);

  RETURN jsonb_build_object('outcome','replacement_created','refund_request_id',v_rid,'refund_operation_id',v_op.id,
    'attempt_version',v_ver,'idempotency_key',v_key,'payment_intent',v_alloc.pi,'keeps_all',v_keeps,'amount',v_remaining);
END $$;

REVOKE ALL ON FUNCTION _open_case(text,text,text,uuid,uuid,uuid,text,text,text,text,integer,text,jsonb) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION park_refund_for_review(uuid,text,text)                                    FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION expire_payment_attempt(text)                                              FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)                     FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION create_refund_replacement(text,text)                                      FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION park_refund_for_review(uuid,text,text)                                   TO service_role;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION expire_payment_attempt(text)                                             TO service_role;
GRANT EXECUTE ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)                    TO service_role;
GRANT EXECUTE ON FUNCTION create_refund_replacement(text,text)                                     TO service_role;

COMMIT;
