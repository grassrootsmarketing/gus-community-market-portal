-- 0070_capacity_serialization.sql — Codex F-01: capacity decreases were not serialized against
-- booking inserts.
--
-- THE BUG. 0047/0066's booking triggers read venues.max_demos_per_slot into a local BEFORE taking
-- the per-slot advisory lock. An insert that then waits on the slot lock carries a STALE cap into
-- its count-and-compare. 0069's decrease guard only takes slot locks for slots that already have
-- active bookings, so a decrease on an EMPTY slot takes no slot lock at all and never meets the
-- waiting inserts. The interleaving (cap 2, empty slot):
--   conn0  holds the slot advisory lock (any earlier insert on that slot, still in flight)
--   ins1   reads cap=2, blocks on the slot lock
--   ins2   reads cap=2, blocks on the slot lock
--   admin  UPDATE venues SET max_demos_per_slot = 1  -> 0069 sees no bookings on that slot, COMMITS
--   conn0  commits, releasing the lock
--   ins1   count 0 < stale cap 2  -> commits
--   ins2   count 1 < stale cap 2  -> commits
--   result cap 1 with 2 active reservations. Capture-without-capacity, the exact state 0069 exists to
--   prevent, reached through a window 0069 never closes.
--
-- THE FIX. Both booking triggers now read the cap with `SELECT ... FOR SHARE` on the venue row, and
-- do so FIRST — before the per-slot advisory lock — and use the value read under that lock:
--   * A decrease is an UPDATE of venues, which takes the row's exclusive tuple lock (FOR NO KEY
--     UPDATE). FOR SHARE conflicts with it. So while ANY insert on that venue is in flight (holding
--     FOR SHARE for the rest of its transaction), the decrease blocks until the insert commits or
--     aborts; when it then runs, guard_capacity_decrease() (0069) re-counts under a fresh snapshot
--     and sees the committed insert. Conversely an insert that arrives while a decrease is in flight
--     blocks on FOR SHARE until the decrease commits, and READ COMMITTED then returns the UPDATED
--     row version — the insert reads the NEW cap. Either way exactly one of {stale insert, unsafe
--     decrease} can no longer happen. This is also what closes the empty-slot case that 0069's
--     slot-lock loop cannot see: the serialization point is the venue row, not the slot.
--   * Lock ORDER is venue row -> slot advisory lock in every path (insert, move, and the decrease
--     guard, which already holds the row lock when its trigger fires), so the paths cannot deadlock.
--   * FOR SHARE (not FOR KEY SHARE): FOR KEY SHARE does NOT conflict with the FOR NO KEY UPDATE an
--     ordinary column UPDATE takes, so it would not serialize anything. FOR SHARE requires UPDATE
--     privilege on venues; every bookings write goes through the service role (0051 revoked anon),
--     which has it.
--
-- REACTIVATION. enforce_slot_capacity_on_move() previously returned early whenever the slot key
-- (venue, date, time) was unchanged — so flipping a 'cancelled'/'expired' booking back to an active
-- status on a now-full slot was never checked. It now also re-checks when status moves from an
-- excluded state into an active one, counting the OTHER active bookings on the slot (id <> NEW.id).
-- The trigger is re-created with an explicit column list that includes status.
--
-- CHECK CONSTRAINT. max_demos_per_slot >= 1. A cap of 0 is not a capacity, it is a closed venue, and
-- the guard's `count > new cap` comparison would otherwise let a 0 through on an empty venue. Added
-- NOT VALID then VALIDATEd (idempotent: the ADD is guarded by a catalog check, VALIDATE is a no-op
-- on an already-valid constraint); a defensive UPDATE first repairs any legacy row so the VALIDATE
-- cannot fail on staging or prod. (The repair UPDATE is an increase or no-op from the guard's point
-- of view, so trg_guard_capacity_decrease passes it.)
--
-- guard_capacity_decrease() and capacity_invariant_violations() (0069) are unchanged. The predicate
-- and lock-key expression below are copied verbatim from 0066/0069 — if either ever changes, change
-- all three capacity checks together.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- INSERT path
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_slot_capacity() RETURNS trigger AS $$
DECLARE cap int; taken int; v_key bigint;
BEGIN
  IF NEW.venue_id IS NULL THEN RAISE EXCEPTION 'booking requires a valid venue'; END IF;

  -- 1. Venue row lock FIRST. Serializes against any UPDATE of the venue (a cap decrease in
  --    particular) for the rest of this transaction, and the cap used below is the one read under
  --    that lock — never a value read before we waited on anything.
  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id
   FOR SHARE;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  -- 2. Per-slot advisory lock (same key as 0047/0066/0069). Serializes concurrent inserts for
  --    THIS slot only; released at end of transaction.
  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  -- 3. Count under both locks with the canonical active predicate.
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

DROP TRIGGER IF EXISTS trg_enforce_slot_capacity ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity();

-- ---------------------------------------------------------------------------------------------
-- UPDATE path: reschedule (slot key changes) OR reactivation (excluded status -> active status)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_slot_capacity_on_move() RETURNS trigger AS $$
DECLARE
  cap int; taken int; v_key bigint;
  slot_changed boolean;
  reactivated  boolean;
BEGIN
  slot_changed := NEW.venue_id   IS DISTINCT FROM OLD.venue_id
               OR NEW.demo_date  IS DISTINCT FROM OLD.demo_date
               OR NEW.demo_time  IS DISTINCT FROM OLD.demo_time;
  reactivated  :=     coalesce(OLD.status,'pending')     IN ('cancelled','declined','expired','auth_canceled')
               AND coalesce(NEW.status,'pending') NOT IN ('cancelled','declined','expired','auth_canceled');

  -- Nothing that could consume capacity changed: active -> active status flips, payment fields, etc.
  IF NOT slot_changed AND NOT reactivated THEN RETURN NEW; END IF;
  -- Leaving (or staying in) an excluded state never needs capacity, wherever the row is moved.
  IF coalesce(NEW.status,'pending') IN ('cancelled','declined','expired','auth_canceled') THEN RETURN NEW; END IF;

  -- 1. Venue row lock FIRST (see enforce_slot_capacity). A NULL venue_id finds no row and fails
  --    the ownership check below, exactly as in 0047/0066.
  SELECT max_demos_per_slot INTO cap FROM venues
   WHERE id = NEW.venue_id AND retailer_id = NEW.retailer_id
   FOR SHARE;
  IF cap IS NULL THEN RAISE EXCEPTION 'venue does not belong to this retailer'; END IF;

  -- 2. Per-slot advisory lock on the DESTINATION slot (same key as 0047/0066/0069).
  v_key := hashtextextended(NEW.venue_id::text || '|' || coalesce(NEW.demo_date::text,'') || '|' || coalesce(NEW.demo_time,''), 0);
  PERFORM pg_advisory_xact_lock(v_key);

  -- 3. Count the OTHER active bookings on the destination slot. Excluding NEW.id is what makes a
  --    same-slot reactivation count correctly (the row itself is not yet active in any snapshot,
  --    but excluding it is the invariant either way).
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

-- 0047 declared this BEFORE UPDATE (all columns). Re-declare with the explicit set of columns that
-- can consume capacity — the three slot-key columns plus status, so a reactivation fires it.
DROP TRIGGER IF EXISTS trg_enforce_slot_capacity_move ON bookings;
CREATE TRIGGER trg_enforce_slot_capacity_move
  BEFORE UPDATE OF venue_id, demo_date, demo_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_capacity_on_move();

-- ---------------------------------------------------------------------------------------------
-- guard_capacity_decrease() (0069) is correct as written and is NOT replaced. Record on the
-- function itself why the empty-slot race it cannot see is nevertheless closed.
-- ---------------------------------------------------------------------------------------------
COMMENT ON FUNCTION guard_capacity_decrease() IS
  'BEFORE UPDATE OF max_demos_per_slot: refuses a decrease below the active count of any future slot (0069). '
  'It only takes slot advisory locks for slots that already have bookings; the empty-slot race against a '
  'waiting insert is closed by 0070, where enforce_slot_capacity()/enforce_slot_capacity_on_move() take '
  'SELECT ... FOR SHARE on the venue row BEFORE the slot lock. The decrease UPDATE needs that row''s exclusive '
  'lock, so it waits for every in-flight insert on the venue (and then re-counts them here), and an insert '
  'arriving later waits for the decrease to commit and then reads the NEW cap.';

-- ---------------------------------------------------------------------------------------------
-- max_demos_per_slot >= 1. Repair first so VALIDATE cannot fail; column remains NOT NULL (0000).
-- ---------------------------------------------------------------------------------------------
UPDATE venues SET max_demos_per_slot = 1
 WHERE max_demos_per_slot IS NULL OR max_demos_per_slot < 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'venues_max_demos_per_slot_min' AND conrelid = 'public.venues'::regclass
  ) THEN
    ALTER TABLE venues ADD CONSTRAINT venues_max_demos_per_slot_min
      CHECK (max_demos_per_slot >= 1) NOT VALID;
  END IF;
END $$;

ALTER TABLE venues VALIDATE CONSTRAINT venues_max_demos_per_slot_min;

COMMIT;

-- ---------------------------------------------------------------------------------------------
-- Post-condition: the catalogs must show the intended end state, or this migration has failed.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE v_src text; v_cols text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_slot_capacity';
  IF v_src IS NULL OR v_src NOT ILIKE '%FOR SHARE%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: enforce_slot_capacity() does not lock the venue row FOR SHARE';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_slot_capacity_on_move';
  IF v_src IS NULL OR v_src NOT ILIKE '%FOR SHARE%' OR v_src NOT ILIKE '%reactivated%' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: enforce_slot_capacity_on_move() lacks FOR SHARE or the reactivation re-check';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_slot_capacity' AND tgrelid = 'public.bookings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_enforce_slot_capacity is not installed on bookings';
  END IF;

  -- The move trigger must fire on status (attnum listed in tgattr).
  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO v_cols
    FROM pg_trigger t
    JOIN unnest(t.tgattr::int2[]) AS u(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = u.attnum
   WHERE t.tgname = 'trg_enforce_slot_capacity_move' AND t.tgrelid = 'public.bookings'::regclass AND NOT t.tgisinternal;
  IF v_cols IS DISTINCT FROM 'demo_date,demo_time,status,venue_id' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_enforce_slot_capacity_move fires on (%) not (demo_date,demo_time,status,venue_id)', coalesce(v_cols, '<missing>');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'venues_max_demos_per_slot_min' AND conrelid = 'public.venues'::regclass AND convalidated
  ) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: venues_max_demos_per_slot_min is missing or not validated';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_capacity_decrease' AND tgrelid = 'public.venues'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_guard_capacity_decrease (0069) is not installed on venues';
  END IF;
END $$;
