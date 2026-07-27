-- 0035_claim_fix_and_invariants.sql — Codex Round 11: claim correctness + integrity invariants.
-- Forward-only (never edits 0029–0034). Applies on top of them.
--
-- Fixes:
--   R11-P0-1  checkout_claim_group: (a) fix the ambiguous `payment_group_id` reference that threw a
--             500 on overlapping-but-unequal carts; (b) authorize EVERY requested booking to the
--             brand BEFORE any reuse return; (c) reuse only on exact two-way set equality + matching
--             brand/retailer/charge-model/currency snapshot; (d) strict keeps-all pilot gate at the DB.
--   R11-P1-1  payment_attempts identity immutability; group-total = allocation-sum asserted before a
--             Session can bind.
--   R11-P1-2  booking FKs on refund_operations/refund_requests; refund booking must equal its
--             allocation's booking.
BEGIN;

-- ============================================================ P0-1: claim rewrite
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

  -- R11 strict pilot gate: connected/destination-charge groups are out of launch scope.
  IF NOT coalesce(p_platform_keeps_all,false) THEN RAISE EXCEPTION 'connected_not_in_pilot'; END IF;

  -- canonical sorted DISTINCT; reject duplicate input
  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  IF array_length(v_ids,1) <> array_length(p_booking_ids,1) THEN RAISE EXCEPTION 'duplicate_booking_input'; END IF;

  -- authorize EVERY requested booking to this brand BEFORE any reuse decision (booking UUIDs are
  -- not an authorization boundary; a known victim UUID must never be reusable/payable by another brand)
  SELECT count(*) INTO v_owned FROM bookings b WHERE b.id = ANY(v_ids) AND b.brand_id = p_brand_id;
  IF v_owned <> array_length(v_ids,1) THEN RAISE EXCEPTION 'not_your_booking'; END IF;

  -- overlapping groups
  SELECT array_agg(DISTINCT a.payment_group_id) INTO v_groups FROM payment_allocations a WHERE a.booking_id = ANY(v_ids);
  IF v_groups IS NOT NULL THEN
    IF array_length(v_groups,1) = 1 THEN
      v_existing := v_groups[1];
      SELECT array_agg(pa.booking_id ORDER BY pa.booking_id) INTO v_existing_set
        FROM payment_allocations pa WHERE pa.payment_group_id = v_existing;     -- qualified: no ambiguity
      SELECT g.* INTO v_g FROM payment_groups g WHERE g.id = v_existing;
      -- exact two-way set equality + full snapshot match (brand/retailer/charge-model/currency)
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

  FOREACH v_bid IN ARRAY v_ids LOOP   -- sorted -> deterministic lock order
    SELECT b.id, b.brand_id, b.retailer_id, b.venue_id, b.status, b.payment_status
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking % not found', v_bid; END IF;
    IF v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    IF v_bk.status <> 'pending_payment' OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;
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

-- ============================================================ P1-1: attempt immutability
CREATE OR REPLACE FUNCTION _attempt_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_group_id <> OLD.payment_group_id
     OR NEW.canonical_request_hash <> OLD.canonical_request_hash
     OR NEW.request_schema_version <> OLD.request_schema_version
     OR (OLD.stripe_checkout_session_id IS NOT NULL AND NEW.stripe_checkout_session_id IS DISTINCT FROM OLD.stripe_checkout_session_id) THEN
    RAISE EXCEPTION 'payment_attempt identity is immutable';
  END IF;
  IF OLD.stripe_payment_intent_id IS NOT NULL AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id THEN
    RAISE EXCEPTION 'payment_attempt PI is null-to-value only';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS attempt_immutable ON payment_attempts;
CREATE TRIGGER attempt_immutable BEFORE UPDATE ON payment_attempts FOR EACH ROW EXECUTE FUNCTION _attempt_immutable();

-- ============================================================ P1-1: group-total = allocation-sum before binding
CREATE OR REPLACE FUNCTION register_payment_attempt(
  p_group_id uuid, p_session_id text, p_payment_intent text, p_hash text, p_schema integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_open record; v_id uuid; v_gstatus text; v_sum int; v_total int;
BEGIN
  SELECT status, total_customer_amount INTO v_gstatus, v_total FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;

  -- invariant: the group total must equal the sum of its immutable allocations before a Session binds
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
  UPDATE payment_groups SET stripe_checkout_session_id = p_session_id, status = 'session_created'
    WHERE id = p_group_id AND stripe_checkout_session_id IS NULL;
  RETURN v_id;
END $$;

-- ============================================================ P1-2: booking referential + cross-row integrity
DO $$ BEGIN
  ALTER TABLE refund_operations ADD CONSTRAINT ro_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE refund_requests ADD CONSTRAINT rr_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- refund booking_id must equal its allocation's booking_id (no cross-booking refund)
CREATE OR REPLACE FUNCTION _refund_booking_matches_alloc() RETURNS trigger AS $$
DECLARE v_alloc_booking uuid;
BEGIN
  SELECT booking_id INTO v_alloc_booking FROM payment_allocations WHERE id = NEW.payment_allocation_id;
  IF v_alloc_booking IS NULL OR v_alloc_booking <> NEW.booking_id THEN
    RAISE EXCEPTION 'refund booking_id must match allocation booking_id';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS rr_booking_matches ON refund_requests;
CREATE TRIGGER rr_booking_matches BEFORE INSERT ON refund_requests FOR EACH ROW EXECUTE FUNCTION _refund_booking_matches_alloc();
DROP TRIGGER IF EXISTS ro_booking_matches ON refund_operations;
CREATE TRIGGER ro_booking_matches BEFORE INSERT ON refund_operations FOR EACH ROW EXECUTE FUNCTION _refund_booking_matches_alloc();

REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer)  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)        FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION register_payment_attempt(uuid,text,text,text,integer)       TO service_role;

COMMIT;
