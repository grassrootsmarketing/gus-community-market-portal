-- 0027_p0-1_role_canonical.sql  (Codex reverify #6 defects A & B; run AFTER 0025+0026 on staging)
-- Make role canonical + NOT NULL, retire `editor`, and make the Model-2 scope constraint
-- FAIL-CLOSED (no catch-all). Transactional: aborts if any invariant can't be installed.
BEGIN;

-- Normalize role casing/whitespace; resolve unknowns to least privilege; retire editor -> viewer
UPDATE retailer_admins SET role = lower(btrim(role)) WHERE role IS NOT NULL;
UPDATE retailer_admins SET role = 'viewer' WHERE role = 'editor';                         -- editor is non-mutating -> viewer
UPDATE retailer_admins SET role = 'viewer' WHERE role IS NULL OR btrim(role) = ''          -- least privilege
   OR role NOT IN ('owner','admin','manager','viewer');
-- Model 2 data-normalize: mutating roles carry no venue scope
UPDATE retailer_admins SET venue_ids = NULL
  WHERE role <> 'viewer' AND venue_ids IS NOT NULL AND array_length(venue_ids, 1) IS NOT NULL;

-- role NOT NULL + canonical closed set (no editor)
ALTER TABLE retailer_admins ALTER COLUMN role SET NOT NULL;
ALTER TABLE retailer_admins DROP CONSTRAINT IF EXISTS retailer_admins_role_domain;
ALTER TABLE retailer_admins ADD  CONSTRAINT retailer_admins_role_domain
  CHECK (role IN ('owner','admin','manager','viewer'));

-- Model-2 scope constraint, FAIL-CLOSED (no exception guard): only viewers may be venue-scoped.
ALTER TABLE retailer_admins DROP CONSTRAINT IF EXISTS retailer_admins_scope_viewer_only;
ALTER TABLE retailer_admins ADD  CONSTRAINT retailer_admins_scope_viewer_only
  CHECK (role = 'viewer' OR venue_ids IS NULL OR array_length(venue_ids, 1) IS NULL);

-- Normalize BOTH email and role on every write (invite/role-change paths cannot diverge)
CREATE OR REPLACE FUNCTION retailer_admins_normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email_normalized := lower(btrim(NEW.email));
  IF NEW.role IS NOT NULL THEN NEW.role := lower(btrim(NEW.role)); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Assert the constraints are present + validated (fail the migration if not)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='retailer_admins_role_domain' AND convalidated) THEN
    RAISE EXCEPTION 'role_domain constraint missing/not validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='retailer_admins_scope_viewer_only' AND convalidated) THEN
    RAISE EXCEPTION 'Model-2 scope constraint missing/not validated';
  END IF;
END $$;

COMMIT;
