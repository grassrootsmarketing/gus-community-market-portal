-- 0077_release_b_projection_and_transitions.sql — Release B closure follow-up (Codex review
-- 2026-09-11, R2 / R4 / R5 / R6). Forward-only; 0075 and 0076 stay as applied.
--
--   R2  booking_transition(): ONE service-only transaction for the booking/demo state boundary.
--       Locks the booking (booking-first order, as accept_reschedule), checks the CURRENT state,
--       applies the transition, and creates / reactivates / retires the linked demo from the
--       booking's current schedule and duration. Manual confirm, decline, cancel, paid promotion
--       (fulfilment) and demo materialisation all use it — one invariant, one implementation.
--       Results are explicit: ok=false with a reason (state_changed / superseded) is never an
--       exception, and a database failure is an exception the caller must treat as retryable.
--       projection_anomalies() audits the two states schedule_mismatches() cannot see: an active
--       demo on an inactive booking, and a confirmed booking with no active demo.
--   R6  a NEW reservation or move may not span a UTC-offset transition (elapsed duration and wall
--       clock would disagree). booking_interval_ok() is the shared rule; the resolve trigger uses it.
--   R5  venue_blackouts_set() returns the full availability snapshot + capacity so an editor can
--       never merge a partial result into stale state.
--   R4  venue_availability_apply_all() gains p_copy_slots: with editing OFF the copy is hours +
--       capacity only and every destination keeps its own slot list.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. R6 — interval must not cross an offset transition.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_interval_ok(p_date date, p_time text, p_hours integer, p_tz text)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_start timestamptz; v_end timestamptz; v_tz text := coalesce(nullif(btrim(p_tz), ''), 'America/Los_Angeles');
        v_off_start interval; v_off_end interval;
BEGIN
  v_start := booking_slot_start_strict(p_date, p_time, v_tz);
  IF v_start IS NULL THEN RETURN false; END IF;
  v_end := v_start + make_interval(hours => coalesce(p_hours, 3));
  v_off_start := (v_start AT TIME ZONE v_tz) - (v_start AT TIME ZONE 'UTC');
  v_off_end   := (v_end   AT TIME ZONE v_tz) - (v_end   AT TIME ZONE 'UTC');
  RETURN v_off_start = v_off_end;
END $$;

CREATE OR REPLACE FUNCTION public.booking_slot_resolve() RETURNS trigger AS $$
DECLARE
  v_av jsonb; v_min integer; v_ok boolean; v_reason text; v_hours integer; v_tz text;
  v_slot_changed boolean; v_reactivated boolean; v_msg text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_slot_changed := NEW.venue_id IS DISTINCT FROM OLD.venue_id
                   OR NEW.demo_date IS DISTINCT FROM OLD.demo_date
                   OR slot_key(NEW.demo_time) IS DISTINCT FROM slot_key(OLD.demo_time);
    v_reactivated  :=     coalesce(OLD.status,'pending')     IN ('cancelled','declined','expired','auth_canceled')
                   AND coalesce(NEW.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');
    IF NOT v_slot_changed AND NOT v_reactivated THEN RETURN NEW; END IF;
  END IF;
  IF coalesce(NEW.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled') THEN RETURN NEW; END IF;
  IF NEW.venue_id IS NULL THEN RETURN NEW; END IF;

  SELECT v.availability INTO v_av FROM venues v
   WHERE v.id = NEW.venue_id AND v.retailer_id = NEW.retailer_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  BEGIN
    PERFORM venue_availability_validate(v_av);
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    RAISE EXCEPTION 'slot_config_invalid: this location''s availability is misconfigured (%)', v_msg USING errcode = 'check_violation';
  END;

  v_min := slot_minutes(NEW.demo_time);
  IF v_min IS NULL THEN
    RAISE EXCEPTION 'slot_not_offered: "%" is not a time this location offers on %', coalesce(NEW.demo_time, ''), NEW.demo_date
      USING errcode = 'check_violation';
  END IF;
  SELECT o.ok, o.reason, o.hours INTO v_ok, v_reason, v_hours FROM venue_slot_offered(v_av, NEW.demo_date, v_min) o;
  IF NOT coalesce(v_ok, false) THEN
    RAISE EXCEPTION '%: % at % is not bookable at this location', v_reason, slot_label(v_min), NEW.demo_date
      USING errcode = 'check_violation';
  END IF;

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  IF booking_slot_start_strict(NEW.demo_date, slot_label(v_min), v_tz) IS NULL THEN
    RAISE EXCEPTION 'invalid_local_time: % on % does not exist exactly once in %', slot_label(v_min), NEW.demo_date, coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles')
      USING errcode = 'check_violation';
  END IF;
  -- R6: the whole interval must sit on one side of any clock change.
  IF NOT booking_interval_ok(NEW.demo_date, slot_label(v_min), v_hours, v_tz) THEN
    RAISE EXCEPTION 'invalid_local_time: % + %h on % spans a daylight-saving change in %', slot_label(v_min), v_hours, NEW.demo_date, coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles')
      USING errcode = 'check_violation';
  END IF;

  NEW.duration_hours := v_hours;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- (trigger definition unchanged: BEFORE INSERT OR UPDATE OF venue_id, demo_date, demo_time, status)

-- ---------------------------------------------------------------------------------------------
-- 2. R2 — booking_transition(): the one place a booking changes state and its demo follows.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_transition(
  p_booking_id uuid, p_retailer_id uuid, p_action text, p_fields jsonb DEFAULT '{}'::jsonb, p_demo_fee numeric DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, status_before text, status_after text, demo_id uuid, demo_created boolean, demo_reactivated boolean, demos_cancelled integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b bookings%ROWTYPE; v_d demos%ROWTYPE; v_target text; v_from text[]; v_cur text; v_fee numeric;
  v_demo_id uuid; v_created boolean := false; v_react boolean := false; v_cancelled integer := 0; v_found boolean;
BEGIN
  IF p_booking_id IS NULL OR p_retailer_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::text, NULL::text, NULL::uuid, false, false, 0; RETURN;
  END IF;
  -- 1. Booking first (the same lock order as accept_reschedule), then its projection.
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id AND b.retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::text, NULL::text, NULL::uuid, false, false, 0; RETURN;
  END IF;
  v_cur := coalesce(v_b.status, 'pending');

  -- 2. Allowed transitions per action, judged on the CURRENT persisted state.
  IF p_action = 'confirm' THEN        v_from := ARRAY['pending', 'held'];              v_target := 'confirmed';
  ELSIF p_action = 'decline' THEN     v_from := ARRAY['pending', 'held'];              v_target := 'declined';
  ELSIF p_action = 'cancel' THEN      v_from := ARRAY['pending', 'confirmed', 'held']; v_target := 'cancelled';
  ELSIF p_action = 'promote_paid' THEN
    v_target := p_fields->>'status';
    IF v_target IS NULL OR v_target NOT IN ('confirmed', 'pending') THEN
      RAISE EXCEPTION 'invalid_target: promote_paid needs status confirmed|pending' USING errcode = 'check_violation';
    END IF;
    v_from := ARRAY['pending_payment', 'held', v_target];   -- the target itself = idempotent retry
  ELSIF p_action = 'materialize' THEN v_from := ARRAY['confirmed'];                    v_target := 'confirmed';
  ELSE
    RAISE EXCEPTION 'invalid_action: %', p_action USING errcode = 'check_violation';
  END IF;

  IF NOT (v_cur = ANY (v_from)) THEN
    RETURN QUERY SELECT false,
      CASE WHEN v_cur IN ('cancelled', 'declined', 'expired', 'auth_canceled') AND p_action IN ('promote_paid', 'materialize') THEN 'superseded' ELSE 'state_changed' END,
      v_cur, v_cur, NULL::uuid, false, false, 0;
    RETURN;
  END IF;

  -- 3. The booking transition (+ the caller's audited fields). UPDATE OF status fires the offering
  --    re-check only for inactive -> active (none of these), never for active -> active.
  IF v_cur <> v_target OR p_fields <> '{}'::jsonb THEN
    UPDATE bookings SET
      status            = v_target,
      cancelled_at      = CASE WHEN p_fields ? 'cancelled_at'      THEN (p_fields->>'cancelled_at')::timestamptz ELSE cancelled_at END,
      cancel_reason     = CASE WHEN p_fields ? 'cancel_reason'     THEN p_fields->>'cancel_reason'                ELSE cancel_reason END,
      refund_id         = CASE WHEN p_fields ? 'refund_id'         THEN p_fields->>'refund_id'                    ELSE refund_id END,
      payment_status    = CASE WHEN p_fields ? 'payment_status'    THEN p_fields->>'payment_status'               ELSE payment_status END,
      payment_intent_id = CASE WHEN p_fields ? 'payment_intent_id' THEN p_fields->>'payment_intent_id'            ELSE payment_intent_id END,
      paid_at           = CASE WHEN p_fields ? 'paid_at'           THEN (p_fields->>'paid_at')::timestamptz       ELSE paid_at END
    WHERE id = p_booking_id
    RETURNING * INTO v_b;
  END IF;

  -- 4. The projection, under the same lock. At most one demo per booking (demos_one_per_booking).
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  v_found := FOUND;
  IF v_target = 'confirmed' THEN
    IF v_b.demo_date IS NULL THEN
      RAISE EXCEPTION 'booking_has_no_date: % cannot be projected onto the calendar', p_booking_id USING errcode = 'check_violation';
    END IF;
    v_fee := p_demo_fee;
    IF v_fee IS NULL THEN SELECT x.demo_fee INTO v_fee FROM venues x WHERE x.id = v_b.venue_id; END IF;
    IF v_found AND coalesce(v_d.status, '') IN ('confirmed', 'scheduled', 'completed') THEN
      v_demo_id := v_d.id;
    ELSIF v_found THEN
      -- a retired projection for a booking that is confirmed again: bring it back on the current schedule
      UPDATE demos SET status = 'confirmed', confirmed_at = now(),
             venue_id = v_b.venue_id, demo_date = v_b.demo_date, demo_time = v_b.demo_time,
             duration_hours = coalesce(v_b.duration_hours, demos.duration_hours, 3),
             demo_fee = coalesce(v_fee, demos.demo_fee)
       WHERE id = v_d.id;
      v_demo_id := v_d.id; v_react := true;
    ELSE
      INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, contact_phone, product, product_skus,
                         demo_date, demo_time, duration_hours, status, confirmed_at, demo_fee, notes, booking_id)
      VALUES (v_b.retailer_id, v_b.venue_id, v_b.brand_id, coalesce(nullif(btrim(v_b.brand_name), ''), 'Unknown'), v_b.contact_name, v_b.contact_email, v_b.contact_phone,
              v_b.product, CASE WHEN jsonb_typeof(v_b.product_skus) = 'array' AND jsonb_array_length(v_b.product_skus) > 0 THEN v_b.product_skus ELSE NULL END,
              v_b.demo_date, v_b.demo_time, coalesce(v_b.duration_hours, 3), 'confirmed', now(), v_fee, v_b.notes, v_b.id)
      RETURNING id INTO v_demo_id;
      v_created := true;
    END IF;
  ELSIF v_target IN ('cancelled', 'declined') THEN
    UPDATE demos SET status = 'cancelled'
     WHERE booking_id = p_booking_id AND coalesce(status, '') IN ('confirmed', 'scheduled');
    GET DIAGNOSTICS v_cancelled = ROW_COUNT;
    IF v_found THEN v_demo_id := v_d.id; END IF;
  ELSE
    IF v_found THEN v_demo_id := v_d.id; END IF;
  END IF;

  RETURN QUERY SELECT true, NULL::text, v_cur, v_target, v_demo_id, v_created, v_react, v_cancelled;
END $$;
REVOKE ALL ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.projection_anomalies(p_retailer_id uuid DEFAULT NULL)
RETURNS TABLE(booking_id uuid, demo_id uuid, retailer_id uuid, booking_status text, demo_status text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, d.id, b.retailer_id, b.status, d.status, 'active_demo_for_inactive_booking'
    FROM bookings b JOIN demos d ON d.booking_id = b.id
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND coalesce(b.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled')
     AND coalesce(d.status, '') IN ('confirmed', 'scheduled')
  UNION ALL
  SELECT b.id, NULL::uuid, b.retailer_id, b.status, NULL::text, 'confirmed_booking_without_demo'
    FROM bookings b
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND b.status = 'confirmed' AND b.demo_date >= current_date
     AND NOT EXISTS (SELECT 1 FROM demos d WHERE d.booking_id = b.id AND coalesce(d.status, '') IN ('confirmed', 'scheduled', 'completed'))
  ORDER BY 1
$$;
REVOKE ALL ON FUNCTION public.projection_anomalies(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.projection_anomalies(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. R5 — blackout operations return the full availability snapshot + capacity.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid, uuid[]);
CREATE OR REPLACE FUNCTION public.venue_blackouts_set(
  p_retailer_id uuid, p_op text, p_dates date[] DEFAULT NULL, p_venue_ids uuid[] DEFAULT NULL,
  p_reason text DEFAULT NULL, p_group_id uuid DEFAULT NULL, p_entry_ids uuid[] DEFAULT NULL)
RETURNS TABLE(venue_id uuid, venue_name text, availability_version integer, group_id uuid, blackouts jsonb, affected jsonb, added integer, removed integer, availability jsonb, max_demos_per_slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v venues%ROWTYPE; v_ids uuid[]; v_group uuid; v_arr jsonb; v_new jsonb; v_d date; v_reason text;
  v_affected jsonb; v_added integer; v_removed integer; v_has_local boolean; v_all boolean;
  v_entry_txt text[]; v_dates date[];
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'not_found' USING errcode = 'no_data_found'; END IF;
  IF p_op NOT IN ('add', 'remove') THEN RAISE EXCEPTION 'invalid_op: % (add|remove)', p_op USING errcode = 'check_violation'; END IF;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  IF length(coalesce(v_reason, '')) > 200 THEN RAISE EXCEPTION 'invalid_reason: too long' USING errcode = 'check_violation'; END IF;

  IF p_op = 'add' THEN
    IF p_dates IS NULL OR cardinality(p_dates) = 0 OR cardinality(p_dates) > 366 THEN
      RAISE EXCEPTION 'invalid_dates: 1-366 dates required' USING errcode = 'check_violation';
    END IF;
    v_all := p_venue_ids IS NULL;
    IF v_all THEN
      SELECT array_agg(x.id ORDER BY x.id) INTO v_ids FROM venues x WHERE x.retailer_id = p_retailer_id;
    ELSE
      SELECT array_agg(x.id ORDER BY x.id) INTO v_ids FROM venues x WHERE x.retailer_id = p_retailer_id AND x.id = ANY (p_venue_ids);
      IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_venue_ids))) THEN
        RAISE EXCEPTION 'not_found: a venue is not yours or does not exist' USING errcode = 'no_data_found';
      END IF;
    END IF;
    v_group := CASE WHEN v_all THEN gen_random_uuid() ELSE NULL END;
  ELSE
    IF (p_entry_ids IS NULL OR cardinality(p_entry_ids) = 0) AND p_group_id IS NULL THEN
      RAISE EXCEPTION 'invalid_target: entry ids or a group id are required to remove' USING errcode = 'check_violation';
    END IF;
    SELECT array_agg(x.id ORDER BY x.id) INTO v_ids FROM venues x WHERE x.retailer_id = p_retailer_id;
    v_group := p_group_id;
    SELECT coalesce(array_agg(lower(e::text)), '{}') INTO v_entry_txt FROM unnest(coalesce(p_entry_ids, '{}'::uuid[])) e;
  END IF;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RETURN; END IF;
  SELECT array_agg(DISTINCT d ORDER BY d) INTO v_dates FROM unnest(coalesce(p_dates, '{}'::date[])) d;

  FOR v IN SELECT * FROM venues x WHERE x.id = ANY (v_ids) ORDER BY x.id FOR UPDATE LOOP
    v_arr := CASE WHEN v.availability IS NOT NULL AND jsonb_typeof(v.availability) = 'object'
                   AND jsonb_typeof(v.availability->'blackouts') = 'array' THEN v.availability->'blackouts' ELSE '[]'::jsonb END;
    v_added := 0; v_removed := 0;
    IF p_op = 'add' THEN
      v_new := v_arr;
      FOREACH v_d IN ARRAY v_dates LOOP
        IF NOT v_all THEN
          SELECT EXISTS (SELECT 1 FROM venue_blackout_dates(v.availability) bd WHERE bd.blackout_date = v_d AND bd.group_id IS NULL) INTO v_has_local;
          IF v_has_local THEN CONTINUE; END IF;
        END IF;
        v_new := v_new || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                   'id', gen_random_uuid()::text, 'date', to_char(v_d, 'YYYY-MM-DD'), 'reason', v_reason,
                   'group_id', v_group::text, 'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
        v_added := v_added + 1;
      END LOOP;
    ELSE
      SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_new
        FROM jsonb_array_elements(v_arr) e
       WHERE NOT ( lower(coalesce(e.value->>'id', '')) = ANY (v_entry_txt)
                   OR (p_group_id IS NOT NULL AND lower(coalesce(e.value->>'group_id', '')) = lower(p_group_id::text)) );
      v_removed := jsonb_array_length(v_arr) - jsonb_array_length(v_new);
    END IF;

    IF v_added > 0 OR v_removed > 0 THEN
      UPDATE venues
         SET availability = jsonb_set(CASE WHEN v.availability IS NULL OR jsonb_typeof(v.availability) <> 'object' THEN '{}'::jsonb ELSE v.availability END,
                                      '{blackouts}', v_new, true),
             availability_version = venues.availability_version + 1
       WHERE id = v.id
      RETURNING venues.availability, venues.availability_version INTO v.availability, v.availability_version;
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'demo_date', b.demo_date, 'demo_time', b.demo_time,
                                                 'status', b.status, 'brand_name', b.brand_name) ORDER BY b.demo_date, b.demo_time), '[]'::jsonb)
      INTO v_affected
      FROM bookings b
     WHERE b.venue_id = v.id AND p_op = 'add' AND b.demo_date = ANY (v_dates)
       AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

    venue_id := v.id; venue_name := v.name; availability_version := v.availability_version;
    group_id := v_group; blackouts := v_new; affected := v_affected; added := v_added; removed := v_removed;
    availability := v.availability; max_demos_per_slot := v.max_demos_per_slot;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. R4 — apply-all with an hours/capacity-only mode (p_copy_slots = false keeps every
--    destination's own slot list and forbids a source slot change in the same call).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer);
CREATE OR REPLACE FUNCTION public.venue_availability_apply_all(
  p_retailer_id uuid, p_source_venue_id uuid, p_expected_version integer,
  p_schedule jsonb DEFAULT NULL, p_slots jsonb DEFAULT NULL, p_reset_slots boolean DEFAULT false, p_max_demos_per_slot integer DEFAULT NULL,
  p_copy_slots boolean DEFAULT true)
RETURNS TABLE(ok boolean, reason text, detail jsonb, venue_id uuid, venue_name text, availability jsonb, availability_version integer, max_demos_per_slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_locked venues[]; src venues%ROWTYPE; v venues%ROWTYPE; v_av jsonb; v_src_av jsonb;
  v_msg text; v_detail text; v_reason text; v_rows jsonb := '[]'::jsonb; i integer;
BEGIN
  IF p_retailer_id IS NULL OR p_source_venue_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF NOT p_copy_slots AND (p_slots IS NOT NULL OR p_reset_slots) THEN
    RAISE EXCEPTION 'slot_editing_disabled: slot lists cannot change in hours-only mode' USING errcode = 'check_violation';
  END IF;
  v_locked := '{}';
  FOR v IN SELECT * FROM venues WHERE retailer_id = p_retailer_id ORDER BY id FOR UPDATE LOOP v_locked := v_locked || v; END LOOP;
  IF cardinality(v_locked) = 0 THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  src := NULL;
  FOR i IN 1..cardinality(v_locked) LOOP IF v_locked[i].id = p_source_venue_id THEN src := v_locked[i]; END IF; END LOOP;
  IF src.id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> src.availability_version THEN
    RETURN QUERY SELECT false, 'stale_version'::text, jsonb_build_object('current_version', src.availability_version), src.id, src.name, src.availability, src.availability_version, src.max_demos_per_slot; RETURN;
  END IF;
  IF p_max_demos_per_slot IS NOT NULL AND p_max_demos_per_slot < 1 THEN
    RETURN QUERY SELECT false, 'invalid_capacity'::text, NULL::jsonb, src.id, src.name, src.availability, src.availability_version, src.max_demos_per_slot; RETURN;
  END IF;

  v_src_av := CASE WHEN src.availability IS NULL OR jsonb_typeof(src.availability) <> 'object' THEN '{}'::jsonb ELSE src.availability END;
  IF p_schedule IS NOT NULL THEN v_src_av := jsonb_set(v_src_av, '{schedule}', p_schedule, true); END IF;
  IF p_reset_slots THEN v_src_av := v_src_av - 'slots';
  ELSIF p_slots IS NOT NULL THEN v_src_av := jsonb_set(v_src_av, '{slots}', p_slots, true); END IF;
  IF NOT (v_src_av ? 'blackouts') THEN v_src_av := jsonb_set(v_src_av, '{blackouts}', '[]'::jsonb, true); END IF;
  BEGIN
    FOR i IN 1..cardinality(v_locked) LOOP
      v := v_locked[i];
      IF v.id = src.id THEN
        v_av := v_src_av;
      ELSE
        v_av := CASE WHEN v.availability IS NULL OR jsonb_typeof(v.availability) <> 'object' THEN '{}'::jsonb ELSE v.availability END;
        IF v_src_av ? 'schedule' THEN v_av := jsonb_set(v_av, '{schedule}', v_src_av->'schedule', true); ELSE v_av := v_av - 'schedule'; END IF;
        IF p_copy_slots THEN
          IF v_src_av ? 'slots' THEN v_av := jsonb_set(v_av, '{slots}', v_src_av->'slots', true); ELSE v_av := v_av - 'slots'; END IF;
        END IF;
        IF NOT (v_av ? 'blackouts') THEN v_av := jsonb_set(v_av, '{blackouts}', '[]'::jsonb, true); END IF;
      END IF;
      BEGIN
        UPDATE venues
           SET availability = v_av,
               availability_version = venues.availability_version + 1,
               max_demos_per_slot = coalesce(p_max_demos_per_slot, src.max_demos_per_slot)
         WHERE id = v.id
        RETURNING * INTO v;
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
        v_reason := split_part(v_msg, ':', 1);
        IF v_reason NOT IN ('slot_in_use', 'availability_invalid', 'slot_config_invalid', 'capacity_below_active_reservations') THEN RAISE; END IF;
        RAISE EXCEPTION 'apply_all_refused' USING errcode = 'check_violation',
          detail = jsonb_build_object('reason', v_reason, 'venue_id', v.id, 'venue_name', v.name, 'message', v_msg,
                                      'affected', CASE WHEN coalesce(v_detail,'') <> '' THEN v_detail::jsonb ELSE NULL END)::text;
      END;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('venue_id', v.id, 'venue_name', v.name, 'availability', v.availability,
                                                               'availability_version', v.availability_version, 'max_demos_per_slot', v.max_demos_per_slot));
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg <> 'apply_all_refused' THEN RAISE; END IF;
    RETURN QUERY SELECT false, (v_detail::jsonb)->>'reason', v_detail::jsonb,
                        ((v_detail::jsonb)->>'venue_id')::uuid, (v_detail::jsonb)->>'venue_name', NULL::jsonb, NULL::integer, NULL::integer;
    RETURN;
  END;
  RETURN QUERY SELECT true, NULL::text, NULL::jsonb, (e->>'venue_id')::uuid, e->>'venue_name', e->'availability',
                      (e->>'availability_version')::integer, (e->>'max_demos_per_slot')::integer
    FROM jsonb_array_elements(v_rows) e;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer, boolean) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Post-conditions.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)') IS NULL
     OR to_regprocedure('public.projection_anomalies(uuid)') IS NULL
     OR to_regprocedure('public.booking_interval_ok(date,text,integer,text)') IS NULL
     OR to_regprocedure('public.venue_blackouts_set(uuid,text,date[],uuid[],text,uuid,uuid[])') IS NULL
     OR to_regprocedure('public.venue_availability_apply_all(uuid,uuid,integer,jsonb,jsonb,boolean,integer,boolean)') IS NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: a 0077 function is missing';
  END IF;
  IF to_regprocedure('public.venue_availability_apply_all(uuid,uuid,integer,jsonb,jsonb,boolean,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: the 0076 apply_all signature survived';
  END IF;
  -- R6 interval rule: Los Angeles spring-forward and fall-back spans refused; daytime and short spans fine.
  IF booking_interval_ok(DATE '2027-03-14', '12:30 AM', 3, 'America/Los_Angeles')   -- 00:30 + 3h crosses 02:00
     OR booking_interval_ok(DATE '2026-11-01', '12:30 AM', 3, 'America/Los_Angeles') -- 00:30 + 3h crosses the fold
     OR NOT booking_interval_ok(DATE '2026-11-01', '11:00 AM', 3, 'America/Los_Angeles')
     OR NOT booking_interval_ok(DATE '2027-03-14', '11:00 AM', 3, 'America/Los_Angeles')
     OR NOT booking_interval_ok(DATE '2026-06-01', '9:00 PM', 2, 'America/Los_Angeles') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_interval_ok() transition rule';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'booking_slot_resolve') NOT ILIKE '%booking_interval_ok%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_resolve() does not apply the interval rule';
  END IF;
END $$;

COMMIT;
