-- ============================================================================
-- SKUs / sampled items. Run ONCE in the Supabase SQL editor.
-- Additive and idempotent. Safe on existing rows. Touches no existing data.
--
-- The code is written to work WITHOUT this migration (writes degrade and the
-- booking still succeeds), so running it late cannot break payments. It just
-- means SKUs are not persisted until you do.
-- ============================================================================

-- 1) The brand's own catalogue of items they sample.
--    Shape: [{"id":"...","name":"Blood Orange Spritz","size":"12oz","sku":"4412"}]
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS products jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 2) Which items are being sampled at THIS demo.
--    Stored as a snapshot, not a reference: if the brand later renames or
--    deletes an item, past bookings still show what was actually sampled.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS product_skus jsonb;

-- Verify (optional):
-- SELECT column_name, data_type FROM information_schema.columns
--  WHERE (table_name = 'brands'   AND column_name = 'products')
--     OR (table_name = 'bookings' AND column_name = 'product_skus');
