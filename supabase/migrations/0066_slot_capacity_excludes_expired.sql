-- 0066_slot_capacity_excludes_expired.sql — provisional-holds slot-contention correctness.
--
-- 0047's capacity count excludes only ('cancelled','declined'). The provisional-holds feature
-- (0063/0065) added the 'expired' status for a released 24h hold, and 0047 was never updated — so
-- a released/expired hold KEPT occupying its slot. Two consequences:
--   1. Stranded slots: a hold that lapses via the 24h sweep (status -> 'expired') blocked the slot
--      forever; nobody could rebook it.
--   2. Broken insured-priority bump: api/book.js releases a 'held' victim to 'expired' and retries
--      the insert — but 'expired' still counted, so the retry hit slot_full again and the verified
--      brand could never take a provisionally-held slot. The documented "verified/confirmed >
--      provisional" priority was non-functional.
--
-- Fix: add 'expired' (and, defensively, 'auth_canceled' — not a bookings.status value today, but
-- harmless and future-proof) to the excluded set in BOTH capacity triggers.
--
-- 'held' is deliberately STILL counted: the bump in book.js relies on a held booking tripping
-- slot_full so the release-and-retry runs. Treating 'held' as fully soft would let a verified
-- booking and a held booking coexist on a cap-1 slot and oversell the calendar if the hold later
-- captures. Keeping held counted + releasing the victim to 'expired' is the coherent design.
BEGIN;

CREATE OR REPLACE FUNCTION enforce_slot_capacity() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint;
BEGIN
  IF NEW.venue_id IS NULL THEN RAISE EXCEPTION 'booking requires a valid venue'; END IF;

  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id
     AND demo_date = NEW.demo_date
     AND demo_time = NEW.demo_time
     AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_slot_capacity_on_move() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint;
BEGIN
  IF NEW.venue_id IS NOT DISTINCT FROM OLD.venue_id
     AND NEW.demo_date IS NOT DISTINCT FROM OLD.demo_date
     AND NEW.demo_time IS NOT DISTINCT FROM OLD.demo_time THEN
    RETURN NEW;
  END IF;
  IF coalesce(NEW.status,'pending') IN ('cancelled','declined','expired','auth_canceled') THEN RETURN NEW; END IF;

  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  SELECT count(*) INTO taken FROM bookings
   WHERE venue_id = NEW.venue_id AND demo_date = NEW.demo_date AND demo_time = NEW.demo_time
     AND id <> NEW.id
     AND coalesce(status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  IF taken >= cap THEN
    RAISE EXCEPTION 'slot_full: % already booked for % % (cap %)', taken, NEW.demo_date, NEW.demo_time, cap
      USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

COMMIT;
