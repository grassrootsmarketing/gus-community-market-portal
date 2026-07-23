-- Carry the brand's sampled items + contact details onto the confirmed demo, so the
-- retailer still sees them AFTER confirming (today they only appear on the pending booking).
-- Run ONCE in the Supabase SQL editor. Additive + idempotent. Safe on existing rows.
--
-- The code already works WITHOUT this migration (confirmation falls back to core columns
-- and just drops these three), so running it late cannot break a confirmation.

ALTER TABLE demos
  ADD COLUMN IF NOT EXISTS product_skus  jsonb,   -- snapshot of the items being sampled
  ADD COLUMN IF NOT EXISTS contact_email text,    -- so the retailer can reach the brand
  ADD COLUMN IF NOT EXISTS contact_phone text;

-- Verify (optional):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'demos' AND column_name IN ('product_skus','contact_email','contact_phone');
