-- CRITICAL pre-live fix.
-- The Stripe webhook writes payment tracking fields to bookings on payment success,
-- failure, and refund. None of these columns existed, so every payment handler's
-- UPDATE would fail — a paid booking would stay 'pending_payment' forever and no
-- confirmation email would send. This adds the columns (all nullable, safe on existing rows).
-- Run ONCE in Supabase SQL editor.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS payment_status    TEXT,           -- paid | failed | refunded | partial_refund
  ADD COLUMN IF NOT EXISTS payment_intent_id TEXT,           -- Stripe PaymentIntent id (pi_...)
  ADD COLUMN IF NOT EXISTS paid_at           TIMESTAMPTZ,    -- when payment succeeded
  ADD COLUMN IF NOT EXISTS amount_paid       INTEGER,        -- cents actually charged for this booking
  ADD COLUMN IF NOT EXISTS refunded_at       TIMESTAMPTZ;    -- when a refund was processed

-- Helpful index for looking a booking up by its payment intent (used on refund/failure webhooks).
CREATE INDEX IF NOT EXISTS idx_bookings_payment_intent_id ON bookings (payment_intent_id);
