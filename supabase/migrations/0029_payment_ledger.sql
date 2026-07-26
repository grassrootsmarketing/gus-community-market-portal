-- 0029_payment_ledger.sql — combined-charge payment ledger (P0-4/P0-5, owner-chosen model).
-- One shared PaymentIntent per cart, an IMMUTABLE per-demo allocation, and a refund-request
-- ledger with reserved balances so refunds are exact and concurrency-safe. All money math lives
-- in SECURITY DEFINER functions (service_role only) so it is atomic — PostgREST can't do this.
BEGIN;

-- ---------- tables ----------
CREATE TABLE IF NOT EXISTS payment_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL,
  retailer_id uuid NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  total_customer_amount integer NOT NULL CHECK (total_customer_amount >= 0),  -- cents
  platform_keeps_all boolean NOT NULL DEFAULT false,
  connect_account_id text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','session_created','paid','partially_refunded','refunded','failed','frozen')),
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_group_id uuid NOT NULL REFERENCES payment_groups(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL UNIQUE,                              -- one active allocation per booking
  customer_amount integer NOT NULL CHECK (customer_amount >= 0),
  venue_amount integer NOT NULL DEFAULT 0 CHECK (venue_amount >= 0),
  platform_fee_amount integer NOT NULL DEFAULT 0 CHECK (platform_fee_amount >= 0),
  refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  reserved_refund_amount integer NOT NULL DEFAULT 0 CHECK (reserved_refund_amount >= 0),
  currency text NOT NULL DEFAULT 'usd',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alloc_refund_within_customer CHECK (refunded_amount + reserved_refund_amount <= customer_amount)
);
CREATE INDEX IF NOT EXISTS payment_allocations_group_idx ON payment_allocations(payment_group_id);

CREATE TABLE IF NOT EXISTS refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_allocation_id uuid NOT NULL REFERENCES payment_allocations(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'usd',
  actor text, reason text, policy_decision text,
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('requires_review','reserved','submitted','pending','succeeded','failed','canceled')),
  stripe_idempotency_key text NOT NULL UNIQUE,
  stripe_refund_id text UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_requests_alloc_idx ON refund_requests(payment_allocation_id);
CREATE INDEX IF NOT EXISTS refund_requests_status_idx ON refund_requests(status);

CREATE TABLE IF NOT EXISTS unmatched_stripe_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_refund_id text UNIQUE NOT NULL,
  stripe_charge_id text, stripe_payment_intent_id text,
  amount integer, currency text, raw jsonb,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- updated_at touch
CREATE OR REPLACE FUNCTION _pl_touch() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pg_groups_touch ON payment_groups;      CREATE TRIGGER pg_groups_touch  BEFORE UPDATE ON payment_groups      FOR EACH ROW EXECUTE FUNCTION _pl_touch();
DROP TRIGGER IF EXISTS pg_alloc_touch ON payment_allocations;  CREATE TRIGGER pg_alloc_touch   BEFORE UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION _pl_touch();
DROP TRIGGER IF EXISTS pg_refreq_touch ON refund_requests;     CREATE TRIGGER pg_refreq_touch  BEFORE UPDATE ON refund_requests     FOR EACH ROW EXECUTE FUNCTION _pl_touch();

-- RLS: service-role only (enable RLS + no policies -> anon/authenticated blocked)
ALTER TABLE payment_groups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_requests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE unmatched_stripe_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON payment_groups, payment_allocations, refund_requests, unmatched_stripe_refunds FROM anon, authenticated;

-- ---------- functions (atomic; service_role only) ----------

-- Claim a cart into an immutable payment group. Verifies ownership + payable state, snapshots the
-- exact per-demo amount, and (via UNIQUE booking_id) makes concurrent double-checkout impossible.
-- Idempotent: re-claiming the SAME booking set that already maps to one pending group returns it.
CREATE OR REPLACE FUNCTION checkout_claim_group(
  p_brand_id uuid, p_retailer_id uuid, p_booking_ids uuid[],
  p_platform_keeps_all boolean, p_connect_account_id text, p_platform_fee_cents integer
) RETURNS TABLE(payment_group_id uuid, total_customer_amount integer, reused boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_gid uuid; v_total int := 0; v_bid uuid; v_bk record; v_ven record;
  v_cust int; v_venue int; v_fee int; v_existing_gid uuid; v_existing_count int;
BEGIN
  IF array_length(p_booking_ids,1) IS NULL THEN RAISE EXCEPTION 'no bookings'; END IF;

  -- idempotent reuse: do these exact bookings already share one PENDING/SESSION group?
  SELECT a.payment_group_id INTO v_existing_gid
  FROM payment_allocations a WHERE a.booking_id = ANY(p_booking_ids) GROUP BY a.payment_group_id LIMIT 2;
  IF v_existing_gid IS NOT NULL THEN
    SELECT count(*) INTO v_existing_count FROM payment_allocations WHERE payment_group_id = v_existing_gid;
    IF v_existing_count = array_length(p_booking_ids,1)
       AND (SELECT status FROM payment_groups WHERE id = v_existing_gid) IN ('pending','session_created') THEN
      RETURN QUERY SELECT v_existing_gid, (SELECT total_customer_amount FROM payment_groups WHERE id = v_existing_gid), true; RETURN;
    END IF;
    RAISE EXCEPTION 'bookings already in another payment group';
  END IF;

  INSERT INTO payment_groups(brand_id, retailer_id, total_customer_amount, platform_keeps_all, connect_account_id, status)
    VALUES (p_brand_id, p_retailer_id, 0, coalesce(p_platform_keeps_all,false), p_connect_account_id, 'pending')
    RETURNING id INTO v_gid;

  FOREACH v_bid IN ARRAY p_booking_ids LOOP
    -- lock the booking; verify ownership + payable state
    SELECT b.id, b.brand_id, b.retailer_id, b.venue_id, b.status, b.payment_status
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking % not found', v_bid; END IF;
    IF v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    IF v_bk.status <> 'pending_payment' OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;

    SELECT v.demo_fee INTO v_ven FROM venues v WHERE v.id = v_bk.venue_id;
    IF v_ven IS NULL OR v_ven.demo_fee IS NULL OR v_ven.demo_fee < 0 THEN RAISE EXCEPTION 'venue_missing_fee %', v_bid; END IF;
    v_venue := round(v_ven.demo_fee * 100)::int;
    v_fee   := CASE WHEN coalesce(p_platform_keeps_all,false) THEN 0 ELSE coalesce(p_platform_fee_cents,0) END;
    v_cust  := v_venue + v_fee;
    v_total := v_total + v_cust;

    INSERT INTO payment_allocations(payment_group_id, booking_id, customer_amount, venue_amount, platform_fee_amount)
      VALUES (v_gid, v_bid, v_cust, v_venue, v_fee);  -- UNIQUE(booking_id) blocks concurrent double-checkout
  END LOOP;

  UPDATE payment_groups SET total_customer_amount = v_total WHERE id = v_gid;
  RETURN QUERY SELECT v_gid, v_total, false;
END $$;

-- Reserve an exact refund against ONE allocation; concurrency-safe (row lock + remaining check).
CREATE OR REPLACE FUNCTION reserve_refund(
  p_booking_id uuid, p_amount integer, p_actor text, p_reason text, p_policy text
) RETURNS TABLE(refund_request_id uuid, idempotency_key text, stripe_payment_intent_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_alloc record; v_remaining int; v_rid uuid; v_key text; v_pi text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'amount must be positive'; END IF;
  SELECT a.*, g.stripe_payment_intent_id AS pi, g.status AS gstatus
    INTO v_alloc FROM payment_allocations a JOIN payment_groups g ON g.id = a.payment_group_id
    WHERE a.booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no allocation for booking'; END IF;
  IF v_alloc.pi IS NULL THEN RAISE EXCEPTION 'group not charged yet'; END IF;
  v_remaining := v_alloc.customer_amount - v_alloc.refunded_amount - v_alloc.reserved_refund_amount;
  IF p_amount > v_remaining THEN RAISE EXCEPTION 'amount exceeds refundable (% > %)', p_amount, v_remaining; END IF;

  UPDATE payment_allocations SET reserved_refund_amount = reserved_refund_amount + p_amount WHERE id = v_alloc.id;
  v_rid := gen_random_uuid();
  v_key := 'demohub-refund-v1:' || v_rid::text;
  INSERT INTO refund_requests(id, payment_allocation_id, booking_id, amount, actor, reason, policy_decision, status, stripe_idempotency_key)
    VALUES (v_rid, v_alloc.id, p_booking_id, p_amount, p_actor, p_reason, p_policy, 'reserved', v_key);
  RETURN QUERY SELECT v_rid, v_key, v_alloc.pi;
END $$;

-- Finalize a refund from a VERIFIED Stripe event: move reserved->refunded, set booking + group status.
CREATE OR REPLACE FUNCTION finalize_refund(
  p_stripe_refund_id text, p_status text, p_amount integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_req record; v_alloc record; v_grp uuid; v_all_refunded boolean;
BEGIN
  SELECT * INTO v_req FROM refund_requests WHERE stripe_refund_id = p_stripe_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'refund request not found for %', p_stripe_refund_id; END IF;
  IF v_req.status IN ('succeeded','failed','canceled') THEN RETURN; END IF;  -- already terminal (idempotent)
  SELECT * INTO v_alloc FROM payment_allocations WHERE id = v_req.payment_allocation_id FOR UPDATE;

  IF p_status = 'succeeded' THEN
    UPDATE payment_allocations
      SET reserved_refund_amount = greatest(0, reserved_refund_amount - v_req.amount),
          refunded_amount = refunded_amount + v_req.amount
      WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = 'succeeded' WHERE id = v_req.id;
    UPDATE bookings SET payment_status = CASE WHEN (v_alloc.refunded_amount + v_req.amount) >= v_alloc.customer_amount THEN 'refunded' ELSE 'partial_refund' END,
                        refund_id = p_stripe_refund_id, refunded_at = now()
      WHERE id = v_req.booking_id;
  ELSIF p_status IN ('failed','canceled') THEN
    UPDATE payment_allocations SET reserved_refund_amount = greatest(0, reserved_refund_amount - v_req.amount) WHERE id = v_alloc.id;
    UPDATE refund_requests SET status = p_status WHERE id = v_req.id;
  END IF;

  -- recompute group status
  v_grp := v_alloc.payment_group_id;
  SELECT bool_and(refunded_amount >= customer_amount) INTO v_all_refunded FROM payment_allocations WHERE payment_group_id = v_grp;
  UPDATE payment_groups SET status = CASE WHEN v_all_refunded THEN 'refunded'
                                          WHEN EXISTS (SELECT 1 FROM payment_allocations WHERE payment_group_id = v_grp AND refunded_amount > 0) THEN 'partially_refunded'
                                          ELSE status END
    WHERE id = v_grp;
END $$;

-- Transactional payment-success transition — never overwrites a refunded/cancelled booking to paid.
CREATE OR REPLACE FUNCTION apply_payment_success(
  p_payment_intent_id text, p_charge_id text
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_grp record; v_n int := 0;
BEGIN
  SELECT * INTO v_grp FROM payment_groups WHERE stripe_payment_intent_id = p_payment_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no payment group for pi %', p_payment_intent_id; END IF;
  UPDATE payment_groups SET status = 'paid', stripe_charge_id = coalesce(p_charge_id, stripe_charge_id) WHERE id = v_grp.id;
  UPDATE bookings b SET payment_status = 'paid', payment_intent_id = p_payment_intent_id, paid_at = now()
    FROM payment_allocations a
    WHERE a.payment_group_id = v_grp.id AND b.id = a.booking_id
      AND b.payment_status = 'unpaid' AND b.status = 'pending_payment';   -- never resurrect refunded/cancelled
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION reserve_refund(uuid,integer,text,text,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_refund(text,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION apply_payment_success(text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION reserve_refund(uuid,integer,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_refund(text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION apply_payment_success(text,text) TO service_role;

COMMIT;
