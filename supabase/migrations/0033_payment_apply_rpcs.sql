-- 0033_payment_apply_rpcs.sql — Codex reverify #10, Phase A + D(payment): verified payment
-- application + Checkout-attempt lifecycle. Builds on 0032. Never rewrites 0029–0031.
--
-- Fixes:
--   R10-P0-1  a frozen (incompletely-applicable) payment must change ZERO booking states and open
--             a reconciliation case — never promote unpaid bookings to confirmed.
--   R10-P0-2  payment is applied from the VERIFIED Checkout Session binding (+ full field checks:
--             session, amount, currency, PI, charge, connect destination, on_behalf_of, app fee),
--             attaching every Stripe id write-once and applying all bookings in ONE transaction —
--             not a metadata-only REST PATCH followed by a separate RPC.
--   R10-P1-1  Session expiry is atomic and NEVER deletes allocations (payment_attempts instead).
--   R10-P1-4  a failed payment attempt records the error but keeps the group payable until the
--             exact Session expires or Stripe reports a terminal condition.
BEGIN;

-- ------------------------------------------------------------------------------------
-- register_payment_attempt: one live Checkout attempt per group (idempotent on re-post).
-- The canonical_request_hash is computed by the handler from the immutable snapshot, so a
-- retry with byte-equivalent params reuses the same open attempt instead of forking one.
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION register_payment_attempt(
  p_group_id uuid, p_session_id text, p_payment_intent text, p_hash text, p_schema integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_open record; v_id uuid; v_gstatus text;
BEGIN
  SELECT status INTO v_gstatus FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;

  SELECT * INTO v_open FROM payment_attempts WHERE payment_group_id = p_group_id AND status = 'open' FOR UPDATE;
  IF FOUND THEN
    -- idempotent reuse only when the retry reproduces the SAME session + canonical request
    IF v_open.stripe_checkout_session_id IS DISTINCT FROM p_session_id OR v_open.canonical_request_hash IS DISTINCT FROM p_hash THEN
      RAISE EXCEPTION 'attempt_in_progress';
    END IF;
    RETURN v_open.id;
  END IF;

  INSERT INTO payment_attempts(payment_group_id, stripe_checkout_session_id, stripe_payment_intent_id, canonical_request_hash, request_schema_version, status)
    VALUES (p_group_id, p_session_id, p_payment_intent, p_hash, coalesce(p_schema,1), 'open')
    RETURNING id INTO v_id;
  UPDATE payment_groups SET stripe_checkout_session_id = p_session_id, status = 'session_created'
    WHERE id = p_group_id AND stripe_checkout_session_id IS NULL;
  RETURN v_id;
END $$;

-- ------------------------------------------------------------------------------------
-- apply_verified_payment: THE payment fulfilment RPC. Bind by stored Session, validate every
-- money-routing field against the immutable snapshot, then atomically apply-all or freeze.
-- Returns jsonb: {outcome: applied|idempotent|frozen|unknown_session|contradiction, ...}
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_grp record; v_alloc_count int; v_flippable int; v_fee_sum int; v_ids uuid[];
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  IF p_amount IS NULL OR p_currency IS NULL THEN RAISE EXCEPTION 'amount_currency_required'; END IF;

  SELECT * INTO v_grp FROM payment_groups WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','unknown_session','session_id',p_session_id);   -- caller quarantines
  END IF;

  -- amount / currency must match the immutable group snapshot
  IF p_amount <> v_grp.total_customer_amount THEN
    INSERT INTO reconciliation_cases(kind, payment_group_id, stripe_payment_intent_id, stripe_charge_id, amount, currency, reason, details)
      VALUES ('payment_contradiction', v_grp.id, p_payment_intent, p_charge, p_amount, p_currency, 'amount_mismatch',
              jsonb_build_object('expected',v_grp.total_customer_amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','payment_group_id',v_grp.id);
  END IF;
  IF lower(p_currency) <> lower(v_grp.currency) THEN
    INSERT INTO reconciliation_cases(kind, payment_group_id, stripe_payment_intent_id, reason, details)
      VALUES ('payment_contradiction', v_grp.id, p_payment_intent, 'currency_mismatch', jsonb_build_object('expected',v_grp.currency,'got',p_currency));
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','payment_group_id',v_grp.id);
  END IF;

  -- charge-model / Connect routing must match the snapshot
  IF v_grp.platform_keeps_all THEN
    IF p_connect_dest IS NOT NULL THEN
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_destination','payment_group_id',v_grp.id);
    END IF;
  ELSE
    SELECT coalesce(sum(platform_fee_amount),0) INTO v_fee_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
    IF coalesce(p_connect_dest,'') <> coalesce(v_grp.connect_account_id,'')
       OR coalesce(p_on_behalf_of,'') <> coalesce(v_grp.connect_account_id,'')
       OR coalesce(p_application_fee,-1) <> v_fee_sum THEN
      INSERT INTO reconciliation_cases(kind, payment_group_id, stripe_payment_intent_id, stripe_charge_id, reason, details)
        VALUES ('payment_contradiction', v_grp.id, p_payment_intent, p_charge, 'connect_routing_mismatch',
                jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'app_fee',p_application_fee,'expected_dest',v_grp.connect_account_id,'expected_fee',v_fee_sum));
      RETURN jsonb_build_object('outcome','contradiction','reason','connect_routing_mismatch','payment_group_id',v_grp.id);
    END IF;
  END IF;

  -- write-once identity: reject a DIFFERENT non-null PI/charge overwriting stored ids
  IF v_grp.stripe_payment_intent_id IS NOT NULL AND p_payment_intent IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id);
  END IF;
  IF v_grp.stripe_charge_id IS NOT NULL AND p_charge IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id);
  END IF;

  -- idempotent replay of an already-paid group (fields already validated above)
  IF v_grp.status = 'paid' THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);   -- stays frozen
  END IF;
  IF v_grp.status NOT IN ('pending','session_created') THEN
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id);
  END IF;

  -- all-or-none: every allocation's booking must be applyable, or we freeze the WHOLE group
  SELECT count(*) INTO v_alloc_count FROM payment_allocations WHERE payment_group_id = v_grp.id;
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id AND b.payment_status = 'unpaid' AND b.status = 'pending_payment';

  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen',
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
           stripe_charge_id = coalesce(stripe_charge_id, p_charge)
      WHERE id = v_grp.id;
    UPDATE payment_attempts SET status = 'failed', last_error = 'group_frozen_incomplete_apply'
      WHERE payment_group_id = v_grp.id AND stripe_checkout_session_id = p_session_id AND status = 'open';
    INSERT INTO reconciliation_cases(kind, payment_group_id, stripe_payment_intent_id, stripe_charge_id, amount, currency, reason, details)
      VALUES ('frozen_payment', v_grp.id, p_payment_intent, p_charge, p_amount, p_currency, 'captured_but_not_all_bookings_applyable',
              jsonb_build_object('alloc_count',v_alloc_count,'flippable',v_flippable));
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;

  -- APPLY: attach Stripe identity (write-once), flip all bookings, close the attempt, mark group paid
  UPDATE payment_groups SET
      status = 'paid',
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge),
      stripe_transfer_id        = coalesce(stripe_transfer_id,        p_transfer_id),
      stripe_application_fee_id = coalesce(stripe_application_fee_id, p_fee_id)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE payment_group_id = v_grp.id AND stripe_checkout_session_id = p_session_id AND status = 'open';
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,'booking_ids',to_jsonb(v_ids));
END $$;

-- ------------------------------------------------------------------------------------
-- expire_payment_attempt: atomic Session expiry. Marks the attempt expired and, only if no other
-- open attempt exists and the group is still unpaid, marks the group failed. NEVER deletes
-- allocations (financial history is retained; a fresh attempt can be created later).
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_payment_attempt(p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_other int;
BEGIN
  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_attempt'); END IF;
  IF v_att.status <> 'open' THEN RETURN jsonb_build_object('outcome','not_open','status',v_att.status); END IF;

  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  -- if the group already paid (payment won the race), just close the attempt as superseded
  IF v_grp.status = 'paid' THEN
    UPDATE payment_attempts SET status = 'expired', expired_at = now(), last_error = 'superseded_by_paid' WHERE id = v_att.id;
    RETURN jsonb_build_object('outcome','superseded_group_paid');
  END IF;

  UPDATE payment_attempts SET status = 'expired', expired_at = now() WHERE id = v_att.id;
  SELECT count(*) INTO v_other FROM payment_attempts WHERE payment_group_id = v_grp.id AND status = 'open';
  IF v_other = 0 AND v_grp.status IN ('pending','session_created') THEN
    UPDATE payment_groups SET status = 'failed' WHERE id = v_grp.id;
    RETURN jsonb_build_object('outcome','group_failed','payment_group_id',v_grp.id);
  END IF;
  RETURN jsonb_build_object('outcome','attempt_expired','payment_group_id',v_grp.id);
END $$;

-- ------------------------------------------------------------------------------------
-- record_payment_attempt_failure: a failed PaymentIntent attempt logs the error but does NOT
-- terminalize an otherwise-payable group (Checkout may still be open for a retry).
-- ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_payment_attempt_failure(p_session_id text, p_err text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record;
BEGIN
  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_attempt'); END IF;
  UPDATE payment_attempts SET last_error = left(coalesce(p_err,'payment_failed'),300) WHERE id = v_att.id;
  RETURN jsonb_build_object('outcome','recorded');
END $$;

-- ---------- privileges: service_role only ----------
REVOKE ALL ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)              FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION expire_payment_attempt(text)                                       FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION record_payment_attempt_failure(text,text)                          FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)             TO service_role;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION expire_payment_attempt(text)                                      TO service_role;
GRANT EXECUTE ON FUNCTION record_payment_attempt_failure(text,text)                         TO service_role;

COMMIT;
