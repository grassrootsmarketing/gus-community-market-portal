-- R2-01: upgrade the webhook dedup table into a durable event inbox with explicit state, so a
-- Stripe event whose handler FAILS is retryable rather than permanently discarded. Run ONCE in
-- the Supabase SQL editor. Additive + idempotent. Requires the earlier
-- dh17-webhook-event-dedup-migration.sql to have been run first (it created the table).
--
-- The deployed webhook is resilient: until this runs, the new columns are absent and the handler
-- degrades to processing every event (never dropping one). After this runs, events are claimed as
-- 'processing', marked 'completed' only after the handler succeeds, and released to 'failed' on
-- error so Stripe's retry can reclaim and finish them.

ALTER TABLE processed_stripe_events
  ADD COLUMN IF NOT EXISTS status     text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS last_error text;

-- Any rows that already exist were inserted by the previous (insert-then-process) logic; default
-- them to 'completed' so they continue to be treated as done.

-- Verify (optional):
-- SELECT status, count(*) FROM processed_stripe_events GROUP BY status;
