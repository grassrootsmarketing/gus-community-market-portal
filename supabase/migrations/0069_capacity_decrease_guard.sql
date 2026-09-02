-- 0069_capacity_decrease_guard.sql — Phase D: prevent invalid capacity transitions.
--
-- THE BUG. venues.max_demos_per_slot could be lowered at any time, regardless of what already sat
-- in the calendar. 0047/0066 make INSERT and reschedule race-free against the cap as it stands at
-- insert time — but nothing re-checks when the cap itself moves. So:
--   cap 2  ->  two valid held bookings on the same future slot  ->  admin lowers cap to 1
--   -> both holds are still "active", both can confirm/capture concurrently, and the retailer is
--      committed to two demos on a slot that now advertises one. Capture-without-capacity.
--
-- THE FIX. A BEFORE UPDATE OF max_demos_per_slot trigger on venues. Only a DECREASE is examined
-- (increase and no-change pass straight through). For every FUTURE slot on that venue that has
-- active bookings it takes the SAME per-slot advisory lock 0047/0066 take before counting, counts
-- with the SAME canonical active predicate, and raises if any slot already holds more than the
-- proposed cap. RAISE aborts the UPDATE, so the venue row is never partially changed.
--
-- WHY THE LOCK MATTERS HERE. Without it, a cap decrease and a booking insert on the same slot could
-- both read a consistent-looking world and both commit (insert saw cap 2; decrease saw count 1).
-- Sharing the slot lock serialises them: whichever runs second sees the other's committed result
-- (plpgsql takes a fresh snapshot per statement under READ COMMITTED), and exactly one of them
-- fails. Slots are visited in (demo_date, demo_time) order so two concurrent decreases on the same
-- venue acquire locks in the same order and cannot deadlock each other.
--
-- Predicate and lock key are copied verbatim from 0066 — drift between the three capacity checks is
-- precisely the class of bug 0066 fixed. If the predicate ever changes, change all three together.
--
-- Also ships capacity_invariant_violations(): a read-only audit that lists every (venue, date, time)
-- whose active count exceeds the venue's CURRENT cap. Zero rows is the invariant; a row is a bug or
-- a pre-0069 legacy state. service_role only, like the other operational functions.
--
-- Past slots (demo_date < current_date) are deliberately NOT guarded: history cannot be oversold and
-- a retailer must be able to shrink a venue without first deleting completed demos. The audit
-- function defaults to the same future-only scope; pass p_future_only := false for a full sweep.
BEGIN;

CREATE OR REPLACE FUNCTION guard_capacity_decrease() RETURNS trigger AS $$
DECLARE
  v_slot record;
  v_taken int;
  v_key bigint;
BEGIN
  -- Increases and no-ops never need a check. (Column is NOT NULL; the NULL guards are defensive.)
  IF NEW.max_demos_per_slot IS NULL OR OLD.max_demos_per_slot IS NULL
     OR NEW.max_demos_per_slot >= OLD.max_demos_per_slot THEN
    RETURN NEW;
  END IF;

  -- Every FUTURE slot on this venue that currently carries at least one active booking, in a
  -- deterministic order so concurrent decreases take their advisory locks in the same sequence.
  FOR v_slot IN
    SELECT demo_date, demo_time
      FROM bookings
     WHERE venue_id = NEW.id
       AND demo_date >= current_date
       AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
     GROUP BY demo_date, demo_time
     ORDER BY demo_date, demo_time
  LOOP
    -- Same key as enforce_slot_capacity()/enforce_slot_capacity_on_move() (0047/0066).
    v_key := hashtextextended(NEW.id::text || '|' || coalesce(v_slot.demo_date::text,'') || '|' || coalesce(v_slot.demo_time,''), 0);
    PERFORM pg_advisory_xact_lock(v_key);

    -- Re-count UNDER the lock: an insert that committed while we waited is now visible.
    SELECT count(*) INTO v_taken FROM bookings
     WHERE venue_id = NEW.id
       AND demo_date = v_slot.demo_date
       AND demo_time = v_slot.demo_time
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

DROP TRIGGER IF EXISTS trg_guard_capacity_decrease ON venues;
CREATE TRIGGER trg_guard_capacity_decrease
  BEFORE UPDATE OF max_demos_per_slot ON venues
  FOR EACH ROW EXECUTE FUNCTION guard_capacity_decrease();

-- ---------------------------------------------------------------------------------------------
-- Read-only invariant audit. One row per over-capacity slot; the healthy answer is no rows.
--   p_venue_id     limit to one venue (NULL = every venue)
--   p_future_only  true (default) = the same scope the guard enforces; false = include history
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION capacity_invariant_violations(p_venue_id uuid DEFAULT NULL, p_future_only boolean DEFAULT true)
RETURNS TABLE(venue_id uuid, retailer_id uuid, demo_date date, demo_time text, active_count bigint, max_demos_per_slot integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT b.venue_id, v.retailer_id, b.demo_date, b.demo_time, count(*) AS active_count, v.max_demos_per_slot
    FROM bookings b
    JOIN venues v ON v.id = b.venue_id
   WHERE (p_venue_id IS NULL OR b.venue_id = p_venue_id)
     AND (NOT p_future_only OR b.demo_date >= current_date)
     AND coalesce(b.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled')
   GROUP BY b.venue_id, v.retailer_id, b.demo_date, b.demo_time, v.max_demos_per_slot
  HAVING count(*) > v.max_demos_per_slot
   ORDER BY b.venue_id, b.demo_date, b.demo_time
$$;

REVOKE ALL ON FUNCTION capacity_invariant_violations(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION capacity_invariant_violations(uuid, boolean) TO service_role;

COMMIT;
