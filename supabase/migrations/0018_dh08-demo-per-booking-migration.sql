-- DH-08: enforce one demo per booking at the database layer, killing the double-confirm race.
-- Two confirmation requests for the same booking (or a Stripe auto-confirm racing a manual one)
-- could each read "no demo yet" and both insert a demo row. This adds a hard DB guarantee.
-- Run ONCE in the Supabase SQL editor. Additive + idempotent.
--
-- ORDERING NOTE: the new booking-action.js is already deployed and is resilient BOTH ways —
--   * before this runs: the demo insert simply drops the booking_id column and behaves as before;
--   * after this runs: a duplicate confirm hits the unique index, and the code reuses the
--     existing demo instead of creating a second one.
-- So there is no window where confirming breaks.

ALTER TABLE demos
  ADD COLUMN IF NOT EXISTS booking_id uuid;

-- One demo per booking. Partial index so historical demos with a NULL booking_id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS demos_one_per_booking
  ON demos (booking_id)
  WHERE booking_id IS NOT NULL;

-- Verify (optional):
-- SELECT indexname FROM pg_indexes WHERE tablename = 'demos' AND indexname = 'demos_one_per_booking';
