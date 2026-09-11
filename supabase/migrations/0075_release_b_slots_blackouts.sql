-- 0075_release_b_slots_blackouts.sql — Release B (Codex feature round §7 + §8): configurable demo
-- time slots and blackout dates, enforced inside the authoritative booking transaction.
--
-- WHAT WAS WRONG.
--   * The public booking page hard-coded two slots ("11:00 AM – 2:00 PM", "3:00 PM – 6:00 PM").
--     The admin "Demo Duration" setting was inert. Nothing on the server checked that a requested
--     demo_time was a slot the store offers; a tampered client could book any time string.
--   * Capacity (0047/0066/0069/0070) keyed on the EXACT demo_time text. "11:00", "11:00 AM" and
--     "11:00 am" were three different reservations for the same real slot — cap 1 could be bypassed
--     by spelling.
--   * venues.availability.blackouts existed but every writer wrote [] and no reader existed.
--   * Booking rows carried no duration; calendar feeds and end_at assumed 3 hours.
--
-- WHAT THIS DOES.
--   1. slot_minutes(text)/slot_key(text): one IMMUTABLE parser (same grammar as booking_slot_start)
--      so every capacity lock and count is keyed by the resolved minute of day, not by spelling.
--      enforce_slot_capacity(), enforce_slot_capacity_on_move() (0070), guard_capacity_decrease()
--      and capacity_invariant_violations() (0069) are re-issued on that key. Lock ORDER is unchanged:
--      venue row (FOR SHARE) -> per-slot advisory lock.
--   2. Slot configuration lives in venues.availability.slots = [{start:'HH:MM', hours:1..12}].
--      Key ABSENT (or availability NULL) = the historical defaults 11:00/3h + 15:00/3h. An EXPLICIT
--      empty list = nothing offered. Malformed = refused on write (venue guard) and, if it ever
--      reaches a booking, fails CLOSED (slot_config_invalid) — never silently reopens defaults.
--      Weekday hours (availability.schedule) filter which slots a given date offers; a slot is
--      offered only when it fits entirely inside an open window for that weekday.
--   3. Blackouts: availability.blackouts = [{date:'YYYY-MM-DD', reason?, group_id?, created_at?}].
--      Reason is private (the public projection strips it — api/find-retailer.js).
--   4. booking_slot_resolve(): BEFORE INSERT / UPDATE OF venue_id, demo_date, demo_time on bookings.
--      Locks the venue row FOR SHARE (so it serializes with any availability edit), refuses a
--      blacked-out date, an un-offered slot, a closed weekday, and sets bookings.duration_hours from
--      the configured slot — the browser never chooses length or end time. Runs for every path:
--      /api/book, staff bookings, accept_reschedule, admin moves, the Release C courtesy pass.
--      A venue that was never configured (availability NULL or {} — the 0000 default; fixtures)
--      has no slot rule at the database level; blackouts still apply. The public page offers
--      nothing for such a venue until hours are set, and once hours exist the defaults apply.
--   5. venue_availability_guard(): BEFORE INSERT / UPDATE OF availability on venues. Validates the
--      shape, and when the SLOT list changes refuses the edit if any future active reservation would
--      no longer map to an offered slot with the same length (slot_in_use, DETAIL = the affected
--      bookings as JSON). Blackouts and hours edits never touch existing reservations.
--   6. RPCs (service_role only, tenant-scoped, one transaction each):
--        venue_availability_set(...)      hours / slots / capacity with a version check; merges keys,
--                                         never replaces the blob from stale client state.
--        venue_blackouts_set(...)         add/remove dates on one venue or ALL CURRENT venues of the
--                                         retailer; merges dates only; returns the reservations that
--                                         remain valid on those dates; group_id lets an all-location
--                                         block be undone without deleting an independent local one.
--        venue_availability_apply_all(...) copies hours+slots+capacity to every venue, keeping each
--                                         venue's own blackouts; all-or-nothing.
--   7. accept_reschedule (0074) maps the new refusals to ok=false reasons.
--   8. offering_anomalies(): audit — future active reservations that no longer match their venue's
--      offering (expected: zero rows; a refused-in-use edit keeps it that way).
--
-- Forward-only. Never edit an applied migration.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. Slot parsing (IMMUTABLE so it can key locks, counts and — later — indexes).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.slot_minutes(p_time text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE m text[]; v_h integer; v_min integer; v_ampm text;
BEGIN
  m := regexp_match(coalesce(p_time, ''), '^\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s*$');
  IF m IS NULL THEN RETURN NULL; END IF;
  v_h    := m[1]::integer;
  v_min  := coalesce(m[2]::integer, 0);
  v_ampm := lower(replace(coalesce(m[3], ''), '.', ''));
  IF v_min > 59 THEN RETURN NULL; END IF;
  IF v_ampm <> '' THEN
    IF v_h < 1 OR v_h > 12 THEN RETURN NULL; END IF;
    IF v_ampm = 'pm' AND v_h <> 12 THEN v_h := v_h + 12; END IF;
    IF v_ampm = 'am' AND v_h = 12 THEN v_h := 0; END IF;
  ELSIF v_h > 23 THEN
    RETURN NULL;
  END IF;
  RETURN v_h * 60 + v_min;
END $$;

-- Canonical storage/display spelling of a minute-of-day: "11:00 AM", "3:30 PM".
CREATE OR REPLACE FUNCTION public.slot_label(p_minutes integer)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_minutes IS NULL THEN NULL ELSE
    (CASE WHEN (p_minutes / 60) % 12 = 0 THEN 12 ELSE (p_minutes / 60) % 12 END)::text
    || ':' || lpad((p_minutes % 60)::text, 2, '0')
    || CASE WHEN p_minutes >= 720 THEN ' PM' ELSE ' AM' END END
$$;

-- The capacity key: resolved minute when parseable, else the trimmed raw text (legacy rows).
CREATE OR REPLACE FUNCTION public.slot_key(p_time text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(slot_minutes(p_time)::text, 'raw:' || lower(btrim(coalesce(p_time, ''))))
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Columns.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS duration_hours integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_duration_hours_range' AND conrelid = 'public.bookings'::regclass) THEN
    ALTER TABLE public.bookings ADD CONSTRAINT bookings_duration_hours_range
      CHECK (duration_hours IS NULL OR (duration_hours >= 1 AND duration_hours <= 12)) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.bookings VALIDATE CONSTRAINT bookings_duration_hours_range;
COMMENT ON COLUMN public.bookings.duration_hours IS
  '0075: length of the booked slot, set by booking_slot_resolve() from the venue configuration at booking/move time. NULL on legacy rows = 3.';

ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS availability_version integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.venues.availability_version IS
  '0075: bumped by every availability RPC; venue_availability_set() refuses a stale expected version.';

-- ---------------------------------------------------------------------------------------------
-- 3. Configuration readers. All raise check_violation with a stable prefix on malformed input.
-- ---------------------------------------------------------------------------------------------
-- Slots: absent key -> defaults; [] -> none; malformed -> slot_config_invalid.
CREATE OR REPLACE FUNCTION public.venue_slots_config(p_availability jsonb)
RETURNS TABLE(start_min integer, hours integer)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_slots jsonb;
  v_el    jsonb;
  v_start text;
  v_hours jsonb;
  v_min   integer;
  v_h     integer;
  v_prev_end integer := -1;
  v_starts integer[] := '{}';
  v_hrs    integer[] := '{}';
  v_seen  integer[] := '{}';
  r record;
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
    v_start := v_el->>'start';
    v_hours := v_el->'hours';
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
    IF v_min + v_h * 60 > 1440 THEN
      RAISE EXCEPTION 'slot_config_invalid: slot % runs past midnight', v_start USING errcode = 'check_violation';
    END IF;
    IF v_min = ANY (v_seen) THEN
      RAISE EXCEPTION 'slot_config_invalid: duplicate start %', v_start USING errcode = 'check_violation';
    END IF;
    v_seen := v_seen || v_min;
    v_starts := v_starts || v_min; v_hrs := v_hrs || v_h;
  END LOOP;
  -- Overlap check in start order.
  FOR r IN SELECT t.s, t.h FROM unnest(v_starts, v_hrs) AS t(s, h) ORDER BY t.s LOOP
    IF r.s < v_prev_end THEN
      RAISE EXCEPTION 'slot_config_invalid: slot % overlaps the previous slot', slot_label(r.s) USING errcode = 'check_violation';
    END IF;
    v_prev_end := r.s + r.h * 60;
    start_min := r.s; hours := r.h;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

-- Weekday open windows. Legacy shapes accepted: [] / null / [{open,close,preferred?}] / {open,close}.
-- Times may be "HH:MM" or "h:mm AM" (both are in the wild); parse failures are availability_invalid.
CREATE OR REPLACE FUNCTION public.venue_day_windows(p_availability jsonb, p_dow integer)
RETURNS TABLE(open_min integer, close_min integer)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_day jsonb; v_el jsonb; v_o integer; v_c integer;
BEGIN
  IF p_availability IS NULL OR jsonb_typeof(p_availability) <> 'object' OR NOT (p_availability ? 'schedule') THEN RETURN; END IF;
  IF jsonb_typeof(p_availability->'schedule') <> 'object' THEN
    RAISE EXCEPTION 'availability_invalid: schedule must be an object' USING errcode = 'check_violation';
  END IF;
  v_day := p_availability->'schedule'->(p_dow::text);
  IF v_day IS NULL OR jsonb_typeof(v_day) = 'null' THEN RETURN; END IF;
  IF jsonb_typeof(v_day) = 'object' THEN v_day := jsonb_build_array(v_day); END IF;
  IF jsonb_typeof(v_day) <> 'array' THEN
    RAISE EXCEPTION 'availability_invalid: schedule day % must be a list of windows', p_dow USING errcode = 'check_violation';
  END IF;
  FOR v_el IN SELECT value FROM jsonb_array_elements(v_day) LOOP
    IF jsonb_typeof(v_el) <> 'object' THEN
      RAISE EXCEPTION 'availability_invalid: window on day % must be an object', p_dow USING errcode = 'check_violation';
    END IF;
    IF coalesce(v_el->>'open', '') = '' AND coalesce(v_el->>'close', '') = '' THEN CONTINUE; END IF;
    v_o := slot_minutes(v_el->>'open'); v_c := slot_minutes(v_el->>'close');
    IF v_o IS NULL OR v_c IS NULL OR v_c <= v_o THEN
      RAISE EXCEPTION 'availability_invalid: window %-% on day % is not a valid open/close pair',
        coalesce(v_el->>'open','?'), coalesce(v_el->>'close','?'), p_dow USING errcode = 'check_violation';
    END IF;
    open_min := v_o; close_min := v_c; RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

CREATE OR REPLACE FUNCTION public.venue_schedule_present(p_availability jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_availability IS NOT NULL AND jsonb_typeof(p_availability) = 'object' AND (p_availability ? 'schedule')
     AND jsonb_typeof(p_availability->'schedule') = 'object'
$$;

-- "Configured" = the retailer has set hours or slots. venues.availability defaults to {} (0000), so
-- NULL and {} are both "never configured": no offering rule at this level (legacy rows, fixtures);
-- blackouts, if any, still apply. The public page offers nothing for such a venue until hours exist.
CREATE OR REPLACE FUNCTION public.venue_slot_configured(p_availability jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_availability IS NOT NULL AND jsonb_typeof(p_availability) = 'object'
     AND ((p_availability ? 'slots') OR (p_availability ? 'schedule'))
$$;

-- Blackouts: absent -> none; malformed -> availability_invalid.
CREATE OR REPLACE FUNCTION public.venue_blackout_dates(p_availability jsonb)
RETURNS TABLE(blackout_date date, reason text, group_id text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_arr jsonb; v_el jsonb; v_d date; v_seen date[] := '{}';
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
    BEGIN
      v_d := (v_el->>'date')::date;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'availability_invalid: blackout date % is not a real date', v_el->>'date' USING errcode = 'check_violation';
    END;
    IF v_d = ANY (v_seen) THEN
      RAISE EXCEPTION 'availability_invalid: blackout date % listed twice', v_d USING errcode = 'check_violation';
    END IF;
    IF length(coalesce(v_el->>'reason', '')) > 200 THEN
      RAISE EXCEPTION 'availability_invalid: blackout reason too long (%)', v_d USING errcode = 'check_violation';
    END IF;
    v_seen := v_seen || v_d;
    blackout_date := v_d; reason := v_el->>'reason'; group_id := v_el->>'group_id';
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;

-- Whole-blob validation (used by the venue guard). NULL is valid (unconfigured venue).
CREATE OR REPLACE FUNCTION public.venue_availability_validate(p_availability jsonb)
RETURNS void
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_dow integer;
BEGIN
  IF p_availability IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_availability) <> 'object' THEN
    RAISE EXCEPTION 'availability_invalid: availability must be an object' USING errcode = 'check_violation';
  END IF;
  PERFORM * FROM venue_slots_config(p_availability);
  FOR v_dow IN 0..6 LOOP PERFORM * FROM venue_day_windows(p_availability, v_dow); END LOOP;
  PERFORM * FROM venue_blackout_dates(p_availability);
END $$;

-- Is (date, minute) an offered slot at this venue? One decision for every writer.
--   reasons: date_blackout | slot_not_offered | venue_closed | slot_outside_hours | (ok)
-- (slot_config_invalid / availability_invalid propagate as exceptions: fail closed.)
CREATE OR REPLACE FUNCTION public.venue_slot_offered(p_availability jsonb, p_date date, p_minutes integer)
RETURNS TABLE(ok boolean, reason text, hours integer)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v_hours integer; v_dow integer; v_fits boolean; v_has_windows boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM venue_blackout_dates(p_availability) bd WHERE bd.blackout_date = p_date) THEN
    RETURN QUERY SELECT false, 'date_blackout'::text, NULL::integer; RETURN;
  END IF;
  SELECT sc.hours INTO v_hours FROM venue_slots_config(p_availability) sc WHERE sc.start_min = p_minutes;
  IF v_hours IS NULL THEN
    RETURN QUERY SELECT false, 'slot_not_offered'::text, NULL::integer; RETURN;
  END IF;
  IF venue_schedule_present(p_availability) THEN
    v_dow := extract(dow FROM p_date)::integer;
    SELECT count(*) > 0, bool_or(p_minutes >= w.open_min AND p_minutes + v_hours * 60 <= w.close_min)
      INTO v_has_windows, v_fits
      FROM venue_day_windows(p_availability, v_dow) w;
    IF NOT coalesce(v_has_windows, false) THEN
      RETURN QUERY SELECT false, 'venue_closed'::text, NULL::integer; RETURN;
    END IF;
    IF NOT coalesce(v_fits, false) THEN
      RETURN QUERY SELECT false, 'slot_outside_hours'::text, NULL::integer; RETURN;
    END IF;
  END IF;
  RETURN QUERY SELECT true, NULL::text, v_hours;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4. booking_slot_resolve(): the authoritative offering check, under the venue lock.
--    Trigger name sorts BEFORE trg_booking_slot_snapshot and trg_enforce_slot_capacity* (BEFORE
--    triggers fire in name order), so end_at and the capacity count see the resolved duration.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_slot_resolve() RETURNS trigger AS $$
DECLARE v_av jsonb; v_found boolean; v_min integer; v_ok boolean; v_reason text; v_hours integer;
BEGIN
  -- Rows that never consume capacity are not offering-checked (a cancelled insert, a cancelled
  -- row being edited). Reactivation is the capacity trigger's concern, not this one's.
  IF coalesce(NEW.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled') THEN
    RETURN NEW;
  END IF;
  IF NEW.venue_id IS NULL THEN RETURN NEW; END IF;   -- enforce_slot_capacity raises for this

  -- Venue row lock FIRST — the same lock and order as enforce_slot_capacity() (0070). An
  -- availability edit (UPDATE venues ... FOR UPDATE inside the RPCs) waits for us or we wait for it;
  -- what we read here is what the committed edit says.
  SELECT v.availability INTO v_av FROM venues v
   WHERE v.id = NEW.venue_id AND v.retailer_id = NEW.retailer_id
   FOR SHARE;
  v_found := FOUND;
  IF NOT v_found THEN RETURN NEW; END IF;          -- enforce_slot_capacity raises for this too

  -- A blackout applies to every venue, configured or not.
  IF EXISTS (SELECT 1 FROM venue_blackout_dates(v_av) bd WHERE bd.blackout_date = NEW.demo_date) THEN
    RAISE EXCEPTION 'date_blackout: % is blocked at this location', NEW.demo_date USING errcode = 'check_violation';
  END IF;
  IF NOT venue_slot_configured(v_av) THEN
    -- Never configured (NULL or {}): no offering rule at this level. Keep a sane length for end_at.
    NEW.duration_hours := coalesce(NEW.duration_hours, 3);
    RETURN NEW;
  END IF;

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
  -- Duration is the configured slot's — never the caller's.
  NEW.duration_hours := v_hours;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_slot_resolve ON public.bookings;
CREATE TRIGGER trg_booking_slot_resolve
  BEFORE INSERT OR UPDATE OF venue_id, demo_date, demo_time ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_slot_resolve();

-- Snapshot (0074): end_at now comes from bookings.duration_hours first; refresh on a duration change.
CREATE OR REPLACE FUNCTION public.booking_slot_snapshot() RETURNS trigger AS $$
DECLARE v_tz text; v_hours integer;
BEGIN
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  NEW.timezone := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  NEW.start_at := booking_slot_start(NEW.demo_date, NEW.demo_time, NEW.timezone, 11);
  IF NEW.start_at IS NULL THEN
    NEW.end_at := NULL;
  ELSE
    v_hours := NEW.duration_hours;
    IF v_hours IS NULL THEN
      SELECT d.duration_hours INTO v_hours FROM demos d WHERE d.booking_id = NEW.id LIMIT 1;
    END IF;
    NEW.end_at := NEW.start_at + make_interval(hours => coalesce(v_hours, 3));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_slot_snapshot ON public.bookings;
CREATE TRIGGER trg_booking_slot_snapshot
  BEFORE INSERT OR UPDATE OF demo_date, demo_time, retailer_id, duration_hours ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_slot_snapshot();

-- ---------------------------------------------------------------------------------------------
-- 5. Capacity on the NORMALIZED slot key (0070 bodies re-issued; lock order and re-checks intact).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_slot_capacity() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint; v_slot text;
BEGIN
  IF NEW.venue_id IS NULL THEN RAISE EXCEPTION 'booking requires a valid venue'; END IF;
  IF coalesce(NEW.status,'pending') IN ('cancelled','declined','expired','auth_canceled') THEN RETURN NEW; END IF;

  -- 1. Venue row lock FIRST (see 0070). The cap used below is the one read under that lock.
  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id
   FOR SHARE;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  -- 2. Per-slot advisory lock on the RESOLVED slot (0075): "11:00", "11:00 AM" and "11:00 am"
  --    are one slot, one lock, one count.
  v_slot := slot_key(NEW.demo_time);
  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || v_slot, 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id
     AND demo_date = NEW.demo_date
     AND slot_key(demo_time) = v_slot
     AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_slot_capacity ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity();

CREATE OR REPLACE FUNCTION enforce_slot_capacity_on_move() RETURNS trigger AS $$
DECLARE
  cap int; taken int; v_key bigint; v_slot text;
  slot_changed boolean;
  reactivated  boolean;
BEGIN
  slot_changed := NEW.venue_id   IS DISTINCT FROM OLD.venue_id
               OR NEW.demo_date  IS DISTINCT FROM OLD.demo_date
               OR slot_key(NEW.demo_time) IS DISTINCT FROM slot_key(OLD.demo_time);
  reactivated  :=     coalesce(OLD.status,'pending')     IN ('cancelled','declined','expired','auth_canceled')
               AND coalesce(NEW.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  IF NOT slot_changed AND NOT reactivated THEN RETURN NEW; END IF;
  IF coalesce(NEW.status,'pending') IN ('cancelled','declined','expired','auth_canceled') THEN RETURN NEW; END IF;

  -- 1. Venue row lock FIRST (see enforce_slot_capacity).
  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id
   FOR SHARE;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  -- 2. Per-slot advisory lock on the DESTINATION slot, normalized (0075).
  v_slot := slot_key(NEW.demo_time);
  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || v_slot, 0);
  PERFORM pg_advisory_xact_lock(v_key);

  -- 3. Count the OTHER active bookings on the destination slot (a same-slot reactivation counts
  --    correctly because the row itself is excluded).
  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id AND demo_date = NEW.demo_date AND slot_key(demo_time) = v_slot
     AND id <> NEW.id
     AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_slot_capacity_move ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity_move
  BEFORE UPDATE OF venue_id, demo_date, demo_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity_on_move();

CREATE OR REPLACE FUNCTION guard_capacity_decrease() RETURNS trigger AS $$
DECLARE
  v_slot record;
  v_taken int;
  v_key bigint;
BEGIN
  IF NEW.max_demos_per_slot IS NULL OR OLD.max_demos_per_slot IS NULL
     OR NEW.max_demos_per_slot >= OLD.max_demos_per_slot THEN
    RETURN NEW;
  END IF;

  FOR v_slot IN
    SELECT demo_date, slot_key(demo_time), min(demo_time) AS demo_time
      FROM bookings
     WHERE venue_id = NEW.id
       AND demo_date >= current_date
       AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
     GROUP BY demo_date, slot_key(demo_time)
     ORDER BY demo_date, slot_key(demo_time)
  LOOP
    v_key := hashtextextended(NEW.id::text || '|' || coalesce(v_slot.demo_date::text,'') || '|' || v_slot.slot_key, 0);
    PERFORM pg_advisory_xact_lock(v_key);

    SELECT count(*) INTO v_taken FROM bookings
     WHERE venue_id = NEW.id
       AND demo_date = v_slot.demo_date
       AND slot_key(demo_time) = v_slot.slot_key
       AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

    IF v_taken > NEW.max_demos_per_slot THEN
      RAISE EXCEPTION 'capacity_below_active_reservations: venue % has % active reservation(s) for % % but proposed max_demos_per_slot is % (current %)',
        NEW.id, v_taken, v_slot.demo_date, v_slot.demo_time, NEW.max_demos_per_slot, OLD.max_demos_per_slot
        USING errcode = 'check_violation',
              hint = 'Cancel or move the excess reservations first, then lower the capacity.';
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION capacity_invariant_violations(p_venue_id uuid DEFAULT NULL, p_future_only boolean DEFAULT true)
RETURNS TABLE(venue_id uuid, retailer_id uuid, demo_date date, demo_time text, active_count bigint, max_demos_per_slot integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.venue_id, v.retailer_id, b.demo_date, min(b.demo_time) AS demo_time, count(*) AS active_count, v.max_demos_per_slot
    FROM bookings b
    JOIN venues v ON v.id = b.venue_id
   WHERE (p_venue_id IS NULL OR b.venue_id = p_venue_id)
     AND (NOT p_future_only OR b.demo_date >= current_date)
     AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
   GROUP BY b.venue_id, v.retailer_id, b.demo_date, slot_key(b.demo_time), v.max_demos_per_slot
  HAVING count(*) > v.max_demos_per_slot
   ORDER BY b.venue_id, b.demo_date, min(b.demo_time)
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. Venue guard: validate on write; a SLOT change may not orphan a future reservation.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.venue_availability_guard() RETURNS trigger AS $$
DECLARE
  v_old_slots text; v_new_slots text; v_tz text; v_today date; v_affected jsonb; v_n integer;
BEGIN
  PERFORM venue_availability_validate(NEW.availability);
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  SELECT string_agg(sc.start_min::text || ':' || sc.hours::text, ',' ORDER BY sc.start_min) INTO v_old_slots FROM venue_slots_config(OLD.availability) sc;
  SELECT string_agg(sc.start_min::text || ':' || sc.hours::text, ',' ORDER BY sc.start_min) INTO v_new_slots FROM venue_slots_config(NEW.availability) sc;
  IF v_old_slots IS NOT DISTINCT FROM v_new_slots THEN RETURN NEW; END IF;   -- hours/blackout-only edit

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  v_today := (now() AT TIME ZONE coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles'))::date;

  -- Every future active reservation must still map to an offered slot of the same length.
  SELECT count(*), jsonb_agg(jsonb_build_object('booking_id', x.id, 'demo_date', x.demo_date, 'demo_time', x.demo_time,
                                                'status', x.status, 'brand_name', x.brand_name) ORDER BY x.demo_date, x.demo_time)
    INTO v_n, v_affected
    FROM (
      SELECT b.id, b.demo_date, b.demo_time, b.status, b.brand_name
        FROM bookings b
       WHERE b.venue_id = NEW.id
         AND b.demo_date >= v_today
         AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
         AND NOT EXISTS (
               SELECT 1 FROM venue_slots_config(NEW.availability) sc
                WHERE sc.start_min = slot_minutes(b.demo_time)
                  AND sc.hours = coalesce(b.duration_hours, 3))
       ORDER BY b.demo_date, b.demo_time
       LIMIT 50
    ) x;
  IF coalesce(v_n, 0) > 0 THEN
    RAISE EXCEPTION 'slot_in_use: % upcoming reservation(s) sit on a slot this change removes or shortens', v_n
      USING errcode = 'check_violation',
            detail  = v_affected::text,
            hint    = 'Keep those slots (same start and length) or wait until the demos have run. Nothing was changed.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_availability_guard ON public.venues;
CREATE TRIGGER trg_venue_availability_guard
  BEFORE INSERT OR UPDATE OF availability ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.venue_availability_guard();

-- ---------------------------------------------------------------------------------------------
-- 7. RPCs. SECURITY DEFINER, service_role only; every one pins the venue(s) to p_retailer_id.
-- ---------------------------------------------------------------------------------------------
-- Hours / slots / capacity on ONE venue, merged key-by-key under a version check.
--   p_schedule NULL = untouched; p_slots NULL = untouched; p_reset_slots = drop the key (defaults);
--   p_max_demos_per_slot NULL = untouched.
CREATE OR REPLACE FUNCTION public.venue_availability_set(
  p_retailer_id uuid, p_venue_id uuid, p_expected_version integer,
  p_schedule jsonb DEFAULT NULL, p_slots jsonb DEFAULT NULL, p_reset_slots boolean DEFAULT false,
  p_max_demos_per_slot integer DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, detail jsonb, availability jsonb, availability_version integer, max_demos_per_slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v venues%ROWTYPE; v_av jsonb; v_msg text; v_detail text; v_reason text;
BEGIN
  IF p_retailer_id IS NULL OR p_venue_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  SELECT * INTO v FROM venues WHERE id = p_venue_id AND retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> v.availability_version THEN
    RETURN QUERY SELECT false, 'stale_version'::text, jsonb_build_object('current_version', v.availability_version),
                        v.availability, v.availability_version, v.max_demos_per_slot; RETURN;
  END IF;
  IF p_max_demos_per_slot IS NOT NULL AND p_max_demos_per_slot < 1 THEN
    RETURN QUERY SELECT false, 'invalid_capacity'::text, NULL::jsonb, v.availability, v.availability_version, v.max_demos_per_slot; RETURN;
  END IF;

  v_av := coalesce(v.availability, '{}'::jsonb);
  IF jsonb_typeof(v_av) <> 'object' THEN v_av := '{}'::jsonb; END IF;
  IF p_schedule IS NOT NULL THEN v_av := jsonb_set(v_av, '{schedule}', p_schedule, true); END IF;
  IF p_reset_slots THEN v_av := v_av - 'slots';
  ELSIF p_slots IS NOT NULL THEN v_av := jsonb_set(v_av, '{slots}', p_slots, true); END IF;
  IF NOT (v_av ? 'blackouts') THEN v_av := jsonb_set(v_av, '{blackouts}', '[]'::jsonb, true); END IF;

  BEGIN
    UPDATE venues
       SET availability = v_av,
           availability_version = venues.availability_version + 1,
           max_demos_per_slot = coalesce(p_max_demos_per_slot, venues.max_demos_per_slot)
     WHERE id = p_venue_id
    RETURNING * INTO v;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    v_reason := split_part(v_msg, ':', 1);
    IF v_reason NOT IN ('slot_in_use', 'availability_invalid', 'slot_config_invalid', 'capacity_below_active_reservations') THEN RAISE; END IF;
    RETURN QUERY SELECT false, v_reason,
      CASE WHEN v_reason = 'slot_in_use' AND coalesce(v_detail, '') <> '' THEN jsonb_build_object('message', v_msg, 'affected', v_detail::jsonb)
           ELSE jsonb_build_object('message', v_msg) END,
      v.availability, v.availability_version, v.max_demos_per_slot;
    RETURN;
  END;
  RETURN QUERY SELECT true, NULL::text, NULL::jsonb, v.availability, v.availability_version, v.max_demos_per_slot;
END $$;
REVOKE ALL ON FUNCTION public.venue_availability_set(uuid, uuid, integer, jsonb, jsonb, boolean, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_availability_set(uuid, uuid, integer, jsonb, jsonb, boolean, integer) TO service_role;

-- Blackouts: add or remove dates on chosen venues, or on ALL CURRENT venues (p_venue_ids NULL).
-- Merges dates only; hours, slots and other dates are untouched. Existing reservations on those
-- dates stay valid and are returned in `affected` so the UI can warn before/after.
CREATE OR REPLACE FUNCTION public.venue_blackouts_set(
  p_retailer_id uuid, p_op text, p_dates date[], p_venue_ids uuid[] DEFAULT NULL,
  p_reason text DEFAULT NULL, p_group_id uuid DEFAULT NULL)
RETURNS TABLE(venue_id uuid, venue_name text, availability_version integer, group_id uuid, blackouts jsonb, affected jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v venues%ROWTYPE; v_ids uuid[]; v_group uuid; v_arr jsonb; v_new jsonb; v_el jsonb; v_d date;
  v_present date[]; v_affected jsonb; v_reason text;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'not_found' USING errcode = 'no_data_found'; END IF;
  IF p_op NOT IN ('add', 'remove') THEN RAISE EXCEPTION 'invalid_op: % (add|remove)', p_op USING errcode = 'check_violation'; END IF;
  IF p_dates IS NULL OR cardinality(p_dates) = 0 OR cardinality(p_dates) > 366 THEN
    RAISE EXCEPTION 'invalid_dates: 1-366 dates required' USING errcode = 'check_violation';
  END IF;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  IF length(coalesce(v_reason, '')) > 200 THEN RAISE EXCEPTION 'invalid_reason: too long' USING errcode = 'check_violation'; END IF;

  -- Venue set, tenant-pinned. A foreign or unknown id is a hard refusal (no partial application).
  IF p_venue_ids IS NULL THEN
    SELECT array_agg(x.id ORDER BY x.id) INTO v_ids FROM venues x WHERE x.retailer_id = p_retailer_id;
  ELSE
    SELECT array_agg(x.id ORDER BY x.id) INTO v_ids FROM venues x WHERE x.retailer_id = p_retailer_id AND x.id = ANY (p_venue_ids);
    IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_venue_ids))) THEN
      RAISE EXCEPTION 'not_found: a venue is not yours or does not exist' USING errcode = 'no_data_found';
    END IF;
  END IF;
  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN RETURN; END IF;
  v_group := coalesce(p_group_id, gen_random_uuid());

  -- Lock every target venue in id order (one lock order everywhere), then merge.
  FOR v IN SELECT * FROM venues x WHERE x.id = ANY (v_ids) ORDER BY x.id FOR UPDATE LOOP
    v_arr := CASE WHEN v.availability IS NOT NULL AND jsonb_typeof(v.availability) = 'object'
                   AND jsonb_typeof(v.availability->'blackouts') = 'array' THEN v.availability->'blackouts' ELSE '[]'::jsonb END;
    IF p_op = 'add' THEN
      SELECT coalesce(array_agg(bd.blackout_date), '{}') INTO v_present FROM venue_blackout_dates(v.availability) bd;
      v_new := v_arr;
      FOREACH v_d IN ARRAY (SELECT array_agg(DISTINCT d ORDER BY d) FROM unnest(p_dates) d) LOOP
        IF NOT (v_d = ANY (v_present)) THEN
          v_new := v_new || jsonb_build_array(
            jsonb_strip_nulls(jsonb_build_object('date', to_char(v_d, 'YYYY-MM-DD'), 'reason', v_reason,
                                                 'group_id', v_group::text, 'created_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
        END IF;
      END LOOP;
    ELSE
      SELECT coalesce(jsonb_agg(e.value), '[]'::jsonb) INTO v_new
        FROM jsonb_array_elements(v_arr) e
       WHERE NOT ( (e.value->>'date') = ANY (SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(p_dates) d)
                   AND (p_group_id IS NULL OR e.value->>'group_id' = p_group_id::text) );
    END IF;

    UPDATE venues
       SET availability = jsonb_set(CASE WHEN v.availability IS NULL OR jsonb_typeof(v.availability) <> 'object' THEN '{}'::jsonb ELSE v.availability END,
                                    '{blackouts}', v_new, true),
           availability_version = venues.availability_version + 1
     WHERE id = v.id
    RETURNING venues.availability_version INTO v.availability_version;

    SELECT coalesce(jsonb_agg(jsonb_build_object('booking_id', b.id, 'demo_date', b.demo_date, 'demo_time', b.demo_time,
                                                 'status', b.status, 'brand_name', b.brand_name) ORDER BY b.demo_date, b.demo_time), '[]'::jsonb)
      INTO v_affected
      FROM bookings b
     WHERE b.venue_id = v.id AND b.demo_date = ANY (p_dates)
       AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

    venue_id := v.id; venue_name := v.name; availability_version := v.availability_version;
    group_id := CASE WHEN p_op = 'add' THEN v_group ELSE p_group_id END; blackouts := v_new; affected := v_affected;
    RETURN NEXT;
  END LOOP;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_blackouts_set(uuid, text, date[], uuid[], text, uuid) TO service_role;

-- Copy hours + slots + capacity from one venue to every other venue of the retailer. Each venue
-- keeps its own blackouts. All-or-nothing: one refused venue (slot_in_use there) rolls back all.
CREATE OR REPLACE FUNCTION public.venue_availability_apply_all(p_retailer_id uuid, p_source_venue_id uuid)
RETURNS TABLE(ok boolean, reason text, detail jsonb, venue_id uuid, venue_name text, availability_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE src venues%ROWTYPE; v venues%ROWTYPE; v_av jsonb; v_msg text; v_detail text; v_reason text;
        v_rows jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO src FROM venues WHERE id = p_source_venue_id AND retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::integer; RETURN;
  END IF;
  BEGIN
    FOR v IN SELECT * FROM venues x WHERE x.retailer_id = p_retailer_id AND x.id <> src.id ORDER BY x.id FOR UPDATE LOOP
      v_av := CASE WHEN v.availability IS NULL OR jsonb_typeof(v.availability) <> 'object' THEN '{}'::jsonb ELSE v.availability END;
      IF src.availability IS NOT NULL AND (src.availability ? 'schedule') THEN v_av := jsonb_set(v_av, '{schedule}', src.availability->'schedule', true);
      ELSE v_av := v_av - 'schedule'; END IF;
      IF src.availability IS NOT NULL AND (src.availability ? 'slots') THEN v_av := jsonb_set(v_av, '{slots}', src.availability->'slots', true);
      ELSE v_av := v_av - 'slots'; END IF;
      IF NOT (v_av ? 'blackouts') THEN v_av := jsonb_set(v_av, '{blackouts}', '[]'::jsonb, true); END IF;
      BEGIN
        UPDATE venues
           SET availability = v_av,
               availability_version = venues.availability_version + 1,
               max_demos_per_slot = src.max_demos_per_slot
         WHERE id = v.id
        RETURNING venues.availability_version INTO v.availability_version;
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
        v_reason := split_part(v_msg, ':', 1);
        IF v_reason NOT IN ('slot_in_use', 'availability_invalid', 'slot_config_invalid', 'capacity_below_active_reservations') THEN RAISE; END IF;
        RAISE EXCEPTION 'apply_all_refused' USING errcode = 'check_violation',
          detail = jsonb_build_object('reason', v_reason, 'venue_id', v.id, 'venue_name', v.name, 'message', v_msg,
                                      'affected', CASE WHEN coalesce(v_detail,'') <> '' THEN v_detail::jsonb ELSE NULL END)::text;
      END;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('venue_id', v.id, 'venue_name', v.name, 'availability_version', v.availability_version));
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg <> 'apply_all_refused' THEN RAISE; END IF;
    -- The sub-transaction rolled every venue back; report the one that refused.
    RETURN QUERY SELECT false, (v_detail::jsonb)->>'reason', v_detail::jsonb,
                        ((v_detail::jsonb)->>'venue_id')::uuid, (v_detail::jsonb)->>'venue_name', NULL::integer;
    RETURN;
  END;
  RETURN QUERY SELECT true, NULL::text, NULL::jsonb, (e->>'venue_id')::uuid, e->>'venue_name', (e->>'availability_version')::integer
    FROM jsonb_array_elements(v_rows) e;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_availability_apply_all(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_availability_apply_all(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. accept_reschedule (0074) with the new refusal reasons. Body otherwise identical.
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
    RETURNING bookings.schedule_revision INTO v_new_rev;
  EXCEPTION WHEN check_violation THEN
    -- 0075: the slot-resolve trigger (offering/blackout/hours) raises with the same errcode as the
    -- capacity trigger; each becomes an ok=false reason with the UPDATE rolled back.
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_not_offered%' THEN RETURN QUERY SELECT false, 'slot_not_offered'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_outside_hours%' THEN RETURN QUERY SELECT false, 'slot_outside_hours'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'date_blackout%' THEN RETURN QUERY SELECT false, 'date_blackout'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'venue_closed%' THEN RETURN QUERY SELECT false, 'venue_closed'::text, v_old_rev; RETURN; END IF;
    IF SQLERRM LIKE 'slot_config_invalid%' THEN RETURN QUERY SELECT false, 'slot_config_invalid'::text, v_old_rev; RETURN; END IF;
    RAISE;
  END;
  -- (trg_booking_slot_snapshot recomputed start_at/end_at/timezone in the same UPDATE.)

  -- 9. Project onto the calendar row and consume the proposal.
  UPDATE demos
     SET demo_date = v_new_date, demo_time = v_new_time,
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
-- 9. Audit: future active reservations whose SLOT INTERVAL no longer matches their venue's slot
--    list (removed start, changed length, unparseable time, broken configuration). Blackouts and
--    hours edits are deliberately NOT anomalies: both are allowed while reservations exist and
--    leave those reservations valid (Codex §8).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offering_anomalies(p_retailer_id uuid DEFAULT NULL)
RETURNS TABLE(booking_id uuid, venue_id uuid, retailer_id uuid, demo_date date, demo_time text, duration_hours integer, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_ok boolean; v_reason text; v_hours integer; v_min integer;
BEGIN
  FOR r IN
    SELECT b.id, b.venue_id, b.retailer_id, b.demo_date, b.demo_time, b.duration_hours, v.availability
      FROM bookings b JOIN venues v ON v.id = b.venue_id
     WHERE (p_retailer_id IS NULL OR b.retailer_id = p_retailer_id)
       AND b.demo_date >= current_date
       AND venue_slot_configured(v.availability)
       AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
     ORDER BY b.demo_date, b.demo_time
  LOOP
    v_min := slot_minutes(r.demo_time);
    IF v_min IS NULL THEN
      booking_id := r.id; venue_id := r.venue_id; retailer_id := r.retailer_id; demo_date := r.demo_date; demo_time := r.demo_time;
      duration_hours := r.duration_hours; reason := 'unparseable_time'; RETURN NEXT; CONTINUE;
    END IF;
    BEGIN
      SELECT o.ok, o.reason, o.hours INTO v_ok, v_reason, v_hours FROM venue_slot_offered(r.availability, r.demo_date, v_min) o;
    EXCEPTION WHEN check_violation THEN
      v_ok := false; v_reason := split_part(SQLERRM, ':', 1);
    END;
    IF v_reason IN ('date_blackout', 'venue_closed', 'slot_outside_hours') THEN
      -- Allowed to coexist with the reservation; check only that the slot itself still exists.
      SELECT sc.hours INTO v_hours FROM venue_slots_config(r.availability) sc WHERE sc.start_min = v_min;
      v_ok := v_hours IS NOT NULL; v_reason := CASE WHEN v_ok THEN NULL ELSE 'slot_not_offered' END;
    END IF;
    IF NOT coalesce(v_ok, false) OR v_hours IS DISTINCT FROM coalesce(r.duration_hours, 3) THEN
      booking_id := r.id; venue_id := r.venue_id; retailer_id := r.retailer_id; demo_date := r.demo_date; demo_time := r.demo_time;
      duration_hours := r.duration_hours;
      reason := CASE WHEN coalesce(v_ok, false) THEN 'duration_mismatch' ELSE v_reason END;
      RETURN NEXT;
    END IF;
  END LOOP;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.offering_anomalies(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offering_anomalies(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 10. Backfill duration from the calendar projection (fires the snapshot trigger -> end_at).
-- ---------------------------------------------------------------------------------------------
UPDATE bookings b
   SET duration_hours = d.duration_hours
  FROM demos d
 WHERE d.booking_id = b.id
   AND b.duration_hours IS NULL
   AND d.duration_hours BETWEEN 1 AND 12;

-- ---------------------------------------------------------------------------------------------
-- 11. Post-conditions.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE v_src text; v_cols text; v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='bookings' AND column_name='duration_hours') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: bookings.duration_hours missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='venues' AND column_name='availability_version') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: venues.availability_version missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_booking_slot_resolve' AND tgrelid = 'public.bookings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_slot_resolve not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_venue_availability_guard' AND tgrelid = 'public.venues'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_venue_availability_guard not installed';
  END IF;
  -- Firing order: resolve < snapshot < enforce (BEFORE triggers fire in name order).
  IF NOT ('trg_booking_slot_resolve' < 'trg_booking_slot_snapshot' AND 'trg_booking_slot_snapshot' < 'trg_enforce_slot_capacity') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trigger name order broken';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_slot_capacity';
  IF v_src IS NULL OR v_src NOT ILIKE '%FOR SHARE%' OR v_src NOT ILIKE '%slot_key(%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: enforce_slot_capacity() lacks FOR SHARE or the normalized slot key';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_slot_capacity_on_move';
  IF v_src IS NULL OR v_src NOT ILIKE '%FOR SHARE%' OR v_src NOT ILIKE '%reactivated%' OR v_src NOT ILIKE '%slot_key(%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: enforce_slot_capacity_on_move() lacks FOR SHARE, the reactivation re-check, or the normalized key';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'booking_slot_resolve';
  IF v_src IS NULL OR v_src NOT ILIKE '%FOR SHARE%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_resolve() does not lock the venue row FOR SHARE';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_reschedule';
  IF v_src IS NULL OR v_src NOT ILIKE '%date_blackout%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: accept_reschedule() does not map the 0075 refusals';
  END IF;
  -- Parser sanity.
  IF slot_minutes('11:00 AM') <> 660 OR slot_minutes('3:00 PM') <> 900 OR slot_minutes('15:00') <> 900
     OR slot_minutes('11:00') <> 660 OR slot_minutes('12:00 AM') <> 0 OR slot_minutes('12:00 PM') <> 720
     OR slot_minutes('25:00') IS NOT NULL OR slot_minutes('11:00 AM sharp') IS NOT NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: slot_minutes() parser';
  END IF;
  IF slot_label(660) <> '11:00 AM' OR slot_label(900) <> '3:00 PM' OR slot_label(0) <> '12:00 AM' OR slot_label(750) <> '12:30 PM' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: slot_label()';
  END IF;
  SELECT count(*) INTO v_n FROM venue_slots_config(NULL);
  IF v_n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: default slots'; END IF;
  SELECT count(*) INTO v_n FROM venue_slots_config('{"slots":[]}'::jsonb);
  IF v_n <> 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: explicit empty slots'; END IF;
  -- Every existing venue configuration must pass the validator, or this migration must not land.
  PERFORM venue_availability_validate(v.availability) FROM venues v;
  PERFORM * FROM venue_slots_config('{"slots":[{"start":"11:00","hours":3},{"start":"13:00","hours":3}]}'::jsonb);
  RAISE EXCEPTION 'POST-CONDITION FAILED: overlapping slots were accepted';
EXCEPTION WHEN check_violation THEN
  IF SQLERRM NOT LIKE 'slot_config_invalid: slot % overlaps%' THEN RAISE; END IF;
END $$;

COMMIT;
