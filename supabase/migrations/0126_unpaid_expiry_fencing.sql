-- 0126_unpaid_expiry_fencing.sql (2026-11-22)
-- ============================================================================
-- Codex return review of 9891aba (verdict FIX): R1, R2 and R3. Forward-only on top of 0123 to 0125, which are applied
-- on demohub-rebuild-check and nowhere else and are not rewritten. The production paste carries 0123 to 0126 in ONE
-- transaction, so production never holds the expiry protocol without these corrections.
--
-- R1  api/provisional-sweep.js and the slot-contention bump still flipped an UNPAID held booking to 'expired' with a
--     plain PATCH after reading whether an open attempt existed. That is a second, unlocked expiry path beside 0123: it
--     ignored reserved attempts and raced a checkout between its read and its write. Now there is one rule per state:
--       unpaid (held or pending_payment)  -> bookings.unpaid_expires_at, through the unpaid sweep's locked protocol
--       authorized hold                   -> bookings.held_expires_at, through the existing provider-aware release
--     The sweep no longer touches an unpaid row. The bump goes through release_unpaid_held_booking, which holds the
--     group and booking locks and refuses while any attempt is live or the group is not quiescent.
--
-- R2  The worker decided "no checkout can still be running" from the reservation's ORIGINAL reserved_at. An old
--     reservation handed to a fresh retry just before the deadline was therefore failed at once, and the retry could
--     reach Stripe after capacity had been released. A reservation now carries a CREATION LEASE: every time
--     reserve_payment_attempt hands a reservation to a caller it stamps create_lease_until under the group lock, and
--     api/checkout.js sends its provider request only inside a shorter window measured on its own clock from before
--     that call, with a bounded request timeout. Expiry takes the same group lock first, so from its commit no lease is
--     granted or renewed. It then waits for the QUIESCENCE POINT before it concludes anything from the provider:
--         quiescent_at = greatest(expiry started, last lease this group granted) + lease + settle
--     Both the worker's provider search and finalize_unpaid_group_expiry are refused before that point.
--     Bounds (unpaid_expiry_lease_seconds = 90, unpaid_expiry_settle_seconds = 60): the handler sends no request later
--     than 30 s after it asked for the reservation and aborts it after 20 s, so nothing is sent later than 50 s after the
--     grant; the lease is 90 s; the provider is searched no sooner than 60 s after that. A request that was sent is
--     therefore visible to the search, and one that was not sent can no longer be. An unreadable or incomplete search
--     still blocks the group. The attempt key and the stored request (0125) are unchanged.
--
-- R3  A blocked group was offered again on every tick and sorted first, so more than a batch of blocked groups starved
--     everything behind them. A blocked group now gets a next-check time (the quiescence point when it waits for a
--     lease, otherwise an exponential backoff from 15 minutes to 6 hours), its reason, when it first blocked and how
--     often, and unpaid_expiry_due leaves it out until that time. Nothing is released to relieve a blockage.
--
-- No row of bookings is updated by this file. The deadline backfill of 0123 is not repeated or extended.
-- ============================================================================

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS create_lease_until timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expiry_next_check_at timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expiry_blocked_reason text;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expiry_blocked_since timestamptz;
ALTER TABLE payment_groups ADD COLUMN IF NOT EXISTS unpaid_expiry_blocked_count integer NOT NULL DEFAULT 0;

-- The two bounds, in one place. api/checkout.js asserts its own send window and timeout fit inside the lease.
CREATE OR REPLACE FUNCTION unpaid_expiry_lease_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 90 $$;
CREATE OR REPLACE FUNCTION unpaid_expiry_settle_seconds() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 60 $$;
CREATE OR REPLACE FUNCTION unpaid_expiry_quiescent_at(p_started timestamptz, p_lease_until timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT greatest(p_started + make_interval(secs => unpaid_expiry_lease_seconds()), coalesce(p_lease_until, p_started))
         + make_interval(secs => unpaid_expiry_settle_seconds())
$$;

-- ---------------------------------------------------------------------------
-- R2: reserve grants the lease; register refuses a new attempt for an expiring group
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_payment_attempt(p_group_id uuid, p_hash text, p_schema integer, p_request text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gstatus text; v_total int; v_sum int; v_live record; v_id uuid; v_gen int; v_started timestamptz; v_lease timestamptz;
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
    -- 0125: the request this attempt was FIRST created with is handed back; the caller sends that, never a rebuilt one.
    -- NULL means a reservation made before 0125, whose original request the ledger never held.
    -- 0126: a caller that is handed a RESERVATION may send one provider request for it, and only inside this lease.
    -- The lease is written under the group lock, so expiry (which takes the same lock) either sees it or prevents it.
    IF v_live.status = 'reserved' THEN
      UPDATE payment_attempts SET create_lease_until = now() + make_interval(secs => unpaid_expiry_lease_seconds()) WHERE id = v_live.id
        RETURNING create_lease_until INTO v_lease;
    END IF;
    RETURN jsonb_build_object('outcome', v_live.status, 'attempt_id', v_live.id, 'generation', v_live.generation, 'lease_until', v_lease,
                              'session_id', v_live.stripe_checkout_session_id, 'existing', true,
                              'request', v_live.provider_request, 'request_version', v_live.provider_request_version);
  END IF;

  SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
  INSERT INTO payment_attempts(payment_group_id, canonical_request_hash, request_schema_version, status, generation, reserved_at, create_lease_until, provider_request, provider_request_version)
    VALUES (p_group_id, p_hash, coalesce(p_schema,1), 'reserved', v_gen, now(), now() + make_interval(secs => unpaid_expiry_lease_seconds()), nullif(p_request, ''), CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END)
    RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'reserved', 'attempt_id', v_id, 'generation', v_gen, 'session_id', NULL, 'existing', false,
                            'lease_until', now() + make_interval(secs => unpaid_expiry_lease_seconds()),
                            'request', nullif(p_request, ''), 'request_version', CASE WHEN nullif(p_request, '') IS NULL THEN NULL ELSE 2 END);
END $$;

CREATE OR REPLACE FUNCTION register_payment_attempt(
  p_group_id uuid, p_session_id text, p_payment_intent text, p_hash text, p_schema integer
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_live record; v_id uuid; v_gstatus text; v_sum int; v_total int; v_gen int;
BEGIN
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN RAISE EXCEPTION 'session_required'; END IF;
  SELECT status, total_customer_amount INTO v_gstatus, v_total FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no_group %', p_group_id; END IF;
  IF v_gstatus NOT IN ('pending','session_created') THEN RAISE EXCEPTION 'group_not_attemptable %', v_gstatus; END IF;

  SELECT coalesce(sum(customer_amount),0) INTO v_sum FROM payment_allocations WHERE payment_group_id = p_group_id;
  IF v_sum <> v_total OR v_sum = 0 THEN RAISE EXCEPTION 'group_sum_mismatch % <> %', v_sum, v_total; END IF;

  SELECT * INTO v_live FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF FOUND THEN
    IF v_live.canonical_request_hash IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
    IF v_live.status = 'open' THEN
      -- an idempotent retry of the SAME session is reused; a different session against an open attempt is a fork
      IF v_live.stripe_checkout_session_id IS DISTINCT FROM p_session_id THEN RAISE EXCEPTION 'attempt_in_progress'; END IF;
      RETURN v_live.id;
    END IF;
    -- a reservation: bind the session to it (the session id is write-once; a second caller binding the same replayed
    -- session gets the same row back through the open branch above on its own call)
    UPDATE payment_attempts SET status = 'open', stripe_checkout_session_id = p_session_id,
           stripe_payment_intent_id = coalesce(stripe_payment_intent_id, p_payment_intent)
      WHERE id = v_live.id;
    v_id := v_live.id;
  ELSE
    -- 0126: binding a session to a live reservation is still allowed once expiry has begun (the worker then expires
    -- that session on the provider). Opening a NEW attempt with no reservation is not.
    IF EXISTS (SELECT 1 FROM payment_groups g WHERE g.id = p_group_id AND g.unpaid_expiry_started_at IS NOT NULL) THEN
      RAISE EXCEPTION 'unpaid_expired group';
    END IF;
    SELECT count(*) + 1 INTO v_gen FROM payment_attempts WHERE payment_group_id = p_group_id;
    INSERT INTO payment_attempts(payment_group_id, stripe_checkout_session_id, stripe_payment_intent_id, canonical_request_hash, request_schema_version, status, generation)
      VALUES (p_group_id, p_session_id, p_payment_intent, p_hash, coalesce(p_schema,1), 'open', v_gen)
      RETURNING id INTO v_id;
  END IF;
  -- mirror the LATEST session on the group for display; attempts remain authoritative for binding
  UPDATE payment_groups SET status = 'session_created' WHERE id = p_group_id;
  UPDATE payment_groups SET stripe_checkout_session_id = p_session_id
    WHERE id = p_group_id AND stripe_checkout_session_id IS NULL;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- R2, R3: begin reports the quiescence point; finalize refuses before it; both clear the schedule when done
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION begin_unpaid_group_expiry(p_group_id uuid, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_att record; v_due int; v_t timestamptz := coalesce(p_now, now()); v_started timestamptz; v_q timestamptz;
BEGIN
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.unpaid_expired_at IS NOT NULL THEN RETURN jsonb_build_object('outcome','already_expired'); END IF;
  -- a payment or an authorization that arrived first wins: nothing to expire
  IF v_g.status NOT IN ('pending','session_created') THEN
    -- the marker of an expiry that had begun is cleared, so the group is not offered to the worker again
    IF v_g.unpaid_expiry_started_at IS NOT NULL THEN
      UPDATE payment_groups SET unpaid_expiry_started_at = NULL, unpaid_expiry_next_check_at = NULL, unpaid_expiry_blocked_reason = NULL,
             unpaid_expiry_blocked_since = NULL, unpaid_expiry_blocked_count = 0 WHERE id = p_group_id;
    END IF;
    RETURN jsonb_build_object('outcome','not_open','status',v_g.status);
  END IF;
  IF v_g.unpaid_expiry_started_at IS NULL THEN
    SELECT count(*) INTO v_due FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id
     WHERE a.payment_group_id = p_group_id AND b.payment_status = 'unpaid' AND b.status IN ('pending_payment','held')
       AND b.unpaid_expires_at IS NOT NULL AND b.unpaid_expires_at <= v_t;
    IF v_due = 0 THEN RETURN jsonb_build_object('outcome','not_due'); END IF;
    UPDATE payment_groups SET unpaid_expiry_started_at = v_t WHERE id = p_group_id;
  END IF;
  v_started := coalesce(v_g.unpaid_expiry_started_at, v_t);
  SELECT * INTO v_att FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved') FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','expiring','live_attempt',NULL,'started_at',v_started,'quiescent',true); END IF;
  -- 0126 (R2): the point after which no checkout request can still be sending a provider request for this group.
  v_q := unpaid_expiry_quiescent_at(v_started, v_att.create_lease_until);
  RETURN jsonb_build_object('outcome','expiring','live_attempt', jsonb_build_object(
    'attempt_id', v_att.id, 'status', v_att.status, 'session_id', v_att.stripe_checkout_session_id,
    'generation', v_att.generation, 'reserved_at', v_att.reserved_at, 'created_at', v_att.created_at, 'create_lease_until', v_att.create_lease_until),
    'started_at', v_started, 'quiescent_at', v_q, 'quiescent', v_t >= v_q, 'seconds_to_quiescent', greatest(0, ceil(extract(epoch from (v_q - v_t))))::int);
END $$;

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
    UPDATE payment_groups SET unpaid_expiry_started_at = NULL, unpaid_expiry_next_check_at = NULL, unpaid_expiry_blocked_reason = NULL,
           unpaid_expiry_blocked_since = NULL, unpaid_expiry_blocked_count = 0 WHERE id = p_group_id;
    RETURN jsonb_build_object('outcome','payment_won','status',v_g.status);
  END IF;
  -- never release while a session may still charge, or while a creation outcome is unknown
  IF EXISTS (SELECT 1 FROM payment_attempts WHERE payment_group_id = p_group_id AND status IN ('open','reserved','authorized')) THEN
    RETURN jsonb_build_object('outcome','attempt_live');
  END IF;
  -- 0126 (R2): with no live attempt left, capacity is still not released before the quiescence point measured from the
  -- fence and from the last creation lease this group ever granted. A request that was handed a reservation just
  -- before the fence has by then either sent its provider request or lost the right to.
  IF v_t < unpaid_expiry_quiescent_at(v_g.unpaid_expiry_started_at,
       (SELECT max(create_lease_until) FROM payment_attempts WHERE payment_group_id = p_group_id)) THEN
    RETURN jsonb_build_object('outcome','not_quiescent');
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
  UPDATE payment_groups SET status = 'failed', unpaid_expired_at = v_t, unpaid_expiry_next_check_at = NULL, unpaid_expiry_blocked_reason = NULL,
         unpaid_expiry_blocked_since = NULL WHERE id = p_group_id;
  RETURN jsonb_build_object('outcome','expired','payment_group_id',p_group_id,'released',to_jsonb(v_released),'left_unchanged',to_jsonb(v_skipped));
END $$;

-- ---------------------------------------------------------------------------
-- R3: a fair queue. Blocked groups wait for their next-check time; everything else is offered oldest first.
-- ---------------------------------------------------------------------------
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
           coalesce(g.unpaid_expiry_next_check_at,
                    least(coalesce(g.unpaid_expiry_started_at, 'infinity'::timestamptz),
                          coalesce((SELECT min(d.unpaid_expires_at) FROM due d WHERE d.gid = g.id), 'infinity'::timestamptz))) AS at
      FROM payment_groups g, n
     WHERE g.unpaid_expired_at IS NULL
       AND (g.unpaid_expiry_started_at IS NOT NULL OR g.id IN (SELECT d.gid FROM due d WHERE d.gid IS NOT NULL))
       AND (g.unpaid_expiry_next_check_at IS NULL OR g.unpaid_expiry_next_check_at <= n.t)
  )
  SELECT x.booking_id, x.payment_group_id FROM (SELECT * FROM loose UNION ALL SELECT * FROM grouped) x
   ORDER BY x.at ASC LIMIT greatest(1, least(coalesce(p_limit, 25), 200));
$$;

-- The worker reports a group it could not finish. p_retry_seconds is the wait it knows (the time to the quiescence
-- point); NULL asks for the backoff: 15 minutes, doubling, at most 6 hours.
CREATE OR REPLACE FUNCTION note_unpaid_group_blocked(p_group_id uuid, p_reason text, p_retry_seconds integer DEFAULT NULL, p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_g record; v_t timestamptz := coalesce(p_now, now()); v_wait int; v_n int;
BEGIN
  SELECT * INTO v_g FROM payment_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_group'); END IF;
  IF v_g.unpaid_expired_at IS NOT NULL OR v_g.unpaid_expiry_started_at IS NULL THEN RETURN jsonb_build_object('outcome','not_expiring'); END IF;
  v_n := v_g.unpaid_expiry_blocked_count + 1;
  v_wait := CASE WHEN p_retry_seconds IS NOT NULL THEN least(greatest(p_retry_seconds, 15), 21600)
                 ELSE least(900 * (2 ^ least(v_g.unpaid_expiry_blocked_count, 5))::int, 21600) END;
  UPDATE payment_groups SET unpaid_expiry_blocked_reason = left(coalesce(p_reason,'blocked'), 80),
         unpaid_expiry_blocked_since = coalesce(unpaid_expiry_blocked_since, v_t),
         -- a wait for the quiescence point is the protocol working, not a failure: it does not lengthen the backoff
         unpaid_expiry_blocked_count = CASE WHEN p_retry_seconds IS NOT NULL THEN unpaid_expiry_blocked_count ELSE v_n END,
         unpaid_expiry_next_check_at = v_t + make_interval(secs => v_wait)
   WHERE id = p_group_id;
  RETURN jsonb_build_object('outcome','noted','next_check_in_seconds',v_wait);
END $$;

-- What an operator looks at: every group whose expiry has begun and not finished, with why and for how long.
CREATE OR REPLACE FUNCTION unpaid_expiry_blocked(p_now timestamptz DEFAULT NULL)
RETURNS TABLE(payment_group_id uuid, reason text, blocked_since timestamptz, blocked_minutes integer, blocked_count integer, next_check_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT g.id, g.unpaid_expiry_blocked_reason, g.unpaid_expiry_blocked_since,
         floor(extract(epoch from (coalesce(p_now, now()) - g.unpaid_expiry_blocked_since)) / 60)::int,
         g.unpaid_expiry_blocked_count, g.unpaid_expiry_next_check_at
    FROM payment_groups g
   WHERE g.unpaid_expiry_started_at IS NOT NULL AND g.unpaid_expired_at IS NULL AND g.unpaid_expiry_blocked_since IS NOT NULL
   ORDER BY g.unpaid_expiry_blocked_since ASC LIMIT 200;
$$;

-- ---------------------------------------------------------------------------
-- R1: the one locked way an unpaid HELD booking is released outside the deadline (the slot-contention bump)
-- ---------------------------------------------------------------------------
-- Lock order: group, then booking, as everywhere in 0123. The group id is read first without a lock (an allocation is
-- immutable once written) and confirmed again under the locks; a booking that gained a group in between answers 'retry'.
CREATE OR REPLACE FUNCTION release_unpaid_held_booking(p_booking_id uuid, p_target text DEFAULT 'expired', p_now timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_gid uuid; v_gid2 uuid; v_g record; v_bk record; v_n int; v_t timestamptz := coalesce(p_now, now());
BEGIN
  IF p_target NOT IN ('expired','declined','cancelled') THEN RAISE EXCEPTION 'invalid_target_status %', p_target; END IF;
  SELECT a.payment_group_id INTO v_gid FROM payment_allocations a WHERE a.booking_id = p_booking_id LIMIT 1;
  IF v_gid IS NOT NULL THEN
    SELECT * INTO v_g FROM payment_groups WHERE id = v_gid FOR UPDATE;
  END IF;
  SELECT b.status, b.payment_status, b.payment_intent_id INTO v_bk FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','no_booking'); END IF;
  IF v_bk.status <> 'held' OR v_bk.payment_status <> 'unpaid' THEN RETURN jsonb_build_object('outcome','not_unpaid_held','status',v_bk.status,'payment_status',v_bk.payment_status); END IF;
  IF v_bk.payment_intent_id IS NOT NULL THEN RETURN jsonb_build_object('outcome','has_payment_intent'); END IF;
  SELECT a.payment_group_id INTO v_gid2 FROM payment_allocations a WHERE a.booking_id = p_booking_id LIMIT 1;
  IF v_gid2 IS DISTINCT FROM v_gid THEN RETURN jsonb_build_object('outcome','retry'); END IF;
  IF v_gid IS NOT NULL THEN
    IF v_g.status NOT IN ('pending','session_created') THEN RETURN jsonb_build_object('outcome','group_not_open','status',v_g.status); END IF;
    -- never while a session may still charge, a creation outcome is unknown, or a request may still be on its way
    IF EXISTS (SELECT 1 FROM payment_attempts WHERE payment_group_id = v_gid AND status IN ('open','reserved','authorized')) THEN
      RETURN jsonb_build_object('outcome','attempt_live');
    END IF;
    IF EXISTS (SELECT 1 FROM payment_attempts WHERE payment_group_id = v_gid AND create_lease_until IS NOT NULL
                 AND v_t < create_lease_until + make_interval(secs => unpaid_expiry_settle_seconds())) THEN
      RETURN jsonb_build_object('outcome','not_quiescent');
    END IF;
    SELECT count(*) INTO v_n FROM payment_allocations WHERE payment_group_id = v_gid;
    IF v_n = 1 THEN
      -- the group existed for this booking alone: it is closed with it, so nothing can be reserved against it later
      UPDATE payment_groups SET status = 'failed', unpaid_expiry_started_at = coalesce(unpaid_expiry_started_at, v_t), unpaid_expired_at = v_t,
             unpaid_expiry_next_check_at = NULL, unpaid_expiry_blocked_reason = NULL, unpaid_expiry_blocked_since = NULL WHERE id = v_gid;
    END IF;
  END IF;
  UPDATE bookings SET status = p_target, held_expires_at = NULL WHERE id = p_booking_id;
  RETURN jsonb_build_object('outcome','released','booking_id',p_booking_id,'target',p_target);
END $$;

-- ---------------------------------------------------------------------------
-- Grants: service role only
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION reserve_payment_attempt(uuid,text,integer,text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION register_payment_attempt(uuid,text,text,text,integer) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION finalize_unpaid_group_expiry(uuid,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_due(integer,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION note_unpaid_group_blocked(uuid,text,integer,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_blocked(timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION release_unpaid_held_booking(uuid,text,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_quiescent_at(timestamptz,timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_lease_seconds() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION unpaid_expiry_settle_seconds() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION reserve_payment_attempt(uuid,text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION register_payment_attempt(uuid,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION begin_unpaid_group_expiry(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION finalize_unpaid_group_expiry(uuid,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_due(integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION note_unpaid_group_blocked(uuid,text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_blocked(timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION release_unpaid_held_booking(uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_quiescent_at(timestamptz,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_lease_seconds() TO service_role;
GRANT EXECUTE ON FUNCTION unpaid_expiry_settle_seconds() TO service_role;

-- ---------------------------------------------------------------------------
-- POST-CONDITION, read from the catalogs
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n int; v_def text;
BEGIN
  SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema='public'
     AND ((table_name='payment_attempts' AND column_name='create_lease_until')
       OR (table_name='payment_groups' AND column_name IN ('unpaid_expiry_next_check_at','unpaid_expiry_blocked_reason','unpaid_expiry_blocked_since','unpaid_expiry_blocked_count')));
  IF v_n <> 5 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: fencing and scheduling columns: % (expected 5)', v_n; END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public'
     AND p.proname IN ('reserve_payment_attempt','register_payment_attempt','begin_unpaid_group_expiry','finalize_unpaid_group_expiry','unpaid_expiry_due',
                       'note_unpaid_group_blocked','unpaid_expiry_blocked','release_unpaid_held_booking','unpaid_expiry_quiescent_at');
  IF v_n <> 9 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: % functions for 9 names (a missing function or an extra overload)', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='reserve_payment_attempt';
  IF position('create_lease_until' in v_def) = 0 OR position('provider_request' in v_def) = 0 OR position('unpaid_expired' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: reserve_payment_attempt lacks the lease or lost an earlier behaviour';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='register_payment_attempt';
  IF position('unpaid_expired' in v_def) = 0 OR position('attempt_in_progress' in v_def) = 0 OR position('reserved' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: register_payment_attempt lacks the expiry refusal or lost an earlier behaviour';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname='public' AND p.proname='finalize_unpaid_group_expiry';
  IF position('not_quiescent' in v_def) = 0 OR position('attempt_live' in v_def) = 0 OR position('payment_won' in v_def) = 0 THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: finalize_unpaid_group_expiry lacks the quiescence refusal or lost an earlier one';
  END IF;
  IF unpaid_expiry_lease_seconds() < 60 OR unpaid_expiry_settle_seconds() < 30 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: lease or settle bound too short'; END IF;
  IF has_function_privilege('anon', 'release_unpaid_held_booking(uuid,text,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'note_unpaid_group_blocked(uuid,text,integer,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'reserve_payment_attempt(uuid,text,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: anon or authenticated can execute a fencing function';
  END IF;
  RAISE NOTICE '0126: post-conditions passed';
END $$;
