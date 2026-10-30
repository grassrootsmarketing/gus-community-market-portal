-- 0118_held_promotion_claim_mode.sql
-- ============================================================================
-- Codex review of a14c621 (connected checkout round 4, 2026-10-30): R3-1, R3-2 and small correction 1. Forward-only,
-- functions only; no table, column or row changes. Replaces nothing deployed to production (0116 and 0117 are not on
-- demohub-prod either; this file simply follows them in the chain).
--
--   R3-1  The held-booking route forward in api/checkout.js (round 3) moved a held booking to pending_payment by booking
--         id with the service credential before checkout_claim_group had checked ownership. That move now lives in
--         promote_held_bookings(): it locks every requested booking in id order, refuses the WHOLE set unless the exact
--         set exists, every booking belongs to the authenticated brand, a booker owns every booking it names and all
--         are at one store, and only then promotes the bookings the caller's coverage policy marked as covered. It
--         returns the fresh rows, which the handler uses instead of what it read first.
--   R3-2  Promotion and the claim serialize on the same row locks, and eligibility (held, unpaid, no PaymentIntent, not
--         expired, no allocation) is re-read under the lock, so a claim, a sweep, a cancel or an authorization that
--         commits first is seen and nothing is promoted over it. checkout_claim_group gains p_provisional: the handler's
--         capture-mode decision is asserted under the locks against the bookings' current state (capture_mode_stale),
--         a manual authorization is refused for a connected group (connected_hold_unsupported) and for more than one
--         booking (provisional_checkout_single_only). NULL keeps the 0116 behaviour for older callers.
--   SC-1  apply_verified_payment counts a charge with no application_fee_amount as a zero fee, which must equal the
--         allocations' zero fee sum; a non-zero fee sum against a missing fee is still a contradiction.
--
-- Nothing here changes the keeps-all pilot's money path: with no held booking in the cart the handler never calls
-- promote_held_bookings, and checkout_claim_group with p_provisional false behaves as 0116 for pending_payment bookings.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. promote_held_bookings: ownership of the whole set, then eligibility under the lock, then the move
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION promote_held_bookings(
  p_brand_id uuid, p_member_id uuid, p_role text, p_booking_ids uuid[], p_covered_booking_ids uuid[]
) RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ids uuid[]; v_cov uuid[]; v_bid uuid; v_bk record; v_n int; v_promoted uuid[] := '{}';
BEGIN
  IF p_brand_id IS NULL THEN RAISE EXCEPTION 'brand_required'; END IF;
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;
  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  v_cov := coalesce(p_covered_booking_ids, '{}'::uuid[]);
  IF EXISTS (SELECT 1 FROM unnest(v_cov) c WHERE NOT (c = ANY(v_ids))) THEN RAISE EXCEPTION 'covered_not_in_set'; END IF;

  -- Lock every requested booking in id order (the order checkout_claim_group takes its locks in), then authorize the
  -- WHOLE set before any write: exact set, every booking owned by the authenticated brand, a booker only its own
  -- bookings, one store. A set that fails any of these changes nothing.
  FOREACH v_bid IN ARRAY v_ids LOOP
    PERFORM 1 FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  END LOOP;
  SELECT count(*) INTO v_n FROM bookings b WHERE b.id = ANY(v_ids);
  IF v_n <> array_length(v_ids,1) THEN RAISE EXCEPTION 'booking_set_mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM bookings b WHERE b.id = ANY(v_ids) AND (b.brand_id IS NULL OR b.brand_id <> p_brand_id)) THEN RAISE EXCEPTION 'not_your_booking'; END IF;
  IF p_role = 'booker' THEN
    IF p_member_id IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.id = ANY(v_ids) AND (b.booked_by_member_id IS NULL OR b.booked_by_member_id <> p_member_id)) THEN
      RAISE EXCEPTION 'not_your_booking';
    END IF;
  END IF;
  SELECT count(DISTINCT b.retailer_id) INTO v_n FROM bookings b WHERE b.id = ANY(v_ids);
  IF v_n <> 1 THEN RAISE EXCEPTION 'mixed_retailers'; END IF;

  -- Eligibility, re-read under the lock, per booking the caller's coverage policy marked as covered: still held and
  -- unpaid, never authorized (no PaymentIntent), not expired, and in NO payment group (allocations are only ever
  -- inserted by checkout_claim_group while it holds this same row lock, so this read is authoritative).
  FOREACH v_bid IN ARRAY v_ids LOOP
    CONTINUE WHEN NOT (v_bid = ANY(v_cov));
    SELECT b.status, b.payment_status, b.payment_intent_id, b.held_expires_at INTO v_bk FROM bookings b WHERE b.id = v_bid;
    IF v_bk.status = 'held' AND v_bk.payment_status = 'unpaid' AND v_bk.payment_intent_id IS NULL
       AND (v_bk.held_expires_at IS NULL OR v_bk.held_expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.booking_id = v_bid) THEN
      UPDATE bookings SET status = 'pending_payment', held_expires_at = NULL
        WHERE bookings.id = v_bid AND bookings.status = 'held' AND bookings.payment_status = 'unpaid';
      v_promoted := v_promoted || v_bid;
    END IF;
  END LOOP;

  RETURN QUERY
    SELECT to_jsonb(b) || jsonb_build_object('promoted', b.id = ANY(v_promoted))
    FROM bookings b WHERE b.id = ANY(v_ids) ORDER BY b.id;
END $$;

-- ---------------------------------------------------------------------------
-- 2. checkout_claim_group: the six-argument form is dropped (PostgREST would otherwise see two candidates) and the
--    seven-argument form, with p_provisional defaulting to NULL, takes its place
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS checkout_claim_group(uuid, uuid, uuid[], boolean, text, integer);
CREATE OR REPLACE FUNCTION checkout_claim_group(
  p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[],
  p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer,
  p_provisional boolean DEFAULT NULL
) RETURNS TABLE(payment_group_id uuid, total_customer_amount integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[]; v_gid uuid; v_total int := 0; v_bid uuid; v_bk record; v_fee_row record;
  v_cust int; v_venue int; v_fee int; v_groups uuid[]; v_existing uuid; v_existing_set uuid[];
  v_owned int; v_g record; v_keeps boolean; v_connect text;
BEGIN
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;
  v_keeps := coalesce(p_platform_keeps_all,false);
  v_connect := nullif(btrim(coalesce(p_connect_account_id,'')), '');
  -- 0116: a connected group must name the account the demo fee is routed to. The handler reads it off the retailer
  -- row and refuses a store that is not payout-ready, but the ledger does not trust the handler for this.
  IF NOT v_keeps AND v_connect IS NULL THEN RAISE EXCEPTION 'connect_account_required'; END IF;
  IF NOT v_keeps AND coalesce(p_platform_fee_cents,0) < 0 THEN RAISE EXCEPTION 'platform_fee_invalid'; END IF;
  IF v_keeps THEN v_connect := NULL; END IF;

  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  IF array_length(v_ids,1) <> array_length(p_booking_ids,1) THEN RAISE EXCEPTION 'duplicate_booking_input'; END IF;

  SELECT count(*) INTO v_owned FROM bookings b WHERE b.id = ANY(v_ids) AND b.brand_id = p_brand_id;
  IF v_owned <> array_length(v_ids,1) THEN RAISE EXCEPTION 'not_your_booking'; END IF;
  -- 0118 (Codex R3-2): the handler decides the capture mode (manual authorization for ONE held booking, immediate charge
  -- otherwise) from the rows it read; that decision is asserted here, under the locks, against the bookings' current
  -- state, so a hold promoted or released by another path between the read and the claim is refused instead of being
  -- authorized or charged from a stale flag. NULL (older callers, the test fixtures) keeps the 0116 behaviour.
  IF p_provisional IS TRUE THEN
    IF NOT v_keeps THEN RAISE EXCEPTION 'connected_hold_unsupported'; END IF;
    IF array_length(v_ids,1) <> 1 THEN RAISE EXCEPTION 'provisional_checkout_single_only'; END IF;
  END IF;

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
         AND v_g.platform_keeps_all = v_keeps
         AND coalesce(v_g.connect_account_id,'') = coalesce(v_connect,'')
         AND lower(v_g.currency) = 'usd' THEN
        IF p_provisional IS NOT NULL AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = ANY(v_ids) AND ((b.status = 'held') <> p_provisional)) THEN
          RAISE EXCEPTION 'capture_mode_stale';
        END IF;
        RETURN QUERY SELECT v_g.id, v_g.total_customer_amount, true; RETURN;
      END IF;
    END IF;
    RAISE EXCEPTION 'booking_in_another_group';
  END IF;

  INSERT INTO payment_groups(brand_id, retailer_id, total_customer_amount, platform_keeps_all, connect_account_id, status)
    VALUES (p_brand_id, p_retailer_id, 0, v_keeps, v_connect, 'pending')
    RETURNING id INTO v_gid;

  FOREACH v_bid IN ARRAY v_ids LOOP
    SELECT b.id, b.brand_id, b.retailer_id, b.venue_id, b.status, b.payment_status
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking % not found', v_bid; END IF;
    IF v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    IF v_bk.status NOT IN ('pending_payment','held') OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;
    IF p_provisional IS NOT NULL AND ((v_bk.status = 'held') <> p_provisional) THEN RAISE EXCEPTION 'capture_mode_stale %', v_bid; END IF;
    SELECT v.demo_fee INTO v_fee_row FROM venues v WHERE v.id = v_bk.venue_id;
    IF v_fee_row IS NULL OR v_fee_row.demo_fee IS NULL OR v_fee_row.demo_fee < 0 THEN RAISE EXCEPTION 'venue_missing_fee %', v_bid; END IF;
    v_venue := round(v_fee_row.demo_fee * 100)::int;
    v_fee   := CASE WHEN v_keeps THEN 0 ELSE coalesce(p_platform_fee_cents,0) END;
    v_cust  := v_venue + v_fee;
    v_total := v_total + v_cust;
    INSERT INTO payment_allocations(payment_group_id, booking_id, customer_amount, venue_amount, platform_fee_amount)
      VALUES (v_gid, v_bid, v_cust, v_venue, v_fee);
  END LOOP;

  UPDATE payment_groups SET total_customer_amount = v_total WHERE id = v_gid;
  RETURN QUERY SELECT v_gid, v_total, false;
END $$;

-- ---------------------------------------------------------------------------
-- 3. apply_verified_payment: a missing application fee is a zero fee
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_verified_payment(
  p_session_id text, p_payment_intent text, p_charge text, p_amount integer, p_currency text,
  p_connect_dest text, p_on_behalf_of text, p_application_fee integer,
  p_transfer_id text, p_fee_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_att record; v_grp record; v_alloc_count int; v_flippable int; v_sum int; v_ids uuid[]; v_case uuid; v_auto boolean; v_fee_sum int;
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
    -- keeps-all: NO Connect field may be present (0036 P0-3 #9, unchanged)
    IF p_connect_dest IS NOT NULL OR p_on_behalf_of IS NOT NULL OR p_application_fee IS NOT NULL
       OR p_transfer_id IS NOT NULL OR p_fee_id IS NOT NULL THEN
      v_case := _open_case('payment_contradiction','connect-on-keepsall:'||p_session_id,'unexpected_connect_fields_on_keeps_all',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                           jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'fee',p_application_fee,'transfer',p_transfer_id,'fee_id',p_fee_id));
      RETURN jsonb_build_object('outcome','contradiction','reason','unexpected_connect_fields','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  ELSE
    -- 0116: connected. The money routing Stripe reports must equal the immutable snapshot taken at claim time:
    -- the destination and the settlement merchant are the store's connected account, and the application fee is
    -- exactly the sum of the platform fee legs. The transfer id and application fee id are NOT required here:
    -- Stripe fills charge.transfer and charge.application_fee a moment after capture (rehearsed 2026-10-30: the
    -- checkout.session.completed retrieval can see them still empty), so they are recorded when present, write-once,
    -- and a later replay that carries them fills them in (the idempotent branch below).
    SELECT coalesce(sum(platform_fee_amount),0) INTO v_fee_sum FROM payment_allocations WHERE payment_group_id = v_grp.id;
    IF coalesce(v_grp.connect_account_id,'') = ''
       OR coalesce(p_connect_dest,'') <> v_grp.connect_account_id
       OR coalesce(p_on_behalf_of,'') <> v_grp.connect_account_id
       -- 0118 (Codex round 4, small correction 1): a destination charge created with no application fee carries no
       -- application_fee_amount at all; that is a zero fee, and it must equal the allocations' zero fee sum.
       OR coalesce(p_application_fee,0) <> v_fee_sum THEN
      v_case := _open_case('payment_contradiction','connect-routing:'||p_session_id,'connect_routing_mismatch',
                           v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                           jsonb_build_object('dest',p_connect_dest,'obo',p_on_behalf_of,'app_fee',p_application_fee,'transfer',p_transfer_id,'fee_id',p_fee_id,
                                              'expected_dest',v_grp.connect_account_id,'expected_fee',v_fee_sum));
      RETURN jsonb_build_object('outcome','contradiction','reason','connect_routing_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
    END IF;
  END IF;

  IF v_grp.stripe_payment_intent_id IS NOT NULL AND v_grp.stripe_payment_intent_id <> p_payment_intent THEN
    v_case := _open_case('payment_contradiction','pi-mismatch:'||p_session_id,'pi_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','pi_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- [0065] an authorized group may already carry the UNCAPTURED charge id from auth time; capture re-delivers the
  -- same charge id, so equality holds.
  IF v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge THEN
    v_case := _open_case('payment_contradiction','charge-mismatch:'||p_session_id,'charge_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,NULL);
    RETURN jsonb_build_object('outcome','contradiction','reason','charge_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- 0116: the settlement identifiers are write-once as well
  IF v_grp.stripe_transfer_id IS NOT NULL AND p_transfer_id IS NOT NULL AND v_grp.stripe_transfer_id <> p_transfer_id THEN
    v_case := _open_case('payment_contradiction','transfer-mismatch:'||p_session_id,'transfer_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('recorded',v_grp.stripe_transfer_id,'got',p_transfer_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','transfer_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;
  -- 0117 (Codex CC-3): the application fee id is write-once too, symmetric with the transfer id
  IF v_grp.stripe_application_fee_id IS NOT NULL AND p_fee_id IS NOT NULL AND v_grp.stripe_application_fee_id <> p_fee_id THEN
    v_case := _open_case('payment_contradiction','fee-mismatch:'||p_session_id,'application_fee_mismatch',v_grp.id,NULL,NULL,p_session_id,p_payment_intent,p_charge,NULL,p_amount,p_currency,
                         jsonb_build_object('recorded',v_grp.stripe_application_fee_id,'got',p_fee_id));
    RETURN jsonb_build_object('outcome','contradiction','reason','application_fee_mismatch','payment_group_id',v_grp.id,'case_id',v_case);
  END IF;

  IF v_grp.status IN ('paid','partially_refunded','refunded') THEN
    -- 0116: a replay of a connected payment that now carries the settlement ids fills them in, write-once (the
    -- routing above already matched the snapshot; a different transfer id was refused above).
    IF NOT v_grp.platform_keeps_all AND (v_grp.stripe_transfer_id IS NULL OR v_grp.stripe_application_fee_id IS NULL) THEN
      UPDATE payment_groups SET stripe_transfer_id = coalesce(stripe_transfer_id, p_transfer_id),
                                stripe_application_fee_id = coalesce(stripe_application_fee_id, p_fee_id) WHERE id = v_grp.id;
    END IF;
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
      stripe_charge_id          = coalesce(stripe_charge_id,          p_charge),
      -- 0116: the settlement identifiers of a destination charge (NULL on a keeps-all group, refused above otherwise)
      stripe_transfer_id        = coalesce(stripe_transfer_id,        p_transfer_id),
      stripe_application_fee_id = coalesce(stripe_application_fee_id, p_fee_id)
    WHERE id = v_grp.id;
  UPDATE payment_attempts SET status = 'paid', stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent), paid_at = now()
    WHERE id = v_att.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;

  -- [0065] (d) a captured hold re-opens its 'held' outbox row with the real target (demo+emails);
  -- finished non-held rows keep their DO NOTHING replay-idempotency. [0078] C1: generation fencing.
  INSERT INTO booking_fulfillments(booking_id, payment_group_id, target_status, status)
    SELECT a.booking_id, v_grp.id, CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END, 'pending'
      FROM payment_allocations a WHERE a.payment_group_id = v_grp.id
    ON CONFLICT (booking_id) DO UPDATE
      SET target_status = EXCLUDED.target_status, status = 'pending',
          demo_created = false, emails_sent = false, completed_at = NULL, last_error = NULL,
          generation = booking_fulfillments.generation + 1,
          lease_owner = NULL, lease_expires_at = NULL, attempts = 0
      WHERE booking_fulfillments.target_status = 'held';

  SELECT array_agg(booking_id) INTO v_ids FROM payment_allocations WHERE payment_group_id = v_grp.id;
  RETURN jsonb_build_object('outcome','applied','payment_group_id',v_grp.id,'applied_count',v_alloc_count,
                            'booking_ids',to_jsonb(v_ids),'target_status', CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END);
END $$;

REVOKE ALL ON FUNCTION promote_held_bookings(uuid,uuid,text,uuid[],uuid[]) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION promote_held_bookings(uuid,uuid,text,uuid[],uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION apply_verified_payment(text,text,text,integer,text,text,text,integer,text,text) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_claim text; v_apply text; v_args text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='promote_held_bookings';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: promote_held_bookings: % (expected 1)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='checkout_claim_group';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group overloads: % (expected the seven-argument one only)', v_n; END IF;
  SELECT pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid) INTO v_args, v_claim FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='checkout_claim_group';
  IF position('p_provisional boolean' in v_args) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group lacks p_provisional'; END IF;
  IF position('capture_mode_stale' in v_claim) = 0 OR position('connected_hold_unsupported' in v_claim) = 0 OR position('connect_account_required' in v_claim) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group lacks the 0118 mode checks or the 0116 routing check'; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_apply FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='apply_verified_payment';
  IF position('coalesce(p_application_fee,0) <> v_fee_sum' in v_apply) = 0 OR position('fee-mismatch' in v_apply) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: apply_verified_payment lacks the zero-fee rule or the fee id contradiction'; END IF;
  RAISE NOTICE '0118: post-conditions passed';
END $$;
