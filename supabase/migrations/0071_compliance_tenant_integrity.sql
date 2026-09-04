-- 0071_compliance_tenant_integrity.sql — Codex F-02: cross-retailer compliance relationship injection.
--
-- THE BUG. compliance_records.brand_contact_id references brand_contacts(id) and nothing else. The
-- FK proves the contact EXISTS; it says nothing about WHOSE contact it is. So an owner/admin/manager
-- of Retailer A could write a compliance record carrying Retailer B's brand_contact_id, and the row
-- would pass every database check while linking A's document to B's relationship. Two consumers
-- then trusted that link without re-checking tenancy:
--   * api/coi-enforcement.js read compliance_records GLOBALLY and matched the joined contact by
--     email only, so a record planted at Retailer A could count as coverage (or as an unreadable
--     "unknown" certificate that suppresses cancellation) for a Retailer B booking;
--   * the daily COI-warning job in api/brand-account.js fetched brand_contacts by id alone.
-- The API layer is fixed alongside this migration (allowlist + same-tenant contact lookup, and a
-- retailer_id filter on both readers). This file makes the invariant a property of the DATA, so no
-- future writer — proxy, seed job, support tooling, a hand-run PATCH — can violate it.
--
-- THE FIX. A composite foreign key (brand_contact_id, retailer_id) -> brand_contacts(id, retailer_id).
-- brand_contacts.id is already the primary key, so the (id, retailer_id) pair is trivially unique;
-- the UNIQUE constraint exists only because a FK target must be a unique key. brand_contact_id stays
-- nullable and the FK uses the default MATCH SIMPLE, so a manual, unlinked record (brand_contact_id
-- NULL) skips the check exactly as it did under the single-column FK. ON DELETE CASCADE matches the
-- behaviour of the single-column FK this replaces (compliance_records_brand_contact_id_fkey, baseline
-- line 478). ON DELETE SET NULL is not an option on a composite key: it would null retailer_id too,
-- which is NOT NULL.
--
-- WHY THE OLD SINGLE-COLUMN FK IS DROPPED. The composite key strictly implies it (a matching
-- (id, retailer_id) pair proves the id exists), so it adds nothing. It does however cost something:
-- PostgREST resolves an embedded select such as `compliance_records?select=...,brand_contacts(email)`
-- through the FK graph, and TWO foreign keys between the same pair of tables make that embed
-- ambiguous (PGRST201 "more than one relationship was found") until every caller names the
-- constraint. coi-enforcement.js uses exactly that embed and is fail-safe on error — a silently
-- ambiguous join would have turned the enforcement worker into a no-op. One relationship, one FK.
--
-- WHY NOT VALID + VALIDATE, AND WHY NO SILENT UPDATE. Codex asked that any existing cross-tenant
-- row be preserved as evidence, not nulled out by the migration. The constraint is therefore added
-- NOT VALID (new writes are checked from that moment) and then VALIDATEd in the same transaction.
-- If real data contains an anomaly, VALIDATE raises, the whole transaction rolls back, and the
-- operator learns about it from the error instead of losing the row. Staging and production are
-- believed to hold zero anomalies; tests/compliance_tenant.test.mjs proves it via the function below.
--
-- READ-ONLY ANOMALY QUERY (also shipped as compliance_tenant_anomalies() for service_role):
--
--   SELECT c.id AS compliance_id, c.retailer_id AS compliance_retailer_id,
--          b.id AS contact_id,    b.retailer_id AS contact_retailer_id
--     FROM compliance_records c
--     JOIN brand_contacts b ON b.id = c.brand_contact_id
--    WHERE c.retailer_id <> b.retailer_id;
--
-- Zero rows is the invariant. Once this migration is applied the function can only ever return
-- zero rows (the FK forbids the join condition); it stays useful as a pre-flight on a database that
-- has not yet taken 0071, and as a permanent audit hook.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Audit function. STABLE, SECURITY DEFINER, service_role only (same shape as
-- capacity_invariant_violations() in 0069).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION compliance_tenant_anomalies()
RETURNS TABLE(compliance_id uuid, compliance_retailer_id uuid, contact_id uuid, contact_retailer_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.retailer_id, b.id, b.retailer_id
    FROM compliance_records c
    JOIN brand_contacts b ON b.id = c.brand_contact_id
   WHERE c.retailer_id <> b.retailer_id
   ORDER BY c.id
$$;

REVOKE ALL ON FUNCTION compliance_tenant_anomalies() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION compliance_tenant_anomalies() TO service_role;

-- ---------------------------------------------------------------------------------------------
-- FK target: (id, retailer_id) must be a unique key for the composite FK to reference it.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'brand_contacts_id_retailer_unique') THEN
    ALTER TABLE brand_contacts ADD CONSTRAINT brand_contacts_id_retailer_unique UNIQUE (id, retailer_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Same-tenant FK. Added NOT VALID (new writes checked immediately), then VALIDATEd: an existing
-- anomaly aborts the migration rather than being nulled away (see header).
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compliance_records_contact_same_retailer') THEN
    ALTER TABLE compliance_records
      ADD CONSTRAINT compliance_records_contact_same_retailer
      FOREIGN KEY (brand_contact_id, retailer_id)
      REFERENCES brand_contacts (id, retailer_id)
      ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

ALTER TABLE compliance_records VALIDATE CONSTRAINT compliance_records_contact_same_retailer;

-- Superseded by the composite key (see header: it is implied, and a second FK between the same two
-- tables makes the PostgREST embed in api/coi-enforcement.js ambiguous). Dropped only AFTER the
-- composite key has validated, inside the same transaction, so there is never a moment without
-- referential integrity on brand_contact_id.
ALTER TABLE compliance_records DROP CONSTRAINT IF EXISTS compliance_records_brand_contact_id_fkey;

COMMIT;
