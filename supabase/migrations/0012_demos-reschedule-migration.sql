-- Reschedule proposals: a retailer proposes a new date for a confirmed demo, the brand
-- accepts or declines. No money moves (unlike cancel). Run ONCE in the Supabase SQL editor.
-- Additive + idempotent. The code degrades gracefully if this hasn't run (the reschedule
-- button simply reports it's not set up yet), so nothing else breaks.

ALTER TABLE demos
  ADD COLUMN IF NOT EXISTS reschedule_to_date       date,        -- proposed new date
  ADD COLUMN IF NOT EXISTS reschedule_to_time       text,        -- proposed new time
  ADD COLUMN IF NOT EXISTS reschedule_requested_at  timestamptz; -- when the retailer proposed it

-- Verify (optional):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'demos'
--    AND column_name IN ('reschedule_to_date','reschedule_to_time','reschedule_requested_at');
