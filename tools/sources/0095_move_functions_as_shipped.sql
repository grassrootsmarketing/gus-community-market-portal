-- The three 0095 schedule functions exactly as pasted on production on 2026-10-19 (cutover-kit/0094-0099-retailer-demo-move-paste.sql lines 421-550, 733-780, 786-881). Source for tools/make-0106.mjs and tools/rehearse-0104-0106-paste.mjs.
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
