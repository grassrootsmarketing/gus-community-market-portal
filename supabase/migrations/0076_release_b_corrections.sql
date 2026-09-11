-- 0076_release_b_corrections.sql — Release B corrections (Codex review 2026-09-10, B-01…B-08).
-- Forward-only: 0075 is applied to the shared test project and stays as it is; every function it
-- installed that needed a change is re-issued here.
--
--   B-01  blackout entries carry a server-generated uuid `id`; an optional `group_id` must be a uuid;
--         the validator refuses anything else (malformed legacy metadata cannot reach a handler).
--   B-02  no "unconfigured venue" wildcard for NEW reservations: a missing slot list means the two
--         standard slots, a missing hours schedule refuses new reservations (venue_hours_not_set),
--         and the WHOLE availability blob is validated before a reservation resolves (fail closed).
--         Existing reservations are never rewritten; the audit reports legacy classes separately.
--   B-03  the offering check also runs on an inactive -> active status transition (reactivation);
--         an ordinary active -> active flip (pending -> confirmed) never re-checks, so an accepted
--         reservation survives a later blackout. Route-side conditional transitions are in the JS.
--   B-04  one occurrence snapshot: accept_reschedule copies the resolved duration to the demo; a
--         duration-only (or status-only) update preserves start_at/timezone and recomputes end_at;
--         new bookings/moves refuse a local time that does not exist (DST gap) or is ambiguous
--         (fold); audits cover duration and snapshot consistency.
--   B-05  blackout entries are addressed by identity: local and all-location contributions coexist
--         on one date; removal targets entry ids or a group id, never "the current entry for a date".
--   B-06  apply-all locks every venue of the retailer in id order in ONE statement before reading
--         the source, and applies the source edit + fan-out under one version check.
--   B-07  the migration's own negative control is isolated from the real-data validation.
--   B-08  a slot may not end at or past midnight.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Backfill entry ids onto existing blackout entries (guard disabled for this metadata-only pass).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.venues DISABLE TRIGGER trg_venue_availability_guard;
UPDATE venues v
   SET availability = jsonb_set(v.availability, '{blackouts}', (
         SELECT coalesce(jsonb_agg(CASE WHEN e ? 'id' THEN e ELSE e || jsonb_build_object('id', gen_random_uuid()::text) END), '[]'::jsonb)
           FROM jsonb_array_elements(v.availability->'blackouts') e))
 WHERE v.availability IS NOT NULL AND jsonb_typeof(v.availability) = 'object'
   AND jsonb_typeof(v.availability->'blackouts') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.availability->'blackouts') e WHERE NOT (e ? 'id'));
ALTER TABLE public.venues ENABLE TRIGGER trg_venue_availability_guard;

-- ---------------------------------------------------------------------------------------------
-- 2. Validators (B-01 ids, B-08 midnight).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.venue_slots_config(p_availability jsonb)
RETURNS TABLE(start_min integer, hours integer)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_slots jsonb; v_el jsonb; v_start text; v_hours jsonb; v_min integer; v_h integer;
  v_prev_end integer := -1; v_starts integer[] := '{}'; v_hrs integer[] := '{}'; v_seen integer[] := '{}'; r record;
BEGIN
  IF p_availability IS NULL OR jsonb_typeof(p_availability) <> 'object' OR NOT (p_availability ? 'slots') THEN
    RETURN QUERY SELECT 660, 3 UNION ALL SELECT 900, 3;   -- 11:00 / 3h, 3:00 PM / 3h
    RETURN;
  END IF;
  v_slots := p_availability->'slots';
  IF jsonb_typeof(v_slots) <> 'array' THEN
    RAISE EXCEPTION 'slot_config_invalid: slots must be a list' USING errcode = 'check_violation';
  END IF;
  IF jsonb_array_length(v_slots) > 24 THEN
    RAISE EXCEPTION 'slot_config_invalid: at most 24 slots' USING errcode = 'check_violation';
  END IF;
  FOR v_el IN SELECT value FROM jsonb_array_elements(v_slots) LOOP
    IF jsonb_typeof(v_el) <> 'object' THEN
      RAISE EXCEPTION 'slot_config_invalid: each slot must be an object' USING errcode = 'check_violation';
    END IF;
    v_start := v_el->>'start'; v_hours := v_el->'hours';
    IF v_start IS NULL OR v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
      RAISE EXCEPTION 'slot_config_invalid: start must be HH:MM (got %)', coalesce(v_start, 'null') USING errcode = 'check_violation';
    END IF;
    IF v_hours IS NULL OR jsonb_typeof(v_hours) <> 'number' OR (v_hours::text) !~ '^\d+$' THEN
      RAISE EXCEPTION 'slot_config_invalid: hours must be a whole number (slot %)', v_start USING errcode = 'check_violation';
    END IF;
    v_h := (v_hours::text)::integer;
    IF v_h < 1 OR v_h > 12 THEN
      RAISE EXCEPTION 'slot_config_invalid: hours must be 1-12 (slot %)', v_start USING errcode = 'check_violation';
    END IF;
    v_min := substr(v_start, 1, 2)::integer * 60 + substr(v_start, 4, 2)::integer;
    -- B-08: a slot must END before midnight (24:00 is refused for this bounded release).
    IF v_min + v_h * 60 >= 1440 THEN
      RAISE EXCEPTION 'slot_config_invalid: slot % must end before midnight', v_start USING errcode = 'check_violation';
    END IF;
    IF v_min = ANY (v_seen) THEN
      RAISE EXCEPTION 'slot_config_invalid: duplicate start %', v_start USING errcode = 'check_violation';
    END IF;
    v_seen := v_seen || v_min; v_starts := v_starts || v_min; v_hrs := v_hrs || v_h;
  END LOOP;
  FOR r IN SELECT t.s, t.h FROM unnest(v_starts, v_hrs) AS t(s, h) ORDER BY t.s LOOP
    IF r.s < v_prev_end THEN
      RAISE EXCEPTION 'slot_config_invalid: slot % overlaps the previous slot', slot_label(r.s) USING errcode = 'check_violation';
    END IF;
    v_prev_end := r.s + r.h * 60;
    start_min := r.s; hours := r.h; RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

-- Blackout entries: {id: uuid (required), date: YYYY-MM-DD, reason?: text<=200, group_id?: uuid,
-- created_at?}. Dates MAY repeat (a local and an all-locations contribution coexist); ids may not.
DROP FUNCTION IF EXISTS public.venue_blackout_dates(jsonb);   -- return shape gains entry_id
CREATE OR REPLACE FUNCTION public.venue_blackout_dates(p_availability jsonb)
RETURNS TABLE(blackout_date date, reason text, group_id text, entry_id text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr jsonb; v_el jsonb; v_d date; v_seen text[] := '{}'; v_id text; v_g text;
BEGIN
  IF p_availability IS NULL OR jsonb_typeof(p_availability) <> 'object' OR NOT (p_availability ? 'blackouts') THEN RETURN; END IF;
  v_arr := p_availability->'blackouts';
  IF jsonb_typeof(v_arr) = 'null' THEN RETURN; END IF;
  IF jsonb_typeof(v_arr) <> 'array' THEN
    RAISE EXCEPTION 'availability_invalid: blackouts must be a list' USING errcode = 'check_violation';
  END IF;
  FOR v_el IN SELECT value FROM jsonb_array_elements(v_arr) LOOP
    IF jsonb_typeof(v_el) <> 'object' OR coalesce(v_el->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'availability_invalid: each blackout needs a date (YYYY-MM-DD)' USING errcode = 'check_violation';
    END IF;
    BEGIN v_d := (v_el->>'date')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'availability_invalid: blackout date % is not a real date', v_el->>'date' USING errcode = 'check_violation';
    END;
    v_id := v_el->>'id';
    IF v_id IS NULL OR jsonb_typeof(v_el->'id') <> 'string' OR v_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'availability_invalid: blackout % has no valid entry id', v_d USING errcode = 'check_violation';
    END IF;
    IF lower(v_id) = ANY (v_seen) THEN
      RAISE EXCEPTION 'availability_invalid: blackout entry id % listed twice', v_id USING errcode = 'check_violation';
    END IF;
    v_seen := v_seen || lower(v_id);
    v_g := v_el->>'group_id';
    IF v_el ? 'group_id' AND (jsonb_typeof(v_el->'group_id') <> 'string' OR v_g !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'availability_invalid: blackout % has an invalid group id', v_d USING errcode = 'check_violation';
    END IF;
    IF v_el ? 'reason' AND jsonb_typeof(v_el->'reason') NOT IN ('string', 'null') THEN
      RAISE EXCEPTION 'availability_invalid: blackout reason must be text (%)', v_d USING errcode = 'check_violation';
    END IF;
    IF length(coalesce(v_el->>'reason', '')) > 200 THEN
      RAISE EXCEPTION 'availability_invalid: blackout reason too long (%)', v_d USING errcode = 'check_violation';
    END IF;
    blackout_date := v_d; reason := v_el->>'reason'; group_id := v_g; entry_id := v_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

-- Offering for one (date, minute): hours are REQUIRED for new reservations (B-02).
--   reasons: date_blackout | slot_not_offered | venue_hours_not_set | venue_closed | slot_outside_hours
CREATE OR REPLACE FUNCTION public.venue_slot_offered(p_availability jsonb, p_date date, p_minutes integer)
RETURNS TABLE(ok boolean, reason text, hours integer)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_hours integer; v_dow integer; v_fits boolean; v_has_windows boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM venue_blackout_dates(p_availability) bd WHERE bd.blackout_date = p_date) THEN
    RETURN QUERY SELECT false, 'date_blackout'::text, NULL::integer; RETURN;
  END IF;
  IF NOT venue_schedule_present(p_availability) THEN
    RETURN QUERY SELECT false, 'venue_hours_not_set'::text, NULL::integer; RETURN;
  END IF;
  SELECT sc.hours INTO v_hours FROM venue_slots_config(p_availability) sc WHERE sc.start_min = p_minutes;
  IF v_hours IS NULL THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, NULL::integer; RETURN; END IF;
  v_dow := extract(dow FROM p_date)::integer;
  SELECT count(*) > 0, bool_or(p_minutes >= w.open_min AND p_minutes + v_hours * 60 <= w.close_min)
    INTO v_has_windows, v_fits FROM venue_day_windows(p_availability, v_dow) w;
  IF NOT coalesce(v_has_windows, false) THEN RETURN QUERY SELECT false, 'venue_closed'::text, NULL::integer; RETURN; END IF;
  IF NOT coalesce(v_fits, false) THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, NULL::integer; RETURN; END IF;
  RETURN QUERY SELECT true, NULL::text, v_hours;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Strict local time (B-04): NULL for an unparseable time, a DST gap (does not exist) or a DST
--    fold (ambiguous). Used for NEW bookings and moves; the lenient 0074 parser stays for legacy.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_slot_start_strict(p_date date, p_time text, p_tz text)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE v_min integer; v_wall timestamp; v_inst timestamptz; v_tz text := coalesce(nullif(btrim(p_tz), ''), 'America/Los_Angeles');
BEGIN
  IF p_date IS NULL THEN RETURN NULL; END IF;
  v_min := slot_minutes(p_time);
  IF v_min IS NULL THEN RETURN NULL; END IF;
  v_wall := p_date + make_time(v_min / 60, v_min % 60, 0);
  BEGIN
    v_inst := v_wall AT TIME ZONE v_tz;
  EXCEPTION WHEN invalid_parameter_value OR invalid_datetime_format THEN
    RETURN NULL;
  END;
  IF (v_inst AT TIME ZONE v_tz) <> v_wall THEN RETURN NULL; END IF;                      -- gap: the wall time does not exist
  IF ((v_inst - interval '1 hour') AT TIME ZONE v_tz) = v_wall
     OR ((v_inst + interval '1 hour') AT TIME ZONE v_tz) = v_wall THEN RETURN NULL; END IF;  -- fold: two instants share the wall time
  RETURN v_inst;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. booking_slot_resolve (B-02 no wildcard, B-03 reactivation, B-04 strict local time).
-- ---------------------------------------------------------------------------------------------
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
    -- An accepted reservation is never re-checked by an active -> active flip (pending -> confirmed
    -- after a blackout was added stays valid, as promised to the retailer).
    IF NOT v_slot_changed AND NOT v_reactivated THEN RETURN NEW; END IF;
  END IF;
  IF coalesce(NEW.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled') THEN RETURN NEW; END IF;
  IF NEW.venue_id IS NULL THEN RETURN NEW; END IF;   -- enforce_slot_capacity raises for this

  -- Venue row lock FIRST — the same lock and order as enforce_slot_capacity() (0070).
  SELECT v.availability INTO v_av FROM venues v
   WHERE v.id = NEW.venue_id AND v.retailer_id = NEW.retailer_id
   FOR SHARE;
  IF NOT FOUND THEN RETURN NEW; END IF;              -- enforce_slot_capacity raises for this too

  -- The WHOLE configuration must be well-formed, or nothing is bookable (fail closed).
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

  -- The local time must exist exactly once in the store's zone (no DST gap/fold guesses).
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  IF booking_slot_start_strict(NEW.demo_date, slot_label(v_min), v_tz) IS NULL THEN
    RAISE EXCEPTION 'invalid_local_time: % on % does not exist exactly once in %', slot_label(v_min), NEW.demo_date, coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles')
      USING errcode = 'check_violation';
  END IF;

  NEW.duration_hours := v_hours;   -- the configured slot's length, never the caller's
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_slot_resolve ON public.bookings;
CREATE TRIGGER trg_booking_slot_resolve
  BEFORE INSERT OR UPDATE OF venue_id, demo_date, demo_time, status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_slot_resolve();

-- ---------------------------------------------------------------------------------------------
-- 5. booking_slot_snapshot (B-04): an update that does not move the occurrence preserves the
--    accepted start/timezone and only recomputes end_at from the (possibly new) duration.
--    Listed columns include status so a reactivation's resolved duration reaches end_at (UPDATE OF
--    fires on the statement's target columns, not on columns another BEFORE trigger changed).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_slot_snapshot() RETURNS trigger AS $$
DECLARE v_tz text; v_hours integer;
BEGIN
  v_hours := NEW.duration_hours;
  IF v_hours IS NULL THEN
    SELECT d.duration_hours INTO v_hours FROM demos d WHERE d.booking_id = NEW.id LIMIT 1;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.demo_date IS NOT DISTINCT FROM OLD.demo_date
     AND NEW.demo_time IS NOT DISTINCT FROM OLD.demo_time
     AND NEW.retailer_id IS NOT DISTINCT FROM OLD.retailer_id
     AND OLD.start_at IS NOT NULL THEN
    NEW.start_at  := OLD.start_at;
    NEW.timezone  := OLD.timezone;
    NEW.end_at    := OLD.start_at + make_interval(hours => coalesce(v_hours, 3));
    RETURN NEW;
  END IF;
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  NEW.timezone := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  NEW.start_at := booking_slot_start(NEW.demo_date, NEW.demo_time, NEW.timezone, 11);
  IF NEW.start_at IS NULL THEN NEW.end_at := NULL;
  ELSE NEW.end_at := NEW.start_at + make_interval(hours => coalesce(v_hours, 3));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_slot_snapshot ON public.bookings;
CREATE TRIGGER trg_booking_slot_snapshot
  BEFORE INSERT OR UPDATE OF demo_date, demo_time, retailer_id, duration_hours, status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_slot_snapshot();

-- ---------------------------------------------------------------------------------------------
-- 6. accept_reschedule (0074/0075) — the resolved duration is projected onto the demo too, and
--    the new refusals are mapped.
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
  -- 1. Lock the booking. Everything below reads under this lock; a concurrent cancel (PATCH status)
  --    or a second accept waits here and then sees what we committed.
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer; RETURN; END IF;

  -- 2. The projection row (one per booking: demos_one_per_booking). Same lock order everywhere.
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_demo'::text, v_b.schedule_revision; RETURN; END IF;

  -- 3. Identity: the brand the booking (or, for legacy rows without one, the demo) belongs to.
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_d.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_b.schedule_revision; RETURN;
  END IF;

  -- 4. Cancel race: only an active booking can move. A booking cancelled between the brand loading
  --    the page and clicking Accept is refused here, and the demo stays cancelled.
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'cancelled'::text, v_b.schedule_revision; RETURN;
  END IF;

  -- 5. Proposal + version. No proposal (already accepted/declined/replayed) and a version other
  --    than the current one (old tab, superseded proposal) are both refusals with no side effect.
  IF v_d.reschedule_to_date IS NULL THEN RETURN QUERY SELECT false, 'no_proposal'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_proposal_version IS NULL OR v_b.reschedule_proposal_version <> p_proposal_version THEN
    RETURN QUERY SELECT false, 'stale_proposal'::text, v_b.schedule_revision; RETURN;
  END IF;

  v_new_date := v_d.reschedule_to_date;
  v_new_time := coalesce(nullif(btrim(v_d.reschedule_to_time), ''), v_b.demo_time, v_d.demo_time);

  -- 6. Destination must not be in the past (retailer-local today).
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = v_b.retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF v_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_b.schedule_revision; RETURN; END IF;

  -- 7. COI on the NEW date — the canonical rule of api/_coi-policy.js coiDecision(), in SQL:
  --      covered <=> (an explicit per-booking waiver)
  --               OR (default_coi_url present AND coi_verification_status in (passed, approved)
  --                   AND default_coi_expires present AND default_coi_expires >= demo date).
  --    pending / flagged / rejected / missing / unreadable expiry never count.
  SELECT * INTO v_brand FROM brands br WHERE br.id = p_brand_id;
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= v_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_b.schedule_revision; RETURN; END IF;

  -- 8. Move the AUTHORITATIVE row. trg_enforce_slot_capacity_move (0070) locks the venue row and
  --    the destination slot and raises slot_full (check_violation) when it is taken; the exception
  --    block below turns that into ok=false with the UPDATE rolled back (plpgsql sub-transaction),
  --    and nothing after this point has run yet, so the database is exactly as it was.
  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = v_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = p_booking_id
    RETURNING bookings.schedule_revision, bookings.duration_hours INTO v_new_rev, v_new_dur;
  EXCEPTION WHEN check_violation THEN
    -- 0075: the slot-resolve trigger (offering/blackout/hours) raises with the same errcode as the
    -- capacity trigger; each becomes an ok=false reason with the UPDATE rolled back.
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
  -- (trg_booking_slot_snapshot recomputed start_at/end_at/timezone in the same UPDATE.)

  -- 9. Project onto the calendar row and consume the proposal.
  UPDATE demos
     SET demo_date = v_new_date, demo_time = v_new_time,
         duration_hours = coalesce(v_new_dur, demos.duration_hours),   -- 0076 (B-04): the occurrence length moves with the slot
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- 10. The event, with both slots, so the fan-out can say "moved from X to Y".
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, p_booking_id, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          p_booking_id::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', v_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'proposal_version', p_proposal_version))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  -- 11. Retire every not-yet-sent delivery of the OLD occurrence (reminders for a slot that no
  --     longer exists, and a confirmation that would now name the wrong day).
  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = p_booking_id::text || ':' || v_old_rev::text
     AND status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_new_rev;
END $$;
REVOKE ALL ON FUNCTION public.accept_reschedule(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(uuid, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Blackouts by identity (B-05). New signature; the 0075 one is dropped.
--    add:    p_dates (+ p_venue_ids, NULL = all current venues; p_reason). A local add on a date
--            that already has a LOCAL entry at that venue is idempotent (nothing added); an
--            all-locations add always appends its own entry (group_id, server-generated).
--    remove: p_entry_ids (observed identities) and/or p_group_id (undo an all-locations block).
--            Unknown ids remove nothing (an old command never deletes a replacement).
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid);
CREATE OR REPLACE FUNCTION public.venue_blackouts_set(
  p_retailer_id uuid, p_op text, p_dates date[] DEFAULT NULL, p_venue_ids uuid[] DEFAULT NULL,
  p_reason text DEFAULT NULL, p_group_id uuid DEFAULT NULL, p_entry_ids uuid[] DEFAULT NULL)
RETURNS TABLE(venue_id uuid, venue_name text, availability_version integer, group_id uuid, blackouts jsonb, affected jsonb, added integer, removed integer)
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
    -- Removal locks every venue of the retailer (one deterministic order for every bulk edit).
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
          IF v_has_local THEN CONTINUE; END IF;   -- idempotent local add
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
      RETURNING venues.availability_version INTO v.availability_version;
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'demo_date', b.demo_date, 'demo_time', b.demo_time,
                                                 'status', b.status, 'brand_name', b.brand_name) ORDER BY b.demo_date, b.demo_time), '[]'::jsonb)
      INTO v_affected
      FROM bookings b
     WHERE b.venue_id = v.id AND p_op = 'add' AND b.demo_date = ANY (v_dates)
       AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

    venue_id := v.id; venue_name := v.name; availability_version := v.availability_version;
    group_id := v_group; blackouts := v_new; affected := v_affected; added := v_added; removed := v_removed;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. Apply-all (B-06): every venue of the retailer is locked in id order in ONE statement before
--    the source is read; the source edit (under its version) and the fan-out are one transaction.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.venue_availability_apply_all(uuid, uuid);
CREATE OR REPLACE FUNCTION public.venue_availability_apply_all(
  p_retailer_id uuid, p_source_venue_id uuid, p_expected_version integer,
  p_schedule jsonb DEFAULT NULL, p_slots jsonb DEFAULT NULL, p_reset_slots boolean DEFAULT false, p_max_demos_per_slot integer DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, detail jsonb, venue_id uuid, venue_name text, availability jsonb, availability_version integer, max_demos_per_slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_locked venues[]; src venues%ROWTYPE; v venues%ROWTYPE; v_av jsonb; v_src_av jsonb;
  v_msg text; v_detail text; v_reason text; v_rows jsonb := '[]'::jsonb; i integer;
BEGIN
  IF p_retailer_id IS NULL OR p_source_venue_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  -- One lock statement in id order, fully consumed before anything is read or written: no
  -- operation on this retailer's venues (blackouts, single edits) can invert it.
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

  -- Source edit (merged keys), then fan-out; everything below is one sub-transaction.
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
        IF v_src_av ? 'slots' THEN v_av := jsonb_set(v_av, '{slots}', v_src_av->'slots', true); ELSE v_av := v_av - 'slots'; END IF;
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
REVOKE ALL ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Audits. offering_anomalies() classifies: 'invariant' (a reservation no longer maps to its
--    venue's slot list / broken config) vs 'legacy' (accepted before hours existed, unparseable
--    time, DST-ambiguous local time). schedule_mismatches() gains duration; snapshot_drift() checks
--    each accepted occurrence against its own stored zone.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.offering_anomalies(uuid);
CREATE OR REPLACE FUNCTION public.offering_anomalies(p_retailer_id uuid DEFAULT NULL)
RETURNS TABLE(booking_id uuid, venue_id uuid, retailer_id uuid, demo_date date, demo_time text, duration_hours integer, reason text, class text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_ok boolean; v_reason text; v_hours integer; v_min integer; v_class text;
BEGIN
  FOR r IN
    SELECT b.id, b.venue_id, b.retailer_id, b.demo_date, b.demo_time, b.duration_hours, b.timezone, v.availability
      FROM bookings b JOIN venues v ON v.id = b.venue_id
     WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
       AND b.demo_date >= current_date
       AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
     ORDER BY b.demo_date, b.demo_time
  LOOP
    v_min := slot_minutes(r.demo_time); v_reason := NULL; v_class := NULL;
    IF v_min IS NULL THEN
      v_reason := 'unparseable_time'; v_class := 'legacy';
    ELSIF NOT venue_schedule_present(r.availability) THEN
      -- accepted before the location had hours: reported as legacy, never as a broken invariant
      v_reason := 'venue_hours_not_set'; v_class := 'legacy';
    ELSE
      BEGIN
        PERFORM venue_availability_validate(r.availability);
        SELECT o.ok, o.reason, o.hours INTO v_ok, v_reason, v_hours FROM venue_slot_offered(r.availability, r.demo_date, v_min) o;
      EXCEPTION WHEN check_violation THEN
        v_ok := false; v_reason := 'slot_config_invalid';
      END;
      IF v_reason IN ('date_blackout', 'venue_closed', 'slot_outside_hours') THEN
        -- allowed to coexist with an accepted reservation: only the interval itself must survive
        SELECT sc.hours INTO v_hours FROM venue_slots_config(r.availability) sc WHERE sc.start_min = v_min;
        v_ok := v_hours IS NOT NULL; v_reason := CASE WHEN v_ok THEN NULL ELSE 'slot_not_offered' END;
      END IF;
      IF v_reason = 'venue_hours_not_set' THEN
        v_class := 'legacy';
      ELSIF NOT coalesce(v_ok, false) THEN
        v_class := 'invariant';
      ELSIF v_hours IS DISTINCT FROM coalesce(r.duration_hours, 3) THEN
        v_reason := 'duration_mismatch'; v_class := 'invariant';
      ELSIF booking_slot_start_strict(r.demo_date, slot_label(v_min), r.timezone) IS NULL THEN
        v_reason := 'invalid_local_time'; v_class := 'legacy';
      END IF;
    END IF;
    IF v_reason IS NOT NULL THEN
      booking_id := r.id; venue_id := r.venue_id; retailer_id := r.retailer_id; demo_date := r.demo_date; demo_time := r.demo_time;
      duration_hours := r.duration_hours; reason := v_reason; class := v_class;
      RETURN NEXT;
    END IF;
  END LOOP;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.offering_anomalies(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offering_anomalies(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.schedule_mismatches()
RETURNS TABLE(booking_id uuid, demo_id uuid, retailer_id uuid, field text, booking_value text, demo_value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH pairs AS (
    SELECT b.id AS bid, d.id AS did, b.retailer_id AS rid,
           b.demo_date AS b_date,  d.demo_date AS d_date,
           b.demo_time AS b_time,  d.demo_time AS d_time,
           b.venue_id  AS b_venue, d.venue_id  AS d_venue,
           coalesce(b.duration_hours, 3) AS b_dur, coalesce(d.duration_hours, 3) AS d_dur
      FROM bookings b JOIN demos d ON d.booking_id = b.id
     WHERE coalesce(b.status,'pending') IN ('pending','confirmed')
       AND coalesce(d.status,'') IN ('confirmed','scheduled')
       AND b.demo_date >= current_date
  )
  SELECT bid, did, rid, 'demo_date', b_date::text,     d_date::text  FROM pairs WHERE b_date  IS DISTINCT FROM d_date
  UNION ALL
  SELECT bid, did, rid, 'demo_time', slot_key(b_time), slot_key(d_time) FROM pairs WHERE slot_key(b_time) IS DISTINCT FROM slot_key(d_time)
  UNION ALL
  SELECT bid, did, rid, 'venue_id',  b_venue::text,    d_venue::text FROM pairs WHERE b_venue IS DISTINCT FROM d_venue
  UNION ALL
  SELECT bid, did, rid, 'duration_hours', b_dur::text, d_dur::text   FROM pairs WHERE b_dur IS DISTINCT FROM d_dur
$$;

CREATE OR REPLACE FUNCTION public.snapshot_drift(p_retailer_id uuid DEFAULT NULL)
RETURNS TABLE(booking_id uuid, retailer_id uuid, reason text, stored_start timestamptz, expected_start timestamptz, stored_end timestamptz, expected_end timestamptz, booking_timezone text, retailer_timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.id, b.retailer_id,
         CASE WHEN b.start_at IS DISTINCT FROM booking_slot_start(b.demo_date, b.demo_time, b.timezone, 11) THEN 'start_differs_from_own_zone'
              WHEN b.end_at IS DISTINCT FROM b.start_at + make_interval(hours => coalesce(b.duration_hours, 3)) THEN 'end_differs_from_duration'
              ELSE 'timezone_differs_from_retailer' END,
         b.start_at, booking_slot_start(b.demo_date, b.demo_time, b.timezone, 11),
         b.end_at, b.start_at + make_interval(hours => coalesce(b.duration_hours, 3)),
         b.timezone, r.timezone
    FROM bookings b JOIN retailers r ON r.id = b.retailer_id
   WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
     AND b.start_at IS NOT NULL
     AND b.demo_date >= current_date
     AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
     AND ( b.start_at IS DISTINCT FROM booking_slot_start(b.demo_date, b.demo_time, b.timezone, 11)
        OR b.end_at IS DISTINCT FROM b.start_at + make_interval(hours => coalesce(b.duration_hours, 3))
        OR coalesce(nullif(btrim(r.timezone), ''), 'America/Los_Angeles') IS DISTINCT FROM b.timezone )
   ORDER BY b.demo_date, b.id
$$;
REVOKE ALL ON FUNCTION public.snapshot_drift(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_drift(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. Post-conditions. (a) REAL DATA: every existing venue configuration must pass the validators
--     — any failure aborts this migration with the offending venue named. No exception handler.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE r record; v_n integer;
BEGIN
  FOR r IN SELECT id, name, availability FROM venues LOOP
    BEGIN
      PERFORM venue_availability_validate(r.availability);
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: venue % (%) has an invalid availability configuration: %', r.id, r.name, SQLERRM;
    END;
  END LOOP;
  SELECT count(*) INTO v_n FROM venues v WHERE jsonb_typeof(v.availability->'blackouts') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.availability->'blackouts') e WHERE NOT (e ? 'id'));
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: % venue(s) still carry blackout entries without ids', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::int2[])
                  WHERE t.tgname = 'trg_booking_slot_resolve' AND t.tgrelid = 'public.bookings'::regclass AND a.attname = 'status') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_slot_resolve does not fire on status';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = ANY (t.tgattr::int2[])
                  WHERE t.tgname = 'trg_booking_slot_snapshot' AND t.tgrelid = 'public.bookings'::regclass AND a.attname = 'status') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_slot_snapshot does not fire on status';
  END IF;
  IF to_regprocedure('public.venue_blackouts_set(uuid,text,date[],uuid[],text,uuid)') IS NOT NULL
     OR to_regprocedure('public.venue_availability_apply_all(uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: an old RPC signature survived';
  END IF;
  -- Strict local-time parser: a normal day, a DST gap and a DST fold in Los Angeles.
  IF booking_slot_start_strict(DATE '2026-06-01', '11:00 AM', 'America/Los_Angeles') IS NULL
     OR booking_slot_start_strict(DATE '2027-03-14', '2:30 AM', 'America/Los_Angeles') IS NOT NULL
     OR booking_slot_start_strict(DATE '2026-11-01', '1:30 AM', 'America/Los_Angeles') IS NOT NULL
     OR booking_slot_start_strict(DATE '2026-11-01', '11:00 AM', 'America/Los_Angeles') IS NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_start_strict() gap/fold handling';
  END IF;
END $$;

-- (b) NEGATIVE CONTROLS, isolated: each deliberately invalid input must be refused. A real-data
--     problem can never satisfy these because they run on literals only.
DO $$
DECLARE v_hit boolean;
BEGIN
  v_hit := false;
  BEGIN PERFORM * FROM venue_slots_config('{"slots":[{"start":"11:00","hours":3},{"start":"13:00","hours":3}]}'::jsonb);
  EXCEPTION WHEN check_violation THEN v_hit := SQLERRM LIKE 'slot_config_invalid: slot % overlaps%'; END;
  IF NOT v_hit THEN RAISE EXCEPTION 'POST-CONDITION FAILED: overlapping slots were accepted'; END IF;

  v_hit := false;
  BEGIN PERFORM * FROM venue_slots_config('{"slots":[{"start":"21:00","hours":3}]}'::jsonb);
  EXCEPTION WHEN check_violation THEN v_hit := SQLERRM LIKE 'slot_config_invalid: slot % must end before midnight'; END;
  IF NOT v_hit THEN RAISE EXCEPTION 'POST-CONDITION FAILED: a slot ending at midnight was accepted'; END IF;

  v_hit := false;
  BEGIN PERFORM * FROM venue_blackout_dates('{"blackouts":[{"date":"2026-10-01"}]}'::jsonb);
  EXCEPTION WHEN check_violation THEN v_hit := SQLERRM LIKE 'availability_invalid: blackout % has no valid entry id'; END;
  IF NOT v_hit THEN RAISE EXCEPTION 'POST-CONDITION FAILED: a blackout without an id was accepted'; END IF;

  v_hit := false;
  BEGIN PERFORM * FROM venue_blackout_dates('{"blackouts":[{"id":"6d3a2b9e-1c3f-4b6e-9f0a-2b7c1d9e8f10","date":"2026-10-01","group_id":"x'');alert(1);//"}]}'::jsonb);
  EXCEPTION WHEN check_violation THEN v_hit := SQLERRM LIKE 'availability_invalid: blackout % has an invalid group id'; END;
  IF NOT v_hit THEN RAISE EXCEPTION 'POST-CONDITION FAILED: a non-uuid group id was accepted'; END IF;

  -- No hours -> nothing offered for a NEW reservation (the wildcard is gone).
  IF (SELECT o.ok FROM venue_slot_offered('{}'::jsonb, DATE '2026-10-06', 660) o) IS DISTINCT FROM false
     OR (SELECT o.reason FROM venue_slot_offered('{}'::jsonb, DATE '2026-10-06', 660) o) <> 'venue_hours_not_set' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: a venue without hours still offers slots';
  END IF;
END $$;

COMMIT;
