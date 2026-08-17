-- 0065_provisional_holds_ledger.sql — provisional holds (24h escrow) ledger machinery.
-- feature/provisional-holds; gated at runtime by PROVISIONAL_HOLDS_ENABLED. Forward-only on top of
-- 0029–0046 + 0063. See docs/provisional-holds.md.
--
-- What this adds:
--   1. 'authorized' / 'auth_canceled' group states + 'authorized' / 'canceled' attempt states
--      (manual-capture authorization is a first-class ledger state, not a variant of 'paid').
--   2. checkout_claim_group accepts 'held' bookings (a provisional booking must be checkout-able).
--   3. apply_verified_authorization(): the auth-time twin of apply_verified_payment. Binds the
--      verified checkout.session.completed (payment_status='unpaid', PI requires_capture) to its
--      attempt/group, moves group -> 'authorized', bookings -> payment_status 'authorized', starts
--      the 24h clock (held_expires_at = now()+24h), and enqueues a 'held' fulfilment (hold email).
--   4. apply_verified_payment(): extended to apply a CAPTURE on an 'authorized' group (bookings
--      held/authorized flip to paid exactly like the immediate-charge path; the 'held' outbox row
--      is re-opened with the real target so demo+emails run).
--   5. apply_authorization_canceled(): converge a canceled authorization (expiry sweep, retailer
--      decline/cancel, or Stripe-side cancellation) — group -> 'auth_canceled', attempt ->
--      'canceled', still-held bookings -> p_target_status with the auth released ($0 charged).
--
-- Provisional groups are SINGLE-BOOKING by construction (api/checkout.js rejects multi-booking or
-- mixed held/normal carts when a held booking is present) because capture/cancel act on the whole
-- PaymentIntent — these RPCs still handle N bookings defensively.
BEGIN;

-- ============================================================ 1. widen status CHECKs
ALTER TABLE payment_groups DROP CONSTRAINT IF EXISTS payment_groups_status_check;
ALTER TABLE payment_groups ADD CONSTRAINT payment_groups_status_check
  CHECK (status IN ('pending','session_created','authorized','paid','partially_refunded','refunded','failed','frozen','auth_canceled'));

ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_status_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_status_check
  CHECK (status IN ('open','authorized','expired','paid','failed','canceled'));

-- ============================================================ 2. claim accepts 'held'
-- Identical to the 0035 rewrite except the payable-state line: a provisional booking enters
-- checkout as status='held' (still payment_status='unpaid').
CREATE OR REPLACE FUNCTION checkout_claim_group(
  p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[],
  p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer
) RETURNS TABLE(payment_group_id uuid, total_customer_amount integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[]; v_gid uuid; v_total int := 0; v_bid uuid; v_bk record; v_fee_row record;
  v_cust int; v_venue int; v_fee int; v_groups uuid[]; v_existing uuid; v_existing_set uuid[];
  v_owned int; v_g record;
BEGIN
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;
  IF NOT coalesce(p_platform_keeps_all,false) THEN RAISE EXCEPTION 'connected_not_in_pilot'; END IF;

  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  IF array_length(v_ids,1) <> array_length(p_booking_ids,1) THEN RAISE EXCEPTION 'duplicate_booking_input'; END IF;

  SELECT count(*) INTO v_owned FROM bookings b WHERE b.id = ANY(v_ids) AND b.brand_id = p_brand_id;
  IF v_owned <> array_length(v_ids,1) THEN RAISE EXCEPTION 'not_your_booking'; END IF;

  SELECT array_agg(DISTINCT a.payment_group_id) INTO v_groups FROM payment_allocations a WHERE a.booking_id = ANY(v_ids);
  IF v_groups IS NOT NULL THEN
    IF array_length(v_groups,1) = 1 THEN
      v_existing := v_groups[1];
      SELECT array_agg(pa.booking_id ORDER BY pa.booking_id) INTO v_existing_set
        FROM payment_allocations pa WHERE pa.payment_group_id = v_existing;
      SELECT g.* INTO v_g FROM payment_groups g WHERE g.id = v_existing;
      IF v_existing_set = v_ids
         AND v_g.status IN ('pending','session_created')
         AND v_g.brand_id = p_brand_id
         AND v_g.retailer_id = p_retailer_id
         AND v_g.platform_keeps_all = coalesce(p_platform_keeps_all,false)
         AND coalesce(v_g.connect_account_id,'') = coalesce(p_connect_account_id,'')
         AND lower(v_g.currency) = 'usd' THEN
        RETURN QUERY SELECT v_g.id, v_g.total_customer_amount, true; RETURN;
      END IF;
    END IF;
    RAISE EXCEPTION 'booking_in_another_group';
  END IF;

  INSERT INTO payment_groups(brand_id, retailer_id, total_customer_amount, platform_keeps_all, connect_account_id, status)
    VALUES (p_brand_id, p_retailer_id, 0, coalesce(p_platform_keeps_all,false), p_connect_account_id, 'pending')
    RETURNING id INTO v_gid;

  FOREACH v_bid IN ARRAY v_ids LOOP
    SELECT b.id, b.brand_id, b.retailer_id, b.venue_id, b.status, b.payment_status
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking % not found', v_bid; END IF;
    IF v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    -- 0065: 'held' (provisional, unverified-COI) bookings are payable — the auth is exactly what
    -- makes the hold real. Everything else keeps the 0035 rule.
    IF v_bk.status NOT IN ('pending_payment','held') OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;
    SELECT v.demo_fee INTO v_fee_row FROM venues v WHERE v.id = v_bk.venue_id;
    IF v_fee_row IS NULL OR v_fee_row.demo_fee IS NULL OR v_fee_row.demo_fee < 0 THEN RAISE EXCEPTION 'venue_missing_fee %', v_bid; END IF;
    v_venue := round(v_fee_row.demo_fee * 100)::int;
    v_fee   := CASE WHEN coalesce(p_platform_keeps_all,false) THEN 0 ELSE coalesce(p_platform_fee_cents,0) END;
    v_cust  := v_venue + v_fee;
    v_total := v_total + v_cust;
    INSERT INTO payment_allocations(payment_group_id, booking_id, customer_amount, venue_amount, platform_fee_amount)
      VALUES (v_gid, v_bid, v_cust, v_venue, v_fee);
  END LOOP;

  UPDATE payment_groups SET total_customer_amount = v_total WHERE id = v_gid;
  RETURN QUERY SELECT v_gid, v_total, false;
END $$;

-- ============================================================ 3. verified AUTHORIZATION apply
-- Twin of apply_verified_payment for the manual-capture auth moment. p_charge is nullable — the
-- uncaptured charge id is recorded when Stripe provides one but is not required to authorize.
CREATE OR REPLACE FUNCTION apply_verified_authorization(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session_required'; END IF;
  IF p_payment_intent IS NULL OR p_amount IS NULL OR p_currency IS NULL THEN
    v_case := _open_case('payment_contradiction','auth-missing:'||p_session_id,'missing_pi_amount_or_currency',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','missing_required_fields','case_id',v_case);
  END IF;

  SELECT * INTO v_att FROM payment_attempts WHERE stripe_checkout_session_id = p_session_id;
  IF NOT FOUND THEN
    v_case := _open_case('unknown_session','unknown-session:'||p_session_id,'authorized_session_not_bound_to_any_attempt',
                         NULL,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','unknown_session','session_id',p_session_id,'case_id',v_case);
  END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;

  IF p_amount <> v_grp.total_customer_amount THEN
    v_case := _open_case('payment_contradiction','auth-amount:'||p_session_id,'amount_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('expected',v_grp.total_customer_amount,'got',p_amount));
    RETURN jsonb_build_object('outcome','contradiction','reason','amount_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF lower(p_currency) <> lower(v_grp.currency) THEN
    v_case := _open_case('payment_contradiction','auth-currency:'||p_session_id,'currency_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','currency_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF NOT v_grp.platform_keeps_all THEN
    v_case := _open_case('payment_contradiction','auth-connected:'||p_session_id,'connected_auth_not_in_pilot',
                         v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','connected_not_in_pilot','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','auth-pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  -- idempotent replay: the auth (or anything after it) already applied with matching identity
  IF v_grp.status IN ('authorized','paid','partially_refunded','refunded','auth_canceled') THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'group_status',v_grp.status,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  IF v_grp.status NOT IN ('pending','session_created','failed') THEN
    v_case := _open_case('payment_contradiction','auth-status:'||p_session_id,'group_not_authorizable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_authorizable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_att.status <> 'open' THEN
    v_case := _open_case('payment_contradiction','auth-attempt:'||p_session_id,'attempt_not_open',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('attempt_status',v_att.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','attempt_not_open','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  SELECT count(*), coalesce(sum(customer_amount),0) INTO v_alloc_count, v_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
  IF v_alloc_count = 0 OR v_sum <> v_grp.total_customer_amount THEN
    UPDATE payment_groups SET status = 'frozen' WHERE id = v_grp.id;
    v_case := _open_case('frozen_payment','auth-sum:'||p_session_id,'allocation_sum_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'alloc_sum',v_sum,'group_total',v_grp.total_customer_amount));
    RETURN jsonb_build_object('outcome','frozen','reason','allocation_sum_mismatch','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  -- every booking must be a held, unpaid provisional — an auth landing on a normal cart is a
  -- contradiction (checkout only sets capture_method=manual for held bookings)
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id AND b.payment_status = 'unpaid' AND b.status = 'held';
  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen',
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent),
           stripe_charge_id = coalesce(stripe_charge_id, p_charge) WHERE id = v_grp.id;
    UPDATE payment_attempts SET status = 'failed', last_error = 'group_frozen_auth_on_non_held_bookings' WHERE id = v_att.id;
    v_case := _open_case('frozen_payment','auth-frozen:'||p_session_id,'authorized_but_not_all_bookings_held',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('alloc_count',v_alloc_count,'flippable',v_flippable));
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0,'case_id',v_case);
  END IF;

  UPDATE payment_groups SET status = 'authorized',
      stripe_checkout_session_id = coalesce(stripe_checkout_session_id, p_session_id),
      stripe_payment_intent_id  = coalesce(stripe_payment_intent_id,  p_payment_intent),
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'authorized', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent)
    WHERE id = v_att.id;
  -- the 24h clock (re)starts at AUTH time — held_expires_at set at booking creation was only
  -- covering the never-checked-out case. payment_status 'authorized' = funds held, $0 charged.
  UPDATE bookings b SET payment_status = 'authorized', payment_intent_id = p_payment_intent,
      held_expires_at = now() + interval '24 hours'
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  -- durable 'held' fulfilment: sends the hold-placed email (no demo). Re-uses the outbox so a
  -- crash between auth-apply and email can never lose the notification.
  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, 'held', 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO NOTHING;

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status','held');
END $$;

REVOKE ALL ON FUNCTION apply_verified_authorization(text,text,text,integer,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_verified_authorization(text,text,text,integer,text) TO service_role;

-- ============================================================ 4. capture-aware payment apply
-- 0046 body + three provisional deltas, each tagged [0065]:
--   (a) group 'authorized' is payable (capture completes it);
--   (b) held/authorized bookings are flippable alongside pending_payment/unpaid;
--   (c) attempt 'authorized' is as apply-able as 'open';
--   (d) a pre-existing 'held' outbox row is RE-OPENED with the real target so demo+emails run.
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
  -- [0065] charge-mismatch guard unchanged, but note an authorized group may already carry the
  -- UNCAPTURED charge id from auth time; capture re-delivers the same charge id, so equality holds.
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'group_status',v_grp.status,'booking_ids',to_jsonb(v_ids));
  END IF;
  IF v_grp.status = 'frozen' THEN
    RETURN jsonb_build_object('outcome','frozen','payment_group_id',v_grp.id,'applied_count',0);
  END IF;
  -- [0065] (a) 'authorized' joins the payable set: capture is the second half of a manual-capture payment
  IF v_grp.status NOT IN ('pending','session_created','failed','authorized') THEN
    v_case := _open_case('payment_contradiction','status:'||p_session_id,'group_not_payable',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('status',v_grp.status));
    RETURN jsonb_build_object('outcome','contradiction','reason','group_not_payable','status',v_grp.status,'payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] (c) an 'authorized' attempt is the expected pre-capture state
  IF v_att.status NOT IN ('open','authorized') THEN
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

  -- [0065] (b) flippable = normal unpaid checkout OR a held authorization being captured
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id
      AND ((b.payment_status = 'unpaid' AND b.status = 'pending_payment')
        OR (b.payment_status = 'authorized' AND b.status = 'held'));
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

  -- [0065] (d) a captured hold re-opens its 'held' outbox row with the real target (demo+emails);
  -- finished non-held rows keep their DO NOTHING replay-idempotency.
  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END, 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO UPDATE
      SET target_status = EXCLUDED.target_status, status = 'pending',
          demo_created = false, emails_sent = false, completed_at = NULL, last_error = NULL
      WHERE booking_fulfillments.target_status = 'held';

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status', CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END);
END $$;

REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;

-- ============================================================ 5. canceled-authorization converge
-- Called synchronously after our own PI cancel (sweep expiry / retailer decline / cancel / bump)
-- and replayed by the payment_intent.canceled webhook. Only a still-'held' booking takes
-- p_target_status — a booking the retailer already moved (declined/cancelled) keeps its status.
CREATE OR REPLACE FUNCTION apply_authorization_canceled(
  p_payment_intent text, p_target_status text DEFAULT 'expired', p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_ids uuid[]; v_case uuid;
BEGIN
  IF p_payment_intent IS NULL THEN RAISE EXCEPTION 'payment_intent_required'; END IF;
  IF p_target_status NOT IN ('expired','declined','cancelled') THEN RAISE EXCEPTION 'invalid_target_status %', p_target_status; END IF;

  SELECT * INTO v_att FROM payment_attempts
    WHERE stripe_payment_intent_id = p_payment_intent ORDER BY created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','unknown_pi','payment_intent',p_payment_intent);
  END IF;
  SELECT * INTO v_grp FROM payment_groups WHERE id = v_att.payment_group_id FOR UPDATE;
  SELECT * INTO v_att FROM payment_attempts WHERE id = v_att.id FOR UPDATE;

  IF v_grp.status = 'auth_canceled' THEN
    SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
    RETURN jsonb_build_object('outcome','idempotent','payment_group_id',v_grp.id,'booking_ids',to_jsonb(v_ids));
  END IF;
  -- a canceled PI on a paid/refunded group would mean Stripe canceled a captured payment — impossible
  -- by API contract; record it rather than trusting either side.
  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    v_case := _open_case('payment_contradiction','cancel-after-capture:'||p_payment_intent,'auth_canceled_on_paid_group',
                         v_grp.id,NULL,NULL,v_att.stripe_checkout_session_id,p_payment_intent,NULL,NULL,NULL,NULL,
                         jsonb_build_object('status',v_grp.status,'reason',p_reason));
    RETURN jsonb_build_object('outcome','contradiction','reason','auth_canceled_on_paid_group','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  IF v_grp.status <> 'authorized' THEN
    -- PI canceled before the auth ever applied (or a frozen group): terminalize the attempt only.
    UPDATE payment_attempts SET status = 'canceled', last_error = coalesce(p_reason,'pi_canceled_pre_auth') WHERE id = v_att.id AND status IN ('open','authorized');
    RETURN jsonb_build_object('outcome','attempt_canceled','payment_group_id',v_grp.id,'group_status',v_grp.status);
  END IF;

  UPDATE payment_groups SET status = 'auth_canceled' WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'canceled', last_error = coalesce(p_reason, last_error) WHERE id = v_att.id;
  -- release: authorized -> unpaid, and ONLY a still-held booking takes the target status
  UPDATE bookings b SET payment_status = 'unpaid',
      status = CASE WHEN b.status = 'held' THEN p_target_status ELSE b.status END
    FROM payment_allocations a
    WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id AND b.payment_status = 'authorized';

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'booking_ids',to_jsonb(v_ids),'target_status',p_target_status);
END $$;

REVOKE ALL ON FUNCTION apply_authorization_canceled(text,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_authorization_canceled(text,text,text) TO service_role;

COMMIT;
