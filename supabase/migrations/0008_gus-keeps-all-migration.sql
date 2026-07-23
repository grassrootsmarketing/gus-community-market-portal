-- Gus's special deal: Demohub keeps 100% of demo fees, Gus gets $0, no bank connection needed.
-- Brand pays $30/demo, all $30 routes to the Demohub platform account.
-- Run this ONCE in Supabase SQL editor.

-- 1. Add the flag column
ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS platform_keeps_all BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Turn it on for Gus's
UPDATE retailers
   SET platform_keeps_all = TRUE
 WHERE slug = 'gus';

-- 3. Set the demo fee to $30 (what the brand pays; all goes to Demohub)
--    Sets the retailer-level default fee...
UPDATE settings
   SET demo_fee = 30
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'gus');

--    ...and each of Gus's venues (so per-location price is $30 too)
UPDATE venues
   SET demo_fee = 30
 WHERE retailer_id = (SELECT id FROM retailers WHERE slug = 'gus');
