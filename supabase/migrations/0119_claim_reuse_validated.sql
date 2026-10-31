-- 0119_claim_reuse_validated.sql
-- ============================================================================
-- Codex review of c36cc1b (connected checkout round 5, 2026-10-31): R4-1 (required), R4-3 (follow-up) and one grant.
-- Forward-only. 0118 is already applied on demohub-rebuild-check and is NOT rewritten; this file follows it in the
-- chain. Nothing here is deployed to production (0116 to 0118 are not on demohub-prod either).
--
--   R4-1  checkout_claim_group validated a REUSED group (an existing pending/session_created group whose allocations
--         cover exactly the requested bookings) after only comparing (status = 'held') with p_provisional, without the
--         booking row locks and the payable-state check the new-group path applied. A cancelled or expired booking is
--         "not held", so with p_provisional false its old group could be handed back as reusable and the handler went
--         on towards Stripe. Now BOTH paths share one protected decision: every requested booking is locked FOR UPDATE
--         in id order and validated under its lock (exists, owned by the brand, at the one store, payable: status
--         pending_payment or held with payment_status unpaid, and the capture mode asserted when p_provisional is not
--         NULL); only then are the allocations read (authoritative: every allocation is inserted under these same
--         locks) and the existing group's state re-read and checked before reuse returns. A booking that is cancelled,
--         expired, declined, authorized, paid or in any other non-payable state is refused (not_payable_state) on the
--         reuse path exactly as on the new-group path. Valid idempotent reuse and immutable allocations are kept.
--
--         Lock order. Bookings are locked in id order and the payment_groups row of an existing group is READ, not
--         locked. Reason: apply_verified_payment and apply_verified_authorization lock the group first and then update
--         the bookings; a claim that held booking locks and then took a lock on the group would be the opposite order
--         and a deadlock candidate against a payment being applied for that very group. Reading the group under the
--         booking locks is enough for the decision: the only writers that move a booking out of a payable state
--         (cancellation, the hold sweep, payment application, authorization) all take the booking row lock, so they
--         either committed before this read or wait until this claim commits. promote_held_bookings, the cancellation
--         functions (0105 to 0110), refund_reserve_cas (booking, then allocation and group) and the new-group path all
--         lock the booking first; this file introduces no lock in the opposite order.
--
--         The seven-argument form is kept (p_provisional DEFAULT NULL) so a six-argument caller still resolves. NULL
--         means NO capture-mode assertion (the 0116 behaviour); the shipped handler always sends the explicit boolean.
--
--   R4-3  fillGroupSettlementIds in api/refund-worker.js selected the 25 oldest connected groups missing a transfer or
--         application fee id on every run. A zero-fee group is complete with its transfer id alone and never gains a
--         fee id, so such groups stayed eligible forever and could starve every later group; groups whose ids never
--         appear behaved the same. Two scheduling columns and one service-only function give the worker a bounded,
--         fair selection: a verified zero-fee-complete group is marked and never selected again; a group still waiting
--         for its ids, one with a stale-ids case open, or one with a charge mismatch gets a next check time and is not
--         selected before it. Nothing fabricates an id; the Stripe identifiers stay write-once.
--
--   Grant _open_case is called directly by api/refund-worker.js with the service credential (group id fill). The chain
--         revoked it from public, anon and authenticated (0036, 0037) and never granted it to service_role; on a Supabase
--         project the project's default privileges grant EXECUTE to service_role on creation, which is why it works on
--         demohub-rebuild-check and would on demohub-prod. The explicit grant makes the committed chain say what is
--         meant and removes that difference from the catalog allowlist. No other grant changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. checkout_claim_group: one protected decision for reuse and for a new group
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION checkout_claim_group(
  p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[],
  p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer,
  p_provisional boolean DEFAULT NULL
) RETURNS TABLE(payment_group_id uuid, total_customer_amount integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[]; v_gid uuid; v_total int := 0; v_bid uuid; v_bk record; v_fee_row record;
  v_cust int; v_venue int; v_fee int; v_groups uuid[]; v_existing uuid; v_existing_set uuid[];
  v_g record; v_keeps boolean; v_connect text;
BEGIN
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;
  IF p_brand_id IS NULL OR p_retailer_id IS NULL THEN RAISE EXCEPTION 'brand_and_retailer_required'; END IF;
  v_keeps := coalesce(p_platform_keeps_all,false);
  v_connect := nullif(btrim(coalesce(p_connect_account_id,'')), '');
  -- 0116: a connected group must name the account the demo fee is routed to. The handler reads it off the retailer
  -- row and refuses a store that is not payout-ready, but the ledger does not trust the handler for this.
  IF NOT v_keeps AND v_connect IS NULL THEN RAISE EXCEPTION 'connect_account_required'; END IF;
  IF NOT v_keeps AND coalesce(p_platform_fee_cents,0) < 0 THEN RAISE EXCEPTION 'platform_fee_invalid'; END IF;
  IF v_keeps THEN v_connect := NULL; END IF;

  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  IF array_length(v_ids,1) <> array_length(p_booking_ids,1) THEN RAISE EXCEPTION 'duplicate_booking_input'; END IF;
  -- 0118 (Codex R3-2): the handler decides the capture mode (manual authorization for ONE held booking, immediate charge
  -- otherwise) from the rows it read; that decision is asserted below, under the locks, against each booking's current
  -- state. NULL (a six-argument caller) means no assertion, the 0116 behaviour.
  IF p_provisional IS TRUE THEN
    IF NOT v_keeps THEN RAISE EXCEPTION 'connected_hold_unsupported'; END IF;
    IF array_length(v_ids,1) <> 1 THEN RAISE EXCEPTION 'provisional_checkout_single_only'; END IF;
  END IF;

  -- (a) Lock every requested booking in id order and validate it under its lock. This is the ONE validation both the
  --     reuse path and the new-group path go through; neither returns before it has completed for every booking.
  FOREACH v_bid IN ARRAY v_ids LOOP
    SELECT b.id, b.brand_id, b.retailer_id, b.status, b.payment_status
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking_set_mismatch %', v_bid; END IF;
    IF v_bk.brand_id IS NULL OR v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id IS NULL OR v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    -- payable means exactly this; "not held" is never read as "pending_payment and unpaid"
    IF v_bk.status NOT IN ('pending_payment','held') OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;
    IF p_provisional IS NOT NULL AND ((v_bk.status = 'held') <> p_provisional) THEN RAISE EXCEPTION 'capture_mode_stale %', v_bid; END IF;
  END LOOP;

  -- (b) Existing allocations, read under the booking locks (every allocation is inserted under these locks, so the
  --     read is authoritative), and the existing group's state re-read as part of the same protected decision.
  SELECT array_agg(DISTINCT a.payment_group_id) INTO v_groups FROM payment_allocations a WHERE a.booking_id = ANY(v_ids);
  IF v_groups IS NOT NULL THEN
    IF array_length(v_groups,1) <> 1 THEN RAISE EXCEPTION 'booking_in_another_group'; END IF;
    v_existing := v_groups[1];
    SELECT array_agg(pa.booking_id ORDER BY pa.booking_id) INTO v_existing_set
      FROM payment_allocations pa WHERE pa.payment_group_id = v_existing;
    SELECT g.* INTO v_g FROM payment_groups g WHERE g.id = v_existing;   -- read, not locked: see the lock-order note above
    IF v_existing_set = v_ids
       AND v_g.status IN ('pending','session_created')
       AND v_g.brand_id = p_brand_id
       AND v_g.retailer_id = p_retailer_id
       AND v_g.platform_keeps_all = v_keeps
       AND coalesce(v_g.connect_account_id,'') = coalesce(v_connect,'')
       AND lower(v_g.currency) = 'usd' THEN
      -- RETURN 1 of 2: idempotent reuse, after (a) for every booking and the group check just above
      RETURN QUERY SELECT v_g.id, v_g.total_customer_amount, true; RETURN;
    END IF;
    RAISE EXCEPTION 'booking_in_another_group';
  END IF;

  -- (c) No allocation for any requested booking: a new group with immutable allocations, under the same locks.
  INSERT INTO payment_groups(brand_id, retailer_id, total_customer_amount, platform_keeps_all, connect_account_id, status)
    VALUES (p_brand_id, p_retailer_id, 0, v_keeps, v_connect, 'pending')
    RETURNING id INTO v_gid;

  FOREACH v_bid IN ARRAY v_ids LOOP
    SELECT b.venue_id INTO v_bk FROM bookings b WHERE b.id = v_bid;   -- locked in (a)
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
  -- RETURN 2 of 2: the new group, after (a) for every booking
  RETURN QUERY SELECT v_gid, v_total, false;
END $$;

-- ---------------------------------------------------------------------------
-- 2. R4-3: scheduling columns for the worker's group id fill, and the service-only function that writes them
-- ---------------------------------------------------------------------------
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS settlement_ids_next_check_at timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS settlement_ids_resolution text;
ALTER TABLE payment_groups DROP CONSTRAINT IF EXISTS payment_groups_settlement_ids_resolution_check;
ALTER TABLE payment_groups ADD CONSTRAINT payment_groups_settlement_ids_resolution_check
  CHECK (settlement_ids_resolution IS NULL OR settlement_ids_resolution IN ('zero_fee_complete'));
CREATE INDEX IF NOT EXISTS payment_groups_settlement_ids_due_idx
  ON payment_groups (settlement_ids_next_check_at, updated_at)
  WHERE platform_keeps_all = false AND settlement_ids_resolution IS NULL
    AND (stripe_transfer_id IS NULL OR stripe_application_fee_id IS NULL);

-- schedule_group_ids_check(group, outcome): the worker reports what it found for one connected group and the ledger
-- decides the next selection. 'zero_fee_complete' is VERIFIED here (connected group, transfer id present, no fee id,
-- allocations' fee sum zero) before the mark is written; the worker cannot mark a positive-fee group complete.
-- 'waiting' (ids not on the charge yet): next check in 5 minutes. 'unresolved' (a stale-ids case was opened): 6 hours.
-- 'mismatch' (a charge contradiction case was opened): 24 hours. 'error' (a provider or database error): 5 minutes.
-- 'due_now' clears the schedule (used by the tests and by an operator who wants a group looked at again).
CREATE OR REPLACE FUNCTION schedule_group_ids_check(p_group_id uuid, p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_fee_sum int; v_next timestamptz; v_res text;
BEGIN
  IF p_group_id IS NULL THEN RAISE EXCEPTION 'group_required'; END IF;
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.platform_keeps_all THEN RETURN jsonb_build_object('outcome','keeps_all_group'); END IF;
  IF p_outcome = 'zero_fee_complete' THEN
    SELECT coalesce(sum(platform_fee_amount),0) INTO v_fee_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
    IF v_g.stripe_transfer_id IS NULL OR v_g.stripe_application_fee_id IS NOT NULL OR v_fee_sum <> 0 THEN
      RETURN jsonb_build_object('outcome','refused','reason','not_a_complete_zero_fee_group','transfer', v_g.stripe_transfer_id, 'fee_id', v_g.stripe_application_fee_id, 'fee_sum', v_fee_sum);
    END IF;
    v_res := 'zero_fee_complete'; v_next := NULL;
  ELSIF p_outcome = 'waiting' THEN v_next := now() + interval '5 minutes';
  ELSIF p_outcome = 'unresolved' THEN v_next := now() + interval '6 hours';
  ELSIF p_outcome = 'mismatch' THEN v_next := now() + interval '24 hours';
  ELSIF p_outcome = 'error' THEN v_next := now() + interval '5 minutes';
  ELSIF p_outcome = 'due_now' THEN v_next := NULL;
  ELSE RAISE EXCEPTION 'unknown_outcome %', p_outcome;
  END IF;
  UPDATE payment_groups SET settlement_ids_next_check_at = v_next, settlement_ids_resolution = v_res WHERE id = p_group_id;
  RETURN jsonb_build_object('outcome','scheduled','payment_group_id',p_group_id,'resolution',v_res,'next_check_at',v_next);
END $$;

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION schedule_group_ids_check(uuid,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION schedule_group_ids_check(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION _open_case(text,text,text,uuid,uuid,uuid,text,text,text,text,integer,text,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_claim text; v_lock int; v_reuse int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='checkout_claim_group';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group overloads: % (expected the seven-argument one only)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_claim FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='checkout_claim_group';
  v_lock := position('FOR UPDATE' in v_claim); v_reuse := position('RETURN QUERY SELECT v_g.id' in v_claim);
  IF v_lock = 0 OR v_reuse = 0 OR v_lock > v_reuse THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group does not lock the bookings before the reuse return'; END IF;
  IF position('not_payable_state' in v_claim) = 0 OR position('capture_mode_stale' in v_claim) = 0 OR position('connect_account_required' in v_claim) = 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group lacks the payable, capture-mode or routing checks'; END IF;
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public' AND table_name='payment_groups' AND column_name IN ('settlement_ids_next_check_at','settlement_ids_resolution');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: payment_groups scheduling columns: % (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='schedule_group_ids_check';
  IF v_n <> 1 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: schedule_group_ids_check: % (expected 1)', v_n; END IF;
  IF NOT has_function_privilege('service_role', '_open_case(text,text,text,uuid,uuid,uuid,text,text,text,text,integer,text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION 'POST-CONDITION FAILED: service_role cannot execute _open_case'; END IF;
  IF has_function_privilege('anon', 'schedule_group_ids_check(uuid,text)', 'EXECUTE') OR has_function_privilege('authenticated', 'checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean)', 'EXECUTE') THEN RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute a service-only function'; END IF;
  RAISE NOTICE '0119: post-conditions passed';
END $$;
