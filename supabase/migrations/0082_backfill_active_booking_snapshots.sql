-- 0082_backfill_active_booking_snapshots.sql
-- Found by the Release B upgrade rehearsal (Codex round 4, R4-04 (7); CI run 34689957112): on a
-- database upgraded from production's ledger (0072) with real rows present, 0074's snapshot backfill
-- stamps start_at / end_at / timezone only for bookings in status 'pending' or 'confirmed', and 0075
-- copies duration_hours only from an existing calendar demo. A booking that is 'held' (authorization
-- placed, not captured) or 'pending_payment' (paid, awaiting the outbox promotion) at cutover therefore
-- keeps NULL start_at / end_at / timezone / duration_hours:
--   * snapshot_drift() cannot see it (it audits rows with start_at IS NOT NULL only);
--   * when the row later transitions (promote_paid / confirm), trg_booking_slot_snapshot stamps the
--     start from the retailer zone but, with duration_hours still NULL and no demo yet, falls back to
--     3 hours — and booking_transition then projects a 3-hour demo for what may be a 1-hour slot.
-- New rows are stamped on INSERT by the 0075/0076 triggers; only pre-existing rows are affected.
--
-- Fix (forward-only, additive, idempotent): for every ACTIVE booking with a demo_date whose snapshot or
-- duration is missing, resolve the duration from its venue's slot configuration on its own date
-- (venue_slot_offered — the same rule booking_slot_resolve applies on write), fall back to a linked
-- demo's duration, and stamp timezone / start_at / end_at exactly as the trigger would. Rows whose slot
-- cannot be resolved (misconfigured venue, unparseable time) get the snapshot with the same defaults
-- the trigger uses (11:00 / 3 h) and are counted in the NOTICE — nothing is invented silently and
-- nothing is raised on data this migration cannot validate; the audits report those rows afterwards.
-- 0074 / 0075 / 0076 untouched.

DO $$
DECLARE
  r record; v_av jsonb; v_min integer; v_hours integer; v_ok boolean; v_tz text; v_dur integer;
  v_done integer := 0; v_from_slot integer := 0; v_from_demo integer := 0; v_defaulted integer := 0;
BEGIN
  FOR r IN
    SELECT b.id, b.retailer_id, b.venue_id, b.demo_date, b.demo_time, b.duration_hours, b.start_at, b.status
      FROM bookings b
     WHERE b.demo_date IS NOT NULL
       AND coalesce(b.status, 'pending') IN ('pending', 'confirmed', 'held', 'pending_payment')
       AND (b.start_at IS NULL OR b.end_at IS NULL OR b.timezone IS NULL OR b.duration_hours IS NULL)
     ORDER BY b.demo_date, b.id
  LOOP
    v_dur := r.duration_hours;
    IF v_dur IS NULL THEN
      -- 1. the venue's offering on that date (what booking_slot_resolve would decide)
      v_hours := NULL;
      IF r.venue_id IS NOT NULL THEN
        SELECT v.availability INTO v_av FROM venues v WHERE v.id = r.venue_id AND v.retailer_id = r.retailer_id;
        v_min := slot_minutes(r.demo_time);
        IF FOUND AND v_min IS NOT NULL THEN
          BEGIN
            SELECT o.ok, o.hours INTO v_ok, v_hours FROM venue_slot_offered(v_av, r.demo_date, v_min) o;
            IF NOT coalesce(v_ok, false) THEN v_hours := NULL; END IF;
          EXCEPTION WHEN OTHERS THEN v_hours := NULL;   -- misconfigured availability: not resolvable here
          END;
        END IF;
      END IF;
      IF v_hours IS NOT NULL THEN
        v_dur := v_hours; v_from_slot := v_from_slot + 1;
      ELSE
        -- 2. a linked calendar demo (0075's own source)
        SELECT d.duration_hours INTO v_dur FROM demos d WHERE d.booking_id = r.id AND d.duration_hours BETWEEN 1 AND 12 LIMIT 1;
        IF v_dur IS NOT NULL THEN v_from_demo := v_from_demo + 1; ELSE v_defaulted := v_defaulted + 1; END IF;
      END IF;
    END IF;

    SELECT rt.timezone INTO v_tz FROM retailers rt WHERE rt.id = r.retailer_id;
    v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
    -- One UPDATE; trg_booking_slot_snapshot (UPDATE OF duration_hours) recomputes the same values from
    -- the same inputs, so the stored snapshot is exactly what the trigger would have produced.
    UPDATE bookings
       SET duration_hours = v_dur,
           timezone = v_tz,
           start_at = booking_slot_start(r.demo_date, r.demo_time, v_tz, 11),
           end_at   = booking_slot_start(r.demo_date, r.demo_time, v_tz, 11) + make_interval(hours => coalesce(v_dur, 3))
     WHERE id = r.id;
    v_done := v_done + 1;
  END LOOP;
  RAISE NOTICE '0082 backfill: % active booking(s) stamped; duration from slot config %, from linked demo %, left NULL (trigger default 3 h applies) %',
    v_done, v_from_slot, v_from_demo, v_defaulted;
END $$;

-- Post-condition: no active booking with a parseable schedule is left without its snapshot.
DO $$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n
    FROM bookings b JOIN retailers r ON r.id = b.retailer_id
   WHERE b.demo_date IS NOT NULL
     AND coalesce(b.status, 'pending') IN ('pending', 'confirmed', 'held', 'pending_payment')
     AND booking_slot_start(b.demo_date, b.demo_time, coalesce(nullif(btrim(r.timezone), ''), 'America/Los_Angeles'), 11) IS NOT NULL
     AND (b.start_at IS NULL OR b.end_at IS NULL OR b.timezone IS NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0082 POST-CONDITION FAILED: % active booking(s) still lack start_at/end_at/timezone', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM bookings b
   WHERE b.start_at IS NOT NULL
     AND coalesce(b.status, 'pending') IN ('pending', 'confirmed', 'held', 'pending_payment')
     AND b.end_at IS DISTINCT FROM b.start_at + make_interval(hours => coalesce(b.duration_hours, 3));
  IF v_n <> 0 THEN
    RAISE EXCEPTION '0082 POST-CONDITION FAILED: % active booking(s) have end_at inconsistent with duration', v_n;
  END IF;
END $$;
