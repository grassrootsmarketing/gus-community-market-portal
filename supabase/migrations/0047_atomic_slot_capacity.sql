-- 0047_atomic_slot_capacity.sql — WO-7 / Codex P1-2: make slot capacity race-free.
--
-- The existing enforce_slot_capacity() trigger does COUNT-then-INSERT with no lock. Two brands
-- submitting the same slot at the same moment both read `taken < cap` and both succeed, so a
-- 1-capacity slot ends up double-booked and a retailer is committed to two demos at once.
--
-- Fix: take a transaction-scoped ADVISORY LOCK keyed on (venue, date, time) before counting.
-- Concurrent inserts for the SAME slot serialise; different slots never block each other. The lock
-- releases automatically at commit/rollback, so there is nothing to clean up.
--
-- Also tightens the count: a booking that is 'pending_payment' still holds the slot (otherwise an
-- abandoned checkout would let the slot be oversold), while cancelled/declined free it.
BEGIN;

CREATE OR REPLACE FUNCTION enforce_slot_capacity() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint;
BEGIN
  IF NEW.venue_id IS NULL THEN RAISE EXCEPTION 'booking requires a valid venue'; END IF;

  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  -- serialise concurrent inserts for THIS slot only (released at end of transaction)
  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id
     AND demo_date = NEW.demo_date
     AND demo_time = NEW.demo_time
     AND coalesce(status,'pending') NOT IN ('cancelled','declined');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_slot_capacity ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity();

-- Re-check on UPDATE too: moving a booking into an occupied slot (reschedule) must obey the same cap.
CREATE OR REPLACE FUNCTION enforce_slot_capacity_on_move() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint;
BEGIN
  IF NEW.venue_id IS NOT DISTINCT FROM OLD.venue_id
     AND NEW.demo_date IS NOT DISTINCT FROM OLD.demo_date
     AND NEW.demo_time IS NOT DISTINCT FROM OLD.demo_time THEN
    RETURN NEW;                      -- slot unchanged
  END IF;
  IF coalesce(NEW.status,'pending') IN ('cancelled','declined') THEN RETURN NEW; END IF;

  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id AND demo_date = NEW.demo_date AND demo_time = NEW.demo_time
     AND id <> NEW.id
     AND coalesce(status,'pending') NOT IN ('cancelled','declined');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_slot_capacity_move ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity_move BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity_on_move();

COMMIT;
