-- 0095_retailer_demo_move_corrections.sql
-- ============================================================================
-- Codex review of the retailer demo moves (RM-1 .. RM-7, 2026-10-16). 0094 is applied to the test
-- project and is left byte-for-byte as applied; every correction is forward, here.
--
-- RM-1  A declined or lapsed move must not cancel a NEWER schedule. bookings.pending_move_settlement
--       (the move id) is set in the same transaction that records the decline / lapse and blocks every
--       schedule-changing entry point (move_booking_by_retailer, propose_reschedule, accept_reschedule)
--       until the settlement is finalised. A pending move that a valid newer schedule supersedes
--       (accept_reschedule, or the booking's revision moving on) is retired atomically, never lapsed.
--       Settlement itself is CLAIMED under the booking-then-move lock (claim_move_settlement: tenant,
--       status, revision, lease) and FINALISED in one transaction (finalize_move_settlement).
-- RM-3  finalize_move_settlement stamps the move and inserts the brand's 'demo_move_cancelled' event in
--       ONE transaction, so a settled move can never lack its notification obligation.
-- RM-5  respond_booking_move enforces the deadline under the lock: at or after it, a confirmation is
--       refused and the move is lapsed (same entitlement as the worker); a decline after it is a lapse.
--       The deadline policy is ONE explicit function, move_reconfirm_deadline:
--           deadline = min(start, max(now + 12h, min(now + window, start - 24h)))
--       i.e. 72 hours, capped a day before the demo, but never under 12 hours, and never after the
--       demo starts. Used by the move and shown to the store before it commits.
-- RM-6  lapse_booking_moves verifies the booking's revision per row (a superseded move is retired,
--       not lapsed) and records lapsed_at; the application reports every claim/read failure.
-- RM-7  move creation sits behind RETAILER_MOVES_ENABLED (application); responses, lapses, settlement
--       and notifications never depend on it. Nothing here is removed on a rollback.
-- Forward-only. Idempotent. No row rewrites.
-- ============================================================================

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS pending_move_settlement uuid;
CREATE INDEX IF NOT EXISTS bookings_pending_move_settlement ON public.bookings (pending_move_settlement) WHERE pending_move_settlement IS NOT NULL;
COMMENT ON COLUMN public.bookings.pending_move_settlement IS
  '0095: the booking_moves.id whose decline/lapse is being settled (cancel + refund). While set, no schedule change may land.';

ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS refund_request_id uuid;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS lapsed_at timestamptz;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS settle_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS settle_last_error text;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS settle_lease_owner text;
ALTER TABLE public.booking_moves ADD COLUMN IF NOT EXISTS settle_lease_until timestamptz;
CREATE INDEX IF NOT EXISTS booking_moves_settle_queue ON public.booking_moves (settle_attempts, updated_at) WHERE status IN ('declined','lapsed') AND settled_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- The deadline policy (RM-5), pure.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_reconfirm_deadline(p_now timestamptz, p_start timestamptz, p_hours integer DEFAULT 72)
RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_start IS NULL THEN p_now + make_interval(hours => greatest(coalesce(p_hours, 72), 1))
    ELSE least(p_start,
               greatest(p_now + interval '12 hours',
                        least(p_now + make_interval(hours => greatest(coalesce(p_hours, 72), 1)), p_start - interval '24 hours')))
  END
$$;

-- ---------------------------------------------------------------------------------------------
-- move_booking_by_retailer (0094 body + RM-1 cancellation_pending + RM-5 deadline function).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.move_booking_by_retailer(
  p_demo_id uuid, p_retailer_id uuid, p_new_date date, p_new_time text DEFAULT NULL,
  p_note text DEFAULT NULL, p_actor text DEFAULT NULL, p_reconfirm_hours integer DEFAULT 72)
RETURNS TABLE(ok boolean, reason text, booking_id uuid, schedule_revision integer, move_id uuid, reconfirm_due_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid      uuid;
  v_b        bookings%ROWTYPE;
  v_d        demos%ROWTYPE;
  v_brand    brands%ROWTYPE;
  v_tz       text;
  v_today    date;
  v_new_time text;
  v_old_rev  integer;
  v_new_rev  integer;
  v_new_dur  integer;
  v_start    timestamptz;
  v_covered  boolean;
  v_note     text;
  v_due      timestamptz;
  v_move     uuid;
  v_hours    integer := greatest(coalesce(p_reconfirm_hours, 72), 1);
BEGIN
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND OR v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'not_active'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  -- RM-1: a decline / lapse is being settled (cancel + refund). No schedule change may land on top of it.
  IF v_b.pending_move_settlement IS NOT NULL THEN
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_bid, v_b.schedule_revision, v_b.pending_move_settlement, NULL::timestamptz; RETURN;
  END IF;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF length(coalesce(v_note, '')) > 500 THEN RETURN QUERY SELECT false, 'note_too_long'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_new_date IS NULL OR p_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  v_new_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);
  IF p_new_date = v_b.demo_date AND (
       v_new_time IS NOT DISTINCT FROM v_b.demo_time
       OR (booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT NULL
           AND booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT DISTINCT FROM booking_slot_start(v_b.demo_date, v_b.demo_time, v_tz, NULL))) THEN
    RETURN QUERY SELECT false, 'same_slot'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  SELECT * INTO v_brand FROM brands br WHERE br.id = coalesce(v_b.brand_id, v_d.brand_id);
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= p_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = p_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = v_bid
    RETURNING bookings.schedule_revision, bookings.duration_hours, bookings.start_at INTO v_new_rev, v_new_dur, v_start;
    IF v_start IS NULL THEN
      RAISE EXCEPTION 'unresolvable_start' USING errcode = 'check_violation';
    END IF;
    IF v_start <= now() THEN
      RAISE EXCEPTION 'time_in_past' USING errcode = 'check_violation';
    END IF;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_not_offered%' THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_outside_hours%' THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'date_blackout%' THEN RETURN QUERY SELECT false, 'date_blackout'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'venue_closed%' THEN RETURN QUERY SELECT false, 'venue_closed'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'slot_config_invalid%' THEN RETURN QUERY SELECT false, 'slot_config_invalid'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'venue_hours_not_set%' THEN RETURN QUERY SELECT false, 'venue_hours_not_set'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'invalid_local_time%' THEN RETURN QUERY SELECT false, 'invalid_local_time'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'time_in_past%' THEN RETURN QUERY SELECT false, 'time_in_past'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    IF SQLERRM LIKE 'unresolvable_start%' THEN RETURN QUERY SELECT false, 'unresolvable_start'::text, v_bid, v_old_rev, NULL::uuid, NULL::timestamptz; RETURN; END IF;
    RAISE;
  END;

  UPDATE demos
     SET demo_date = p_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- RM-5: ONE explicit policy, the same function the store sees before committing.
  v_due := move_reconfirm_deadline(now(), v_start, v_hours);

  UPDATE booking_moves SET status = 'superseded', updated_at = now()
   WHERE booking_moves.booking_id = v_bid AND booking_moves.status = 'pending';
  INSERT INTO booking_moves (booking_id, retailer_id, brand_id, demo_id, from_date, from_time, to_date, to_time, schedule_revision, note, moved_by, moved_at, reconfirm_due_at)
  VALUES (v_bid, p_retailer_id, coalesce(v_b.brand_id, v_d.brand_id), v_d.id, v_b.demo_date, v_b.demo_time, p_new_date, v_new_time, v_new_rev, v_note, p_actor, now(), v_due)
  RETURNING id INTO v_move;

  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, v_bid, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          v_bid::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', p_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'moved_by_retailer', true, 'move_id', v_move))
  ON CONFLICT (kind, transition_id) DO NOTHING;
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, v_bid, coalesce(v_b.brand_id, v_d.brand_id), 'demo_moved', v_move::text,
          jsonb_build_object('move_id', v_move, 'old_date', v_b.demo_date, 'old_time', v_b.demo_time,
                             'new_date', p_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'note', v_note, 'reconfirm_due_at', v_due, 'venue_id', v_b.venue_id, 'timezone', v_tz))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = v_bid::text || ':' || v_old_rev::text
     AND notification_deliveries.status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_bid, v_new_rev, v_move, v_due;
END $$;

-- ---------------------------------------------------------------------------------------------
-- respond_booking_move (RM-1 pending settlement, RM-5 deadline under the lock).
--   confirm before the deadline  -> 'confirmed'
--   decline before the deadline  -> 'declined', bookings.pending_move_settlement = move
--   anything at/after the deadline -> the move is 'lapsed' (pending settlement set); a confirmation is
--                                   refused with reason 'move_lapsed', a decline returns ok with 'lapsed'.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_booking_move(p_move_id uuid, p_brand_id uuid, p_decision text, p_actor text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, booking_id uuid, retailer_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE;
  v_b bookings%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('confirm', 'decline') THEN
    RETURN QUERY SELECT false, 'invalid_decision'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN;
  END IF;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id FOR UPDATE;
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_m.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF v_m.status <> 'pending' THEN
    RETURN QUERY SELECT false, ('move_' || v_m.status)::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') THEN
    RETURN QUERY SELECT false, 'booking_not_active'::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  IF v_b.schedule_revision IS DISTINCT FROM v_m.schedule_revision THEN
    UPDATE booking_moves SET status = 'superseded', updated_at = now() WHERE id = p_move_id;
    RETURN QUERY SELECT false, 'move_superseded'::text, v_m.booking_id, v_m.retailer_id, 'superseded'::text; RETURN;
  END IF;
  -- RM-5: the authoritative clock, under the lock. At or after the deadline the entitlement is the lapse.
  IF now() >= v_m.reconfirm_due_at THEN
    UPDATE booking_moves SET status = 'lapsed', lapsed_at = now(), responded_at = now(), responded_by = p_actor, updated_at = now() WHERE id = p_move_id;
    UPDATE bookings SET pending_move_settlement = p_move_id WHERE id = v_m.booking_id AND pending_move_settlement IS NULL;
    IF p_decision = 'confirm' THEN
      RETURN QUERY SELECT false, 'move_lapsed'::text, v_m.booking_id, v_m.retailer_id, 'lapsed'::text; RETURN;
    END IF;
    RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'lapsed'::text; RETURN;
  END IF;
  IF p_decision = 'confirm' THEN
    UPDATE booking_moves SET status = 'confirmed', responded_at = now(), responded_by = p_actor, updated_at = now() WHERE id = p_move_id;
    RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'confirmed'::text; RETURN;
  END IF;
  UPDATE booking_moves SET status = 'declined', responded_at = now(), responded_by = p_actor, updated_at = now() WHERE id = p_move_id;
  UPDATE bookings SET pending_move_settlement = p_move_id WHERE id = v_m.booking_id AND pending_move_settlement IS NULL;
  RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, 'declined'::text;
END $$;

-- ---------------------------------------------------------------------------------------------
-- lapse_booking_moves (RM-1 / RM-6): per row, booking-then-move lock, revision verified. A move whose
-- booking moved on or is no longer active is retired as 'superseded' (never settled); a genuine
-- lapse records lapsed_at and sets the booking's pending settlement. Bounded, SKIP LOCKED.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lapse_booking_moves(p_limit integer DEFAULT 25)
RETURNS SETOF public.booking_moves
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; v_b bookings%ROWTYPE; v_m booking_moves%ROWTYPE;
BEGIN
  FOR r IN
    SELECT m.id, m.booking_id FROM booking_moves m
     WHERE m.status = 'pending' AND m.reconfirm_due_at <= now()
     ORDER BY m.reconfirm_due_at ASC
     LIMIT greatest(coalesce(p_limit, 25), 1)
  LOOP
    SELECT * INTO v_b FROM bookings b WHERE b.id = r.booking_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO v_m FROM booking_moves m WHERE m.id = r.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR v_m.status <> 'pending' OR v_m.reconfirm_due_at > now() THEN CONTINUE; END IF;
    IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR v_b.schedule_revision IS DISTINCT FROM v_m.schedule_revision OR v_b.pending_move_settlement IS NOT NULL THEN
      UPDATE booking_moves SET status = 'superseded', updated_at = now() WHERE id = v_m.id;
      CONTINUE;
    END IF;
    UPDATE booking_moves SET status = 'lapsed', lapsed_at = now(), updated_at = now() WHERE id = v_m.id RETURNING * INTO v_m;
    UPDATE bookings SET pending_move_settlement = v_m.id WHERE id = v_b.id;
    RETURN NEXT v_m;
  END LOOP;
  RETURN;
END $$;

-- ---------------------------------------------------------------------------------------------
-- claim_move_settlement (RM-1 / RM-4): the durable settlement claim. Booking-then-move lock; tenant,
-- status, revision and lease validated atomically. Returns the booking facts the application needs
-- for the money step; the lease stops a second worker (or the response route) from settling the same
-- move concurrently. A move whose booking moved on while it was still active is retired here.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_move_settlement(p_move_id uuid, p_owner text, p_lease_seconds integer DEFAULT 180)
RETURNS TABLE(ok boolean, reason text, move jsonb, booking jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE; v_b bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::jsonb; RETURN; END IF;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'booking_missing'::text, to_jsonb(v_m), NULL::jsonb; RETURN; END IF;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id FOR UPDATE;
  IF v_m.status NOT IN ('declined', 'lapsed') THEN RETURN QUERY SELECT false, ('move_' || v_m.status)::text, to_jsonb(v_m), to_jsonb(v_b); RETURN; END IF;
  IF v_m.settled_at IS NOT NULL THEN RETURN QUERY SELECT false, 'already_settled'::text, to_jsonb(v_m), to_jsonb(v_b); RETURN; END IF;
  IF v_b.retailer_id IS DISTINCT FROM v_m.retailer_id THEN RETURN QUERY SELECT false, 'tenant_mismatch'::text, to_jsonb(v_m), to_jsonb(v_b); RETURN; END IF;
  IF v_m.settle_lease_until IS NOT NULL AND v_m.settle_lease_until > now() AND v_m.settle_lease_owner IS DISTINCT FROM p_owner THEN
    RETURN QUERY SELECT false, 'lease_held'::text, to_jsonb(v_m), to_jsonb(v_b); RETURN;
  END IF;
  -- The booking must still be the schedule this move produced, or already inactive (a settlement that
  -- cancelled it and crashed before finalising). A different ACTIVE revision means a valid newer
  -- schedule landed; this move is retired and must never cancel it.
  IF coalesce(v_b.status, 'pending') IN ('pending', 'confirmed') AND v_b.schedule_revision IS DISTINCT FROM v_m.schedule_revision THEN
    UPDATE booking_moves SET status = 'superseded', settle_lease_owner = NULL, settle_lease_until = NULL, updated_at = now() WHERE id = p_move_id;
    UPDATE bookings SET pending_move_settlement = NULL WHERE id = v_b.id AND pending_move_settlement = p_move_id;
    RETURN QUERY SELECT false, 'revision_mismatch'::text, to_jsonb(v_m), to_jsonb(v_b); RETURN;
  END IF;
  IF coalesce(v_b.status, 'pending') IN ('pending', 'confirmed') AND v_b.pending_move_settlement IS DISTINCT FROM p_move_id THEN
    -- The booking was never marked for this settlement (an older row shape); mark it now so no schedule change lands.
    UPDATE bookings SET pending_move_settlement = p_move_id WHERE id = v_b.id AND pending_move_settlement IS NULL;
  END IF;
  UPDATE booking_moves
     SET settle_lease_owner = p_owner, settle_lease_until = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 180))), updated_at = now()
   WHERE id = p_move_id
  RETURNING * INTO v_m;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id;
  RETURN QUERY SELECT true, NULL::text, to_jsonb(v_m), to_jsonb(v_b);
END $$;
REVOKE ALL ON FUNCTION public.claim_move_settlement(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_move_settlement(uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- finalize_move_settlement (RM-2 / RM-3): ONE transaction, lease verified.
--   p_settled = true : settled_at, refund_status, refund_request_id, case id; the booking's pending
--                      settlement cleared; the brand's 'demo_move_cancelled' event inserted (idempotent,
--                      payload states the persisted financial state).
--   p_settled = false: attempts + 1, last error, lease released, nothing else (the next sweep retries).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_move_settlement(
  p_move_id uuid, p_owner text, p_settled boolean, p_refund_status text DEFAULT NULL, p_refund_request_id uuid DEFAULT NULL,
  p_case_id uuid DEFAULT NULL, p_error text DEFAULT NULL, p_event_payload jsonb DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, event_written boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m booking_moves%ROWTYPE; v_b bookings%ROWTYPE; v_n integer := 0;
BEGIN
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, false; RETURN; END IF;
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_m.booking_id FOR UPDATE;
  SELECT * INTO v_m FROM booking_moves m WHERE m.id = p_move_id FOR UPDATE;
  IF v_m.settle_lease_owner IS DISTINCT FROM p_owner THEN RETURN QUERY SELECT false, 'lease_lost'::text, false; RETURN; END IF;
  IF v_m.settled_at IS NOT NULL THEN RETURN QUERY SELECT false, 'already_settled'::text, false; RETURN; END IF;
  IF NOT coalesce(p_settled, false) THEN
    UPDATE booking_moves
       SET settle_attempts = settle_attempts + 1, settle_last_error = left(coalesce(p_error, 'unknown'), 300),
           refund_request_id = coalesce(p_refund_request_id, refund_request_id), reconciliation_case_id = coalesce(p_case_id, reconciliation_case_id),
           refund_status = coalesce(p_refund_status, refund_status),
           settle_lease_owner = NULL, settle_lease_until = NULL, updated_at = now()
     WHERE id = p_move_id;
    RETURN QUERY SELECT true, NULL::text, false; RETURN;
  END IF;
  UPDATE booking_moves
     SET settled_at = now(), refund_status = p_refund_status, refund_request_id = coalesce(p_refund_request_id, refund_request_id),
         reconciliation_case_id = coalesce(p_case_id, reconciliation_case_id), settle_last_error = NULL,
         settle_lease_owner = NULL, settle_lease_until = NULL, updated_at = now()
   WHERE id = p_move_id;
  UPDATE bookings SET pending_move_settlement = NULL WHERE id = v_m.booking_id AND pending_move_settlement = p_move_id;
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_m.retailer_id, v_m.booking_id, coalesce(v_m.brand_id, v_b.brand_id), 'demo_move_cancelled', p_move_id::text || ':cancelled',
          coalesce(p_event_payload, '{}'::jsonb) || jsonb_build_object('move_id', p_move_id, 'outcome', v_m.status, 'refund_status', p_refund_status,
                                                                      'refund_request_id', coalesce(p_refund_request_id, v_m.refund_request_id),
                                                                      'to_date', v_m.to_date, 'to_time', v_m.to_time, 'from_date', v_m.from_date, 'from_time', v_m.from_time, 'note', v_m.note))
  ON CONFLICT (kind, transition_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN QUERY SELECT true, NULL::text, v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_move_settlement(uuid, text, boolean, text, uuid, uuid, text, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- propose_reschedule (0074 body + RM-1 cancellation_pending).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_reschedule(p_demo_id uuid, p_retailer_id uuid, p_new_date date, p_new_time text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, proposal_version integer, booking_id uuid, new_time text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid  uuid;
  v_b    bookings%ROWTYPE;
  v_d    demos%ROWTYPE;
  v_tz   text;
  v_ver  integer;
  v_time text;
BEGIN
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;

  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid OR v_d.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') OR coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') THEN
    RETURN QUERY SELECT false, 'not_active'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;
  -- RM-1 (0095): no schedule change while a declined / lapsed move is being settled.
  IF v_b.pending_move_settlement IS NOT NULL THEN
    RETURN QUERY SELECT false, 'cancellation_pending'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  IF p_new_date IS NULL OR p_new_date < (now() AT TIME ZONE coalesce(nullif(v_tz, ''), 'America/Los_Angeles'))::date THEN
    RETURN QUERY SELECT false, 'date_in_past'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;
  v_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);

  UPDATE demos
     SET reschedule_to_date = p_new_date, reschedule_to_time = v_time, reschedule_requested_at = now()
   WHERE id = p_demo_id;
  UPDATE bookings
     SET reschedule_proposal_version = reschedule_proposal_version + 1
   WHERE id = v_bid
  RETURNING reschedule_proposal_version INTO v_ver;

  RETURN QUERY SELECT true, NULL::text, v_ver, v_bid, v_time;
END $$;

-- ---------------------------------------------------------------------------------------------
-- accept_reschedule (0076 body + RM-1: cancellation_pending refusal; a pending retailer move is
-- superseded atomically when the brand-accepted schedule lands).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_reschedule(p_booking_id uuid, p_brand_id uuid, p_proposal_version integer)
RETURNS TABLE(ok boolean, reason text, schedule_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b        bookings%ROWTYPE;
  v_d        demos%ROWTYPE;
  v_brand    brands%ROWTYPE;
  v_tz       text;
  v_today    date;
  v_new_date date;
  v_new_time text;
  v_old_rev  integer;
  v_new_rev  integer;
  v_new_dur  integer;
  v_covered  boolean;
BEGIN
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_demo'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_d.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_b.schedule_revision; RETURN;
  END IF;
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'cancelled'::text, v_b.schedule_revision; RETURN;
  END IF;
  -- RM-1 (0095): no schedule change while a declined / lapsed move is being settled.
  IF v_b.pending_move_settlement IS NOT NULL THEN
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_b.schedule_revision; RETURN;
  END IF;
  IF v_d.reschedule_to_date IS NULL THEN RETURN QUERY SELECT false, 'no_proposal'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_proposal_version IS NULL OR v_b.reschedule_proposal_version <> p_proposal_version THEN
    RETURN QUERY SELECT false, 'stale_proposal'::text, v_b.schedule_revision; RETURN;
  END IF;

  v_new_date := v_d.reschedule_to_date;
  v_new_time := coalesce(nullif(btrim(v_d.reschedule_to_time), ''), v_b.demo_time, v_d.demo_time);

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = v_b.retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF v_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_b.schedule_revision; RETURN; END IF;

  SELECT * INTO v_brand FROM brands br WHERE br.id = p_brand_id;
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= v_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_b.schedule_revision; RETURN; END IF;

  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = v_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = p_booking_id
    RETURNING bookings.schedule_revision, bookings.duration_hours INTO v_new_rev, v_new_dur;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_not_offered%' THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_outside_hours%' THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'date_blackout%' THEN RETURN QUERY SELECT false, 'date_blackout'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'venue_closed%' THEN RETURN QUERY SELECT false, 'venue_closed'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_config_invalid%' THEN RETURN QUERY SELECT false, 'slot_config_invalid'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'venue_hours_not_set%' THEN RETURN QUERY SELECT false, 'venue_hours_not_set'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'invalid_local_time%' THEN RETURN QUERY SELECT false, 'invalid_local_time'::text, v_old_rev; RETURN; END IF;
    RAISE;
  END;

  UPDATE demos
     SET demo_date = v_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- RM-1 (0095): a valid newer schedule retires any unanswered retailer move atomically.
  UPDATE booking_moves SET status = 'superseded', updated_at = now()
   WHERE booking_moves.booking_id = p_booking_id AND booking_moves.status = 'pending';

  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, p_booking_id, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          p_booking_id::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', v_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'proposal_version', p_proposal_version))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = p_booking_id::text || ':' || v_old_rev::text
     AND status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_new_rev;
END $$;

-- Post-conditions (literal-only).
DO $$
DECLARE v_fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'pending_move_settlement') THEN RAISE EXCEPTION '0095 postcondition: bookings.pending_move_settlement missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_moves' AND column_name = 'settle_lease_until') THEN RAISE EXCEPTION '0095 postcondition: booking_moves settlement columns missing'; END IF;
  FOREACH v_fn IN ARRAY ARRAY['move_reconfirm_deadline', 'claim_move_settlement', 'finalize_move_settlement', 'move_booking_by_retailer', 'respond_booking_move', 'lapse_booking_moves', 'propose_reschedule', 'accept_reschedule'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = v_fn) THEN RAISE EXCEPTION '0095 postcondition: % missing', v_fn; END IF;
  END LOOP;
  IF position('cancellation_pending' IN pg_get_functiondef('public.accept_reschedule(uuid, uuid, integer)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0095 postcondition: accept_reschedule lacks the cancellation_pending rule'; END IF;
  IF position('cancellation_pending' IN pg_get_functiondef('public.propose_reschedule(uuid, uuid, date, text)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0095 postcondition: propose_reschedule lacks the cancellation_pending rule'; END IF;
  IF position('move_reconfirm_deadline' IN pg_get_functiondef('public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)'::regprocedure)) = 0 THEN RAISE EXCEPTION '0095 postcondition: move_booking_by_retailer does not use the deadline policy'; END IF;
  IF move_reconfirm_deadline('2026-01-01T00:00:00Z', '2026-01-01T06:00:00Z', 72) <> '2026-01-01T06:00:00Z'::timestamptz THEN RAISE EXCEPTION '0095 postcondition: deadline policy (start 6h) wrong'; END IF;
  IF move_reconfirm_deadline('2026-01-01T00:00:00Z', '2026-01-01T18:00:00Z', 72) <> '2026-01-01T12:00:00Z'::timestamptz THEN RAISE EXCEPTION '0095 postcondition: deadline policy (start 18h) wrong'; END IF;
  IF move_reconfirm_deadline('2026-01-01T00:00:00Z', '2026-01-02T12:00:00Z', 72) <> '2026-01-01T12:00:00Z'::timestamptz THEN RAISE EXCEPTION '0095 postcondition: deadline policy (start 36h) wrong'; END IF;
  IF move_reconfirm_deadline('2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z', 72) <> '2026-01-04T00:00:00Z'::timestamptz THEN RAISE EXCEPTION '0095 postcondition: deadline policy (start 96h) wrong'; END IF;
  IF move_reconfirm_deadline('2026-01-01T00:00:00Z', '2026-01-10T00:00:00Z', 72) <> '2026-01-04T00:00:00Z'::timestamptz THEN RAISE EXCEPTION '0095 postcondition: deadline policy (start 9d) wrong'; END IF;
END $$;
