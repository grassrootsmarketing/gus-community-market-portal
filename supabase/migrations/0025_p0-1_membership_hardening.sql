-- 0025_p0-1_membership_hardening.sql
-- Codex P0-1 (reopen): make retailer_admins the single canonical authorization source for
-- retailer mutations, with EXACT normalized-email identity and no "owner may have no row" gap.
--   P0-1A  every retailer's owner gets a live membership row (no lockout of the real owner)
--   P0-1B  normalized email + UNIQUE (retailer_id, email_normalized); auth compares with = not ILIKE
-- Idempotent + transactional. Safe to re-run.
BEGIN;

-- 1) normalized-email column (lower + trim), backfilled
ALTER TABLE retailer_admins ADD COLUMN IF NOT EXISTS email_normalized text;
UPDATE retailer_admins SET email_normalized = lower(btrim(email))
  WHERE email_normalized IS DISTINCT FROM lower(btrim(email));

-- 2) collapse duplicate (retailer_id, email_normalized) rows, keeping the highest-privilege one
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY retailer_id, email_normalized
           ORDER BY CASE lower(role)
                      WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                      WHEN 'manager' THEN 2 WHEN 'editor' THEN 3 ELSE 4 END, id
         ) AS rn
  FROM retailer_admins
)
DELETE FROM retailer_admins ra USING ranked r WHERE ra.id = r.id AND r.rn > 1;

ALTER TABLE retailer_admins ALTER COLUMN email_normalized SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS retailer_admins_retailer_email_uidx
  ON retailer_admins (retailer_id, email_normalized);

-- 3) keep it normalized on every future write (invite / role-update paths cannot disagree)
CREATE OR REPLACE FUNCTION retailer_admins_normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email_normalized := lower(btrim(NEW.email));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS retailer_admins_normalize ON retailer_admins;
CREATE TRIGGER retailer_admins_normalize
  BEFORE INSERT OR UPDATE OF email ON retailer_admins
  FOR EACH ROW EXECUTE FUNCTION retailer_admins_normalize_email();

-- 4) OWNER BACKFILL — the fix for the lockout risk.
--    Every retailer's billing_email gets a live membership if it has none. We use role 'admin'
--    (an existing booking-capable role) as the canonical owner-membership bridge; a distinct
--    'owner' role + venue-scope model is formalized in the P0-8 authz cutover. Authority now
--    comes ONLY from a retailer_admins row (never an implicit "owner has no row" exception).
INSERT INTO retailer_admins (retailer_id, email, email_normalized, role)
SELECT r.id, lower(btrim(r.billing_email)), lower(btrim(r.billing_email)), 'admin'
FROM retailers r
WHERE r.billing_email IS NOT NULL AND btrim(r.billing_email) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM retailer_admins ra
    WHERE ra.retailer_id = r.id
      AND ra.email_normalized = lower(btrim(r.billing_email))
  );

COMMIT;

-- Verification (expect 0 rows = no retailer whose owner lacks a membership):
--   SELECT r.id, r.slug FROM retailers r
--   WHERE r.billing_email IS NOT NULL AND btrim(r.billing_email) <> ''
--     AND NOT EXISTS (SELECT 1 FROM retailer_admins ra
--                     WHERE ra.retailer_id = r.id
--                       AND ra.email_normalized = lower(btrim(r.billing_email)));
