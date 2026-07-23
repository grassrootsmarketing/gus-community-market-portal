-- Level 3 enterprise support access: retailer-controlled toggle with 24h auto-expire.
-- Run this ONCE in Supabase SQL editor.

ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS allow_support_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS support_access_expires_at TIMESTAMPTZ;

-- Optional: seed the current retailer (Gus's) to ON so David can immediately test.
-- Comment out if you want to test the "OFF by default" behavior first.
UPDATE retailers
   SET allow_support_access = TRUE,
       support_access_expires_at = NOW() + INTERVAL '24 hours'
 WHERE slug = 'gus';
