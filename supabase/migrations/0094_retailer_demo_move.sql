-- 0094_retailer_demo_move.sql
-- ============================================================================
-- Retailer-initiated demo moves with brand reconfirmation (David, 2026-10-16).
--
-- THE PRODUCT RULE. The store owns its calendar. A retailer may move a confirmed (or paid pending) demo
-- to any slot its location offers, immediately, without asking the brand first. The brand is told at
-- once and has a reconfirmation window (72 hours, compressed when the new demo is closer) to say
-- "we'll be there" or "we can't make it". Silence at the deadline, or a "can't make it", cancels the
-- demo with a FULL refund to the brand (the store changed the terms; a kept charge is a chargeback).
-- The retailer's existing "propose a new date" flow (0074 propose_reschedule / accept_reschedule) is
-- kept for stores that prefer to ask first.
--
-- WHAT THIS ADDS
--   * booking_moves: one row per move, the audit trail and the reconfirmation state machine
--       pending    -> confirmed  (brand confirmed)
--                  -> declined   (brand cannot make it; the application cancels + refunds, settled_at set)
--                  -> lapsed     (deadline passed; the worker cancels + refunds, settled_at set)
--                  -> superseded (the store moved the same booking again before the brand answered)
--     At most ONE pending move per booking (partial unique index).
--   * move_booking_by_retailer(): the ONE transaction that moves a booking on the store's authority.
--     Same body as accept_reschedule (lock, active check, COI on the new date, the 0070/0075 slot and
--     capacity triggers through the UPDATE, projection, demo_rescheduled event for the store contacts,
--     retire the old occurrence's deliveries) plus: any open proposal is cleared, any earlier pending
--     move is superseded, the move row is written with its deadline, and a 'demo_moved' event is
--     written for the brand (fanned out and sent by the notification outbox; nothing is sent here).
--     No lead-time rule and no "how close is the demo" rule: the store decides. The only time rule is
--     that the new start must be in the future.
--   * respond_booking_move(): the brand's answer (confirm | decline), authorised by the brand that owns
--     the booking, refused when the move is no longer pending or the booking is no longer active.
--     A decline records the answer; the cancellation and refund happen in the application through the
--     existing ledger-backed refund path (refund_reserve_cas) and booking_transition, and are retried
--     by the refund worker until settled_at is set.
--   * notification_events kind CHECK admits 'demo_moved' (brand: your demo was moved, please confirm)
--     and 'demo_move_cancelled' (brand: it was cancelled, refund submitted). Reminders before the
--     deadline are worker-scheduled deliveries (kind 'demo_move_reminder', no event row).
-- Forward-only. Idempotent. No row rewrites. 0074 / 0076 functions untouched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.booking_moves (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid        NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  retailer_id        uuid        NOT NULL,
  brand_id           uuid,
  demo_id            uuid,
  from_date          date,
  from_time          text,
  to_date            date        NOT NULL,
  to_time            text,
  schedule_revision  integer     NOT NULL,                 -- the revision the move produced
  note               text,                                 -- the store's note to the brand (<= 500 chars)
  moved_by           text,                                 -- staff email
  moved_at           timestamptz NOT NULL DEFAULT now(),
  reconfirm_due_at   timestamptz NOT NULL,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','lapsed','superseded')),
  responded_at       timestamptz,
  responded_by       text,
  settled_at         timestamptz,                          -- declined/lapsed: cancellation + refund step completed
  refund_status      text,                                 -- what the settlement did: submitted | not_paid | refund_failed | auth_released
  reconciliation_case_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_moves_one_pending ON public.booking_moves (booking_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS booking_moves_due ON public.booking_moves (reconfirm_due_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS booking_moves_unsettled ON public.booking_moves (status) WHERE status IN ('declined','lapsed') AND settled_at IS NULL;
CREATE INDEX IF NOT EXISTS booking_moves_brand ON public.booking_moves (brand_id, status);
CREATE INDEX IF NOT EXISTS booking_moves_retailer ON public.booking_moves (retailer_id, status);
REVOKE ALL ON TABLE public.booking_moves FROM public, anon, authenticated;
GRANT ALL ON TABLE public.booking_moves TO service_role;

ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check;
ALTER TABLE public.notification_events
  ADD CONSTRAINT notification_events_kind_check
  CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected','owner_booking_created','payment_receipt',
                  'demo_moved','demo_move_cancelled'));

-- ---------------------------------------------------------------------------------------------
-- move_booking_by_retailer: the store moves a demo now. Returns ok=false with a reason and NO side
-- effect for every refusal (the UPDATE is rolled back by the plpgsql sub-transaction on a trigger
-- refusal, and nothing after it has run).
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
  -- 1. The projection row names the booking; the retailer must own both.
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  -- 2. Lock order: bookings row, then demos row (the same order as accept_reschedule / booking_transition).
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND OR v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid, NULL::integer, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  -- 3. Only a live booking with a live projection moves.
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'not_active'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  -- 4. Inputs.
  v_note := nullif(btrim(coalesce(p_note, '')), '');
  IF length(coalesce(v_note, '')) > 500 THEN RETURN QUERY SELECT false, 'note_too_long'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF p_new_date IS NULL OR p_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;
  v_new_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);
  -- "Same slot" is judged on the resolved instant, not the label ('10:00' and '10:00 AM' are one slot).
  IF p_new_date = v_b.demo_date AND (
       v_new_time IS NOT DISTINCT FROM v_b.demo_time
       OR (booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT NULL
           AND booking_slot_start(p_new_date, v_new_time, v_tz, NULL) IS NOT DISTINCT FROM booking_slot_start(v_b.demo_date, v_b.demo_time, v_tz, NULL))) THEN
    RETURN QUERY SELECT false, 'same_slot'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN;
  END IF;

  -- 5. COI on the NEW date (the canonical rule of api/_coi-policy.js, as in accept_reschedule).
  SELECT * INTO v_brand FROM brands br WHERE br.id = coalesce(v_b.brand_id, v_d.brand_id);
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= p_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_bid, v_b.schedule_revision, NULL::uuid, NULL::timestamptz; RETURN; END IF;

  -- 6. Move the AUTHORITATIVE row. The slot-resolve and capacity triggers refuse an unoffered, blocked,
  --    closed or full slot with check_violation; the sub-transaction rolls the UPDATE back and the
  --    reason is returned. A same-day move to a start already in the past is refused the same way.
  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = p_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = v_bid
    RETURNING bookings.schedule_revision, bookings.duration_hours, bookings.start_at INTO v_new_rev, v_new_dur, v_start;
    IF v_start IS NOT NULL AND v_start <= now() THEN
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
    RAISE;
  END;

  -- 7. Project onto the calendar row; any open "ask first" proposal is consumed by the move.
  UPDATE demos
     SET demo_date = p_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- 8. The reconfirmation deadline: the window, but never later than a day before the new start, and
  --    never shorter than 12 hours (a demo inside the next day keeps the start itself as the deadline).
  v_due := now() + make_interval(hours => v_hours);
  IF v_start IS NOT NULL THEN
    v_due := least(v_due, v_start - interval '24 hours');
    IF v_due < now() + interval '12 hours' THEN v_due := least(now() + interval '12 hours', v_start); END IF;
  END IF;

  -- 9. An earlier unanswered move on this booking is superseded by this one; then the new move row.
  UPDATE booking_moves SET status = 'superseded', updated_at = now()
   WHERE booking_moves.booking_id = v_bid AND booking_moves.status = 'pending';
  INSERT INTO booking_moves (booking_id, retailer_id, brand_id, demo_id, from_date, from_time, to_date, to_time, schedule_revision, note, moved_by, moved_at, reconfirm_due_at)
  VALUES (v_bid, p_retailer_id, coalesce(v_b.brand_id, v_d.brand_id), v_d.id, v_b.demo_date, v_b.demo_time, p_new_date, v_new_time, v_new_rev, v_note, p_actor, now(), v_due)
  RETURNING id INTO v_move;

  -- 10. Events: the store contacts' "rescheduled" notice (existing kind, existing mail) and the brand's
  --     "your demo was moved, please confirm" notice (new kind). Both fanned out by the outbox worker.
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

  -- 11. Retire every not-yet-sent delivery of the OLD occurrence (as accept_reschedule does).
  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = v_bid::text || ':' || v_old_rev::text
     AND notification_deliveries.status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_bid, v_new_rev, v_move, v_due;
END $$;
REVOKE ALL ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- respond_booking_move: the brand answers. confirm -> 'confirmed'. decline -> 'declined' (the
-- application then cancels and refunds; the refund worker retries until settled_at is set).
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
  -- Lock the booking first (the same order as every other booking transaction), then the move row.
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
    -- The booking moved again after this move row (should have been superseded); never act on it.
    RETURN QUERY SELECT false, 'move_superseded'::text, v_m.booking_id, v_m.retailer_id, v_m.status; RETURN;
  END IF;
  UPDATE booking_moves
     SET status = CASE WHEN p_decision = 'confirm' THEN 'confirmed' ELSE 'declined' END,
         responded_at = now(), responded_by = p_actor, updated_at = now()
   WHERE id = p_move_id;
  RETURN QUERY SELECT true, NULL::text, v_m.booking_id, v_m.retailer_id, CASE WHEN p_decision = 'confirm' THEN 'confirmed' ELSE 'declined' END;
END $$;
REVOKE ALL ON FUNCTION public.respond_booking_move(uuid, uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_booking_move(uuid, uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- lapse_booking_moves: the worker's claim of due moves. Marks pending moves past their deadline as
-- 'lapsed' (unsettled) and returns them, so the application cancels and refunds each one exactly once
-- per row and the refund worker retries any row left without settled_at. Bounded.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lapse_booking_moves(p_limit integer DEFAULT 25)
RETURNS SETOF public.booking_moves
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT m.id FROM booking_moves m
     WHERE m.status = 'pending' AND m.reconfirm_due_at <= now()
     ORDER BY m.reconfirm_due_at ASC
     LIMIT greatest(coalesce(p_limit, 25), 1)
       FOR UPDATE SKIP LOCKED
  )
  UPDATE booking_moves bm
     SET status = 'lapsed', updated_at = now()
    FROM due
   WHERE bm.id = due.id
  RETURNING bm.*;
END $$;
REVOKE ALL ON FUNCTION public.lapse_booking_moves(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lapse_booking_moves(integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  IF to_regclass('public.booking_moves') IS NULL THEN RAISE EXCEPTION '0094 postcondition: booking_moves missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'booking_moves_one_pending') THEN RAISE EXCEPTION '0094 postcondition: booking_moves_one_pending missing'; END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint WHERE conname = 'notification_events_kind_check' AND conrelid = 'public.notification_events'::regclass;
  IF v_def IS NULL OR position('demo_moved' IN v_def) = 0 OR position('demo_move_cancelled' IN v_def) = 0 THEN RAISE EXCEPTION '0094 postcondition: events kind check lacks the move kinds'; END IF;
  IF position('payment_receipt' IN v_def) = 0 OR position('owner_booking_created' IN v_def) = 0 THEN RAISE EXCEPTION '0094 postcondition: events kind check lost an earlier kind'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'move_booking_by_retailer') THEN RAISE EXCEPTION '0094 postcondition: move_booking_by_retailer missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'respond_booking_move') THEN RAISE EXCEPTION '0094 postcondition: respond_booking_move missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'lapse_booking_moves') THEN RAISE EXCEPTION '0094 postcondition: lapse_booking_moves missing'; END IF;
END $$;
