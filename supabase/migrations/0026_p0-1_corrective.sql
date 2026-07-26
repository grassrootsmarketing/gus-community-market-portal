-- 0026_p0-1_corrective.sql  (Codex re-verify #5 corrective; run AFTER 0025 on staging)
-- Fixes: normalization trigger desync, owner-role lifecycle, closed role domain, Model-2 scope.
-- The UNIQUE(retailer_id, email_normalized) index from 0025 already prevents new duplicate
-- memberships, so no further duplicate-collapse runs here (stop-and-review policy: any future
-- conflict is rejected by the unique index rather than silently resolved).
BEGIN;

-- 1) Trigger desync fix: re-derive email_normalized on EVERY update (not just UPDATE OF email),
--    and on insert. A direct write to email_normalized can no longer diverge from email.
CREATE OR REPLACE FUNCTION retailer_admins_normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email_normalized := lower(btrim(NEW.email));
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS retailer_admins_normalize ON retailer_admins;
CREATE TRIGGER retailer_admins_normalize
  BEFORE INSERT OR UPDATE ON retailer_admins
  FOR EACH ROW EXECUTE FUNCTION retailer_admins_normalize_email();

-- 2) Owner lifecycle: a retailer's billing_email membership must be a MUTATING role. If 0025 left
--    an owner sitting on a viewer/editor row, upgrade that specific row to admin (they own the store).
UPDATE retailer_admins ra
SET role = 'admin'
FROM retailers r
WHERE ra.retailer_id = r.id
  AND r.billing_email IS NOT NULL AND btrim(r.billing_email) <> ''
  AND ra.email_normalized = lower(btrim(r.billing_email))
  AND lower(ra.role) IN ('viewer', 'editor');

-- 3) Closed role domain — reject any unknown role string going forward.
--    (editor is retained in the domain for now; it is NON-mutating in code and slated for retirement.)
DO $$ BEGIN
  ALTER TABLE retailer_admins
    ADD CONSTRAINT retailer_admins_role_domain
    CHECK (lower(role) IN ('owner','admin','manager','viewer','editor'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4) Model 2: only viewers may be venue-scoped; mutating roles must have NO scope.
--    Data-normalize first, then enforce with a constraint (best-effort: skipped if the column
--    type is not an array, so this migration never aborts on a schema surprise).
DO $$
BEGIN
  BEGIN
    UPDATE retailer_admins SET venue_ids = NULL
      WHERE lower(role) <> 'viewer' AND venue_ids IS NOT NULL AND array_length(venue_ids, 1) IS NOT NULL;
    BEGIN
      ALTER TABLE retailer_admins
        ADD CONSTRAINT retailer_admins_scope_viewer_only
        CHECK (lower(role) = 'viewer' OR venue_ids IS NULL OR array_length(venue_ids, 1) IS NULL);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'Model-2 venue-scope constraint skipped (venue_ids not a plain array?): %', SQLERRM;
  END;
END $$;

COMMIT;

-- Verification (all expect 0 rows):
--   -- owners on a non-mutating role:
--   SELECT r.slug FROM retailers r JOIN retailer_admins ra
--     ON ra.retailer_id=r.id AND ra.email_normalized=lower(btrim(r.billing_email))
--     WHERE lower(ra.role) NOT IN ('owner','admin','manager');
--   -- mutating roles carrying a venue scope:
--   SELECT id, role FROM retailer_admins
--     WHERE lower(role) <> 'viewer' AND venue_ids IS NOT NULL AND array_length(venue_ids,1) IS NOT NULL;
--   -- unknown roles:
--   SELECT DISTINCT role FROM retailer_admins WHERE lower(role) NOT IN ('owner','admin','manager','viewer','editor');
