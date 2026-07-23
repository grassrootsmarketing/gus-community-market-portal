-- Private calendar-feed key. The iCal feed URL used to be guessable (keyed on the public
-- slug); this adds a secret key that the feed now requires. Run ONCE in the Supabase SQL
-- editor. Additive; generates a key for every existing retailer.
--
-- IMPORTANT ordering: the new cal.js (which requires the key) is already deployed, so the
-- iCal feed returns 401 until this runs and populates keys. There are no live calendar
-- subscribers yet, so nothing breaks in the meantime.

ALTER TABLE retailers
  ADD COLUMN IF NOT EXISTS cal_feed_key text;

-- Give every existing retailer a random 32-char key (122 bits of entropy — not guessable).
UPDATE retailers
   SET cal_feed_key = replace(gen_random_uuid()::text, '-', '')
 WHERE cal_feed_key IS NULL OR cal_feed_key = '';

-- Verify (optional):
-- SELECT slug, left(cal_feed_key, 6) || '…' AS key_preview FROM retailers ORDER BY slug;
