-- DH-17: durable Stripe webhook idempotency. Stripe retries and can reorder events; without a
-- record of what we've already handled, a retry can double-send emails or repeat DB work.
-- This table lets the webhook reject a replay with a single PRIMARY-KEY conflict (HTTP 409).
-- Run ONCE in the Supabase SQL editor. Additive + idempotent.
--
-- ORDERING NOTE: the new stripe-webhook.js is already deployed and resilient — until this table
-- exists, the dedup insert simply fails soft and the event processes exactly as it does today.
-- Nothing about live payments changes when you run this; it only starts catching replays.

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  event_id     text PRIMARY KEY,
  event_type   text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Keep it tenant-invisible: it's an internal ledger, not user data. RLS on, no anon policy.
ALTER TABLE processed_stripe_events ENABLE ROW LEVEL SECURITY;

-- Verify (optional):
-- SELECT count(*) FROM processed_stripe_events;
