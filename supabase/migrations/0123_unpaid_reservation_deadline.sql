-- 0123_unpaid_reservation_deadline.sql (2026-11-22)
-- ============================================================================
-- Codex brand-walk review and work order of 2026-11-21, item 2: a bounded unpaid reservation lifecycle.
-- Forward-only. Nothing earlier in the chain is rewritten.
--
-- The gap. An unpaid booking counts against a slot's capacity (0070) for as long as it is 'pending_payment' or 'held'.
-- Nothing ended that: provisional-sweep only looks at 'held' rows past held_expires_at and skips a brand whose
-- certificate is now covered; promote_held_bookings (0118) moves a covered held booking to 'pending_payment' and clears
-- held_expires_at; expire_payment_attempt (0036) expires the ATTEMPT and reopens the group, never the booking. A brand
-- that left the payment page, or never opened it, kept the store's slot indefinitely. Read-only trace on demohub-prod,
-- 2026-11-22 01:06 UTC: two bookings from the brand walk, both 'pending_payment' / 'unpaid' with held_expires_at NULL,
-- in one 'session_created' group with one 'open' attempt; hidden from both lists, still holding capacity.
--
-- The rule (David, 2026-11-22: "24 hours"). An unpaid booking has until unpaid_expires_at = created_at + 24 hours. The
-- deadline is set by the database on insert, never by a client, and never moves: not on a payment retry, not on
-- promotion from 'held', not on a new attempt. Bookings paid together share one immutable group, so a group ends when
-- its EARLIEST booking deadline passes and every unpaid booking in it ends with it.
--
-- The protocol. Expiry of a group is three separate steps, each safe to repeat, so that a timer firing never releases
-- capacity while a session may still charge:
--   1. begin_unpaid_group_expiry(group)   under the group row lock: stamps unpaid_expiry_started_at. From that commit
--      on, reserve_payment_attempt refuses the group (no new attempt, and an existing one is not handed back) and
--      checkout_claim_group refuses to reuse it. Nothing is released yet. Returns the live attempt, if any.
--   2. the worker settles the live attempt with the provider: an open session is expired on Stripe and then recorded
--      with expire_payment_attempt (0036); a reservation with no stored session id is only failed after the provider
--      has been searched for a session of this group (a missing id is not proof that no session exists). A session that
--      is complete is NOT touched: the payment wins through apply_verified_payment as before, because the group's
--      status is still payable.
--   3. finalize_unpaid_group_expiry(group) under the group row lock, then the booking locks in id order: refuses while
--      any attempt is live, yields to a payment that arrived (group no longer 'pending'/'session_created'), and only
--      then marks the unpaid bookings 'expired' (which is what frees capacity, 0066/0070) and the group 'failed'.
-- A booking with no payment group (checkout never started) is one step: expire_unpaid_booking, under its row lock,
-- which checkout_claim_group also takes before it creates a group.
--
-- A late payment after finalize cannot be applied to capacity that may have been given away: the attempt is 'expired'
-- or 'failed' and the bookings are not flippable, so apply_verified_payment opens its existing reconciliation case
-- (attempt_not_open, or the frozen-group case) and changes no booking. Nothing is deleted: bookings, allocations,
-- attempts and groups all stay, in terminal states.
--
-- Lock order. begin and finalize lock the payment_groups row first and bookings (finalize only) second, in id order:
-- the order apply_verified_payment and apply_verified_authorization use. checkout_claim_group and promote_held_bookings
-- lock bookings and only READ the group, so they cannot form a cycle with these. expire_unpaid_booking locks one booking
-- and no group. refund_reserve_cas locks booking, then allocation and group; it acts on paid bookings, which these
-- functions never select, and a cycle with it would be resolved by the database's deadlock detection and retried on
-- the next sweep.
--
-- Existing rows. Every booking that is unpaid and 'pending_payment' or 'held' when this file runs gets a deadline of
-- 24 hours from the later of its creation and this migration, so nothing expires the moment the file is applied.
-- No row is deleted or moved by this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The deadline column, set by the database
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS unpaid_expires_at timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expiry_started_at timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expired_at timestamptz;

CREATE OR REPLACE FUNCTION bookings_unpaid_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- server-owned: whatever a caller sent is replaced
    IF coalesce(NEW.payment_status,'unpaid') = 'unpaid' AND NEW.status IN ('pending_payment','held') THEN
      NEW.unpaid_expires_at := coalesce(NEW.created_at, now()) + interval '24 hours';
    ELSE
      NEW.unpaid_expires_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: the deadline never moves once set. It is not reset by a retry, a promotion or a direct write.
  IF NEW.unpaid_expires_at IS DISTINCT FROM OLD.unpaid_expires_at AND OLD.unpaid_expires_at IS NOT NULL THEN
    NEW.unpaid_expires_at := OLD.unpaid_expires_at;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bookings_unpaid_deadline_ins ON bookings;
CREATE TRIGGER trg_bookings_unpaid_deadline_ins BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_unpaid_deadline();
DROP TRIGGER IF EXISTS trg_bookings_unpaid_deadline_upd ON bookings;
CREATE TRIGGER trg_bookings_unpaid_deadline_upd BEFORE UPDATE OF unpaid_expires_at ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_unpaid_deadline();

-- Existing unpaid reservations: a full day from the later of creation and now. The update trigger only fires when the
-- old value is set, so this first write goes through.
UPDATE bookings
   SET unpaid_expires_at = greatest(coalesce(created_at, now()), now()) + interval '24 hours'
 WHERE unpaid_expires_at IS NULL AND payment_status = 'unpaid' AND status IN ('pending_payment','held');

CREATE INDEX IF NOT EXISTS bookings_unpaid_due_idx ON bookings (unpaid_expires_at)
  WHERE payment_status = 'unpaid' AND status IN ('pending_payment','held');
CREATE INDEX IF NOT EXISTS payment_groups_unpaid_expiring_idx ON payment_groups (unpaid_expiry_started_at)
  WHERE unpaid_expiry_started_at IS NOT NULL AND unpaid_expired_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. unpaid_expiry_due: what the worker should look at (read only)
-- ---------------------------------------------------------------------------
-- One row per due booking that has no payment group, and one row per group that is due or already expiring.
-- p_now exists for the controlled-clock tests; the scheduled worker never passes it.
CREATE OR REPLACE FUNCTION unpaid_expiry_due(p_limit integer DEFAULT 25, p_now timestamptz DEFAULT NULL)
RETURNS TABLE(booking_id uuid, payment_group_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (SELECT coalesce(p_now, now()) AS t),
  due AS (
    SELECT b.id, (SELECT a.payment_group_id FROM payment_allocations a WHERE a.booking_id = b.id LIMIT 1) AS gid, b.unpaid_expires_at
      FROM bookings b, n
     WHERE b.payment_status = 'unpaid' AND b.status IN ('pending_payment','held')
       AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= n.t
  ),
  loose AS (SELECT d.id AS booking_id, NULL::uuid AS payment_group_id, d.unpaid_expires_at AS at FROM due d WHERE d.gid IS NULL),
  grouped AS (
    SELECT NULL::uuid AS booking_id, g.id AS payment_group_id,
           least(coalesce(g.unpaid_expiry_started_at, 'infinity'::timestamptz),
                 coalesce((SELECT min(d.unpaid_expires_at) FROM due d WHERE d.gid = g.id), 'infinity'::timestamptz)) AS at
      FROM payment_groups g
     WHERE g.unpaid_expired_at IS NULL
       AND (g.unpaid_expiry_started_at IS NOT NULL OR g.id IN (SELECT d.gid FROM due d WHERE d.gid IS NOT NULL))
  )
  SELECT x.booking_id, x.payment_group_id FROM (SELECT * FROM loose UNION ALL SELECT * FROM grouped) x
   ORDER BY x.at ASC LIMIT greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- ---------------------------------------------------------------------------
-- 3. expire_unpaid_booking: a due booking that never reached checkout
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION expire_unpaid_booking(p_booking_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_gid uuid; v_t timestamptz := coalesce(p_now, now());
BEGIN
  SELECT b.id, b.status, b.payment_status, b.payment_intent_id, b.unpaid_expires_at INTO v_bk FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_booking'); END IF;
  IF v_bk.payment_status <> 'unpaid' OR v_bk.status NOT IN ('pending_payment','held') THEN
    RETURN jsonb_build_object('outcome','not_unpaid','status',v_bk.status,'payment_status',v_bk.payment_status);
  END IF;
  IF v_bk.unpaid_expires_at IS NULL OR v_bk.unpaid_expires_at > v_t THEN RETURN jsonb_build_object('outcome','not_due'); END IF;
  -- an authorization is never released by a timer here; that is the hold sweep's job, with the provider
  IF v_bk.payment_intent_id IS NOT NULL THEN RETURN jsonb_build_object('outcome','has_payment_intent'); END IF;
  -- allocations are only inserted by checkout_claim_group under this same row lock, so this read is authoritative
  SELECT a.payment_group_id INTO v_gid FROM payment_allocations a WHERE a.booking_id = p_booking_id LIMIT 1;
  IF v_gid IS NOT NULL THEN RETURN jsonb_build_object('outcome','has_group','payment_group_id',v_gid); END IF;
  UPDATE bookings SET status = 'expired', held_expires_at = NULL WHERE id = p_booking_id;
  RETURN jsonb_build_object('outcome','expired','booking_id',p_booking_id,'previous_status',v_bk.status);
END $$;

-- ---------------------------------------------------------------------------
-- 4. begin_unpaid_group_expiry: step 1, closes the group to new and reused attempts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION begin_unpaid_group_expiry(p_group_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_att record; v_due int; v_t timestamptz := coalesce(p_now, now());
BEGIN
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.unpaid_expired_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_expired'); END IF;
  -- a payment or an authorization that arrived first wins: nothing to expire
  IF v_g.status NOT IN ('pending','session_created') THEN
    -- the marker of an expiry that had begun is cleared, so the group is not offered to the worker again
    IF v_g.unpaid_expiry_started_at IS NOT NULL THEN UPDATE payment_groups SET unpaid_expiry_started_at = NULL WHERE id = p_group_id; END IF;
    RETURN jsonb_build_object('outcome','not_open','status',v_g.status);
  END IF;
  IF v_g.unpaid_expiry_started_at IS NULL THEN
    SELECT count(*) INTO v_due FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
     WHERE a.payment_group_id = p_group_id AND b.payment_status = 'unpaid' AND b.status IN ('pending_payment','held')
       AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= v_t;
    IF v_due = 0 THEN RETURN jsonb_build_object('outcome','not_due'); END IF;
    UPDATE payment_groups SET unpaid_expiry_started_at = v_t WHERE id = p_group_id;
  END IF;
  SELECT * INTO v_att FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','expiring','live_attempt',NULL); END IF;
  RETURN jsonb_build_object('outcome','expiring','live_attempt', jsonb_build_object(
    'attempt_id', v_att.id, 'status', v_att.status, 'session_id', v_att.stripe_checkout_session_id,
    'generation', v_att.generation, 'reserved_at', v_att.reserved_at, 'created_at', v_att.created_at));
END $$;

-- ---------------------------------------------------------------------------
-- 5. finalize_unpaid_group_expiry: step 3, releases capacity exactly once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION finalize_unpaid_group_expiry(p_group_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_bid uuid; v_bk record; v_ids uuid[]; v_released uuid[] := '{}'; v_skipped uuid[] := '{}'; v_t timestamptz := coalesce(p_now, now());
BEGIN
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.unpaid_expired_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_expired'); END IF;
  IF v_g.unpaid_expiry_started_at IS NULL THEN RETURN jsonb_build_object('outcome','not_begun'); END IF;
  -- a payment or an authorization that was applied after step 1 wins. The marker is cleared so the group reads as an
  -- ordinary paid or authorized group from here on.
  IF v_g.status NOT IN ('pending','session_created') THEN
    UPDATE payment_groups SET unpaid_expiry_started_at = NULL WHERE id = p_group_id;
    RETURN jsonb_build_object('outcome','payment_won','status',v_g.status);
  END IF;
  -- never release while a session may still charge, or while a creation outcome is unknown
  IF EXISTS (SELECT 1 FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved','authorized')) THEN
    RETURN jsonb_build_object('outcome','attempt_live');
  END IF;
  SELECT array_agg(a.booking_id ORDER BY a.booking_id) INTO v_ids FROM payment_allocations a WHERE a.payment_group_id = p_group_id;
  FOREACH v_bid IN ARRAY coalesce(v_ids, '{}'::uuid[]) LOOP
    SELECT b.status, b.payment_status, b.payment_intent_id INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF v_bk.payment_status = 'unpaid' AND v_bk.status IN ('pending_payment','held') AND v_bk.payment_intent_id IS NULL THEN
      UPDATE bookings SET status = 'expired', held_expires_at = NULL WHERE id = v_bid;
      v_released := v_released || v_bid;
    ELSE
      v_skipped := v_skipped || v_bid;   -- cancelled, declined, already expired, or carrying a payment intent: left as it is
    END IF;
  END LOOP;
  UPDATE payment_groups SET status = 'failed', unpaid_expired_at = v_t WHERE id = p_group_id;
  RETURN jsonb_build_object('outcome','expired','payment_group_id',p_group_id,'released',to_jsonb(v_released),'left_unchanged',to_jsonb(v_skipped));
END $$;

-- ---------------------------------------------------------------------------
-- 6. checkout_claim_group and reserve_payment_attempt: the same definitions as 0119 and 0120, plus the deadline checks
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
    SELECT b.id, b.brand_id, b.retailer_id, b.status, b.payment_status, b.unpaid_expires_at
      INTO v_bk FROM bookings b WHERE b.id = v_bid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking_set_mismatch %', v_bid; END IF;
    IF v_bk.brand_id IS NULL OR v_bk.brand_id <> p_brand_id THEN RAISE EXCEPTION 'not_your_booking %', v_bid; END IF;
    IF v_bk.retailer_id IS NULL OR v_bk.retailer_id <> p_retailer_id THEN RAISE EXCEPTION 'mixed_retailers'; END IF;
    -- payable means exactly this; "not held" is never read as "pending_payment and unpaid"
    IF v_bk.status NOT IN ('pending_payment','held') OR v_bk.payment_status <> 'unpaid' THEN RAISE EXCEPTION 'not_payable_state %', v_bid; END IF;
    -- 0123: an unpaid booking past its deadline is no longer payable, whether or not the sweep has reached it yet
    IF v_bk.unpaid_expires_at IS NOT NULL AND v_bk.unpaid_expires_at <= now() THEN RAISE EXCEPTION 'unpaid_expired %', v_bid; END IF;
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
    -- 0123: a group whose expiry has begun is never handed back as reusable
    IF v_g.unpaid_expiry_started_at IS NOT NULL THEN RAISE EXCEPTION 'unpaid_expired group'; END IF;
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

CREATE OR REPLACE FUNCTION reserve_payment_attempt(p_group_id uuid, p_hash text, p_schema integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gstatus text; v_total int; v_sum int; v_live record; v_id uuid; v_gen int; v_started timestamptz;
BEGIN
  IF p_group_id IS NULL OR p_hash IS NULL OR btrim(p_hash) = '' THEN RAISE EXCEPTION 'group_and_hash_required'; END IF;
  SELECT status, total_customer_amount, unpaid_expiry_started_at INTO v_gstatus, v_total, v_started FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;
  -- 0123: once expiry has begun for this group, no attempt is created and no existing attempt is handed back
  IF v_started IS NOT NULL THEN RAISE EXCEPTION 'unpaid_expired group'; END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
             WHERE a.payment_group_id = p_group_id AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= now()) THEN
    RAISE EXCEPTION 'unpaid_expired group';
  END IF;
  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    -- the immutable request snapshot of the live attempt must be the one the caller computed; a different snapshot
    -- (the store's routing changed after the claim) is refused, never silently forked
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    RETURN jsonb_build_object('outcome', v_live.status, 'attempt_id', v_live.id, 'generation', v_live.generation,
                              'session_id', v_live.stripe_checkout_session_id, 'existing', true);
  END IF;

  SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
  INSERT INTO payment_attempts(payment_group_id, canonical_request_hash, request_schema_version, status, generation, reserved_at)
    VALUES (p_group_id, p_hash, coalesce(p_schema,1), 'reserved', v_gen, now())
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'reserved', 'attempt_id', v_id, 'generation', v_gen, 'session_id', NULL, 'existing', false);
END $$;

-- ---------------------------------------------------------------------------
-- 7. Grants: service role only
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION unpaid_expiry_due(integer,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION expire_unpaid_booking(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_unpaid_group_expiry(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION bookings_unpaid_deadline() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION reserve_payment_attempt(uuid,text,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION unpaid_expiry_due(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION expire_unpaid_booking(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_unpaid_group_expiry(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION checkout_claim_group(uuid,uuid,uuid[],boolean,text,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt(uuid,text,integer) TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public'
     AND ((table_name='bookings' AND column_name='unpaid_expires_at')
       OR (table_name='payment_groups' AND column_name IN ('unpaid_expiry_started_at','unpaid_expired_at')));
  IF v_n <> 3 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: unpaid deadline columns: % (expected 3)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'bookings' AND t.tgname IN ('trg_bookings_unpaid_deadline_ins','trg_bookings_unpaid_deadline_upd') AND NOT t.tgisinternal;
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: unpaid deadline triggers: % (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public'
     AND p.proname IN ('unpaid_expiry_due','expire_unpaid_booking','begin_unpaid_group_expiry','finalize_unpaid_group_expiry');
  IF v_n <> 4 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: unpaid expiry functions: % (expected 4)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname IN ('checkout_claim_group','reserve_payment_attempt');
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: a re-created function has more than one overload (% for 2 names)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='checkout_claim_group';
  IF position('unpaid_expired' in v_def) = 0 OR position('not_payable_state' in v_def) = 0 OR position('capture_mode_stale' in v_def) = 0 OR position('connected_hold_unsupported' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: checkout_claim_group lacks the deadline check or lost an earlier refusal';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='reserve_payment_attempt';
  IF position('unpaid_expired' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 OR position('group_sum_mismatch' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: reserve_payment_attempt lacks the expiry refusal or lost an earlier refusal';
  END IF;
  IF has_function_privilege('anon', 'expire_unpaid_booking(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'finalize_unpaid_group_expiry(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'begin_unpaid_group_expiry(uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute an unpaid expiry function';
  END IF;
  SELECT count(*) INTO v_n FROM bookings WHERE payment_status = 'unpaid' AND status IN ('pending_payment','held') AND unpaid_expires_at IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: % unpaid reservations have no deadline', v_n; END IF;
  RAISE NOTICE '0123: post-conditions passed';
END $$;
