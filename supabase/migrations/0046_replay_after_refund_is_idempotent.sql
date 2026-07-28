-- 0046_replay_after_refund_is_idempotent.sql — live-preview finding (Codex scenario 2).
--
-- Stripe can re-deliver checkout.session.completed at any time, including long after the payment
-- succeeded AND after some of the group has been refunded. 0038's apply_verified_payment only
-- treated status='paid' as an idempotent replay, so a re-delivery for a group now sitting at
-- 'partially_refunded' or 'refunded' fell through to "group_not_payable" and opened an operator
-- reconciliation case. That is a false alarm on entirely normal traffic — and false alarms are how
-- real incidents get missed.
--
-- Fix: a replay whose Session/PI/Charge identity matches a group that has ALREADY been paid (in any
-- post-payment state) is idempotent. Money is never re-applied; bookings are never re-promoted.
BEGIN;

CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid; v_auto boolean;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  IF p_payment_intent IS NULL OR p_charge IS NULL OR p_amount IS NULL OR p_currency IS NULL THEN
    v_case := _open_case('payment_contradiction','pi-missing:'||p_session_id,'missing_pi_charge_amount_or_currency',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;

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

  IF v_grp.platform_keeps_all THEN
    IF p_connect_dest IS NOT NULL OR p_on_behalf_of IS NOT NULL OR p_application_fee IS NOT NULL
       OR p_transfer_id IS NOT NULL OR p_fee_id IS NOT NULL THEN
      v_case := _open_case('payment_contradiction','connect-on-keepsall:'||p_session_id,'unexpected_connect_fields_on_keeps_all',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_fields','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  ELSE
    v_case := _open_case('payment_contradiction','connected-not-in-pilot:'||p_session_id,'connected_payment_not_in_pilot',
                         v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','connected_not_in_pilot','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  -- ---- idempotent replay: ANY already-paid state (incl. post-refund) with matching identity ----
  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'group_status',v_grp.status,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  IF v_grp.status NOT IN ('pending','session_created','failed') THEN
    v_case := _open_case('payment_contradiction','status:'||p_session_id,'group_not_payable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_att.status <> 'open' THEN
    v_case := _open_case('payment_contradiction','attempt-not-open:'||p_session_id,'attempt_not_open',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('attempt_status',v_att.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','attempt_not_open','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

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

  SELECT coalesce(r.auto_confirm_bookings,false) INTO v_auto FROM retailers r WHERE r.id = v_grp.retailer_id;

  UPDATE payment_groups SET status = 'paid',
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE id = v_att.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END, 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO NOTHING;

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status', CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END);
END $$;

REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;

COMMIT;
