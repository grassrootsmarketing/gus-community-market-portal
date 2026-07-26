-- 0030_payment_ledger_hardening.sql — corrective forward migration for Codex reverify #9.
-- Fixes P0-1 (exact-set claim), P0-3 (monotonic verified payment apply), P0-4 (exact refund
-- finalize), P1-2 (idempotent refund op-key), P1-5 (FKs + immutability). Never rewrites 0029.
-- (Individual refund.* events, inbox lease, session.expired, retry worker: handler-side, next pass.)
BEGIN;

-- ---- P1-5: referential integrity + immutability ----
DO $$ BEGIN
  ALTER TABLE payment_allocations ADD CONSTRAINT pa_booking_fk FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE refund_requests ADD CONSTRAINT rr_alloc_fk FOREIGN KEY (payment_allocation_id) REFERENCES payment_allocations(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- refund op-key (P1-2): one refund request per (booking, operation); retries return the same row.
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS op_key text;
CREATE UNIQUE INDEX IF NOT EXISTS refund_requests_opkey_uidx ON refund_requests(op_key) WHERE op_key IS NOT NULL;

-- immutability: after insert, an allocation's identity + snapshot amounts cannot change
-- (only refunded_amount / reserved_refund_amount / updated_at may move).
CREATE OR REPLACE FUNCTION _pa_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_group_id <> OLD.payment_group_id OR NEW.booking_id <> OLD.booking_id
     OR NEW.customer_amount <> OLD.customer_amount OR NEW.venue_amount <> OLD.venue_amount
     OR NEW.platform_fee_amount <> OLD.platform_fee_amount OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'payment_allocation snapshot is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pa_immutable ON payment_allocations;
CREATE TRIGGER pa_immutable BEFORE UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION _pa_immutable();

-- ---- P0-1: exact-set claim (sorted set equality, dedup, deterministic lock order) ----
CREATE OR REPLACE FUNCTION checkout_claim_group(
  p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[],
  p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer
) RETURNS TABLE(payment_group_id uuid, total_customer_amount integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ids uuid[]; v_gid uuid; v_total int := 0; v_bid uuid; v_bk record; v_fee_row record;
  v_cust int; v_venue int; v_fee int; v_groups uuid[]; v_existing uuid; v_existing_set uuid[];
BEGIN
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;
  -- canonical sorted DISTINCT; reject duplicate input
  SELECT array_agg(x ORDER BY x) INTO v_ids FROM (SELECT DISTINCT unnest(p_booking_ids) x) d;
  IF array_length(v_ids,1) <> array_length(p_booking_ids,1) THEN RAISE EXCEPTION 'duplicate_booking_input'; END IF;

  -- all overlapping groups
  SELECT array_agg(DISTINCT a.payment_group_id) INTO v_groups FROM payment_allocations a WHERE a.booking_id = ANY(v_ids);
  IF v_groups IS NOT NULL THEN
    IF array_length(v_groups,1) = 1 THEN
      v_existing := v_groups[1];
      SELECT array_agg(booking_id ORDER BY booking_id) INTO v_existing_set FROM payment_allocations WHERE payment_group_id = v_existing;
      IF v_existing_set = v_ids
         AND (SELECT status FROM payment_groups WHERE id = v_existing) IN ('pending','session_created')
         AND (SELECT brand_id FROM payment_groups WHERE id = v_existing) = p_brand_id
         AND (SELECT retailer_id FROM payment_groups WHERE id = v_existing) = p_retailer_id THEN
        RETURN QUERY SELECT v_existing, (SELECT total_customer_amount FROM payment_groups WHERE id = v_existing), true; RETURN;
      END IF;
    END IF;
    RAISE EXCEPTION 'booking_in_another_group';
  END IF;

  INSERT INTO payment_groups(brand_id, retailer_id, total_customer_amount, platform_keeps_all, connect_account_id, status)
    VALUES (p_brand_id, p_retailer_id, 0, coalesce(p_platform_keeps_all,false), p_connect_account_id, 'pending')
    RETURNING id INTO v_gid;

  FOREACH v_bid IN ARRAY v_ids LOOP   -- v_ids already sorted -> deterministic lock order (no deadlock)
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

-- ---- P0-3: verified, monotonic, all-or-none payment apply ----
CREATE OR REPLACE FUNCTION apply_payment_success(
  p_payment_intent_id text, p_charge_id text, p_amount integer, p_currency text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_grp record; v_alloc_count int; v_flippable int;
BEGIN
  SELECT * INTO v_grp FROM payment_groups WHERE stripe_payment_intent_id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group_for_pi %', p_payment_intent_id; END IF;
  -- idempotent replay of an already-paid group (only if charge id is null-or-same)
  IF v_grp.status = 'paid' THEN
    IF p_charge_id IS NOT NULL AND v_grp.stripe_charge_id IS NOT NULL AND v_grp.stripe_charge_id <> p_charge_id THEN RAISE EXCEPTION 'charge_mismatch'; END IF;
    RETURN 0;
  END IF;
  IF v_grp.status NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_payable %', v_grp.status; END IF;  -- reject refunded/frozen/failed
  IF p_amount IS NOT NULL AND p_amount <> v_grp.total_customer_amount THEN RAISE EXCEPTION 'amount_mismatch % <> %', p_amount, v_grp.total_customer_amount; END IF;
  IF p_currency IS NOT NULL AND lower(p_currency) <> lower(v_grp.currency) THEN RAISE EXCEPTION 'currency_mismatch'; END IF;

  SELECT count(*) INTO v_alloc_count FROM payment_allocations WHERE payment_group_id = v_grp.id;
  SELECT count(*) INTO v_flippable FROM bookings b JOIN payment_allocations a ON a.booking_id = b.id
    WHERE a.payment_group_id = v_grp.id AND b.payment_status = 'unpaid' AND b.status = 'pending_payment';
  IF v_flippable <> v_alloc_count THEN
    UPDATE payment_groups SET status = 'frozen' WHERE id = v_grp.id;   -- captured but not fully applicable -> freeze + reconcile
    RETURN -1;
  END IF;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent_id, paid_at = now()
    FROM payment_allocations a WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id;
  UPDATE payment_groups SET status = 'paid', stripe_charge_id = coalesce(p_charge_id, stripe_charge_id) WHERE id = v_grp.id;
  RETURN v_alloc_count;
END $$;

-- ---- P0-4: exact refund finalize (validate amount/currency; typed unmatched vs error) ----
CREATE OR REPLACE FUNCTION finalize_refund(
  p_stripe_refund_id text, p_status text, p_amount integer, p_currency text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_alloc record; v_grp uuid; v_all boolean;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE stripe_refund_id = p_stripe_refund_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unmatched'; END IF;                                   -- typed, not an exception
  IF p_amount IS NOT NULL AND p_amount <> v_req.amount THEN RAISE EXCEPTION 'refund_amount_mismatch % <> %', p_amount, v_req.amount; END IF;
  IF p_currency IS NOT NULL AND lower(p_currency) <> lower(v_req.currency) THEN RAISE EXCEPTION 'refund_currency_mismatch'; END IF;
  IF v_req.status IN ('succeeded','failed','canceled') THEN RETURN 'already_terminal'; END IF;
  SELECT * INTO v_alloc FROM payment_allocations WHERE id = v_req.payment_allocation_id FOR UPDATE;

  IF p_status = 'succeeded' THEN
    IF v_alloc.reserved_refund_amount < v_req.amount THEN RAISE EXCEPTION 'reservation_underflow'; END IF;
    UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount - v_req.amount, refunded_amount = refunded_amount + v_req.amount WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'succeeded' WHERE id = v_req.id;
    UPDATE bookings SET payment_status = CASE WHEN (v_alloc.refunded_amount + v_req.amount) >= v_alloc.customer_amount THEN 'refunded' ELSE 'partial_refund' END,
                        refund_id = p_stripe_refund_id, refunded_at = now() WHERE id = v_req.booking_id;
  ELSIF p_status IN ('failed','canceled') THEN
    UPDATE payment_allocations SET reserved_refund_amount = greatest(0, reserved_refund_amount - v_req.amount) WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = p_status WHERE id = v_req.id;
  ELSE
    RETURN 'pending';                                                            -- pending/requires_action: no money move
  END IF;

  v_grp := v_alloc.payment_group_id;
  SELECT bool_and(refunded_amount >= customer_amount) INTO v_all FROM payment_allocations WHERE payment_group_id = v_grp;
  UPDATE payment_groups SET status = CASE WHEN v_all THEN 'refunded'
                                          WHEN EXISTS (SELECT 1 FROM payment_allocations WHERE payment_group_id = v_grp AND refunded_amount > 0) THEN 'partially_refunded'
                                          ELSE status END
    WHERE id = v_grp AND status IN ('paid','partially_refunded');
  RETURN 'finalized';
END $$;

-- ---- P1-2: idempotent refund reservation keyed on an operation id ----
CREATE OR REPLACE FUNCTION reserve_refund(
  p_booking_id uuid, p_amount integer, p_actor text, p_reason text, p_policy text, p_op_key text
) RETURNS TABLE(refund_request_id uuid, idempotency_key text, stripe_payment_intent_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_alloc record; v_remaining int; v_rid uuid; v_key text; v_ex record;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  -- idempotent: same operation returns the existing request
  IF p_op_key IS NOT NULL THEN
    SELECT rr.id, rr.stripe_idempotency_key, g.stripe_payment_intent_id AS pi INTO v_ex
    FROM refund_requests rr JOIN payment_allocations a ON a.id = rr.payment_allocation_id JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE rr.op_key = p_op_key AND rr.status NOT IN ('failed','canceled') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_ex.id, v_ex.stripe_idempotency_key, v_ex.pi; RETURN; END IF;
  END IF;
  SELECT a.*, g.stripe_payment_intent_id AS pi, g.status AS gstatus
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no allocation for booking'; END IF;
  IF v_alloc.pi IS NULL OR v_alloc.gstatus NOT IN ('paid','partially_refunded') THEN RAISE EXCEPTION 'group not in a refundable state'; END IF;
  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF p_amount > v_remaining THEN RAISE EXCEPTION 'amount exceeds refundable (% > %)', p_amount, v_remaining; END IF;
  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + p_amount WHERE id = v_alloc.id;
  v_rid := gen_random_uuid(); v_key := 'demohub-refund-v1:' || v_rid::text;
  INSERT INTO refund_requests(id, payment_allocation_id, booking_id, amount, actor, reason, policy_decision, status, stripe_idempotency_key, op_key)
    VALUES (v_rid, v_alloc.id, p_booking_id, p_amount, p_actor, p_reason, p_policy, 'reserved', v_key, p_op_key);
  RETURN QUERY SELECT v_rid, v_key, v_alloc.pi;
END $$;

-- privileges for the new/changed signatures
REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_payment_success(text,text,integer,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_refund(text,text,integer,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION reserve_refund(uuid,integer,text,text,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION apply_payment_success(text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_refund(text,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION reserve_refund(uuid,integer,text,text,text,text) TO service_role;
-- drop the superseded 4-arg finalize / 2-arg apply / 5-arg reserve from 0029 (signatures changed)
DROP FUNCTION IF EXISTS finalize_refund(text,text,integer);
DROP FUNCTION IF EXISTS apply_payment_success(text,text);
DROP FUNCTION IF EXISTS reserve_refund(uuid,integer,text,text,text);

COMMIT;
