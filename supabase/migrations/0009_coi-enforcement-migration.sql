-- ============================================================================
-- Phase 1 migration for COI Enforcement & Auto-Cancellation.
-- Run ONCE in the Supabase SQL editor. Additive + idempotent (IF NOT EXISTS),
-- safe on existing rows, does not touch data. Nothing enforces anything until
-- you ALSO set the env vars (see the build log) — this just adds the columns.
-- ============================================================================

-- 1) Retailer timezone — drives the 72-hour cutoff (cutoff = demo_date 00:00 local, minus 72h).
--    Default Pacific; Gus is in San Francisco.
ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Los_Angeles';

UPDATE retailers SET timezone = 'America/Los_Angeles' WHERE slug = 'gus';

-- 2) Booking cancellation + COI enforcement markers.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS cancelled_at           timestamptz,   -- when auto-cancelled
  ADD COLUMN IF NOT EXISTS cancel_reason          text,          -- 'coi_missing' for this feature
  ADD COLUMN IF NOT EXISTS coi_reminder_sent_at   timestamptz,   -- 7-day long-lead reminder marker
  ADD COLUMN IF NOT EXISTS coi_final_warn_sent_at timestamptz,   -- final-warning (cutoff-24h) marker
  ADD COLUMN IF NOT EXISTS coi_waived_at          timestamptz,   -- retailer waived the COI for this demo
  ADD COLUMN IF NOT EXISTS coi_waived_by          text;          -- who waived it

-- Verify (optional): should list the new columns.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'bookings'
--    AND column_name IN ('cancelled_at','cancel_reason','coi_reminder_sent_at','coi_final_warn_sent_at','coi_waived_at','coi_waived_by');
